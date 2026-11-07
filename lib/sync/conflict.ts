// Phase 19 / MERGE-01 — the ONE last-write-wins comparator.
//
// Dependency-free on purpose: no React, Dexie, or browser globals. The server
// carries a byte-equivalent mirror in server/src/lww.ts, and
// test/merge-conflict.test.ts asserts the two agree over the same case table.
// Divergent comparators are the exact failure mode this phase forbids.

export interface LwwMeta {
  updated_at: string
  deleted_at: string | null
  device_id: string | null
}

/**
 * True when `incoming` should replace `current`.
 *
 * Order (locked by RESEARCH §4a):
 *  1. Different `updated_at` => the lexicographically greater one wins.
 *  2. Equal `updated_at`: a tombstone beats a live row.
 *  3. Otherwise the lexicographically greater `device_id` wins; null sorts
 *     as '' (lowest).
 *
 * Identical rows return false (neither strictly wins), so replaying a server
 * echo never rewrites the local row.
 */
export function wins(incoming: LwwMeta, current: LwwMeta): boolean {
  if (incoming.updated_at !== current.updated_at) {
    return incoming.updated_at > current.updated_at
  }
  const incomingTombstone = incoming.deleted_at !== null
  const currentTombstone = current.deleted_at !== null
  if (currentTombstone && !incomingTombstone) return false
  if (incomingTombstone && !currentTombstone) return true
  return (incoming.device_id ?? '') > (current.device_id ?? '')
}
