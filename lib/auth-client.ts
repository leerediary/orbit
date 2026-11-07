import { API_URL } from './api-url'
import {
  clearSession,
  readDeviceId,
  readSession,
  writeSession,
  type StoredSession,
} from './auth-storage'
import { deriveDeviceName } from './device-name'

/**
 * Browser-side auth HTTP client.
 *
 * Contract with the Worker (RESEARCH "端点清单"):
 *   POST /v1/auth/login   -> { access_token, refresh_token, expiries, user, device }
 *   POST /v1/auth/refresh -> same session body (rotated refresh token)
 *   POST /v1/auth/recover -> { recovery_code }
 *   errors                -> { error: <code> }
 *
 * 401 handling follows D-05: refresh once, retry once, then give up. Refresh is
 * single-flight at module scope and, when available, serialized across tabs
 * with `navigator.locks` so a rotated refresh token is never wasted (Pitfall 4).
 *
 * Login/logout never touch the sync engine (SC5): the only imports are the
 * API URL switch, the storage seam, and the pure device-name mapper.
 */

export type AuthErrorKind =
  | 'invalid_credentials'
  | 'invalid_recovery'
  | 'rate_limited'
  | 'offline'
  | 'server'

export type AuthResult =
  | { ok: true; session: StoredSession }
  | { ok: false; error: AuthErrorKind }

const MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: '邮箱或密码不正确。',
  invalid_recovery: '恢复码不正确。',
  rate_limited: '尝试次数过多，请稍后再试。',
  offline: '无法连接服务器，请检查网络。',
  server: '服务器暂时不可用，请稍后再试。',
}

/** UI-SPEC locked copy. Unknown kinds fall back to the server message. */
export function authErrorMessage(kind: AuthErrorKind): string {
  return MESSAGES[kind] ?? MESSAGES.server
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The UA is read inside functions only — the static export prerenders in Node. */
function currentUserAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : ''
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Maps a non-OK response to a UI error kind. Never logs body or headers. */
async function classify(res: Response): Promise<AuthErrorKind> {
  if (res.status === 429) return 'rate_limited'
  let code: unknown
  try {
    const body: unknown = await res.json()
    code = isRecord(body) ? body.error : undefined
  } catch {
    code = undefined
  }
  if (code === 'rate_limited') return 'rate_limited'
  if (res.status === 401) {
    return code === 'invalid_recovery' ? 'invalid_recovery' : 'invalid_credentials'
  }
  return 'server'
}

/** Parses a login/refresh success body into a StoredSession, or null. */
async function parseSession(
  res: Response,
  fallbackDeviceName: string,
  fallbackDeviceId: string,
): Promise<StoredSession | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  if (!isRecord(body)) return null

  const user = body.user
  const device = body.device
  if (!isRecord(user) || typeof user.email !== 'string') return null
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) return null
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) return null
  if (typeof body.access_expires_at !== 'number' || !Number.isFinite(body.access_expires_at)) {
    return null
  }
  if (typeof body.refresh_expires_at !== 'number' || !Number.isFinite(body.refresh_expires_at)) {
    return null
  }

  const deviceId =
    isRecord(device) && typeof device.id === 'string' && device.id.length > 0
      ? device.id
      : fallbackDeviceId
  const deviceName =
    isRecord(device) && typeof device.name === 'string' && device.name.length > 0
      ? device.name
      : fallbackDeviceName

  return {
    email: user.email,
    deviceId,
    deviceName,
    accessToken: body.access_token,
    accessExpiresAt: body.access_expires_at,
    refreshToken: body.refresh_token,
    refreshExpiresAt: body.refresh_expires_at,
  }
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const deviceName = deriveDeviceName(currentUserAgent())
  const deviceId = readDeviceId()

  let res: Response
  try {
    res = await postJson('/v1/auth/login', {
      email: normalizeEmail(email),
      password,
      device_id: deviceId,
      device_name: deviceName,
    })
  } catch {
    return { ok: false, error: 'offline' }
  }

  if (!res.ok) return { ok: false, error: await classify(res) }

  const session = await parseSession(res, deviceName, deviceId)
  if (!session) return { ok: false, error: 'server' }

  writeSession(session)
  return { ok: true, session }
}

export async function recover(
  email: string,
  recoveryCode: string,
  newPassword: string,
): Promise<{ ok: true; recoveryCode: string } | { ok: false; error: AuthErrorKind }> {
  let res: Response
  try {
    res = await postJson('/v1/auth/recover', {
      email: normalizeEmail(email),
      recovery_code: recoveryCode,
      new_password: newPassword,
    })
  } catch {
    return { ok: false, error: 'offline' }
  }

  if (!res.ok) return { ok: false, error: await classify(res) }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, error: 'server' }
  }
  if (!isRecord(body)) return { ok: false, error: 'server' }
  const code = body.recovery_code
  if (typeof code !== 'string') return { ok: false, error: 'server' }
  return { ok: true, recoveryCode: code }
}

let inflight: Promise<string | null> | null = null

/**
 * Silently refresh the access token. Concurrent callers share one request
 * (module-level single flight) and, in browsers, one cross-tab lock.
 * Returns the new access token, or null when the session is gone/rejected.
 */
export function refresh(): Promise<string | null> {
  if (inflight) return inflight
  const pending = doRefresh().finally(() => {
    if (inflight === pending) inflight = null
  })
  inflight = pending
  return pending
}

async function doRefresh(): Promise<string | null> {
  const session = readSession()
  if (!session) return null

  const run = async (): Promise<string | null> => {
    let res: Response
    try {
      res = await postJson('/v1/auth/refresh', { refresh_token: session.refreshToken })
    } catch {
      // Offline is not a reason to log the user out.
      return null
    }

    if (!res.ok) {
      clearSession()
      return null
    }

    const next = await parseSession(res, session.deviceName, session.deviceId)
    if (!next) {
      clearSession()
      return null
    }

    writeSession(next)
    return next.accessToken
  }

  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request('orbit-auth-refresh', run)
  }
  return run()
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  const session = readSession()
  if (session) headers.set('Authorization', `Bearer ${session.accessToken}`)
  return fetch(`${API_URL}${path}`, { ...init, headers })
}

/**
 * Authorized fetch: 401 triggers one silent refresh and one retry; a second
 * 401 clears the session. Never retries more than once (D-05).
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let res = await send(path, init)
  if (res.status !== 401) return res

  const token = await refresh()
  if (!token) return res

  res = await send(path, init)
  if (res.status === 401) clearSession()
  return res
}

/**
 * Local-only logout (D-09): clears the session token, keeps the device id and
 * every local database row, and never calls the server.
 */
export function logout(): void {
  clearSession()
}
