import { describe, expect, it } from 'vitest'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'
import type { OrbitBridge } from '@/lib/sqlite-bridge'

/**
 * WR-02 guard: a transient schema-bootstrap failure must not permanently
 * poison the module-scoped `schemaReady` promise. The next call retries.
 *
 * This lives in its own file because vitest isolates module state per test
 * file — the module-scoped promise must start unset.
 */
describe('SqliteLocalRepository schema bootstrap', () => {
  it('retries after a transient failure instead of caching the rejection', async () => {
    let failNext = true
    const bridge: OrbitBridge = {
      async execute() {
        if (failNext) {
          failNext = false
          throw new Error('bridge not ready')
        }
      },
      async query<T>() {
        return [] as T[]
      },
    }
    const repo = new SqliteLocalRepository(bridge)

    await expect(repo.list('goals')).rejects.toThrow('bridge not ready')

    // The cached promise was cleared, so this call re-runs the bootstrap.
    await expect(repo.list('goals')).resolves.toEqual([])
  })
})
