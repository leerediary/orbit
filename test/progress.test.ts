import { describe, expect, it } from 'vitest'
import { progressOf } from '@/lib/progress'
import type { Task } from '@/lib/types'

/**
 * Derived progress contract (D-06 / D-07, PROG-01).
 *
 *  - progressOf counts task.completed === true over the live tasks the caller
 *    already filtered; total is the array length.
 *  - Empty input yields { completed: 0, total: 0 } so callers can render nothing
 *    (D-02).
 *  - Pure: the input array is never mutated.
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

describe('progressOf', () => {
  it('returns zero counts for an empty list', () => {
    expect(progressOf([])).toEqual({ completed: 0, total: 0 })
  })

  it('counts completed and total over a mixed list', () => {
    const tasks = [
      task({ id: 'a', completed: true, completed_at: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'b', completed: false }),
      task({ id: 'c', completed: true, completed_at: '2026-02-02T00:00:00.000Z' }),
      task({ id: 'd', completed: false }),
      task({ id: 'e', completed: false }),
    ]
    expect(progressOf(tasks)).toEqual({ completed: 2, total: 5 })
  })

  it('reports completed === total when every task is done', () => {
    const tasks = [
      task({ id: 'a', completed: true, completed_at: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'b', completed: true, completed_at: '2026-02-02T00:00:00.000Z' }),
      task({ id: 'c', completed: true, completed_at: '2026-02-03T00:00:00.000Z' }),
    ]
    const progress = progressOf(tasks)
    expect(progress).toEqual({ completed: 3, total: 3 })
    expect(progress.completed).toBe(progress.total)
  })

  it('counts only completed === true and does not mutate the input', () => {
    const tasks = [
      task({ id: 'a', completed: true }),
      task({ id: 'b', completed: false }),
      task({ id: 'c', completed: true }),
    ]
    const snapshot = tasks.map((entry) => entry.id)

    expect(progressOf(tasks)).toEqual({ completed: 2, total: 3 })
    expect(tasks.map((entry) => entry.id)).toEqual(snapshot)
    expect(tasks[0].completed).toBe(true)
    expect(tasks[1].completed).toBe(false)
  })
})
