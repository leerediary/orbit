import { describe, expect, it } from 'vitest'
import { ENTITY_COLUMNS, validateImportRow } from '@/lib/entity-schema'
import type { Goal } from '@/lib/types'

/**
 * Phase 22 / D-01 + D-02: the goal→habit link is an IMPORT-ONLY shape key.
 *
 * `goals.habit_id` persists on the active Dexie/web runtime (whole-row JSON) and
 * must validate on import, but it is deliberately absent from SHAPES.goals so it
 * never enters ENTITY_COLUMNS.goals and the frozen SQLite INSERT column list
 * cannot be widened (T-22-02). The dormant SQLite path therefore drops the
 * field — a recorded limitation, not a migration target for this phase.
 */

const CREATED = '2026-01-01T00:00:00.000Z'
const UPDATED = '2026-01-02T00:00:00.000Z'

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'category-1',
    name: '读《原则》',
    created_at: CREATED,
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('validateImportRow for goals.habit_id', () => {
  it('accepts a legacy goal row that omits habit_id entirely', () => {
    expect(() => validateImportRow('goals', goal(), 0)).not.toThrow()
  })

  it('accepts habit_id: null (no habit linked)', () => {
    expect(() => validateImportRow('goals', goal({ habit_id: null }), 0)).not.toThrow()
  })

  it('accepts habit_id: string (habit linked)', () => {
    expect(() => validateImportRow('goals', goal({ habit_id: 'habit-1' }), 0)).not.toThrow()
  })

  it('rejects a numeric habit_id', () => {
    expect(() =>
      validateImportRow('goals', { ...goal(), habit_id: 42 }, 0),
    ).toThrow(/habit_id 必须是 null 或字符串/)
  })

  it('rejects an object habit_id', () => {
    expect(() =>
      validateImportRow('goals', { ...goal(), habit_id: {} }, 0),
    ).toThrow(/habit_id 必须是 null 或字符串/)
  })

  it('still rejects an unrelated unknown key', () => {
    expect(() =>
      validateImportRow('goals', { ...goal(), injected_column: 'x' }, 0),
    ).toThrow(/含未知字段/)
  })

  it('locks the native schema: habit_id is not a SQLite column', () => {
    expect(ENTITY_COLUMNS.goals).not.toContain('habit_id')
  })

  it('allows two goal rows to share the same habit_id (D-02, no uniqueness)', () => {
    expect(() => validateImportRow('goals', goal({ id: 'goal-a', habit_id: 'habit-1' }), 0)).not.toThrow()
    expect(() => validateImportRow('goals', goal({ id: 'goal-b', habit_id: 'habit-1' }), 1)).not.toThrow()
  })
})
