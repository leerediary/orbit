import { describe, expect, it } from 'vitest'
import { EXPORT_ENTITIES } from '@/lib/data-export'
import {
  detectBranch,
  ENTITY_LABELS,
  ENTITY_ORDER,
  needsBootstrap,
  requiresSecondConfirm,
  serverOnlyIds,
  totalCounts,
  type BootstrapCounts,
} from '@/lib/sync-bootstrap'

/**
 * Phase 20 / plan 20-01 — the pure branch/error state machine. BOOT-02's core
 * rule is proven here before any UI exists: a failed read is ALWAYS ERROR and
 * can never be mistaken for an empty dataset (T-20-02).
 */

function zeroCounts(): BootstrapCounts {
  return Object.fromEntries(EXPORT_ENTITIES.map((entity) => [entity, 0])) as BootstrapCounts
}

function counts(overrides: Partial<BootstrapCounts> = {}): BootstrapCounts {
  return { ...zeroCounts(), ...overrides }
}

const FAILURE_REASONS = ['auth', 'network', 'server', 'malformed', 'local-throw'] as const

describe('sync-bootstrap: detectBranch error precedence', () => {
  it.each(FAILURE_REASONS)(
    'maps a %s local failure to ERROR without exposing counts',
    (reason) => {
      const read = { ok: false as const, where: 'local' as const, reason }
      const branch = detectBranch(read)

      expect(branch.kind).toBe('ERROR')
      expect(branch).toEqual({ kind: 'ERROR', read })
      expect('localLive' in branch).toBe(false)
      expect('serverLive' in branch).toBe(false)
    },
  )

  it.each(FAILURE_REASONS)(
    'maps a %s server failure to ERROR without exposing counts',
    (reason) => {
      const branch = detectBranch({ ok: false, where: 'server', reason })
      expect(branch.kind).toBe('ERROR')
      expect('localLive' in branch).toBe(false)
    },
  )
})

describe('sync-bootstrap: detectBranch classification', () => {
  it('returns D when both totals are exactly zero', () => {
    expect(detectBranch({ ok: true, local: counts(), server: counts() })).toEqual({
      kind: 'D',
    })
  })

  it('returns A when only local has live rows', () => {
    expect(
      detectBranch({ ok: true, local: counts({ goals: 2 }), server: counts() }),
    ).toEqual({ kind: 'A', localLive: 2 })
  })

  it('returns B when only the server has live rows', () => {
    expect(
      detectBranch({ ok: true, local: counts(), server: counts({ tasks: 4 }) }),
    ).toEqual({ kind: 'B', serverLive: 4 })
  })

  it('returns C when both sides have live rows', () => {
    expect(
      detectBranch({
        ok: true,
        local: counts({ categories: 1 }),
        server: counts({ habits: 3 }),
      }),
    ).toEqual({ kind: 'C', localLive: 1, serverLive: 3 })
  })
})

describe('sync-bootstrap: entity labels', () => {
  it('has exactly the EXPORT_ENTITIES keys in the same order', () => {
    expect(Object.keys(ENTITY_LABELS)).toEqual([...EXPORT_ENTITIES])
  })

  it('uses the locked Chinese labels in order', () => {
    expect(EXPORT_ENTITIES.map((entity) => ENTITY_LABELS[entity])).toEqual([
      '分类',
      '目标',
      '里程碑',
      '任务',
      '今日待办',
      '日记',
      '习惯',
      '打卡',
      '番茄',
    ])
  })

  it('exposes the ordered entity array', () => {
    expect([...ENTITY_ORDER]).toEqual([...EXPORT_ENTITIES])
  })
})

describe('sync-bootstrap: counting helpers', () => {
  it('totalCounts sums all nine entities', () => {
    expect(totalCounts(counts({ categories: 1, goals: 2, tasks: 3, pomodoroSessions: 5 }))).toBe(
      11,
    )
  })

  it('serverOnlyIds preserves server order and excludes local ids', () => {
    expect(serverOnlyIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(serverOnlyIds([], ['b'])).toEqual([])
  })

  it('requires a second confirm only for the destructive choices', () => {
    expect(requiresSecondConfirm('keep-both')).toBe(false)
    expect(requiresSecondConfirm('use-local')).toBe(true)
    expect(requiresSecondConfirm('use-cloud')).toBe(true)
  })

  it('re-exports needsBootstrap', () => {
    expect(needsBootstrap({ complete: true, accountId: 'u', currentSub: 'u' })).toBe(false)
  })
})
