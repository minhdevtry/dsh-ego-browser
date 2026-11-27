/**
 * src/stealth/antibot-detect.ts — anti-bot vendor + challenge detection.
 *
 * Heuristics adapted from mcp-camoufox (MIT, RobithYusuf).
 *
 * Pure data module for smart_fetch escalation: classify a page from the
 * signals a fetch already has (HTML, title, response headers, URL, status)
 * without a browser. Two exported functions are the whole interface; the
 * rule table, weights and header/cookie parsing stay private so callers
 * never depend on detection internals.
 *
 * Page content is UNTRUSTED input: it is only pattern-matched with literal
 * regular expressions, never evaluated, parsed as HTML, or executed. All
 * patterns are flat alternations (no nested quantifiers) so matching stays
 * linear and cannot catastrophically backtrack on hostile pages.
 *
 * Semantics:
 * - `vendor` is the best-supported vendor; ties resolve by VENDOR_PRIORITY.
 * - `challenge` means an interactive interstitial is blocking the page, not
 *   merely that a vendor script/cookie is present (a passed page still carries
 *   cf_clearance / datadome / _abck cookies).
 * - `confidence` is the capped sum of the matched signal weights (0..1).
 * - Nothing matched → { vendor: 'unknown', challenge: false, confidence: 0,
 *   evidence: [] }. A generic interstitial title alone never invents a vendor.
 */

export type AntiBotVendor =
  | 'cloudflare'
  | 'datadome'
  | 'akamai'
  | 'perimeterx'
  | 'imperva'
  | 'recaptcha'
  | 'hcaptcha'
  | 'unknown'

export interface AntiBotSignals {
  html?: string
  title?: string
  headers?: Record<string, string>
  url?: string
  status?: number
}

export interface AntiBotResult {
  vendor: AntiBotVendor
  challenge: boolean
  confidence: number
  evidence: string[]
}

type Vendor = Exclude<AntiBotVendor, 'unknown'>

interface Match {
  vendor: Vendor
  challenge: boolean
  weight: number
  label: string
}

interface PatternRule {
  vendor: Vendor
  source: 'html' | 'title' | 'url'
  pattern: RegExp
  challenge: boolean
  weight: number
  label: string
}

/** Tie-break order when two vendors score the same. */
const VENDOR_PRIORITY: Vendor[] = [
  'cloudflare',
  'datadome',
  'akamai',
  'perimeterx',
  'imperva',
  'recaptcha',
  'hcaptcha',
]

/** Status codes that, combined with any vendor signal, mean "blocked". */
const BLOCK_STATUSES = new Set([403, 429, 503])

/**
 * Interstitial title phrasing (mcp-camoufox detect_anti_bot). Only upgrades
 * `challenge` when a vendor is already detected — alone it identifies nobody.
 */
const INTERSTITIAL_TITLE =
  /just a moment|checking your browser|verifying you are human|verify you are (?:a )?human|performing security|attention required|access denied|one more step|please wait|are you a robot|press\s*(?:&|and)\s*hold/i

/**
 * Content rules. Challenge markers are interstitial artifacts (challenge
 * scripts, captcha iframes, block-page titles); passive markers are vendor
 * scripts/widgets/cookies that also live on already-passed pages. Weights:
 * challenge marker 0.6, passive marker 0.2 (headers/cookies weigh more below).
 */
