import { describe, it, expect, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Browser } from 'playwright-core'
import { CamoufoxEngine, type CamoufoxAction, type CamoufoxEngineOptions } from '../src/camoufox/engine.ts'

// Fake launcher/browser/page/locator doubles: the engine is exercised only
// through its public seams (execute/status/close/dispose).
function baseOptions(overrides: Partial<CamoufoxEngineOptions> = {}): CamoufoxEngineOptions {
  return { headless: true, humanize: false, geoip: false, idleTimeoutMs: 0, ...overrides }
}

function createFake() {
  const locator = {
    ariaSnapshot: vi.fn(async () => '- button "OK" [ref=e1]'),
    innerText: vi.fn(async () => 'hello world'),
    click: vi.fn(async () => {}),
    dblclick: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
  }
  const page = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => 'https://example.com/'),
    title: vi.fn(async () => 'Example Domain'),
    locator: vi.fn((_selector: string) => locator),
    keyboard: { press: vi.fn(async () => {}) },
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    evaluate: vi.fn(async (_expression: string): Promise<unknown> => ({})),
    close: vi.fn(async () => {}),
  }
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  }
  const launcher = vi.fn(async (_options: Record<string, unknown>) => browser as unknown as Browser)
  return { launcher, browser, page, locator }
}

function makeEngine(fake = createFake(), options: Partial<CamoufoxEngineOptions> = {}) {
  const engine = new CamoufoxEngine(() => baseOptions(options), {
    launcher: fake.launcher,
    now: () => 1700000000000,
  })
  return { engine, ...fake }
}

