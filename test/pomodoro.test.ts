import { describe, expect, it } from 'vitest'
import {
  CHERRY_MAX_SEC,
  MODE_RANGES,
  buildPomodoroSession,
  buildSharedIndices,
  buildTodayPomodoroRows,
  earlyFinishDurationSec,
  mergeHabitNote,
  pomodoroMode,
  remainingSec,
  resolveProgressAmount,
} from '@/lib/pomodoro'
import type { DailyTodo, Habit, PomodoroSession, Task } from '@/lib/types'

/**
 * Phase 13 / POMO-01 pure-helper contract.
 *
 *  - pomodoroMode derives the mode from duration_sec (< 16 min = 圣女果).
 *  - remainingSec is clamped to [0, durationSec] and floors elapsed seconds.
 *  - earlyFinishDurationSec rounds to the nearest minute, minimum one minute.
 */

describe('pomodoroMode', () => {
  it('treats anything under 16 minutes as cherry', () => {
    expect(pomodoroMode(959)).toBe('cherry')
  })

  it('treats 16 minutes or more as tomato', () => {
    expect(pomodoroMode(960)).toBe('tomato')
  })

  it('classifies the cherry range bounds as cherry', () => {
    expect(pomodoroMode(7 * 60)).toBe('cherry')
    expect(pomodoroMode(15 * 60)).toBe('cherry')
  })

  it('classifies the tomato range bounds as tomato', () => {
    expect(pomodoroMode(20 * 60)).toBe('tomato')
    expect(pomodoroMode(30 * 60)).toBe('tomato')
  })
})

describe('MODE_RANGES', () => {
  it('locks the diary-web mode bounds and defaults', () => {
    expect(CHERRY_MAX_SEC).toBe(960)
    expect(MODE_RANGES.tomato).toEqual({ min: 20, max: 30, default: 25, label: '番茄' })
    expect(MODE_RANGES.cherry).toEqual({ min: 7, max: 15, default: 10, label: '圣女果' })
  })
})

describe('remainingSec', () => {
  const started = 1_000_000

  it('equals the full duration at the start', () => {
    expect(remainingSec(started, 1500, started)).toBe(1500)
  })

  it('still equals the duration after 0.9 seconds elapsed', () => {
    expect(remainingSec(started, 1500, started + 900)).toBe(1500)
  })

  it('is 0 exactly at the duration boundary', () => {
    expect(remainingSec(started, 1500, started + 1500 * 1000)).toBe(0)
  })

  it('stays 0 beyond the duration', () => {
    expect(remainingSec(started, 1500, started + (1500 + 50) * 1000)).toBe(0)
  })

  it('never exceeds the duration when the clock runs backwards', () => {
    expect(remainingSec(started, 1500, started - 10_000)).toBe(1500)
  })

  it('floors partial elapsed seconds', () => {
    expect(remainingSec(started, 1500, started + 1.9 * 1000)).toBe(1499)
  })
})

describe('earlyFinishDurationSec', () => {
  it('never returns less than one minute', () => {
    expect(earlyFinishDurationSec(0)).toBe(60)
    expect(earlyFinishDurationSec(30)).toBe(60)
  })

  it('rounds to the nearest whole minute', () => {
    expect(earlyFinishDurationSec(61)).toBe(60)
    expect(earlyFinishDurationSec(90)).toBe(120)
    expect(earlyFinishDurationSec(150)).toBe(180)
  })
})

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

describe('buildSharedIndices', () => {
  it('returns an empty list when no habit is linked, even with true flags', () => {
    expect(buildSharedIndices(['笔记'], [true], false)).toEqual([])
  })

  it('returns every index when all flags are true', () => {
    expect(buildSharedIndices(['a', 'b'], [true, true], true)).toEqual([0, 1])
  })

  it('defaults a short flags array tail to shared', () => {
    expect(buildSharedIndices(['a', 'b', 'c'], [true], true)).toEqual([0, 1, 2])
  })

  it('excludes indices whose flag is false', () => {
    expect(buildSharedIndices(['a', 'b', 'c'], [true, false, true], true)).toEqual([0, 2])
  })

  it('ignores flags beyond the notes length', () => {
    expect(buildSharedIndices(['a'], [true, false, true], true)).toEqual([0])
  })

  it('returns an empty list for empty notes', () => {
    expect(buildSharedIndices([], [true], true)).toEqual([])
  })
})

describe('mergeHabitNote', () => {
  it('returns the joined addition when prior is null', () => {
    expect(mergeHabitNote(null, ['第一行', '第二行'])).toBe('第一行\n第二行')
  })

  it('returns the joined addition when prior is empty', () => {
    expect(mergeHabitNote('', ['第一行'])).toBe('第一行')
  })

  it('leaves an existing note unchanged when there is nothing to share', () => {
    expect(mergeHabitNote('原有笔记', [])).toBe('原有笔记')
  })

  it('preserves prior content before the appended addition', () => {
    expect(mergeHabitNote('原有笔记', ['新笔记'])).toBe('原有笔记\n新笔记')
  })

  it('returns prior unchanged for an empty shared array even when prior is null', () => {
    expect(mergeHabitNote(null, [])).toBeNull()
  })

  it('is idempotent when the same addition is merged twice', () => {
    const once = mergeHabitNote('原有笔记', ['新笔记'])
    expect(mergeHabitNote(once, ['新笔记'])).toBe(once)
  })

  it('treats a prior equal to the addition as already merged', () => {
    expect(mergeHabitNote('新笔记', ['新笔记'])).toBe('新笔记')
  })
})

