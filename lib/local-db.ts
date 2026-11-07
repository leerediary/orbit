import Dexie, { type Table } from 'dexie'
import type { Category, DailyTodo, Goal, Habit, HabitCompletion, JournalEntry, Milestone, PomodoroSession, Task } from '@/lib/types'
// Type-only imports: they are erased at runtime, so the schema module and the
// side-table modules never form a runtime import cycle.
import type { OutboxEntry } from '@/lib/outbox'
import type { SyncStateRow } from '@/lib/sync-store'
import {
  migrateLegacyRows,
  normalizeTaskV3,
  type LegacyGoal,
  type LegacyMilestone,
  type LegacyTask,
  type LegacyV2Task,
} from '@/lib/legacy-migration'

// Single-user Orbit store. Data volume is tiny (one person's goals), so we
// index only what IndexedDB can key on reliably and filter the rest in memory.
// NOTE: boolean `completed` is intentionally NOT indexed — IndexedDB cannot use
// boolean keys; filtering these in memory is correct and cheap at this scale.
//
// D-01: the four-level hierarchy is declared in ONE version(2). version(1) is
// kept so Dexie knows the previous schema and can run the in-place migration.

export class OrbitDB extends Dexie {
  categories!: Table<Category, string>
  goals!: Table<Goal, string>
  milestones!: Table<Milestone, string>
  tasks!: Table<Task, string>
  dailyTodos!: Table<DailyTodo, string>
  journalEntries!: Table<JournalEntry, string>
  habits!: Table<Habit, string>
  habitCompletions!: Table<HabitCompletion, string>
  pomodoroSessions!: Table<PomodoroSession, string>

  // v8 sync side tables — never part of EXPORT_ENTITIES / ALL_ENTITIES, so the
  // orbit-export v7 contract and every entity shape stay byte-identical.
  syncOutbox!: Table<OutboxEntry, number>
  syncState!: Table<SyncStateRow, string>

