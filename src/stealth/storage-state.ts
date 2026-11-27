/**
 * src/stealth/storage-state.ts — versioned cookies + localStorage state.
 *
 * Storage-state shape adapted from mcp-camoufox (MIT, RobithYusuf).
 * (storage_state_save/load in mcp-camoufox/src/tools/session.ts; reshaped here
 * to a versioned, array-based form — no AGPL crw-camofox code is used.)
 *
 * Pure logic + page.evaluate expression strings only: no browser execution,
 * no filesystem (the caller handles file IO), no logging of cookie values.
 */

/** One cookie. `expires` is epoch seconds (Playwright convention); -1/absent = session cookie. */
export interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** localStorage captured for exactly one origin. */
export interface OriginStorage {
  origin: string
  localStorage: { name: string; value: string }[]
}

/** Versioned, serializable browser storage state. */
export interface StorageState {
  version: 1
  cookies: CookieRecord[]
  origins: OriginStorage[]
}

/** A fresh, empty version-1 state. */
export function emptyStorageState(): StorageState {
  return { version: 1, cookies: [], origins: [] }
}

/** Parse and validate a storage-state JSON string; throws Error on invalid input. */
export function parseStorageState(json: string): StorageState {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (error) {
    throw new Error(`storage state: invalid JSON (${(error as Error).message})`)
  }
  if (!isRecord(data)) throw new Error('storage state: expected a JSON object')
  if (data.version !== 1) {
    throw new Error(`storage state: unsupported version ${JSON.stringify(data.version) ?? String(data.version)} (expected 1)`)
  }
  if (!Array.isArray(data.cookies)) throw new Error('storage state: cookies must be an array')
  if (!Array.isArray(data.origins)) throw new Error('storage state: origins must be an array')
  return {
    version: 1,
    cookies: data.cookies.map(parseCookie),
    origins: data.origins.map(parseOrigin),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`storage state: ${label} must be a string`)
  return value
}

const optionalBoolean = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`storage state: ${label} must be a boolean`)
  return value
}

/** Normalize one cookie, dropping unknown keys and absent optional fields. */
const parseCookie = (raw: unknown, index: number): CookieRecord => {
  const label = `cookies[${index}]`
  if (!isRecord(raw)) throw new Error(`storage state: ${label} must be an object`)
  const cookie: CookieRecord = {
    name: requireString(raw.name, `${label}.name`),
    value: requireString(raw.value, `${label}.value`),
    domain: requireString(raw.domain, `${label}.domain`),
    path: requireString(raw.path, `${label}.path`),
  }
  if (raw.expires !== undefined) {
    if (typeof raw.expires !== 'number' || !Number.isFinite(raw.expires)) {
      throw new Error(`storage state: ${label}.expires must be a finite number (epoch seconds)`)
    }
    cookie.expires = raw.expires
  }
  const httpOnly = optionalBoolean(raw.httpOnly, `${label}.httpOnly`)
  if (httpOnly !== undefined) cookie.httpOnly = httpOnly
  const secure = optionalBoolean(raw.secure, `${label}.secure`)
  if (secure !== undefined) cookie.secure = secure
  if (raw.sameSite !== undefined) {
    if (raw.sameSite !== 'Strict' && raw.sameSite !== 'Lax' && raw.sameSite !== 'None') {
      throw new Error(`storage state: ${label}.sameSite must be 'Strict', 'Lax' or 'None'`)
    }
    cookie.sameSite = raw.sameSite
  }
  return cookie
}

/** Normalize one origin entry, dropping unknown keys. */
const parseOrigin = (raw: unknown, index: number): OriginStorage => {
  const label = `origins[${index}]`
  if (!isRecord(raw)) throw new Error(`storage state: ${label} must be an object`)
  const origin = requireString(raw.origin, `${label}.origin`)
  if (!Array.isArray(raw.localStorage)) {
    throw new Error(`storage state: ${label}.localStorage must be an array`)
  }
  const localStorage = raw.localStorage.map((entry: unknown, entryIndex: number) => {
    const entryLabel = `${label}.localStorage[${entryIndex}]`
    if (!isRecord(entry)) throw new Error(`storage state: ${entryLabel} must be an object`)
    return {
      name: requireString(entry.name, `${entryLabel}.name`),
      value: requireString(entry.value, `${entryLabel}.value`),
    }
  })
  return { origin, localStorage }
}

/**
 * Serialize to pretty JSON (2 spaces) with a deterministic key order:
 * root version/cookies/origins; cookie name/value/domain/path then the
 * optional fields (omitted when absent); origin origin/localStorage.
 */
export function serializeStorageState(state: StorageState): string {
  const ordered = {
    version: state.version,
    cookies: state.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })),
    origins: state.origins.map((entry) => ({
      origin: entry.origin,
      localStorage: entry.localStorage.map((item) => ({ name: item.name, value: item.value })),
    })),
  }
  // JSON.stringify drops undefined-valued keys, so absent optionals stay absent.
  return JSON.stringify(ordered, null, 2)
}

