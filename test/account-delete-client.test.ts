import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deleteCloudAccount } from '@/lib/account-delete'

/**
 * Phase 20 / BOOT-04 — client half of cloud account deletion.
 *
 * The request target is the JWT `sub` on the server; this client only sends the
 * explicit confirmation body. Cleanup order is load-bearing: metadata is reset
 * BEFORE the session is cleared, and only a 200 reaches either step (D-10).
 */

const SOURCE = readFileSync(
  new URL('../lib/account-delete.ts', import.meta.url),
  'utf8',
)

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ version: 1, ok: status < 400 }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('deleteCloudAccount', () => {
  it('on 200 resets metadata before clearing the session and reports ok', async () => {
    const events: string[] = []
    const fetchFn = vi.fn(async () => jsonResponse(200))
    const resetMetadata = vi.fn(async () => {
      events.push('reset')
    })
    const clearSessionFn = vi.fn(() => {
      events.push('clear')
    })

    const result = await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    expect(result).toEqual({ ok: true })
    expect(events).toEqual(['reset', 'clear'])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(resetMetadata).toHaveBeenCalledTimes(1)
    expect(clearSessionFn).toHaveBeenCalledTimes(1)
  })

  it('posts exactly {confirm:true} to /v1/account/delete with a JSON content type', async () => {
    const fetchFn = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse(200))
    const resetMetadata = vi.fn(async () => {})
    const clearSessionFn = vi.fn(() => {})

    await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/v1/account/delete')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ confirm: true })
    const headers = new Headers(init.headers)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('maps 401 to auth with no local cleanup', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401))
    const resetMetadata = vi.fn(async () => {})
    const clearSessionFn = vi.fn(() => {})

    const result = await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    expect(result).toEqual({ ok: false, error: 'auth' })
    expect(resetMetadata).not.toHaveBeenCalled()
    expect(clearSessionFn).not.toHaveBeenCalled()
  })

  it('maps a thrown fetch to network with no local cleanup', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const resetMetadata = vi.fn(async () => {})
    const clearSessionFn = vi.fn(() => {})

    const result = await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    expect(result).toEqual({ ok: false, error: 'network' })
    expect(resetMetadata).not.toHaveBeenCalled()
    expect(clearSessionFn).not.toHaveBeenCalled()
  })

  it('maps other non-ok responses to server with no local cleanup', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500))
    const resetMetadata = vi.fn(async () => {})
    const clearSessionFn = vi.fn(() => {})

    const result = await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    expect(result).toEqual({ ok: false, error: 'server' })
    expect(resetMetadata).not.toHaveBeenCalled()
    expect(clearSessionFn).not.toHaveBeenCalled()
  })

  it('still clears the session and reports ok when metadata reset throws', async () => {
    const events: string[] = []
    const fetchFn = vi.fn(async () => jsonResponse(200))
    const resetMetadata = vi.fn(async () => {
      events.push('reset')
      throw new Error('dexie failed')
    })
    const clearSessionFn = vi.fn(() => {
      events.push('clear')
    })

    const result = await deleteCloudAccount({ fetchFn, resetMetadata, clearSessionFn })

    // The server deletion already succeeded; a local metadata failure must not
    // leave the user signed in to a deleted account.
    expect(result).toEqual({ ok: true })
    expect(events).toEqual(['reset', 'clear'])
  })

  it('never sends a user id, logs, or touches localStorage', () => {
    expect(SOURCE).not.toMatch(/user_id|userId/)
    expect(SOURCE).not.toMatch(/console\./)
    expect(SOURCE).not.toMatch(/localStorage/)
  })
})
