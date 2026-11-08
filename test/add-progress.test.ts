import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getRepository } from '@/lib/repository-provider'
import { addProgress } from '@/lib/task-progress'
import type { Task } from '@/lib/types'

/**
 * addProgress reusable primitive (D-04). It must be a standalone lib function,
 * never buried in a UI component, so a future 今日待办 / 番茄钟 can call the same
 * entry point. These tests drive it through the real Dexie repository.
 */

function quantityTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-quantity',
    milestone_id: 'milestone-a',
    goal_id: null,
    parent_id: null,
    progress_type: 'quantity',
    unit: '页',
    target_value: 100,
    current_value: 40,
    name: '读 100 页',
    completed: false,
    completed_at: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

beforeEach(async () => {
  await db.tasks.clear()
})

describe('addProgress', () => {
  it('accumulates amount onto current_value and persists it', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask())

    const updated = await addProgress('task-quantity', 25)

    expect(updated.current_value).toBe(65)
    const row = await db.tasks.get('task-quantity')
    expect(row?.current_value).toBe(65)
  })

  it('treats a null current_value as zero', async () => {
    await getRepository().upsert<Task>(
      'tasks',
      quantityTask({ id: 'task-empty', current_value: null }),
    )

    const updated = await addProgress('task-empty', 10)

    expect(updated.current_value).toBe(10)
  })

  it('returns the updated task, preserving non-progress fields', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask())

    const updated = await addProgress('task-quantity', 5)

    expect(updated.id).toBe('task-quantity')
    expect(updated.name).toBe('读 100 页')
    expect(updated.target_value).toBe(100)
    expect(updated.current_value).toBe(45)
  })

  it('stamps completed_at when the quantity crosses its target', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask({ current_value: 95 }))

    const updated = await addProgress('task-quantity', 10)

    expect(updated.current_value).toBe(105)
    expect(updated.completed_at).not.toBeNull()
    const row = await db.tasks.get('task-quantity')
    expect(row?.completed_at).not.toBeNull()
  })

  it('does not stamp completed_at before the target is reached', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask())

    const updated = await addProgress('task-quantity', 25)

    expect(updated.current_value).toBe(65)
    expect(updated.completed_at).toBeNull()
  })

  it('rejects a non-quantity task', async () => {
    await getRepository().upsert<Task>(
      'tasks',
      quantityTask({ id: 'task-checkbox', progress_type: 'checkbox', unit: null, target_value: null, current_value: null }),
    )

    await expect(addProgress('task-checkbox', 5)).rejects.toThrow('该任务不是数量型任务')
  })

  it('rejects a missing task', async () => {
    await expect(addProgress('task-missing', 5)).rejects.toThrow('任务不存在')
  })

  it('rejects amount <= 0', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask())

    await expect(addProgress('task-quantity', 0)).rejects.toThrow('增加量必须大于 0')
    await expect(addProgress('task-quantity', -3)).rejects.toThrow('增加量必须大于 0')
  })

  it('rejects a non-finite amount', async () => {
    await getRepository().upsert<Task>('tasks', quantityTask())

    await expect(addProgress('task-quantity', Number.NaN)).rejects.toThrow('增加量必须大于 0')
    await expect(addProgress('task-quantity', Number.POSITIVE_INFINITY)).rejects.toThrow(
      '增加量必须大于 0',
    )
  })

  it('stamps completed_at on a further increment when already at target (T21 heal)', async () => {
    await getRepository().upsert<Task>('tasks', {
      ...quantityTask(),
      current_value: 100,
      target_value: 100,
      completed_at: null,
    })

    const updated = await addProgress('task-quantity', 5)

    expect(updated.completed_at).not.toBeNull()
  })
})
