import { describe, expect, it } from 'vitest'
import {
  HISTORY_DAYS,
  buildPomodoroChartData,
  buildPomodoroHistoryGroups,
  formatPomodoroHistoryLabel,
} from '@/lib/pomodoro-stats'
import type { DailyTodo, Habit, PomodoroSession, Task } from '@/lib/types'

/**
 * Phase 14 / STATS-01..02 pure-derivation contract.
 *
 *  - buildPomodoroChartData buckets by the local logical day (dayKey + offset),
 *    returns exactly `days` points ending on `today`, and accumulates `cumul`
 *    only inside the returned window.
 *  - buildPomodoroHistoryGroups returns the last 7 logical days newest-first,
 *    rows ascending inside each group, reusing the Phase 13 link resolution.
 *
 * vitest.config.ts pins TZ=UTC, so toLocaleTimeString('zh-CN', ...) is
 * deterministic for the explicit ISO instants used below.
 */

const UPDATED = '2026-01-02T00:00:00.000Z'

function task(overrides: Partial<Task> = {}): Task {
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
    created_at: '2026-01-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

function dailyTodo(overrides: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'todo-1',
    task_id: null,
    name: '买菜',
    completed: false,
    completed_at: null,
    added_at: '2026-10-31T00:30:00.000Z',
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

function session(overrides: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 'session-1',
    started_at: '2026-10-31T01:00:00.000Z',
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
    ...overrides,
  }
}

describe('HISTORY_DAYS', () => {
  it('locks the history window to one week', () => {
    expect(HISTORY_DAYS).toBe(7)
  })
})

describe('buildPomodoroChartData', () => {
  it('returns exactly `days` consecutive points ending on today', () => {
    const points = buildPomodoroChartData([], 7, '2026-10-31', 0)
    expect(points).toHaveLength(7)
    expect(points.map((p) => p.date)).toEqual([
      '10-25',
      '10-26',
      '10-27',
      '10-28',
      '10-29',
      '10-30',
      '10-31',
    ])
    expect(points.at(-1)).toMatchObject({ date: '10-31', daily: 0, cumul: 0 })
  })

  it('buckets a near-midnight session by the local logical day, not a UTC slice', () => {
    const points = buildPomodoroChartData(
      [session({ started_at: '2026-10-30T23:30:00.000Z' })],
      2,
      '2026-10-31',
      4,
    )
    expect(points.map((p) => p.date)).toEqual(['10-30', '10-31'])
    expect(points[0].daily).toBe(1)
    expect(points[1].daily).toBe(0)
  })

  it('applies offsetHours when the instant is before the day boundary', () => {
    const beforeBoundary = [session({ started_at: '2026-10-31T01:00:00.000Z' })]
    // 01:00Z with a 04:00 day boundary belongs to the previous logical day.
    const shifted = buildPomodoroChartData(beforeBoundary, 2, '2026-10-30', 4)
    expect(shifted.map((p) => p.date)).toEqual(['10-29', '10-30'])
    expect(shifted[1].daily).toBe(1)
    // With no offset the same instant is 10-31, outside the 10-29..10-30 window.
    const unshifted = buildPomodoroChartData(beforeBoundary, 2, '2026-10-30', 0)
    expect(unshifted.map((p) => p.daily)).toEqual([0, 0])
  })

  it('counts live sessions per day and accumulates cumul inside the window', () => {
    const points = buildPomodoroChartData(
      [
        session({ id: 'a', started_at: '2026-10-29T10:00:00.000Z' }),
        session({ id: 'b', started_at: '2026-10-31T10:00:00.000Z' }),
        session({ id: 'c', started_at: '2026-10-31T11:00:00.000Z' }),
      ],
      3,
      '2026-10-31',
      0,
    )
    expect(points.map((p) => p.daily)).toEqual([1, 0, 2])
    expect(points.map((p) => p.cumul)).toEqual([1, 1, 3])
  })

  it('ignores sessions outside the window and tombstoned rows', () => {
    const points = buildPomodoroChartData(
      [
        // Window for 7 days ending 10-31 starts on 10-25.
        session({ id: 'old', started_at: '2026-10-24T12:00:00.000Z' }),
        session({
          id: 'dead',
          started_at: '2026-10-31T12:00:00.000Z',
          deleted_at: '2026-10-31T13:00:00.000Z',
        }),
      ],
      7,
      '2026-10-31',
      0,
    )
    expect(points).toHaveLength(7)
    expect(points.every((p) => p.daily === 0)).toBe(true)
    expect(points.every((p) => p.cumul === 0)).toBe(true)
  })

  it('returns [] for non-positive or non-integer days', () => {
    expect(buildPomodoroChartData([], 0, '2026-10-31')).toEqual([])
    expect(buildPomodoroChartData([], -3, '2026-10-31')).toEqual([])
    expect(buildPomodoroChartData([], 1.5, '2026-10-31')).toEqual([])
    expect(buildPomodoroChartData([], Number.NaN, '2026-10-31')).toEqual([])
  })
})

describe('formatPomodoroHistoryLabel', () => {
  it('labels today as 今天', () => {
    expect(formatPomodoroHistoryLabel('2026-10-31', '2026-10-31')).toBe('今天')
  })

  it('labels yesterday as 昨天', () => {
    expect(formatPomodoroHistoryLabel('2026-10-30', '2026-10-31')).toBe('昨天')
  })

  it('labels older days as MM-DD', () => {
    expect(formatPomodoroHistoryLabel('2026-10-28', '2026-10-31')).toBe('10-28')
    expect(formatPomodoroHistoryLabel('2026-09-05', '2026-10-31')).toBe('09-05')
  })
})

describe('buildPomodoroHistoryGroups', () => {
  it('returns only the last 7 logical days, newest first, rows oldest first', () => {
    const groups = buildPomodoroHistoryGroups(
      [
        session({ id: 'late', started_at: '2026-10-31T05:00:00.000Z' }),
        session({ id: 'early', started_at: '2026-10-31T01:00:00.000Z' }),
        session({ id: 'yesterday', started_at: '2026-10-30T12:00:00.000Z' }),
        // Window for 7 days ending 10-31 starts on 10-25 → 10-23 is excluded.
        session({ id: 'old', started_at: '2026-10-23T12:00:00.000Z' }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.date)).toEqual(['2026-10-31', '2026-10-30'])
    expect(groups[0].rows.map((r) => r.id)).toEqual(['early', 'late'])
    expect(groups[0].rows.map((r) => r.time)).toEqual(['01:00', '05:00'])
    expect(groups[1].rows.map((r) => r.id)).toEqual(['yesterday'])
  })

  it('labels groups 今天 / 昨天 / MM-DD', () => {
    const groups = buildPomodoroHistoryGroups(
      [
        session({ id: 'today', started_at: '2026-10-31T01:00:00.000Z' }),
        session({ id: 'yesterday', started_at: '2026-10-30T01:00:00.000Z' }),
        session({ id: 'older', started_at: '2026-10-28T01:00:00.000Z' }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '10-28'])
  })

  it('skips days that produce no rows', () => {
    const groups = buildPomodoroHistoryGroups(
      [
        session({ id: 'today', started_at: '2026-10-31T01:00:00.000Z' }),
        session({ id: 'older', started_at: '2026-10-27T01:00:00.000Z' }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(groups.map((g) => g.date)).toEqual(['2026-10-31', '2026-10-27'])
  })

  it('reuses the Phase 13 link resolution and habit secondary name', () => {
    const groups = buildPomodoroHistoryGroups(
      [
        session({
          id: 'task-linked',
          started_at: '2026-10-31T01:00:00.000Z',
          task_id: 'task-1',
          habit_id: 'habit-1',
        }),
        session({
          id: 'todo-linked',
          started_at: '2026-10-31T02:00:00.000Z',
          daily_todo_id: 'todo-1',
        }),
        session({
          id: 'habit-only',
          started_at: '2026-10-31T03:00:00.000Z',
          habit_id: 'habit-1',
        }),
        session({
          id: 'missing-task',
          started_at: '2026-10-31T04:00:00.000Z',
          task_id: 'gone',
        }),
      ],
      [task({ id: 'task-1', name: '写代码' })],
      [dailyTodo({ id: 'todo-1', name: '买菜' })],
      [habit({ id: 'habit-1', name: '跑步' })],
      '2026-10-31',
    )
    const rows = groups[0].rows
    expect(rows.map((r) => r.linkName)).toEqual([
      '写代码',
      '买菜',
      '跑步',
      '(已删除的任务)',
    ])
    expect(rows.map((r) => r.linkKind)).toEqual(['task', 'todo', 'habit', 'task'])
    expect(rows[0].secondaryLinkName).toBe('跑步')
    expect(rows[1].secondaryLinkName).toBeNull()
  })

  it('preserves note lines in order and excludes tombstones', () => {
    const groups = buildPomodoroHistoryGroups(
      [
        session({
          id: 'live',
          started_at: '2026-10-31T01:00:00.000Z',
          notes: ['第一行', '第二行'],
        }),
        session({
          id: 'dead',
          started_at: '2026-10-31T02:00:00.000Z',
          deleted_at: '2026-10-31T03:00:00.000Z',
        }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].rows).toHaveLength(1)
    expect(groups[0].rows[0].id).toBe('live')
    expect(groups[0].rows[0].noteLines).toEqual(['第一行', '第二行'])
  })

  it('returns [] for non-positive or non-integer days', () => {
    expect(buildPomodoroHistoryGroups([], [], [], [], '2026-10-31', 0, 0)).toEqual([])
    expect(buildPomodoroHistoryGroups([], [], [], [], '2026-10-31', 0, 2.5)).toEqual([])
  })
})
