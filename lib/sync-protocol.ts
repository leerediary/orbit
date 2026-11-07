import type { SyncEntity } from '@/lib/sync-entities'

/**
 * Wire protocol for `/v1/sync/push` and `/v1/sync/pull` (plan 18-02).
 *
 * Dependency-free on purpose: no React, no Dexie, no server package. The
 * constants MUST mirror `server/src/sync.ts` — the client chunks requests to
 * stay inside the server's limits instead of discovering them via a 400/413.
 */

export type PushOp = 'upsert' | 'delete' | 'purge'

export interface PushChange {
  entity: SyncEntity
  id: string
  op: PushOp
  updated_at: string
  deleted_at: string | null
  /** `null` for a purge — the row is gone, so there is nothing to send (MERGE-04). */
  data: Record<string, unknown> | null
}

export interface PullChange {
  entity: SyncEntity
  id: string
  server_seq: number
  /**
   * The change kind, so the client can branch on one field (RESEARCH §2).
   * A purge projects as `{ op: 'purge', data: null, updated_at: null,
   * deleted_at: null, device_id }`.
   */
  op: PushOp
  /** `null` on a purge; the writer's timestamp on a row change. */
  updated_at: string | null
  deleted_at: string | null
  data: Record<string, unknown> | null
  /** Writer device of the change; `null` when the server has no device id. */
  device_id: string | null
}

export type PushResult =
  | {
      entity: SyncEntity
      id: string
      status: 'applied'
      server_seq: number
      /** Set when a journal natural-key merge landed the row under another id (MERGE-02). */
      merged_into?: string
    }
  | { entity: SyncEntity; id: string; status: 'lost'; current: PullChange | null }
  | { entity: SyncEntity; id: string; status: 'rejected'; error: string }

export interface PushResponse {
  version: 1
  results: PushResult[]
}

export interface PullResponse {
  version: 1
  changes: PullChange[]
  next_cursor: number
  has_more: boolean
}

/**
 * Push request body. `allow_bulk_delete` is a one-shot, user-confirmed
 * permission for a destructive drain; it is never persisted and is omitted
 * (never sent as `false`) unless raised. `declared_delete_total` is the total
 * delete/purge intent count for the whole logical drain, sent on every chunk so
 * a split delete cannot slip its first chunk past the server guard (BOOT-04).
 */
export interface PushRequestBody {
  device_id: string
  changes: PushChange[]
  allow_bulk_delete?: boolean
  declared_delete_total?: number
}

export type SyncErrorKind = 'offline' | 'server' | 'auth' | 'bulk' | 'unknown'

/** Mirror of server/src/sync.ts limits (plan 18-02). */
export const MAX_PUSH_CHANGES = 200
export const MAX_SYNC_BODY_BYTES = 2 * 1024 * 1024
/** Server-side per-row payload cap (`MAX_PAYLOAD_BYTES` in server/src/validate.ts). */
export const MAX_ROW_BYTES = 256 * 1024
/** Server default page size; within the accepted [1, 1000] range. */
export const PULL_LIMIT = 500
/** Consecutive rejections before a row is quarantined out of the retry loop. */
export const MAX_REJECTIONS = 3