const RULES: PatternRule[] = [
  // Cloudflare — "Just a moment", challenge-platform scripts, Turnstile.
  { vendor: 'cloudflare', source: 'title', pattern: /just a moment/i, challenge: true, weight: 0.6, label: 'title: "Just a moment"' },
  { vendor: 'cloudflare', source: 'title', pattern: /cloudflare/i, challenge: false, weight: 0.2, label: 'title: cloudflare' },
  { vendor: 'cloudflare', source: 'html', pattern: /__cf_chl|cf-chl|cf-challenge|challenge-platform/i, challenge: true, weight: 0.6, label: 'html: cf-chl' },
  { vendor: 'cloudflare', source: 'html', pattern: /challenges\.cloudflare\.com|turnstile/i, challenge: false, weight: 0.2, label: 'html: turnstile' },
  { vendor: 'cloudflare', source: 'url', pattern: /challenges\.cloudflare\.com/i, challenge: false, weight: 0.2, label: 'url: challenges.cloudflare.com' },
  // DataDome — captcha-delivery iframe is the block; tags.js/cookie is passive.
  { vendor: 'datadome', source: 'html', pattern: /dd-captcha|captcha-delivery/i, challenge: true, weight: 0.6, label: 'html: datadome captcha' },
  { vendor: 'datadome', source: 'html', pattern: /datadome/i, challenge: false, weight: 0.2, label: 'html: datadome' },
  { vendor: 'datadome', source: 'title', pattern: /datadome/i, challenge: false, weight: 0.2, label: 'title: datadome' },
  // Akamai — "Access Denied" reference page is the block; _abck/akamai scripts passive.
  { vendor: 'akamai', source: 'title', pattern: /access denied/i, challenge: true, weight: 0.6, label: 'title: "Access Denied"' },
  { vendor: 'akamai', source: 'html', pattern: /access denied/i, challenge: true, weight: 0.6, label: 'html: "Access Denied"' },
  { vendor: 'akamai', source: 'html', pattern: /akamai|akam\.net|_abck|_bm\.|bot-detector/i, challenge: false, weight: 0.2, label: 'html: akamai' },
  // PerimeterX — px-captcha / "Press & Hold" is the block; _px cookies passive.
  { vendor: 'perimeterx', source: 'html', pattern: /px-captcha/i, challenge: true, weight: 0.6, label: 'html: px-captcha' },
  { vendor: 'perimeterx', source: 'title', pattern: /press\s*(?:&|&amp;|and)\s*hold/i, challenge: true, weight: 0.6, label: 'title: "Press & Hold"' },
  { vendor: 'perimeterx', source: 'html', pattern: /press\s*(?:&|&amp;|and)\s*hold/i, challenge: true, weight: 0.6, label: 'html: "Press & Hold"' },
  { vendor: 'perimeterx', source: 'html', pattern: /perimeterx|_px|px-cdn\.net/i, challenge: false, weight: 0.2, label: 'html: perimeterx' },
  // Imperva — Incapsula incident page is the block; _Incapsula_Resource passive.
  { vendor: 'imperva', source: 'html', pattern: /incapsula incident|request unsuccessful/i, challenge: true, weight: 0.6, label: 'html: imperva incident' },
  { vendor: 'imperva', source: 'html', pattern: /incapsula|_incap_|imperva/i, challenge: false, weight: 0.2, label: 'html: imperva' },
  // reCAPTCHA / hCaptcha — embedded widgets are passive; an interstitial title
  // (handled by INTERSTITIAL_TITLE) is what makes them a blocking challenge.
  { vendor: 'recaptcha', source: 'html', pattern: /g-recaptcha|recaptcha|grecaptcha/i, challenge: false, weight: 0.2, label: 'html: recaptcha' },
  { vendor: 'recaptcha', source: 'title', pattern: /recaptcha/i, challenge: false, weight: 0.2, label: 'title: recaptcha' },
  { vendor: 'hcaptcha', source: 'html', pattern: /hcaptcha|h-captcha/i, challenge: false, weight: 0.2, label: 'html: hcaptcha' },
  { vendor: 'hcaptcha', source: 'title', pattern: /hcaptcha/i, challenge: false, weight: 0.2, label: 'title: hcaptcha' },
]