describe('buildPomodoroSession', () => {
  it('maps camelCase input to the snake_case entity exactly', () => {
    const built = buildPomodoroSession({
      id: 'session-1',
      startedAt: '2026-10-31T01:00:00.000Z',
      durationSec: 1500,
      notes: ['第一行', '第二行'],
      habitId: 'habit-1',
      taskId: 'task-1',
      taskIds: ['task-1'],
      dailyTodoId: null,
      markedTaskComplete: true,
      progressAmount: 12,
      sharedIndices: [0, 1],
    })
    expect(built).toEqual({
      id: 'session-1',
      started_at: '2026-10-31T01:00:00.000Z',
      duration_sec: 1500,
      notes: ['第一行', '第二行'],
      habit_id: 'habit-1',
      task_id: 'task-1',
      task_ids: ['task-1'],
      daily_todo_id: null,
      marked_task_complete: true,
      progress_amount: 12,
      shared_indices: [0, 1],
      updated_at: '',
      deleted_at: null,
    })
  })

  it('copies notes and sharedIndices so the output does not alias the input', () => {
    const notes = ['第一行']
    const sharedIndices = [0]
    const built = buildPomodoroSession({
      id: 'session-1',
      startedAt: '2026-10-31T01:00:00.000Z',
      durationSec: 600,
      notes,
      habitId: null,
      taskId: null,
      taskIds: [],
      dailyTodoId: null,
      markedTaskComplete: false,
      progressAmount: null,
      sharedIndices,
    })
    expect(built.notes).not.toBe(notes)
    expect(built.shared_indices).not.toBe(sharedIndices)
    notes.push('后加')
    sharedIndices.push(1)
    expect(built.notes).toEqual(['第一行'])
    expect(built.shared_indices).toEqual([0])
  })

  it('passes null links and amounts through unchanged', () => {
    const built = buildPomodoroSession({
      id: 'session-1',
      startedAt: '2026-10-31T01:00:00.000Z',
      durationSec: 600,
      notes: [],
      habitId: null,
      taskId: null,
      taskIds: [],
      dailyTodoId: null,
      markedTaskComplete: false,
      progressAmount: null,
      sharedIndices: [],
    })
    expect(built.habit_id).toBeNull()
    expect(built.task_id).toBeNull()
    expect(built.daily_todo_id).toBeNull()
    expect(built.progress_amount).toBeNull()
    expect(built.notes).toEqual([])
    expect(built.shared_indices).toEqual([])
  })

  it('leaves timestamps for the repository to stamp', () => {
    const built = buildPomodoroSession({
      id: 'session-1',
      startedAt: '2026-10-31T01:00:00.000Z',
      durationSec: 600,
      notes: [],
      habitId: null,
      taskId: null,
      taskIds: [],
      dailyTodoId: null,
      markedTaskComplete: false,
      progressAmount: null,
      sharedIndices: [],
    })
    expect(built.updated_at).toBe('')
    expect(built.deleted_at).toBeNull()
  })
})

