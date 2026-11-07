import { authedFetch } from '@/lib/auth-client'
import { clearSession } from '@/lib/auth-storage'
import { resetSyncMetadataAfterAccountDelete } from '@/lib/bootstrap-local'
import { db } from '@/lib/local-db'

/**
 * Phase 20 / BOOT-04 — client request for cloud account deletion.
 *
 * The server owns the target: it derives the account from the bearer token's
 * `sub`, so this client sends only the explicit `{ confirm: true }` body and
 * never an identity (T-20-36). Local cleanup is ordered and conditional
 * (T-20-39): metadata reset, then the session clear, and BOTH only after a 200.
 * A failed request leaves the session and every metadata key untouched.
 */

export type AccountDeleteError = 'auth' | 'network' | 'server' | 'unknown'

export type DeleteCloudAccountResult =
  | { ok: true }
  | { ok: false; error: AccountDeleteError }

export interface DeleteCloudAccountInput {
  /** Authenticated fetch; defaults to the shared 401-refresh client. */
  fetchFn?: (path: string, init?: RequestInit) => Promise<Response>
  /** Sync-metadata reset; defaults to the Dexie-backed reset (entity tables untouched). */
  resetMetadata?: () => Promise<void>
  /** Local session clear; defaults to the storage seam. */
  clearSessionFn?: () => void
}

/**
 * Permanently delete the signed-in user's cloud account.
 *
 * Error map: a thrown fetch is `network`, HTTP 401 is `auth` (the refresh-token
 * flow already ran), and every other non-OK response is `server`.
 *
 * On success the local metadata is reset BEFORE the session is cleared. If the
 * metadata reset fails, the session is still cleared and the result is `ok`:
 * the server deletion already happened, and a stale `bootstrapAccountId` is
 * fail-safe because a mismatched account forces a re-bootstrap.
 */
export async function deleteCloudAccount(
  input: DeleteCloudAccountInput = {},
): Promise<DeleteCloudAccountResult> {
  const fetchFn = input.fetchFn ?? authedFetch
  const resetMetadata =
    input.resetMetadata ?? (() => resetSyncMetadataAfterAccountDelete(db))
  const clearSessionFn = input.clearSessionFn ?? clearSession

  let res: Response
  try {
    res = await fetchFn('/v1/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
  } catch {
    return { ok: false, error: 'network' }
  }

  if (res.status === 401) return { ok: false, error: 'auth' }
  if (!res.ok) return { ok: false, error: 'server' }

  try {
    await resetMetadata()
  } catch {
    // The server deletion succeeded; never leave the user signed in to a
    // deleted account because a local metadata write failed.
  }
  clearSessionFn()
  return { ok: true }
}
