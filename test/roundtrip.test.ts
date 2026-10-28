import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getRepository } from '@/lib/repository-provider'
import { importData } from '@/lib/data-import'
import { EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import type { Goal, Milestone, Review, Task } from '@/lib/types'

/**
 * Data-portability round-trip proof (success criterion #3).
 *
 * Builds the exact orbit-export contract and feeds it through importData():
 *  - a live Goal + a tombstoned Goal survive with ids, updated_at, and
 *    deleted_at byte-identical to the input
 *  - a fully valid contract writes the expected per-entity row counts
 *  - a bad row in the LAST entity rolls back all four tables (atomicity)
 *  - a wrong format identifier throws with zero writes
 */

function contract(data: Partial<Record<'goals' | 'milestones' | 'tasks' | 'reviews', unknown[]>> = {}) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      goals: [],
      milestones: [],
      tasks: [],
      reviews: [],
      ...data,
    },
  })
}

async function reset() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
}

async function counts() {
  return {
    goals: await db.goals.count(),
    milestones: await db.milestones.count(),
    tasks: await db.tasks.count(),
    reviews: await db.reviews.count(),
  }
}

const liveGoal: Goal = {
  id: 'goal-live',
  name: 'Ship Orbit',
  description: 'M1 — local-first goals',
  created_at: '2026-01-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedGoal: Goal = {
  id: 'goal-tombstoned',
  name: 'Archived goal',
  description: 'soft-deleted, must survive export/import',
  created_at: '2026-01-02T00:00:00.000Z',
  sort_order: 2,
  updated_at: '2026-03-01T00:00:00.000Z',
  deleted_at: '2026-04-01T00:00:00.000Z',
}

const milestone: Milestone = {
  id: 'milestone-1',
  goal_id: liveGoal.id,
  name: 'First milestone',
  completed: false,
  completed_at: null,
  created_at: '2026-01-03T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-03T00:00:00.000Z',
  deleted_at: null,
}

const task: Task = {
  id: 'task-1',
  goal_id: liveGoal.id,
  milestone_id: milestone.id,
  name: 'First task',
  completed: true,
  completed_at: '2026-03-03T00:00:00.000Z',
  created_at: '2026-01-04T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-04T00:00:00.000Z',
  deleted_at: null,
}

const review: Review = {
  id: 'review-1',
  goal_id: liveGoal.id,
  content: 'Weekly review',
  created_at: '2026-01-05T00:00:00.000Z',
  updated_at: '2026-02-05T00:00:00.000Z',
  deleted_at: null,
}

beforeEach(async () => {
  await reset()
})