describe('buildTodayPomodoroRows', () => {
  it('includes today and excludes yesterday', () => {
    const rows = buildTodayPomodoroRows(
      [
        session({ id: 'today', started_at: '2026-10-31T01:00:00.000Z' }),
        session({ id: 'yesterday', started_at: '2026-10-30T23:30:00.000Z' }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows.map((r) => r.id)).toEqual(['today'])
  })

  it('applies offsetHours to the logical day boundary', () => {
    const lateNight = session({ id: 'late', started_at: '2026-10-31T01:00:00.000Z' })
    const rows = buildTodayPomodoroRows([lateNight], [], [], [], '2026-10-30', 2)
    expect(rows.map((r) => r.id)).toEqual(['late'])
    expect(buildTodayPomodoroRows([lateNight], [], [], [], '2026-10-31', 2)).toEqual([])
  })

  it('excludes tombstoned sessions', () => {
    const rows = buildTodayPomodoroRows(
      [session({ deleted_at: '2026-10-31T02:00:00.000Z' })],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows).toEqual([])
  })

  it('sorts rows ascending by started_at', () => {
    const rows = buildTodayPomodoroRows(
      [
        session({ id: 'late', started_at: '2026-10-31T05:00:00.000Z' }),
        session({ id: 'early', started_at: '2026-10-31T01:00:00.000Z' }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows.map((r) => r.id)).toEqual(['early', 'late'])
  })

  it('resolves a linked task name', () => {
    const rows = buildTodayPomodoroRows(
      [session({ task_id: 'task-1', marked_task_complete: true })],
      [task({ id: 'task-1', name: '写代码' })],
      [],
      [],
      '2026-10-31',
    )
    expect(rows[0]).toMatchObject({
      linkName: '写代码',
      linkKind: 'task',
      completed: true,
      secondaryLinkName: null,
    })
  })

  it('falls back when the linked task is missing', () => {
    const rows = buildTodayPomodoroRows(
      [session({ task_id: 'gone' })],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows[0].linkName).toBe('(已删除的任务)')
    expect(rows[0].linkKind).toBe('task')
  })

  it('resolves a daily todo and outranks a habit when both are present', () => {
    const rows = buildTodayPomodoroRows(
      [session({ daily_todo_id: 'todo-1', habit_id: 'habit-1' })],
      [],
      [dailyTodo({ id: 'todo-1', name: '买菜' })],
      [habit({ id: 'habit-1', name: '跑步' })],
      '2026-10-31',
    )
    expect(rows[0]).toMatchObject({
      linkName: '买菜',
      linkKind: 'todo',
      secondaryLinkName: '跑步',
    })
  })

  it('falls back for a missing daily todo', () => {
    const rows = buildTodayPomodoroRows(
      [session({ daily_todo_id: 'gone' })],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows[0].linkName).toBe('(已删除的待办)')
  })

  it('exposes the habit as secondaryLinkName when a task is also linked', () => {
    const rows = buildTodayPomodoroRows(
      [session({ task_id: 'task-1', habit_id: 'habit-1' })],
      [task({ id: 'task-1', name: '写代码' })],
      [],
      [habit({ id: 'habit-1', name: '跑步' })],
      '2026-10-31',
    )
    expect(rows[0]).toMatchObject({
      linkName: '写代码',
      linkKind: 'task',
      secondaryLinkName: '跑步',
    })
  })

  it('uses (已归档) when a linked habit is missing alongside a task', () => {
    const rows = buildTodayPomodoroRows(
      [session({ task_id: 'task-1', habit_id: 'gone' })],
      [task({ id: 'task-1', name: '写代码' })],
      [],
      [],
      '2026-10-31',
    )
    expect(rows[0].secondaryLinkName).toBe('(已归档)')
  })

  it('resolves a habit-only link and leaves secondaryLinkName null', () => {
    const rows = buildTodayPomodoroRows(
      [session({ habit_id: 'habit-1' })],
      [],
      [],
      [habit({ id: 'habit-1', name: '跑步' })],
      '2026-10-31',
    )
    expect(rows[0]).toMatchObject({
      linkName: '跑步',
      linkKind: 'habit',
      secondaryLinkName: null,
    })
  })

  it('derives durationMin and mode from duration_sec', () => {
    const rows = buildTodayPomodoroRows(
      [
        session({ id: 'cherry', started_at: '2026-10-31T01:00:00.000Z', duration_sec: 600 }),
        session({ id: 'tomato', started_at: '2026-10-31T02:00:00.000Z', duration_sec: 1500 }),
      ],
      [],
      [],
      [],
      '2026-10-31',
    )
    expect(rows[0]).toMatchObject({ durationMin: 10, mode: 'cherry' })
    expect(rows[1]).toMatchObject({ durationMin: 25, mode: 'tomato' })
  })

  it('copies notes so noteLines does not alias the input', () => {
    const notes = ['第一行', '第二行']
    const input = session({ notes })
    const rows = buildTodayPomodoroRows([input], [], [], [], '2026-10-31')
    expect(rows[0].noteLines).toEqual(notes)
    expect(rows[0].noteLines).not.toBe(notes)
    rows[0].noteLines.push('新行')
    expect(input.notes).toEqual(['第一行', '第二行'])
  })

  it('returns an empty array for no sessions', () => {
    expect(buildTodayPomodoroRows([], [], [], [], '2026-10-31')).toEqual([])
  })
})

describe('resolveProgressAmount (T6 本次增加量 / 本次到达)', () => {
  it('uses the increment input directly', () => {
    expect(resolveProgressAmount(100, '5', '')).toEqual({ amount: 5, error: null })
  })

  it('derives increment from the arrival input (arrival - start)', () => {
    expect(resolveProgressAmount(100, '', '105')).toEqual({ amount: 5, error: null })
  })

  it('prefers the increment input when both are filled', () => {
    expect(resolveProgressAmount(100, '7', '105')).toEqual({ amount: 7, error: null })
  })

  it('rejects a non-positive or non-incrementing value', () => {
    expect(resolveProgressAmount(100, '0', '')).toEqual({ amount: null, error: 'non_positive' })
    expect(resolveProgressAmount(100, '', '100')).toEqual({ amount: null, error: 'non_positive' })
    expect(resolveProgressAmount(100, '', '99')).toEqual({ amount: null, error: 'non_positive' })
  })

  it('rejects a non-integer', () => {
    expect(resolveProgressAmount(100, '1.5', '')).toEqual({ amount: null, error: 'invalid' })
  })

  it('treats empty input as no progress (valid)', () => {
    expect(resolveProgressAmount(100, '', '')).toEqual({ amount: null, error: null })
  })
})
