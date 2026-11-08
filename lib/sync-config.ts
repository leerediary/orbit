/**
 * Sync badge visibility gate (plan 18-05 / SYNC-03, D-03, UI-SPEC §7).
 *
 * The badge renders only when this build is configured (`NEXT_PUBLIC_API_URL`
 * set), a session exists, the component has mounted in the browser, and this
 * release gate is on.
 *
 * Release gate (Phase 20, BOOT-02): this is a COMPILED LITERAL, not an env var
 * or runtime setting, so no public-mirror build can switch it on by accident
 * (T-20-04). Plan 20-12 flipped it to `true` in the two-device sign-off commit;
 * that commit is the sign-off and the gate is not configurable at runtime.
 * test/sync-config.test.ts asserts the literal.
 *
 * Every helper here is pure and DOM-free so the whole truth table is
 * unit-testable (W3) without rendering React or touching a browser global.
 */

/** Open since the plan 20-12 two-device sign-off. */
export const SYNC_UI_ENABLED = true

export function isSyncBadgeVisible(input: {
  mounted: boolean
  enabled: boolean
  configured: boolean
  signedIn: boolean
  bootstrapped: boolean
  paused: boolean
}): boolean {
  return (
    input.mounted &&
    input.enabled &&
    input.configured &&
    input.signedIn &&
    input.bootstrapped === true &&
    input.paused !== true
  )
}

/**
 * Settings 云同步 block visibility (Phase 20). One pure source for the
 * three-way gate: release flag, build configuration, and session presence.
 */
export function isSyncUiVisible(input: {
  enabled: boolean
  configured: boolean
  signedIn: boolean
}): boolean {
  return input.enabled && input.configured && input.signedIn
}

/**
 * First-sync bootstrap screen activation (Phase 20). True only for a
 * configured, signed-in device that has NOT bootstrapped and is not paused —
 * the two-gate model: release gate + per-device runtime gate (RESEARCH
 * Pattern 1).
 */
export function isBootstrapActive(input: {
  enabled: boolean
  configured: boolean
  signedIn: boolean
  bootstrapped: boolean
  paused: boolean
}): boolean {
  return (
    input.enabled &&
    input.configured &&
    input.signedIn &&
    !input.bootstrapped &&
    !input.paused
  )
}
