import type { Repository } from '@/lib/repository'
import { LocalRepository } from '@/lib/local-repository'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'

/**
 * The ONE place that decides the active Repository implementation.
 *
 * Web build → Dexie/IndexedDB `LocalRepository` (the source of truth).
 * Native build → `SqliteLocalRepository`, selected when `window.orbitBridge` is
 * present at runtime (injected by a future native shell). Runtime presence is
 * the single signal — no build-time env var.
 *
 * No cloud/sync wrapper: pure local-first (D-06). The branch is Dexie-vs-SQLite
 * only.
 *
 * IMPORTANT: every Repository call MUST happen inside a client effect/handler —
 * never at module scope or during render. Build-time prerender runs in Node
 * with no IndexedDB (see lib/local-db.ts) and no `window` (see
 * lib/sqlite-bridge.ts).
 */
export let instance: Repository | null = null

export function getRepository(): Repository {
  if (!instance) {
    const isNative = typeof window !== 'undefined' && !!window.orbitBridge
    instance = isNative ? new SqliteLocalRepository() : new LocalRepository()
  }
  return instance
}

/**
 * Typed accessor for the local-only primitives (bulkLoad, bulkLoadAll,
 * replaceAll, hardDelete) that aren't on the Repository interface. Centralizes
 * the cast.
 *
 * Same discipline as getRepository(): only call inside an effect/handler — never
 * at module scope or render time.
 */
export function getLocalRepository(): LocalRepository {
  return getRepository() as unknown as LocalRepository
}
