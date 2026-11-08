import { describe, expect, it } from 'vitest'
import {
  validateHabitCompletionRelations,
  validateImportRow,
  validateImportRows,
} from '@/lib/entity-schema'
import type { Habit, HabitCompletion } from '@/lib/types'

/**
 * Phase 12 / T-12-01: the habit layer's shape + cross-row invariants. Pure (no
 * IndexedDB) — a hand-edited backup must be rejected BEFORE any write so the
 * "one live completion per (habit, day)" guarantee holds on both backends
 * (Dexie keeps a non-unique `[habit_id+date]` index; SQLite has no UNIQUE, so
 * the validator owns live uniqueness — RESEARCH A4).
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
    date: '2026-01-01',
    note: null,
    completed_at: COMPLETED,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('validateImportRow for habits', () => {
  it('accepts a valid habit row', () => {
    expect(() => validateImportRow('habits', habit(), 0)).not.toThrow()
  })

  it('accepts an empty short_name and sort_order 0', () => {
    expect(() => validateImportRow('habits', habit({ short_name: '' }), 0)).not.toThrow()
    expect(() => validateImportRow('habits', habit({ sort_order: 0 }), 0)).not.toThrow()
  })

  it('rejects an unknown key', () => {
    expect(() =>
      validateImportRow('habits', { ...habit(), injected_column: 'x' }, 0),
    ).toThrow(/未知字段/)
  })

  it('rejects a non-string name', () => {
    expect(() => validateImportRow('habits', { ...habit(), name: 42 }, 0)).toThrow(
      /name 必须是字符串/,
    )
  })

  it('rejects an empty name', () => {
    expect(() => validateImportRow('habits', habit({ name: '' }), 0)).toThrow(/不能为空/)
  })

  it('rejects a missing id', () => {
    const { id: _id, ...withoutId } = habit()
    expect(() => validateImportRow('habits', withoutId, 0)).toThrow(/缺少字段/)
  })
})

describe('validateImportRow for habitCompletions', () => {
  it('accepts a completion whose note is null', () => {
    expect(() => validateImportRow('habitCompletions', completion(), 0)).not.toThrow()
  })

  it('accepts a multi-line note', () => {
    expect(() =>
      validateImportRow('habitCompletions', completion({ note: '第一行\n第二行' }), 0),
    ).not.toThrow()
  })

  it('rejects a row missing the note key', () => {
    const { note: _note, ...withoutNote } = completion()
    expect(() => validateImportRow('habitCompletions', withoutNote, 0)).toThrow(/缺少字段/)
  })

  it('accepts a parseable completed_at timestamp', () => {
    expect(() =>
      validateImportRow('habitCompletions', completion({ completed_at: COMPLETED }), 0),
    ).not.toThrow()
  })

  it('rejects an unparseable completed_at value', () => {
    expect(() =>
      validateImportRow('habitCompletions', completion({ completed_at: 'not-a-date' }), 0),
    ).toThrow(/completed_at 必须是有效的 ISO 时间戳/)
  })

  it('rejects an empty id', () => {
    expect(() => validateImportRow('habitCompletions', completion({ id: '' }), 0)).toThrow(
      /不能为空/,
    )
  })

  it('rejects a non-string non-null note', () => {
    expect(() =>
      validateImportRow('habitCompletions', { ...completion(), note: 7 }, 0),
    ).toThrow(/必须是 null 或字符串/)
  })
})

describe('validateHabitCompletionRelations', () => {
  it('is a no-op for an empty array', () => {
    expect(() => validateHabitCompletionRelations([])).not.toThrow()
  })

  it('accepts one completion per habit per day', () => {
    expect(() =>
      validateHabitCompletionRelations([
        completion({ id: 'a', date: '2026-01-01' }),
        completion({ id: 'b', date: '2026-01-02' }),
        completion({ id: 'c', habit_id: 'habit-2', date: '2026-01-01' }),
      ]),
    ).not.toThrow()
  })

  it('rejects an impossible date (2026-02-30)', () => {
    expect(() => validateHabitCompletionRelations([completion({ date: '2026-02-30' })])).toThrow(
      /习惯打卡 ".*" 的日期必须为有效的 YYYY-MM-DD/,
    )
  })

  it('rejects two live rows sharing (habit_id, date)', () => {
    expect(() =>
      validateHabitCompletionRelations([
        completion({ id: 'live-a', habit_id: 'habit-1', date: '2026-01-01' }),
        completion({ id: 'live-b', habit_id: 'habit-1', date: '2026-01-01' }),
      ]),
    ).toThrow(/习惯打卡中存在重复记录/)
  })

  it('allows a duplicate where one row is tombstoned', () => {
    expect(() =>
      validateHabitCompletionRelations([
        completion({ id: 'live', habit_id: 'habit-1', date: '2026-01-01' }),
        completion({
          id: 'tombstoned',
          habit_id: 'habit-1',
          date: '2026-01-01',
          deleted_at: '2026-05-01T00:00:00.000Z',
        }),
      ]),
    ).not.toThrow()
  })

  it('allows a duplicate where both rows are tombstoned', () => {
    expect(() =>
      validateHabitCompletionRelations([
        completion({ id: 'old-a', deleted_at: '2026-05-01T00:00:00.000Z' }),
        completion({ id: 'old-b', deleted_at: '2026-05-02T00:00:00.000Z' }),
      ]),
    ).not.toThrow()
  })

  it('allows a dangling habit_id (no foreign key requirement)', () => {
    expect(() =>
      validateHabitCompletionRelations([completion({ habit_id: 'habit-that-does-not-exist' })]),
    ).not.toThrow()
  })
})

describe('validateImportRows for habitCompletions', () => {
  it('rejects an unknown key before relation checks', () => {
    expect(() =>
      validateImportRows('habitCompletions', [{ ...completion(), injected_column: 'x' }]),
    ).toThrow(/未知字段/)
  })
})
