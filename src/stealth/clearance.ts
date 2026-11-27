// Clearance-cache pattern inspired by fastCRW (concept only; original implementation).

/** Longest a clearance entry lives, regardless of the cookie's own expiry. */
export const CLEARANCE_MAX_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Common multi-part public suffixes (eTLDs with two labels).
 *
 * This is a pragmatic, deliberately small heuristic — NOT the full Public
 * Suffix List. It covers the frequent `co.*` / `com.*` / `org.*` / `net.*`
 * second-level TLDs so that `example.co.uk` is not collapsed to `co.uk`.
 * Any suffix not listed here falls back to the plain last-two-labels rule.
 */
const MULTI_PART_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'asn.au', 'com.au', 'edu.au', 'gov.au', 'id.au', 'net.au', 'org.au',
  'ac.jp', 'co.jp', 'go.jp', 'ne.jp', 'or.jp',
  'com.br', 'net.br', 'org.br',
  'co.nz', 'net.nz', 'org.nz',
  'co.in', 'net.in', 'org.in',
  'co.za', 'net.za', 'org.za',
  'com.mx', 'net.mx', 'org.mx',
  'com.cn', 'net.cn', 'org.cn',
  'com.hk', 'com.tw', 'com.sg',
  'co.kr', 'or.kr',
  'co.th', 'or.th',
  'com.my', 'com.ph', 'com.vn',
  'com.tr', 'com.ua', 'com.ar', 'com.co', 'com.pe', 'com.ec',
  'co.id', 'co.il',
  'com.pl', 'com.ro', 'com.gr', 'com.pt', 'com.es',
  'com.sa', 'com.eg', 'com.ng', 'com.pk', 'com.bd',
])

/**
 * Reduce a hostname to its registrable domain (eTLD+1).
 *
 * Heuristic only — NOT the full Public Suffix List.
 */
export function registrableHost(host: string): string {
  let h = host.trim().toLowerCase()
  // Bracketed IPv6 literal, possibly with a port: `[2001:db8::1]:443`.
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(1, end)
  }
  // Bare IPv6 literal has more than one colon; a host:port has at most one.
  if ((h.match(/:/g) ?? []).length > 1) return h
  const colon = h.lastIndexOf(':')
  if (colon !== -1) h = h.slice(0, colon)
  if (h.endsWith('.')) h = h.slice(0, -1)
  // IPv4 literal: never split into a "registrable domain".
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h
  const labels = h.split('.')
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

/** One cached clearance: the `cf_clearance` cookie bound to the UA that solved it. */
export interface ClearanceEntry {
  cookie: string
  userAgent: string
  expiresAt: number
}

/** In-memory, bounded LRU cache of clearance entries keyed by registrable host. */
export class ClearanceCache {
  private readonly entries = new Map<string, ClearanceEntry>()
  private readonly maxEntries: number

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries
  }

  remember(host: string, cookie: string, userAgent: string, expiresAt?: number): void {
    const key = registrableHost(host)
    const capped = Date.now() + CLEARANCE_MAX_TTL_MS
    // Delete first so a re-remember moves the entry to the most-recent end.
    this.entries.delete(key)
    this.entries.set(key, {
      cookie,
      userAgent,
      expiresAt: expiresAt === undefined ? capped : Math.min(expiresAt, capped),
    })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  lookup(host: string): ClearanceEntry | null {
    const key = registrableHost(host)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return null
    }
    // A hit counts as a use: move the entry to the most-recent end.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  forget(host: string): void {
    this.entries.delete(registrableHost(host))
  }

  get size(): number {
    return this.entries.size
  }
}