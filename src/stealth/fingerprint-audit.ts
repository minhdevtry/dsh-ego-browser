// Audit checks adapted from mcp-camoufox fingerprint_audit (MIT, RobithYusuf).
// Reference: mcp-camoufox/src/tools/inspect.ts (fingerprint_audit). This is an
// original, conservative re-implementation of the self-consistency checks; no
// AGPL code is copied. Pure logic + a page-side collector expression only.

export interface FingerprintSnapshot {
  userAgent: string
  userAgentData?: { platform?: string; brands?: { brand: string; version: string }[]; mobile?: boolean }
  platform: string
  webglVendor: string
  webglRenderer: string
  webdriver: boolean
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number }
  timezone: string
  languages: string[]
  hardwareConcurrency: number
}

export interface AuditMismatch {
  field: string
  expected: string
  actual: string
  reason: string
}

export interface AuditResult {
  consistent: boolean
  mismatches: AuditMismatch[]
}

type OsFamily = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'chromeos' | ''

function osFromUserAgent(ua: string): OsFamily {
  // Order matters: Android / CrOS user-agents also contain "Linux".
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/CrOS/i.test(ua)) return 'chromeos'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return ''
}

function osFromPlatform(platform: string): OsFamily {
  if (/^Win/i.test(platform)) return 'windows'
  if (/Mac/i.test(platform)) return 'macos'
  if (/iPhone|iPad|iPod/i.test(platform)) return 'ios'
  if (/Linux|arm|aarch64|x86/i.test(platform)) return 'linux'
  return ''
}

function osFromHintsPlatform(platform: string): OsFamily {
  switch (platform.toLowerCase()) {
    case 'windows':
      return 'windows'
    case 'macos':
    case 'mac os x':
      return 'macos'
    case 'linux':
      return 'linux'
    case 'android':
      return 'android'
    case 'ios':
      return 'ios'
    case 'chrome os':
    case 'cros':
      return 'chromeos'
    default:
      return ''
  }
}

// Android and Chrome OS legitimately report a Linux navigator.platform, so
// treat the Linux-like family as mutually compatible to avoid false positives.
function osCompatible(a: OsFamily, b: OsFamily): boolean {
  if (!a || !b) return true
  if (a === b) return true
  const linuxLike: OsFamily[] = ['linux', 'android', 'chromeos']
  return linuxLike.includes(a) && linuxLike.includes(b)
}

function chromeMajorVersion(ua: string): number {
  const m = /Chrome\/(\d+)/.exec(ua)
  return m ? Number(m[1]) : 0
}

// A small, unambiguous timezone -> ISO region map. Unlisted zones are skipped so
// the check stays conservative (no false positives on exotic or UTC zones).
const TIMEZONE_REGION: Record<string, string> = {
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'Europe/London': 'GB',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Moscow': 'RU',
  'Europe/Warsaw': 'PL',
  'Europe/Stockholm': 'SE',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Singapore': 'SG',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Hanoi': 'VN',
  'Asia/Jakarta': 'ID',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ',
  'America/Sao_Paulo': 'BR',
  'America/Mexico_City': 'MX',
}

// Extract the region subtag from the primary language (e.g. "en-US" -> "US",
// "zh-Hans-CN" -> "CN"). Returns '' when there is no explicit region.
function primaryLanguageRegion(languages: string[]): string {
  const first = (languages[0] || '').trim()
  if (!first) return ''
  const parts = first.split('-')
  for (let i = 1; i < parts.length; i++) {
    if (/^[A-Za-z]{2}$/.test(parts[i])) return parts[i].toUpperCase()
  }
  return ''
}

