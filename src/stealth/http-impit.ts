// src/stealth/http-impit.ts — browserless HTTP with Firefox TLS impersonation.
//
// Concepts adapted from mcp-camoufox (MIT, RobithYusuf): lazy-loaded impit native
// client, anti-bot block markers, and the manual-redirect security fix (impit
// replays a manually-set Cookie header onto redirect targets, so redirects are
// followed by hand and credential headers are dropped on cross-origin hops).
// Original implementation; no AGPL code.
//
// Deep module: all transport behaviour behind impitFetch/smartFetch. Dependencies
// (impit loader, block detector, clearance cache) are injected so this module is
// testable without the native binary, the browser, or the sibling stealth modules.

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface FetchResponse {
  status: number
  headers: Record<string, string> | { entries(): Iterable<[string, string]> }
  text(): Promise<string>
  url?: string
}

export interface ImpitLike {
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>
}

export interface ClearanceLike {
  lookup(host: string): { cookie: string; userAgent: string } | null
  remember?(host: string, cookie: string, userAgent: string, expiresAt?: number): void
}

export interface HttpDeps {
  loadImpit?: (opts: { browser: string; timeout: number; followRedirects: boolean; proxyUrl?: string }) => Promise<ImpitLike>
  detectBlocked?: (status: number | null, text: string, headers?: Record<string, string>) => boolean
  clearance?: ClearanceLike
}

export interface ImpitFetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  impersonate?: 'firefox' | 'chrome'
  proxy?: string
  timeoutMs?: number
}

export interface HttpResponse {
  status: number | null
  text: string
  headers: Record<string, string>
  url: string
  error?: string
  redirects?: string[]
}

const MAX_HOPS = 5
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const BLOCK_STATUS = new Set([401, 403, 405, 406, 409, 421, 429, 503])
const BLOCK_MARKERS = [
  'just a moment', 'cf-chl', 'challenge-platform', 'checking your browser',
  'attention required', 'captcha-delivery', 'please verify you are a human',
  'access denied', 'enable javascript and cookies to continue',
  'verifying you are human', 'px-captcha', 'incapsula incident',
]
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0'

/** Does this response smell like an anti-bot wall (worth spending a browser on)? */
export function looksBlockedDefault(status: number | null, text: string): boolean {
  if (status === null) return true
  if (BLOCK_STATUS.has(status)) return true
  const low = (text || '').slice(0, 6000).toLowerCase()
  return BLOCK_MARKERS.some((m) => low.includes(m))
}

/** A 200 with a near-empty HTML body MAY be a JS-challenge shell. Soft signal. */
export function looksThin(status: number | null, text: string): boolean {
  if (status !== 200) return false
  const low = (text || '').toLowerCase()
  return low.length < 512 && (low.includes('<html') || low.trim() === '')
}

function normalizeHeaders(h: FetchResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  const entries = typeof (h as { entries?: unknown }).entries === 'function'
    ? (h as { entries(): Iterable<[string, string]> }).entries()
    : Object.entries(h as Record<string, string>)
  for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v)
  return out
}

function headerGet(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

async function defaultLoadImpit(opts: { browser: string; timeout: number; followRedirects: boolean; proxyUrl?: string }): Promise<ImpitLike> {
  let mod: { Impit: new (o: unknown) => ImpitLike }
  try {
    // Variable specifier keeps this optional native dep out of static type
    // resolution: impit may be absent on a platform without prebuilt bindings.
    const specifier = 'impit'
    mod = await import(specifier) as { Impit: new (o: unknown) => ImpitLike }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`impit (native HTTP client) unavailable on this platform: ${msg}. Use the browser tools instead.`)
  }
  return new mod.Impit(opts)
}

function captureClearance(hdrs: Record<string, string>, host: string, ua: string, clearance?: ClearanceLike): void {
  if (!clearance?.remember || !host) return
  const sc = hdrs['set-cookie']
  if (!sc) return
  const m = /cf_clearance=([^;]+)/.exec(sc)
  if (!m) return
  let expiresAt: number | undefined
  const maxAge = /Max-Age=(\d+)/i.exec(sc)
  if (maxAge) expiresAt = Date.now() + parseInt(maxAge[1]!, 10) * 1000
  else {
    const exp = /Expires=([^;]+)/i.exec(sc)
    if (exp) {
      const t = Date.parse(exp[1]!)
      if (!Number.isNaN(t)) expiresAt = t
    }
  }
  clearance.remember(host, `cf_clearance=${m[1]}`, ua, expiresAt)
}

