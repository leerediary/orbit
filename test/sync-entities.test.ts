import { describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import { SYNC_ENTITIES } from '@/lib/sync-entities'

/**
 * Phase 16 / SC4 — client sync registry must equal the Dexie 9-store set.
 *
 * A missing entity here means "sync succeeded" while an entire category never
 * syncs, so the registry is derived from EXPORT_ENTITIES and asserted against
 * `db.tables` after open. The export contract itself must stay at v7 (D-13);
 * this test pins the format/version so an accidental bump fails loudly.
 */
describe('sync entity registry', () => {
  // Phase 18 adds two Dexie side stores for the sync engine. They are NOT sync
  // entities (they never leave the device and are excluded from EXPORT_ENTITIES
  // / ALL_ENTITIES), so the registry comparison must ignore them while still
  // proving the nine entity tables match SYNC_ENTITIES exactly.
  const SIDE_TABLES = ['syncOutbox', 'syncState'] as const

  it('exactly matches the Dexie table set (9 stores)', async () => {
    const db = new OrbitDB('orbit-sync-registry-test')
    await db.open()
    try {
      const tableNames = db.tables.map((t) => t.name)
      const entityNames = tableNames
        .filter((name) => !SIDE_TABLES.includes(name as never))
        .sort()
      expect(entityNames).toEqual([...SYNC_ENTITIES].sort())
      expect(SYNC_ENTITIES).toHaveLength(9)
      // Both sync side tables exist and are explicitly excluded above.
      for (const side of SIDE_TABLES) {
        expect(tableNames).toContain(side)
      }
    } finally {
      db.close()
      await db.delete()
    }
  })

  it('keeps the orbit-export contract at v7 byte-for-byte', () => {
    expect(EXPORT_FORMAT).toBe('orbit-export')
    expect(EXPORT_VERSION).toBe(7)
  })
})
