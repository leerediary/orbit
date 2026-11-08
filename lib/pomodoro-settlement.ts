// Phase 13 / POMO-03 — deterministic pomodoro settlement.
//
// Repository-injected on purpose: the write order is the risky part of this
// feature (D-04 / UI-SPEC §6), so it lives in a pure-from-React helper the
// integration tests can drive with a real LocalRepository. The view only
// resolves the linked rows and calls this once per summary.
//
// Phase 24+ multi-task (T8): a session may link several tasks. The per-task
// completion/progress is passed in `options.tasks`; the legacy single-task
// `linkedTask` + `session.progress_amount` / `marked_task_complete` is kept and
// normalized into the same loop so old callers and rows keep working.

import { habitCompletionId } from '@/lib/habit'
import { autoCheckinForTask } from '@/lib/habit-auto-checkin'
import { dayKey } from '@/lib/today'
import { mergeHabitNote } from '@/lib/pomodoro'
import { addProgress } from '@/lib/task-progress'
import type { Repository } from '@/lib/repository'
import type {
  DailyTodo,
  Habit,
  HabitCompletion,
  PomodoroSession,
  Task,
} from '@/lib/types'

/** One linked task's settlement decision. */
export interface TaskSettlement {
  /** The live linked task. */
  task: Task
  /** Mark the (checkbox) task complete this session. */
  complete: boolean
  /** Quantity increment; null = no progress. */
  amount: number | null
}

export interface SettlePomodoroOptions {
  /** The live task resolved from the loaded today arrays, or null (legacy). */
  linkedTask: Task | null
  /** Multi-task settlements; when set, drives the per-task operations. */
  tasks?: TaskSettlement[]
  /** The live standalone DailyTodo resolved from the loaded today arrays, or null. */
  linkedTodo: DailyTodo | null
  /** DAY_OFFSET hours used by dayKey for the habit's completion date. */
  offsetHours: number
  /** Commit instant stamped on completion rows and used for new completions. */
  nowIso: string
}

/**
 * Persist one finished session and every linked side effect.
 *
 * Order (UI-SPEC §6 / T-13-17):
 *   1. Retry guard — a live row with the same id means the session is already
 *      settled, so return without writing (no double progress).
 *   2. Validate EVERY precondition before any write.
 *   3. Re-runnable side effects first (habit check-in, checkbox/todo completion),
 *      then the non-idempotent `addProgress`, then the session row LAST as the
 *      commit marker. A retry therefore only double-applies progress if the
 *      process dies between addProgress and the session write (accepted risk).
 *
 * The habit is idempotent because it targets `habitCompletionId(habit_id, date)`
 * and merges notes through `mergeHabitNote`; the explicit `deleted_at: null`
 * revives a tombstoned completion (Pitfall 10).
 */
