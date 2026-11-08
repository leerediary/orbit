/**
 * Human-visible build version, shown in Settings so the user can confirm which
 * bundle they are actually running (and whether an update has landed).
 *
 * MUST stay in lockstep with the service-worker build literals:
 *   - public/sw-policy.js  CACHE_VERSION
 *   - public/sw.js         SW_BUILD
 * test/sw-policy.test.ts asserts all three match — bump them together, never one
 * alone.
 */
export const BUILD_VERSION = 'orbit-v119'
