import type { OrbitDB } from '@/lib/local-db'
import type { SyncEntity } from '@/lib/sync-entities'
import { getSyncValue, setSyncValue } from '@/lib/sync-store'

/**
 * Persisted quarantine for rows that can never sync (plan 18-03 / B6 / I11).
 *
 * Quarantine entries are diagnostic only. They live in the `syncState` side
 * table (key `quarantine`) as a JSON string, so they never enter
 * `EXPORT_ENTITIES` and never affect the orbit-export v7 contract. Nothing
 * deletes them automatically: a bad pulled row or a permanently rejected push
 * row is skipped by the engine (the cursor still advances) but its payload is
 * preserved here for inspection.
 */

export interface QuarantineEntry {
  kind: 'pull-invalid' | 'push-invalid' | 'push-rejected' | 'push-oversize' | 'push-http-4xx'
  entity: SyncEntity
  id?: string
  /** The server-side `server_seq` of a pulled row that failed validation. */
  serverSeq?: number
  reason: string
  /** ISO timestamp when the row was quarantined. */
  at: string
}

export const QUARANTINE_KEY = 'quarantine'

/** Bounded so a pathological server cannot grow the key without limit. */
const MAX_QUARANTINE = 500

export async function listQuarantine(d: OrbitDB): Promise<QuarantineEntry[]> {
  const raw = await getSyncValue<string>(d, QUARANTINE_KEY, '[]')
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QuarantineEntry[]) : []
  } catch {
    // A corrupt value must never break sync — treat it as empty.
    return []
  }
}

export async function countQuarantine(d: OrbitDB): Promise<number> {
  return (await listQuarantine(d)).length
}

/** Append one entry, keeping the newest 500. */
export async function appendQuarantine(d: OrbitDB, entry: QuarantineEntry): Promise<void> {
  const existing = await listQuarantine(d)
  const next = [...existing, entry]
  const bounded = next.length > MAX_QUARANTINE ? next.slice(next.length - MAX_QUARANTINE) : next
  await setSyncValue(d, QUARANTINE_KEY, JSON.stringify(bounded))
}