/**
 * JS expression for page.evaluate that returns `{ cookies, origins }` for the
 * CURRENT origin only, using document.cookie + localStorage.
 *
 * Limitations (inherent to page JS):
 * - httpOnly cookies are NOT visible to document.cookie, so they are never
 *   collected here. For full fidelity the caller must merge cookies obtained
 *   via CDP (Network.getAllCookies) or the browser-context cookie API.
 * - document.cookie exposes only name=value pairs: the real domain, path,
 *   expires, secure and sameSite attributes are not recoverable. The records
 *   below use best-effort defaults (location.hostname, path '/').
 * - Pages without storage access (about:blank, sandboxed frames) throw on
 *   localStorage; that is tolerated and yields empty results, not a failure.
 */
export function collectStorageExpression(): string {
  return `(() => {
  var cookies = [];
  try {
    var raw = document.cookie || '';
    if (raw) {
      var parts = raw.split(';');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        var name = parts[i].slice(0, eq).trim();
        var value = parts[i].slice(eq + 1).trim();
        if (!name) continue;
        cookies.push({ name: name, value: value, domain: location.hostname, path: '/' });
      }
    }
  } catch (e) {}
  var entries = [];
  try {
    for (var j = 0; j < localStorage.length; j++) {
      var key = localStorage.key(j);
      if (key === null) continue;
      var item = localStorage.getItem(key);
      entries.push({ name: key, value: item === null ? '' : item });
    }
  } catch (e) {}
  return { cookies: cookies, origins: [{ origin: location.origin, localStorage: entries }] };
})()`
}

/**
 * Embed a value as a JS literal that is safe even inside an HTML <script>
 * block: JSON.stringify handles quotes/backslashes/control chars, and the
 * extra escapes remove raw `<`, `>`, backticks and the JS line separators
 * U+2028/U+2029, so no value can break out of the literal or the script tag.
 */
const jsLiteral = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/`/g, '\\u0060')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

/**
 * JS expression for page.evaluate that applies a StorageState to the CURRENT
 * page: localStorage entries whose origin matches location.origin, and
 * cookies whose domain matches location.hostname, via document.cookie.
 * Returns `{ cookies, localStorage, skippedOrigins, skippedCookies }` counts
 * (attempts — the browser may still silently reject a cookie).
 *
 * Safety: every value is embedded through jsLiteral (JSON-escaped, plus
 * `<`/`>`/backtick/U+2028/U+2029), so quotes, backticks and `</script>` in
 * names/values cannot inject code. localStorage for a DIFFERENT origin is
 * never written here — handing tokens to whatever site the browser landed on
 * would leak them (same guard as mcp-camoufox's storage_state_load).
 *
 * Limitations: document.cookie cannot set the httpOnly flag (it is ignored),
 * and values containing ';' or control characters may be truncated/rejected
 * by the browser. For httpOnly/full-attribute cookies use CDP
 * (Network.setCookie) or the browser-context cookie API instead.
 */
export function applyStorageExpression(state: StorageState): string {
  return `((state) => {
  var here = location.origin;
  var host = location.hostname.toLowerCase();
  var applied = { cookies: 0, localStorage: 0, skippedOrigins: 0, skippedCookies: 0 };
  var domainMatches = function (domain) {
    var d = String(domain || '').replace(/^\\./, '').toLowerCase();
    if (!d) return true;
    return host === d || host.endsWith('.' + d);
  };
  var clean = function (text) { return String(text).replace(/[;\\r\\n]/g, ''); };
  for (var i = 0; i < state.origins.length; i++) {
    var entry = state.origins[i];
    if (entry.origin !== here) { applied.skippedOrigins++; continue; }
    for (var j = 0; j < entry.localStorage.length; j++) {
      var item = entry.localStorage[j];
      try { localStorage.setItem(item.name, item.value); applied.localStorage++; } catch (e) {}
    }
  }
  for (var k = 0; k < state.cookies.length; k++) {
    var cookie = state.cookies[k];
    if (!domainMatches(cookie.domain)) { applied.skippedCookies++; continue; }
    try {
      var pair = cookie.name + '=' + cookie.value;
      pair += '; path=' + clean(cookie.path || '/');
      if (cookie.domain) pair += '; domain=' + clean(cookie.domain);
      if (typeof cookie.expires === 'number' && isFinite(cookie.expires) && cookie.expires > 0) {
        pair += '; expires=' + new Date(cookie.expires * 1000).toUTCString();
      }
      if (cookie.secure) pair += '; secure';
      if (cookie.sameSite) pair += '; samesite=' + clean(cookie.sameSite);
      document.cookie = pair;
      applied.cookies++;
    } catch (e) {}
  }
  return applied;
})(${jsLiteral(state)})`
}