import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_ENTITIES,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportFilename,
} from '@/lib/data-export'
import { buildCloudExportContract, exportCloudBackup } from '@/lib/cloud-backup'
import type { PullChange, PullResponse, PushOp } from '@/lib/sync-protocol'
import type { SyncEntity } from '@/lib/sync-entities'
import type { Category, Goal, Task } from '@/lib/types'

/**
 * Phase 20 / BOOT-03 — truthful cloud backup export.
 *
 * A cloud backup must reflect what the server has (including tombstones) in the
 * same frozen orbit-export v7 envelope the local backup uses, so the backup is a
 * real safety net instead of a misleading local-only copy.
 */

const category: Category = {
  id: 'category-cloud',
  name: '云端分类',
  created_at: '2026-10-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-10-02T00:00:00.000Z',
  deleted_at: null,
}

const goal: Goal = {
  id: 'goal-cloud',
  category_id: category.id,
  name: '云端目标',
  created_at: '2026-10-03T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-10-04T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedTask: Task = {
  id: 'task-tombstoned',
  milestone_id: null,
  goal_id: goal.id,
  parent_id: null,
  name: '已删除任务',
  progress_type: 'checkbox',
  unit: null,
  target_value: null,
  current_value: null,
  completed: false,
  completed_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-10-06T00:00:00.000Z',
  deleted_at: '2026-10-07T00:00:00.000Z',
}

function change(over: {
  entity: SyncEntity
  id: string
  data: Record<string, unknown> | null
  op?: PushOp
  server_seq?: number
}): PullChange {
  return {
    entity: over.entity,
    id: over.id,
    server_seq: over.server_seq ?? 1,
    op: over.op ?? 'upsert',
    updated_at: '2026-11-01T00:00:00.000Z',
    deleted_at: null,
    data: over.data,
    device_id: 'device-1',
  }
}

function jsonResponse(body: PullResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('buildCloudExportContract', () => {
  it('zero-fills every export entity and groups rows under the right entity', () => {
    const contract = buildCloudExportContract([
      { entity: 'categories', data: category as unknown as Record<string, unknown> },
      { entity: 'goals', data: goal as unknown as Record<string, unknown> },
    ])

    expect(contract.format).toBe(EXPORT_FORMAT)
    expect(contract.version).toBe(EXPORT_VERSION)
    expect(typeof contract.exportedAt).toBe('string')
    expect(Object.keys(contract.data)).toEqual([...EXPORT_ENTITIES])
    for (const entity of EXPORT_ENTITIES) {
      expect(Array.isArray(contract.data[entity])).toBe(true)
    }
    expect(contract.data.categories).toEqual([category])
    expect(contract.data.goals).toEqual([goal])
    expect(contract.data.tasks).toEqual([])
  })

  it('drops purge entries but keeps tombstoned rows', () => {
    const contract = buildCloudExportContract([
      { entity: 'categories', data: category as unknown as Record<string, unknown> },
      { entity: 'tasks', data: tombstonedTask as unknown as Record<string, unknown> },
      { entity: 'habits', op: 'purge' },
    ])

    expect(contract.data.categories).toEqual([category])
    expect(contract.data.tasks).toEqual([tombstonedTask])
    expect((contract.data.tasks as Task[])[0].deleted_at).toBe(tombstonedTask.deleted_at)
    expect(contract.data.habits).toEqual([])
  })

  it('rejects an unknown entity instead of silently dropping its rows', () => {
    expect(() =>
      buildCloudExportContract([{ entity: 'mystery', data: { id: 'x' } }]),
    ).toThrow()
  })
})

describe('exportFilename', () => {
  it('formats prefix-YYYY-MM-DD.json with zero padding', () => {
    expect(exportFilename('orbit-export', new Date('2026-01-05T10:00:00.000Z'))).toBe(
      'orbit-export-2026-01-05.json',
    )
  })
})

describe('exportCloudBackup', () => {
  it('accumulates every page, drops purges, and delivers the v7 contract exactly once', async () => {
    const paths: string[] = []
    const fetchFn = async (path: string): Promise<Response> => {
      paths.push(path)
      if (paths.length === 1) {
        return jsonResponse({
          version: 1,
          changes: [
            change({
              entity: 'categories',
              id: category.id,
              data: category as unknown as Record<string, unknown>,
              server_seq: 1,
            }),
            change({
              entity: 'tasks',
              id: tombstonedTask.id,
              data: tombstonedTask as unknown as Record<string, unknown>,
              op: 'delete',
              server_seq: 2,
            }),
          ],
          next_cursor: 5,
          has_more: true,
        })
      }
      return jsonResponse({
        version: 1,
        changes: [
          change({ entity: 'habits', id: 'gone-habit', data: null, op: 'purge', server_seq: 6 }),
          change({
            entity: 'goals',
            id: goal.id,
            data: goal as unknown as Record<string, unknown>,
            server_seq: 7,
          }),
        ],
        next_cursor: 9,
        has_more: false,
      })
    }

    const deliver = vi.fn(async () => {})

    const result = await exportCloudBackup({
      fetchFn,
      deliver,
      now: () => new Date('2026-11-02T10:00:00.000Z'),
    })

    expect(paths).toEqual([
      '/v1/sync/pull?since=0&limit=500',
      '/v1/sync/pull?since=5&limit=500',
    ])
    expect(result).toEqual({ rows: 3 })
    expect(deliver).toHaveBeenCalledTimes(1)

    const [json, filename] = deliver.mock.calls[0] as unknown as [string, string]
    expect(filename).toBe('orbit-cloud-export-2026-11-02.json')
    const contract = JSON.parse(json) as ReturnType<typeof buildCloudExportContract>
    expect(contract.format).toBe(EXPORT_FORMAT)
    expect(contract.version).toBe(EXPORT_VERSION)
    expect(Object.keys(contract.data)).toEqual([...EXPORT_ENTITIES])
    expect(contract.data.categories).toEqual([category])
    expect(contract.data.goals).toEqual([goal])
    // The tombstone survives even though the row is soft-deleted.
    expect(contract.data.tasks).toEqual([tombstonedTask])
    // The purge marker is not exported as a row.
    expect(contract.data.habits).toEqual([])
  })

  it('throws on a non-ok page before delivering anything', async () => {
    const deliver = vi.fn(async () => {})
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({ version: 1, changes: [], next_cursor: 0, has_more: false }, 500)

    await expect(exportCloudBackup({ fetchFn, deliver })).rejects.toThrow()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('throws on a malformed next_cursor before delivering anything', async () => {
    const deliver = vi.fn(async () => {})
    const fetchFn = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ version: 1, changes: [], next_cursor: '5', has_more: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )

    await expect(exportCloudBackup({ fetchFn, deliver })).rejects.toThrow()
    expect(deliver).not.toHaveBeenCalled()
  })
})
