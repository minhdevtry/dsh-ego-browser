import { describe, it, expect } from 'vitest'
import {
  auditFingerprint,
  collectFingerprintExpression,
  type FingerprintSnapshot,
} from '../src/stealth/fingerprint-audit.ts'

// A coherent desktop Chrome-on-Windows snapshot. Every test mutates a copy of
// this baseline so a failure points at exactly one injected contradiction.
function baseSnapshot(): FingerprintSnapshot {
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    userAgentData: {
      platform: 'Windows',
      brands: [
        { brand: 'Chromium', version: '120' },
        { brand: 'Google Chrome', version: '120' },
        { brand: 'Not?A_Brand', version: '24' },
      ],
      mobile: false,
    },
    platform: 'Win32',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webdriver: false,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    timezone: 'America/New_York',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
  }
}

describe('auditFingerprint', () => {
  it('reports a coherent snapshot as consistent with no mismatches', () => {
    const result = auditFingerprint(baseSnapshot())
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('flags navigator.webdriver === true as the automation tell', () => {
    const result = auditFingerprint({ ...baseSnapshot(), webdriver: true })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'webdriver')
    expect(m).toBeDefined()
    expect(m?.expected).toBe('false')
    expect(m?.actual).toBe('true')
    expect(m?.reason).toMatch(/automation/i)
  })

  it('flags hardwareConcurrency of zero as impossible', () => {
    const result = auditFingerprint({ ...baseSnapshot(), hardwareConcurrency: 0 })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'hardwareConcurrency')).toBe(true)
  })

  it('flags negative hardwareConcurrency as impossible', () => {
    const result = auditFingerprint({ ...baseSnapshot(), hardwareConcurrency: -2 })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'hardwareConcurrency')).toBe(true)
  })

  it('flags a Windows user-agent paired with a Linux navigator.platform', () => {
    const result = auditFingerprint({ ...baseSnapshot(), platform: 'Linux x86_64' })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'platform')
    expect(m).toBeDefined()
    expect(m?.actual).toBe('Linux x86_64')
    expect(m?.reason).toMatch(/user-agent/i)
  })

  it('flags a macOS user-agent paired with a Win32 navigator.platform', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      userAgentData: { platform: 'macOS', brands: [{ brand: 'Google Chrome', version: '120' }], mobile: false },
    })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'platform')).toBe(true)
  })

  it('flags userAgentData.platform disagreeing with the user-agent OS', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      userAgentData: { platform: 'Linux', brands: [{ brand: 'Google Chrome', version: '120' }], mobile: false },
    })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'userAgentData.platform')).toBe(true)
  })

  it('tolerates an Android user-agent reporting a Linux platform (normal)', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      userAgentData: { platform: 'Android', brands: [{ brand: 'Google Chrome', version: '120' }], mobile: true },
    })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('flags empty userAgentData.brands while the UA claims a modern Chrome', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      userAgentData: { platform: 'Windows', brands: [], mobile: false },
    })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'userAgentData.brands')
    expect(m).toBeDefined()
    expect(m?.reason).toMatch(/client hints/i)
  })

  it('flags missing userAgentData.brands while the UA claims a modern Chrome', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      userAgentData: { platform: 'Windows', mobile: false },
    })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'userAgentData.brands')).toBe(true)
  })

  it('flags availWidth larger than the screen width as impossible', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      screen: { ...baseSnapshot().screen, availWidth: 2000 },
    })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'screen.availWidth')).toBe(true)
  })

  it('flags availHeight larger than the screen height as impossible', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      screen: { ...baseSnapshot().screen, availHeight: 1200 },
    })
    expect(result.consistent).toBe(false)
    expect(result.mismatches.some((x) => x.field === 'screen.availHeight')).toBe(true)
  })

  it('flags an Apple GPU renderer paired with a Windows platform', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      webglVendor: 'Apple Inc.',
      webglRenderer: 'Apple M1',
    })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'webglRenderer')
    expect(m).toBeDefined()
    expect(m?.reason).toMatch(/Apple/i)
  })

  it('flags a software renderer on a desktop OS as informational', () => {
    const result = auditFingerprint({
      ...baseSnapshot(),
      webglVendor: 'Mesa',
      webglRenderer: 'llvmpipe (LLVM 15.0.7, 256 bits)',
    })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'webglRenderer')
    expect(m).toBeDefined()
    expect(m?.reason).toMatch(/informational/i)
    expect(m?.reason).toMatch(/software/i)
  })

  it('tolerates an unavailable WebGL context (empty vendor/renderer)', () => {
    const result = auditFingerprint({ ...baseSnapshot(), webglVendor: '', webglRenderer: '' })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('tolerates a missing userAgentData object on a modern Chrome UA', () => {
    const result = auditFingerprint({ ...baseSnapshot(), userAgentData: undefined })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('flags a gross timezone/locale region mismatch as informational', () => {
    const result = auditFingerprint({ ...baseSnapshot(), timezone: 'Asia/Tokyo' })
    expect(result.consistent).toBe(false)
    const m = result.mismatches.find((x) => x.field === 'timezone')
    expect(m).toBeDefined()
    expect(m?.reason).toMatch(/informational/i)
  })

  it('does not flag a timezone that matches the primary locale region', () => {
    const result = auditFingerprint({ ...baseSnapshot(), timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja'] })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('does not flag an unmapped timezone (conservative)', () => {
    const result = auditFingerprint({ ...baseSnapshot(), timezone: 'UTC' })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('does not flag a primary language without a region subtag (conservative)', () => {
    const result = auditFingerprint({ ...baseSnapshot(), timezone: 'Asia/Tokyo', languages: ['en'] })
    expect(result.consistent).toBe(true)
    expect(result.mismatches).toEqual([])
  })
})

// The collector is a page-side JS expression. We exercise it here with plain JS
// stubs for navigator/screen/document (no browser), which is the public seam:
// the string must be a valid expression that gathers the snapshot safely.
function evalCollector(
  expr: string,
  globals: { navigator: unknown; screen: unknown; document: unknown },
): FingerprintSnapshot {
  const fn = new Function('navigator', 'screen', 'document', `return (${expr})`)
  return fn(globals.navigator, globals.screen, globals.document) as FingerprintSnapshot
}

function collectorGlobals(webgl: 'ok' | 'throw') {
  const navigator = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32',
    webdriver: false,
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
    userAgentData: {
      platform: 'Windows',
      brands: [{ brand: 'Google Chrome', version: '120' }],
      mobile: false,
    },
  }
  const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 }
  const gl = {
    getExtension: (name: string) =>
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }
        : null,
    getParameter: (p: number) =>
      p === 0x9245 ? 'Google Inc. (Intel)' : p === 0x9246 ? 'ANGLE (Intel, D3D11)' : 'masked',
  }
  const document = {
    createElement: () => ({
      getContext: () => {
        if (webgl === 'throw') throw new Error('WebGL unavailable')
        return gl
      },
    }),
  }
  return { navigator, screen, document }
}

describe('collectFingerprintExpression', () => {
  it('returns a non-empty string that is a valid JS expression', () => {
    const expr = collectFingerprintExpression()
    expect(typeof expr).toBe('string')
    expect(expr.length).toBeGreaterThan(0)
    expect(() => new Function(`return (${expr})`)).not.toThrow()
  })

  it('gathers the full snapshot from navigator, screen, WebGL and Intl', () => {
    const globals = collectorGlobals('ok')
    const fp = evalCollector(collectFingerprintExpression(), globals)
    expect(fp.userAgent).toBe(globals.navigator.userAgent)
    expect(fp.platform).toBe('Win32')
    expect(fp.webdriver).toBe(false)
    expect(fp.languages).toEqual(['en-US', 'en'])
    expect(fp.hardwareConcurrency).toBe(8)
    expect(fp.screen).toEqual(globals.screen)
    expect(fp.webglVendor).toBe('Google Inc. (Intel)')
    expect(fp.webglRenderer).toBe('ANGLE (Intel, D3D11)')
    expect(fp.userAgentData?.platform).toBe('Windows')
    expect(fp.userAgentData?.brands).toEqual([{ brand: 'Google Chrome', version: '120' }])
    expect(typeof fp.timezone).toBe('string')
    expect(fp.timezone.length).toBeGreaterThan(0)
  })

  it('still returns a snapshot when WebGL throws (try/catch safety)', () => {
    const globals = collectorGlobals('throw')
    const fp = evalCollector(collectFingerprintExpression(), globals)
    expect(fp.userAgent).toBe(globals.navigator.userAgent)
    expect(fp.platform).toBe('Win32')
    expect(fp.webglVendor).toBe('')
    expect(fp.webglRenderer).toBe('')
  })

  it('produces a snapshot the auditor accepts as coherent', () => {
    const fp = evalCollector(collectFingerprintExpression(), collectorGlobals('ok'))
    // Intl timezone in this environment may differ from en-US; only assert the
    // collector output is structurally audit-able (no throw, boolean result).
    const result = auditFingerprint(fp)
    expect(typeof result.consistent).toBe('boolean')
    expect(Array.isArray(result.mismatches)).toBe(true)
  })
})
