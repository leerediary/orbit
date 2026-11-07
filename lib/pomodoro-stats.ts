// Phase 14 / STATS-01..02 — pure pomodoro statistics derivations.
//
// No React, no Dexie, no browser globals, and no wall-clock reads: the caller
// always passes `today` and `offsetHours`. This mirrors the Phase 13
// rule that every tested unit stays deterministic and import-testable, so the
// statistics chart and history list cannot drift from the dayKey boundary the
// rest of the daily layer uses (D-04 / D-05).

import { dayDiff, dayKey } from '@/lib/today'
import { buildTodayPomodoroRows, type TodayPomodoroRow } from '@/lib/pomodoro'
import type { DailyTodo, Habit, PomodoroSession, Task } from '@/lib/types'

/** One X-axis point of the focus-count chart. */
export interface ChartPoint {
  /** 'MM-DD' for display on the X axis */
  date: string
  /** Live sessions whose started_at falls on this local logical day */
  daily: number
  /** Running total of `daily` inside the returned window (never all-time) */
  cumul: number
}

/** One day's slice of the recent history list. */
export interface PomodoroHistoryGroup {
  /** 'YYYY-MM-DD' logical local day */
  date: string
  /** 今天 / 昨天 / MM-DD */
  label: string
  /** That day's rows, ordered oldest session first */
  rows: TodayPomodoroRow[]
}

/** The history list shows the most recent week (D-05). */
export const HISTORY_DAYS = 7

/**
 * Build the focus-count chart series.
 *
 * Returns one point per day in [today - days + 1, today], ending on `today`.
 * `daily` buckets each live session by its LOCAL logical day
 * (`dayKey(started_at, offsetHours)`), never a UTC slice, so a near-midnight
 * session lands on the same day the rest of the app calls "today". `cumul` is
 * the prefix sum across ONLY the enumerated window, so a session outside the
 * window never contributes.
 *
 * `days` must be a positive integer; anything else yields [] without throwing.
 */
export function buildPomodoroChartData(
  sessions: readonly PomodoroSession[],
  days: number,
  today: string,
  offsetHours = 0,
): ChartPoint[] {
  if (!Number.isInteger(days) || days < 1) return []

  const countMap = new Map<string, number>()
  for (const s of sessions) {
    if (!s.started_at || s.deleted_at != null) continue
    const key = dayKey(s.started_at, offsetHours)
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }

  const points: ChartPoint[] = []
  let cumul = 0
  const end = parseYmd(today)
  // UTC-midnight arithmetic means a DST transition can never shift a bucket.
  for (let i = days - 1; i >= 0; i--) {
    const cur = new Date(end.getTime())
    cur.setUTCDate(end.getUTCDate() - i)
    const iso = formatYmd(cur)
    const daily = countMap.get(iso) ?? 0
    cumul += daily
    points.push({ date: iso.slice(5), daily, cumul }) // 'MM-DD'
  }
  return points
}

/** Relative label for a history group: 今天 / 昨天 / MM-DD. */
export function formatPomodoroHistoryLabel(date: string, today: string): string {
  if (date === today) return '今天'
  if (dayDiff(date, today) === 1) return '昨天'
  return date.slice(5)
}

/**
 * Build the recent-history groups: the last `days` logical days that have live
 * sessions, newest day first, each group's rows oldest session first (D-05).
 *
 * Link names are resolved by reusing `buildTodayPomodoroRows` per day, so the
 * task → dailyTodo → habit precedence, deleted/archived fallbacks, HH:MM
 * formatting, and habit secondary name all stay in the Phase 13 helper — this
 * module defines no fallback strings of its own.
 */
export function buildPomodoroHistoryGroups(
  sessions: readonly PomodoroSession[],
  tasks: readonly Task[],
  dailyTodos: readonly DailyTodo[],
  habits: readonly Habit[],
  today: string,
  offsetHours = 0,
  days = HISTORY_DAYS,
): PomodoroHistoryGroup[] {
  if (!Number.isInteger(days) || days < 1) return []

  const end = parseYmd(today)
  const startDate = new Date(end.getTime())
  startDate.setUTCDate(end.getUTCDate() - (days - 1))
  const start = formatYmd(startDate)

  const liveSessions: PomodoroSession[] = []
  const dayKeys = new Set<string>()
  for (const s of sessions) {
    if (!s.started_at || s.deleted_at != null) continue
    const key = dayKey(s.started_at, offsetHours)
    // 'YYYY-MM-DD' strings compare lexicographically == chronologically.
    if (key < start || key > today) continue
    liveSessions.push(s)
    dayKeys.add(key)
  }

  const orderedDays = [...dayKeys].sort((a, b) => b.localeCompare(a))

  const groups: PomodoroHistoryGroup[] = []
  for (const day of orderedDays) {
    const rows = buildTodayPomodoroRows(liveSessions, tasks, dailyTodos, habits, day, offsetHours)
    if (rows.length === 0) continue
    groups.push({ date: day, label: formatPomodoroHistoryLabel(day, today), rows })
  }
  return groups
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
