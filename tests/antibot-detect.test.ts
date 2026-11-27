/**
 * tests/antibot-detect.test.ts — spec for the stealth anti-bot detector.
 *
 * Seams under test (fixed by the ticket #2 module contract):
 *   - detectAntiBot(signals): vendor + challenge + confidence + evidence
 *   - looksBlocked(html, headers?, status?): the smart_fetch escalation gate
 *
 * Fixtures are known-good literals shaped like real vendor pages/headers,
 * never derived from the implementation's own patterns.
 */

import { describe, it, expect } from 'vitest'
import { detectAntiBot, looksBlocked } from '../src/stealth/antibot-detect.ts'
import type { AntiBotSignals, AntiBotResult } from '../src/stealth/antibot-detect.ts'

// ── Fixtures: real-world page shapes ────────────────────────────────────────

const cfChallenge: AntiBotSignals = {
  title: 'Just a moment...',
  html:
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-challenge">Checking your browser before accessing example.com.</div>' +
    '<script>window.__cf_chl_opt={};var cpo=document.createElement("script");' +
    'cpo.src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1";</script>' +
    '</body></html>',
  headers: { 'cf-ray': '8abc123def456-SGN', 'cf-mitigated': 'challenge', server: 'cloudflare' },
  url: 'https://example.com/',
  status: 403,
}

const cfPassiveWidget: AntiBotSignals = {
  title: 'Sign in — Example Shop',
  html:
    '<form class="login"><div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>' +
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></form>',
  headers: { 'cf-ray': '8abc123def456-SGN' },
  status: 200,
}

const cfSolvedCookie: AntiBotSignals = {
  title: 'Example Shop — Home',
  html: '<h1>Welcome back</h1><p>Real content after a solved challenge.</p>',
  headers: { 'set-cookie': 'cf_clearance=aBcDeF123; Path=/; Secure; HttpOnly', 'cf-ray': 'x-SGN' },
  status: 200,
}

const datadomeChallenge: AntiBotSignals = {
  title: 'DataDome',
  html:
    '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=abc123" title="DataDome CAPTCHA"></iframe>' +
    '<script src="https://js.datadome.co/tags.js"></script>',
  headers: { 'set-cookie': 'datadome=xYz987; Max-Age=3600; Path=/', 'x-dd-b': '3' },
  status: 403,
}

const datadomePassive: AntiBotSignals = {
  title: 'Running Shoes — Example Store',
  html: '<script src="https://js.datadome.co/tags.js"></script><h1>Running Shoes</h1>',
  headers: { 'set-cookie': 'datadome=xYz987; Max-Age=3600' },
  status: 200,
}

const akamaiChallenge: AntiBotSignals = {
  title: 'Access Denied',
  html:
    '<html><head><title>Access Denied</title></head><body>' +
    'You don\'t have permission to access "https://example.com/" on this server.' +
    '<p>Reference&#32;&#35;18.abc123def.1700000000.1a2b3c4d</p></body></html>',
  status: 403,
}

const akamaiPassive: AntiBotSignals = {
  title: 'Example Store — Checkout',
  html:
    '<script src="https://ds-aksb-a.akamaihd.net/aksb.min.js"></script>' +
    '<script>var _abck="ABCDEF~0~YAAQ";</script><h1>Checkout</h1>',
  headers: { 'akamai-grn': '0.abc123.1700000000.1a2b3c' },
  status: 200,
}

const perimeterxChallenge: AntiBotSignals = {
  title: 'Press & Hold',
  html:
    '<div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human</p>' +
    '<script src="//captcha.px-cdn.net/PX1234/captcha.js"></script>',
  status: 403,
}

const perimeterxPassive: AntiBotSignals = {
  title: 'Example News — Front page',
  html: '<script>window._pxAppId="PX1234";window._pxUuid="uuid";</script><h1>News</h1>',
  headers: { 'set-cookie': '_px3=aBcD; Path=/; _pxhd=xYz; Path=/' },
  status: 200,
}

const impervaChallenge: AntiBotSignals = {
  title: 'Request unsuccessful',
  html: '<html><body>Request unsuccessful. Incapsula incident ID: 123000456789-012345</body></html>',
  status: 403,
}

const impervaPassive: AntiBotSignals = {
  title: 'Example Bank — Accounts',
  html: '<script src="/_Incapsula_Resource?SWJIWLNA=1"></script><h1>Accounts</h1>',
  headers: { 'set-cookie': 'incap_ses_123=aBc; visid_incap_123=xYz', 'x-iinfo': '12-34567-0 0NNN' },
  status: 200,
}

