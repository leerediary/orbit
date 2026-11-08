import { describe, expect, it } from 'vitest'
import { validateDailyTodoRelations, validateImportRow } from '@/lib/entity-schema'
import type { DailyTodo } from '@/lib/types'

/**
 * Phase 9 / T-09-01: the daily layer's cross-row invariants. These are pure
 * (no IndexedDB) — the validator must reject malformed rows BEFORE any write so
 * a hand-edited backup can never introduce a second completion source, an empty
 * standalone todo, or duplicate live associations.
 */

const ADDED = '2026-01-01T00:00:00.000Z'
const UPDATED = '2026-01-02T00:00:00.000Z'

function standalone(overrides: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'todo-1',
    task_id: null,
    name: '买牛奶',
    completed: false,
    completed_at: null,
    added_at: ADDED,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

function linked(overrides: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'link-1',
    task_id: 'task-1',
    name: null,
    completed: null,
    completed_at: null,
    added_at: ADDED,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('validateDailyTodoRelations', () => {
  it('accepts a valid standalone todo', () => {
    expect(() => validateDailyTodoRelations([standalone()])).not.toThrow()
    expect(() => validateDailyTodoRelations([standalone({ completed: true, completed_at: UPDATED })])).not.toThrow()
  })

  it('accepts a valid linked row with null name/completed/completed_at', () => {
    expect(() => validateDailyTodoRelations([linked()])).not.toThrow()
  })

  it('rejects a standalone todo with a missing or blank name', () => {
    expect(() => validateDailyTodoRelations([standalone({ name: null })])).toThrow(/是独立待办，名称不能为空/)
    expect(() => validateDailyTodoRelations([standalone({ name: '   ' })])).toThrow(/是独立待办，名称不能为空/)
  })

  it('rejects a standalone todo whose completed is null', () => {
    expect(() => validateDailyTodoRelations([standalone({ completed: null })])).toThrow(
      /是独立待办，完成状态必须为布尔值/,
    )
  })

  it('rejects a linked row that carries name or completion', () => {
    expect(() => validateDailyTodoRelations([linked({ completed: true })])).toThrow(
      /关联任务时不能携带名称或完成状态/,
    )
    expect(() => validateDailyTodoRelations([linked({ name: '偷带的名字' })])).toThrow(
      /关联任务时不能携带名称或完成状态/,
    )
    expect(() => validateDailyTodoRelations([linked({ completed_at: UPDATED })])).toThrow(
      /关联任务时不能携带名称或完成状态/,
    )
  })

  it('rejects an empty task_id on a row that claims to be linked', () => {
    expect(() => validateDailyTodoRelations([linked({ task_id: '  ' })])).toThrow(/的 task_id 不能为空/)
  })

  it('rejects two live rows referencing the same task', () => {
    expect(() =>
      validateDailyTodoRelations([
        linked({ id: 'link-a', task_id: 'task-1' }),
        linked({ id: 'link-b', task_id: 'task-1' }),
      ]),
    ).toThrow(/今日待办中存在重复关联的任务 "task-1"/)
  })

  it('allows a duplicate where one row is tombstoned', () => {
    expect(() =>
      validateDailyTodoRelations([
        linked({ id: 'link-a', task_id: 'task-1' }),
        linked({ id: 'link-b', task_id: 'task-1', deleted_at: '2026-05-01T00:00:00.000Z' }),
      ]),
    ).not.toThrow()
  })

  it('allows a linked row pointing at a task absent from the import (no FK)', () => {
    expect(() =>
      validateDailyTodoRelations([linked({ task_id: 'task-that-does-not-exist' })]),
    ).not.toThrow()
  })

  it('is a no-op for an empty array', () => {
    expect(() => validateDailyTodoRelations([])).not.toThrow()
  })
})

describe('validateImportRow for dailyTodos', () => {
  it('rejects a non-boolean, non-null completed value', () => {
    expect(() =>
      validateImportRow('dailyTodos', { ...standalone(), completed: 'yes' }, 0),
    ).toThrow(/必须是 null 或布尔值/)
  })

  it('accepts a well-formed linked row', () => {
    expect(() => validateImportRow('dailyTodos', linked(), 0)).not.toThrow()
  })
})
