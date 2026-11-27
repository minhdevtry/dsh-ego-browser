// Embedded Camoufox runtime: one real browser shown directly in the DSH panel
// via noVNC, with a manual/agent control gate. The agent may only act after the
// user grants control; the user can always interact with the panel directly.

import { CamoufoxDisplay, type DisplayInfo } from './display.ts'
import { collectFingerprintExpression, auditFingerprint } from '../stealth/fingerprint-audit.ts'
import type { Page } from 'playwright-core'

export type ControlMode = 'manual' | 'agent'
export interface EmbeddedInfo extends DisplayInfo {
  enabled: boolean
  controlMode: ControlMode
  currentUrl: string
  title: string
}

const MAX_CHARS = 30000
function bound(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_CHARS), truncated: true }
}

export interface EmbeddedConfig {
  enabled: boolean
  humanize: boolean
  geoip: boolean
  proxy?: string
  width?: number
  height?: number
}

export class EmbeddedCamoufox {
  private display: CamoufoxDisplay
  private getCfg: () => EmbeddedConfig
  controlMode: ControlMode = 'manual'
  private lastUrl = 'about:blank'

  constructor(getCfg: () => EmbeddedConfig) {
    this.getCfg = getCfg
    this.display = new CamoufoxDisplay({})
  }

  isEnabled(): boolean { return this.getCfg().enabled }

  status(): Record<string, unknown> {
    const info = this.display.getInfo()
    return { ok: true, running: info.running, controlMode: this.controlMode, viewerUrl: info.viewerUrl, currentUrl: this.lastUrl }
  }

  async ensureStarted(): Promise<DisplayInfo> {
    const cfg = this.getCfg()
    // Re-create display with current options if not running.
    if (!this.display.getInfo().running) {
      this.display = new CamoufoxDisplay({ humanize: cfg.humanize, geoip: cfg.geoip, proxy: cfg.proxy, width: cfg.width, height: cfg.height })
    }
    const info = await this.display.start()
    const page = this.display.getPage()
    if (page) {
      try { this.lastUrl = page.url() } catch {}
    }
    return info
  }

  async getInfo(): Promise<EmbeddedInfo> {
    const info = this.display.getInfo()
    const page = this.display.getPage()
    let currentUrl = this.lastUrl, title = ''
    if (page) {
      try { currentUrl = page.url() } catch {}
      try { title = await page.title() } catch {}
    }
    return { ...info, enabled: this.isEnabled(), controlMode: this.controlMode, currentUrl, title }
  }

  setControlMode(mode: ControlMode): void { this.controlMode = mode }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'Only http/https URLs are allowed.' }
    await this.ensureStarted()
    const page = this.display.getPage()
    if (!page) return { ok: false, error: 'No page' }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      this.lastUrl = page.url()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }

  async stop(): Promise<void> { await this.display.stop(); this.controlMode = 'manual' }
  async dispose(): Promise<void> { await this.stop() }

  private requirePage(): Page | null { return this.display.getPage() }

  private gate(): { ok: false; code: string; error: string } | null {
    if (this.controlMode !== 'agent') {
      return { ok: false, code: 'NEEDS_CONFIRMATION', error: 'Agent control is locked. The user must grant control in the Camoufox panel (Allow agent) before the agent can act.' }
    }
    return null
  }

  async execute(action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) return { ok: false, code: 'DISABLED', error: 'Embedded Camoufox is disabled.' }
    if (action === 'status') return { ok: true, ...(await this.getInfo()) }
    if (action === 'request_control') {
      return { ok: true, controlMode: this.controlMode, message: this.controlMode === 'agent' ? 'Agent control already granted.' : 'Ask the user to click "Allow agent" in the Camoufox panel.' }
    }
    const g = this.gate()
    if (g) return g
    await this.ensureStarted()
    const page = this.requirePage()
    if (!page) return { ok: false, code: 'NO_PAGE', error: 'No page open.' }
    try {
      switch (action) {
        case 'open': {
          const url = typeof args.url === 'string' ? args.url : ''
          const r = await this.navigate(url)
          return r.ok ? { ok: true, url: page.url(), title: await page.title().catch(() => '') } : r
        }
        case 'read': {
          const body = page.locator('body')
          if (args.mode === 'text') {
            const { text, truncated } = bound(await body.innerText({ timeout: 10000 }))
            return { ok: true, mode: 'text', text, truncated }
          }
          const raw = await body.ariaSnapshot({ mode: 'ai', timeout: 10000 })
          const { text, truncated } = bound(raw)
          return { ok: true, mode: 'snapshot', snapshot: text, truncated }
        }
        case 'act': {
          const op = String(args.operation || '')
          const ref = typeof args.ref === 'string' ? args.ref : ''
          if (!/^e\d+$/.test(ref) && op !== 'press') return { ok: false, code: 'INVALID_REF', error: 'ref must look like e12 from the latest snapshot.' }
          const loc = ref ? page.locator(`aria-ref=${ref}`) : null
          const t = { timeout: 10000 }
          if (op === 'click' && loc) await loc.click(t)
          else if (op === 'dblclick' && loc) await loc.dblclick(t)
          else if (op === 'fill' && loc) await loc.fill(String(args.text ?? ''), t)
          else if (op === 'press') { if (loc) await loc.press(String(args.key ?? ''), t); else await page.keyboard.press(String(args.key ?? '')) }
          else if (op === 'select' && loc) await loc.selectOption(String(args.value ?? ''), t)
          else if (op === 'check' && loc) await loc.check(t)
          else if (op === 'uncheck' && loc) await loc.uncheck(t)
          else if (op === 'hover' && loc) await loc.hover(t)
          else return { ok: false, code: 'INVALID_OPERATION', error: 'Unsupported operation.' }
          return { ok: true, operation: op, actionSent: true, requiresRead: true }
        }
        case 'eval': {
          const value = await page.evaluate(String(args.expression ?? ''))
          const { text, truncated } = bound(JSON.stringify(value) ?? String(value))
          return { ok: true, result: text, truncated }
        }
        case 'audit': {
          const snap = await page.evaluate(collectFingerprintExpression())
          const { consistent, mismatches } = auditFingerprint(snap as any)
          return { ok: true, consistent, mismatches }
        }
        case 'screenshot': {
          const path = typeof args.path === 'string' && args.path ? args.path : `/tmp/camoufox-${Date.now()}.png`
          await page.screenshot({ path, type: 'png', fullPage: args.fullPage === true })
          return { ok: true, path }
        }
        case 'close': {
          await this.stop()
          return { ok: true, closed: true }
        }
        default:
          return { ok: false, code: 'UNKNOWN_ACTION', error: `Unknown action: ${action}` }
      }
    } catch (e) {
      return { ok: false, code: 'ACTION_FAILED', error: e instanceof Error ? e.message : String(e), actionSent: true }
    }
  }
}