describe('CamoufoxEngine open', () => {
  it('launches lazily with mapped options and caches url/title', async () => {
    const { engine, launcher, browser, page } = makeEngine()
    const result = await engine.execute('open', { url: 'https://example.com/' })
    expect(result).toMatchObject({ ok: true, url: 'https://example.com/', title: 'Example Domain' })
    expect(launcher).toHaveBeenCalledTimes(1)
    expect(launcher).toHaveBeenCalledWith({ headless: true, humanize: false, enable_cache: false })
    expect(browser.newPage).toHaveBeenCalledTimes(1)
    expect(page.goto).toHaveBeenCalledWith('https://example.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    expect(engine.status()).toMatchObject({ running: true, url: 'https://example.com/', title: 'Example Domain' })
  })

  it('maps proxy/geoip into launch options and never exposes the proxy value', async () => {
    const proxy = 'http://user:secret@proxy.local:8080'
    const { engine, launcher } = makeEngine(createFake(), { humanize: true, geoip: true, proxy })
    await engine.execute('open', { url: 'https://example.com/' })
    expect(launcher).toHaveBeenCalledWith({
      headless: true,
      humanize: true,
      enable_cache: false,
      proxy: { server: proxy },
      geoip: true,
    })
    const status = engine.status()
    expect(status.proxyConfigured).toBe(true)
    expect(JSON.stringify(status)).not.toContain('user:secret')
  })

  it('launches once for concurrent opens and keeps a single active page', async () => {
    const fake = createFake()
    const firstPage = fake.page
    const secondPage = { ...fake.page, close: vi.fn(async () => {}) }
    fake.browser.newPage.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage)
    const { engine, launcher, browser } = makeEngine(fake)
    const [r1, r2] = await Promise.all([
      engine.execute('open', { url: 'https://example.com/' }),
      engine.execute('open', { url: 'https://example.org/' }),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(launcher).toHaveBeenCalledTimes(1)
    expect(browser.newPage).toHaveBeenCalledTimes(2)
    expect(firstPage.close).toHaveBeenCalledTimes(1)
    expect(secondPage.close).not.toHaveBeenCalled()
  })

  it('rejects relative, non-http(s) and credential-bearing URLs without launching', async () => {
    const badUrls = [
      'not a url',
      '/relative/path',
      'ftp://example.com/',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
      '',
    ]
    for (const url of badUrls) {
      const { engine, launcher } = makeEngine()
      const result = await engine.execute('open', { url })
      expect(result.ok, url).toBe(false)
      expect(result.code, url).toBe('INVALID_URL')
      expect(launcher, url).not.toHaveBeenCalled()
    }
    const { engine } = makeEngine()
    expect((await engine.execute('open')).code).toBe('INVALID_URL')
  })

  it('returns an actionable launch error and lets a later call retry', async () => {
    const fake = createFake()
    let attempt = 0
    fake.launcher.mockImplementation(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("Cannot find package 'camoufox'")
      return fake.browser as unknown as Browser
    })
    const { engine } = makeEngine(fake)
    const failed = await engine.execute('open', { url: 'https://example.com/' })
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('LAUNCH_FAILED')
    expect(String(failed.error)).toContain('camoufox fetch')
    expect(engine.status().running).toBe(false)
    const retried = await engine.execute('open', { url: 'https://example.com/' })
    expect(retried.ok).toBe(true)
    expect(fake.launcher).toHaveBeenCalledTimes(2)
  })

  it('reports OPEN_FAILED when navigation fails and leaves no readable page', async () => {
    const { engine, page } = makeEngine()
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'))
    const result = await engine.execute('open', { url: 'https://bad.example/' })
    expect(result).toMatchObject({ ok: false, code: 'OPEN_FAILED' })
    expect(page.close).toHaveBeenCalled()
    const read = await engine.execute('read')
    expect(read).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
  })
})

describe('CamoufoxEngine read', () => {
  it('does not launch and reports honestly when no page is open', async () => {
    const { engine, launcher } = makeEngine()
    const result = await engine.execute('read')
    expect(result).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('returns an AI aria snapshot of body with incrementing snapshot ids', async () => {
    const { engine, page, locator } = makeEngine()
    await engine.execute('open', { url: 'https://example.com/' })
    const first = await engine.execute('read')
    expect(first).toMatchObject({
      ok: true,
      mode: 'snapshot',
      snapshotId: 'cf-1',
      snapshot: '- button "OK" [ref=e1]',
      truncated: false,
    })
    expect(page.locator).toHaveBeenCalledWith('body')
    expect(locator.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai', timeout: 10000 })
    const second = await engine.execute('read', { mode: 'snapshot' })
    expect(second.snapshotId).toBe('cf-2')
  })

  it('bounds snapshot and text output to 30000 chars with a truncated notice', async () => {
    const { engine, locator } = makeEngine()
    await engine.execute('open', { url: 'https://example.com/' })
    locator.ariaSnapshot.mockResolvedValueOnce('x'.repeat(40000))
    const snap = await engine.execute('read')
    expect(snap.ok).toBe(true)
    expect(String(snap.snapshot)).toHaveLength(30000)
    expect(snap.truncated).toBe(true)
    expect(String(snap.notice)).toMatch(/truncated/i)
    locator.innerText.mockResolvedValueOnce('y'.repeat(40000))
    const text = await engine.execute('read', { mode: 'text' })
    expect(text).toMatchObject({ ok: true, mode: 'text', truncated: true })
    expect(String(text.text)).toHaveLength(30000)
    expect(locator.innerText).toHaveBeenCalled()
  })
})

async function openedEngine(options: Partial<CamoufoxEngineOptions> = {}) {
  const made = makeEngine(createFake(), options)
  await made.engine.execute('open', { url: 'https://example.com/' })
  const read = await made.engine.execute('read')
  return { ...made, snapshotId: String(read.snapshotId) }
}

describe('CamoufoxEngine act', () => {
  it('does not launch when no page is open', async () => {
    const { engine, launcher } = makeEngine()
    const result = await engine.execute('act', { operation: 'click', ref: 'e1' })
    expect(result).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('rejects operations outside the allowlist and malformed refs without touching the page', async () => {
    const { engine, locator, page } = await openedEngine()
    const bad = await engine.execute('act', { operation: 'goto', ref: 'e1' })
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    for (const ref of ['x1', 'e', 'e1e', '1']) {
      const r = await engine.execute('act', { operation: 'click', ref })
      expect(r.ok, ref).toBe(false)
      expect(r.code, ref).toBe('INVALID_REF')
    }
    const missing = await engine.execute('act', { operation: 'click' })
    expect(missing.code).toBe('INVALID_REF')
    expect(locator.click).not.toHaveBeenCalled()
    expect(page.locator).toHaveBeenCalledTimes(1) // only the body read
  })

  it('requires text/value/key arguments for fill/select/press', async () => {
    const { engine, locator } = await openedEngine()
    expect((await engine.execute('act', { operation: 'fill', ref: 'e1' })).code).toBe('INVALID_ARGS')
    expect((await engine.execute('act', { operation: 'select', ref: 'e1' })).code).toBe('INVALID_ARGS')
    expect((await engine.execute('act', { operation: 'press', ref: 'e1' })).code).toBe('INVALID_ARGS')
    expect(locator.fill).not.toHaveBeenCalled()
    expect(locator.selectOption).not.toHaveBeenCalled()
    expect(locator.press).not.toHaveBeenCalled()
  })

  it('fails STALE_REF when snapshotId does not match the current generation', async () => {
    const { engine, locator, snapshotId } = await openedEngine()
    const stale = await engine.execute('act', { operation: 'click', ref: 'e1', snapshotId: 'cf-999' })
    expect(stale).toMatchObject({ ok: false, code: 'STALE_REF' })
    expect(locator.click).not.toHaveBeenCalled()
    const fresh = await engine.execute('act', { operation: 'click', ref: 'e1', snapshotId })
    expect(fresh.ok).toBe(true)
  })

  it('clicks via aria-ref and invalidates the snapshot generation', async () => {
    const { engine, page, locator, snapshotId } = await openedEngine()
    const result = await engine.execute('act', { operation: 'click', ref: 'e1', snapshotId })
    expect(result).toMatchObject({ ok: true, operation: 'click', ref: 'e1', actionSent: true, requiresRead: true })
    expect(page.locator).toHaveBeenCalledWith('aria-ref=e1')
    expect(locator.click).toHaveBeenCalledWith({ timeout: 10000 })
    const after = await engine.execute('act', { operation: 'click', ref: 'e1', snapshotId })
    expect(after.code).toBe('STALE_REF')
  })

  it('fills without echoing the text', async () => {
    const { engine, locator } = await openedEngine()
    const secret = 'hunter2-secret'
    const ok = await engine.execute('act', { operation: 'fill', ref: 'e1', text: secret })
    expect(ok.ok).toBe(true)
    expect(locator.fill).toHaveBeenCalledWith(secret, { timeout: 10000 })
    expect(JSON.stringify(ok)).not.toContain(secret)
  })

  it('reports ACTION_FAILED without retrying and redacts fill text from failures', async () => {
    const { engine, locator } = await openedEngine()
    const secret = 'hunter2-secret'
    locator.fill.mockRejectedValueOnce(new Error(`fill failed for value ${secret}`))
    const result = await engine.execute('act', { operation: 'fill', ref: 'e1', text: secret })
    expect(result).toMatchObject({ ok: false, actionSent: true, code: 'ACTION_FAILED', requiresRead: true })
    expect(String(result.error)).not.toContain(secret)
    expect(locator.fill).toHaveBeenCalledTimes(1)
  })

  it('presses on the page keyboard without a ref and on the locator with one', async () => {
    const { engine, page, locator } = await openedEngine()
    const global = await engine.execute('act', { operation: 'press', key: 'Enter' })
    expect(global).toMatchObject({ ok: true, actionSent: true, requiresRead: true })
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter')
    expect(locator.press).not.toHaveBeenCalled()
    const read = await engine.execute('read')
    const targeted = await engine.execute('act', {
      operation: 'press',
      ref: 'e1',
      key: 'Tab',
      snapshotId: String(read.snapshotId),
    })
    expect(targeted.ok).toBe(true)
    expect(locator.press).toHaveBeenCalledWith('Tab', { timeout: 10000 })
  })

  it('maps dblclick/select/check/uncheck/hover to the matching locator calls', async () => {
    const { engine, locator } = await openedEngine()
    const act = async (operation: string, extra: Record<string, unknown> = {}) => {
      const read = await engine.execute('read')
      return engine.execute('act', { operation, ref: 'e1', snapshotId: String(read.snapshotId), ...extra })
    }
    expect((await act('dblclick')).ok).toBe(true)
    expect(locator.dblclick).toHaveBeenCalledWith({ timeout: 10000 })
    expect((await act('select', { value: 'b' })).ok).toBe(true)
    expect(locator.selectOption).toHaveBeenCalledWith('b', { timeout: 10000 })
    expect((await act('check')).ok).toBe(true)
    expect(locator.check).toHaveBeenCalledWith({ timeout: 10000 })
    expect((await act('uncheck')).ok).toBe(true)
    expect(locator.uncheck).toHaveBeenCalledWith({ timeout: 10000 })
    expect((await act('hover')).ok).toBe(true)
    expect(locator.hover).toHaveBeenCalledWith({ timeout: 10000 })
  })
})

describe('CamoufoxEngine eval', () => {
  it('does not launch when no page is open', async () => {
    const { engine, launcher } = makeEngine()
    const result = await engine.execute('eval', { expression: '1 + 1' })
    expect(result).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('requires a nonempty expression', async () => {
    const { engine, page } = await openedEngine()
    expect((await engine.execute('eval')).code).toBe('INVALID_ARGS')
    expect((await engine.execute('eval', { expression: '   ' })).code).toBe('INVALID_ARGS')
    expect(page.evaluate).not.toHaveBeenCalled()
  })

  it('returns a JSON-safe bounded result', async () => {
    const { engine, page } = await openedEngine()
    page.evaluate.mockResolvedValueOnce({ a: 1 })
    const ok = await engine.execute('eval', { expression: '({ a: 1 })' })
    expect(ok).toMatchObject({ ok: true, result: '{"a":1}', truncated: false })
    expect(page.evaluate).toHaveBeenCalledWith('({ a: 1 })')
    page.evaluate.mockResolvedValueOnce('z'.repeat(40000))
    const big = await engine.execute('eval', { expression: 'big' })
    expect(big.ok).toBe(true)
    expect(String(big.result)).toHaveLength(30000)
    expect(big.truncated).toBe(true)
    expect(String(big.notice)).toMatch(/truncated/i)
  })
})

describe('CamoufoxEngine audit', () => {
  it('does not launch when no page is open', async () => {
    const { engine, launcher } = makeEngine()
    const result = await engine.execute('audit')
    expect(result).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('audits the collected fingerprint for coherence', async () => {
    const { engine, page } = await openedEngine()
    const coherent = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      webglVendor: 'Google Inc. (Intel)',
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      webdriver: false,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
    }
    page.evaluate.mockResolvedValueOnce(coherent)
    const ok = await engine.execute('audit')
    expect(ok).toMatchObject({ ok: true, consistent: true, mismatches: [] })
    page.evaluate.mockResolvedValueOnce({ ...coherent, webdriver: true })
    const flagged = await engine.execute('audit')
    expect(flagged.ok).toBe(true)
    expect(flagged.consistent).toBe(false)
    expect(flagged.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'webdriver' })]))
  })
})

describe('CamoufoxEngine screenshot', () => {
  it('does not launch when no page is open', async () => {
    const { engine, launcher } = makeEngine()
    const result = await engine.execute('screenshot')
    expect(result).toMatchObject({ ok: false, error: 'No page open; use action=open first.' })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('defaults to a timestamped PNG under the plugin data dir and returns only the path', async () => {
    const { engine, page } = await openedEngine()
    const result = await engine.execute('screenshot')
    expect(result.ok).toBe(true)
    const path = String(result.path)
    expect(path).toContain(join('.dsh', 'plugin-data', 'ego-browser', 'camoufox-shots'))
    expect(path.endsWith('1700000000000.png')).toBe(true)
    expect(page.screenshot).toHaveBeenCalledWith({ path, type: 'png', fullPage: false })
    expect(Object.keys(result).sort()).toEqual(['ok', 'path'])
  })

  it('honours args.path and fullPage, creating parent directories', async () => {
    const { engine, page } = await openedEngine()
    const dir = join(tmpdir(), `cf-engine-test-${process.pid}`)
    const target = join(dir, 'nested', 'shot.png')
    try {
      const result = await engine.execute('screenshot', { path: target, fullPage: true })
      expect(result).toMatchObject({ ok: true, path: target })
      expect(page.screenshot).toHaveBeenCalledWith({ path: target, type: 'png', fullPage: true })
      expect(existsSync(dirname(target))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CamoufoxEngine lifecycle', () => {
  it('close closes only the owned browser and resets state', async () => {
    const { engine, browser } = await openedEngine()
    const result = await engine.close()
    expect(result).toMatchObject({ ok: true, closed: true })
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(engine.status()).toMatchObject({ running: false, url: null, title: null })
    expect((await engine.execute('read')).code).toBe('NO_PAGE')
    const again = await engine.close()
    expect(again).toMatchObject({ ok: true, closed: false })
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('execute close behaves like close()', async () => {
    const { engine, browser } = await openedEngine()
    const result = await engine.execute('close')
    expect(result).toMatchObject({ ok: true, closed: true })
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('closes the browser after the idle timeout and reschedules on activity', async () => {
    vi.useFakeTimers()
    try {
      const { engine, browser } = await openedEngine({ idleTimeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(600)
      expect(browser.close).not.toHaveBeenCalled()
      await engine.execute('read')
      await vi.advanceTimersByTimeAsync(600)
      expect(browser.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)
      expect(browser.close).toHaveBeenCalledTimes(1)
      expect(engine.status().running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules idle cleanup even when navigation fails after launch', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFake()
      fake.page.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      const engine = new CamoufoxEngine(() => baseOptions({ idleTimeoutMs: 1000 }), {
        launcher: fake.launcher,
        now: () => 1700000000000,
      })
      const result = await engine.execute('open', { url: 'https://example.com/' })
      expect(result).toMatchObject({ ok: false, code: 'OPEN_FAILED' })
      expect(fake.browser.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(fake.browser.close).toHaveBeenCalledTimes(1)
      expect(engine.status().running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('idleTimeoutMs=0 disables the idle timer', async () => {
    vi.useFakeTimers()
    try {
      const { engine, browser } = await openedEngine({ idleTimeoutMs: 0 })
      await vi.advanceTimersByTimeAsync(60000)
      expect(browser.close).not.toHaveBeenCalled()
      expect(engine.status().running).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose marks disposed, closes, and rejects later execute calls', async () => {
    const { engine, browser } = await openedEngine()
    await engine.dispose()
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(engine.status()).toMatchObject({ disposed: true, running: false })
    const result = await engine.execute('open', { url: 'https://example.com/' })
    expect(result).toMatchObject({ ok: false, code: 'DISPOSED' })
  })

  it('serializes close after a pending action', async () => {
    const { engine, browser, locator } = await openedEngine()
    const order: string[] = []
    let release!: () => void
    locator.click.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('click-done')
    })
    browser.close.mockImplementationOnce(async () => {
      order.push('close-done')
    })
    const acting = engine.execute('act', { operation: 'click', ref: 'e1' })
    const closing = engine.close()
    await vi.waitFor(() => expect(locator.click).toHaveBeenCalled())
    release()
    const [actResult, closeResult] = await Promise.all([acting, closing])
    expect(actResult.ok).toBe(true)
    expect(closeResult).toMatchObject({ ok: true, closed: true })
    expect(order).toEqual(['click-done', 'close-done'])
  })

  it('rejects unknown actions honestly', async () => {
    const { engine } = makeEngine()
    const result = await engine.execute('bogus' as CamoufoxAction)
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ACTION' })
  })

  it('bounds error strings', async () => {
    const fake = createFake()
    fake.launcher.mockRejectedValueOnce(new Error('x'.repeat(10000)))
    const { engine } = makeEngine(fake)
    const result = await engine.execute('open', { url: 'https://example.com/' })
    expect(result.ok).toBe(false)
    expect(String(result.error).length).toBeLessThanOrEqual(2000)
  })
})

describe('CamoufoxEngine.status', () => {
  it('reports idle state without launching the browser', () => {
    const { engine, launcher } = makeEngine()
    const status = engine.status()
    expect(status).toMatchObject({
      ok: true,
      running: false,
      disposed: false,
      proxyConfigured: false,
      humanize: false,
      headless: true,
    })
    expect(status.url).toBeNull()
    expect(status.title).toBeNull()
    expect(launcher).not.toHaveBeenCalled()
  })
})
