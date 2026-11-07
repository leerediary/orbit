'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { db } from '@/lib/local-db'
import { isSyncConfigured } from '@/lib/api-url'
import { SYNC_UI_ENABLED } from '@/lib/sync-config'
import { readSession, readSessionSubject, subscribeAuthChange } from '@/lib/auth-storage'
import {
  getBootstrapAccountId,
  getBootstrapComplete,
  isSyncPaused,
  subscribeSyncMetadata,
} from '@/lib/sync-store'
import {
  getBulkDeleteSnapshot,
  publishBulkDeleteRequired,
  resolveBulkDelete,
  subscribeBulkDelete,
} from '@/lib/sync-bulk-delete'
import { requestSync } from '@/lib/sync-engine'

/**
 * Phase 20 / BOOT-04 — the single UI exit for a guarded bulk delete
 * (20-UI-SPEC §2).
 *
 * The engine publishes a pending confirmation for a client pre-flight drain or
 * a server 409 `bulk_delete_required`; this dialog is the only place the user
 * can authorize it. Three invariants dominate:
 *  - the numbers come from the engine snapshot, never from UI-side thresholds;
 *  - cancel clears the request and never touches the outbox or starts a sync;
 *  - confirm awaits the 20-05 coalesced trailing run and only reports done from
 *    its result; a repeated `bulk` result re-opens the prompt for a new explicit
 *    click instead of retrying silently.
 *
 * The dialog renders only on a mounted, configured, signed-in device that
 * bootstrapped for the current account with sync unpaused. Every browser global
 * / Dexie / engine call lives inside effects and handlers, so the static-export
 * prerender can import this module safely.
 */

const TITLE_ID = 'orbit-bulk-delete-title'
const BODY_ID = 'orbit-bulk-delete-body'
const PANEL_ID = 'orbit-bulk-delete-panel'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

const BODY_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const HELPER_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const BUTTON_GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '24px',
}

/** UI-SPEC DESTRUCTIVE_CONFIRM — outline + destructive text, never a fill. */
const DESTRUCTIVE_CONFIRM_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'none',
  border: '1px solid var(--destructive)',
  borderRadius: '8px',
  color: 'var(--destructive)',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  fontFamily: 'inherit',
}

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
}

const PANEL_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  padding: '24px',
  paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
  boxShadow: 'none',
}

