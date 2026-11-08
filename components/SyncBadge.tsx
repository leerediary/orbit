'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { readSession, readSessionSubject, subscribeAuthChange } from '@/lib/auth-storage'
import { isSyncConfigured } from '@/lib/api-url'
import { db } from '@/lib/local-db'
import {
  getBootstrapAccountId,
  getBootstrapComplete,
  isSyncPaused,
  subscribeSyncMetadata,
} from '@/lib/sync-store'
import { SYNC_UI_ENABLED, isSyncBadgeVisible } from '@/lib/sync-config'
import { getSyncStatus, useSyncState } from '@/lib/sync-state'
import { formatSyncAbsolute, formatSyncRelative, type SyncStatus } from '@/lib/sync-time'
import { requestSync, startSyncEngine, type SyncRunResult } from '@/lib/sync-engine'

/**
 * Global sync status badge (plan 18-05 / SYNC-03, D-03, D-04).
 *
 * Two components with a hard split (W3):
 *  - the outer `SyncBadge` is a pure gate. It subscribes to NO sync store, and
 *    returns `null` unless this build is configured, the browser has mounted,
 *    a session exists, this device bootstrapped for that account, sync is not
 *    paused, and `SYNC_UI_ENABLED` is on;
 *  - the inner `SyncBadgeInner` mounts only while that gate is true. It owns the
 *    `useSyncState` subscription, the 60 s caption tick, and the engine's
 *    `startSyncEngine()` lifecycle (its cleanup stops the engine on logout).
 *
 * The badge is a pure subscriber: it never queries Dexie, never picks a leader
 * and never pushes/pulls on its own. Browser globals (`window`, `document`,
 * `readSession`) are touched only inside effects/handlers, so the static export
 * prerenders this module safely.
 */

