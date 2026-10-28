import { describe, expect, it } from 'vitest'
import { effectiveOrder, nextSortOrder, sortByEffectiveOrder, sortGoals } from '@/lib/goal-order'
import type { Goal, Milestone, Task } from '@/lib/types'

/**
 * Scoped structural ordering contract for Phase 3 (D-05 / D-06).
 *
 * `lib/goal-order.ts` is entity-agnostic: milestones and tasks sort with the
 * same effectiveOrder/sortByEffectiveOrder/nextSortOrder helpers as goals.
 * Scoping to a parent (goal_id + milestone_id) is the CALLER's job — these
 * tests pre-filter, then assert each sibling group orders independently.
 */

const CREATED = '2026-06-01T00:00:00.000Z'
const CREATED_MS = Date.parse(CREATED)

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-a',
    goal_id: 'goal-a',
    name: 'Milestone',
    completed: false,
    completed_at: null,
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
    goal_id: 'goal-a',
    milestone_id: null,
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

  it('keeps sibling groups independent when the caller pre-filters by parent', () => {
    const tasks = [
      task({ id: 'g1-null-b', goal_id: 'goal-1', milestone_id: null, sort_order: 1 }),
      task({ id: 'g1-null-a', goal_id: 'goal-1', milestone_id: null, sort_order: 0 }),
      task({ id: 'g1-m1-b', goal_id: 'goal-1', milestone_id: 'm1', sort_order: 1 }),
      task({ id: 'g1-m1-a', goal_id: 'goal-1', milestone_id: 'm1', sort_order: 0 }),
      task({ id: 'g2-null-a', goal_id: 'goal-2', milestone_id: null, sort_order: 0 }),
      task({ id: 'g2-null-b', goal_id: 'goal-2', milestone_id: null, sort_order: 1 }),
    ]

    const directG1 = sortByEffectiveOrder(
      tasks.filter((t) => t.goal_id === 'goal-1' && t.milestone_id === null),
    ).map((t) => t.id)
    const withinM1 = sortByEffectiveOrder(tasks.filter((t) => t.milestone_id === 'm1')).map(
      (t) => t.id,
    )
    const directG2 = sortByEffectiveOrder(
      tasks.filter((t) => t.goal_id === 'goal-2' && t.milestone_id === null),
    ).map((t) => t.id)

    expect(directG1).toEqual(['g1-null-a', 'g1-null-b'])
    expect(withinM1).toEqual(['g1-m1-a', 'g1-m1-b'])
    expect(directG2).toEqual(['g2-null-a', 'g2-null-b'])
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

describe('sortGoals alias', () => {
  it('yields results identical to sortByEffectiveOrder on the same Goal[]', () => {
    const goals: Goal[] = [
      {
        id: 'b',
        name: 'B',
        description: '',
        sort_order: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'a',
        name: 'A',
        description: '',
        sort_order: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted_at: null,
      },
    ]

    expect(sortGoals(goals).map((g) => g.id)).toEqual(['a', 'b'])
    expect(sortGoals(goals)).toEqual(sortByEffectiveOrder(goals))
  })
})
