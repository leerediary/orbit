import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import {
  getBootstrapAccountId,
  getBootstrapComplete,
  getDatasetEpoch,
  isSyncPaused,
  needsBootstrap,
  notifySyncMetadata,
  setBootstrapAccountId,
  setBootstrapComplete,
  setDatasetEpoch,
  setSyncPaused,
  subscribeSyncMetadata,
} from '@/lib/sync-store'

/**
 * Phase 20 / plan 20-01 — bootstrap metadata in the existing `syncState` KV
 * store. Every accessor must fall back to a safe default on a fresh store so a
 * device that has never bootstrapped can never be misread as bootstrapped.
 */

const opened: OrbitDB[] = []

function freshDb(): OrbitDB {
  const name = `orbit-sync-metadata-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const database = new OrbitDB(name)
  opened.push(database)
  return database
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    await database.delete().catch(() => {})
  }
})

describe('sync metadata: bootstrap defaults', () => {
  it('falls back to false / null / 0 / false on a fresh store', async () => {
    const d = freshDb()
    expect(await getBootstrapComplete(d)).toBe(false)
    expect(await getBootstrapAccountId(d)).toBeNull()
    expect(await getDatasetEpoch(d)).toBe(0)
    expect(await isSyncPaused(d)).toBe(false)
  })

  it('round-trips every bootstrap value', async () => {
    const d = freshDb()
    await setBootstrapComplete(d, true)
    await setBootstrapAccountId(d, 'user-1')
    await setDatasetEpoch(d, 3)
    await setSyncPaused(d, true)

    expect(await getBootstrapComplete(d)).toBe(true)
    expect(await getBootstrapAccountId(d)).toBe('user-1')
    expect(await getDatasetEpoch(d)).toBe(3)
    expect(await isSyncPaused(d)).toBe(true)
  })

  it('clears the account id back to null', async () => {
    const d = freshDb()
    await setBootstrapAccountId(d, 'user-1')
    await setBootstrapAccountId(d, null)
    expect(await getBootstrapAccountId(d)).toBeNull()
  })
})

describe('sync metadata: needsBootstrap', () => {
  it('is true when complete is false', () => {
    expect(
      needsBootstrap({ complete: false, accountId: 'user-1', currentSub: 'user-1' }),
    ).toBe(true)
  })

  it('is true when there is no current subject', () => {
    expect(needsBootstrap({ complete: true, accountId: 'user-1', currentSub: null })).toBe(
      true,
    )
  })

  it('is true when the account differs from the current subject', () => {
    expect(
      needsBootstrap({ complete: true, accountId: 'user-1', currentSub: 'user-2' }),
    ).toBe(true)
  })

  it('is true when the stored account id is null', () => {
    expect(needsBootstrap({ complete: true, accountId: null, currentSub: 'user-1' })).toBe(
      true,
    )
  })

  it('is false only when complete and the accounts match', () => {
    expect(
      needsBootstrap({ complete: true, accountId: 'user-1', currentSub: 'user-1' }),
    ).toBe(false)
  })
})

describe('sync metadata: listeners', () => {
  it('receives a notification and stops after unsubscribe', () => {
    const seen: number[] = []
    const unsubscribe = subscribeSyncMetadata(() => seen.push(1))

    notifySyncMetadata()
    expect(seen).toHaveLength(1)

    unsubscribe()
    notifySyncMetadata()
    expect(seen).toHaveLength(1)
  })
})
