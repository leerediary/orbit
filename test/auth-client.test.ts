import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Client auth tests run in Node: fetch is mocked per test, and a private
 * in-memory Storage stands in for localStorage. Modules are re-imported after
 * `vi.resetModules()` so the module-level single-flight promise starts clean
 * for every scenario.
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
const ORIGINAL_FETCH = Object.getOwnPropertyDescriptor(globalThis, 'fetch')

const SESSION = {
  email: 'me@example.com',
  deviceId: 'device-1',
  deviceName: 'Mac',
  accessToken: 'access-1',
  accessExpiresAt: 1_763_000_000_000,
  refreshToken: 'refresh-1',
  refreshExpiresAt: 1_768_000_000_000,
}

const LOGIN_BODY = {
  version: 1,
  access_token: 'access-1',
  access_expires_at: 1_763_000_000_000,
  refresh_token: 'refresh-1',
  refresh_expires_at: 1_768_000_000_000,
  user: { email: 'me@example.com' },
  device: { id: 'device-1', name: '浏览器' },
}

const REFRESH_BODY = {
  version: 1,
  access_token: 'access-2',
  access_expires_at: 1_763_000_900_000,
  refresh_token: 'refresh-2',
  refresh_expires_at: 1_768_000_000_000,
  user: { email: 'me@example.com' },
  device: { id: 'device-1', name: 'Mac' },
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function plainResponse(status: number): Response {
  return new Response(null, { status })
}

let storage: MemoryStorage

function installStorage(): MemoryStorage {
  const next = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: next,
    configurable: true,
    writable: true,
  })
  return next
}

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  Object.defineProperty(globalThis, 'fetch', {
    value: mock,
    configurable: true,
    writable: true,
  })
  return mock
}

function refreshCalls(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter(([input]) => String(input).endsWith('/v1/auth/refresh')).length
}

async function load(): Promise<{
  client: typeof import('../lib/auth-client')
  storage: typeof import('../lib/auth-storage')
}> {
  const client = await import('../lib/auth-client')
  const storageModule = await import('../lib/auth-storage')
  return { client, storage: storageModule }
}

beforeEach(() => {
  vi.resetModules()
  storage = installStorage()
})

afterEach(() => {
  if (ORIGINAL_LOCALSTORAGE) {
    Object.defineProperty(globalThis, 'localStorage', ORIGINAL_LOCALSTORAGE)
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
  if (ORIGINAL_FETCH) {
    Object.defineProperty(globalThis, 'fetch', ORIGINAL_FETCH)
  } else {
    delete (globalThis as { fetch?: unknown }).fetch
  }
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('login', () => {
  it('trims and lowercases the email, sends device fields, and writes the session', async () => {
    const fetchMock = installFetch(async () => jsonResponse(200, LOGIN_BODY))
    const { client, storage: store } = await load()

    const result = await client.login('  Me@Example.COM ', 'secret-pass')

    expect(result).toEqual({
      ok: true,
      session: {
        email: 'me@example.com',
        deviceId: 'device-1',
        deviceName: '浏览器',
        accessToken: 'access-1',
        accessExpiresAt: 1_763_000_000_000,
        refreshToken: 'refresh-1',
        refreshExpiresAt: 1_768_000_000_000,
      },
    })
    expect(store.readSession()).toEqual(result.ok ? result.session : null)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('/v1/auth/login')
    const sent = JSON.parse(String(init?.body))
    expect(sent.email).toBe('me@example.com')
    expect(sent.password).toBe('secret-pass')
    expect(sent.device_id).toBe(store.readDeviceId())
    expect(sent.device_name).toBe('浏览器')
  })

  it('returns invalid_credentials for a 401 and writes no session', async () => {
    installFetch(async () => jsonResponse(401, { version: 1, error: 'invalid_credentials' }))
    const { client, storage: store } = await load()

    await expect(client.login('me@example.com', 'wrong')).resolves.toEqual({
      ok: false,
      error: 'invalid_credentials',
    })
    expect(store.readSession()).toBeNull()
  })

  it('returns offline for a thrown network error instead of rejecting', async () => {
    installFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const { client } = await load()

    await expect(client.login('me@example.com', 'secret')).resolves.toEqual({
      ok: false,
      error: 'offline',
    })
  })

  it('maps 429 to rate_limited', async () => {
    installFetch(async () => jsonResponse(429, { version: 1, error: 'rate_limited' }))
    const { client } = await load()
    await expect(client.login('me@example.com', 'secret')).resolves.toEqual({
      ok: false,
      error: 'rate_limited',
    })
  })

  it('maps 5xx and non-JSON bodies to server', async () => {
    installFetch(async () => plainResponse(500))
    let { client } = await load()
    await expect(client.login('me@example.com', 'secret')).resolves.toEqual({
      ok: false,
      error: 'server',
    })

    vi.resetModules()
    installFetch(async () => new Response('<html>oops</html>', { status: 200 }))
    ;({ client } = await load())
    await expect(client.login('me@example.com', 'secret')).resolves.toEqual({
      ok: false,
      error: 'server',
    })
  })
})

describe('recover', () => {
  it('returns the new recovery code on success', async () => {
    installFetch(async () => jsonResponse(200, { version: 1, recovery_code: 'ABCD-EFGH' }))
    const { client } = await load()
    await expect(client.recover('me@example.com', 'old-code', 'new-pass')).resolves.toEqual({
      ok: true,
      recoveryCode: 'ABCD-EFGH',
    })
  })

  it('maps a 401 invalid_recovery body to invalid_recovery', async () => {
    installFetch(async () => jsonResponse(401, { version: 1, error: 'invalid_recovery' }))
    const { client } = await load()
    await expect(client.recover('me@example.com', 'bad', 'new-pass')).resolves.toEqual({
      ok: false,
      error: 'invalid_recovery',
    })
  })
})

describe('authedFetch: retry once after a successful refresh', () => {
  it('retries exactly once with the rotated access token', async () => {
    let originals = 0
    const fetchMock = installFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) return jsonResponse(200, REFRESH_BODY)
      originals += 1
      return originals === 1 ? plainResponse(401) : plainResponse(200)
    })
    const { client, storage: store } = await load()
    store.writeSession(SESSION)

    const res = await client.authedFetch('/v1/records')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(refreshCalls(fetchMock)).toBe(1)

    const firstAuth = new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')
    const retryAuth = new Headers(fetchMock.mock.calls[2][1]?.headers).get('Authorization')
    expect(firstAuth).toBe('Bearer access-1')
    expect(retryAuth).toBe('Bearer access-2')
    expect(store.readSession()?.accessToken).toBe('access-2')
    expect(store.readSession()?.refreshToken).toBe('refresh-2')
  })

  it('clears the session when the retry is also 401', async () => {
    const fetchMock = installFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) return jsonResponse(200, REFRESH_BODY)
      return plainResponse(401)
    })
    const { client, storage: store } = await load()
    store.writeSession(SESSION)

    const res = await client.authedFetch('/v1/records')

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(store.readSession()).toBeNull()
  })
})

