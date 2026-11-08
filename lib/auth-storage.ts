/**
 * The single seam for auth persistence.
 *
 * Tokens are bearer tokens in localStorage (D-03) — not cookies, not Dexie.
 * Everything reads and writes through this module so switching the backend to
 * IndexedDB later (D-E) needs no caller changes.
 *
 * IMPORTANT: no browser global is touched at module scope. The static export
 * prerenders in Node, where `localStorage` does not exist (Pitfall 10). Callers
 * may use these functions only inside an effect or an event handler.
 *
 * This module must stay importable before the database layer exists: it must
 * not import Dexie, `lib/local-db`, or anything sync-related (SC5).
 */

export interface StoredSession {
  email: string
  deviceId: string
  deviceName: string
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  refreshExpiresAt: number
}

export const SESSION_KEY = 'orbit.auth.v1'
export const DEVICE_KEY = 'orbit.device.v1'

/**
 * Same-document session presence-change event (plan 18-05 / B1).
 *
 * The sync badge gate subscribes to this instead of polling storage, so a login
 * or logout in Settings flips the gate without a reload. It fires only on a
 * signed-out <-> signed-in transition — never on token rotation (T-18-41).
 */
export const AUTH_CHANGE_EVENT = 'orbit-auth-change'

/** The ambient Storage, or null in Node prerender / when access is blocked. */
export function getStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!isRecord(value)) return false
  return (
    typeof value.email === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.deviceName === 'string' &&
    typeof value.accessToken === 'string' &&
    typeof value.accessExpiresAt === 'number' &&
    Number.isFinite(value.accessExpiresAt) &&
    typeof value.refreshToken === 'string' &&
    typeof value.refreshExpiresAt === 'number' &&
    Number.isFinite(value.refreshExpiresAt)
  )
}

/** Session from storage, or null when absent / corrupt / not a session. */
export function readSession(): StoredSession | null {
  const raw = getStorage()?.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isStoredSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the JWT `sub` claim from an already-issued access token (plan 20-01 /
 * BOOT-01).
 *
 * This is an equality-only identity hint: it reads a token this client already
 * holds to detect an account change and compare against `bootstrapAccountId`.
 * It performs NO signature verification, NO expiry check, and NO authorization
 * decision — the server is the only authority on any of those. Never send this
 * value to the server and never trust it for access control (T-20-01/T-20-03).
 *
 * Returns null for a missing session, a non-JWT shape, an undecodable payload,
 * or a payload whose `sub` is not a non-empty string. `atob`/`TextDecoder` are
 * touched inside the function only, so module scope stays browser-free.
 */
export function readSessionSubject(session: StoredSession | null): string | null {
  if (!session) return null

  const parts = session.accessToken.split('.')
  if (parts.length !== 3) return null

  const payloadSegment = parts[1]
  if (!payloadSegment) return null

  try {
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const decoded = atob(padded)
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsedSubject(payload)
  } catch {
    return null
  }
}

function parsedSubject(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const sub = (payload as { sub?: unknown }).sub
  return typeof sub === 'string' && sub.length > 0 ? sub : null
}

/** Dispatches the presence-change event. `window` is touched inside only. */
function notifyAuthChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT))
}

export function writeSession(session: StoredSession): void {
  const hadSession = readSession() !== null
  getStorage()?.setItem(SESSION_KEY, JSON.stringify(session))
  // Only a presence transition notifies; a token rotation keeps the same user
  // signed in, so it must not restart the sync engine.
  if (!hadSession) notifyAuthChange()
}

/** Removes only the session. The device id (and local data) survive (D-09). */
export function clearSession(): void {
  const hadSession = readSession() !== null
  getStorage()?.removeItem(SESSION_KEY)
  if (hadSession) notifyAuthChange()
}

/**
 * Subscribe to session presence changes (plan 18-05 / B1).
 *
 * Two sources feed the same presence comparison:
 *  - the same-document `AUTH_CHANGE_EVENT` from `writeSession`/`clearSession`;
 *  - cross-tab `storage` events for `SESSION_KEY` (other tabs cannot deliver a
 *    same-document CustomEvent, so the browser storage event bridges the gap).
 *
 * The handler always re-reads storage, so an event payload is never trusted and
 * a token rotation (presence unchanged) is silently ignored. Returns an
 * unsubscribe that is safe to call more than once.
 */
export function subscribeAuthChange(fn: (signedIn: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}

  let last = readSession() !== null
  const notify = () => {
    const next = readSession() !== null
    if (next === last) return
    last = next
    fn(next)
  }
  const onStorage = (event: Event) => {
    if ((event as StorageEvent).key === SESSION_KEY) notify()
  }

  window.addEventListener(AUTH_CHANGE_EVENT, notify)
  window.addEventListener('storage', onStorage)

  return () => {
    window.removeEventListener(AUTH_CHANGE_EVENT, notify)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * Stable per-browser device id. Created once with `crypto.randomUUID()` and
 * never regenerated, so logging out and back in reuses the same devices row
 * (D-D, T-17-11).
 */
export function readDeviceId(): string {
  const storage = getStorage()
  const existing = storage?.getItem(DEVICE_KEY)
  if (existing) return existing
  const id = globalThis.crypto.randomUUID()
  storage?.setItem(DEVICE_KEY, id)
  return id
}
