import { describe, expect, it, vi } from 'vitest'
import {
  fetchDevices,
  fetchSnapshots,
  restoreSnapshot,
  revokeDevice,
  type DeviceInfo,
  type SnapshotInfo,
} from '@/lib/sync-ops-client'

/**
 * Phase 21 / OPS-02 — typed snapshot and device API client.
 *
 * The diagnostics surface renders only `{date,total}` and safe device metadata.
 * These tests pin the two invariants that keep that safe: an untrusted envelope
 * must fail as `malformed` (never an empty list), and no request carries a body
 * user id — the server binds the JWT `sub`.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchCall = [path: string, init?: RequestInit]

function scripted(factory: (path: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push([path, init])
    return factory(path, init)
  })
  return { fn, calls }
}

const snapshots: SnapshotInfo[] = [
  { date: '2026-11-02', total: 12 },
  { date: '2026-11-01', total: 0 },
]

const devices: DeviceInfo[] = [
  { id: 'dev-a', name: 'MacBook', last_seen_at: '2026-11-02T06:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' },
  { id: 'dev-b', name: null, last_seen_at: null, created_at: '2026-10-02T00:00:00.000Z' },
]

describe('fetchSnapshots', () => {
  it('returns validated snapshots from the list envelope', async () => {
    const { fn, calls } = scripted(() =>
      jsonResponse({ version: 1, snapshots }),
    )

    await expect(fetchSnapshots(fn)).resolves.toEqual({ ok: true, snapshots })
    expect(calls[0]?.[0]).toBe('/v1/snapshots')
  })

  it('fails the whole read as malformed when a date is not YYYY-MM-DD', async () => {
    const { fn } = scripted(() =>
      jsonResponse({
        version: 1,
        snapshots: [{ date: '2026/11/02', total: 1 }],
      }),
    )

    await expect(fetchSnapshots(fn)).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('fails as malformed when a total is negative or not an integer', async () => {
    const negative = scripted(() =>
      jsonResponse({ version: 1, snapshots: [{ date: '2026-11-02', total: -1 }] }),
    )
    const fractional = scripted(() =>
      jsonResponse({ version: 1, snapshots: [{ date: '2026-11-02', total: 1.5 }] }),
    )

    await expect(fetchSnapshots(negative.fn)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    })
    await expect(fetchSnapshots(fractional.fn)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('fails as malformed when snapshots is not an array', async () => {
    const { fn } = scripted(() => jsonResponse({ version: 1, snapshots: null }))
    await expect(fetchSnapshots(fn)).resolves.toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('restoreSnapshot', () => {
  it('posts confirm:true to the encoded date route and echoes the total', async () => {
    const { fn, calls } = scripted(() =>
      jsonResponse({ version: 1, ok: true, date: '2026-11-02', total: 12 }),
    )

    await expect(restoreSnapshot(fn, '2026-11-02')).resolves.toEqual({
      ok: true,
      date: '2026-11-02',
      total: 12,
    })

    const [path, init] = calls[0]!
    expect(path).toBe('/v1/snapshots/2026-11-02/restore')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({ confirm: true })
    expect(String(init?.body)).not.toContain('user_id')
  })

  it('URL-encodes the date segment', async () => {
    const { fn, calls } = scripted(() =>
      jsonResponse({ version: 1, ok: true, date: '2026-11-02', total: 1 }),
    )
    await restoreSnapshot(fn, '2026-11-02?x=1')
    expect(calls[0]?.[0]).toBe('/v1/snapshots/2026-11-02%3Fx%3D1/restore')
  })

  it('maps 401 to auth, a thrown fetch to network and 500 to server', async () => {
    const auth = scripted(() => jsonResponse({ version: 1, error: 'auth' }, 401))
    const thrown = scripted(() => {
      throw new Error('offline')
    })
    const server = scripted(() => jsonResponse({ version: 1, error: 'boom' }, 500))

    await expect(restoreSnapshot(auth.fn, '2026-11-02')).resolves.toEqual({
      ok: false,
      reason: 'auth',
    })
    await expect(restoreSnapshot(thrown.fn, '2026-11-02')).resolves.toEqual({
      ok: false,
      reason: 'network',
    })
    await expect(restoreSnapshot(server.fn, '2026-11-02')).resolves.toEqual({
      ok: false,
      reason: 'server',
    })
  })

  it('maps a non-OK response without a numeric total to unknown/malformed', async () => {
    const notFound = scripted(() => jsonResponse({ version: 1, error: 'not_found' }, 404))
    await expect(restoreSnapshot(notFound.fn, '2026-11-02')).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    })

    const noTotal = scripted(() =>
      jsonResponse({ version: 1, ok: true, date: '2026-11-02' }),
    )
    await expect(restoreSnapshot(noTotal.fn, '2026-11-02')).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})

describe('fetchDevices', () => {
  it('preserves null name and last_seen_at', async () => {
    const { fn, calls } = scripted(() => jsonResponse({ version: 1, devices }))

    await expect(fetchDevices(fn)).resolves.toEqual({ ok: true, devices })
    expect(calls[0]?.[0]).toBe('/v1/devices')
  })

  it('fails the whole read when one device entry is malformed', async () => {
    const badId = scripted(() =>
      jsonResponse({ version: 1, devices: [{ id: '', name: null, last_seen_at: null, created_at: 'x' }] }),
    )
    const badName = scripted(() =>
      jsonResponse({
        version: 1,
        devices: [{ id: 'd', name: 42, last_seen_at: null, created_at: 'x' }],
      }),
    )
    const badCreated = scripted(() =>
      jsonResponse({
        version: 1,
        devices: [{ id: 'd', name: null, last_seen_at: null, created_at: null }],
      }),
    )

    await expect(fetchDevices(badId.fn)).resolves.toEqual({ ok: false, reason: 'malformed' })
    await expect(fetchDevices(badName.fn)).resolves.toEqual({ ok: false, reason: 'malformed' })
    await expect(fetchDevices(badCreated.fn)).resolves.toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('revokeDevice', () => {
  it('sends confirm:true plus current_device_id and returns ok', async () => {
    const { fn, calls } = scripted(() => jsonResponse({ version: 1, ok: true, revoked: 1 }))

    await expect(revokeDevice(fn, 'dev-b', 'dev-a')).resolves.toEqual({ ok: true })

    const [path, init] = calls[0]!
    expect(path).toBe('/v1/devices/dev-b/revoke')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ confirm: true, current_device_id: 'dev-a' })
    expect(body).not.toHaveProperty('user_id')
  })

  it('URL-encodes the device id segment', async () => {
    const { fn, calls } = scripted(() => jsonResponse({ version: 1, ok: true, revoked: 1 }))
    await revokeDevice(fn, 'dev/b', 'dev-a')
    expect(calls[0]?.[0]).toBe('/v1/devices/dev%2Fb/revoke')
  })

  it('maps cannot_revoke_current_device 400 to its distinct failure', async () => {
    const { fn } = scripted(() =>
      jsonResponse({ version: 1, error: 'cannot_revoke_current_device' }, 400),
    )
    await expect(revokeDevice(fn, 'dev-a', 'dev-a')).resolves.toEqual({
      ok: false,
      reason: 'cannot-revoke-current',
    })
  })

  it('maps any other 400 to unknown and 401/5xx/throw as usual', async () => {
    const other400 = scripted(() => jsonResponse({ version: 1, error: 'confirm_required' }, 400))
    const auth = scripted(() => jsonResponse({ version: 1, error: 'auth' }, 401))
    const server = scripted(() => jsonResponse({ version: 1, error: 'boom' }, 500))
    const thrown = scripted(() => {
      throw new Error('offline')
    })

    await expect(revokeDevice(other400.fn, 'dev-b', 'dev-a')).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    })
    await expect(revokeDevice(auth.fn, 'dev-b', 'dev-a')).resolves.toEqual({
      ok: false,
      reason: 'auth',
    })
    await expect(revokeDevice(server.fn, 'dev-b', 'dev-a')).resolves.toEqual({
      ok: false,
      reason: 'server',
    })
    await expect(revokeDevice(thrown.fn, 'dev-b', 'dev-a')).resolves.toEqual({
      ok: false,
      reason: 'network',
    })
  })
})
