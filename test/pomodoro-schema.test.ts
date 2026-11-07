import { describe, expect, it } from 'vitest'
import {
  validateImportRow,
  validateImportRows,
  validatePomodoroSessionRelations,
} from '@/lib/entity-schema'
import type { PomodoroSession } from '@/lib/types'

/**
 * Phase 13 / T-13-01: the pomodoro layer's shape + cross-row invariants. Pure
 * (no IndexedDB) — a hand-edited backup must be rejected BEFORE any write.
 *
 * `notes` / `shared_indices` are the first ARRAY columns in the schema, so the
 * per-row validator must reject non-arrays and wrong element types; the
 * relation validator owns XOR, completion-target, progress-range and
 * shared-index invariants.
 */

const STARTED = '2026-10-31T08:00:00.000Z'
const UPDATED = '2026-10-31T08:25:00.000Z'

function session(overrides: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 'session-1',
    started_at: STARTED,
    duration_sec: 1500,
    notes: ['第一行', '第二行'],
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

describe('validateImportRow for pomodoroSessions', () => {
  it('accepts a fully valid live row', () => {
    expect(() => validateImportRow('pomodoroSessions', session(), 0)).not.toThrow()
  })

  it('accepts a valid tombstoned row', () => {
    expect(() =>
      validateImportRow(
        'pomodoroSessions',
        session({ deleted_at: '2026-10-31T09:00:00.000Z' }),
        0,
      ),
    ).not.toThrow()
  })

  it('rejects an unknown field', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), injected_column: 'x' }, 0),
    ).toThrow(/未知字段/)
  })

  it('accepts a legacy row without task_ids', () => {
    expect(() => validateImportRow('pomodoroSessions', session(), 0)).not.toThrow()
  })

  it('accepts a row with task_ids (import-only multi-task field)', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), task_ids: ['t1', 't2'] }, 0),
    ).not.toThrow()
  })

  it('rejects task_ids that is not a string array', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), task_ids: 't1' }, 0),
    ).toThrow(/task_ids 必须是字符串数组/)
  })

  it('rejects notes that is not an array', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), notes: '一段字符串' }, 0),
    ).toThrow(/notes 必须是字符串数组/)
  })

  it('rejects notes containing a non-string element', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), notes: ['ok', 42] }, 0),
    ).toThrow(/notes 必须是字符串数组/)
  })

  it('rejects shared_indices that is not an array', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), shared_indices: '[0]' }, 0),
    ).toThrow(/shared_indices 必须是数字数组/)
  })

  it('rejects shared_indices containing a non-number element', () => {
    expect(() =>
      validateImportRow('pomodoroSessions', { ...session(), shared_indices: ['0'] }, 0),
    ).toThrow(/shared_indices 必须是数字数组/)
  })

  it('rejects a missing notes key', () => {
    const { notes: _notes, ...withoutNotes } = session()
    expect(() => validateImportRow('pomodoroSessions', withoutNotes, 0)).toThrow(/缺少字段/)
  })

  it('rejects a missing shared_indices key', () => {
    const { shared_indices: _shared, ...withoutShared } = session()
    expect(() => validateImportRow('pomodoroSessions', withoutShared, 0)).toThrow(/缺少字段/)
  })
})

describe('validatePomodoroSessionRelations', () => {
  it('is a no-op for an empty array', () => {
    expect(() => validatePomodoroSessionRelations([])).not.toThrow()
  })

  it('rejects a session linking both a task and a daily todo', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ task_id: 'task-1', daily_todo_id: 'todo-1' }),
      ]),
    ).toThrow(/不能同时关联任务和独立待办/)
  })

  it('accepts a session linking neither a task nor a daily todo', () => {
    expect(() =>
      validatePomodoroSessionRelations([session({ task_id: null, daily_todo_id: null })]),
    ).not.toThrow()
  })

  it('rejects marked_task_complete without a target', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ marked_task_complete: true, task_id: null, daily_todo_id: null }),
      ]),
    ).toThrow(/标记完成时必须关联任务或独立待办/)
  })

  it('accepts marked_task_complete with a task', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ marked_task_complete: true, task_id: 'task-1' }),
      ]),
    ).not.toThrow()
  })

  it('accepts marked_task_complete with a daily todo', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ marked_task_complete: true, daily_todo_id: 'todo-1' }),
      ]),
    ).not.toThrow()
  })

  it('rejects a shared index equal to notes.length', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ habit_id: 'habit-1', notes: ['a', 'b'], shared_indices: [2] }),
      ]),
    ).toThrow(/分发下标越界/)
  })

  it('rejects a negative shared index', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ habit_id: 'habit-1', notes: ['a', 'b'], shared_indices: [-1] }),
      ]),
    ).toThrow(/分发下标越界/)
  })

  it('rejects a non-integer shared index', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ habit_id: 'habit-1', notes: ['a', 'b'], shared_indices: [1.5] }),
      ]),
    ).toThrow(/分发下标越界/)
  })

  it('rejects non-empty shared_indices without a habit', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ habit_id: null, notes: ['a', 'b'], shared_indices: [0] }),
      ]),
    ).toThrow(/未关联习惯时不能有分发笔记/)
  })

  it('rejects a progress_amount of 0', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({ task_id: 'task-1', progress_amount: 0 }),
      ]),
    ).toThrow(/推进量必须大于 0/)
  })

  it('accepts a null progress_amount', () => {
    expect(() =>
      validatePomodoroSessionRelations([session({ task_id: 'task-1', progress_amount: null })]),
    ).not.toThrow()
  })

  it('accepts a dangling task_id (no foreign key requirement)', () => {
    expect(() =>
      validatePomodoroSessionRelations([session({ task_id: 'task-that-does-not-exist' })]),
    ).not.toThrow()
  })

  it('accepts a habit-linked session with in-range shared indices', () => {
    expect(() =>
      validatePomodoroSessionRelations([
        session({
          habit_id: 'habit-1',
          task_id: 'task-1',
          notes: ['a', 'b', 'c'],
          shared_indices: [0, 2],
        }),
      ]),
    ).not.toThrow()
  })
})

describe('validateImportRows for pomodoroSessions', () => {
  it('rejects an unknown key before relation checks', () => {
    expect(() =>
      validateImportRows('pomodoroSessions', [{ ...session(), injected_column: 'x' }]),
    ).toThrow(/未知字段/)
  })
})