  constructor(name = 'orbit') {
    super(name)

    // v1 — three-level schema (Goal → Milestone → Task, plus Reviews). Kept as
    // the upgrade source; fresh installs skip straight to version(2).
    this.version(1).stores({
      goals: 'id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, goal_id, updated_at, created_at',
      reviews: 'id, goal_id, updated_at, created_at',
    })

    // v2 — four-level schema (Category → Goal → Milestone → Task). Dexie
    // MERGES store specs across versions, so a table is only dropped by
    // declaring it `null` here (omission would inherit the v1 spec). Setting
    // `reviews: null` drops the table and its rows after the upgrade.
    this.version(2)
      .stores({
        categories: 'id, updated_at, created_at',
        goals: 'id, category_id, updated_at, created_at',
        milestones: 'id, goal_id, updated_at, created_at',
        tasks: 'id, milestone_id, updated_at, created_at',
        reviews: null,
      })
      .upgrade(async (tx) => {
        // READ EVERYTHING FIRST: goals/milestones/tasks persist across versions,
        // so clearing before reading would lose the legacy source rows.
        const goals = await tx.table<LegacyGoal, string>('goals').toArray()
        const milestones = await tx.table<LegacyMilestone, string>('milestones').toArray()
        const tasks = await tx.table<LegacyTask, string>('tasks').toArray()

        const next = migrateLegacyRows({ goals, milestones, tasks })

        await tx.table('goals').clear()
        await tx.table('milestones').clear()
        await tx.table('tasks').clear()

        // bulkPut (NOT repository.upsert): preserves id/updated_at/deleted_at
        // verbatim. upsert would regenerate ids and re-stamp timestamps.
        await tx.table('categories').bulkPut(next.categories)
        await tx.table('goals').bulkPut(next.goals)
        await tx.table('milestones').bulkPut(next.milestones)
        // `tasks` is intentionally left empty: the new leaf level starts empty.
        // Any throw here aborts the versionchange transaction → stays at v1.
      })

    // v3 — flexible leaf tasks (Phase 8, D-05). Indexes are unchanged; this
    // upgrade only default-fills the new fields on existing v2 rows in place.
    // READ FIRST, then bulkPut (never clear / upsert): identity, updated_at and
    // tombstones must survive byte-for-byte (T-08-01/T-08-02). Any throw aborts
    // the versionchange transaction and rolls back to v2.
    this.version(3)
      .stores({
        categories: 'id, updated_at, created_at',
        goals: 'id, category_id, updated_at, created_at',
        milestones: 'id, goal_id, updated_at, created_at',
        tasks: 'id, milestone_id, updated_at, created_at',
      })
      .upgrade(async (tx) => {
        const rows = await tx.table<LegacyV2Task, string>('tasks').toArray()
        // Fresh installs / already-empty task stores have nothing to fill.
        if (rows.length === 0) return
        await tx.table('tasks').bulkPut(rows.map(normalizeTaskV3))
      })

    // v4 — daily layer (Phase 9, D-01). A brand-new store is a PURE schema diff:
    // Dexie folds store specs across versions cumulatively, so repeating the four
    // existing specs is a no-op and the new store is created empty. There is
    // intentionally NO .upgrade() callback — no existing row is read or rewritten
    // (T-09-02).
    this.version(4).stores({
      categories: 'id, updated_at, created_at',
      goals: 'id, category_id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, milestone_id, updated_at, created_at',
      // added_at is not indexed: ordering happens in memory at this scale.
      dailyTodos: 'id, task_id, updated_at',
    })

    // v5 — daily layer / journal (Phase 10, D-01). Same pure-additive shape as
    // v4: a brand-new store is a schema diff, so re-declaring the five existing
    // specs is a no-op and the journal store is created empty. There is
    // intentionally NO .upgrade() callback — no existing row is read or
    // rewritten. The `&` prefix makes day_key a UNIQUE index, so at most one
    // journal row can exist per logical local day (T-10-01).
    this.version(5).stores({
      categories: 'id, updated_at, created_at',
      goals: 'id, category_id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, milestone_id, updated_at, created_at',
      dailyTodos: 'id, task_id, updated_at',
      journalEntries: 'id, &day_key, updated_at',
    })

    // v6 — daily layer / habits (Phase 12, HABIT-01/02). Same pure-additive shape
    // as v4/v5: two brand-new stores are a schema diff, so re-declaring the six
    // existing specs is a no-op and both habit stores are created empty. There is
    // intentionally NO .upgrade() callback — no existing row is read or rewritten.
    // The `[habit_id+date]` index is NON-unique: live-only uniqueness is owned by
    // validateHabitCompletionRelations so tombstones may keep duplicating a live
    // natural key (RESEARCH A4).
    this.version(6).stores({
      categories: 'id, updated_at, created_at',
      goals: 'id, category_id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, milestone_id, updated_at, created_at',
      dailyTodos: 'id, task_id, updated_at',
      journalEntries: 'id, &day_key, updated_at',
      habits: 'id, sort_order, updated_at',
      habitCompletions: 'id, [habit_id+date], date, updated_at',
    })

    // v7 — daily layer / pomodoro (Phase 13, POMODORO-01). Same pure-additive
    // shape as v4/v5/v6: a brand-new store is a schema diff, so re-declaring the
    // eight existing specs is a no-op and pomodoroSessions is created empty.
    // There is intentionally NO .upgrade() callback — no existing row is read or
    // rewritten. `started_at` is indexed for day/range filtering; the array
    // fields notes/shared_indices are intentionally NOT indexed (IndexedDB
    // cannot key on arrays and the table is tiny).
    this.version(7).stores({
      categories: 'id, updated_at, created_at',
      goals: 'id, category_id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, milestone_id, updated_at, created_at',
      dailyTodos: 'id, task_id, updated_at',
      journalEntries: 'id, &day_key, updated_at',
      habits: 'id, sort_order, updated_at',
      habitCompletions: 'id, [habit_id+date], date, updated_at',
      pomodoroSessions: 'id, started_at, updated_at',
    })

    // v8 — sync engine side tables (Phase 18, SYNC-01). Same pure-additive shape
    // as v4–v7: two brand-new stores are a schema diff, so re-declaring the nine
    // existing specs is a no-op and both side stores are created empty. There is
    // intentionally NO .upgrade() callback — no existing row is read or rewritten,
    // and the entity tables (and therefore orbit-export v7) are untouched.
    //   syncOutbox — durable change queue. `++seq` is the auto-increment primary
    //   key that gives a stable drain order; entity/row_id/op are indexed for
    //   coalescing and targeted acknowledgement.
    //   syncState — small key/value store for the pull cursor, last-synced time,
    //   and engine status (e.g. needs-full-reconcile).
    this.version(8).stores({
      categories: 'id, updated_at, created_at',
      goals: 'id, category_id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, milestone_id, updated_at, created_at',
      dailyTodos: 'id, task_id, updated_at',
      journalEntries: 'id, &day_key, updated_at',
      habits: 'id, sort_order, updated_at',
      habitCompletions: 'id, [habit_id+date], date, updated_at',
      pomodoroSessions: 'id, started_at, updated_at',
      syncOutbox: '++seq, entity, row_id, op, updated_at',
      syncState: 'key',
    })
  }
}

// Constructing OrbitDB does NOT open IndexedDB — Dexie auto-opens lazily on the
// first table operation. So this module-scope instance is safe to import during
// Node build-time prerender. INVARIANT: never run a query at module scope or
// during render — only inside client effects/handlers (browser has IndexedDB;
// the prerender pass does not). Do not add an eager db.open() here.
export const db = new OrbitDB()
