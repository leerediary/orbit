import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SYNC_UI_ENABLED,
  isBootstrapActive,
  isSyncBadgeVisible,
  isSyncUiVisible,
} from '../lib/sync-config'
import { BUILD_VERSION } from '../lib/build-version'

/**
 * The badge gate is the only thing standing between a public mirror build and
 * the sync UI (T-18-28/T-18-42): it is pure and DOM-free so the full truth table
 * is provable here. The same file also guards the SW lockstep bump (T-18-32).
 */

const policySource = readFileSync(new URL('../public/sw-policy.js', import.meta.url), 'utf-8')
const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf-8')

function cacheVersion(): string | undefined {
  return policySource.match(/CACHE_VERSION:\s*'([^']+)'/)?.[1]
}

function swBuild(): string | undefined {
  return swSource.match(/const SW_BUILD = '([^']+)'/)?.[1]
}

const ALL_VISIBLE = {
  mounted: true,
  enabled: true,
  configured: true,
  signedIn: true,
  bootstrapped: true,
  paused: false,
}

describe('sync-config: badge visibility gate', () => {
  it('ships enabled as of the 20-12 two-device sign-off', () => {
    // Plan 20-12 owns the one-line flip to true after two-device sign-off.
    expect(SYNC_UI_ENABLED).toBe(true)
  })

  it('is visible only when all six inputs satisfy the gate', () => {
    expect(isSyncBadgeVisible(ALL_VISIBLE)).toBe(true)
  })

  it.each(['mounted', 'enabled', 'configured', 'signedIn', 'bootstrapped'] as const)(
    'renders null when %s is false',
    (key) => {
      expect(isSyncBadgeVisible({ ...ALL_VISIBLE, [key]: false })).toBe(false)
    },
  )

  it('renders null while paused even after bootstrap', () => {
    expect(isSyncBadgeVisible({ ...ALL_VISIBLE, paused: true })).toBe(false)
  })

  it('flips from hidden to visible when the session appears (B1 same-page login)', () => {
    const signedOut = { ...ALL_VISIBLE, signedIn: false }
    expect(isSyncBadgeVisible(signedOut)).toBe(false)
    // The auth-change seam flips only `signedIn`; a reload is not required.
    expect(isSyncBadgeVisible({ ...signedOut, signedIn: true })).toBe(true)
  })

  it('stays hidden for an unconfigured public-mirror build', () => {
    expect(isSyncBadgeVisible({ ...ALL_VISIBLE, configured: false })).toBe(false)
  })
})

describe('sync-config: Settings cloud block visibility', () => {
  const ALL_VISIBLE_UI = { enabled: true, configured: true, signedIn: true }

  it('is visible only when enabled, configured and signed in', () => {
    expect(isSyncUiVisible(ALL_VISIBLE_UI)).toBe(true)
  })

  it.each(['enabled', 'configured', 'signedIn'] as const)(
    'is hidden when %s is false',
    (key) => {
      expect(isSyncUiVisible({ ...ALL_VISIBLE_UI, [key]: false })).toBe(false)
    },
  )
})

describe('sync-config: bootstrap activation gate', () => {
  const ACTIVE = {
    enabled: true,
    configured: true,
    signedIn: true,
    bootstrapped: false,
    paused: false,
  }

  it('is active only when all five inputs satisfy the gate', () => {
    expect(isBootstrapActive(ACTIVE)).toBe(true)
  })

  it('is inactive once bootstrapped', () => {
    expect(isBootstrapActive({ ...ACTIVE, bootstrapped: true })).toBe(false)
  })

  it('is inactive while paused', () => {
    expect(isBootstrapActive({ ...ACTIVE, paused: true })).toBe(false)
  })

  it.each(['enabled', 'configured', 'signedIn'] as const)(
    'is inactive when %s is false',
    (key) => {
      expect(isBootstrapActive({ ...ACTIVE, [key]: false })).toBe(false)
    },
  )
})

describe('sync-config: SW build lockstep', () => {
  it('bumps both CACHE_VERSION and SW_BUILD to BUILD_VERSION', () => {
    expect(cacheVersion()).toBe(BUILD_VERSION)
    expect(swBuild()).toBe(BUILD_VERSION)
  })

  it('keeps the two versions equal', () => {
    expect(cacheVersion()).toBe(swBuild())
  })
})
