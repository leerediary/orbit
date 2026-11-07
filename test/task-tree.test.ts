import { describe, expect, it } from 'vitest'
import {
  buildTaskTree,
  descendantIds,
  leafFraction,
  reachableLeaves,
  subtreeProgress,
  taskDepth,
} from '@/lib/task-tree'
import type { Task } from '@/lib/types'

/**
 * Task-tree contract for the flexible hierarchy (D-01/D-02/D-03, A5).
 *
 * Orphan defense: a task's parent must exist AND share its milestone_id.
 * Containers are never leaves; the UI and progress rollup share this exact
 * reachableLeaves definition so they can never disagree.
 */

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
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('leafFraction', () => {
  it('maps checkbox completion to 0 or 1', () => {
    expect(leafFraction(task({ progress_type: 'checkbox', completed: true }))).toBe(1)
    expect(leafFraction(task({ progress_type: 'checkbox', completed: false }))).toBe(0)
  })

  it('computes the quantity ratio between 0 and 1', () => {
    expect(leafFraction(task({ progress_type: 'quantity', target_value: 3, current_value: 1 }))).toBeCloseTo(
      1 / 3,
    )
    expect(leafFraction(task({ progress_type: 'quantity', target_value: 100, current_value: 40 }))).toBe(0.4)
  })

  it('returns an exact 1 when the target is reached (no float drift)', () => {
    const done = leafFraction(task({ progress_type: 'quantity', target_value: 3, current_value: 3 }))
    expect(done).toBe(1)
    expect(Object.is(done, 1)).toBe(true)
    expect(leafFraction(task({ progress_type: 'quantity', target_value: 3, current_value: 9 }))).toBe(1)
  })

  it('returns 0 for a non-positive target and clamps negative current values', () => {
    expect(leafFraction(task({ progress_type: 'quantity', target_value: 0, current_value: 5 }))).toBe(0)
    expect(leafFraction(task({ progress_type: 'quantity', target_value: 10, current_value: -4 }))).toBe(0)
  })
})

describe('buildTaskTree', () => {
  it('buckets roots and children and sorts each bucket', () => {
    const tasks = [
      task({ id: 'root-b', sort_order: 1 }),
      task({ id: 'root-a', sort_order: 0 }),
      task({ id: 'child-b', parent_id: 'root-a', sort_order: 1 }),
      task({ id: 'child-a', parent_id: 'root-a', sort_order: 0 }),
    ]

    const { roots, children } = buildTaskTree(tasks)

    expect(roots.map((t) => t.id)).toEqual(['root-a', 'root-b'])
    expect(children.get('root-a')?.map((t) => t.id)).toEqual(['child-a', 'child-b'])
  })

  it('drops a task whose parent is missing', () => {
    const { roots, children } = buildTaskTree([
      task({ id: 'root' }),
      task({ id: 'orphan', parent_id: 'missing' }),
    ])

    expect(roots.map((t) => t.id)).toEqual(['root'])
    expect(children.size).toBe(0)
  })

  it('drops a task whose parent belongs to another milestone', () => {
    const { roots, children } = buildTaskTree([
      task({ id: 'parent', milestone_id: 'm1' }),
      task({ id: 'child', parent_id: 'parent', milestone_id: 'm2' }),
    ])

    expect(roots.map((t) => t.id)).toEqual(['parent'])
    expect(children.size).toBe(0)
  })
})

describe('reachableLeaves', () => {
  it('excludes containers and returns their leaves', () => {
    const tasks = [
      task({ id: 'container' }),
      task({ id: 'leaf-1', parent_id: 'container', sort_order: 0 }),
      task({ id: 'leaf-2', parent_id: 'container', sort_order: 1 }),
    ]

    expect(reachableLeaves(tasks).map((t) => t.id)).toEqual(['leaf-1', 'leaf-2'])
  })

  it('counts a childless root as a leaf', () => {
    expect(reachableLeaves([task({ id: 'solo' })]).map((t) => t.id)).toEqual(['solo'])
  })

  it('terminates on a cyclic parent graph instead of looping', () => {
    const leaves = reachableLeaves([
      task({ id: 'a', parent_id: 'b' }),
      task({ id: 'b', parent_id: 'a' }),
    ])

    expect(leaves).toEqual([])
  })
})

describe('descendantIds', () => {
  it('walks descendants depth-first in sibling order', () => {
    const tasks = [
      task({ id: 'root' }),
      task({ id: 'a', parent_id: 'root', sort_order: 0 }),
      task({ id: 'a1', parent_id: 'a', sort_order: 0 }),
      task({ id: 'b', parent_id: 'root', sort_order: 1 }),
    ]
    const { children } = buildTaskTree(tasks)

    expect(descendantIds('root', children)).toEqual(['a', 'a1', 'b'])
  })

  it('terminates on a cyclic children map', () => {
    const cyclic = new Map<string, Task[]>([
      ['a', [task({ id: 'b' })]],
      ['b', [task({ id: 'a' })]],
    ])

    expect(descendantIds('a', cyclic)).toEqual(['b'])
  })
})

describe('taskDepth', () => {
  it('counts a milestone-level top task as depth 1 and supports three levels', () => {
    const tasks = [
      task({ id: 'l1' }),
      task({ id: 'l2', parent_id: 'l1' }),
      task({ id: 'l3', parent_id: 'l2' }),
    ]
    const byId = new Map(tasks.map((t) => [t.id, t]))

    expect(taskDepth(byId.get('l1') as Task, byId)).toBe(1)
    expect(taskDepth(byId.get('l2') as Task, byId)).toBe(2)
    expect(taskDepth(byId.get('l3') as Task, byId)).toBe(3)
  })
})

describe('subtreeProgress', () => {
  it('aggregates leaf fractions strictly below the container', () => {
    const tasks = [
      task({ id: 'root' }),
      task({ id: 'done', parent_id: 'root', progress_type: 'checkbox', completed: true }),
      task({
        id: 'partial',
        parent_id: 'root',
        progress_type: 'quantity',
        target_value: 3,
        current_value: 1,
      }),
    ]
    const { children } = buildTaskTree(tasks)

    const progress = subtreeProgress('root', children)

    expect(progress.total).toBe(2)
    expect(progress.completed).toBeCloseTo(1 + 1 / 3)
  })

  it('returns zero for a container with no descendants', () => {
    expect(subtreeProgress('nobody', new Map())).toEqual({ completed: 0, total: 0 })
  })
})
