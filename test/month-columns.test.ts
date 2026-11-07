import { describe, expect, it } from 'vitest'
import { deriveMonthColumns, monthDateKeys, monthStats } from '@/lib/month-columns'
import type { Habit } from '@/lib/types'

/**
 * Phase 12 / HABIT-04 month derivation contract.
 *
 *  - deriveMonthColumns: current/future months show exactly the live habits;
 *    past months show completion-derived columns (archived habits that were
 *    used stay visible, unused/archived and uncompleted live habits drop out).
 *  - monthDateKeys: every local day in a month, zero-padded, leap-aware.
 *  - monthStats: { done, past, pct } with the elapsed-day rule and a clamped
 *    percentage (never > 100).
 */

const UPDATED = '2026-01-02T00:00:00.000Z'

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '每天跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('deriveMonthColumns', () => {
  it('returns live habits unchanged for a current or future month', () => {
    const live = [habit({ id: 'a', sort_order: 0 }), habit({ id: 'b', sort_order: 1 })]
    const all = [...live, habit({ id: 'archived', sort_order: 2, deleted_at: '2026-03-01T00:00:00.000Z' })]
    const completions = [{ habit_id: 'a' }, { habit_id: 'archived' }]

    expect(deriveMonthColumns(live, all, completions, true)).toBe(live)
  })

  it('derives past-month columns from completions, including archived habits', () => {
    const live = [habit({ id: 'a', sort_order: 0 }), habit({ id: 'b', sort_order: 1 })]
    const all = [
      habit({ id: 'b', sort_order: 1 }),
      habit({ id: 'a', sort_order: 0 }),
      habit({ id: 'archived-used', sort_order: 2, deleted_at: '2026-03-01T00:00:00.000Z' }),
      habit({ id: 'archived-unused', sort_order: 3, deleted_at: '2026-03-01T00:00:00.000Z' }),
    ]
    const completions = [{ habit_id: 'b' }, { habit_id: 'archived-used' }]

    const columns = deriveMonthColumns(live, all, completions, false)
    // Live 'a' has no completion; archived-unused has none either.
    expect(columns.map((h) => h.id)).toEqual(['b', 'archived-used'])
  })

  it('returns an empty list when a past month has no completions', () => {
    const live = [habit({ id: 'a' })]
    const all = [habit({ id: 'a' }), habit({ id: 'archived', deleted_at: '2026-03-01T00:00:00.000Z' })]

    expect(deriveMonthColumns(live, all, [], false)).toEqual([])
  })

  it('sorts completion-derived columns by sort_order', () => {
    const all = [
      habit({ id: 'z', sort_order: 9 }),
      habit({ id: 'a', sort_order: 1 }),
      habit({ id: 'm', sort_order: 5 }),
    ]
    const completions = [{ habit_id: 'z' }, { habit_id: 'a' }, { habit_id: 'm' }]

    expect(deriveMonthColumns([], all, completions, false).map((h) => h.id)).toEqual([
      'a',
      'm',
      'z',
    ])
  })
})

describe('monthDateKeys', () => {
  it('returns every day of a 31-day month', () => {
    const keys = monthDateKeys(2026, 10)
    expect(keys).toHaveLength(31)
    expect(keys[0]).toBe('2026-10-01')
    expect(keys[30]).toBe('2026-10-31')
  })

  it('handles a leap February', () => {
    const keys = monthDateKeys(2024, 2)
    expect(keys).toHaveLength(29)
    expect(keys[28]).toBe('2024-02-29')
  })

  it('handles a non-leap February', () => {
    expect(monthDateKeys(2025, 2)).toHaveLength(28)
  })
})

describe('monthStats', () => {
  it('counts elapsed days and done days for the current month', () => {
    const stats = monthStats(
      2026,
      10,
      new Set(['2026-10-01', '2026-10-02', '2026-10-05']),
      '2026-10-10',
    )
    expect(stats).toEqual({ done: 3, past: 10, pct: 30 })
  })

  it('counts every day as elapsed for a past month', () => {
    const stats = monthStats(2026, 9, new Set(['2026-09-01', '2026-09-02']), '2026-10-10')
    expect(stats).toEqual({ done: 2, past: 30, pct: 7 })
  })

  it('reports zero elapsed and zero percent for a future month', () => {
    const stats = monthStats(2026, 11, new Set(['2026-11-01']), '2026-10-10')
    expect(stats).toEqual({ done: 1, past: 0, pct: 0 })
  })

  it('never exceeds 100 percent when done exceeds elapsed days', () => {
    const done = new Set(
      Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`),
    )
    const stats = monthStats(2026, 10, done, '2026-10-05')
    expect(stats).toEqual({ done: 10, past: 5, pct: 100 })
  })

  it('ignores completion keys outside the month', () => {
    const stats = monthStats(2026, 10, new Set(['2026-10-01', '2026-09-01']), '2026-10-10')
    expect(stats).toEqual({ done: 1, past: 10, pct: 10 })
  })
})
