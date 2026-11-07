import { describe, expect, it } from 'vitest'
import { togglePayload } from '@/lib/task-order'
import type { Task } from '@/lib/types'

/**
 * Pure task contract for the flexible hierarchy (D-05 / D-06).
 *
 * Task grouping moved to lib/task-tree.ts (buildTaskTree); this module keeps
 * only togglePayload: flip completed and set/clear completed_at.
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

  it('still flips the completed flag for a quantity task', () => {
    const payload = togglePayload(
      task({ progress_type: 'quantity', target_value: 10, current_value: 2 }),
      '2026-05-01T12:00:00.000Z',
    )
    expect(payload).toEqual({ completed: true, completed_at: '2026-05-01T12:00:00.000Z' })
  })

  // Structural contract: daily todos (and any future row) only need a boolean
  // `completed`, so a plain object literal must type-check without a cast.
  it('accepts a plain { completed } row', () => {
    const now = '2026-05-01T12:00:00.000Z'
    expect(togglePayload({ completed: false }, now)).toEqual({
      completed: true,
      completed_at: now,
    })
  })
})
