/**
 * tests/storage-state.test.ts — seams for src/stealth/storage-state.ts.
 *
 * Pure-logic seams only: empty state, parse validation, deterministic
 * serialization, round-trip, and the two page.evaluate expression builders.
 * Expression strings are exercised against plain Node stubs of
 * document/localStorage/location (same no-browser harness idea as
 * click-script.test.ts) — never a real browser.
 */
import { describe, it, expect } from 'vitest'
import { emptyStorageState, parseStorageState, serializeStorageState, collectStorageExpression, applyStorageExpression, type StorageState } from '../src/stealth/storage-state.ts'

/** Minimal localStorage stub backed by a Map (no browser, no jsdom). */
const stubStorage = (entries: [string, string][]) => {
  const map = new Map(entries)
  return {
    get length() { return map.size },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    snapshot: () => Array.from(map.entries()),
  }
}

/** Evaluate a page.evaluate expression string against plain stubs, Node-only. */
const evaluateExpression = (
  expr: string,
  globals: { document: unknown, localStorage: unknown, location: unknown },
): unknown =>
  new Function('document', 'localStorage', 'location', `"use strict"; return (${expr})`)(
    globals.document, globals.localStorage, globals.location,
  )

describe('emptyStorageState', () => {
  it('returns a version-1 state with empty cookies and origins, fresh each call', () => {
    expect(emptyStorageState()).toEqual({ version: 1, cookies: [], origins: [] })
    const first = emptyStorageState()
    first.cookies.push({ name: 'sid', value: 'x', domain: 'example.com', path: '/' })
    first.origins.push({ origin: 'https://example.com', localStorage: [] })
    expect(emptyStorageState()).toEqual({ version: 1, cookies: [], origins: [] })
  })
})

describe('parseStorageState', () => {
  it('accepts a valid state and tolerates missing optional cookie fields', () => {
    const json = JSON.stringify({
      version: 1,
      cookies: [
        { name: 'sid', value: 'abc', domain: '.example.com', path: '/' },
        {
          name: 'pref', value: 'dark', domain: 'example.com', path: '/app',
          expires: 1893456000, httpOnly: false, secure: true, sameSite: 'Lax',
        },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }] },
      ],
    })
    expect(parseStorageState(json)).toEqual({
      version: 1,
      cookies: [
        { name: 'sid', value: 'abc', domain: '.example.com', path: '/' },
        {
          name: 'pref', value: 'dark', domain: 'example.com', path: '/app',
          expires: 1893456000, httpOnly: false, secure: true, sameSite: 'Lax',
        },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }] },
      ],
    })
  })

  it.each([
    ['a newer version', JSON.stringify({ version: 2, cookies: [], origins: [] })],
    ['version 0', JSON.stringify({ version: 0, cookies: [], origins: [] })],
    ['a string version', JSON.stringify({ version: '1', cookies: [], origins: [] })],
    ['a missing version', JSON.stringify({ cookies: [], origins: [] })],
  ])('rejects %s with a clear Error', (_label, json) => {
    expect(() => parseStorageState(json)).toThrow(/version/)
  })

  it.each([
    ['broken JSON', '{not json', /invalid JSON/],
    ['a null root', 'null', /expected a JSON object/],
    ['an array root', '[]', /expected a JSON object/],
    ['a string root', '"hi"', /expected a JSON object/],
    ['missing cookies', JSON.stringify({ version: 1, origins: [] }), /cookies/],
    ['non-array cookies', JSON.stringify({ version: 1, cookies: {}, origins: [] }), /cookies/],
    ['non-array origins', JSON.stringify({ version: 1, cookies: [], origins: {} }), /origins/],
    ['a non-object cookie', JSON.stringify({ version: 1, cookies: ['x'], origins: [] }), /cookies\[0\]/],
    ['a cookie missing domain', JSON.stringify({ version: 1, cookies: [{ name: 'a', value: 'b', path: '/' }], origins: [] }), /cookies\[0\]\.domain/],
    ['a numeric cookie value', JSON.stringify({ version: 1, cookies: [{ name: 'a', value: 5, domain: 'e.com', path: '/' }], origins: [] }), /cookies\[0\]\.value/],
    ['a bad sameSite', JSON.stringify({ version: 1, cookies: [{ name: 'a', value: 'b', domain: 'e.com', path: '/', sameSite: 'Bogus' }], origins: [] }), /cookies\[0\]\.sameSite/],
    ['a non-numeric expires', JSON.stringify({ version: 1, cookies: [{ name: 'a', value: 'b', domain: 'e.com', path: '/', expires: 'soon' }], origins: [] }), /cookies\[0\]\.expires/],
    ['a non-boolean httpOnly', JSON.stringify({ version: 1, cookies: [{ name: 'a', value: 'b', domain: 'e.com', path: '/', httpOnly: 'yes' }], origins: [] }), /cookies\[0\]\.httpOnly/],
    ['a non-object origin', JSON.stringify({ version: 1, cookies: [], origins: [42] }), /origins\[0\]/],
    ['a non-string origin.origin', JSON.stringify({ version: 1, cookies: [], origins: [{ origin: 5, localStorage: [] }] }), /origins\[0\]\.origin/],
    ['non-array localStorage', JSON.stringify({ version: 1, cookies: [], origins: [{ origin: 'https://e.com', localStorage: {} }] }), /origins\[0\]\.localStorage/],
    ['a numeric localStorage value', JSON.stringify({ version: 1, cookies: [], origins: [{ origin: 'https://e.com', localStorage: [{ name: 'k', value: 1 }] }] }), /origins\[0\]\.localStorage\[0\]\.value/],
  ])('rejects %s', (_label, json, pattern) => {
    expect(() => parseStorageState(json)).toThrow(pattern)
  })
})

