/**
 * Pure habit helpers for the daily check-in layer (Phase 12, HABIT-01/02/05).
 *
 * No React, no Dexie, no wall-clock reads. Everything here is a deterministic
 * computation over persisted rows and an explicit day key, so the risky rules
 * (completion identity, display order, short-name defaults, today's checked
 * set) are unit-testable without a browser.
 *
 * `lib/goal-order.ts` is intentionally NOT reused: it orders by `created_at`,
 * which `Habit` does not carry. Habits order by `sort_order` → `updated_at` → `id`
 * (RESEARCH A7 / diary-web parity).
 */

import type { Habit, HabitCompletion } from '@/lib/types'

/**
 * Deterministic completion row id for a (habit, day) pair.
 *
 * Checking and unchecking the same box therefore target the SAME persisted row
 * instead of accumulating duplicates, and a re-check can reuse a tombstoned row
 * by id rather than inserting a new one.
 */
export function habitCompletionId(habitId: string, date: string): string {
  return `habit-${habitId}-${date}`
}

/**
 * Ascending habit display order: `sort_order`, then `updated_at`, then `id`.
 *
 * Deterministic under ties and non-mutating — returns a new array. Structural so
 * it accepts `Habit` without importing React/Dexie.
 */
export function sortHabits<
  T extends { sort_order: number; updated_at: string; id: string },
>(habits: readonly T[]): T[] {
  return [...habits].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

/**
 * The `sort_order` for a habit appended after every existing row.
 *
 * Returns 1 for an empty list. Callers pass tombstone-inclusive rows so a new
 * habit never collides with an archived habit that could later be restored.
 */
export function nextHabitSortOrder(habits: readonly { sort_order: number }[]): number {
  if (habits.length === 0) return 1
  return Math.max(...habits.map((h) => h.sort_order)) + 1
}

/**
 * Default compact label for the month-overview column header.
 *
 * Trims surrounding whitespace and returns the first two Unicode CODE POINTS
 * (`Array.from`, so surrogate pairs/emoji count as one) — empty input yields ''.
 */
export function defaultShortName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return ''
  return Array.from(trimmed).slice(0, 2).join('')
}

export interface HabitDayState {
  habits: Habit[]
  completedIds: string[]
  notes: Record<string, string>
}

/**
 * Today's slice of the habit layer for one logical day.
 *
 * Live habits sorted by `sortHabits`; `completedIds` and `notes` derive ONLY
 * from live completions whose `date` matches the requested day. A null note
 * becomes '' so the UI never renders "null" and blank notes round-trip.
 */
export function buildHabitDayState(
  habits: Habit[],
  completions: HabitCompletion[],
  date: string,
): HabitDayState {
  const live = completions.filter((c) => c.deleted_at == null && c.date === date)
  const completedIds = live.map((c) => c.habit_id)
  const notes: Record<string, string> = {}
  for (const c of live) notes[c.habit_id] = c.note ?? ''

  return {
    habits: sortHabits(habits.filter((h) => h.deleted_at == null)),
    completedIds,
    notes,
  }
}
