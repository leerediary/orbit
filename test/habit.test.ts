import { describe, expect, it } from 'vitest'
import {
  buildHabitDayState,
  defaultShortName,
  habitCompletionId,
  nextHabitSortOrder,
  sortHabits,
} from '@/lib/habit'
import type { Habit, HabitCompletion } from '@/lib/types'

/**
 * Phase 12 / HABIT-01 + HABIT-02 pure-helper contract.
 *
 *  - habitCompletionId is deterministic from (habit_id, date), so checking and
 *    unchecking target the same persisted row.
 *  - sortHabits is sort_order → updated_at → id, non-mutating.
 *  - nextHabitSortOrder starts at 1 and appends after every existing row
 *    (archived rows are passed in by callers and must be counted).
 *  - defaultShortName trims and keeps the first two Unicode code points.
 *  - buildHabitDayState ignores tombstones and completions for other days.
 */

const UPDATED = '2026-01-02T00:00:00.000Z'
const COMPLETED = '2026-01-01T08:00:00.000Z'

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

function completion(overrides: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: 'completion-1',
    habit_id: 'habit-1',
    date: '2026-10-31',
    note: null,
    completed_at: COMPLETED,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('habitCompletionId', () => {
  it('builds the deterministic row id from habit id and day key', () => {
    expect(habitCompletionId('h1', '2026-10-31')).toBe('habit-h1-2026-10-31')
  })

  it('is stable for the same inputs', () => {
    expect(habitCompletionId('h1', '2026-10-31')).toBe(habitCompletionId('h1', '2026-10-31'))
  })
})

describe('sortHabits', () => {
  it('orders by sort_order ascending', () => {
    const sorted = sortHabits([
      habit({ id: 'c', sort_order: 2 }),
      habit({ id: 'a', sort_order: 0 }),
      habit({ id: 'b', sort_order: 1 }),
    ])
    expect(sorted.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  })

  it('tie-breaks on updated_at then id', () => {
    const sorted = sortHabits([
      habit({ id: 'h3', sort_order: 1, updated_at: '2026-01-02T00:00:00.000Z' }),
      habit({ id: 'h2', sort_order: 1, updated_at: '2026-01-01T00:00:00.000Z' }),
      habit({ id: 'h1', sort_order: 1, updated_at: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(sorted.map((h) => h.id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('does not mutate the input array', () => {
    const input = [habit({ id: 'b', sort_order: 1 }), habit({ id: 'a', sort_order: 0 })]
    const before = input.map((h) => h.id)
    const sorted = sortHabits(input)
    expect(input.map((h) => h.id)).toEqual(before)
    expect(sorted).not.toBe(input)
    expect(sorted.map((h) => h.id)).toEqual(['a', 'b'])
  })
})

describe('nextHabitSortOrder', () => {
  it('returns 1 for an empty list', () => {
    expect(nextHabitSortOrder([])).toBe(1)
  })

  it('appends after the maximum sort_order', () => {
    expect(nextHabitSortOrder([{ sort_order: 1 }, { sort_order: 3 }])).toBe(4)
  })

  it('counts archived rows that are passed in', () => {
    const archived = { sort_order: 7, deleted_at: '2026-02-01T00:00:00.000Z' }
    expect(nextHabitSortOrder([{ sort_order: 2 }, archived])).toBe(8)
  })
})

describe('defaultShortName', () => {
  it('trims surrounding whitespace and takes the first two code points', () => {
    expect(defaultShortName('  跑步计划  ')).toBe('跑步')
  })

  it('returns a single character when the name has one', () => {
    expect(defaultShortName('读')).toBe('读')
  })

  it('counts Unicode code points, not UTF-16 units', () => {
    expect(defaultShortName('😀😁abc')).toBe('😀😁')
  })

  it('returns an empty string for empty or whitespace-only names', () => {
    expect(defaultShortName('')).toBe('')
    expect(defaultShortName('   ')).toBe('')
  })
})

describe('buildHabitDayState', () => {
  it('returns live habits sorted with completed ids and note map', () => {
    const state = buildHabitDayState(
      [
        habit({ id: 'b', sort_order: 1, name: '冥想', short_name: '冥想' }),
        habit({ id: 'a', sort_order: 0 }),
      ],
      [
        completion({ id: 'c-a', habit_id: 'a', date: '2026-10-31', note: '很好' }),
        completion({ id: 'c-b', habit_id: 'b', date: '2026-10-31', note: null }),
      ],
      '2026-10-31',
    )

    expect(state.habits.map((h) => h.id)).toEqual(['a', 'b'])
    expect(state.completedIds).toEqual(['a', 'b'])
    expect(state.notes).toEqual({ a: '很好', b: '' })
  })

  it('ignores tombstoned habits and tombstoned completions', () => {
    const state = buildHabitDayState(
      [habit({ id: 'a' }), habit({ id: 'archived', deleted_at: '2026-03-01T00:00:00.000Z' })],
      [
        completion({ id: 'live', habit_id: 'a', date: '2026-10-31' }),
        completion({
          id: 'dead',
          habit_id: 'a',
          date: '2026-10-31',
          deleted_at: '2026-03-01T00:00:00.000Z',
        }),
      ],
      '2026-10-31',
    )

    expect(state.habits.map((h) => h.id)).toEqual(['a'])
    expect(state.completedIds).toEqual(['a'])
  })

  it('ignores completions for other days', () => {
    const state = buildHabitDayState(
      [habit({ id: 'a' })],
      [
        completion({ id: 'today', habit_id: 'a', date: '2026-10-31' }),
        completion({ id: 'yesterday', habit_id: 'a', date: '2026-10-30' }),
      ],
      '2026-10-31',
    )

    expect(state.completedIds).toEqual(['a'])
    expect(state.notes).toEqual({ a: '' })
  })
})