const recaptchaPassive: AntiBotSignals = {
  title: 'Contact us — Example',
  html:
    '<form><div class="g-recaptcha" data-sitekey="6LcAbCdEfGhIjK"></div>' +
    '<script src="https://www.google.com/recaptcha/api.js" async defer></script>' +
    '<textarea name="g-recaptcha-response"></textarea></form>',
  status: 200,
}

const recaptchaChallenge: AntiBotSignals = {
  title: 'Verify you are human',
  html:
    '<div class="g-recaptcha" data-sitekey="6LcAbCdEfGhIjK"></div>' +
    '<script src="https://www.google.com/recaptcha/api.js"></script>',
  status: 403,
}

const hcaptchaPassive: AntiBotSignals = {
  title: 'Register — Example',
  html:
    '<div class="h-captcha" data-sitekey="a1b2c3d4-e5f6"></div>' +
    '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>',
  status: 200,
}

const hcaptchaChallenge: AntiBotSignals = {
  title: 'Are you a robot?',
  html: '<div class="h-captcha" data-sitekey="a1b2c3d4-e5f6"></div><script src="https://hcaptcha.com/1/api.js"></script>',
  status: 403,
}

const allFixtures: AntiBotSignals[] = [
  cfChallenge, cfPassiveWidget, cfSolvedCookie,
  datadomeChallenge, datadomePassive,
  akamaiChallenge, akamaiPassive,
  perimeterxChallenge, perimeterxPassive,
  impervaChallenge, impervaPassive,
  recaptchaPassive, recaptchaChallenge,
  hcaptchaPassive, hcaptchaChallenge,
]

const evidenceText = (r: AntiBotResult): string => r.evidence.join('\n')

// ── detectAntiBot: vendor identification ────────────────────────────────────

