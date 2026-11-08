import type { ServerErrorReason } from '@/lib/sync-diagnostics'

/**
 * Phase 21 / OPS-02 — typed snapshot and device API client.
 *
 * Two hard rules live here (21-UI-SPEC §4–§5, T-21-07-01/04/05):
 *  - Every server envelope is validated before it reaches a render tree. A bad
 *    entry fails the WHOLE read as `malformed`; it never becomes a partial list
 *    or an empty one.
 *  - No request body ever carries a caller-supplied user id. The server binds
 *    the JWT `sub`; the only identity field sent is `current_device_id`, which is
 *    the advisory self-revoke guard.
 *
 * Importing this module touches no React, Dexie or browser global — it is only
 * a `fetch`-shaped function plus pure validation, so it is safe during the
 * static-export prerender and trivially unit-testable.
 */

type FetchFn = (path: string, init?: RequestInit) => Promise<Response>

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface SnapshotInfo {
  date: string
  total: number
}

export type SnapshotListRead =
  | { ok: true; snapshots: SnapshotInfo[] }
  | { ok: false; reason: ServerErrorReason }

export type SnapshotRestoreRead =
  | { ok: true; date: string; total: number }
  | { ok: false; reason: ServerErrorReason }

export interface DeviceInfo {
  id: string
  name: string | null
  last_seen_at: string | null
  created_at: string
}

export type DeviceListRead =
  | { ok: true; devices: DeviceInfo[] }
  | { ok: false; reason: ServerErrorReason }

export type RevokeFailure = ServerErrorReason | 'cannot-revoke-current'

export type DeviceRevokeRead = { ok: true } | { ok: false; reason: RevokeFailure }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Network throws are handled by callers; this only maps an HTTP status. */
function classifyStatus(status: number): ServerErrorReason {
  if (status === 401) return 'auth'
  if (status >= 500) return 'server'
  return 'unknown'
}

async function readJson(res: Response): Promise<unknown | undefined> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** `GET /v1/snapshots` → `{date,total}` only. A malformed entry fails all. */
export async function fetchSnapshots(fetchFn: FetchFn): Promise<SnapshotListRead> {
  let res: Response
  try {
    res = await fetchFn('/v1/snapshots')
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  const body = await readJson(res)
  if (!isPlainObject(body)) return { ok: false, reason: 'malformed' }

  const raw = body.snapshots
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed' }

  const snapshots: SnapshotInfo[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, reason: 'malformed' }
    const date = item.date
    const total = item.total
    if (typeof date !== 'string' || !DAY_KEY_PATTERN.test(date)) {
      return { ok: false, reason: 'malformed' }
    }
    if (!isFiniteNonNegativeInteger(total)) {
      return { ok: false, reason: 'malformed' }
    }
    snapshots.push({ date, total })
  }

  return { ok: true, snapshots }
}

/** `POST /v1/snapshots/:date/restore` with the mandatory `confirm:true` body. */
export async function restoreSnapshot(
  fetchFn: FetchFn,
  date: string,
): Promise<SnapshotRestoreRead> {
  let res: Response
  try {
    res = await fetchFn(`/v1/snapshots/${encodeURIComponent(date)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  const body = await readJson(res)
  if (!isPlainObject(body)) return { ok: false, reason: 'malformed' }
  if (!isFiniteNonNegativeInteger(body.total)) {
    return { ok: false, reason: 'malformed' }
  }

  return { ok: true, date, total: body.total }
}

/** `GET /v1/devices` → safe session metadata; one bad entry fails all. */
export async function fetchDevices(fetchFn: FetchFn): Promise<DeviceListRead> {
  let res: Response
  try {
    res = await fetchFn('/v1/devices')
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  const body = await readJson(res)
  if (!isPlainObject(body)) return { ok: false, reason: 'malformed' }

  const raw = body.devices
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed' }

  const devices: DeviceInfo[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, reason: 'malformed' }
    const { id, name, last_seen_at: lastSeenAt, created_at: createdAt } = item
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, reason: 'malformed' }
    }
    if (!isStringOrNull(name) || !isStringOrNull(lastSeenAt)) {
      return { ok: false, reason: 'malformed' }
    }
    if (typeof createdAt !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    devices.push({ id, name, last_seen_at: lastSeenAt, created_at: createdAt })
  }

  return { ok: true, devices }
}

/**
 * `POST /v1/devices/:id/revoke` with `{confirm:true, current_device_id}`.
 * The server re-validates ownership against the JWT and rejects a self-revoke;
 * a `cannot_revoke_current_device` 400 surfaces as its own typed failure so the
 * UI can distinguish a real refusal from a generic read failure.
 */
export async function revokeDevice(
  fetchFn: FetchFn,
  deviceId: string,
  currentDeviceId: string,
): Promise<DeviceRevokeRead> {
  let res: Response
  try {
    res = await fetchFn(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, current_device_id: currentDeviceId }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (res.status === 400) {
    const body = await readJson(res)
    if (isPlainObject(body) && body.error === 'cannot_revoke_current_device') {
      return { ok: false, reason: 'cannot-revoke-current' }
    }
    return { ok: false, reason: 'unknown' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  return { ok: true }
}