export function auditFingerprint(fp: FingerprintSnapshot): AuditResult {
  const mismatches: AuditMismatch[] = []

  // navigator.webdriver is the single most checked automation tell.
  if (fp.webdriver === true) {
    mismatches.push({
      field: 'webdriver',
      expected: 'false',
      actual: 'true',
      reason: 'navigator.webdriver is true — the standard automation flag that detectors check first.',
    })
  }

  // A real browser always reports at least one logical core.
  if (!(fp.hardwareConcurrency > 0)) {
    mismatches.push({
      field: 'hardwareConcurrency',
      expected: 'a positive integer (>= 1)',
      actual: String(fp.hardwareConcurrency),
      reason: 'navigator.hardwareConcurrency is zero or negative — no real browser reports that.',
    })
  }

  // Cross-check the OS implied by the user-agent against navigator.platform and
  // the Client Hints platform. Only genuine disagreements are flagged.
  const uaOs = osFromUserAgent(fp.userAgent)
  const platOs = osFromPlatform(fp.platform)
  if (uaOs && platOs && !osCompatible(uaOs, platOs)) {
    mismatches.push({
      field: 'platform',
      expected: `an OS matching the user-agent (${uaOs})`,
      actual: fp.platform,
      reason: `navigator.platform "${fp.platform}" disagrees with the OS implied by the user-agent (${uaOs}).`,
    })
  }
  const hintsPlatform = fp.userAgentData?.platform
  if (hintsPlatform) {
    const hintsOs = osFromHintsPlatform(hintsPlatform)
    if (uaOs && hintsOs && !osCompatible(uaOs, hintsOs)) {
      mismatches.push({
        field: 'userAgentData.platform',
        expected: `an OS matching the user-agent (${uaOs})`,
        actual: hintsPlatform,
        reason: `userAgentData.platform "${hintsPlatform}" disagrees with the OS implied by the user-agent (${uaOs}).`,
      })
    }
  }

  // A modern Chrome always exposes a non-empty userAgentData.brands. An absent
  // userAgentData object is tolerated (non-Chromium browsers lack it entirely).
  if (fp.userAgentData && chromeMajorVersion(fp.userAgent) >= 90) {
    const brands = fp.userAgentData.brands
    if (!brands || brands.length === 0) {
      mismatches.push({
        field: 'userAgentData.brands',
        expected: 'a non-empty brands list for a modern Chrome',
        actual: brands ? '[]' : 'undefined',
        reason:
          'Client Hints inconsistency: the user-agent claims a modern Chrome but userAgentData.brands is missing or empty.',
      })
    }
  }

  // The available screen area can never exceed the physical screen.
  if (fp.screen.availWidth > fp.screen.width) {
    mismatches.push({
      field: 'screen.availWidth',
      expected: `<= screen.width (${fp.screen.width})`,
      actual: String(fp.screen.availWidth),
      reason: 'screen.availWidth is larger than screen.width — impossible on a real display.',
    })
  }
  if (fp.screen.availHeight > fp.screen.height) {
    mismatches.push({
      field: 'screen.availHeight',
      expected: `<= screen.height (${fp.screen.height})`,
      actual: String(fp.screen.availHeight),
      reason: 'screen.availHeight is larger than screen.height — impossible on a real display.',
    })
  }

  // WebGL vendor/renderer must be plausible for the claimed platform. Skip when
  // WebGL is unavailable (empty strings), which is normal in some contexts.
  const renderer = fp.webglRenderer || ''
  const vendor = fp.webglVendor || ''
  if (renderer || vendor) {
    const gpuOs = platOs || osFromHintsPlatform(hintsPlatform || '') || uaOs
    const appleGpu = /Apple/i.test(renderer) || /Apple/i.test(vendor)
    if (appleGpu && gpuOs && gpuOs !== 'macos' && gpuOs !== 'ios') {
      mismatches.push({
        field: 'webglRenderer',
        expected: `a GPU consistent with the platform (${gpuOs})`,
        actual: renderer || vendor,
        reason: `WebGL reports an Apple GPU ("${renderer || vendor}") but the platform claims ${gpuOs}.`,
      })
    }
    const softwareRenderer = /llvmpipe|softpipe|swiftshader|software rasterizer|mesa offscreen|software/i.test(renderer)
    const desktopOs = gpuOs === 'windows' || gpuOs === 'macos' || gpuOs === 'linux'
    if (softwareRenderer && desktopOs) {
      mismatches.push({
        field: 'webglRenderer',
        expected: 'a hardware GPU renderer on a desktop OS',
        actual: renderer,
        reason:
          'Informational: a software WebGL renderer (llvmpipe/SwiftShader) on a desktop OS may indicate a headless or virtualized GPU.',
      })
    }
  }

  // Timezone vs primary locale region. Low severity: a mismatch can be legitimate
  // (travel, VPN, expat), so it is reported as informational, never a hard tell.
  const tzRegion = TIMEZONE_REGION[fp.timezone]
  const langRegion = primaryLanguageRegion(fp.languages)
  if (tzRegion && langRegion && tzRegion !== langRegion) {
    mismatches.push({
      field: 'timezone',
      expected: `a timezone consistent with the primary locale region (${langRegion})`,
      actual: fp.timezone,
      reason: `Informational (low severity): timezone "${fp.timezone}" maps to ${tzRegion} but the primary language region is ${langRegion}; this can be legitimate.`,
    })
  }

  return { consistent: mismatches.length === 0, mismatches }
}

// A self-contained JS expression for page.evaluate. It reads only what the page
// already exposes and never throws: each source (navigator, screen, Intl, WebGL)
// is guarded, and WebGL in particular is wrapped in try/catch because a canvas
// context can be unavailable or blocked. Returns a FingerprintSnapshot object.
export function collectFingerprintExpression(): string {
  return `(function () {
  var out = {
    userAgent: '',
    platform: '',
    webglVendor: '',
    webglRenderer: '',
    webdriver: false,
    screen: { width: 0, height: 0, availWidth: 0, availHeight: 0, colorDepth: 0 },
    timezone: '',
    languages: [],
    hardwareConcurrency: 0
  };
  try {
    var n = navigator;
    out.userAgent = String(n.userAgent || '');
    out.platform = String(n.platform || '');
    out.webdriver = n.webdriver === true;
    out.languages = Array.prototype.slice.call(n.languages || []);
    out.hardwareConcurrency = Number(n.hardwareConcurrency) || 0;
    if (n.userAgentData) {
      out.userAgentData = {
        platform: n.userAgentData.platform,
        brands: Array.prototype.slice.call(n.userAgentData.brands || []).map(function (b) {
          return { brand: String(b.brand), version: String(b.version) };
        }),
        mobile: n.userAgentData.mobile === true
      };
    }
  } catch (e) {}
  try {
    var s = screen;
    out.screen = {
      width: s.width,
      height: s.height,
      availWidth: s.availWidth,
      availHeight: s.availHeight,
      colorDepth: s.colorDepth
    };
  } catch (e) {}
  try {
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {}
  try {
    var cv = document.createElement('canvas');
    var gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (gl) {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.webglVendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      out.webglRenderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
  } catch (e) {}
  return out;
})()`
}
