import { beforeEach, describe, expect, it } from 'vitest'
import { LocalRepository } from '@/lib/local-repository'
import { db } from '@/lib/local-db'
import type { Review } from '@/lib/types'
import { sortReviewsNewestFirst } from '@/lib/review-time'

/**
 * Repository-boundary proof for Phase 5 (REV-01 / REV-02).
 *
 * Reviews are written through LocalRepository.upsert (which supplies
 * id/updated_at/deleted_at) and read back through a FRESH repository instance,
 * proving the write reached IndexedDB rather than an in-instance cache. The
 * test also proves goal scoping ("stays attached to the correct goal") and that
 * the real sortReviewsNewestFirst helper yields a chronological timeline.
 *
 * fake-indexeddb is wired globally via vitest.config.ts setupFiles.
 */

async function reset() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
}

beforeEach(async () => {
  await reset()
})

describe('review persistence across repository re-instantiation', () => {
  it('persists goal-scoped reviews and orders them newest-first', async () => {
    const repo = new LocalRepository()

    // upsert supplies id / updated_at / deleted_at: null.
    await repo.upsert<Review>('reviews', {
      goal_id: 'goal-a',
      content: 'older note',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    await repo.upsert<Review>('reviews', {
      goal_id: 'goal-a',
      content: 'newest note',
      created_at: '2026-03-01T00:00:00.000Z',
    })
    await repo.upsert<Review>('reviews', {
      goal_id: 'goal-b',
      content: 'other goal',
      created_at: '2026-02-01T00:00:00.000Z',
    })

    // Fresh instance: the rows must come from IndexedDB, not this object.
    const fresh = new LocalRepository()
    const all = await fresh.list<Review>('reviews')

    expect(all).toHaveLength(3)
    expect(all.every((r) => !!r.id)).toBe(true)
    expect(all.map((r) => r.content).sort()).toEqual(
      ['newest note', 'older note', 'other goal'].sort(),
    )
    expect(all.every((r) => r.deleted_at === null)).toBe(true)

    const goalA = all.filter((r) => r.goal_id === 'goal-a')
    const goalB = all.filter((r) => r.goal_id === 'goal-b')

    expect(goalA).toHaveLength(2)
    expect(goalA.every((r) => r.goal_id === 'goal-a')).toBe(true)
    expect(goalB).toHaveLength(1)

    const sorted = sortReviewsNewestFirst(goalA)
    expect(sorted.map((r) => r.content)).toEqual(['newest note', 'older note'])
  })
})