describe('serializeStorageState', () => {
  it('pretty-prints with 2 spaces and a stable key order regardless of input key order', () => {
    const state: StorageState = {
      version: 1,
      cookies: [
        {
          name: 'sid', value: 'abc', domain: '.example.com', path: '/',
          expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Lax',
        },
        { name: 'plain', value: 'v', domain: 'example.com', path: '/' },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }] },
      ],
    }
    // Expected output written by hand from the spec: root version/cookies/origins,
    // cookie name/value/domain/path then optionals, origin origin/localStorage.
    const expected = `{
  "version": 1,
  "cookies": [
    {
      "name": "sid",
      "value": "abc",
      "domain": ".example.com",
      "path": "/",
      "expires": 1893456000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    },
    {
      "name": "plain",
      "value": "v",
      "domain": "example.com",
      "path": "/"
    }
  ],
  "origins": [
    {
      "origin": "https://example.com",
      "localStorage": [
        {
          "name": "token",
          "value": "xyz"
        }
      ]
    }
  ]
}`
    expect(serializeStorageState(state)).toBe(expected)
    const reordered = {
      origins: [{ localStorage: [{ value: 'xyz', name: 'token' }], origin: 'https://example.com' }],
      cookies: [
        { sameSite: 'Lax', secure: true, httpOnly: true, expires: 1893456000, path: '/', domain: '.example.com', value: 'abc', name: 'sid' },
        { path: '/', domain: 'example.com', value: 'v', name: 'plain' },
      ],
      version: 1,
    } as StorageState
    expect(serializeStorageState(reordered)).toBe(expected)
  })
})

describe('storage-state round-trip', () => {
  it('parse(serialize(state)) deep-equals the state, with and without optional fields', () => {
    const state: StorageState = {
      version: 1,
      cookies: [
        {
          name: 'sid', value: 'a"b\\c', domain: '.example.com', path: '/',
          expires: 1893456000, httpOnly: true, secure: true, sameSite: 'None',
        },
        { name: 'session', value: '', domain: 'example.com', path: '/' },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }, { name: 'empty', value: '' }] },
        { origin: 'https://other.example.com', localStorage: [] },
      ],
    }
    expect(parseStorageState(serializeStorageState(state))).toEqual(state)
    expect(parseStorageState(serializeStorageState(emptyStorageState()))).toEqual(emptyStorageState())
  })
})

describe('collectStorageExpression', () => {
  it('is a non-empty expression string reading document.cookie and localStorage for the current origin', () => {
    const expr = collectStorageExpression()
    expect(typeof expr).toBe('string')
    expect(expr.length).toBeGreaterThan(0)
    const result = evaluateExpression(expr, {
      document: { cookie: 'sid=abc; tok=a=b; pref=dark' },
      localStorage: stubStorage([['token', 'xyz'], ['k2', 'v2']]),
      location: { origin: 'https://example.com', hostname: 'example.com' },
    })
    expect(result).toEqual({
      cookies: [
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/' },
        { name: 'tok', value: 'a=b', domain: 'example.com', path: '/' },
        { name: 'pref', value: 'dark', domain: 'example.com', path: '/' },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }, { name: 'k2', value: 'v2' }] },
      ],
    })
  })

  it('tolerates pages where storage access throws (about:blank) and still reports the origin', () => {
    const denied = () => { throw new Error('SecurityError: storage is disabled') }
    const result = evaluateExpression(collectStorageExpression(), {
      document: { get cookie() { throw new Error('SecurityError') } },
      localStorage: { get length() { throw new Error('SecurityError') }, key: denied, getItem: denied },
      location: { origin: 'null', hostname: '' },
    })
    expect(result).toEqual({ cookies: [], origins: [{ origin: 'null', localStorage: [] }] })
  })
})

