import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Session presence-change seam (plan 18-05 / B1 / T-18-41).
 *
 * The sync badge gate must flip on same-page login/logout without a reload, and
 * token rotation must never restart the sync engine. These tests install a
 * private in-memory Storage plus a minimal fake `window` backed by EventTarget
 * (Node exposes both `Event` and `EventTarget`), mirroring the browser contract:
 *
 *  - `writeSession` / `clearSession` emit `orbit-auth-change` only on a
 *    signed-out <-> signed-in presence transition;
 *  - `subscribeAuthChange` also mirrors cross-tab `storage` events by re-reading
 *    storage (never trusting the event payload).
 *
 * `vi.resetModules()` + dynamic import keeps module-scope state isolated.
 */

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

/** Minimal `window`: EventTarget provides add/remove/dispatchEvent. */
class FakeWindow extends EventTarget {}

const ORIGINAL_LOCALSTORAGE = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

function installWindow(): FakeWindow {
  const win = new FakeWindow()
  Object.defineProperty(globalThis, 'window', {
    value: win,
    configurable: true,
    writable: true,
  })
  return win
}

function restoreGlobal(name: 'localStorage' | 'window', original: PropertyDescriptor | undefined): void {
  if (original) {
    Object.defineProperty(globalThis, name, original)
  } else {
    delete (globalThis as Record<string, unknown>)[name]
  }
}

const SESSION = {
  email: 'me@example.com',
  deviceId: 'device-1',
  deviceName: 'Mac',
  accessToken: 'access-1',
  accessExpiresAt: 1_763_000_000_000,
  refreshToken: 'refresh-1',
  refreshExpiresAt: 1_768_000_000_000,
}

async function loadStorage() {
  return import('../lib/auth-storage')
}

let storage: MemoryStorage
let win: FakeWindow

beforeEach(() => {
  vi.resetModules()
  storage = installStorage()
  win = installWindow()
})

afterEach(() => {
  restoreGlobal('localStorage', ORIGINAL_LOCALSTORAGE)
  restoreGlobal('window', ORIGINAL_WINDOW)
  vi.resetModules()
})

describe('auth-change: same-document presence transitions', () => {
  it('dispatches once and notifies true when a session appears', async () => {
    const m = await loadStorage()
    let events = 0
    win.addEventListener(m.AUTH_CHANGE_EVENT, () => {
      events += 1
    })
    const seen: boolean[] = []
    m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    m.writeSession(SESSION)

    expect(events).toBe(1)
    expect(seen).toEqual([true])
  })

  it('stays silent on token rotation (a session was already present)', async () => {
    const m = await loadStorage()
    m.writeSession(SESSION)

    let events = 0
    win.addEventListener(m.AUTH_CHANGE_EVENT, () => {
      events += 1
    })
    const seen: boolean[] = []
    m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    m.writeSession({ ...SESSION, accessToken: 'access-2', refreshToken: 'refresh-2' })

    expect(events).toBe(0)
    expect(seen).toEqual([])
  })

  it('notifies false exactly once when the session is cleared', async () => {
    const m = await loadStorage()
    m.writeSession(SESSION)

    let events = 0
    win.addEventListener(m.AUTH_CHANGE_EVENT, () => {
      events += 1
    })
    const seen: boolean[] = []
    m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    m.clearSession()

    expect(events).toBe(1)
    expect(seen).toEqual([false])
  })

  it('dispatches nothing when clearing an already-empty session', async () => {
    const m = await loadStorage()
    let events = 0
    win.addEventListener(m.AUTH_CHANGE_EVENT, () => {
      events += 1
    })
    const seen: boolean[] = []
    m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    m.clearSession()

    expect(events).toBe(0)
    expect(seen).toEqual([])
  })
})

describe('auth-change: cross-tab storage mirror', () => {
  it('re-reads storage on a matching storage event and ignores rotation', async () => {
    const m = await loadStorage()
    const seen: boolean[] = []
    m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    // Another tab signs in.
    storage.setItem(m.SESSION_KEY, JSON.stringify(SESSION))
    win.dispatchEvent(Object.assign(new Event('storage'), { key: m.SESSION_KEY }))
    expect(seen).toEqual([true])

    // Another tab rotates tokens: presence is unchanged, so nothing fires.
    storage.setItem(m.SESSION_KEY, JSON.stringify({ ...SESSION, accessToken: 'rotated' }))
    win.dispatchEvent(Object.assign(new Event('storage'), { key: m.SESSION_KEY }))
    expect(seen).toEqual([true])

    // An unrelated key never notifies.
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'orbit.business' }))
    expect(seen).toEqual([true])
  })
})

describe('auth-change: unsubscribe', () => {
  it('removes both listeners and is safe to call twice', async () => {
    const m = await loadStorage()
    let events = 0
    win.addEventListener(m.AUTH_CHANGE_EVENT, () => {
      events += 1
    })
    const seen: boolean[] = []
    const unsubscribe = m.subscribeAuthChange((signedIn) => seen.push(signedIn))

    unsubscribe()
    expect(() => unsubscribe()).not.toThrow()

    m.writeSession(SESSION)
    expect(events).toBe(1) // the raw event still fires; the subscriber is gone
    expect(seen).toEqual([])
  })
})