/** Header names are case-insensitive; cookies arrive folded into set-cookie. */
function headerMatches(headers: Record<string, string>): Match[] {
  const lower: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value ?? ''
  const matches: Match[] = []
  const add = (vendor: Vendor, challenge: boolean, weight: number, label: string): void => {
    matches.push({ vendor, challenge, weight, label })
  }

  // cf-mitigated is only sent when Cloudflare mitigates the request.
  if (lower['cf-mitigated'] !== undefined) add('cloudflare', true, 0.7, 'header: cf-mitigated')
  // cf-ray rides on every proxied response, blocked or not.
  if (lower['cf-ray'] !== undefined) add('cloudflare', false, 0.3, 'header: cf-ray')
  if (lower['x-datadome'] !== undefined || lower['x-dd-b'] !== undefined || lower['x-dd-type'] !== undefined) {
    add('datadome', false, 0.3, 'header: datadome')
  }
  if (Object.keys(lower).some((k) => k === 'akamai-grn' || k.startsWith('x-akamai'))) {
    add('akamai', false, 0.3, 'header: akamai')
  }
  if (lower['x-iinfo'] !== undefined) add('imperva', false, 0.3, 'header: x-iinfo')

  const cookie = lower['set-cookie'] ?? ''
  // cf_clearance means a challenge was already solved — passive presence.
  if (/cf_clearance|__cf_bm/i.test(cookie)) add('cloudflare', false, 0.3, 'cookie: cloudflare')
  if (/datadome/i.test(cookie)) add('datadome', false, 0.3, 'cookie: datadome')
  if (/_abck/i.test(cookie)) add('akamai', false, 0.3, 'cookie: _abck')
  if (/(?:^|;\s*)_px/i.test(cookie)) add('perimeterx', false, 0.3, 'cookie: _px')
  if (/incap_ses|visid_incap|_incap_/i.test(cookie)) add('imperva', false, 0.3, 'cookie: incap')
  return matches
}

/**
 * Identify the anti-bot vendor behind a page and whether an interactive
 * challenge interstitial is currently blocking it. Pure: reads the signals,
 * never executes or mutates them.
 */
export function detectAntiBot(signals: AntiBotSignals): AntiBotResult {
  const sources = {
    html: signals.html ?? '',
    title: signals.title ?? '',
    url: signals.url ?? '',
  }
  const matches: Match[] = []
  for (const rule of RULES) {
    if (rule.pattern.test(sources[rule.source])) {
      matches.push({ vendor: rule.vendor, challenge: rule.challenge, weight: rule.weight, label: rule.label })
    }
  }
  if (signals.headers) matches.push(...headerMatches(signals.headers))

  const scores = new Map<Vendor, number>()
  for (const m of matches) scores.set(m.vendor, (scores.get(m.vendor) ?? 0) + m.weight)

  let vendor: Vendor | undefined
  let best = 0
  for (const v of VENDOR_PRIORITY) {
    const score = scores.get(v) ?? 0
    if (score > best) {
      vendor = v
      best = score
    }
  }
  if (!vendor) return { vendor: 'unknown', challenge: false, confidence: 0, evidence: [] }

  const own = matches.filter((m) => m.vendor === vendor)
  let challenge = own.some((m) => m.challenge)
  let score = own.reduce((sum, m) => sum + m.weight, 0)
  const evidence = own.map((m) => m.label)

  // An interstitial title upgrades a passive vendor hit to a challenge
  // (e.g. "Attention Required! | Cloudflare", "Verify you are human").
  if (!challenge && INTERSTITIAL_TITLE.test(sources.title)) {
    challenge = true
    score += 0.5
    evidence.push('title: interstitial phrase')
  }
  // A blocking status corroborates the detection but is not itself an
  // interstitial — looksBlocked owns the status-based escalation decision.
  if (signals.status !== undefined && BLOCK_STATUSES.has(signals.status)) {
    score += 0.2
    evidence.push(`status: ${signals.status}`)
  }

  return {
    vendor,
    challenge,
    confidence: Math.min(1, Math.round(score * 100) / 100),
    evidence: [...new Set(evidence)],
  }
}

/**
 * smart_fetch escalation gate: true when the page shows a challenge, or when
 * a blocking status (403/429/503) comes with any anti-bot vendor signal.
 * Passive vendor presence on a normal 200 page is NOT a block.
 */
export function looksBlocked(html: string, headers?: Record<string, string>, status?: number): boolean {
  const result = detectAntiBot({ html, headers, status })
  if (result.challenge) return true
  return result.vendor !== 'unknown' && status !== undefined && BLOCK_STATUSES.has(status)
}
