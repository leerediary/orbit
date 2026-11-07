import type { OrbitDB } from '@/lib/local-db'
import { EXPORT_ENTITIES } from '@/lib/data-export'
import { countOutbox } from '@/lib/outbox'
import { QUARANTINE_KEY, listQuarantine, type QuarantineEntry } from '@/lib/sync-quarantine'
import { SYNC_KEYS, getSyncCursor, getSyncValue, setSyncValue } from '@/lib/sync-store'
import { formatSyncRelative } from '@/lib/sync-time'

/**
 * Phase 21 / OPS-01 — diagnostics read model.
 *
 * Pure client-side reads behind `SyncDiagnosticsSheet`. Importing this module
 * touches no React and no browser global at module scope, so it is safe during
 * the static-export prerender and unit-testable under Node + fake-indexeddb.
 *
 * Hard rule (21-UI-SPEC §2): a failed read is ALWAYS a typed failure. It must
 * never collapse into a zero-filled snapshot or an empty list, because that
 * would render "0 items" over real data and invite a destructive resync.
 */

export const CLIENT_PROTOCOL_VERSION = 1

export type ServerErrorReason = 'auth' | 'network' | 'server' | 'malformed' | 'unknown'

/** The shared server-error map from 21-UI-SPEC, character for character. */
export const SERVER_ERROR_COPY: Record<ServerErrorReason, string> = {
  auth: '登录已过期，请重新登录。',
  network: '无法连接服务器，请检查网络。',
  server: '服务器暂时不可用，请稍后再试。',
  malformed: '服务器返回的数据无法识别。请稍后重试。',
  unknown: '读取失败，请稍后重试。',
}

export function isServerVersionMismatch(version: number): boolean {
  return version !== CLIENT_PROTOCOL_VERSION
}

/** Per-entity live counts / live ids. Keys are normalized to every entity. */
export type EntityCountMap = Record<string, number>
export type EntityIdMap = Record<string, string[]>

export interface LocalInventory {
  counts: EntityCountMap
  ids: EntityIdMap
}

export interface CloudManifest {
  counts: EntityCountMap
  ids: EntityIdMap
  latestSeq: number
}

export interface DiagnosticsSnapshot {
  cursor: number
  outboxCount: number
  quarantine: QuarantineEntry[]
  /** Raw stored code or null — the panel shows it verbatim. */
  lastError: string | null
}

export type DiagnosticsRead =
  | { ok: true; snapshot: DiagnosticsSnapshot }
  | { ok: false; reason: 'local-throw' }

export type ServerVersionRead =
  | { ok: true; version: number }
  | { ok: false; reason: ServerErrorReason }

export type CloudManifestRead =
  | { ok: true; manifest: CloudManifest }
  | { ok: false; reason: ServerErrorReason }

export type LocalInventoryRead =
  | { ok: true; inventory: LocalInventory }
  | { ok: false; reason: 'local-throw' }

type FetchFn = (path: string, init?: RequestInit) => Promise<Response>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function classifyStatus(status: number): ServerErrorReason {
  if (status === 401) return 'auth'
  if (status >= 500) return 'server'
  return 'unknown'
}

function emptyCounts(): EntityCountMap {
  const out: EntityCountMap = {}
  for (const entity of EXPORT_ENTITIES) out[entity] = 0
  return out
}

function emptyIds(): EntityIdMap {
  const out: EntityIdMap = {}
  for (const entity of EXPORT_ENTITIES) out[entity] = []
  return out
}

/**
 * Read the four local diagnostics values in one shot. Any rejection returns
 * `local-throw`; a partial or zero-filled snapshot is never produced.
 */
export async function readDiagnostics(db: OrbitDB): Promise<DiagnosticsRead> {
  try {
    const [cursor, outboxCount, quarantine, lastError] = await Promise.all([
      getSyncCursor(db),
      countOutbox(db),
      listQuarantine(db),
      getSyncValue<string | null>(db, SYNC_KEYS.lastError, null),
    ])
    return { ok: true, snapshot: { cursor, outboxCount, quarantine, lastError } }
  } catch {
    return { ok: false, reason: 'local-throw' }
  }
}

/** `GET /v1/status` → the server protocol version. */
export async function readServerVersion(fetchFn: FetchFn): Promise<ServerVersionRead> {
  let res: Response
  try {
    res = await fetchFn('/v1/status')
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!isPlainObject(body)) return { ok: false, reason: 'malformed' }
  const version = body.version
  if (!isFiniteNonNegative(version)) return { ok: false, reason: 'malformed' }
  return { ok: true, version }
}

/**
 * `GET /v1/sync/manifest?ids=1` → validated counts, ids and latest_seq.
 *
 * Missing entity keys normalize to `0` / `[]` ONLY when the container objects
 * are valid; any wrong type fails the whole read as `malformed`. The response
 * body is never sliced, logged, or otherwise exposed.
 */
