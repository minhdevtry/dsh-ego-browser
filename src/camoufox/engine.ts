// Camoufox backend adapter (ticket #10, part of #9).
// The official Camoufox launcher (npm `camoufox`, MIT, daijro and contributors)
// is dynamically imported at launch time only; this file is an original
// adapter — no Camoufox code is copied.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { auditFingerprint, collectFingerprintExpression, type FingerprintSnapshot } from '../stealth/fingerprint-audit.ts'

export interface CamoufoxEngineOptions {
  headless: boolean
  humanize: boolean
  geoip: boolean
  proxy?: string
  idleTimeoutMs: number
}

export type CamoufoxAction = 'status' | 'open' | 'read' | 'act' | 'screenshot' | 'eval' | 'audit' | 'close'

export type CamoufoxResult = { ok: boolean; [key: string]: unknown }

export type CamoufoxLauncher = (options: Record<string, unknown>) => Promise<Browser>

export interface CamoufoxEngineDeps {
  launcher?: CamoufoxLauncher
  now?: () => number
}

const MAX_ERROR_CHARS = 2000
const MAX_OUTPUT_CHARS = 30000
const NAV_TIMEOUT_MS = 30000
const ACTION_TIMEOUT_MS = 10000
const TRUNCATED_NOTICE = `Output truncated to ${MAX_OUTPUT_CHARS} characters; read a narrower region or scroll for the rest.`

const ACT_OPERATIONS = ['click', 'dblclick', 'fill', 'press', 'select', 'check', 'uncheck', 'hover'] as const
type ActOperation = (typeof ACT_OPERATIONS)[number]

const FAILURE_CODES: Partial<Record<CamoufoxAction, string>> = {
  open: 'OPEN_FAILED',
  read: 'READ_FAILED',
  eval: 'EVAL_FAILED',
  audit: 'AUDIT_FAILED',
  screenshot: 'SCREENSHOT_FAILED',
}

function boundText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
}

export class CamoufoxEngine {
  private readonly getOptions: () => CamoufoxEngineOptions
  private readonly launcher: CamoufoxLauncher
  private readonly now: () => number
  private browser: Browser | null = null
  private page: Page | null = null
  private launchPromise: Promise<Browser> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private cachedUrl: string | null = null
  private cachedTitle: string | null = null
  private snapshotId: string | null = null
  private snapshotSeq = 0

  constructor(options: () => CamoufoxEngineOptions, deps: CamoufoxEngineDeps = {}) {
    this.getOptions = options
    this.launcher = deps.launcher ?? defaultLauncher
    this.now = deps.now ?? Date.now
  }

  status(): CamoufoxResult {
    const options = this.getOptions()
    return {
      ok: true,
      running: this.browser !== null,
      disposed: this.disposed,
      url: this.cachedUrl,
      title: this.cachedTitle,
      proxyConfigured: Boolean(options.proxy),
      humanize: options.humanize,
      headless: options.headless,
    }
  }

  execute(action: CamoufoxAction, args: Record<string, unknown> = {}): Promise<CamoufoxResult> {
    if (this.disposed) {
      return Promise.resolve(this.fail('DISPOSED', 'CamoufoxEngine is disposed; create a new engine to continue.'))
    }
    if (action === 'status') return Promise.resolve(this.status())
    return this.enqueue(() => this.run(action, args))
  }

  close(): Promise<CamoufoxResult> {
    return this.enqueue(() => this.closeOwned())
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.enqueue(() => this.closeOwned())
  }

