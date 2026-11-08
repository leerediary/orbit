import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { addProgress } from '@/lib/task-progress'
import { settlePomodoroSession } from '@/lib/pomodoro-settlement'
import { dayKey } from '@/lib/today'
import type {
  Goal,
  Habit,
  HabitCompletion,
  Milestone,
  PomodoroSession,
  Task,
} from '@/lib/types'

/**
 * Phase 22 / 22-04 — trigger integration proofs.
 *
 * These cases drive the real primitives (`addProgress`, `settlePomodoroSession`)
 * through a fresh LocalRepository so the assertions cover the persisted habit
 * completion rather than a mock. They prove the two trigger seams required by
 * D-03/D-05:
 *  - `addProgress` fires the goal-inherited `progress` check-in, with the
 *    explicit note winning over the fallback event description
 *  - pomodoro settlement's checkbox path fires the `complete` check-in and its
 *    quantity path threads the session note through `addProgress`
 *
 * The day key is derived from the wall clock because `addProgress` has no
 * injectable clock; the suite pins TZ=UTC in vitest.config.ts.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-habit-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
const HABIT_ID = 'habit-1'

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'category-1',
    name: '读《原则》',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    habit_id: HABIT_ID,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-1',
    goal_id: 'goal-1',
    name: '第三章',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function quantityTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-q',
    milestone_id: 'milestone-1',
    goal_id: null,
    parent_id: null,
    name: '读第3章',
    progress_type: 'quantity',
    unit: '页',
    target_value: 200,
    current_value: 10,
    completed: false,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function checkboxTask(over: Partial<Task> = {}): Task {
  return quantityTask({
    id: 'task-c',
    name: '写代码',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    ...over,
  })
}

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: HABIT_ID,
    name: '阅读',
    short_name: '阅读',
    sort_order: 0,
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

/** Seed Goal(habit_id) → Milestone → quantity/checkbox Task + Habit. */
async function seed(
  repo: LocalRepository,
  overrides: { goalHabitId?: string | null } = {},
): Promise<void> {
  const habitId = 'goalHabitId' in overrides ? overrides.goalHabitId : HABIT_ID
  await repo.upsert<Goal>('goals', goal({ habit_id: habitId ?? null }))
  await repo.upsert<Milestone>('milestones', milestone())
  await repo.upsert<Task>('tasks', quantityTask())
  await repo.upsert<Task>('tasks', checkboxTask())
  await repo.upsert<Habit>('habits', habit())
}

async function allCompletions(repo: LocalRepository): Promise<HabitCompletion[]> {
  return repo.list<HabitCompletion>('habitCompletions', { includeDeleted: true })
}

describe('addProgress — D-03 quantity trigger', () => {
  it('creates one completion with the goal/milestone/task range description', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await addProgress('task-q', 20, undefined, repo)

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].habit_id).toBe(HABIT_ID)
    expect(rows[0].note).toBe('读《原则》, 第三章, 读第3章, 10-30页')
    expect(rows[0].deleted_at).toBeNull()
  })

  it('appends a distinct range line on a repeated increment and preserves completed_at', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await addProgress('task-q', 20, undefined, repo)
    const [first] = await allCompletions(repo)

    await addProgress('task-q', 20, undefined, repo)
    const rows = await allCompletions(repo)

    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('读《原则》, 第三章, 读第3章, 10-30页\n读《原则》, 第三章, 读第3章, 30-50页')
    expect(rows[0].completed_at).toBe(first.completed_at)
  })

  it('uses an explicit note instead of the event description (D-05 seam)', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await addProgress('task-q', 20, '番茄笔记', repo)

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('番茄笔记')
  })

  it('still returns and persists the task when the goal has no habit (no-op)', async () => {
    const { repo } = open(newName())
    await seed(repo, { goalHabitId: null })

    const updated = await addProgress('task-q', 20, undefined, repo)

    expect(updated.current_value).toBe(30)
    const tasks = await repo.list<Task>('tasks')
    expect(tasks.find((t) => t.id === 'task-q')?.current_value).toBe(30)
    expect(await allCompletions(repo)).toHaveLength(0)
  })
})

describe('settlePomodoroSession — D-03/D-05 goal-habit seam', () => {
  const settleOptions = (linkedTask: Task) => ({
    linkedTask,
    linkedTodo: null,
    offsetHours: 0,
    nowIso: NOW,
  })

  it('checks the goal habit on checkbox completion even when session.habit_id is null', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await settlePomodoroSession(
      repo,
      session({ id: 'session-c', task_id: 'task-c', marked_task_complete: true }),
      settleOptions(checkboxTask()),
    )

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      habit_id: HABIT_ID,
      date: dayKey(NOW, 0),
      note: '读《原则》, 第三章, 写代码',
      deleted_at: null,
    })
  })

  it('uses the session notes as the exact habit note for a checkbox session (D-05)', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await settlePomodoroSession(
      repo,
      session({
        id: 'session-c-notes',
        task_id: 'task-c',
        marked_task_complete: true,
        notes: ['专注写代码'],
        shared_indices: [],
      }),
      settleOptions(checkboxTask()),
    )

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('专注写代码')
  })

  it('threads the quantity session note through addProgress verbatim', async () => {
    const { repo } = open(newName())
    await seed(repo)

    const quantity = quantityTask()
    await settlePomodoroSession(
      repo,
      session({
        id: 'session-q-note',
        task_id: 'task-q',
        progress_amount: 15,
        notes: ['读完第3章'],
        shared_indices: [],
      }),
      settleOptions(quantity),
    )

    // The Goal-habit note is the session's exact text, not 推进《task》.
    const rows = (await allCompletions(repo)).filter((row) => row.habit_id === HABIT_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('读完第3章')
    expect(rows[0].note).not.toBe('读《原则》, 第三章, 读第3章, 10-25页')

    // Progress itself still applied.
    const tasks = await repo.list<Task>('tasks')
    expect(tasks.find((t) => t.id === 'task-q')?.current_value).toBe(25)
  })

  it('keeps the direct session.habit_id write while the goal-habit note is not duplicated', async () => {
    const { repo } = open(newName())
    await seed(repo)

    await settlePomodoroSession(
      repo,
      session({
        id: 'session-both',
        task_id: 'task-c',
        habit_id: HABIT_ID,
        marked_task_complete: true,
      }),
      settleOptions(checkboxTask()),
    )

    const rows = (await allCompletions(repo)).filter((row) => row.habit_id === HABIT_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('读《原则》, 第三章, 写代码')
  })

  it('does not duplicate the completion or note on a retried settlement', async () => {
    const { repo } = open(newName())
    await seed(repo)
    const linked = checkboxTask()
    const row = session({
      id: 'session-retry',
      task_id: 'task-c',
      marked_task_complete: true,
      notes: ['专注写代码'],
      shared_indices: [],
    })

    await settlePomodoroSession(repo, row, settleOptions(linked))
    await settlePomodoroSession(repo, row, settleOptions(linked))

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('专注写代码')
    expect(await repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(1)
  })
})
