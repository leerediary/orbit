import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { habitCompletionId } from '@/lib/habit'
import { settlePomodoroSession } from '@/lib/pomodoro-settlement'
import { dayKey } from '@/lib/today'
import type {
  DailyTodo,
  Habit,
  HabitCompletion,
  PomodoroSession,
  Task,
} from '@/lib/types'

/**
 * Phase 13 / POMO-03 settlement integration proof.
 *
 * Every test drives `settlePomodoroSession` through a real LocalRepository on a
 * fresh, uniquely named fake-indexeddb database, so the assertions cover the
 * actual write order rather than an in-memory mock. The suite covers:
 *  - quantity addProgress, checkbox completion, and standalone todo completion
 *  - habit completion keyed by habitCompletionId with note merging/revival
 *  - the session-last retry guard (no double progress)
 *  - every precondition rejecting before ANY write
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-pomodoro-settle-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(name: string): { database: OrbitDB; repo: LocalRepository } {
  const database = new OrbitDB(name)
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

const UPDATED = '2026-10-31T00:00:00.000Z'
const STARTED = '2026-10-31T01:00:00.000Z'
const NOW = '2026-10-31T01:25:00.000Z'
const DAY = dayKey(STARTED, 0)

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    milestone_id: null,
    goal_id: 'goal-1',
    parent_id: null,
    name: '写代码',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    completed: false,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function dailyTodo(over: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'todo-1',
    task_id: null,
    name: '买菜',
    completed: false,
    completed_at: null,
    added_at: '2026-10-31T00:30:00.000Z',
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function completion(over: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: habitCompletionId('habit-1', DAY),
    habit_id: 'habit-1',
    date: DAY,
    note: null,
    completed_at: '2026-10-31T00:10:00.000Z',
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function session(over: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 'session-1',
    started_at: STARTED,
    duration_sec: 1500,
    notes: [],
    habit_id: null,
    task_id: null,
    daily_todo_id: null,
    marked_task_complete: false,
    progress_amount: null,
    shared_indices: [],
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

const options = {
  linkedTask: null as Task | null,
  linkedTodo: null as DailyTodo | null,
  offsetHours: 0,
  nowIso: NOW,
}

describe('settlePomodoroSession — task paths', () => {
  it('adds quantity progress and stores the session row with arrays intact', async () => {
    const { repo } = open(newName())
    const quantity = task({
      id: 'task-q',
      progress_type: 'quantity',
      unit: '页',
      target_value: 100,
      current_value: 10,
    })
    await repo.upsert<Task>('tasks', quantity)

    const row = session({
      id: 'session-q',
      task_id: 'task-q',
      progress_amount: 15,
      notes: ['第一行', '第二行'],
      shared_indices: [1],
    })
    const result = await settlePomodoroSession(repo, row, {
      ...options,
      linkedTask: quantity,
    })

    expect(result).toBe(row)
    const tasks = await repo.list<Task>('tasks')
    expect(tasks[0].current_value).toBe(25)

    const sessions = await repo.list<PomodoroSession>('pomodoroSessions')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'session-q',
      task_id: 'task-q',
      progress_amount: 15,
      notes: ['第一行', '第二行'],
      shared_indices: [1],
    })
    expect(sessions[0].notes).toEqual(['第一行', '第二行'])
    expect(sessions[0].shared_indices).toEqual([1])
  })

  it('marks a checkbox task complete with completed_at = nowIso', async () => {
    const { repo } = open(newName())
    const checkbox = task({ id: 'task-c', progress_type: 'checkbox' })
    await repo.upsert<Task>('tasks', checkbox)

    await settlePomodoroSession(
      repo,
      session({ id: 'session-c', task_id: 'task-c', marked_task_complete: true }),
      { ...options, linkedTask: checkbox },
    )

    const tasks = await repo.list<Task>('tasks')
    expect(tasks[0].completed).toBe(true)
    expect(tasks[0].completed_at).toBe(NOW)
  })

  it('marks a standalone todo complete with completed_at = nowIso', async () => {
    const { repo } = open(newName())
    const todo = dailyTodo({ id: 'todo-s', task_id: null, completed: false })
    await repo.upsert<DailyTodo>('dailyTodos', todo)

    await settlePomodoroSession(
      repo,
      session({
        id: 'session-t',
        daily_todo_id: 'todo-s',
        marked_task_complete: true,
      }),
      { ...options, linkedTodo: todo },
    )

    const todos = await repo.list<DailyTodo>('dailyTodos')
    expect(todos[0].completed).toBe(true)
    expect(todos[0].completed_at).toBe(NOW)
  })
})

describe('settlePomodoroSession — habit paths', () => {
  it('writes one completion at habitCompletionId and appends shared notes', async () => {
    const { repo } = open(newName())
    const linkedHabit = habit({ id: 'habit-1' })
    await repo.upsert<Habit>('habits', linkedHabit)
    await repo.upsert<HabitCompletion>(
      'habitCompletions',
      completion({ id: habitCompletionId('habit-1', DAY), note: '原有笔记' }),
    )

    await settlePomodoroSession(
      repo,
      session({
        id: 'session-h',
        habit_id: 'habit-1',
        notes: ['第一行', '不分享', '第三行'],
        shared_indices: [0, 2],
      }),
      options,
    )

    const rows = await repo.list<HabitCompletion>('habitCompletions')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(habitCompletionId('habit-1', DAY))
    expect(rows[0].habit_id).toBe('habit-1')
    expect(rows[0].date).toBe(DAY)
    // Existing content stays first; only indices 0 and 2 are appended.
    expect(rows[0].note).toBe('原有笔记\n第一行\n第三行')
    // The original tap time is preserved on a note-only merge.
    expect(rows[0].completed_at).toBe('2026-10-31T00:10:00.000Z')
  })

  it('revives a tombstoned completion with deleted_at null and the merged note', async () => {
    const { database, repo } = open(newName())
    const linkedHabit = habit({ id: 'habit-1' })
    await repo.upsert<Habit>('habits', linkedHabit)
    const id = habitCompletionId('habit-1', DAY)
    await repo.upsert<HabitCompletion>(
      'habitCompletions',
      completion({ id, note: '旧笔记' }),
    )
    await repo.softDelete('habitCompletions', id)

    await settlePomodoroSession(
      repo,
      session({
        id: 'session-revive',
        habit_id: 'habit-1',
        notes: ['新笔记'],
        shared_indices: [0],
      }),
      options,
    )

    const live = await repo.list<HabitCompletion>('habitCompletions')
    expect(live).toHaveLength(1)
    expect(live[0].deleted_at).toBeNull()
    expect(live[0].note).toBe('旧笔记\n新笔记')
    const all = await database.habitCompletions.where('id').equals(id).count()
    expect(all).toBe(1)
  })

  it('creates no completion row when no habit is linked', async () => {
    const { repo } = open(newName())
    const checkbox = task({ id: 'task-c' })
    await repo.upsert<Task>('tasks', checkbox)

    await settlePomodoroSession(
      repo,
      session({ id: 'session-nohabit', task_id: 'task-c' }),
      { ...options, linkedTask: checkbox },
    )

    const rows = await repo.list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    expect(rows).toHaveLength(0)
  })
})

describe('settlePomodoroSession — retry guard', () => {
  it('does not double-apply progress when called twice with the same id', async () => {
    const { repo } = open(newName())
    const quantity = task({
      id: 'task-q',
      progress_type: 'quantity',
      unit: '页',
      target_value: 100,
      current_value: 10,
    })
    await repo.upsert<Task>('tasks', quantity)
    const row = session({
      id: 'session-retry',
      task_id: 'task-q',
      progress_amount: 5,
    })

    await settlePomodoroSession(repo, row, { ...options, linkedTask: quantity })
    const first = await repo.list<Task>('tasks')
    expect(first[0].current_value).toBe(15)

    // The live session row is the commit marker: the second call returns early.
    await settlePomodoroSession(repo, row, { ...options, linkedTask: quantity })
    const second = await repo.list<Task>('tasks')
    expect(second[0].current_value).toBe(15)
    expect(await repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(1)
  })
})

describe('settlePomodoroSession — preconditions write nothing', () => {
  it('rejects a progress amount on a checkbox task and writes no session', async () => {
    const { repo } = open(newName())
    const checkbox = task({ id: 'task-c', progress_type: 'checkbox' })
    await repo.upsert<Task>('tasks', checkbox)

    await expect(
      settlePomodoroSession(
        repo,
        session({ id: 'bad-q', task_id: 'task-c', progress_amount: 5 }),
        { ...options, linkedTask: checkbox },
      ),
    ).rejects.toThrow()

    expect(await repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(0)
    const tasks = await repo.list<Task>('tasks')
    expect(tasks[0].completed).toBe(false)
    expect(tasks[0].current_value).toBeNull()
  })

  it('rejects when both task_id and daily_todo_id are set', async () => {
    const { repo } = open(newName())

    await expect(
      settlePomodoroSession(
        repo,
        session({ id: 'both', task_id: 'task-1', daily_todo_id: 'todo-1' }),
        options,
      ),
    ).rejects.toThrow()

    expect(await repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(0)
  })

  it('rejects a linked DailyTodo (task_id non-null) before any write', async () => {
    const { repo } = open(newName())
    const linked = dailyTodo({ id: 'todo-linked', task_id: 'task-1' })
    await repo.upsert<DailyTodo>('dailyTodos', linked)

    await expect(
      settlePomodoroSession(
        repo,
        session({ id: 'bad-todo', daily_todo_id: 'todo-linked' }),
        { ...options, linkedTodo: linked },
      ),
    ).rejects.toThrow()

    expect(await repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(0)
  })
})

describe('multi-task settlement (T8)', () => {
  it('applies per-task complete + progress in one settlement', async () => {
    const { repo } = open(newName())
    const checkbox = task({ id: 'task-c', progress_type: 'checkbox' })
    const quantity = task({
      id: 'task-q',
      progress_type: 'quantity',
      unit: '页',
      target_value: 100,
      current_value: 10,
    })
    await repo.upsert<Task>('tasks', checkbox)
    await repo.upsert<Task>('tasks', quantity)

    const row = session({ id: 'session-multi', task_ids: ['task-c', 'task-q'] })
    const result = await settlePomodoroSession(repo, row, {
      ...options,
      tasks: [
        { task: checkbox, complete: true, amount: null },
        { task: quantity, complete: false, amount: 15 },
      ],
    })

    expect(result).toBe(row)
    const tasks = await repo.list<Task>('tasks')
    expect(tasks.find((t) => t.id === 'task-c')?.completed).toBe(true)
    expect(tasks.find((t) => t.id === 'task-q')?.current_value).toBe(25)

    const sessions = await repo.list<PomodoroSession>('pomodoroSessions')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].task_ids).toEqual(['task-c', 'task-q'])
  })

  it('rejects a multi-task settlement that also links a todo', async () => {
    const { repo } = open(newName())
    const checkbox = task({ id: 'task-c', progress_type: 'checkbox' })
    const todo = dailyTodo({ id: 'todo-1' })
    await repo.upsert<Task>('tasks', checkbox)
    await repo.upsert<DailyTodo>('dailyTodos', todo)

    await expect(
      settlePomodoroSession(
        repo,
        session({ id: 'session-x', task_ids: ['task-c'] }),
        {
          ...options,
          tasks: [{ task: checkbox, complete: true, amount: null }],
          linkedTodo: todo,
        },
      ),
    ).rejects.toThrow(/任务与待办不能同时关联/)
  })
})