describe('orbit-export round-trip', () => {
  it('preserves ids, updated_at timestamps, and soft-delete tombstones', async () => {
    await importData(contract({ goals: [liveGoal, tombstonedGoal] }))

    const rows = await getRepository().list<Goal>('goals', { includeDeleted: true })
    expect(rows).toHaveLength(2)

    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(tombstonedGoal.id)).toEqual(tombstonedGoal)
    expect(byId.get(liveGoal.id)).toEqual(liveGoal)

    const tombstone = byId.get(tombstonedGoal.id)!
    expect(tombstone.deleted_at).toBe('2026-04-01T00:00:00.000Z')
    expect(tombstone.updated_at).toBe(tombstonedGoal.updated_at)

    // Live reads still hide the tombstone.
    const liveRows = await getRepository().list<Goal>('goals')
    expect(liveRows).toHaveLength(1)
    expect(liveRows[0].id).toBe(liveGoal.id)
  })

  it('writes exactly the per-entity row counts for a fully valid contract', async () => {
    await importData(
      contract({
        goals: [liveGoal, tombstonedGoal],
        milestones: [milestone],
        tasks: [task],
        reviews: [review],
      }),
    )

    expect(await counts()).toEqual({ goals: 2, milestones: 1, tasks: 1, reviews: 1 })
  })

  it('round-trips a task whose milestone_id is a real UUID', async () => {
    const uuid = crypto.randomUUID()
    const uuidMilestone: Milestone = { ...milestone, id: uuid }
    const uuidTask: Task = { ...task, milestone_id: uuid }

    await importData(
      contract({ goals: [liveGoal], milestones: [uuidMilestone], tasks: [uuidTask] }),
    )

    const rows = await getRepository().list<Task>('tasks')
    expect(rows).toHaveLength(1)
    expect(rows[0].milestone_id).toBe(uuid)
  })

  it('rolls back every table when the last entity has a row missing id', async () => {
    const malformed = contract({
      goals: [liveGoal],
      milestones: [milestone],
      tasks: [task],
      // 'reviews' is the LAST export entity; this row has no `id` keyPath.
      reviews: [{ goal_id: liveGoal.id, content: 'bad', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null }],
    })

    await expect(importData(malformed)).rejects.toThrow()

    const result = await counts()
    expect(Object.values(result).every((n) => n === 0)).toBe(true)
  })

  it('rejects an id-only row instead of overwriting a complete existing row', async () => {
    await importData(contract({ goals: [liveGoal] }))
    expect(await db.goals.toArray()).toEqual([liveGoal])

    // Dexie bulkPut would accept this and replace the full row with {id}.
    await expect(importData(contract({ goals: [{ id: liveGoal.id }] }))).rejects.toThrow(/缺少字段/)

    // The complete row is untouched.
    expect(await db.goals.toArray()).toEqual([liveGoal])
  })

  it('rejects a wrong-typed field and writes nothing', async () => {
    const malformed = contract({ goals: [{ ...liveGoal, name: 42 }] })
    await expect(importData(malformed)).rejects.toThrow(/必须是字符串/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('rejects a non-numeric sort_order and writes nothing', async () => {
    const malformed = contract({ goals: [{ ...liveGoal, sort_order: '5' }] })
    await expect(importData(malformed)).rejects.toThrow(/必须是数字/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('accepts a legacy goal without sort_order (runtime effectiveOrder fallback)', async () => {
    const legacyGoal = { ...liveGoal } as Partial<Goal>
    delete legacyGoal.sort_order

    await importData(contract({ goals: [legacyGoal] }))

    const rows = await getRepository().list<Goal>('goals', { includeDeleted: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(liveGoal.id)
    expect(rows[0].sort_order).toBeUndefined()
  })

  it('accepts a legacy milestone and task without sort_order (runtime effectiveOrder fallback)', async () => {
    const legacyMilestone = { ...milestone } as Partial<Milestone>
    delete legacyMilestone.sort_order
    const legacyTask = { ...task } as Partial<Task>
    delete legacyTask.sort_order

    await importData(
      contract({ goals: [liveGoal], milestones: [legacyMilestone], tasks: [legacyTask] }),
    )

    const milestoneRows = await getRepository().list<Milestone>('milestones', {
      includeDeleted: true,
    })
    const taskRows = await getRepository().list<Task>('tasks', { includeDeleted: true })
    expect(milestoneRows).toHaveLength(1)
    expect(taskRows).toHaveLength(1)
    expect(milestoneRows[0].sort_order).toBeUndefined()
    expect(taskRows[0].sort_order).toBeUndefined()
  })

  it('rejects unknown keys and writes nothing', async () => {
    const malformed = contract({ goals: [{ ...liveGoal, injected_column: 'x' }] })
    await expect(importData(malformed)).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('rejects a non-ISO timestamp so incremental sync comparisons stay valid', async () => {
    const malformed = contract({ goals: [{ ...liveGoal, updated_at: 'not-a-date' }] })
    await expect(importData(malformed)).rejects.toThrow(/ISO 时间戳/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('rejects a wrong format identifier and writes nothing', async () => {
    const wrongFormat = JSON.stringify({
      format: 'diary-web-export',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      data: { goals: [liveGoal], milestones: [], tasks: [], reviews: [] },
    })

    await expect(importData(wrongFormat)).rejects.toThrow(/文件格式不匹配/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  // T-06-02: the allowlist must check OWN properties. A plain `key in shape`
  // accepts prototype-named keys (__proto__/constructor/toString) because they
  // live on Object.prototype. Each case below carries a real own enumerable key
  // (computed keys / JSON.parse), so the allowlist is genuinely exercised.
  it('rejects an own __proto__ key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveGoal, ['__proto__']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, '__proto__')).toBe(true)

    await expect(importData(contract({ goals: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('rejects an own constructor key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveGoal, ['constructor']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, 'constructor')).toBe(true)

    await expect(importData(contract({ goals: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('rejects an own toString key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveGoal, ['toString']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, 'toString')).toBe(true)

    // JSON.parse path proves the key survives serialization as an OWN property.
    const parsed = JSON.parse(JSON.stringify(crafted)) as Record<string, unknown>
    expect(Object.keys(parsed)).toContain('toString')

    await expect(importData(contract({ goals: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })
})
