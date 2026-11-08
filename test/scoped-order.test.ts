import { describe, expect, it } from 'vitest'
import { effectiveOrder, nextSortOrder, sortByEffectiveOrder } from '@/lib/goal-order'
import type { Milestone, Task } from '@/lib/types'

/**
 * Scoped structural ordering contract for the four-level hierarchy (D-05 / D-06).
 *
 * `lib/goal-order.ts` is entity-agnostic: categories, goals, milestones and
 * tasks all sort with the same effectiveOrder/sortByEffectiveOrder/nextSortOrder
 * helpers. Scoping to a parent (category_id / goal_id / milestone_id) is the
 * CALLER's job — these tests pre-filter, then assert each sibling group orders
 * independently.
 */

const CREATED = '2026-06-01T00:00:00.000Z'
const CREATED_MS = Date.parse(CREATED)

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-a',
    goal_id: 'goal-a',
    name: 'Milestone',
    created_at: '2026-01-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    milestone_id: 'milestone-a',
    goal_id: null,
    parent_id: null,
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    name: 'Task',
    completed: false,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('effectiveOrder (structural)', () => {
  it('uses sort_order when present', () => {
    expect(effectiveOrder({ sort_order: 5, created_at: CREATED })).toBe(5)
  })

  it('falls back to Date.parse(created_at) when sort_order is omitted', () => {
    expect(effectiveOrder({ created_at: CREATED })).toBe(CREATED_MS)
  })
})

describe('sortByEffectiveOrder', () => {
  it("sorts one goal's milestones ascending by sort_order", () => {
    const items = [
      milestone({ id: 'm-c', sort_order: 2 }),
      milestone({ id: 'm-a', sort_order: 0 }),
      milestone({ id: 'm-b', sort_order: 1 }),
    ]
    expect(sortByEffectiveOrder(items).map((m) => m.id)).toEqual(['m-a', 'm-b', 'm-c'])
  })

  it('tie-breaks equal sort_order by created_at ascending, then id ascending', () => {
    const items = [
      milestone({ id: 'z', sort_order: 1, created_at: '2026-01-02T00:00:00.000Z' }),
      milestone({ id: 'a', sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }),
      milestone({ id: 'm', sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(sortByEffectiveOrder(items).map((m) => m.id)).toEqual(['a', 'm', 'z'])
  })

  it('returns a new array and leaves the input untouched', () => {
    const items = [milestone({ id: 'b', sort_order: 2 }), milestone({ id: 'a', sort_order: 1 })]
    const sorted = sortByEffectiveOrder(items)
    expect(sorted).not.toBe(items)
    expect(items.map((m) => m.id)).toEqual(['b', 'a'])
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('keeps sibling groups independent when the caller pre-filters by milestone', () => {
    const tasks = [
      task({ id: 'm1-b', milestone_id: 'm1', sort_order: 1 }),
      task({ id: 'm1-a', milestone_id: 'm1', sort_order: 0 }),
      task({ id: 'm2-b', milestone_id: 'm2', sort_order: 1 }),
      task({ id: 'm2-a', milestone_id: 'm2', sort_order: 0 }),
    ]

    const withinM1 = sortByEffectiveOrder(tasks.filter((t) => t.milestone_id === 'm1')).map(
      (t) => t.id,
    )
    const withinM2 = sortByEffectiveOrder(tasks.filter((t) => t.milestone_id === 'm2')).map(
      (t) => t.id,
    )

    expect(withinM1).toEqual(['m1-a', 'm1-b'])
    expect(withinM2).toEqual(['m2-a', 'm2-b'])
  })
})

describe('nextSortOrder (structural)', () => {
  it('returns max(effectiveOrder) + 1 and counts a tombstoned sibling', () => {
    const items = [
      task({ sort_order: 2 }),
      task({ sort_order: 7, deleted_at: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(nextSortOrder(items)).toBe(8)
  })
})
