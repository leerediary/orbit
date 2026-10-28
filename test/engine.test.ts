import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getLocalRepository, getRepository } from '@/lib/repository-provider'
import type { Goal, Task } from '@/lib/types'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

beforeEach(async () => {
  await Promise.all([
    db.goals.clear(),
    db.milestones.clear(),
    db.tasks.clear(),
    db.reviews.clear(),
  ])
})

describe('engine round-trip (web / Dexie branch)', () => {
  it('creates a goal from a partial row, then re-stamps updated_at while preserving id', async () => {
    const repo = getRepository()

    await repo.upsert<Goal>('goals', {
      name: 'Ship Orbit',
      description: 'M1 — local-first goals',
      created_at: '2026-05-18T00:00:00.000Z',
      sort_order: 1,
    })

    const [first] = await repo.list<Goal>('goals')
    expect(first).toBeDefined()
    expect(first.id).toBeTruthy()
    expect(first.updated_at).toMatch(ISO)
    expect(first.deleted_at).toBeNull()

    await new Promise((r) => setTimeout(r, 5))
    await repo.upsert<Goal>('goals', {
      id: first.id,
      name: 'Ship Orbit v1',
      description: 'M1 shipped',
      created_at: '2026-05-18T00:00:00.000Z',
      sort_order: 2,
    })

    const rows = await repo.list<Goal>('goals')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id)
    expect(rows[0].name).toBe('Ship Orbit v1')
    expect(rows[0].updated_at).toMatch(ISO)
    expect(rows[0].updated_at > first.updated_at).toBe(true)
  })

  it('softDelete hides the row but preserves the tombstone with includeDeleted', async () => {
    const repo = getRepository()

    await repo.upsert<Goal>('goals', {
      name: 'Archivable goal',
      description: '',
      created_at: '2026-05-18T00:00:00.000Z',
      sort_order: 3,
    })
    const [goal] = await repo.list<Goal>('goals')

    await repo.softDelete('goals', goal.id)
    expect(await repo.list<Goal>('goals')).toHaveLength(0)

    const all = await repo.list<Goal>('goals', { includeDeleted: true })
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(goal.id)
    expect(all[0].deleted_at).not.toBeNull()
  })

  it('repeated seed upserts with a fixed id collapse to a single row', async () => {
    const repo = getRepository()
    const seed = {
      id: 'seed-goal-orbit-v1',
      name: '示例目标',
      description: '本地持久化验证 — 刷新后仍在',
      created_at: '2026-05-18T00:00:00.000Z',
      sort_order: 4,
    }

    // Simulates StrictMode double-invoke / two tabs racing the empty store.
    await Promise.all([
      repo.upsert<Goal>('goals', seed),
      repo.upsert<Goal>('goals', seed),
    ])

    const rows = await repo.list<Goal>('goals')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(seed.id)
  })

  it('upsert preserves an existing tombstone and merges omitted columns', async () => {
    const repo = getRepository()

    await repo.upsert<Goal>('goals', {
      id: 'goal-tombstoned',
      name: 'Original',
      description: 'keep me',
      created_at: '2026-05-01T00:00:00.000Z',
      sort_order: 5,
    })
    await repo.softDelete('goals', 'goal-tombstoned')
    expect(await repo.list<Goal>('goals')).toHaveLength(0)

    // A partial runtime row with no deleted_at must not resurrect the row and
    // must not drop the columns it omits.
    await repo.upsert<Goal>('goals', {
      id: 'goal-tombstoned',
      name: 'Renamed',
    } as unknown as Goal)

    expect(await repo.list<Goal>('goals')).toHaveLength(0)
    const [row] = await repo.list<Goal>('goals', { includeDeleted: true })
    expect(row.name).toBe('Renamed')
    expect(row.description).toBe('keep me')
    expect(row.deleted_at).not.toBeNull()
  })

  it('bulkLoadAll loads rows verbatim preserving id, updated_at, and deleted_at', async () => {
    const goalRow: Goal = {
      id: 'goal-1',
      name: 'Backup goal',
      description: 'from export',
      created_at: '2026-01-01T00:00:00.000Z',
      sort_order: 6,
      updated_at: '2026-02-02T00:00:00.000Z',
      deleted_at: null,
    }
    const taskRow: Task = {
      id: 'task-1',
      goal_id: 'goal-1',
      milestone_id: null,
      name: 'Backup task',
      completed: true,
      completed_at: '2026-03-03T00:00:00.000Z',
      created_at: '2026-01-02T00:00:00.000Z',
      sort_order: 7,
      updated_at: '2026-02-03T00:00:00.000Z',
      deleted_at: '2026-04-04T00:00:00.000Z',
    }

    await getLocalRepository().bulkLoadAll([
      ['goals', [goalRow]],
      ['tasks', [taskRow]],
    ])

    expect(await db.goals.toArray()).toEqual([goalRow])
    expect(await db.tasks.toArray()).toEqual([taskRow])
  })

  it('imports the provider module without touching window at module scope', async () => {
    const mod = await import('@/lib/repository-provider')
    expect(typeof mod.getRepository).toBe('function')
    expect(typeof window).toBe('undefined')
  })
})
