import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registrableHost, ClearanceCache, CLEARANCE_MAX_TTL_MS } from '../src/stealth/clearance.ts'

const NOW = 1_700_000_000_000

describe('registrableHost', () => {
  it('reduces subdomains to the registrable domain under a plain TLD', () => {
    expect(registrableHost('www.example.com')).toBe('example.com')
    expect(registrableHost('example.com')).toBe('example.com')
    expect(registrableHost('localhost')).toBe('localhost')
  })

  it('keeps one extra label for common multi-part public suffixes', () => {
    expect(registrableHost('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableHost('shop.example.com.au')).toBe('example.com.au')
    expect(registrableHost('www.example.co.jp')).toBe('example.co.jp')
    expect(registrableHost('example.com.br')).toBe('example.com.br')
    expect(registrableHost('co.uk')).toBe('co.uk')
  })

  it('lowercases the host and strips any port or trailing dot', () => {
    expect(registrableHost('WWW.Example.COM:8443')).toBe('example.com')
    expect(registrableHost('Example.Co.Uk:443')).toBe('example.co.uk')
    expect(registrableHost('Example.COM.')).toBe('example.com')
  })

  it('returns IP literals unchanged (port stripped, never split)', () => {
    expect(registrableHost('192.168.1.1')).toBe('192.168.1.1')
    expect(registrableHost('127.0.0.1:8080')).toBe('127.0.0.1')
    expect(registrableHost('8.8.8.8')).toBe('8.8.8.8')
    expect(registrableHost('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(registrableHost('2001:db8::1')).toBe('2001:db8::1')
  })
})

describe('CLEARANCE_MAX_TTL_MS', () => {
  it('is 24 hours in milliseconds', () => {
    expect(CLEARANCE_MAX_TTL_MS).toBe(86_400_000)
  })
})

describe('ClearanceCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores the cookie together with the user agent that solved it', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0')
    const entry = cache.lookup('example.com')
    expect(entry).not.toBeNull()
    expect(entry!.cookie).toBe('cf_clearance=abc')
    expect(entry!.userAgent).toBe('UA/1.0')
    expect(typeof entry!.expiresAt).toBe('number')
  })

  it('replaces the cookie+UA pair when the same host is remembered again', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=old', 'UA/1.0')
    cache.remember('example.com', 'cf_clearance=new', 'UA/2.0')
    const entry = cache.lookup('example.com')
    expect(entry!.cookie).toBe('cf_clearance=new')
    expect(entry!.userAgent).toBe('UA/2.0')
    expect(cache.size).toBe(1)
  })

  it('defaults expiry to now + 24h when expiresAt is omitted', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0')
    expect(cache.lookup('example.com')!.expiresAt).toBe(NOW + 86_400_000)
  })

  it('caps a longer cookie expiry at 24h', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0', NOW + 30 * 86_400_000)
    expect(cache.lookup('example.com')!.expiresAt).toBe(NOW + 86_400_000)
  })

  it('honors a shorter cookie expiry and removes expired entries lazily', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0', NOW + 60_000)
    expect(cache.lookup('example.com')!.expiresAt).toBe(NOW + 60_000)
    vi.setSystemTime(NOW + 59_999)
    expect(cache.lookup('example.com')).not.toBeNull()
    vi.setSystemTime(NOW + 60_000)
    expect(cache.lookup('example.com')).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('does not serve an entry whose expiry is already in the past', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0', NOW - 1000)
    expect(cache.lookup('example.com')).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('shares one entry across subdomains of the same registrable host', () => {
    const cache = new ClearanceCache()
    cache.remember('www.example.co.uk', 'cf_clearance=abc', 'UA/1.0')
    expect(cache.lookup('api.example.co.uk')!.cookie).toBe('cf_clearance=abc')
    expect(cache.lookup('EXAMPLE.CO.UK:443')!.userAgent).toBe('UA/1.0')
    expect(cache.size).toBe(1)
  })

  it('evicts the least-recently-used entry when over maxEntries', () => {
    const cache = new ClearanceCache(2)
    cache.remember('a.com', 'cf_clearance=a', 'UA/a')
    cache.remember('b.com', 'cf_clearance=b', 'UA/b')
    cache.lookup('a.com') // touch a, so b becomes the least-recently-used
    cache.remember('c.com', 'cf_clearance=c', 'UA/c')
    expect(cache.size).toBe(2)
    expect(cache.lookup('b.com')).toBeNull()
    expect(cache.lookup('a.com')!.cookie).toBe('cf_clearance=a')
    expect(cache.lookup('c.com')!.cookie).toBe('cf_clearance=c')
  })

  it('bounds the default cache at 1000 entries', () => {
    const cache = new ClearanceCache()
    for (let i = 0; i < 1001; i++) cache.remember(`host${i}.com`, 'cf_clearance=x', 'UA/x')
    expect(cache.size).toBe(1000)
    expect(cache.lookup('host0.com')).toBeNull()
    expect(cache.lookup('host1000.com')).not.toBeNull()
  })

  it('forgets an entry via any host that maps to it', () => {
    const cache = new ClearanceCache()
    cache.remember('www.example.com', 'cf_clearance=abc', 'UA/1.0')
    cache.forget('EXAMPLE.COM:443')
    expect(cache.lookup('www.example.com')).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('ignores forget for a host that was never cached', () => {
    const cache = new ClearanceCache()
    cache.remember('example.com', 'cf_clearance=abc', 'UA/1.0')
    cache.forget('other.com')
    expect(cache.size).toBe(1)
    expect(cache.lookup('example.com')).not.toBeNull()
  })
})