export async function readCloudManifest(fetchFn: FetchFn): Promise<CloudManifestRead> {
  let res: Response
  try {
    res = await fetchFn('/v1/sync/manifest?ids=1')
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (!res.ok) return { ok: false, reason: classifyStatus(res.status) }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!isPlainObject(body)) return { ok: false, reason: 'malformed' }
  const rawCounts = body.counts
  const rawIds = body.ids
  if (!isPlainObject(rawCounts) || !isPlainObject(rawIds)) {
    return { ok: false, reason: 'malformed' }
  }

  const counts = emptyCounts()
  for (const entity of EXPORT_ENTITIES) {
    const value = rawCounts[entity]
    if (value === undefined) continue
    if (!isFiniteNonNegative(value)) return { ok: false, reason: 'malformed' }
    counts[entity] = value
  }

  const ids = emptyIds()
  for (const entity of EXPORT_ENTITIES) {
    const value = rawIds[entity]
    if (value === undefined) continue
    if (!Array.isArray(value)) return { ok: false, reason: 'malformed' }
    if (value.some((id) => typeof id !== 'string' || id.length === 0)) {
      return { ok: false, reason: 'malformed' }
    }
    ids[entity] = [...(value as string[])]
  }

  const latestSeq = body.latest_seq
  if (!isFiniteNonNegative(latestSeq)) return { ok: false, reason: 'malformed' }

  return { ok: true, manifest: { counts, ids, latestSeq } }
}

/**
 * Read every entity table once and keep live rows (`deleted_at == null`) with a
 * usable string id. A throw from any table fails the whole inventory.
 */
export async function readLocalInventory(db: OrbitDB): Promise<LocalInventoryRead> {
  const counts = emptyCounts()
  const ids = emptyIds()

  try {
    for (const entity of EXPORT_ENTITIES) {
      const rows = (await db.table(entity).toArray()) as Array<Record<string, unknown>>
      for (const row of rows) {
        if (row.deleted_at != null) continue
        const id = row.id
        if (typeof id !== 'string' || id.length === 0) continue
        counts[entity] += 1
        ids[entity].push(id)
      }
    }
  } catch {
    return { ok: false, reason: 'local-throw' }
  }

  return { ok: true, inventory: { counts, ids } }
}

/** Ids present locally but absent from the manifest, in EXPORT_ENTITIES order. */
export function localOnlyIds(
  local: LocalInventory,
  manifest: CloudManifest,
): Record<string, string[]> {
  return difference(local.ids, manifest.ids)
}

/** Ids present in the manifest but absent locally, in EXPORT_ENTITIES order. */
export function serverOnlyIdsFromManifest(
  local: LocalInventory,
  manifest: CloudManifest,
): Record<string, string[]> {
  return difference(manifest.ids, local.ids)
}

function difference(
  primary: Readonly<EntityIdMap>,
  other: Readonly<EntityIdMap>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const entity of EXPORT_ENTITIES) {
    const otherSet = new Set(other[entity] ?? [])
    const only = (primary[entity] ?? []).filter((id) => !otherSet.has(id))
    if (only.length > 0) out[entity] = only
  }
  return out
}

/** Total number of ids across an entity list map. */
export function totalIds(map: Readonly<Record<string, readonly string[]>>): number {
  let total = 0
  for (const entity of EXPORT_ENTITIES) total += (map[entity] ?? []).length
  return total
}

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A snapshot day as `M月D日`, prefixed with `YYYY年` only when it is not the
 * current year. Invalid input returns an empty string (never `NaN月NaN日`).
 */
export function formatSnapshotDate(dayKey: string, now: Date): string {
  const match = DAY_KEY_PATTERN.exec(dayKey)
  if (!match) return ''

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''

  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return ''
  }

  const base = `${month}月${day}日`
  return year === now.getFullYear() ? base : `${year}年${base}`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** An ISO timestamp as `M月D日 HH:mm` (month/day unpadded, time padded). */
export function formatDiagnosticTime(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const date = new Date(ms)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`
}

/** Device last-seen copy: `从未活跃` for null, else a relative-time phrase. */
export function formatDeviceLastSeen(iso: string | null, nowMs: number): string {
  if (iso === null) return '从未活跃'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return `最后活跃 ${formatSyncRelative(ms, nowMs)}`
}

const SAFE_REASON_PATTERN = /^[a-z0-9_.-]{1,64}$/

const QUARANTINE_FALLBACK: Record<QuarantineEntry['kind'], string> = {
  'pull-invalid': 'pull_invalid',
  'push-invalid': 'push_invalid',
  'push-rejected': 'push_rejected',
  'push-oversize': 'payload_too_large',
  'push-http-4xx': 'http_4xx',
}

/**
 * Hard-red-line guard for quarantine text. Only a short machine code is shown
 * verbatim; anything else — including a validation message that embeds a record
 * value — is replaced by a fixed per-kind fallback.
 */
export function sanitizeQuarantineReason(
  kind: QuarantineEntry['kind'],
  reason: string,
): string {
  return SAFE_REASON_PATTERN.test(reason) ? reason : QUARANTINE_FALLBACK[kind]
}

/** Clear the diagnostic quarantine in one write. Never retries or edits data. */
export async function clearQuarantineEntries(db: OrbitDB): Promise<void> {
  await setSyncValue(db, QUARANTINE_KEY, '[]')
}
