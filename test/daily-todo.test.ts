import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { addProgress } from '@/lib/task-progress'
import { togglePayload } from '@/lib/task-order'
import type { DailyTodo, Task } from '@/lib/types'

/**
 * DAILY-02/03/04 persistence proof (Phase 9).
 *
 * Every case runs against a FRESH OrbitDB + LocalRepository instance (never the
 * shared singleton), so writes are proven to have reached fake-indexeddb rather
 * than an in-memory test double.
 */

const CREATED = '2026-01-01T00:00:00.000Z'

const dbNames: string[] = []
const opened: OrbitDB[] = []

function fresh(suffix: string): { db: OrbitDB; repo: LocalRepository } {
  const name = `test-daily-todo-${suffix}`
  dbNames.push(name)
  const db = new OrbitDB(name)
  opened.push(db)
  return { db, repo: new LocalRepository(db) }
}

afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  for (const name of dbNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    milestone_id: 'milestone-a',
    goal_id: null,
    parent_id: null,
    name: '任务 A',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    completed: false,
    completed_at: null,
    created_at: CREATED,
    sort_order: 0,
    updated_at: CREATED,
    deleted_at: null,
    ...overrides,
  }
}

function standalone(overrides: Partial<DailyTodo> = {}): Omit<DailyTodo, 'id' | 'updated_at' | 'deleted_at'> {
  return {
    task_id: null,
    name: '买牛奶',
    completed: false,
    completed_at: null,
    added_at: '2026-06-01T08:00:00.000Z',
    ...overrides,
  }
}

describe('dailyTodo persistence', () => {
  it('inserts a standalone todo with all fields and a generated id', async () => {
    const { repo } = fresh('standalone')

    await repo.upsert<DailyTodo>('dailyTodos', standalone())

    const rows = await repo.list<DailyTodo>('dailyTodos')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBeTruthy()
    expect(rows[0]).toMatchObject({
      task_id: null,
      name: '买牛奶',
      completed: false,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
      deleted_at: null,
    })
  })

  it('toggles a standalone todo and a fresh read sees the new state', async () => {
    const { repo } = fresh('toggle-standalone')
    await repo.upsert<DailyTodo>('dailyTodos', standalone())

    const [todo] = await repo.list<DailyTodo>('dailyTodos')
    const now = '2026-06-02T09:00:00.000Z'
    await repo.upsert<DailyTodo>('dailyTodos', {
      ...todo,
      ...togglePayload({ completed: todo.completed ?? false }, now),
    })

    const [updated] = await repo.list<DailyTodo>('dailyTodos')
    expect(updated.id).toBe(todo.id)
    expect(updated.completed).toBe(true)
    expect(updated.completed_at).toBe(now)
  })

  it('routes a linked checkbox toggle to the Task, leaving the daily row null', async () => {
    const { repo } = fresh('toggle-linked')
    await repo.upsert<Task>('tasks', taskRow({ id: 'task-linked' }))
    await repo.upsert<DailyTodo>('dailyTodos', {
      task_id: 'task-linked',
      name: null,
      completed: null,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
    })

    const [task] = await repo.list<Task>('tasks')
    await repo.upsert<Task>('tasks', { ...task, ...togglePayload(task) })

    const [storedTask] = await repo.list<Task>('tasks')
    expect(storedTask.completed).toBe(true)
    expect(typeof storedTask.completed_at).toBe('string')
    expect(Number.isNaN(Date.parse(storedTask.completed_at as string))).toBe(false)

    // Single source of truth: the linked row never stores completion or a name.
    const [storedDaily] = await repo.list<DailyTodo>('dailyTodos')
    expect(storedDaily.task_id).toBe('task-linked')
    expect(storedDaily.completed).toBeNull()
    expect(storedDaily.name).toBeNull()
  })

  it('removes a linked entry without touching the Task', async () => {
    const { repo } = fresh('remove-linked')
    await repo.upsert<Task>('tasks', taskRow({ id: 'task-linked' }))
    await repo.upsert<DailyTodo>('dailyTodos', {
      task_id: 'task-linked',
      name: null,
      completed: null,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
    })

    const [entry] = await repo.list<DailyTodo>('dailyTodos')
    expect(entry.task_id).toBe('task-linked')

    await repo.softDelete('dailyTodos', entry.id)

    expect(await repo.list<DailyTodo>('dailyTodos')).toHaveLength(0)
    const tasks = await repo.list<Task>('tasks')
    expect(tasks.map((t) => t.id)).toEqual(['task-linked'])
    expect(tasks[0].deleted_at).toBeNull()
  })

  it('increments a quantity task through addProgress', async () => {
    const { repo } = fresh('add-progress')
    await repo.upsert<Task>('tasks', taskRow({
      id: 'task-quantity',
      progress_type: 'quantity',
      unit: '页',
      target_value: 10,
      current_value: 2,
    }))

    const updated = await addProgress('task-quantity', 5, undefined, repo)
    expect(updated.current_value).toBe(7)

    const [stored] = await repo.list<Task>('tasks')
    expect(stored.current_value).toBe(7)
  })

  it('keeps the tombstoned daily row visible with includeDeleted', async () => {
    const { repo } = fresh('tombstone')
    await repo.upsert<DailyTodo>('dailyTodos', standalone())

    const [row] = await repo.list<DailyTodo>('dailyTodos')
    await repo.softDelete('dailyTodos', row.id)

    const all = await repo.list<DailyTodo>('dailyTodos', { includeDeleted: true })
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(row.id)
    expect(all[0].deleted_at).not.toBeNull()
  })
})