/**
 * Fetch with Firefox TLS impersonation, following redirects manually so a
 * cross-origin hop never receives the caller's Cookie/Authorization headers.
 * Injects a cached cf_clearance (+ its paired UA) when one exists for the host,
 * and captures a fresh cf_clearance from the response into the cache.
 */
export async function impitFetch(opts: ImpitFetchOptions, deps: HttpDeps = {}): Promise<HttpResponse> {
  const callerHeaders: Record<string, string> = { ...(opts.headers || {}) }
  let url = opts.url
  let method = (opts.method || 'GET').toUpperCase()
  let body = opts.body
  const trail: string[] = []
  try {
    const loadImpit = deps.loadImpit || defaultLoadImpit
    const client = await loadImpit({
      browser: opts.impersonate || 'firefox',
      timeout: opts.timeoutMs || 30000,
      followRedirects: false,
      ...(opts.proxy ? { proxyUrl: opts.proxy } : {}),
    })
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const headers: Record<string, string> = { ...callerHeaders }
      const host = safeHostname(url)
      const entry = deps.clearance?.lookup(host)
      if (entry) {
        const existing = headerGet(headers, 'cookie')
        headers['Cookie'] = existing ? `${existing}; ${entry.cookie}` : entry.cookie
        if (!headerGet(headers, 'user-agent')) headers['User-Agent'] = entry.userAgent
      }
      const resp = await client.fetch(url, { method, headers, ...(body ? { body } : {}) })
      const hdrs = normalizeHeaders(resp.headers)
      captureClearance(hdrs, host, headerGet(headers, 'user-agent') || DEFAULT_UA, deps.clearance)

      if (REDIRECT_CODES.has(resp.status)) {
        const loc = hdrs['location']
        if (!loc) return { status: resp.status, text: await resp.text().catch(() => ''), headers: hdrs, url, redirects: trail }
        let next: string
        try { next = new URL(loc, url).toString() } catch {
          return { status: resp.status, text: '', headers: hdrs, url, error: `bad Location header: ${loc}`, redirects: trail }
        }
        const sameOrigin = safeOrigin(next) === safeOrigin(url)
        if (!sameOrigin) {
          for (const k of Object.keys(callerHeaders)) {
            if (/^(cookie|authorization|proxy-authorization)$/i.test(k)) delete callerHeaders[k]
          }
        }
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET'
          body = undefined
        }
        trail.push(`${resp.status} -> ${next}${sameOrigin ? '' : ' (cross-origin: credentials dropped)'}`)
        url = next
        continue
      }
      return { status: resp.status, text: await resp.text().catch(() => ''), headers: hdrs, url: resp.url || url, redirects: trail }
    }
    return { status: null, text: '', headers: {}, url, error: `too many redirects (>${MAX_HOPS})`, redirects: trail }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: null, text: '', headers: {}, url, error: msg, redirects: trail }
  }
}

export interface SmartFetchResult {
  response: HttpResponse
  escalate: boolean
  reason?: string
}

/**
 * Browserless-first fetch: try impit, and recommend escalating to the real
 * browser only when the response looks anti-bot blocked (or a thin challenge
 * shell). The caller performs the escalation; this module only decides.
 */
export async function smartFetch(opts: ImpitFetchOptions, deps: HttpDeps = {}): Promise<SmartFetchResult> {
  const response = await impitFetch(opts, deps)
  const detect = deps.detectBlocked || ((status: number | null, text: string) => looksBlockedDefault(status, text))
  if (response.error) return { response, escalate: true, reason: `http-error: ${response.error}` }
  if (detect(response.status, response.text, response.headers)) return { response, escalate: true, reason: 'anti-bot-blocked' }
  if (looksThin(response.status, response.text)) return { response, escalate: true, reason: 'thin-js-challenge-shell' }
  return { response, escalate: false }
}