export default function SyncBulkDeletePrompt() {
  const request = useSyncExternalStore(
    subscribeBulkDelete,
    getBulkDeleteSnapshot,
    () => null,
  )

  const [mounted, setMounted] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  // Fail closed until metadata is actually read: paused=true keeps the gate shut.
  const [bootstrapped, setBootstrapped] = useState(false)
  const [paused, setPaused] = useState(true)
  const [busy, setBusy] = useState(false)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const busyRef = useRef(false)

  const readMeta = useCallback(async () => {
    try {
      const [complete, accountId, isPaused] = await Promise.all([
        getBootstrapComplete(db),
        getBootstrapAccountId(db),
        isSyncPaused(db),
      ])
      const subject = readSessionSubject(readSession())
      setBootstrapped(complete === true && subject !== null && accountId === subject)
      setPaused(isPaused === true)
    } catch {
      // Unreadable metadata never opens the destructive gate.
      setBootstrapped(false)
      setPaused(true)
    }
  }, [])

  useEffect(() => {
    setMounted(true)
    setSignedIn(readSession() !== null)
    void readMeta()

    const unsubscribeAuth = subscribeAuthChange((next) => {
      setSignedIn(next)
      void readMeta()
    })
    const unsubscribeMeta = subscribeSyncMetadata(() => {
      void readMeta()
    })

    return () => {
      unsubscribeAuth()
      unsubscribeMeta()
    }
  }, [readMeta])

  const visible =
    mounted &&
    SYNC_UI_ENABLED &&
    isSyncConfigured &&
    signedIn &&
    bootstrapped &&
    !paused &&
    request !== null

  // Capture the element that opened the dialog so cancel can restore focus.
  useEffect(() => {
    if (!visible) {
      previousFocusRef.current = null
      return
    }
    if (previousFocusRef.current === null) {
      const active = document.activeElement
      previousFocusRef.current = active instanceof HTMLElement ? active : null
    }
  }, [visible])

  // Focus lands on the safe action (取消) whenever the dialog opens.
  useEffect(() => {
    if (visible) cancelRef.current?.focus()
  }, [visible, request])

  const restoreFocus = useCallback(() => {
    const target = previousFocusRef.current
    previousFocusRef.current = null
    requestAnimationFrame(() => {
      if (target && document.contains(target)) target.focus()
      else document.body.focus()
    })
  }, [])

  // 取消: clear the pending request, leave the outbox untouched, show nothing.
  const cancel = useCallback(() => {
    resolveBulkDelete()
    restoreFocus()
  }, [restoreFocus])

  // 确认删除: the explicit one-shot authorization. Never fire-and-forget.
  const confirm = useCallback(async () => {
    if (busyRef.current || !request) return
    busyRef.current = true
    setBusy(true)
    const captured = request

    resolveBulkDelete()
    restoreFocus()

    try {
      // The 20-05 single-flight merge resolves this only after the trailing
      // run actually consumes `allowBulkDelete`.
      const result = await requestSync('manual', { allowBulkDelete: true })
      if (!result.ok && result.error === 'bulk') {
        // Still guarded: re-open for a NEW explicit click, never a retry loop.
        publishBulkDeleteRequired(captured)
      }
      // Any other failure: show nothing. The badge owns the generic copy.
    } catch {
      // Never leak a raw error from this destructive surface.
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [request, restoreFocus])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (busyRef.current) return
      cancel()
      return
    }
    if (event.key !== 'Tab') return

    // Hand-rolled focus trap, matching the existing sheets.
    const root = panelRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, select, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)

    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    const inside = current instanceof Node && root.contains(current)

    if (event.shiftKey) {
      if (!inside || current === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!visible || !request) return null

  const percent = Math.round((request.deletes / Math.max(request.total, 1)) * 100)

  return (
    <div
      className="orbit-bulk-delete-scrim fixed inset-0 flex items-end justify-center sm:items-center"
      role="presentation"
      onKeyDown={handleKeyDown}
      style={{ background: 'rgba(0,0,0,0.32)', zIndex: 70 }}
    >
      <style>{`
        @keyframes orbit-bulk-delete-scrim-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes orbit-bulk-delete-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-bulk-delete-scrim {
          animation: orbit-bulk-delete-scrim-in 150ms ease-out both;
        }
        .orbit-bulk-delete-sheet {
          animation: orbit-bulk-delete-sheet-in 200ms ease-out both;
        }
        @media (prefers-reduced-motion: reduce) {
          .orbit-bulk-delete-scrim,
          .orbit-bulk-delete-sheet { animation: none !important; }
        }
      `}</style>

      <div
        id={PANEL_ID}
        ref={panelRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={BODY_ID}
        aria-busy={busy ? true : undefined}
        className="orbit-bulk-delete-sheet w-full max-h-[90vh] overflow-y-auto rounded-t-2xl sm:max-w-[448px] sm:rounded-2xl"
        style={PANEL_STYLE}
      >
        <h2 id={TITLE_ID} style={TITLE_STYLE}>
          删除大量数据？
        </h2>
        <p id={BODY_ID} style={BODY_STYLE}>
          {`本次同步将删除 ${request.deletes} 条数据，约占本机数据的 ${percent}%。删除会同步到其他设备，且无法撤销。`}
        </p>
        <p style={HELPER_STYLE}>如果这是误操作，请取消。</p>

        <div style={BUTTON_GROUP_STYLE}>
          <button
            type="button"
            className={FOCUS_RING}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void confirm()}
            style={{
              ...DESTRUCTIVE_CONFIRM_STYLE,
              opacity: busy ? 0.4 : 1,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            确认删除
          </button>
          <button
            ref={cancelRef}
            type="button"
            className={FOCUS_RING}
            onClick={cancel}
            style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
