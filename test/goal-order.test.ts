import { describe, expect, it } from 'vitest'
import { effectiveOrder, nextSortOrder } from '@/lib/goal-order'
import type { Goal } from '@/lib/types'

/**
 * Pure ordering contract for the four-level hierarchy (D-02 / D-08).
 *
 *  - effectiveOrder uses sort_order when present, else falls back to
 *    Date.parse(created_at) so a legacy row still sorts.
 *  - sortByEffectiveOrder is ascending by effectiveOrder, tie-breaking on
 *    created_at ascending then id ascending (covered in scoped-order.test.ts).
 *  - nextSortOrder returns max(effectiveOrder over ALL siblings) + 1, so a
 *    newly created/reordered row always lands after every existing sibling.
 */

const CREATED = '2026-06-01T00:00:00.000Z'
const CREATED_MS = Date.parse(CREATED)

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-a',
    category_id: 'category-a',
    name: 'Goal',
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
    // Simulate a legacy row: no sort_order at all.
    const { sort_order: _omitted, ...legacy } = goal({ created_at: CREATED })
    expect(effectiveOrder(legacy as unknown as Goal)).toBe(CREATED_MS)
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
