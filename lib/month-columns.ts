/**
 * Pure monthly-overview derivation for habits (Phase 12, HABIT-04).
 *
 * Ported from diary-web's `deriveMonthColumns` idea, but kept pure and
 * deterministic: no React, no Dexie, no wall-clock reads. Callers pass the
 * already-loaded rows plus an explicit `today` day key.
 *
 *  - The CURRENT month (and any future month) lists exactly the live habits.
 *  - A PAST month lists the habits that actually have a completion in it, so an
 *    archived habit that was used still shows up while a habit that was never
 *    used (or was added later) does not.
 *
 * Day arithmetic uses local `Date` day counts, not UTC string slicing, so
 * month lengths (including leap February) are correct everywhere.
 */

import { sortHabits } from '@/lib/habit'
import type { Habit, HabitCompletion } from '@/lib/types'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Columns for the month grid.
 *
 * `useLiveColumns` is true for the current/future month: return the live habits
 * untouched. For a past month, derive columns from the habit ids that appear in
 * `completions` (tombstones are not filtered here — the caller passes rows it
 * wants counted) and order them with the same comparator as `sortHabits`.
 */
export function deriveMonthColumns(
  liveHabits: Habit[],
  allHabits: Habit[],
  completions: readonly Pick<HabitCompletion, 'habit_id'>[],
  useLiveColumns: boolean,
): Habit[] {
  if (useLiveColumns) return liveHabits

  const ids = new Set(completions.map((c) => c.habit_id))
  return sortHabits(allHabits.filter((h) => ids.has(h.id)))
}

/**
 * Every `YYYY-MM-DD` key in a month. `month` is 1-12.
 *
 * `new Date(year, month, 0)` is the last day of `month` in LOCAL terms, so the
 * leap-year rule comes straight from the platform and never depends on the
 * device zone (only the day count is read).
 */
export function monthDateKeys(year: number, month: number): string[] {
  const days = new Date(year, month, 0).getDate()
  const keys: string[] = []
  for (let day = 1; day <= days; day += 1) {
    keys.push(`${year}-${pad2(month)}-${pad2(day)}`)
  }
  return keys
}

export interface MonthStats {
  done: number
  past: number
  pct: number
}

/**
 * Done / elapsed / percentage for one month.
 *
 *   - past = days in the month <= today (current month), all days (past month),
 *     0 (future month)
 *   - done = month keys present in `doneDates`
 *   - pct  = round(min(done, past) / past * 100), 0 when past === 0
 *
 * The min() clamp (T-12-04) keeps a malformed/future completion from producing
 * a percentage above 100.
 */
export function monthStats(
  year: number,
  month: number,
  doneDates: ReadonlySet<string>,
  today: string,
): MonthStats {
  const keys = monthDateKeys(year, month)
  const [todayYear, todayMonth] = today.split('-').map(Number)

  let past: number
  const cmp = year * 12 + month - (todayYear * 12 + todayMonth)
  if (cmp === 0) {
    past = keys.filter((key) => key <= today).length
  } else if (cmp < 0) {
    past = keys.length
  } else {
    past = 0
  }

  let done = 0
  for (const key of keys) {
    if (doneDates.has(key)) done += 1
  }

  const pct = past === 0 ? 0 : Math.round((Math.min(done, past) / past) * 100)

  return { done, past, pct }
}