/** UI-SPEC §1 — bottom-right capsule, 12px above the 56px Feedback FAB. */
const CAPSULE_STYLE: CSSProperties = {
  position: 'fixed',
  right: 'max(24px, env(safe-area-inset-right))',
  bottom: 'calc(max(24px, env(safe-area-inset-bottom)) + 68px)',
  zIndex: 30,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  padding: '0 12px',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  boxShadow: 'none',
  fontFamily: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** UI-SPEC §2 — light popover above the capsule; 8px gap = capsule 44 + 8. */
const POPOVER_STYLE: CSSProperties = {
  position: 'fixed',
  right: 'max(24px, env(safe-area-inset-right))',
  bottom: 'calc(max(24px, env(safe-area-inset-bottom)) + 120px)',
  zIndex: 40,
  width: 'min(280px, calc(100vw - 32px))',
  boxSizing: 'border-box',
  padding: '16px',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
  animation: 'orbit-sync-popover-in 150ms ease-out both',
}

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

const STATUS_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const CAPTION_STYLE: CSSProperties = {
  margin: '4px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const ERROR_STYLE: CSSProperties = {
  margin: '12px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const ACTION_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: 0,
  marginTop: '16px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

function dotStyle(status: SyncStatus): CSSProperties {
  const base: CSSProperties = {
    width: '6px',
    height: '6px',
    borderRadius: '9999px',
    boxSizing: 'border-box',
    flex: '0 0 auto',
  }
  switch (status) {
    case 'offline':
      return { ...base, background: 'transparent', border: '1.5px solid var(--muted)' }
    case 'pending':
      return { ...base, background: 'var(--foreground)' }
    case 'synced':
      return { ...base, background: 'var(--muted)' }
    case 'never':
      return { ...base, background: 'var(--border)' }
  }
}

/** UI-SPEC §4 — the four locked manual-failure messages. Never raw errors. */
function manualErrorMessage(error: SyncRunResult['error']): string {
  switch (error) {
    case 'offline':
      return '无法连接服务器，请检查网络。'
    case 'server':
      return '服务器暂时不可用，请稍后再试。'
    case 'auth':
      return '登录已过期，请重新登录。'
    case 'bulk':
      return '这次同步会删除大量数据，需要确认。'
    default:
      return '同步失败，稍后会自动重试。'
  }
}

export default function SyncBadge() {
  const [mounted, setMounted] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  // BOOT-04: the badge may only appear once this device adopted a dataset.
  // Fail closed: both stay at "not eligible" until the metadata read succeeds.
  const [bootstrapped, setBootstrapped] = useState(false)
  const [paused, setPaused] = useState(true)

  useEffect(() => {
    let cancelled = false

    // Completion is bound to the current JWT `sub`; an account switch must
    // hide the badge again even though `bootstrapComplete` is still set.
    const readMeta = async () => {
      try {
        const [complete, accountId, isPaused] = await Promise.all([
          getBootstrapComplete(db),
          getBootstrapAccountId(db),
          isSyncPaused(db),
        ])
        if (cancelled) return
        const subject = readSessionSubject(readSession())
        setBootstrapped(complete === true && subject !== null && accountId === subject)
        setPaused(isPaused === true)
      } catch {
        if (cancelled) return
        // Unreadable metadata never opens the gate.
        setBootstrapped(false)
        setPaused(true)
      }
    }

    setMounted(true)
    setSignedIn(readSession() !== null)
    void readMeta()

    // Same-document login/logout flips the gate without a reload (B1).
    const unsubscribe = subscribeAuthChange((next) => {
      setSignedIn(next)
      void readMeta()
    })

    // Bootstrap writes several keys in one transaction; the metadata seam
    // reports that as a single change so the badge re-reads completion.
    const unsubscribeMeta = subscribeSyncMetadata(() => {
      void readMeta()
    })

    // Storage may also change while the tab was backgrounded without a
    // same-document event; re-read on return.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setSignedIn(readSession() !== null)
        void readMeta()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeMeta()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Pure gate: no sync store subscription happens here (W3/T-18-42).
  if (
    !isSyncBadgeVisible({
      mounted,
      enabled: SYNC_UI_ENABLED,
      configured: isSyncConfigured,
      signedIn,
      bootstrapped,
      paused,
    })
  ) {
    return null
  }

  return <SyncBadgeInner />
}

function SyncBadgeInner() {
  const state = useSyncState()
  const [open, setOpen] = useState(false)
  const [manualPending, setManualPending] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const capsuleRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const actionRef = useRef<HTMLButtonElement | null>(null)

  // This component exists only while the gate is true. Logout unmounts it and
  // the returned cleanup stops every engine trigger (B1).
  useEffect(() => startSyncEngine(), [])

  // Recompute the relative caption once a minute; purely local, no network.
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Opening moves focus to the manual action (UI-SPEC §5).
  useEffect(() => {
    if (open) actionRef.current?.focus()
  }, [open])

  // Outside pointerdown closes. Clicks inside the capsule are excluded so the
  // capsule's own toggle handler owns that path.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (popoverRef.current?.contains(target)) return
      if (capsuleRef.current?.contains(target)) return
      closePopover()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // W4: every close path clears the manual error and returns focus to the
  // capsule, so a stale failure line can never reappear on the next open.
  function closePopover() {
    setOpen(false)
    setManualError(null)
    capsuleRef.current?.focus()
  }

  async function handleManualSync() {
    setManualError(null)
    setManualPending(true)
    try {
      const result = await requestSync('manual')
      if (!result.ok) setManualError(manualErrorMessage(result.error))
    } catch {
      setManualError(manualErrorMessage('unknown'))
    } finally {
      setManualPending(false)
    }
  }

  // A sync started by another tab sets `state.syncing` through the shared
  // BroadcastChannel (W3): the popover shows it and the button disables too.
  const syncing = manualPending || state.syncing
  const status = getSyncStatus(state)
  const lastSyncedAt = state.lastSyncedAt
  const labelColor =
    status === 'offline' || status === 'pending' ? 'var(--foreground)' : 'var(--muted)'

  let label: string
  switch (status) {
    case 'offline':
      label = '离线'
      break
    case 'pending':
      label = `待同步 ${state.outboxCount} 项`
      break
    case 'synced':
      label = `已同步 · ${formatSyncRelative(lastSyncedAt ?? now, now)}`
      break
    default:
      label = '尚未同步'
      break
  }

  let statusLine: string
  if (syncing) {
    statusLine = '正在同步…'
  } else if (status === 'offline') {
    statusLine = '当前离线'
  } else if (status === 'pending') {
    statusLine = `${state.outboxCount} 项改动等待同步`
  } else if (status === 'synced') {
    statusLine = '已全部同步'
  } else {
    statusLine = '尚未同步'
  }

  const showTimeLine = lastSyncedAt != null && status !== 'offline'
  const disabled = status === 'offline' || syncing

  return (
    <>
      <style>{`
        @keyframes orbit-sync-popover-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        [data-sync-action]:hover {
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        [data-sync-action]:active {
          opacity: 0.6;
        }
        @media (prefers-reduced-motion: reduce) {
          .orbit-sync-popover { animation: none !important; }
        }
      `}</style>

      <button
        ref={capsuleRef}
        type="button"
        className="active:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="orbit-sync-popover"
        aria-label={`同步：${label}`}
        onClick={() => {
          if (open) closePopover()
          else setOpen(true)
        }}
        style={CAPSULE_STYLE}
      >
        <span aria-hidden="true" style={dotStyle(status)} />
        <span
          style={{
            fontSize: '13px',
            fontWeight: 400,
            lineHeight: 1.4,
            color: labelColor,
          }}
        >
          {label}
        </span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          id="orbit-sync-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="orbit-sync-title"
          className="orbit-sync-popover"
          style={POPOVER_STYLE}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Do not let the key reach an underlying sheet (UI-SPEC §5).
              event.stopPropagation()
              event.preventDefault()
              closePopover()
            }
          }}
        >
          <h2 id="orbit-sync-title" style={TITLE_STYLE}>
            同步
          </h2>
          <p role="status" aria-live="polite" style={STATUS_STYLE}>
            {statusLine}
          </p>
          {showTimeLine ? (
            <p style={CAPTION_STYLE}>{formatSyncAbsolute(lastSyncedAt ?? now, now)}</p>
          ) : null}
          {status === 'offline' && state.outboxCount > 0 ? (
            <p style={CAPTION_STYLE}>{`${state.outboxCount} 项改动将在联网后同步`}</p>
          ) : null}
          {status === 'offline' ? <p style={CAPTION_STYLE}>联网后会自动同步。</p> : null}
          {manualError ? <p style={ERROR_STYLE}>{manualError}</p> : null}
          <button
            ref={actionRef}
            type="button"
            data-sync-action
            disabled={disabled}
            aria-busy={disabled}
            onClick={handleManualSync}
            style={{
              ...ACTION_BUTTON_STYLE,
              opacity: disabled ? 0.4 : 1,
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            立即同步
          </button>
        </div>
      ) : null}
    </>
  )
}