  // All operations run one at a time; a failed task never poisons the queue.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async run(action: CamoufoxAction, args: Record<string, unknown>): Promise<CamoufoxResult> {
    try {
      const result = await this.dispatch(action, args)
      // A failed navigation can still leave an owned browser running; arm the
      // idle reaper whenever a browser exists, not only after successful calls.
      if (action !== 'close' && this.browser) this.scheduleIdle()
      return result
    } catch (err) {
      return this.fail(FAILURE_CODES[action] ?? 'INTERNAL_ERROR', this.errorMessage(err))
    }
  }

  private async dispatch(action: CamoufoxAction, args: Record<string, unknown>): Promise<CamoufoxResult> {
    switch (action) {
      case 'open':
        return this.open(args)
      case 'read':
        return this.read(args)
      case 'act':
        return this.act(args)
      case 'eval':
        return this.eval(args)
      case 'audit':
        return this.audit()
      case 'screenshot':
        return this.screenshot(args)
      case 'close':
        return this.closeOwned()
      default:
        return this.fail('UNKNOWN_ACTION', `Unknown action: ${String(action)}.`)
    }
  }

  private async screenshot(args: Record<string, unknown>): Promise<CamoufoxResult> {
    const page = this.page
    if (!page) return this.noPage()
    const path =
      typeof args.path === 'string' && args.path
        ? args.path
        : join(homedir(), '.dsh', 'plugin-data', 'ego-browser', 'camoufox-shots', `${this.now()}.png`)
    await mkdir(dirname(path), { recursive: true })
    await page.screenshot({ path, type: 'png', fullPage: args.fullPage === true })
    return { ok: true, path }
  }

  private async audit(): Promise<CamoufoxResult> {
    const page = this.page
    if (!page) return this.noPage()
    const snapshot = (await page.evaluate(collectFingerprintExpression())) as FingerprintSnapshot
    const { consistent, mismatches } = auditFingerprint(snapshot)
    return { ok: true, consistent, mismatches }
  }

  private async eval(args: Record<string, unknown>): Promise<CamoufoxResult> {
    const page = this.page
    if (!page) return this.noPage()
    const expression = args.expression
    if (typeof expression !== 'string' || !expression.trim()) {
      return this.fail('INVALID_ARGS', 'eval requires a nonempty expression string.')
    }
    const value = await page.evaluate(expression)
    let serialized: string
    try {
      serialized = JSON.stringify(value) ?? String(value)
    } catch {
      serialized = String(value)
    }
    const { text, truncated } = boundText(serialized)
    return { ok: true, result: text, truncated, ...(truncated ? { notice: TRUNCATED_NOTICE } : {}) }
  }

  private async read(args: Record<string, unknown>): Promise<CamoufoxResult> {
    const page = this.page
    if (!page) return this.noPage()
    const body = page.locator('body')
    if (args.mode === 'text') {
      const raw = await body.innerText({ timeout: ACTION_TIMEOUT_MS })
      const { text, truncated } = boundText(raw)
      return { ok: true, mode: 'text', text, truncated, ...(truncated ? { notice: TRUNCATED_NOTICE } : {}) }
    }
    // Official Playwright AI snapshot: semantic [ref=eN] markers, no custom DOM
    // injection; refs resolve later via locator('aria-ref=eN').
    const raw = await body.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS })
    this.snapshotSeq += 1
    this.snapshotId = `cf-${this.snapshotSeq}`
    const { text, truncated } = boundText(raw)
    return {
      ok: true,
      mode: 'snapshot',
      snapshotId: this.snapshotId,
      snapshot: text,
      truncated,
      ...(truncated ? { notice: TRUNCATED_NOTICE } : {}),
    }
  }

  private noPage(): CamoufoxResult {
    return this.fail('NO_PAGE', 'No page open; use action=open first.')
  }

  private async act(args: Record<string, unknown>): Promise<CamoufoxResult> {
    const page = this.page
    if (!page) return this.noPage()
    const operation = args.operation
    if (typeof operation !== 'string' || !(ACT_OPERATIONS as readonly string[]).includes(operation)) {
      return this.fail('INVALID_OPERATION', `act supports only: ${ACT_OPERATIONS.join(', ')}.`)
    }
    const op = operation as ActOperation
    const ref = typeof args.ref === 'string' ? args.ref : ''
    const hasRef = /^e\d+$/.test(ref)
    if (ref && !hasRef) return this.fail('INVALID_REF', 'ref must look like e12 from the latest snapshot.')
    if (!hasRef && op !== 'press') {
      return this.fail('INVALID_REF', 'act requires a ref like e12 from the latest snapshot (only press may omit it).')
    }
    if (args.snapshotId !== undefined && args.snapshotId !== this.snapshotId) {
      return this.fail('STALE_REF', 'snapshotId does not match the current snapshot; read again before acting.')
    }
    if (op === 'fill' && typeof args.text !== 'string') return this.fail('INVALID_ARGS', 'fill requires text (string).')
    if (op === 'select' && typeof args.value !== 'string') {
      return this.fail('INVALID_ARGS', 'select requires value (string).')
    }
    if (op === 'press' && typeof args.key !== 'string') return this.fail('INVALID_ARGS', 'press requires key (string).')

    // Fill text is a secret: never echo it in results, redact it from errors.
    const secrets = op === 'fill' ? [args.text as string] : []
    try {
      if (op === 'press' && !hasRef) {
        await page.keyboard.press(args.key as string)
      } else {
        // Official Playwright semantic ref from the AI snapshot; no custom DOM.
        const locator = page.locator(`aria-ref=${ref}`)
        const timeout = { timeout: ACTION_TIMEOUT_MS }
        switch (op) {
          case 'click':
            await locator.click(timeout)
            break
          case 'dblclick':
            await locator.dblclick(timeout)
            break
          case 'fill':
            await locator.fill(args.text as string, timeout)
            break
          case 'press':
            await locator.press(args.key as string, timeout)
            break
          case 'select':
            await locator.selectOption(args.value as string, timeout)
            break
          case 'check':
            await locator.check(timeout)
            break
          case 'uncheck':
            await locator.uncheck(timeout)
            break
          case 'hover':
            await locator.hover(timeout)
            break
        }
      }
    } catch (err) {
      // The action may have half-executed: never auto-retry; observe first.
      this.snapshotId = null
      return {
        ok: false,
        actionSent: true,
        requiresRead: true,
        code: 'ACTION_FAILED',
        error: this.sanitize(this.errorMessage(err), secrets),
      }
    }
    this.snapshotId = null
    return { ok: true, operation: op, ...(hasRef ? { ref } : {}), actionSent: true, requiresRead: true }
  }

  private async open(args: Record<string, unknown>): Promise<CamoufoxResult> {
    const raw = typeof args.url === 'string' ? args.url : ''
    const url = this.parseHttpUrl(raw)
    if (!url) {
      return this.fail('INVALID_URL', 'open requires an absolute http/https URL without embedded credentials.')
    }
    let browser: Browser
    try {
      browser = await this.ensureBrowser()
    } catch (err) {
      return this.fail('LAUNCH_FAILED', this.errorMessage(err))
    }
    const previous = this.page
    const page = await browser.newPage()
    try {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    } catch (err) {
      await page.close().catch(() => {})
      return this.fail('OPEN_FAILED', this.errorMessage(err))
    }
    this.page = page
    this.cachedUrl = page.url()
    this.cachedTitle = await page.title().catch(() => '')
    this.snapshotId = null
    // One active page: retire the page from a previous open, best effort.
    if (previous && previous !== page) await previous.close().catch(() => {})
    return { ok: true, url: this.cachedUrl, title: this.cachedTitle }
  }

  // Single-flight launch: concurrent callers share one promise; a failure
  // resets it so a later explicit call may retry.
  private ensureBrowser(): Promise<Browser> {
    if (this.browser) return Promise.resolve(this.browser)
    if (!this.launchPromise) {
      this.launchPromise = this.launcher(this.launchOptions()).then(
        (browser) => {
          this.browser = browser
          this.launchPromise = null
          return browser
        },
        (err: unknown) => {
          this.launchPromise = null
          throw new Error(
            `Camoufox launch failed: ${this.errorMessage(err)} — install the optional deps camoufox + playwright-core and fetch the engine with 'npx camoufox fetch'.`,
          )
        },
      )
    }
    return this.launchPromise
  }

  private launchOptions(): Record<string, unknown> {
    const options = this.getOptions()
    return {
      headless: options.headless,
      humanize: options.humanize,
      enable_cache: false,
      ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
      ...(options.geoip ? { geoip: true } : {}),
    }
  }

  private parseHttpUrl(raw: string): URL | null {
    if (!raw) return null
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  }

  // Close only the browser this engine launched — never unrelated Firefox.
  private async closeOwned(): Promise<CamoufoxResult> {
    this.clearIdle()
    const browser = this.browser
    this.browser = null
    this.page = null
    this.launchPromise = null
    this.cachedUrl = null
    this.cachedTitle = null
    this.snapshotId = null
    if (!browser) return { ok: true, closed: false }
    try {
      await browser.close()
      return { ok: true, closed: true }
    } catch (err) {
      return this.fail('CLOSE_FAILED', this.errorMessage(err))
    }
  }

  private scheduleIdle(): void {
    this.clearIdle()
    const ms = this.getOptions().idleTimeoutMs
    if (!(ms > 0) || !this.browser || this.disposed) return
    const timer = setTimeout(() => {
      void this.enqueue(() => this.closeOwned())
    }, ms)
    timer.unref?.()
    this.idleTimer = timer
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private fail(code: string, message: string): CamoufoxResult {
    return { ok: false, code, error: this.sanitize(message) }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  // Never leak the configured proxy value (it may embed credentials) or fill text.
  private sanitize(message: string, extraSecrets: string[] = []): string {
    const proxy = this.getOptions().proxy
    let out = proxy ? message.split(proxy).join('[proxy redacted]') : message
    for (const secret of extraSecrets) {
      if (secret) out = out.split(secret).join('[redacted]')
    }
    return out.slice(0, MAX_ERROR_CHARS)
  }
}

const defaultLauncher: CamoufoxLauncher = async (options) => {
  // Variable specifier keeps the optional dependency out of static resolution.
  const specifier = 'camoufox'
  const m = await import(specifier)
  return m.Camoufox(options) as Promise<Browser>
}