describe('applyStorageExpression', () => {
  it('writes localStorage only for the current origin and sets cookies best-effort, returning counts', () => {
    const state: StorageState = {
      version: 1,
      cookies: [
        {
          name: 'sid', value: 'abc', domain: '.example.com', path: '/',
          expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Lax',
        },
        { name: 'host', value: 'h', domain: 'example.com', path: '/app' },
        { name: 'hostonly', value: 'x', domain: '', path: '/' },
        { name: 'foreign', value: 'f', domain: 'other.com', path: '/' },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }] },
        { origin: 'https://elsewhere.com', localStorage: [{ name: 'leak', value: 'no' }] },
      ],
    }
    const storage = stubStorage([])
    const written: string[] = []
    const documentStub = {
      get cookie() { return '' },
      set cookie(v: string) { written.push(v) },
    }
    const result = evaluateExpression(applyStorageExpression(state), {
      document: documentStub,
      localStorage: storage,
      location: { origin: 'https://example.com', hostname: 'www.example.com' },
    })
    expect(storage.snapshot()).toEqual([['token', 'xyz']])
    expect(written).toHaveLength(3)
    expect(written[0]).toMatch(/^sid=abc; path=\/; domain=\.example\.com; expires=/)
    expect(written[0]).toMatch(/; secure; samesite=Lax$/)
    expect(written[0]).not.toMatch(/httponly/i)
    const expiresText = written[0]!.split('expires=')[1]!.split(';')[0]!
    expect(Date.parse(expiresText) / 1000).toBe(1893456000)
    expect(written[1]).toBe('host=h; path=/app; domain=example.com')
    expect(written[2]).toBe('hostonly=x; path=/')
    expect(result).toEqual({ cookies: 3, localStorage: 1, skippedOrigins: 1, skippedCookies: 1 })
  })

  it('JSON-escapes hostile values so quotes, backticks and </script> cannot inject code', () => {
    const hostile = `'); globalThis.__pwned = 'cookie'; ('`
    const backtick = '`; globalThis.__pwned = `template`; ${globalThis.__pwned}'
    const script = '</script><script>globalThis.__pwned = "html"</script>'
    const separators = 'line\u2028sep\u2029end'
    const state: StorageState = {
      version: 1,
      cookies: [
        { name: 'evil"name', value: hostile, domain: 'example.com', path: '/' },
        { name: 'bt', value: backtick, domain: 'example.com', path: '/' },
        { name: 'html', value: script, domain: 'example.com', path: '/' },
      ],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [
            { name: 'q"uote', value: hostile },
            { name: 'bt`key', value: backtick },
            { name: 'tag', value: script },
            { name: 'sep', value: separators },
            { name: 'back\\slash', value: 'a\\b' },
          ],
        },
      ],
    }
    const expr = applyStorageExpression(state)
    // Static: no raw breakout sequence survives anywhere in the expression text.
    expect(expr.toLowerCase()).not.toContain('</script>')
    expect(expr).not.toContain('`')
    expect(expr).not.toContain('\u2028')
    expect(expr).not.toContain('\u2029')
    // Behavioral: values arrive verbatim through the stubs; no injected code runs.
    Reflect.deleteProperty(globalThis, '__pwned')
    const storage = stubStorage([])
    const written: string[] = []
    const result = evaluateExpression(expr, {
      document: { get cookie() { return '' }, set cookie(v: string) { written.push(v) } },
      localStorage: storage,
      location: { origin: 'https://example.com', hostname: 'example.com' },
    })
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined()
    expect(storage.snapshot()).toEqual([
      ['q"uote', hostile],
      ['bt`key', backtick],
      ['tag', script],
      ['sep', separators],
      ['back\\slash', 'a\\b'],
    ])
    expect(written).toEqual([
      'evil"name=' + hostile + '; path=/; domain=example.com',
      'bt=' + backtick + '; path=/; domain=example.com',
      'html=' + script + '; path=/; domain=example.com',
    ])
    expect(result).toEqual({ cookies: 3, localStorage: 5, skippedOrigins: 0, skippedCookies: 0 })
  })
})