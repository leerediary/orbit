import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The auth storage seam must work with whatever Storage the runtime provides
 * and degrade to null in Node prerender. These tests install a private
 * in-memory Storage so they never depend on the host having one (Node 24 only
 * exposes localStorage behind an experimental flag).
 *
 * `vi.resetModules()` + dynamic import keeps module-scope state from leaking
 * between tests, mirroring how the UI re-imports the module after a reload.
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

const ORIGINAL_LOCALSTORAGE = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

function removeStorage(): void {
  if (ORIGINAL_LOCALSTORAGE) {
    Object.defineProperty(globalThis, 'localStorage', ORIGINAL_LOCALSTORAGE)
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage
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

beforeEach(() => {
  vi.resetModules()
  storage = installStorage()
})

afterEach(() => {
  removeStorage()
  vi.resetModules()
})

describe('auth-storage: session round-trip', () => {
  it('reads back every field unchanged after a module reload', async () => {
    const first = await loadStorage()
    first.writeSession(SESSION)
    expect(storage.getItem('orbit.auth.v1')).toBe(JSON.stringify(SESSION))

    vi.resetModules()
    const second = await loadStorage()
    expect(second.readSession()).toEqual(SESSION)
  })

  it('returns null for corrupt JSON', async () => {
    const m = await loadStorage()
    storage.setItem('orbit.auth.v1', '{not json')
    expect(m.readSession()).toBeNull()
  })

  it('returns null for a non-object payload', async () => {
    const m = await loadStorage()
    storage.setItem('orbit.auth.v1', '[1,2,3]')
    expect(m.readSession()).toBeNull()
  })

  it('returns null when a required field has the wrong primitive type', async () => {
    const m = await loadStorage()
    storage.setItem('orbit.auth.v1', JSON.stringify({ ...SESSION, accessExpiresAt: '1000' }))
    expect(m.readSession()).toBeNull()
  })

  it('returns null and never throws when no Storage global exists', async () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    const m = await loadStorage()
    expect(m.readSession()).toBeNull()
    expect(() => m.writeSession(SESSION)).not.toThrow()
    expect(() => m.clearSession()).not.toThrow()
    expect(typeof m.readDeviceId()).toBe('string')
  })
})

describe('auth-storage: logout isolation', () => {
  it('clearSession removes only orbit.auth.v1', async () => {
    storage.setItem('orbit.device.v1', 'device-1')
    storage.setItem('orbit.business', 'unrelated-data')
    const m = await loadStorage()
    m.writeSession(SESSION)

    m.clearSession()

    expect(storage.getItem('orbit.auth.v1')).toBeNull()
    expect(storage.getItem('orbit.device.v1')).toBe('device-1')
    expect(storage.getItem('orbit.business')).toBe('unrelated-data')
  })
})

describe('auth-storage: device id', () => {
  it('creates a UUID once and returns the same value across calls', async () => {
    const m = await loadStorage()
    const id = m.readDeviceId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(m.readDeviceId()).toBe(id)
    expect(storage.getItem('orbit.device.v1')).toBe(id)
  })

  it('never regenerates an existing device id', async () => {
    storage.setItem('orbit.device.v1', 'seeded-device-id')
    const m = await loadStorage()
    expect(m.readDeviceId()).toBe('seeded-device-id')
    expect(storage.getItem('orbit.device.v1')).toBe('seeded-device-id')
  })
})

/**
 * Bootstrap identity (plan 20-01 / BOOT-01). The subject is read from an
 * already-issued bearer token for equality only — never verified, never sent.
 */
function jwt(payload: unknown): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

describe('auth-storage: readSessionSubject', () => {
  it('reads the sub claim from a well-formed access token', async () => {
    const m = await loadStorage()
    const session = { ...SESSION, accessToken: jwt({ sub: 'user-1' }) }
    expect(m.readSessionSubject(session)).toBe('user-1')
  })

  it('returns null for a non-JWT string', async () => {
    const m = await loadStorage()
    expect(m.readSessionSubject({ ...SESSION, accessToken: 'not-a-jwt' })).toBeNull()
  })

  it('returns null for a two-part token', async () => {
    const m = await loadStorage()
    expect(m.readSessionSubject({ ...SESSION, accessToken: 'header.payload' })).toBeNull()
  })

  it('returns null for an empty payload segment', async () => {
    const m = await loadStorage()
    expect(m.readSessionSubject({ ...SESSION, accessToken: 'header..signature' })).toBeNull()
  })

  it('returns null when the payload has no non-empty sub', async () => {
    const m = await loadStorage()
    expect(m.readSessionSubject({ ...SESSION, accessToken: jwt({ sub: '' }) })).toBeNull()
    expect(m.readSessionSubject({ ...SESSION, accessToken: jwt({ sub: 123 }) })).toBeNull()
    expect(m.readSessionSubject({ ...SESSION, accessToken: jwt({}) })).toBeNull()
  })

  it('returns null for a null session', async () => {
    const m = await loadStorage()
    expect(m.readSessionSubject(null)).toBeNull()
  })
})

describe('auth-storage: no sync coupling (SC5)', () => {
  it('imports no Dexie, local-db, sync, or outbox module', () => {
    const source = readFileSync(new URL('../lib/auth-storage.ts', import.meta.url), 'utf-8')
    const specifiers = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/dexie|local-db|sync|outbox/i)
    }
  })
})
