// Phase 13 / POMO-01..04 — pure pomodoro derivations.
//
// No React, no Dexie, no browser globals: every helper takes explicit inputs
// (timestamps, today, offsets) so the timer, settlement, and today-list all rest
// on one deterministic rule set that the UI cannot drift from. Mirrors the
// diary-web semantics distilled in 13-RESEARCH.md Pattern 1.

import { dayKey } from '@/lib/today'
import type { DailyTodo, Habit, PomodoroSession, Task } from '@/lib/types'

/** Below this many seconds a session is 圣女果 (cherry); at or above it is 番茄. */
export const CHERRY_MAX_SEC = 16 * 60

/** Mode is derived from duration_sec — it is never stored (D-02). */
export type PomodoroMode = 'tomato' | 'cherry'

/** Per-mode duration bounds in minutes (UI step/wheel clamps + defaults). */
export const MODE_RANGES = {
  tomato: { min: 20, max: 30, default: 25, label: '番茄' },
  cherry: { min: 7, max: 15, default: 10, label: '圣女果' },
} as const

/** Classify a session from its actual duration; < 16 min is 圣女果. */
export function pomodoroMode(durationSec: number): PomodoroMode {
  return durationSec < CHERRY_MAX_SEC ? 'cherry' : 'tomato'
}

/**
 * Whole seconds left, clamped to [0, durationSec].
 *
 * Elapsed is floored to whole seconds, so a sub-second tick never shaves a
 * second early. A clock that runs backwards (nowMs < startedAtMs) can never
 * report more than the original duration.
 */
export function remainingSec(startedAtMs: number, durationSec: number, nowMs: number): number {
  const elapsed = Math.floor((nowMs - startedAtMs) / 1000)
  return Math.min(durationSec, Math.max(0, durationSec - elapsed))
}

/**
 * Persisted duration for an early finish: elapsed rounded to the nearest whole
 * minute, never less than one minute (D-02).
 */
export function earlyFinishDurationSec(elapsedSec: number): number {
  return Math.max(1, Math.round(elapsedSec / 60)) * 60
}

/**
 * Align per-note "share to habit" flags with the notes array and emit the shared
 * indices (RESEARCH Pitfall 7 / T-13-05).
 *
 * - No linked habit → [] (nothing to share, regardless of flags).
 * - A shorter flags array defaults the missing tail to shared (a newly added note
 *   is shared by default, matching diary-web).
 * - A longer flags array is ignored; only indices < notes.length are produced, so
 *   no out-of-range index can reach settlement.
 */
export function buildSharedIndices(
  notes: readonly string[],
  flags: readonly boolean[],
  habitLinked: boolean,
): number[] {
  if (!habitLinked) return []
  const out: number[] = []
  for (let i = 0; i < notes.length; i++) {
    if (flags[i] ?? true) out.push(i)
  }
  return out
}

/**
 * Merge newly shared notes into a habit's existing note (RESEARCH Pitfall 10).
 *
 * Prior content stays first, the new lines are appended with `\n` (same format as
 * HabitCompletion.note). Idempotent: if the addition is already the whole prior
 * value or its trailing block, the prior is returned unchanged, so a retried
 * settlement cannot duplicate notes.
 */
export function mergeHabitNote(
  prior: string | null,
  sharedNotes: readonly string[],
): string | null {
  if (sharedNotes.length === 0) return prior
  const addition = sharedNotes.join('\n')
  if (prior == null || prior === '') return addition
  if (prior === addition || prior.endsWith(`\n${addition}`)) return prior
  return `${prior}\n${addition}`
}

/** Every value needed to assemble a PomodoroSession, in camelCase. */
export interface BuildPomodoroSessionInput {
  id: string
  startedAt: string
  durationSec: number
  notes: readonly string[]
  habitId: string | null
  taskId: string | null
  /** All linked task ids (multi-task, Phase 24+). taskId is the legacy single. */
  taskIds: readonly string[]
  dailyTodoId: string | null
  markedTaskComplete: boolean
  progressAmount: number | null
  sharedIndices: readonly number[]
}

/**
 * Assemble a PomodoroSession row from view state (UI-SPEC §6 / Data Contract).
 *
 * PURE: no id generation and no clock reads — the caller passes a frozen id and
 * start snapshot. `notes` / `sharedIndices` are copied so later draft mutations
 * cannot alias the persisted row. `updated_at` is left empty and `deleted_at`
 * explicit null so the repository stamps the former and treats the row as live.
 */
