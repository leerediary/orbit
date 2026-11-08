import { EXPORT_ENTITIES } from '@/lib/data-export'
import type { Entity } from '@/lib/repository'

/**
 * Client-side sync registry. Derived, never hand-written, so it cannot drift
 * from the export contract (D-12). The 9 names must equal the Dexie table set;
 * test/sync-entities.test.ts enforces both, and test/registry-parity.test.ts
 * keeps it equal to the server allow-list (server/src/entities.ts).
 */
export const SYNC_ENTITIES = EXPORT_ENTITIES satisfies readonly Entity[]

export type SyncEntity = (typeof SYNC_ENTITIES)[number]
