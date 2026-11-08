import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { enqueueOutbox } from '@/lib/outbox'
import { QUARANTINE_KEY, appendQuarantine, listQuarantine } from '@/lib/sync-quarantine'
import { SYNC_KEYS, getSyncValue, setSyncValue } from '@/lib/sync-store'
import {
  CLIENT_PROTOCOL_VERSION,
  SERVER_ERROR_COPY,
  clearQuarantineEntries,
  formatDeviceLastSeen,
  formatDiagnosticTime,
  formatSnapshotDate,
  isServerVersionMismatch,
  localOnlyIds,
  readCloudManifest,
  readDiagnostics,
  readLocalInventory,
  readServerVersion,
  sanitizeQuarantineReason,
  serverOnlyIdsFromManifest,
  totalIds,
  type CloudManifest,
  type LocalInventory,
} from '@/lib/sync-diagnostics'
import type { Habit } from '@/lib/types'

/**
 * Phase 21 / OPS-01 — diagnostics read model.
 *
 * The single invariant under test: a failed read is ALWAYS a typed failure.
 * It is never allowed to collapse into a zero-filled snapshot or an empty list,
 * because the diagnostics panel would then render "0 items" over real data.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-sync-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(): OrbitDB {
  const database = new OrbitDB(newName())
  opened.push(database)
  return database
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

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '每天跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: '2026-10-30T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('readDiagnostics', () => {
  it('returns a successful zero snapshot only for a genuinely empty store', async () => {
    const db = open()
    const result = await readDiagnostics(db)

    expect(result).toEqual({
      ok: true,
      snapshot: { cursor: 0, outboxCount: 0, quarantine: [], lastError: null },
    })
  })

  it('reads cursor, outbox count, quarantine and the raw last error', async () => {
    const db = open()
    await setSyncValue(db, SYNC_KEYS.cursor, 42)
    await setSyncValue(db, SYNC_KEYS.lastError, 'http_413')
    await enqueueOutbox(db, {
      entity: 'habits',
      row_id: 'habit-1',
      op: 'upsert',
      updated_at: '2026-10-30T00:00:00.000Z',
    })
    await appendQuarantine(db, {
      kind: 'push-oversize',
      entity: 'habits',
      id: 'habit-2',
      reason: 'payload_too_large',
      at: '2026-11-01T00:00:00.000Z',
    })

    const result = await readDiagnostics(db)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.cursor).toBe(42)
    expect(result.snapshot.outboxCount).toBe(1)
    expect(result.snapshot.lastError).toBe('http_413')
    expect(result.snapshot.quarantine).toHaveLength(1)
    expect(result.snapshot.quarantine[0].reason).toBe('payload_too_large')
  })

  it('returns local-throw instead of a zero snapshot when a local read rejects', async () => {
    const stub = {
      syncState: { get: async () => undefined },
      syncOutbox: {
        count: async () => {
          throw new Error('outbox unavailable')
        },
      },
    } as unknown as OrbitDB

    const result = await readDiagnostics(stub)

    expect(result).toEqual({ ok: false, reason: 'local-throw' })
  })
})

describe('readServerVersion', () => {
  it('returns the numeric version from /v1/status', async () => {
    const seen: string[] = []
    const fetchFn = async (path: string): Promise<Response> => {
      seen.push(path)
      return jsonResponse({ version: 1, userId: 'user-1' })
    }

    const result = await readServerVersion(fetchFn)

    expect(seen).toEqual(['/v1/status'])
    expect(result).toEqual({ ok: true, version: 1 })
  })

  it('classifies 401 as auth', async () => {
    const result = await readServerVersion(async () => jsonResponse({ error: 'unauthorized' }, 401))
    expect(result).toEqual({ ok: false, reason: 'auth' })
  })

  it('classifies 5xx as server', async () => {
    const result = await readServerVersion(async () => jsonResponse({ error: 'down' }, 503))
    expect(result).toEqual({ ok: false, reason: 'server' })
  })

  it('classifies other non-OK responses as unknown', async () => {
    const result = await readServerVersion(async () => jsonResponse({ error: 'nope' }, 404))
    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })

  it('classifies an unparseable body as malformed', async () => {
    const result = await readServerVersion(async () => new Response('not json', { status: 200 }))
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('classifies a non-numeric version as malformed', async () => {
    const result = await readServerVersion(async () =>
      jsonResponse({ version: 'one', userId: 'user-1' }),
    )
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('classifies a thrown fetch as network', async () => {
    const result = await readServerVersion(async () => {
      throw new TypeError('offline')
    })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })
})

describe('readCloudManifest', () => {
  it('reads counts, ids and latest_seq, normalizing missing entities to 0 / []', async () => {
    const seen: string[] = []
    const fetchFn = async (path: string): Promise<Response> => {
      seen.push(path)
      return jsonResponse({
        version: 1,
        counts: { habits: 3, categories: 1 },
        ids: { habits: ['h1', 'h2', 'h3'] },
        latest_seq: 17,
      })
    }

    const result = await readCloudManifest(fetchFn)

    expect(seen).toEqual(['/v1/sync/manifest?ids=1'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.counts.habits).toBe(3)
    expect(result.manifest.counts.goals).toBe(0)
    expect(result.manifest.ids.habits).toEqual(['h1', 'h2', 'h3'])
    expect(result.manifest.ids.goals).toEqual([])
    expect(result.manifest.latestSeq).toBe(17)
  })

  it('rejects a string count as malformed (never zeroes it)', async () => {
    const result = await readCloudManifest(async () =>
      jsonResponse({
        version: 1,
        counts: { habits: '3' },
        ids: {},
        latest_seq: 1,
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a non-array ids entry as malformed', async () => {
    const result = await readCloudManifest(async () =>
      jsonResponse({
        version: 1,
        counts: { habits: 1 },
        ids: { habits: 'h1' },
        latest_seq: 1,
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a missing latest_seq as malformed', async () => {
    const result = await readCloudManifest(async () =>
      jsonResponse({ version: 1, counts: { habits: 1 }, ids: { habits: ['h1'] } }),
    )
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('classifies a 401 as auth', async () => {
    const result = await readCloudManifest(async () => jsonResponse({ error: 'unauthorized' }, 401))
    expect(result).toEqual({ ok: false, reason: 'auth' })
  })
})

describe('readLocalInventory', () => {
  it('returns only live rows with string ids, per entity', async () => {
    const db = open()
    await db.habits.bulkPut([
      habit({ id: 'live-a' }),
      habit({ id: 'live-b' }),
      habit({ id: 'dead', deleted_at: '2026-10-29T00:00:00.000Z' }),
    ])
    await db.categories.bulkPut([
      {
        id: 'category-1',
        name: '学习',
        created_at: '2026-10-01T00:00:00.000Z',
        sort_order: 1,
        updated_at: '2026-10-02T00:00:00.000Z',
        deleted_at: null,
      },
    ])

    const result = await readLocalInventory(db)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inventory.counts.habits).toBe(2)
    expect(result.inventory.ids.habits).toEqual(['live-a', 'live-b'])
    expect(result.inventory.counts.categories).toBe(1)
    expect(result.inventory.ids.categories).toEqual(['category-1'])
    expect(result.inventory.counts.goals).toBe(0)
    expect(result.inventory.ids.goals).toEqual([])
  })

  it('returns local-throw when a table read rejects', async () => {
    const stub = {
      table: () => ({
        toArray: async () => {
          throw new Error('table unavailable')
        },
      }),
    } as unknown as OrbitDB

    const result = await readLocalInventory(stub)

    expect(result).toEqual({ ok: false, reason: 'local-throw' })
  })
})

describe('count diffs', () => {
  const local: LocalInventory = {
    counts: { habits: 2 },
    ids: { habits: ['a', 'b'] },
  }
  const manifest: CloudManifest = {
    counts: { habits: 3 },
    ids: { habits: ['b', 'c', 'd'] },
    latestSeq: 9,
  }

  it('localOnlyIds keeps local order and omits empty entities', () => {
    expect(localOnlyIds(local, manifest)).toEqual({ habits: ['a'] })
  })

  it('serverOnlyIdsFromManifest keeps manifest order and omits empty entities', () => {
    expect(serverOnlyIdsFromManifest(local, manifest)).toEqual({ habits: ['c', 'd'] })
  })

  it('totalIds sums every list', () => {
    expect(totalIds({ habits: ['a', 'b'], categories: ['x'] })).toBe(3)
    expect(totalIds({})).toBe(0)
  })
})

describe('date and device formatting', () => {
  it('formats a snapshot day without a year when it matches now', () => {
    expect(formatSnapshotDate('2026-11-02', new Date('2026-11-02T12:00:00.000Z'))).toBe('11月2日')
  })

  it('prefixes the year when the snapshot crosses a year boundary', () => {
    expect(formatSnapshotDate('2025-12-31', new Date('2026-01-02T12:00:00.000Z'))).toBe(
      '2025年12月31日',
    )
  })

  it('returns an empty string for an invalid day key', () => {
    expect(formatSnapshotDate('not-a-day', new Date('2026-11-02T12:00:00.000Z'))).toBe('')
  })

  it('formats a diagnostic timestamp as M月D日 HH:mm', () => {
    expect(formatDiagnosticTime('2026-11-02T05:07:00.000Z')).toBe('11月2日 05:07')
  })

  it('returns an empty string for an invalid timestamp', () => {
    expect(formatDiagnosticTime('not-a-date')).toBe('')
  })

  it('formats device last-seen as 从未活跃 or a relative phrase', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z')
    expect(formatDeviceLastSeen(null, now)).toBe('从未活跃')
    expect(formatDeviceLastSeen('2026-11-02T11:40:00.000Z', now)).toBe('最后活跃 20 分钟前')
    expect(formatDeviceLastSeen('not-a-date', now)).toBe('')
  })
})

describe('sanitizeQuarantineReason', () => {
  it('passes a safe machine code through', () => {
    expect(sanitizeQuarantineReason('push-http-4xx', 'http_4xx')).toBe('http_4xx')
    expect(sanitizeQuarantineReason('pull-invalid', 'schema_mismatch')).toBe('schema_mismatch')
  })

  it('replaces a reason containing row content with the kind fallback', () => {
    expect(
      sanitizeQuarantineReason('pull-invalid', '字段 name 的值 "私密目标" 无效'),
    ).toBe('pull_invalid')
  })

  it('replaces an over-long code with the kind fallback', () => {
    expect(sanitizeQuarantineReason('push-rejected', 'a'.repeat(65))).toBe('push_rejected')
  })

  it('maps every kind to its fixed fallback', () => {
    expect(sanitizeQuarantineReason('pull-invalid', '!!!')).toBe('pull_invalid')
    expect(sanitizeQuarantineReason('push-invalid', '!!!')).toBe('push_invalid')
    expect(sanitizeQuarantineReason('push-rejected', '!!!')).toBe('push_rejected')
    expect(sanitizeQuarantineReason('push-oversize', '!!!')).toBe('payload_too_large')
    expect(sanitizeQuarantineReason('push-http-4xx', '!!!')).toBe('http_4xx')
  })
})

describe('quarantine clearing', () => {
  it('replaces the stored quarantine with an empty array', async () => {
    const db = open()
    await appendQuarantine(db, {
      kind: 'pull-invalid',
      entity: 'habits',
      reason: 'invalid_field',
      at: '2026-11-01T00:00:00.000Z',
    })
    expect(await listQuarantine(db)).toHaveLength(1)

    await clearQuarantineEntries(db)

    expect(await getSyncValue(db, QUARANTINE_KEY, null)).toBe('[]')
    expect(await listQuarantine(db)).toEqual([])
  })
})

describe('protocol constants', () => {
  it('locks the client protocol version and mismatch rule', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(1)
    expect(isServerVersionMismatch(1)).toBe(false)
    expect(isServerVersionMismatch(2)).toBe(true)
  })

  it('matches the 21-UI-SPEC error copy character for character', () => {
    expect(SERVER_ERROR_COPY).toEqual({
      auth: '登录已过期，请重新登录。',
      network: '无法连接服务器，请检查网络。',
      server: '服务器暂时不可用，请稍后再试。',
      malformed: '服务器返回的数据无法识别。请稍后重试。',
      unknown: '读取失败，请稍后重试。',
    })
  })
})
