/**
 * src/english.ts — additive English overlay for host-side, user-visible text.
 *
 * Why a separate file: the upstream tool-result strings (failure hints, snapshot
 * diff summaries, ego_status / action hints, ego_help fallbacks) are Chinese-only.
 * Keeping every English string here means upstream edits to those source files
 * merge without conflict; only the tiny wiring lines at the output sites can
 * conflict, and they degrade gracefully (an unmatched key falls back to the
 * original upstream text).
 *
 * Opt-in: the overlay is active only when the plugin config `language` is 'en'.
 * Default 'auto' keeps upstream behavior unchanged, so the fork is non-invasive.
 * The watch-panel / settings UI language is handled separately by the client
 * (host/browser locale) and is already English for non-Chinese browsers.
 *
 * The system-prompt rules in src/rules.ts are intentionally NOT translated:
 * they are model-facing (never shown to the user) and translating them risks
 * subtle model-behavior changes plus extra merge surface.
 */
import type { EgoFailureCode } from './errors.ts'
import { EN_HELP_DOCS } from './english-help.ts'

export type ResultLanguage = 'auto' | 'en' | 'zh'

// Live source registered by apply() so GUI config edits take effect immediately.
let languageSource: () => ResultLanguage = () => 'auto'
export function setLanguageSource(fn: () => ResultLanguage): void {
  languageSource = fn
}
function isEn(): boolean {
  return languageSource() === 'en'
}

/** English failure-recovery hints, keyed by the stable EgoFailureCode. */
export const EN_HINTS: Record<EgoFailureCode, string> = {
  TIMEOUT:
    'Action timed out: check the current state with ego_page_info / ego_snapshot first; do not retry the same action unchanged.',
  LOCATOR_NOT_FOUND:
    'Target not found: take a fresh ego_snapshot for new refs or change the locator; do not retry the old selector/ref.',
  NAVIGATION_FAILED:
    'Navigation failed: verify the URL and network; confirm the current page with ego_page_info before deciding the next step.',
  DIALOG_BLOCKING:
    'The page has an unhandled dialog: accept/dismiss it with ego_dialog first, then continue.',
  CAPTCHA:
    'A human-verification challenge appeared: let the user complete it in the ego browser, or wait with ego_wait_for_human; do not try to bypass it.',
  USER_CONTROLLING:
    'The user has taken over the browser: stop and ask the user; do not takeOver or retry.',
  SPACE_STALE:
    'The task space is stale: the plugin will reset to the space name and retry; if it still fails, reopen it with ego_space_open.',
  STALE_REF:
    'The snapshot generation is stale: take a new ego_snapshot and act with the new ref/loc; do not reuse old refs.',
  BROWSER_DOWN:
    'The browser is unavailable: run ego_doctor to diagnose; wait for a cold start or restart, then try again.',
  NO_PAYLOAD:
    'The script produced no result: confirm the page state with ego_page_info first, then retry.',
  INVALID_ARGS:
    'Invalid arguments: fix them as indicated and retry; do not resend unchanged.',
  UNKNOWN:
    'Observe before deciding: check the current state with ego_page_info / ego_snapshot; do not repeat the same action.',
}
export function hintFor(code: EgoFailureCode, zh: string): string {
  return isEn() ? (EN_HINTS[code] ?? zh) : zh
}

const EN_STATUS_RULES_SUMMARY = [
  'Observe before acting: ego_snapshot (refs are valid only for that snapshot) / ego_tabs list.',
  'Make only one page-changing action per observation cycle, then assert the expectation with ego_verify, or confirm the effect with ego_page_info / ego_read_element.',
  'On timeout or a missing target, re-snapshot instead of retrying unchanged; handle failures via the returned retry / hint.',
].join('\n')
export function statusRulesSummary(zh: string): string {
  return isEn() ? EN_STATUS_RULES_SUMMARY : zh
}

const EN_ACTION_SUCCESS_HINT =
  'The action was executed. Prefer asserting the expected change with ego_verify; otherwise confirm with ego_page_info / ego_read_element. Take a new ego_snapshot only when you need new locators; if the expected change did not appear, do not repeat the same action.'
export function actionSuccessHint(zh: string): string {
  return isEn() ? EN_ACTION_SUCCESS_HINT : zh
}

/** English ego_help topic text; falls back to the upstream text per topic. */
export function helpText(topic: string, zh: string): string {
  return isEn() ? (EN_HELP_DOCS[topic] ?? zh) : zh
}
export function helpPlatformUnavailable(zh: string): string {
  return isEn()
    ? `${zh}\n\n(Unavailable on this platform: this topic is offered only on macOS / Windows.)`
    : `${zh}\n\n（当前平台不可用：该主题仅在 macOS / Windows 提供）`
}
export function helpNotFound(q: string, available: string[], overviewZh: string): string {
  if (!isEn()) return `未找到 topic "${q}"。可用: ${available.join(', ')}\n\noverview: ${overviewZh}`
  return `Topic "${q}" not found. Available: ${available.join(', ')}\n\noverview: ${EN_HELP_DOCS.overview ?? overviewZh}`
}

/** English snapshot-diff strings. */
export function diffSummary(changed: boolean, added: number, removed: number, modified: number, zh: string): string {
  if (!isEn()) return zh
  return changed
    ? `Page changed: ${added} added, ${removed} removed, ${modified} modified`
    : 'No page change'
}
export function diffBaseline(zh: string): string {
  return isEn() ? 'First snapshot (no previous baseline); returning the full tree. The next diff can compare.' : zh
}
export function diffNote(zh: string): string {
  return isEn() ? 'A diff only describes page changes; to click/type, take a fresh ego_snapshot for the full tree (ref/loc are the actionable basis).' : zh
}
