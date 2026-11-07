import { describe, expect, it } from 'vitest'
import {
  buildFeedbackMarkdown,
  clampFeedbackPosition,
  formatFeedbackDate,
  formatFeedbackTimestamp,
  parseFeedbackItems,
  parseFeedbackPosition,
} from '@/lib/feedback'

/**
 * Feedback widget pure logic. Tests run under the pinned TZ=UTC (vitest.config),
 * so local-time constructors like `new Date(2026, 9, 31)` are deterministic.
 */

describe('formatFeedbackDate', () => {
  it('renders a zero-padded local YYYY-MM-DD', () => {
    expect(formatFeedbackDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('returns an empty string for an invalid Date', () => {
    expect(formatFeedbackDate(new Date('nope'))).toBe('')
  })
})

describe('formatFeedbackTimestamp', () => {
  it('renders a zero-padded local YYYY-MM-DD HH:mm', () => {
    expect(formatFeedbackTimestamp(new Date(2026, 9, 31, 9, 5).getTime())).toBe(
      '2026-10-31 09:05',
    )
  })

  it('never emits Invalid Date for a non-finite timestamp', () => {
    expect(formatFeedbackTimestamp(NaN)).toBe('')
    expect(formatFeedbackTimestamp(Infinity)).toBe('')
  })
})

describe('buildFeedbackMarkdown', () => {
  it('prefixes a dated heading and bullets each item in order', () => {
    expect(
      buildFeedbackMarkdown(
        [{ text: '按钮错位' }, { text: '复制无反馈' }],
        new Date(2026, 9, 31),
      ),
    ).toBe('## 反馈 2026-10-31\n\n- 按钮错位\n- 复制无反馈')
  })

  it('returns only the heading for an empty list', () => {
    expect(buildFeedbackMarkdown([], new Date(2026, 9, 31))).toBe('## 反馈 2026-10-31')
  })
})

describe('parseFeedbackItems', () => {
  it('returns [] for null, invalid JSON, or a non-array payload', () => {
    expect(parseFeedbackItems(null)).toEqual([])
    expect(parseFeedbackItems('{not json')).toEqual([])
    expect(parseFeedbackItems('{"id":"a"}')).toEqual([])
  })

  it('keeps only well-shaped records and preserves order', () => {
    const raw =
      '[{"id":"a","text":"x","createdAt":1},{"id":"","text":"y","createdAt":2},{"bad":true}]'
    expect(parseFeedbackItems(raw)).toEqual([{ id: 'a', text: 'x', createdAt: 1 }])
  })

  it('drops records with a non-finite createdAt or non-string text', () => {
    const raw =
      '[{"id":"a","text":"x","createdAt":"1"},{"id":"b","text":2,"createdAt":1},{"id":"c","text":"z","createdAt":3}]'
    expect(parseFeedbackItems(raw)).toEqual([{ id: 'c', text: 'z', createdAt: 3 }])
  })
})

describe('parseFeedbackPosition', () => {
  it('returns null for null, invalid JSON, non-objects, and missing numbers', () => {
    expect(parseFeedbackPosition(null)).toBeNull()
    expect(parseFeedbackPosition('{oops')).toBeNull()
    expect(parseFeedbackPosition('[]')).toBeNull()
    expect(parseFeedbackPosition('{"x":10}')).toBeNull()
    expect(parseFeedbackPosition('{"x":"10","y":20}')).toBeNull()
  })

  it('returns the parsed position for a valid payload', () => {
    expect(parseFeedbackPosition('{"x":10,"y":20}')).toEqual({ x: 10, y: 20 })
  })
})

describe('clampFeedbackPosition', () => {
  it('clamps both axes into the viewport margin box', () => {
    expect(
      clampFeedbackPosition(
        { x: -30, y: 9999 },
        { width: 800, height: 600 },
        { width: 340, height: 400 },
        8,
      ),
    ).toEqual({ x: 8, y: 192 })
  })

  it('leaves an in-bounds position untouched', () => {
    expect(
      clampFeedbackPosition(
        { x: 100, y: 50 },
        { width: 800, height: 600 },
        { width: 340, height: 400 },
      ),
    ).toEqual({ x: 100, y: 50 })
  })

  it('falls back to the margin when the panel is larger than the viewport', () => {
    expect(
      clampFeedbackPosition(
        { x: 400, y: 400 },
        { width: 200, height: 200 },
        { width: 340, height: 400 },
        8,
      ),
    ).toEqual({ x: 8, y: 8 })
  })
})