describe('authedFetch: single-flight refresh', () => {
  it('shares one refresh across two concurrent 401s when the refresh fails', async () => {
    const fetchMock = installFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) return jsonResponse(401, { version: 1, error: 'invalid_refresh' })
      return plainResponse(401)
    })
    const { client, storage: store } = await load()
    store.writeSession(SESSION)

    const [a, b] = await Promise.all([
      client.authedFetch('/v1/records'),
      client.authedFetch('/v1/goals'),
    ])

    // 2 originals + 1 refresh, zero retries.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(refreshCalls(fetchMock)).toBe(1)
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(store.readSession()).toBeNull()
  })

  it('shares one refresh across two concurrent 401s when the refresh succeeds', async () => {
    let originals = 0
    const fetchMock = installFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) return jsonResponse(200, REFRESH_BODY)
      originals += 1
      return originals <= 2 ? plainResponse(401) : plainResponse(200)
    })
    const { client, storage: store } = await load()
    store.writeSession(SESSION)

    const [a, b] = await Promise.all([
      client.authedFetch('/v1/records'),
      client.authedFetch('/v1/goals'),
    ])

    // 2 originals + 1 refresh + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(refreshCalls(fetchMock)).toBe(1)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(store.readSession()?.accessToken).toBe('access-2')
  })
})

describe('logout', () => {
  it('clears only the session and keeps the device id', async () => {
    const { client, storage: store } = await load()
    store.writeSession(SESSION)
    const deviceId = store.readDeviceId()

    client.logout()

    expect(store.readSession()).toBeNull()
    expect(storage.getItem('orbit.device.v1')).toBe(deviceId)
  })
})

describe('authErrorMessage', () => {
  it('returns the locked copy for every kind', async () => {
    const { client } = await load()
    expect(client.authErrorMessage('invalid_credentials')).toBe('邮箱或密码不正确。')
    expect(client.authErrorMessage('invalid_recovery')).toBe('恢复码不正确。')
    expect(client.authErrorMessage('rate_limited')).toBe('尝试次数过多，请稍后再试。')
    expect(client.authErrorMessage('offline')).toBe('无法连接服务器，请检查网络。')
    expect(client.authErrorMessage('server')).toBe('服务器暂时不可用，请稍后再试。')
  })
})

describe('no sync coupling (SC5)', () => {
  it('imports no sync, outbox, local-db, or Dexie module', () => {
    const source = readFileSync(new URL('../lib/auth-client.ts', import.meta.url), 'utf-8')
    const specifiers = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/sync|outbox|local-db|dexie/i)
    }
  })
})