export function buildPomodoroSession(input: BuildPomodoroSessionInput): PomodoroSession {
  return {
    id: input.id,
    started_at: input.startedAt,
    duration_sec: input.durationSec,
    notes: [...input.notes],
    habit_id: input.habitId,
    task_id: input.taskId,
    task_ids: [...input.taskIds],
    daily_todo_id: input.dailyTodoId,
    marked_task_complete: input.markedTaskComplete,
    progress_amount: input.progressAmount,
    shared_indices: [...input.sharedIndices],
    updated_at: '',
    deleted_at: null,
  }
}

/** One rendered row of the 今日番茄 card (UI-SPEC §7). */
export interface TodayPomodoroRow {
  id: string
  /** HH:MM in the device-local time zone. */
  time: string
  durationMin: number
  mode: PomodoroMode
  linkName: string | null
  linkKind: 'task' | 'todo' | 'habit' | null
  /**
   * The linked habit's name when a task/todo AND a habit are both associated, so
   * the "task + habit" core scenario stays visible; otherwise null.
   */
  secondaryLinkName: string | null
  completed: boolean
  noteLines: string[]
}

const DELETED_TASK = '(已删除的任务)'
const DELETED_TODO = '(已删除的待办)'
const ARCHIVED_HABIT = '(已归档)'

/**
 * Build the 今日番茄 rows: today's live sessions, oldest first, with link names
 * resolved task → todo → habit (RESEARCH Pitfall 8 / buildTodayPomodoroRows).
 *
 * `today` and `offsetHours` are passed in so this never reads the wall clock;
 * dayKey applies the same logical-day boundary as the rest of the daily layer.
 */
export function buildTodayPomodoroRows(
  sessions: readonly PomodoroSession[],
  tasks: readonly Task[],
  dailyTodos: readonly DailyTodo[],
  habits: readonly Habit[],
  today: string,
  offsetHours = 0,
): TodayPomodoroRow[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const todoById = new Map(dailyTodos.map((t) => [t.id, t]))
  const habitById = new Map(habits.map((h) => [h.id, h]))

  return sessions
    .filter((s) => s.deleted_at == null && dayKey(s.started_at, offsetHours) === today)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((s) => {
      let linkName: string | null = null
      let linkKind: TodayPomodoroRow['linkKind'] = null

      if (s.task_id) {
        linkName = taskById.get(s.task_id)?.name ?? DELETED_TASK
        linkKind = 'task'
      } else if (s.daily_todo_id) {
        linkName = todoById.get(s.daily_todo_id)?.name ?? DELETED_TODO
        linkKind = 'todo'
      } else if (s.habit_id) {
        linkName = habitById.get(s.habit_id)?.name ?? ARCHIVED_HABIT
        linkKind = 'habit'
      }

      const secondaryLinkName =
        (s.task_id || s.daily_todo_id) && s.habit_id
          ? (habitById.get(s.habit_id)?.name ?? ARCHIVED_HABIT)
          : null

      return {
        id: s.id,
        time: new Date(s.started_at).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        durationMin: Math.round(s.duration_sec / 60),
        mode: pomodoroMode(s.duration_sec),
        linkName,
        linkKind,
        secondaryLinkName,
        completed: s.marked_task_complete,
        noteLines: [...s.notes],
      }
    })
}

/** Validation result for a quantity-task progress input. */
export interface ResolveProgressResult {
  amount: number | null
  error: 'invalid' | 'non_positive' | null
}

/**
 * Resolve the settlement increment (progress_amount) from the 结算 sheet's two
 * mutually-exclusive inputs. The 增加量 input takes precedence when filled;
 * otherwise the 到达 input is converted via `arrival - startValue`. Empty input
 * means "no progress" (amount null, no error) — settlement still completes.
 */
export function resolveProgressAmount(
  startValue: number,
  incrementText: string,
  arrivalText: string,
): ResolveProgressResult {
  const inc = incrementText.trim()
  if (inc !== '') {
    const n = Number(inc)
    if (!Number.isSafeInteger(n)) return { amount: null, error: 'invalid' }
    if (n <= 0) return { amount: null, error: 'non_positive' }
    return { amount: n, error: null }
  }
  const arr = arrivalText.trim()
  if (arr !== '') {
    const n = Number(arr)
    if (!Number.isSafeInteger(n)) return { amount: null, error: 'invalid' }
    if (n <= startValue) return { amount: null, error: 'non_positive' }
    return { amount: n - startValue, error: null }
  }
  return { amount: null, error: null }
}
