import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getLocalRepository } from '@/lib/repository-provider'
import { importData } from '@/lib/data-import'
import { EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import type { Goal, Milestone, Review, Task } from '@/lib/types'

/**
 * D-01 proof: import is a 整库替换 (true restore), not a merge-by-id upsert.
 *
 *  - rows created after the backup are discarded (all four tables cleared)
 *  - the backup's rows survive byte-for-byte (ids, timestamps, tombstones)
 *  - legacy rows without sort_order stay without sort_order
 *  - a failure mid-replace rolls back every clear (atomicity)
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

const goalA: Goal = {
  id: 'goal-a',
  name: 'Pre-existing A',
  description: 'created after the backup was taken',
  created_at: '2026-05-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-05-01T00:00:00.000Z',
  deleted_at: null,
}

const goalB: Goal = {
  id: 'goal-b',
  name: 'Pre-existing B',
  description: 'also created after the backup',
  created_at: '2026-05-02T00:00:00.000Z',
  sort_order: 2,
  updated_at: '2026-05-02T00:00:00.000Z',
  deleted_at: null,
}

const backupGoal: Goal = {
  id: 'goal-backup',
  name: 'Only in the backup',
  description: 'must be the sole surviving goal',
  created_at: '2026-01-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedGoal: Goal = {
  id: 'goal-tombstoned',
  name: 'Archived goal',
  description: 'soft-deleted, must survive the replace verbatim',
  created_at: '2026-01-02T00:00:00.000Z',
  sort_order: 2,
  updated_at: '2026-03-01T00:00:00.000Z',
  deleted_at: '2026-04-01T00:00:00.000Z',
}

const milestone: Milestone = {
  id: 'milestone-1',
  goal_id: backupGoal.id,
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
  goal_id: backupGoal.id,
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
  goal_id: backupGoal.id,
  content: 'Imported review',
  created_at: '2026-01-05T00:00:00.000Z',
  updated_at: '2026-02-05T00:00:00.000Z',
  deleted_at: null,
}

beforeEach(async () => {
  await reset()
})

describe('whole-store replace (D-01)', () => {
  it('discards rows created after the backup instead of merging by id', async () => {
    await db.goals.bulkPut([goalA, goalB])

    await importData(contract({ goals: [backupGoal] }))

    const rows = await db.goals.toArray()
    expect(rows.map((r) => r.id)).toEqual([backupGoal.id])
    expect(rows[0]).toEqual(backupGoal)
  })

  it('clears all four tables when the backup is empty', async () => {
    await db.goals.bulkPut([goalA])
    await db.milestones.bulkPut([milestone])
    await db.tasks.bulkPut([task])
    await db.reviews.bulkPut([review])

    await importData(contract())

    expect(await counts()).toEqual({ goals: 0, milestones: 0, tasks: 0, reviews: 0 })
  })

  it('preserves ids, updated_at timestamps, and tombstones verbatim through the replace', async () => {
    await importData(
      contract({
        goals: [backupGoal, tombstonedGoal],
        milestones: [milestone],
        tasks: [task],
        reviews: [review],
      }),
    )

    const goals = await db.goals.toArray()
    const byId = new Map(goals.map((g) => [g.id, g]))
    expect(byId.get(backupGoal.id)).toEqual(backupGoal)
    expect(byId.get(tombstonedGoal.id)).toEqual(tombstonedGoal)

    const tasks = await db.tasks.toArray()
    expect(tasks).toEqual([task])
    const reviews = await db.reviews.toArray()
    expect(reviews).toEqual([review])
  })

  it('keeps a legacy goal without sort_order free of sort_order after the replace', async () => {
    const legacyGoal = { ...backupGoal } as Partial<Goal>
    delete legacyGoal.sort_order

    await importData(contract({ goals: [legacyGoal] }))

    const stored = await db.goals.get(backupGoal.id)
    expect(stored).toBeDefined()
    expect(stored!.sort_order).toBeUndefined()
  })

  it('rolls back every clear when a later bulkPut throws', async () => {
    await db.goals.bulkPut([goalA])
    await db.tasks.bulkPut([task])

    // A function is not structured-cloneable, so Dexie's bulkPut throws
    // DataCloneError AFTER both clears — proving the transaction rolls the
    // clears back rather than leaving the store wiped.
    await expect(
      getLocalRepository().replaceAll([
        ['goals', [{ ...backupGoal, id: 'new-goal' }]],
        ['reviews', [{ id: 'bad', fn: () => 1 }]],
      ]),
    ).rejects.toThrow()

    const goals = await db.goals.toArray()
    const tasks = await db.tasks.toArray()
    expect(goals.map((g) => g.id)).toEqual([goalA.id])
    expect(tasks.map((t) => t.id)).toEqual([task.id])
  })
})
