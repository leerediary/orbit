import { describe, expect, it } from 'vitest'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'
import type { OrbitBridge } from '@/lib/sqlite-bridge'
import type { DailyTodo, Goal, Habit, HabitCompletion, JournalEntry, PomodoroSession, Task } from '@/lib/types'
import { ENTITY_COLUMNS } from '@/lib/entity-schema'

/**
 * CR-02 guard: column names never come from the caller. Every key must pass
 * the per-entity allowlist before it can appear in SQL, and values are always
 * bound as parameters.
 */

interface Statement {
  sql: string
  params: unknown[]
}

function fakeBridge(): { bridge: OrbitBridge; statements: Statement[] } {
  const statements: Statement[] = []
  const bridge: OrbitBridge = {
    async execute(sql, params) {
      statements.push({ sql, params })
    },
    async query<T>() {
      return [] as T[]
    },
  }
  return { bridge, statements }
}

const validGoal: Goal = {
  id: 'goal-1',
  category_id: 'category-1',
  name: 'Ship Orbit',
  sort_order: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const validTask: Task = {
  id: 'task-1',
  milestone_id: 'milestone-1',
  goal_id: null,
  parent_id: null,
  name: 'First task',
  progress_type: 'checkbox',
  completed: false,
  completed_at: null,
  unit: null,
  target_value: null,
  current_value: null,
  created_at: '2026-01-02T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-02T00:00:00.000Z',
  deleted_at: null,
}

const validHabit: Habit = {
  id: 'habit-1',
  name: '每天跑步',
  short_name: '跑步',
  sort_order: 0,
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const validCompletion: HabitCompletion = {
  id: 'completion-1',
  habit_id: 'habit-1',
  date: '2026-01-01',
  note: null,
  completed_at: '2026-01-01T08:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const validPomodoroSession: PomodoroSession = {
  id: 'session-1',
  started_at: '2026-01-01T08:00:00.000Z',
  duration_sec: 1500,
  notes: ['第一行', '第二行'],
  habit_id: 'habit-1',
  task_id: 'task-1',
  daily_todo_id: null,
  marked_task_complete: true,
  progress_amount: null,
  shared_indices: [0, 1],
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

function inserts(statements: Statement[]): Statement[] {
  return statements.filter((s) => s.sql.includes('INSERT OR REPLACE'))
}

describe('SqliteLocalRepository column allowlist', () => {
  // Declared FIRST so the module-level cached `schemaReady` promise has not
  // resolved yet: this call emits the CREATE TABLE statements and can assert
  // the v3 tasks DDL directly.
  it('creates the v3 tasks table with nullable scope columns and progress_type', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    await repo.list<Task>('tasks')

    const ddl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS tasks'))
    expect(ddl).toBeDefined()
    expect(ddl).toContain('milestone_id TEXT,')
    expect(ddl).toContain('goal_id TEXT,')
    expect(ddl).toContain('parent_id TEXT,')
    expect(ddl).toContain("progress_type TEXT NOT NULL DEFAULT 'checkbox'")
    expect(ddl).toContain('unit TEXT')
    expect(ddl).toContain('target_value REAL')
    expect(ddl).toContain('current_value REAL')
    expect(ddl).not.toMatch(/milestone_id TEXT NOT NULL/)

    // Daily layer DDL: `completed` is nullable (null = linked row), and
    // `added_at` must never be nullable.
    const dailyDdl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS dailyTodos'))
    expect(dailyDdl).toBeDefined()
    expect(dailyDdl).toContain('task_id TEXT')
    expect(dailyDdl).toContain('completed INTEGER')
    expect(dailyDdl).toContain('added_at TEXT NOT NULL')
    expect(dailyDdl).not.toContain('completed INTEGER NOT NULL')

    // Journal DDL: day_key is UNIQUE (one row per logical local day) and
    // content is NOT NULL (an empty day is stored as '', never deleted).
    const journalDdl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS journalEntries'))
    expect(journalDdl).toBeDefined()
    expect(journalDdl).toContain('day_key TEXT NOT NULL UNIQUE')
    expect(journalDdl).toContain('content TEXT NOT NULL')

    // Habits DDL: column order mirrors SHAPES.habits; sort_order is NOT NULL.
    const habitsDdl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS habits'))
    expect(habitsDdl).toBeDefined()
    expect(habitsDdl).toContain('name TEXT NOT NULL')
    expect(habitsDdl).toContain('short_name TEXT NOT NULL')
    expect(habitsDdl).toContain('sort_order INTEGER NOT NULL')
    expect(habitsDdl).toContain('deleted_at TEXT')

    // Completions DDL: note is nullable, completed_at is NOT NULL, and there is
    // NO UNIQUE(habit_id, date) — live-only uniqueness is validator-owned (A4).
    const completionsDdl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS habitCompletions'))
    expect(completionsDdl).toBeDefined()
    expect(completionsDdl).toContain('habit_id TEXT NOT NULL')
    expect(completionsDdl).toContain('date TEXT NOT NULL')
    expect(completionsDdl).toContain('note TEXT')
    expect(completionsDdl).toContain('completed_at TEXT NOT NULL')
    expect(completionsDdl).not.toContain('UNIQUE')

    // Pomodoro DDL: every SHAPES key is present, arrays are TEXT NOT NULL, and
    // marked_task_complete is an INTEGER NOT NULL.
    const pomodoroDdl = statements
      .map((s) => s.sql)
      .find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS pomodoroSessions'))
    expect(pomodoroDdl).toBeDefined()
    for (const column of ENTITY_COLUMNS.pomodoroSessions) {
      expect(pomodoroDdl).toContain(`${column} `)
    }
    expect(pomodoroDdl).toContain('notes TEXT NOT NULL')
    expect(pomodoroDdl).toContain('shared_indices TEXT NOT NULL')
    expect(pomodoroDdl).toContain('marked_task_complete INTEGER NOT NULL')
    expect(pomodoroDdl).toContain('started_at TEXT NOT NULL')
    expect(pomodoroDdl).toContain('duration_sec INTEGER NOT NULL')
    expect(pomodoroDdl).toContain('progress_amount REAL')

    // The five habit-layer indexes are created.
    const indexSql = statements.map((s) => s.sql).join('\n')
    expect(indexSql).toContain('habits_sort_order')
    expect(indexSql).toContain('habits_updated_at')
    expect(indexSql).toContain('habitCompletions_habit_id_date')
    expect(indexSql).toContain('habitCompletions_date')
    expect(indexSql).toContain('habitCompletions_updated_at')
    // Both pomodoro indexes are created.
    expect(indexSql).toContain('pomodoroSessions_started_at')
    expect(indexSql).toContain('pomodoroSessions_updated_at')
  })

  it('deserializes v3 task defaults from a raw SQLite row', async () => {
    const raw = {
      id: 'task-1',
      milestone_id: 'm1',
      name: 'Raw',
      completed: 1,
      completed_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      sort_order: 1,
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }
    const bridge: OrbitBridge = {
      async execute() {},
      async query<T>() {
        return [raw] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    const [task] = await repo.list<Task>('tasks')
    expect(task.completed).toBe(true)
    expect(task.goal_id).toBeNull()
    expect(task.parent_id).toBeNull()
    expect(task.progress_type).toBe('checkbox')
    expect(task.unit).toBeNull()
    expect(task.target_value).toBeNull()
    expect(task.current_value).toBeNull()
  })

  it('deserializes dailyTodos keeping nullable completion and defaulting missing columns', async () => {
    const linkedRaw = {
      id: 'daily-linked',
      task_id: 'task-1',
      name: null,
      completed: null,
      completed_at: null,
      added_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }
    const standaloneRaw = {
      id: 'daily-standalone',
      task_id: null,
      name: '买牛奶',
      completed: 1,
      completed_at: '2026-01-03T00:00:00.000Z',
      added_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }
    // A raw row that omits the nullable columns entirely.
    const missingRaw = {
      id: 'daily-missing',
      completed: 0,
      added_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute() {},
      async query<T>() {
        return [linkedRaw, standaloneRaw, missingRaw] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    const rows = await repo.list<DailyTodo>('dailyTodos')
    const byId = new Map(rows.map((r) => [r.id, r] as const))
    // SQLite NULL stays JS null — a linked row never carries a second completion.
    expect(byId.get('daily-linked')!.completed).toBeNull()
    expect(byId.get('daily-linked')!.name).toBeNull()
    // 0/1 deserializes to a real boolean.
    expect(byId.get('daily-standalone')!.completed).toBe(true)
    expect(byId.get('daily-missing')!.completed).toBe(false)
    expect(byId.get('daily-missing')!.task_id).toBeNull()
    expect(byId.get('daily-missing')!.name).toBeNull()
    expect(byId.get('daily-missing')!.completed_at).toBeNull()
  })

  it('deserializes journalEntries defaulting a missing content column to empty string', async () => {
    // A row with no `content` and no `deleted_at` columns at all.
    const raw = {
      id: 'journal-2026-10-30',
      day_key: '2026-10-30',
      updated_at: '2026-10-30T08:00:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute() {},
      async query<T>() {
        return [raw] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    const [entry] = await repo.list<JournalEntry>('journalEntries')
    expect(entry.content).toBe('')
    expect(entry.deleted_at).toBeNull()
    expect(entry.day_key).toBe('2026-10-30')
  })

  it('deserializes habitCompletions defaulting an absent note to null', async () => {
    // A raw row with no `note` and no `deleted_at` columns at all.
    const raw = {
      id: 'completion-1',
      habit_id: 'habit-1',
      date: '2026-01-01',
      completed_at: '2026-01-01T08:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute() {},
      async query<T>() {
        return [raw] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    const [completion] = await repo.list<HabitCompletion>('habitCompletions')
    expect(completion.note).toBeNull()
    expect(completion.deleted_at).toBeNull()
    expect(completion.completed_at).toBe('2026-01-01T08:00:00.000Z')
  })

  it('accepts every allowlisted column for both habit tables', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const habit: Habit = {
      id: 'habit-1',
      name: '每天跑步',
      short_name: '跑步',
      sort_order: 0,
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }
    const completion: HabitCompletion = {
      id: 'completion-1',
      habit_id: 'habit-1',
      date: '2026-01-01',
      note: null,
      completed_at: '2026-01-01T08:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }

    // Every key in each row is a SHAPES key, so the allowlist must accept them.
    expect(Object.keys(habit).sort()).toEqual([...ENTITY_COLUMNS.habits].sort())
    expect(Object.keys(completion).sort()).toEqual([...ENTITY_COLUMNS.habitCompletions].sort())

    await repo.bulkLoadAll([
      ['habits', [habit]],
      ['habitCompletions', [completion]],
    ])
    expect(inserts(statements)).toHaveLength(2)
  })

  it('rejects an unknown key on the habit tables', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const craftedHabit = { ...validHabit, 'name) VALUES (1); --': 'x' }
    const craftedCompletion = { ...validCompletion, 'note) VALUES (1); --': 'x' }

    await expect(repo.bulkLoadAll([['habits', [craftedHabit]]])).rejects.toThrow(
      /unknown column/,
    )
    await expect(repo.bulkLoadAll([['habitCompletions', [craftedCompletion]]])).rejects.toThrow(
      /unknown column/,
    )
    expect(inserts(statements)).toHaveLength(0)
  })

  it('deserializes pomodoroSessions parsing JSON arrays and coercing the boolean', async () => {
    const rawOne = {
      id: 'session-1',
      started_at: '2026-10-31T08:00:00.000Z',
      duration_sec: 1500,
      notes: '["第一行","第二行"]',
      habit_id: 'habit-1',
      task_id: null,
      daily_todo_id: null,
      marked_task_complete: 1,
      progress_amount: null,
      shared_indices: '[0]',
      updated_at: '2026-10-31T08:25:00.000Z',
      deleted_at: null,
    }
    // A raw row omitting the array columns and carrying marked_task_complete 0.
    const rawMissing = {
      id: 'session-2',
      started_at: '2026-10-31T09:00:00.000Z',
      duration_sec: 600,
      marked_task_complete: 0,
      updated_at: '2026-10-31T09:10:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute() {},
      async query<T>() {
        return [rawOne, rawMissing] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    const rows = await repo.list<PomodoroSession>('pomodoroSessions')
    const byId = new Map(rows.map((r) => [r.id, r] as const))

    const one = byId.get('session-1')!
    expect(one.notes).toEqual(['第一行', '第二行'])
    expect(one.shared_indices).toEqual([0])
    expect(one.marked_task_complete).toBe(true)
    expect(one.habit_id).toBe('habit-1')
    expect(one.task_id).toBeNull()
    expect(one.daily_todo_id).toBeNull()
    expect(one.progress_amount).toBeNull()

    const missing = byId.get('session-2')!
    expect(missing.notes).toEqual([])
    expect(missing.shared_indices).toEqual([])
    expect(missing.marked_task_complete).toBe(false)
    expect(missing.deleted_at).toBeNull()
  })

  it('accepts every allowlisted pomodoro column and serializes arrays as JSON', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    expect(Object.keys(validPomodoroSession).sort()).toEqual(
      [...ENTITY_COLUMNS.pomodoroSessions].sort(),
    )

    await repo.bulkLoadAll([['pomodoroSessions', [validPomodoroSession]]])
    const [insert] = inserts(statements)
    const columns = insert.sql
      .slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')'))
      .split(', ')
    expect(insert.params[columns.indexOf('notes')]).toBe(
      JSON.stringify(validPomodoroSession.notes),
    )
    expect(insert.params[columns.indexOf('shared_indices')]).toBe(
      JSON.stringify(validPomodoroSession.shared_indices),
    )
    expect(insert.params[columns.indexOf('marked_task_complete')]).toBe(1)
  })

  it('rejects an unknown key on pomodoroSessions instead of interpolating it', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = { ...validPomodoroSession, 'notes) VALUES (1); --': 'x' }

    await expect(repo.bulkLoadAll([['pomodoroSessions', [crafted]]])).rejects.toThrow(
      /unknown column/,
    )
    expect(inserts(statements)).toHaveLength(0)
  })

  it('rejects an unknown key instead of interpolating it into SQL', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = {
      id: 'goal-1',
      category_id: 'category-1',
      name: 'x',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
      'name) VALUES (1); DROP TABLE goals; --': 'boom',
    } as unknown as Goal

    await expect(repo.upsert<Goal>('goals', crafted)).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
  })

  it('rolls back bulkLoadAll when a row carries an unknown key', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = { ...validTask, 'milestone_id) VALUES (1); --': 'x' }

    await expect(repo.bulkLoadAll([['tasks', [crafted]]])).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
    expect(statements.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('preserves an existing tombstone and merges omitted columns on upsert', async () => {
    const statements: Statement[] = []
    const existing = {
      id: 'goal-1',
      category_id: 'category-existing',
      name: 'Original',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-06-01T00:00:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute(sql, params) {
        statements.push({ sql, params })
      },
      async query<T>() {
        return [existing] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    await repo.upsert<Goal>('goals', { id: 'goal-1', name: 'Renamed' } as unknown as Goal)

    const [insert] = inserts(statements)
    const columns = insert.sql
      .slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')'))
      .split(', ')
    expect(insert.params[columns.indexOf('name')]).toBe('Renamed')
    expect(insert.params[columns.indexOf('category_id')]).toBe('category-existing')
    expect(insert.params[columns.indexOf('deleted_at')]).toBe(existing.deleted_at)
  })

  it('binds every allowlisted value as a parameter', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    await repo.bulkLoadAll([
      ['goals', [validGoal]],
      ['tasks', [validTask]],
    ])

    const [goalInsert, taskInsert] = inserts(statements)
    expect(goalInsert.sql).toBe(
      'INSERT OR REPLACE INTO goals (id, category_id, name, sort_order, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    expect(goalInsert.params).toEqual([
      validGoal.id,
      validGoal.category_id,
      validGoal.name,
      validGoal.sort_order,
      validGoal.created_at,
      validGoal.updated_at,
      validGoal.deleted_at,
    ])
    expect(taskInsert.sql).toBe(
      'INSERT OR REPLACE INTO tasks (id, milestone_id, goal_id, parent_id, name, progress_type, completed, completed_at, unit, target_value, current_value, created_at, sort_order, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    // completed serializes to 0/1, never interpolated.
    expect(taskInsert.sql).not.toContain('false')
    const taskColumns = taskInsert.sql
      .slice(taskInsert.sql.indexOf('(') + 1, taskInsert.sql.indexOf(')'))
      .split(', ')
    expect(taskInsert.params[taskColumns.indexOf('progress_type')]).toBe('checkbox')
    expect(taskInsert.params[taskColumns.indexOf('completed')]).toBe(0)
  })

  // Appended after the existing tests so the module-level cached `schemaReady`
  // promise is already resolved: ensureSchema() emits no CREATE TABLE before
  // BEGIN, and the statement sequence can be asserted from BEGIN onward.
  it('replaceAll clears all nine tables before inserting, in one transaction', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    await repo.replaceAll([['tasks', [validTask]]])

    const beginAt = statements.findIndex((s) => s.sql === 'BEGIN')
    expect(beginAt).toBeGreaterThanOrEqual(0)

    const sequence = statements.slice(beginAt)
    expect(sequence.map((s) => s.sql)).toEqual([
      'BEGIN',
      'DELETE FROM categories',
      'DELETE FROM goals',
      'DELETE FROM milestones',
      'DELETE FROM tasks',
      'DELETE FROM dailyTodos',
      'DELETE FROM journalEntries',
      'DELETE FROM habits',
      'DELETE FROM habitCompletions',
      'DELETE FROM pomodoroSessions',
      expect.stringMatching(/^INSERT OR REPLACE INTO tasks \(/),
      'COMMIT',
    ])
  })

  it('rolls back replaceAll when a row carries an unknown column, after the clears', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = { ...validTask, 'milestone_id) VALUES (1); --': 'x' }

    await expect(repo.replaceAll([['tasks', [crafted]]])).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
    expect(statements.at(-1)?.sql).toBe('ROLLBACK')
  })
})
