import { describe, it, expect, afterEach } from 'vitest'
import {
  setLanguageSource, hintFor, statusRulesSummary, actionSuccessHint,
  helpText, helpNotFound, diffSummary, diffBaseline, diffNote,
} from '../src/english.ts'
import { EN_HELP_DOCS } from '../src/english-help.ts'

afterEach(() => setLanguageSource(() => 'auto'))

describe('english overlay', () => {
  it('keeps upstream text when language is auto (non-invasive default)', () => {
    setLanguageSource(() => 'auto')
    expect(hintFor('TIMEOUT', '中文')).toBe('中文')
    expect(diffNote('zh')).toBe('zh')
    expect(diffBaseline('zh')).toBe('zh')
    expect(helpText('overview', 'zh')).toBe('zh')
    expect(statusRulesSummary('zh')).toBe('zh')
    expect(actionSuccessHint('zh')).toBe('zh')
  })

  it('returns English when language is en', () => {
    setLanguageSource(() => 'en')
    expect(hintFor('TIMEOUT', '中文')).toContain('Action timed out')
    expect(hintFor('CAPTCHA', '中文')).toContain('human-verification')
    expect(diffSummary(true, 1, 2, 3, 'zh')).toBe('Page changed: 1 added, 2 removed, 3 modified')
    expect(diffSummary(false, 0, 0, 0, 'zh')).toBe('No page change')
    expect(diffBaseline('zh')).toContain('First snapshot')
    expect(diffNote('zh')).toContain('A diff only describes')
    expect(statusRulesSummary('zh')).toContain('Observe before acting')
    expect(actionSuccessHint('zh')).toContain('The action was executed')
    expect(helpText('overview', 'zh')).toBe(EN_HELP_DOCS.overview)
  })

  it('falls back to upstream text for an unknown help topic', () => {
    setLanguageSource(() => 'en')
    expect(helpText('nonexistent-topic', 'zh')).toBe('zh')
  })

  it('keeps the Chinese platform-unavailable note when not English', () => {
    setLanguageSource(() => 'auto')
    expect(helpNotFound('x', ['tools'], 'ov')).toContain('未找到 topic')
  })

  it('translates every help topic with no leftover CJK', () => {
    expect(Object.keys(EN_HELP_DOCS).length).toBeGreaterThanOrEqual(18)
    for (const key of Object.keys(EN_HELP_DOCS)) {
      expect(EN_HELP_DOCS[key].length).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fff]/.test(EN_HELP_DOCS[key])).toBe(false)
    }
  })
})
