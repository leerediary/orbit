import { describe, expect, it } from 'vitest'
import { formatReviewTimestamp, sortReviewsNewestFirst } from '@/lib/review-time'
import type { Review } from '@/lib/types'

/**
 * Timeline ordering + timestamp contract (D-01 / D-06, REV-01 / REV-02).
 *
 *  - sortReviewsNewestFirst orders newest-first (descending created_at), breaks
 *    same-millisecond ties by id ascending, and never mutates its input.
 *  - formatReviewTimestamp renders an absolute device-local `YYYY-MM-DD HH:mm`
 *    string (zero-padded, 24-hour) and returns '' for unparseable input — never
 *    "Invalid Date" and never a relative label.
 */

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-a',
    goal_id: 'goal-a',
    content: 'Note',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('sortReviewsNewestFirst', () => {
  it('returns an empty array for empty input', () => {
    expect(sortReviewsNewestFirst([])).toEqual([])
  })

  it('orders newest-first by created_at', () => {
    const jan = review({ id: 'jan-01', created_at: '2026-01-01T00:00:00.000Z' })
    const feb = review({ id: 'feb-01', created_at: '2026-02-01T00:00:00.000Z' })
    const mar = review({ id: 'mar-01', created_at: '2026-03-01T00:00:00.000Z' })

    const sorted = sortReviewsNewestFirst([jan, feb, mar])

    expect(sorted.map((entry) => entry.id)).toEqual(['mar-01', 'feb-01', 'jan-01'])
  })

  it('tie-breaks equal created_at by id ascending', () => {
    const a = review({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' })
    const b = review({ id: 'b', created_at: '2026-01-01T00:00:00.000Z' })

    const sorted = sortReviewsNewestFirst([b, a])

    expect(sorted.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array and returns a new reference', () => {
    const input = [
      review({ id: 'jan-01', created_at: '2026-01-01T00:00:00.000Z' }),
      review({ id: 'mar-01', created_at: '2026-03-01T00:00:00.000Z' }),
      review({ id: 'feb-01', created_at: '2026-02-01T00:00:00.000Z' }),
    ]
    const snapshot = input.map((entry) => entry.id)

    const result = sortReviewsNewestFirst(input)

    expect(input.map((entry) => entry.id)).toEqual(snapshot)
    expect(result).not.toBe(input)
  })
})

describe('formatReviewTimestamp', () => {
  it('zero-pads an absolute local YYYY-MM-DD HH:mm timestamp', () => {
    const iso = '2026-10-26T15:30:00.000Z'
    const d = new Date(iso)
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`

    expect(formatReviewTimestamp(iso)).toBe(expected)
  })

  it('returns an empty string for invalid or empty input', () => {
    expect(formatReviewTimestamp('not-a-date')).toBe('')
    expect(formatReviewTimestamp('')).toBe('')
  })
})