describe('detectAntiBot — Cloudflare', () => {
  it('flags the "Just a moment" interstitial as a Cloudflare challenge', () => {
    const r = detectAntiBot(cfChallenge)
    expect(r.vendor).toBe('cloudflare')
    expect(r.challenge).toBe(true)
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
    expect(evidenceText(r)).toMatch(/cf-mitigated|cf-chl|just a moment/i)
  })

  it('treats an embedded Turnstile widget on a login form as passive presence', () => {
    const r = detectAntiBot(cfPassiveWidget)
    expect(r.vendor).toBe('cloudflare')
    expect(r.challenge).toBe(false)
    expect(r.confidence).toBeGreaterThan(0)
  })

  it('treats a cf_clearance cookie on real content as a solved (passive) challenge', () => {
    const r = detectAntiBot(cfSolvedCookie)
    expect(r.vendor).toBe('cloudflare')
    expect(r.challenge).toBe(false)
  })

  it('detects a challenge from the cf-mitigated header alone', () => {
    const r = detectAntiBot({ headers: { 'cf-mitigated': 'challenge' } })
    expect(r.vendor).toBe('cloudflare')
    expect(r.challenge).toBe(true)
  })

  it('matches header names case-insensitively', () => {
    const r = detectAntiBot({ headers: { 'CF-RAY': 'x-SGN', 'CF-MITIGATED': 'challenge' } })
    expect(r.vendor).toBe('cloudflare')
    expect(r.challenge).toBe(true)
    expect(evidenceText(r)).toMatch(/cf-ray/i)
  })

  it('detects Cloudflare from a challenges.cloudflare.com URL signal', () => {
    const r = detectAntiBot({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js' })
    expect(r.vendor).toBe('cloudflare')
  })
})

describe('detectAntiBot — DataDome', () => {
  it('flags the captcha-delivery interstitial as a DataDome challenge', () => {
    const r = detectAntiBot(datadomeChallenge)
    expect(r.vendor).toBe('datadome')
    expect(r.challenge).toBe(true)
    expect(evidenceText(r)).toMatch(/captcha|datadome/i)
  })

  it('treats the datadome cookie + tags.js on real content as passive presence', () => {
    const r = detectAntiBot(datadomePassive)
    expect(r.vendor).toBe('datadome')
    expect(r.challenge).toBe(false)
    expect(r.confidence).toBeGreaterThan(0)
  })

  it('detects DataDome from the x-datadome header alone', () => {
    const r = detectAntiBot({ headers: { 'x-datadome': 'protected' } })
    expect(r.vendor).toBe('datadome')
    expect(r.challenge).toBe(false)
  })
})

describe('detectAntiBot — Akamai', () => {
  it('flags the "Access Denied" reference page as an Akamai challenge', () => {
    const r = detectAntiBot(akamaiChallenge)
    expect(r.vendor).toBe('akamai')
    expect(r.challenge).toBe(true)
    expect(evidenceText(r)).toMatch(/access denied/i)
  })

  it('treats _abck / akamai scripts on real content as passive presence', () => {
    const r = detectAntiBot(akamaiPassive)
    expect(r.vendor).toBe('akamai')
    expect(r.challenge).toBe(false)
  })
})

describe('detectAntiBot — PerimeterX', () => {
  it('flags the px-captcha "Press & Hold" interstitial as a challenge', () => {
    const r = detectAntiBot(perimeterxChallenge)
    expect(r.vendor).toBe('perimeterx')
    expect(r.challenge).toBe(true)
    expect(evidenceText(r)).toMatch(/px-captcha|press/i)
  })

  it('treats _px cookies on real content as passive presence', () => {
    const r = detectAntiBot(perimeterxPassive)
    expect(r.vendor).toBe('perimeterx')
    expect(r.challenge).toBe(false)
  })
})

describe('detectAntiBot — Imperva', () => {
  it('flags the Incapsula incident page as a challenge', () => {
    const r = detectAntiBot(impervaChallenge)
    expect(r.vendor).toBe('imperva')
    expect(r.challenge).toBe(true)
    expect(evidenceText(r)).toMatch(/incapsula|incident/i)
  })

  it('treats _Incapsula_Resource + incap cookies on real content as passive presence', () => {
    const r = detectAntiBot(impervaPassive)
    expect(r.vendor).toBe('imperva')
    expect(r.challenge).toBe(false)
  })
})

describe('detectAntiBot — reCAPTCHA / hCaptcha', () => {
  it('treats an embedded g-recaptcha widget as passive presence', () => {
    const r = detectAntiBot(recaptchaPassive)
    expect(r.vendor).toBe('recaptcha')
    expect(r.challenge).toBe(false)
  })

  it('flags reCAPTCHA with an interstitial title as a challenge', () => {
    const r = detectAntiBot(recaptchaChallenge)
    expect(r.vendor).toBe('recaptcha')
    expect(r.challenge).toBe(true)
  })

  it('treats an embedded h-captcha widget as passive presence', () => {
    const r = detectAntiBot(hcaptchaPassive)
    expect(r.vendor).toBe('hcaptcha')
    expect(r.challenge).toBe(false)
  })

  it('flags hCaptcha with an "Are you a robot?" interstitial title as a challenge', () => {
    const r = detectAntiBot(hcaptchaChallenge)
    expect(r.vendor).toBe('hcaptcha')
    expect(r.challenge).toBe(true)
  })

  it('prefers Cloudflare when both Turnstile and reCAPTCHA widgets are present', () => {
    const r = detectAntiBot({
      html: '<div class="cf-turnstile"></div><div class="g-recaptcha"></div>',
    })
    expect(r.vendor).toBe('cloudflare')
  })
})

// ── detectAntiBot: unknown + invariants ─────────────────────────────────────

describe('detectAntiBot — unknown and invariants', () => {
  it('returns the canonical unknown result for empty signals', () => {
    expect(detectAntiBot({})).toEqual({
      vendor: 'unknown',
      challenge: false,
      confidence: 0,
      evidence: [],
    })
  })

  it('returns unknown for an ordinary content page', () => {
    const r = detectAntiBot({ title: 'My Blog', html: '<h1>Hello world</h1><p>Posts...</p>', status: 200 })
    expect(r.vendor).toBe('unknown')
    expect(r.challenge).toBe(false)
    expect(r.confidence).toBe(0)
    expect(r.evidence).toEqual([])
  })

  it('does not fire on the bare noun "captcha" in ordinary prose', () => {
    const r = detectAntiBot({
      title: 'How our captcha policy works',
      html: '<p>This blog post explains captcha UX patterns.</p>',
    })
    expect(r.vendor).toBe('unknown')
    expect(r.challenge).toBe(false)
  })

  it('does not invent a vendor from a generic interstitial title alone', () => {
    const r = detectAntiBot({ title: 'Please wait' })
    expect(r.vendor).toBe('unknown')
    expect(r.challenge).toBe(false)
    expect(r.confidence).toBe(0)
  })

  it('keeps confidence within [0, 1] for every fixture', () => {
    for (const signals of allFixtures) {
      const r = detectAntiBot(signals)
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('lists non-empty evidence whenever a vendor is detected', () => {
    for (const signals of allFixtures) {
      const r = detectAntiBot(signals)
      expect(r.vendor).not.toBe('unknown')
      expect(r.evidence.length).toBeGreaterThan(0)
    }
  })

  it('does not mutate frozen (untrusted) input signals', () => {
    const frozen: AntiBotSignals = Object.freeze({
      title: 'Just a moment...',
      html: '<div id="cf-challenge"></div><script>__cf_chl_opt</script>',
      headers: Object.freeze({ 'cf-ray': 'x-SGN' }),
      status: 403,
    })
    expect(() => detectAntiBot(frozen)).not.toThrow()
    expect(detectAntiBot(frozen).vendor).toBe('cloudflare')
  })
})

// ── detectAntiBot: confidence + evidence semantics ──────────────────────────

describe('detectAntiBot — confidence and evidence', () => {
  it('raises confidence and flips challenge when a challenge header corroborates a passive signal', () => {
    const passive = detectAntiBot({ headers: { 'cf-ray': 'x-SGN' } })
    const challenged = detectAntiBot({ headers: { 'cf-ray': 'x-SGN', 'cf-mitigated': 'challenge' } })
    expect(passive.challenge).toBe(false)
    expect(challenged.challenge).toBe(true)
    expect(challenged.confidence).toBeGreaterThan(passive.confidence)
  })

  it('scores a full interstitial higher than a bare passive cookie', () => {
    const interstitial = detectAntiBot(cfChallenge)
    const passive = detectAntiBot(cfSolvedCookie)
    expect(interstitial.confidence).toBeGreaterThan(passive.confidence)
  })

  it('records a blocking status code as supporting evidence without inventing a challenge', () => {
    const withStatus = detectAntiBot({ headers: { 'cf-ray': 'x-SGN' }, status: 403 })
    const withoutStatus = detectAntiBot({ headers: { 'cf-ray': 'x-SGN' } })
    expect(withStatus.vendor).toBe('cloudflare')
    expect(withStatus.challenge).toBe(false)
    expect(evidenceText(withStatus)).toMatch(/403/)
    expect(withStatus.confidence).toBeGreaterThan(withoutStatus.confidence)
  })

  it('ignores a non-blocking status code for evidence', () => {
    const r = detectAntiBot({ headers: { 'cf-ray': 'x-SGN' }, status: 200 })
    expect(evidenceText(r)).not.toMatch(/200/)
  })
})

// ── looksBlocked: the smart_fetch escalation gate ───────────────────────────

describe('looksBlocked', () => {
  it('is true for a challenge interstitial even with a 200 status', () => {
    expect(looksBlocked(cfChallenge.html ?? '', cfChallenge.headers, 200)).toBe(true)
  })

  it('is true for a 403 with anti-bot headers but a bare body', () => {
    expect(looksBlocked('<html><body>Forbidden</body></html>', { 'cf-ray': 'x-SGN' }, 403)).toBe(true)
  })

  it('is true for a 429 with a DataDome cookie', () => {
    expect(looksBlocked('', { 'set-cookie': 'datadome=xYz' }, 429)).toBe(true)
  })

  it('is true for a 503 with Akamai bot-manager signals', () => {
    expect(looksBlocked('<script>var _abck="x";</script>', undefined, 503)).toBe(true)
  })

  it('is false for a 403 without any anti-bot signal', () => {
    expect(looksBlocked('<html><body>Forbidden</body></html>', undefined, 403)).toBe(false)
  })

  it('is false for a 500 even with anti-bot headers (not an escalation status)', () => {
    expect(looksBlocked('', { 'cf-ray': 'x-SGN' }, 500)).toBe(false)
  })

  it('is false for passive vendor presence on a 200 page', () => {
    expect(looksBlocked(cfPassiveWidget.html ?? '', cfPassiveWidget.headers, 200)).toBe(false)
    expect(looksBlocked(datadomePassive.html ?? '', datadomePassive.headers, 200)).toBe(false)
  })

  it('is false for a solved cf_clearance cookie on real content', () => {
    expect(looksBlocked(cfSolvedCookie.html ?? '', cfSolvedCookie.headers, 200)).toBe(false)
  })

  it('is false for empty input', () => {
    expect(looksBlocked('')).toBe(false)
    expect(looksBlocked('', undefined, 403)).toBe(false)
  })

  it('is true for the Akamai "Access Denied" page regardless of status', () => {
    expect(looksBlocked(akamaiChallenge.html ?? '', undefined, 403)).toBe(true)
    expect(looksBlocked(akamaiChallenge.html ?? '')).toBe(true)
  })
})
