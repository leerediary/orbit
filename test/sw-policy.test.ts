import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * WR-07: the SW's pure routing decisions were claimed to be "vitest-tested"
 * but no test imported them. This exercises the whole decision surface
 * (bypass, immutable assets, shell mapping) for both a root deploy and a
 * /orbit basePath, plus the SW_BUILD == CACHE_VERSION lockstep invariant.
 *
 * sw-policy.js is dual-target: the worker gets it via importScripts, Node via
 * require(). createRequire keeps that exact contract under test.
 */

interface Policy {
  CACHE_VERSION: string
  PRECACHE_URLS: readonly string[]
  configure(prefix: string): void
  isBypass(url: string, selfOrigin: string): boolean
  isImmutableAsset(url: string): boolean
  shellForPath(pathname: string): string
}

const require = createRequire(import.meta.url)
// require (not import) mirrors the dual-target load path the worker uses.
const P = require('../public/sw-policy.js') as Policy

const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf-8')

beforeEach(() => {
  P.configure('')
})

describe('sw-policy: root deploy', () => {
  it('maps the root navigation to the root shell', () => {
    expect(P.shellForPath('/')).toBe('/')
  })

  it('treats /_next/static/ as immutable content-hashed assets', () => {
    expect(P.isImmutableAsset('https://orbit.example/_next/static/chunks/app.js')).toBe(true)
    expect(P.isImmutableAsset('https://orbit.example/app.js')).toBe(false)
  })
})

describe('sw-policy: /orbit basePath', () => {
  it('maps prefixed navigations to the prefixed shell', () => {
    P.configure('/orbit')
    // The worker builds precache keys as `_prefix + shell`, so the prefixed
    // root shell key is '/orbit/'.
    expect(P.shellForPath('/orbit')).toBe('/orbit/')
    expect(P.shellForPath('/orbit/')).toBe('/orbit/')
  })

  it('recognizes prefixed immutable assets only under the prefix', () => {
    P.configure('/orbit')
    expect(P.isImmutableAsset('https://orbit.example/orbit/_next/static/chunks/app.js')).toBe(true)
    expect(P.isImmutableAsset('https://orbit.example/_next/static/chunks/app.js')).toBe(false)
    expect(P.isImmutableAsset('https://orbit.example/orbitfoo/_next/static/x.js')).toBe(false)
  })
})

describe('sw-policy: cross-origin bypass', () => {
  it('passes cross-origin requests through and handles same-origin', () => {
    expect(P.isBypass('https://cdn.example.com/lib.js', 'https://orbit.example')).toBe(true)
    expect(P.isBypass('https://orbit.example/lib.js', 'https://orbit.example')).toBe(false)
  })

  it('bypasses unparseable URLs rather than intercepting them', () => {
    expect(P.isBypass('not a url', 'https://orbit.example')).toBe(true)
  })
})

describe('sw-policy: build lockstep', () => {
  it('SW_BUILD in sw.js equals CACHE_VERSION in sw-policy.js', () => {
    const match = swSource.match(/const SW_BUILD = '([^']+)'/)
    expect(match?.[1]).toBeTruthy()
    expect(match?.[1]).toBe(P.CACHE_VERSION)
  })
})
