import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { PomodoroSession } from '@/lib/types'

/**
 * Phase 13 / POMODO-03 persistence proof.
 *
 * Every test writes through a real `LocalRepository` backed by a fresh, uniquely
 * named fake-indexeddb database, then CLOSES it and re-opens a new OrbitDB under
 * the same name — so the assertions prove bytes reached IndexedDB rather than
 * surviving in an in-memory cache.
 *
 * The module-level `db` singleton is deliberately never imported: these tests
 * must not share state with the rest of the suite.
 *
 * Covered:
 *  - arrays (`notes`, `shared_indices`) and booleans survive an IndexedDB reopen
 *  - the default list hides a soft-deleted session; includeDeleted shows the
 *    tombstone with its arrays intact
 *  - a note edit through upsert preserves id + deleted_at and re-stamps
 *    updated_at
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-pomodoro-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(name: string): { database: OrbitDB; repo: LocalRepository } {
  const database = new OrbitDB(name)
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

function session(over: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 'session-1',
    started_at: '2026-10-31T08:00:00.000Z',
    duration_sec: 1500,
    notes: ['第一行笔记', '第二行笔记'],
    habit_id: null,
    task_id: 'task-1',
    daily_todo_id: null,
    marked_task_complete: true,
    progress_amount: 12,
    shared_indices: [0, 1],
    updated_at: '2026-10-31T08:25:00.000Z',
    deleted_at: null,
    ...over,
  }
}

describe('pomodoro session persistence across reopen', () => {
  it('persists a live session with intact arrays and boolean after reopen', async () => {
    const name = newName()
    const first = open(name)
    const s = session()
    await first.repo.upsert<PomodoroSession>('pomodoroSessions', s)
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<PomodoroSession>('pomodoroSessions')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toBe(s.id)
    expect(row.started_at).toBe(s.started_at)
    expect(row.duration_sec).toBe(1500)
    expect(row.notes).toEqual(['第一行笔记', '第二行笔记'])
    expect(row.shared_indices).toEqual([0, 1])
    expect(row.marked_task_complete).toBe(true)
    expect(row.progress_amount).toBe(12)
    expect(row.task_id).toBe('task-1')
    expect(row.habit_id).toBeNull()
    expect(row.deleted_at).toBeNull()
  })

  it('hides a tombstoned session from live reads but returns it with arrays via includeDeleted', async () => {
    const name = newName()
    const first = open(name)
    const s = session()
    await first.repo.upsert<PomodoroSession>('pomodoroSessions', s)
    await first.repo.softDelete('pomodoroSessions', s.id)
    first.database.close()

    const second = open(name)
    // The default list hides the soft-deleted row.
    expect(await second.repo.list<PomodoroSession>('pomodoroSessions')).toHaveLength(0)
    // The tombstone is still there, arrays intact.
    const all = await second.repo.list<PomodoroSession>('pomodoroSessions', {
      includeDeleted: true,
    })
    expect(all).toHaveLength(1)
    expect(all[0].deleted_at).not.toBeNull()
    expect(all[0].notes).toEqual(['第一行笔记', '第二行笔记'])
    expect(all[0].shared_indices).toEqual([0, 1])
  })

  it('a note edit through upsert preserves id and deleted_at while re-stamping updated_at', async () => {
    const name = newName()
    const first = open(name)
    const s = session()
    await first.repo.upsert<PomodoroSession>('pomodoroSessions', s)
    await first.repo.softDelete('pomodoroSessions', s.id)
    first.database.close()

    const second = open(name)
    const before = await second.repo.list<PomodoroSession>('pomodoroSessions', {
      includeDeleted: true,
    })
    // Note-only save: omit deleted_at so upsert preserves the tombstone.
    await second.repo.upsert<PomodoroSession>('pomodoroSessions', {
      id: before[0].id,
      started_at: before[0].started_at,
      duration_sec: before[0].duration_sec,
      notes: ['改过的笔记'],
      habit_id: before[0].habit_id,
      task_id: before[0].task_id,
      daily_todo_id: before[0].daily_todo_id,
      marked_task_complete: before[0].marked_task_complete,
      progress_amount: before[0].progress_amount,
      shared_indices: [0],
    })
    second.database.close()

    const third = open(name)
    const rows = await third.repo.list<PomodoroSession>('pomodoroSessions', {
      includeDeleted: true,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(s.id)
    expect(rows[0].deleted_at).not.toBeNull()
    expect(rows[0].notes).toEqual(['改过的笔记'])
    expect(rows[0].updated_at).not.toBe(before[0].updated_at)
  })
})