export async function settlePomodoroSession(
  repo: Repository,
  session: PomodoroSession,
  options: SettlePomodoroOptions,
): Promise<PomodoroSession> {
  // 1. Retry guard: the session row is written last, so its presence proves the
  //    whole settlement completed. A tombstoned row does not count.
  const sessions = await repo.list<PomodoroSession>('pomodoroSessions', {
    includeDeleted: true,
  })
  if (sessions.some((row) => row.id === session.id && row.deleted_at == null)) {
    return session
  }

  const { linkedTodo } = options

  // Normalize the linked tasks into one uniform array: the explicit multi-task
  // list when provided, otherwise the legacy single link derived from the
  // session's single-task fields.
  let tasks: TaskSettlement[]
  if (options.tasks) {
    tasks = options.tasks
  } else if (options.linkedTask != null) {
    tasks = [
      {
        task: options.linkedTask,
        complete: session.marked_task_complete,
        amount: session.progress_amount,
      },
    ]
  } else if (session.task_id != null) {
    throw new Error('关联任务不存在或已删除')
  } else {
    tasks = []
  }

  // 2. Validate everything before the first write.
  if (tasks.length > 0 && linkedTodo != null) {
    throw new Error('任务与待办不能同时关联')
  }

  for (const entry of tasks) {
    const task = entry.task
    if (task.deleted_at != null) {
      throw new Error('关联任务不存在或已删除')
    }
    if (entry.amount != null) {
      if ((task.progress_type ?? 'checkbox') !== 'quantity') {
        throw new Error('该任务不是数量型任务，无法推进进度')
      }
      if (!Number.isFinite(entry.amount) || entry.amount <= 0) {
        throw new Error('本次推进量必须大于 0')
      }
    }
    if (entry.complete && (task.progress_type ?? 'checkbox') !== 'checkbox') {
      throw new Error('数量型任务不能直接标记完成')
    }
  }

  if (linkedTodo != null) {
    if (linkedTodo.deleted_at != null) {
      throw new Error('关联待办不存在或已删除')
    }
    // T-13-18: a linked DailyTodo owns no completion boolean of its own.
    if (linkedTodo.task_id !== null) {
      throw new Error('该待办关联了长期任务，不能作为独立待办结算')
    }
  }
  // A todo-only session must not carry a progress amount (legacy tamper guard).
  if (linkedTodo != null && tasks.length === 0 && session.progress_amount != null) {
    throw new Error('独立待办不支持数量进度')
  }

  if (session.habit_id != null) {
    const habits = await repo.list<Habit>('habits')
    const habit = habits.find(
      (row) => row.id === session.habit_id && row.deleted_at == null,
    )
    if (!habit) throw new Error('关联习惯不存在或已删除')
  }

  // D-05 note source, computed once and reused by 3a and the goal-habit seams.
  const sharedNotes = session.notes.filter((_, index) =>
    session.shared_indices.includes(index),
  )
  const sessionNotes =
    sharedNotes.length > 0
      ? sharedNotes
      : session.habit_id == null
        ? session.notes.filter((note) => note.trim() !== '')
        : []
  const sessionNote = mergeHabitNote(null, sessionNotes)

  // 3a. Habit check-in first — merging and tombstone revival are idempotent.
  if (session.habit_id != null) {
    const date = dayKey(session.started_at, options.offsetHours)
    const id = habitCompletionId(session.habit_id, date)
    const completions = await repo.list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    const existing = completions.find((row) => row.id === id) ?? null
    const note = mergeHabitNote(existing?.note ?? null, sharedNotes)
    await repo.upsert<HabitCompletion>('habitCompletions', {
      id,
      habit_id: session.habit_id,
      date,
      note,
      completed_at: existing?.completed_at ?? options.nowIso,
      // Explicit null: LocalRepository.upsert preserves an omitted tombstone.
      deleted_at: null,
    })
  }

  // 3b. Per-task settlement: checkbox completion (idempotent) then the
  //     non-idempotent quantity progress. Each goal-inherited habit check-in is
  //     best-effort (a habit failure must not abort settlement).
  for (const entry of tasks) {
    const task = entry.task
    if (entry.complete && (task.progress_type ?? 'checkbox') === 'checkbox') {
      await repo.upsert<Task>('tasks', {
        ...task,
        completed: true,
        completed_at: options.nowIso,
      })
      try {
        await autoCheckinForTask({
          task,
          kind: 'complete',
          note: sessionNote,
          nowIso: options.nowIso,
          offsetHours: options.offsetHours,
          repo,
        })
      } catch {
        // best effort: settlement must not fail on a habit write
      }
    }
    if (entry.amount != null) {
      await addProgress(task.id, entry.amount, sessionNote ?? undefined, repo)
    }
  }

  // 3c. Standalone todo completion (idempotent).
  if (
    session.daily_todo_id != null &&
    session.marked_task_complete &&
    linkedTodo
  ) {
    await repo.upsert<DailyTodo>('dailyTodos', {
      ...linkedTodo,
      completed: true,
      completed_at: options.nowIso,
    })
  }

  // 4. Commit marker LAST: the retry guard depends on this row existing only
  //    after every side effect above has been applied.
  await repo.upsert<PomodoroSession>('pomodoroSessions', session)

  return session
}
