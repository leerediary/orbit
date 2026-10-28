import { describe, expect, it } from 'vitest'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'
import type { OrbitBridge } from '@/lib/sqlite-bridge'
import type { Goal, Task } from '@/lib/types'

/**
 * CR-02 guard: column names never come from the caller. Every key must pass
 * the per-entity allowlist before it can appear in SQL, and values are always
 * bound as parameters.
 */

interface Statement {
  sql: string
  params: unknown[]
}

function fakeBridge(): { bridge: OrbitBridge; statements: Statement[] } {
  const statements: Statement[] = []
  const bridge: OrbitBridge = {
    async execute(sql, params) {
      statements.push({ sql, params })
    },
    async query<T>() {
      return [] as T[]
    },
  }
  return { bridge, statements }
}

const validGoal: Goal = {
  id: 'goal-1',
  name: 'Ship Orbit',
  description: '',
  sort_order: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const validTask: Task = {
  id: 'task-1',
  goal_id: 'goal-1',
  milestone_id: null,
  name: 'First task',
  completed: false,
  completed_at: null,
  created_at: '2026-01-02T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-02T00:00:00.000Z',
  deleted_at: null,
}

function inserts(statements: Statement[]): Statement[] {
  return statements.filter((s) => s.sql.includes('INSERT OR REPLACE'))
}

describe('SqliteLocalRepository column allowlist', () => {
  it('rejects an unknown key instead of interpolating it into SQL', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = {
      id: 'goal-1',
      name: 'x',
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
      'name) VALUES (1); DROP TABLE goals; --': 'boom',
    } as unknown as Goal

    await expect(repo.upsert<Goal>('goals', crafted)).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
  })

  it('rolls back bulkLoadAll when a row carries an unknown key', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = { ...validTask, 'goal_id) VALUES (1); --': 'x' }

    await expect(repo.bulkLoadAll([['tasks', [crafted]]])).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
    expect(statements.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('preserves an existing tombstone and merges omitted columns on upsert', async () => {
    const statements: Statement[] = []
    const existing = {
      id: 'goal-1',
      name: 'Original',
      description: 'keep me',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-06-01T00:00:00.000Z',
    }
    const bridge: OrbitBridge = {
      async execute(sql, params) {
        statements.push({ sql, params })
      },
      async query<T>() {
        return [existing] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    await repo.upsert<Goal>('goals', { id: 'goal-1', name: 'Renamed' } as unknown as Goal)

    const [insert] = inserts(statements)
    const columns = insert.sql
      .slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')'))
      .split(', ')
    expect(insert.params[columns.indexOf('name')]).toBe('Renamed')
    expect(insert.params[columns.indexOf('description')]).toBe('keep me')
    expect(insert.params[columns.indexOf('deleted_at')]).toBe(existing.deleted_at)
  })

  it('binds every allowlisted value as a parameter', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    await repo.bulkLoadAll([
      ['goals', [validGoal]],
      ['tasks', [validTask]],
    ])

    const [goalInsert, taskInsert] = inserts(statements)
    expect(goalInsert.sql).toBe(
      'INSERT OR REPLACE INTO goals (id, name, description, sort_order, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    expect(goalInsert.params).toEqual([
      validGoal.id,
      validGoal.name,
      validGoal.description,
      validGoal.sort_order,
      validGoal.created_at,
      validGoal.updated_at,
      validGoal.deleted_at,
    ])
    // completed serializes to 0/1, never interpolated.
    expect(taskInsert.sql).not.toContain('false')
    expect(taskInsert.params).toContain(0)
  })

  // Appended after the existing tests so the module-level cached `schemaReady`
  // promise is already resolved: ensureSchema() emits no CREATE TABLE before
  // BEGIN, and the statement sequence can be asserted from BEGIN onward.
  it('replaceAll clears all four tables before inserting, in one transaction', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    await repo.replaceAll([['tasks', [validTask]]])

    const beginAt = statements.findIndex((s) => s.sql === 'BEGIN')
    expect(beginAt).toBeGreaterThanOrEqual(0)

    const sequence = statements.slice(beginAt)
    expect(sequence.map((s) => s.sql)).toEqual([
      'BEGIN',
      'DELETE FROM goals',
      'DELETE FROM milestones',
      'DELETE FROM tasks',
      'DELETE FROM reviews',
      expect.stringMatching(/^INSERT OR REPLACE INTO tasks \(/),
      'COMMIT',
    ])
  })

  it('rolls back replaceAll when a row carries an unknown column, after the clears', async () => {
    const { bridge, statements } = fakeBridge()
    const repo = new SqliteLocalRepository(bridge)

    const crafted = { ...validTask, 'goal_id) VALUES (1); --': 'x' }

    await expect(repo.replaceAll([['tasks', [crafted]]])).rejects.toThrow(/unknown column/)
    expect(inserts(statements)).toHaveLength(0)
    expect(statements.at(-1)?.sql).toBe('ROLLBACK')
  })
})
