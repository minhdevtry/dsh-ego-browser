import { describe, it, expect } from 'vitest'
import {
  looksBlockedDefault,
  looksThin,
  impitFetch,
  smartFetch,
  type ImpitLike,
  type HttpDeps,
  type FetchResponse,
} from '../src/stealth/http-impit.ts'

// A fake impit client scripted with a queue of responses, recording each call.
function fakeClient(responses: FetchResponse[]) {
  const calls: { url: string; init?: any }[] = []
  let i = 0
  const client: ImpitLike = {
    async fetch(url, init) {
      calls.push({ url, init })
      const r = responses[Math.min(i, responses.length - 1)]!
      i += 1
      return r
    },
  }
  return { client, calls }
}

function res(partial: Partial<FetchResponse> & { status: number; body?: string }): FetchResponse {
  return {
    status: partial.status,
    headers: partial.headers ?? {},
    text: async () => partial.body ?? '',
    url: partial.url,
  } as FetchResponse
}

function depsWith(client: ImpitLike, extra?: Partial<HttpDeps>): HttpDeps {
  return { loadImpit: async () => client, ...extra }
}

describe('looksBlockedDefault', () => {
  it('flags block status codes', () => {
    for (const s of [401, 403, 429, 503]) expect(looksBlockedDefault(s, '')).toBe(true)
  })
  it('flags challenge markers in body', () => {
    expect(looksBlockedDefault(200, '<title>Just a moment...</title>')).toBe(true)
    expect(looksBlockedDefault(200, 'px-captcha')).toBe(true)
  })
  it('passes a clean 200', () => {
    expect(looksBlockedDefault(200, '<html><body>hello world</body></html>')).toBe(false)
  })
  it('treats null status (network error) as blocked', () => {
    expect(looksBlockedDefault(null, '')).toBe(true)
  })
})

describe('looksThin', () => {
  it('flags a tiny 200 html shell', () => {
    expect(looksThin(200, '<html></html>')).toBe(true)
  })
  it('does not flag a full 200 page', () => {
    expect(looksThin(200, '<html>' + 'x'.repeat(2000) + '</html>')).toBe(false)
  })
  it('does not flag non-200', () => {
    expect(looksThin(403, '<html></html>')).toBe(false)
  })
})

describe('impitFetch', () => {
  it('performs a basic GET and returns text/headers', async () => {
    const { client, calls } = fakeClient([res({ status: 200, body: 'ok', headers: { 'content-type': 'text/plain' } })])
    const r = await impitFetch({ url: 'https://example.com' }, depsWith(client))
    expect(r.status).toBe(200)
    expect(r.text).toBe('ok')
    expect(r.headers['content-type']).toBe('text/plain')
    expect(calls[0]!.url).toBe('https://example.com')
  })

  it('follows a same-origin redirect keeping the Cookie header', async () => {
    const { client, calls } = fakeClient([
      res({ status: 302, headers: { location: '/next' } }),
      res({ status: 200, body: 'done' }),
    ])
    const r = await impitFetch({ url: 'https://example.com/a', headers: { Cookie: 's=1' } }, depsWith(client))
    expect(r.status).toBe(200)
    expect(calls[1]!.url).toBe('https://example.com/next')
    expect(calls[1]!.init.headers.Cookie).toBe('s=1')
  })

  it('drops credential headers on a cross-origin redirect', async () => {
    const { client, calls } = fakeClient([
      res({ status: 302, headers: { location: 'https://attacker.test/steal' } }),
      res({ status: 200, body: 'x' }),
    ])
    await impitFetch({ url: 'https://example.com/a', headers: { Cookie: 's=1', Authorization: 'Bearer t' } }, depsWith(client))
    expect(calls[1]!.init.headers.Cookie).toBeUndefined()
    expect(calls[1]!.init.headers.Authorization).toBeUndefined()
  })

  it('converts 303 POST to GET without body', async () => {
    const { client, calls } = fakeClient([
      res({ status: 303, headers: { location: '/after' } }),
      res({ status: 200 }),
    ])
    await impitFetch({ url: 'https://example.com/submit', method: 'POST', body: 'a=1' }, depsWith(client))
    expect(calls[1]!.init.method).toBe('GET')
    expect(calls[1]!.init.body).toBeUndefined()
  })

  it('errors on too many redirects', async () => {
    const { client } = fakeClient([res({ status: 302, headers: { location: '/loop' } })])
    const r = await impitFetch({ url: 'https://example.com' }, depsWith(client))
    expect(r.status).toBeNull()
    expect(r.error).toMatch(/redirect/i)
  })

  it('injects cached clearance cookie + UA for the host', async () => {
    const { client, calls } = fakeClient([res({ status: 200 })])
    const clearance = { lookup: (h: string) => (h === 'sub.example.com' ? { cookie: 'cf_clearance=abc', userAgent: 'UA-X' } : null) }
    await impitFetch({ url: 'https://sub.example.com/p' }, depsWith(client, { clearance }))
    expect(calls[0]!.init.headers.Cookie).toContain('cf_clearance=abc')
    expect(calls[0]!.init.headers['User-Agent']).toBe('UA-X')
  })

  it('captures cf_clearance from set-cookie into the cache', async () => {
    const remembered: any[] = []
    const { client } = fakeClient([res({ status: 200, headers: { 'set-cookie': 'cf_clearance=xyz; Path=/; Max-Age=3600' } })])
    const clearance = { lookup: () => null, remember: (...a: any[]) => remembered.push(a) }
    await impitFetch({ url: 'https://example.com' }, depsWith(client, { clearance }))
    expect(remembered.length).toBe(1)
    expect(remembered[0][0]).toBe('example.com')
    expect(remembered[0][1]).toContain('cf_clearance=xyz')
  })

  it('returns a graceful error when impit is unavailable', async () => {
    const deps: HttpDeps = { loadImpit: async () => { throw new Error('native module unavailable') } }
    const r = await impitFetch({ url: 'https://example.com' }, deps)
    expect(r.status).toBeNull()
    expect(r.error).toMatch(/unavailable/i)
  })
})

describe('smartFetch', () => {
  it('does not escalate on a clean response', async () => {
    const { client } = fakeClient([res({ status: 200, body: '<html>' + 'content '.repeat(200) + '</html>' })])
    const r = await smartFetch({ url: 'https://example.com' }, depsWith(client))
    expect(r.escalate).toBe(false)
    expect(r.response.status).toBe(200)
  })
  it('escalates when the response looks blocked', async () => {
    const { client } = fakeClient([res({ status: 403, body: 'Just a moment' })])
    const r = await smartFetch({ url: 'https://example.com' }, depsWith(client))
    expect(r.escalate).toBe(true)
    expect(r.reason).toBeTruthy()
  })
  it('escalates softly on a thin JS-challenge shell', async () => {
    const { client } = fakeClient([res({ status: 200, body: '<html></html>' })])
    const r = await smartFetch({ url: 'https://example.com' }, depsWith(client))
    expect(r.escalate).toBe(true)
    expect(r.reason).toMatch(/thin|challenge/i)
  })
})
