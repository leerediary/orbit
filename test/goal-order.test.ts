import { describe, expect, it } from 'vitest'
import { effectiveOrder, nextSortOrder, sortGoals } from '@/lib/goal-order'
import type { Goal } from '@/lib/types'

/**
 * Pure ordering contract for the Goals UI (D-02 / D-08).
 *
 *  - effectiveOrder uses sort_order when present, else falls back to
 *    Date.parse(created_at) so a legacy row (seed-goal-orbit-v1) still sorts.
 *  - sortGoals is ascending by effectiveOrder, tie-breaking on created_at
 *    ascending then id ascending (deterministic, never locale-dependent).
 *  - nextSortOrder returns max(effectiveOrder over ALL goals) + 1, so a newly
 *    created/reordered goal always lands after every existing goal.
 */

const CREATED = '2026-06-01T00:00:00.000Z'
const CREATED_MS = Date.parse(CREATED)

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-a',
    name: 'Goal',
    description: '',
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('effectiveOrder', () => {
  it('uses sort_order when present', () => {
    expect(effectiveOrder(goal({ sort_order: 5, created_at: CREATED }))).toBe(5)
  })

  it('falls back to Date.parse(created_at) for a legacy row without sort_order', () => {
    // Simulate the runtime seed-goal-orbit-v1 row: no sort_order at all.
    const { sort_order: _omitted, ...legacy } = goal({ created_at: CREATED })
    expect(effectiveOrder(legacy as unknown as Goal)).toBe(CREATED_MS)
  })
})

describe('sortGoals', () => {
  it('sorts ascending by effectiveOrder', () => {
    const goals = [
      goal({ id: 'c', sort_order: 2 }),
      goal({ id: 'a', sort_order: 0 }),
      goal({ id: 'b', sort_order: 1 }),
    ]
    expect(sortGoals(goals).map((g) => g.id)).toEqual(['a', 'b', 'c'])
  })

  it('tie-breaks equal effectiveOrder by created_at ascending, then id ascending', () => {
    const goals = [
      goal({ id: 'z', sort_order: 1, created_at: '2026-01-02T00:00:00.000Z' }),
      goal({ id: 'a', sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }),
      goal({ id: 'm', sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(sortGoals(goals).map((g) => g.id)).toEqual(['a', 'm', 'z'])
  })

  it('returns a new array and leaves the input untouched', () => {
    const goals = [goal({ id: 'b', sort_order: 2 }), goal({ id: 'a', sort_order: 1 })]
    const sorted = sortGoals(goals)
    expect(sorted).not.toBe(goals)
    expect(goals.map((g) => g.id)).toEqual(['b', 'a'])
    expect(sorted.map((g) => g.id)).toEqual(['a', 'b'])
  })
})

describe('nextSortOrder', () => {
  it('returns max(effectiveOrder) + 1', () => {
    expect(nextSortOrder([goal({ sort_order: 1 }), goal({ sort_order: 3 })])).toBe(4)
  })

  it('counts archived goals too (they are still passed in the list)', () => {
    expect(nextSortOrder([goal({ sort_order: 7, deleted_at: '2026-02-01T00:00:00.000Z' })])).toBe(8)
  })

  it('returns a finite positive baseline for an empty list', () => {
    const n = nextSortOrder([])
    expect(Number.isFinite(n)).toBe(true)
    expect(n).toBeGreaterThan(0)
  })
})
