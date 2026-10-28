import { describe, expect, it } from 'vitest'
import { groupTasks, reparentOrder, togglePayload } from '@/lib/task-order'
import { effectiveOrder, nextSortOrder } from '@/lib/goal-order'
import type { Task } from '@/lib/types'

/**
 * Pure task contract for the Phase 3 hierarchy (D-05 / D-06, TASK-02).
 *
 *  - groupTasks buckets live tasks by milestone_id; null OR dangling ids land
 *    in the direct bucket (orphan defense — never dropped, never hidden) and
 *    every bucket is sorted ascending by effective order.
 *  - togglePayload flips completed and sets/clears completed_at.
 *  - reparentOrder assigns DISTINCT sort_order values (base + index) so moved
 *    tasks keep their visual order when a milestone is deleted.
 */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    goal_id: 'goal-a',
    milestone_id: null,
    name: 'Task',
    completed: false,
    completed_at: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('groupTasks', () => {
  it('buckets by milestone_id and puts null or dangling ids in the direct group', () => {
    const tasks = [
      task({ id: 'direct', milestone_id: null, sort_order: 0 }),
      task({ id: 'live', milestone_id: 'm1', sort_order: 1 }),
      task({ id: 'dangling', milestone_id: 'gone', sort_order: 1 }),
      task({ id: 'foreign', milestone_id: 'other-goal-milestone', sort_order: 2 }),
    ]
    const { direct, byMilestone } = groupTasks(tasks, new Set(['m1']))

    expect(direct.map((t) => t.id)).toEqual(['direct', 'dangling', 'foreign'])
    expect(byMilestone.get('m1')?.map((t) => t.id)).toEqual(['live'])
    expect(byMilestone.has('gone')).toBe(false)
    expect(byMilestone.size).toBe(1)
  })

  it('sorts every bucket by effective order with created_at then id tie-break', () => {
    const tasks = [
      task({ id: 'b', milestone_id: 'm1', sort_order: 1, created_at: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'a', milestone_id: 'm1', sort_order: 0, created_at: '2026-03-01T00:00:00.000Z' }),
      task({ id: 'z', milestone_id: null, sort_order: 1, created_at: '2026-01-02T00:00:00.000Z' }),
      task({ id: 'y', milestone_id: null, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }),
    ]
    const { direct, byMilestone } = groupTasks(tasks, new Set(['m1']))

    expect(byMilestone.get('m1')?.map((t) => t.id)).toEqual(['a', 'b'])
    expect(direct.map((t) => t.id)).toEqual(['y', 'z'])
  })

  it('returns empty buckets and does not mutate the input', () => {
    const tasks = [task({ id: 'x', sort_order: 5 })]
    const snapshot = tasks.map((t) => t.id)
    const { direct, byMilestone } = groupTasks(tasks, new Set())
    expect(byMilestone.size).toBe(0)
    expect(direct.map((t) => t.id)).toEqual(['x'])
    expect(tasks.map((t) => t.id)).toEqual(snapshot)
  })
})

describe('togglePayload', () => {
  it('flips completed and stamps completed_at when completing', () => {
    const now = '2026-05-01T12:00:00.000Z'
    expect(togglePayload(task({ completed: false }), now)).toEqual({
      completed: true,
      completed_at: now,
    })
  })

  it('clears completed_at when uncompleting', () => {
    const payload = togglePayload(
      task({ completed: true, completed_at: '2026-04-01T00:00:00.000Z' }),
      '2026-05-01T12:00:00.000Z',
    )
    expect(payload).toEqual({ completed: false, completed_at: null })
  })

  it('defaults now to an ISO timestamp', () => {
    const payload = togglePayload(task({ completed: false }))
    expect(payload.completed).toBe(true)
    expect(typeof payload.completed_at).toBe('string')
    expect(Number.isNaN(Date.parse(payload.completed_at as string))).toBe(false)
  })
})

describe('reparentOrder', () => {
  it('assigns base + index for empty direct siblings', () => {
    const before = Date.now()
    const moved = [task({ id: 'a' }), task({ id: 'b' })]
    const result = reparentOrder([], moved)
    const after = Date.now()

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('a')
    expect(result[1].id).toBe('b')
    // Empty list → nextSortOrder baseline is Date.now() + 1, then + index.
    expect(result[0].sort_order).toBeGreaterThanOrEqual(before + 1)
    expect(result[0].sort_order).toBeLessThanOrEqual(after + 1)
    expect(result[1].sort_order).toBe(result[0].sort_order + 1)
  })

  it('uses max(effectiveOrder)+1 of siblings (including tombstones) and distinct ascending values', () => {
    const siblings = [
      task({ id: 'live', sort_order: 3 }),
      task({ id: 'tombstone', sort_order: 7, deleted_at: '2026-02-01T00:00:00.000Z' }),
    ]
    const moved = [task({ id: 'moved-1' }), task({ id: 'moved-2' }), task({ id: 'moved-3' })]
    const result = reparentOrder(siblings, moved)
    const base = nextSortOrder(siblings)

    expect(base).toBe(Math.max(...siblings.map(effectiveOrder)) + 1)
    expect(result.map((r) => r.sort_order)).toEqual([base, base + 1, base + 2])
    expect(new Set(result.map((r) => r.sort_order)).size).toBe(3)
  })
})
