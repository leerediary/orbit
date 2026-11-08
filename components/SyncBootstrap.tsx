'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { db } from '@/lib/local-db'
import { isSyncConfigured } from '@/lib/api-url'
import { SYNC_UI_ENABLED, isBootstrapActive } from '@/lib/sync-config'
import {
  clearSession,
  readSession,
  readSessionSubject,
  subscribeAuthChange,
  type StoredSession,
} from '@/lib/auth-storage'
import {
  SYNC_KEYS,
  getBootstrapAccountId,
  getBootstrapComplete,
  getDatasetEpoch,
  isSyncPaused,
  needsBootstrap,
  setSyncCursor,
  setSyncPaused,
  setSyncValue,
  subscribeSyncMetadata,
} from '@/lib/sync-store'
import { authedFetch } from '@/lib/auth-client'
import { getLocalRepository } from '@/lib/repository-provider'
import {
  commitBootstrapComplete,
  downloadCloudBaseline,
  enqueuePurges,
  resetOutboxToLocalState,
  serverOnlyIdsByEntity,
} from '@/lib/bootstrap-local'
import { requestSync, startSyncEngine } from '@/lib/sync-engine'
import { countCoalescedDeleteIntents } from '@/lib/sync-bulk-delete'
import { readOutbox } from '@/lib/outbox'
import {
  detectBranch,
  ENTITY_LABELS,
  ENTITY_ORDER,
  serverOnlyIds,
  type BootstrapBranch,
  type BootstrapChoice,
  type BootstrapCounts,
  type BootstrapRead,
} from '@/lib/sync-bootstrap'
import { exportCloudBackup } from '@/lib/cloud-backup'
import { exportData } from '@/lib/data-export'

/**
 * Phase 20 / BOOT-01 + BOOT-02 — first-sync bootstrap modal (20-UI-SPEC §1).
 *
 * The only place a device can adopt or upload a dataset. Two rules dominate:
 *  - a failed read is NEVER rendered as empty data (no branch UI, no "0 条");
 *  - only the user's explicit choice can delete cloud-only rows or replace the
 *    local store, and both destructive choices need a second screen.
 *
 * The modal renders only when the compiled release gate, build configuration,
 * session presence, per-account completion, and `!paused` all pass. All browser
 * globals / Dexie / fetch access lives inside effects and handlers, so the
 * static-export prerender can import this module safely.
 */

const TITLE_ID = 'orbit-bootstrap-title'
const BODY_ID = 'orbit-bootstrap-body'
const PANEL_ID = 'orbit-bootstrap-panel'

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

const REASSURE_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const ERROR_DETAIL_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const BUTTON_GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '24px',
}

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'var(--accent)',
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
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

const ACCENT_TEXT_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  textAlign: 'left',
}

const TABLE_STYLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  marginTop: '16px',
  fontSize: '13px',
  fontVariantNumeric: 'tabular-nums',
}

const TH_STYLE: CSSProperties = {
  padding: '0 0 8px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const TD_LABEL_STYLE: CSSProperties = {
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  textAlign: 'left',
}

const TF_LABEL_STYLE: CSSProperties = {
  paddingTop: '12px',
  borderTop: '1px solid var(--border)',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  textAlign: 'left',
}

const TF_COUNT_STYLE: CSSProperties = {
  paddingTop: '12px',
  borderTop: '1px solid var(--border)',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

const RADIO_GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '16px',
}

const RADIO_OPTION_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '16px',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '12px',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
  transition: 'border-color 120ms ease-out',
}

const RADIO_DOT_STYLE: CSSProperties = {
  width: '20px',
  height: '20px',
  flex: '0 0 20px',
  borderRadius: '9999px',
  boxSizing: 'border-box',
  border: '1.5px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const RADIO_INNER_DOT_STYLE: CSSProperties = {
  width: '10px',
  height: '10px',
  borderRadius: '9999px',
  background: 'var(--accent)',
}

const RADIO_CONTENT_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const RADIO_TITLE_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
}

const RADIO_DESCRIPTION_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const PANEL_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  padding: '24px',
  paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
  boxShadow: 'none',
}

const CHOICES: ReadonlyArray<{ value: BootstrapChoice; label: string }> = [
  { value: 'keep-both', label: '保留双方' },
  { value: 'use-local', label: '使用本机' },
  { value: 'use-cloud', label: '使用云端' },
]

const KEEP_BOTH_EXECUTING_COPY = '正在合并两边数据。请保持网络连接。'
const USE_LOCAL_EXECUTING_COPY = '正在以本机数据为准同步。请保持网络连接。'
const USE_CLOUD_EXECUTING_COPY = '正在用云端数据替换本机数据。请保持网络连接。'
const BRANCH_B_EXECUTING_COPY = '正在下载云端数据。请保持网络连接。'

type View =
  | 'detecting'
  | 'error'
  | 'A'
  | 'B'
  | 'C'
  | 'confirm-local'
  | 'confirm-cloud'
  | 'executing'

type ReadErrorReason = 'local-throw' | 'auth' | 'network' | 'server' | 'malformed'

type BootstrapError =
  | { kind: 'read'; reason: ReadErrorReason }
  | { kind: 'exec' }

interface ManifestSnapshot {
  counts: BootstrapCounts
  ids: Record<string, string[]>
  latestSeq: number
}

interface BootstrapMetadata {
  complete: boolean
  accountId: string | null
  paused: boolean
}

const EXEC_ERROR_COPY = {
  title: '同步没有完成',
  body: '同步没有完成，请重试。',
  primary: '重试',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function zeroCounts(): BootstrapCounts {
  const counts = {} as BootstrapCounts
  for (const entity of ENTITY_ORDER) counts[entity] = 0
  return counts
}

/**
 * Validate the manifest envelope before it is allowed to drive any decision.
 *
 * Counts must be finite numbers for all nine entities and `latest_seq` must be
 * numeric. The id inventory (`ids=1`) is validated too: an unreadable list must
 * become ERROR, never an empty list — an empty id set would make "使用本机"
 * purge every cloud-only row (T-20-30).
 */
function parseManifest(body: unknown): ManifestSnapshot | null {
  if (!isRecord(body)) return null

  const rawCounts = body.counts
  if (!isRecord(rawCounts)) return null
  const counts = zeroCounts()
  for (const entity of ENTITY_ORDER) {
    const value = rawCounts[entity]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    counts[entity] = value
  }

  const latestSeq = body.latest_seq
  if (typeof latestSeq !== 'number' || !Number.isFinite(latestSeq)) return null

  const rawIds = body.ids
  if (!isRecord(rawIds)) return null
  const ids: Record<string, string[]> = {}
  for (const entity of ENTITY_ORDER) {
    const list = rawIds[entity]
    if (!Array.isArray(list)) return null
    const entityIds: string[] = []
    for (const item of list) {
      if (typeof item !== 'string') return null
      entityIds.push(item)
    }
    ids[entity] = entityIds
  }

  return { counts, ids, latestSeq }
}

function readErrorCopy(reason: ReadErrorReason): {
  title: string
  body: string
  primary: string
} {
  switch (reason) {
    case 'local-throw':
      return {
        title: '无法读取本机数据',
        body: '读取本机数据失败，请刷新页面后重试。',
        primary: '重试',
      }
    case 'auth':
      return {
        title: '无法读取云端数据',
        body: '登录已过期，请重新登录后再同步。',
        primary: '重新登录',
      }
    case 'network':
      return {
        title: '无法读取云端数据',
        body: '无法连接服务器，请检查网络后重试。',
        primary: '重试',
      }
    case 'server':
      return {
        title: '无法读取云端数据',
        body: '服务器暂时不可用，请稍后再试。',
        primary: '重试',
      }
    case 'malformed':
      return {
        title: '无法读取云端数据',
        body: '服务器返回的数据无法识别。请稍后重试。',
        primary: '重试',
      }
  }
}

export default function SyncBootstrap() {
  const [mounted, setMounted] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [session, setSession] = useState<StoredSession | null>(null)
  const [meta, setMeta] = useState<BootstrapMetadata | null>(null)

  const [view, setView] = useState<View>('detecting')
  const [error, setError] = useState<BootstrapError | null>(null)
  const [branch, setBranch] = useState<BootstrapBranch | null>(null)
  const [localCounts, setLocalCounts] = useState<BootstrapCounts | null>(null)
  const [localIds, setLocalIds] = useState<Record<string, string[]> | null>(null)
  const [manifest, setManifest] = useState<ManifestSnapshot | null>(null)
  const [choice, setChoice] = useState<BootstrapChoice>('keep-both')
  const [backupError, setBackupError] = useState<string | null>(null)
  const [executingCopy, setExecutingCopy] = useState('')

  const panelRef = useRef<HTMLDivElement | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([])
  const subjectRef = useRef<string | null>(null)
  const detectKeyRef = useRef<string | null>(null)
  const branchDoneRef = useRef(false)

  const subject = readSessionSubject(session)
  const bootstrapped = meta
    ? !needsBootstrap({
        complete: meta.complete,
        accountId: meta.accountId,
        currentSub: subject,
      })
    : false
  const active = isBootstrapActive({
    enabled: SYNC_UI_ENABLED,
    configured: isSyncConfigured,
    signedIn,
    bootstrapped,
    // Stay closed until the per-device metadata has actually been read.
    paused: meta ? meta.paused : true,
  })

  const readMeta = useCallback(async () => {
    try {
      const [complete, accountId, paused] = await Promise.all([
        getBootstrapComplete(db),
        getBootstrapAccountId(db),
        isSyncPaused(db),
      ])
      setMeta({ complete, accountId, paused })
    } catch {
      // Metadata unreadable: leave `meta` null so the modal stays closed rather
      // than guessing that this device is unclassified.
    }
  }, [])

  // Session + metadata subscriptions. A login/logout or a Settings click that
  // clears `syncPaused` flips the gate without a reload.
  useEffect(() => {
    setMounted(true)
    const stored = readSession()
    setSession(stored)
    setSignedIn(stored !== null)
    void readMeta()

    const unsubscribeAuth = subscribeAuthChange((next) => {
      const nextSession = next ? readSession() : null
      setSignedIn(next)
      setSession(nextSession)
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

  const restoreFocus = useCallback(() => {
    if (typeof document === 'undefined') return
    requestAnimationFrame(() => {
      const gear = document.querySelector<HTMLElement>('[data-settings-button]')
      if (gear) {
        gear.focus()
        return
      }
      document.body.focus()
    })
  }, [])

  const failRead = useCallback((read: Extract<BootstrapRead, { ok: false }>) => {
    const classified = detectBranch(read)
    if (classified.kind === 'ERROR') {
      setError({ kind: 'read', reason: classified.read.reason })
    }
    setView('error')
  }, [])

  const detect = useCallback(async () => {
    branchDoneRef.current = false
    setView('detecting')
    setError(null)
    setBranch(null)
    setLocalCounts(null)
    setLocalIds(null)
    setManifest(null)
    setChoice('keep-both')
    setBackupError(null)
    setExecutingCopy('')

    const currentSession = readSession()
    const currentSubject = readSessionSubject(currentSession)
    subjectRef.current = currentSubject

    // An undecodable token cannot complete bootstrap (completion is tied to the
    // JWT `sub`). Surface the re-login path instead of reading counts.
    if (!currentSubject) {
      failRead({ ok: false, where: 'server', reason: 'auth' })
      return
    }

    // Local read: live counts (tombstones excluded) plus the physical id set
    // (tombstones included) needed by use-local / use-cloud. One read each.
    let counts: BootstrapCounts
    let ids: Record<string, string[]>
    try {
      const repo = getLocalRepository()
      counts = zeroCounts()
      ids = {}
      for (const entity of ENTITY_ORDER) {
        const rows = await repo.list<Record<string, unknown>>(entity, {
          includeDeleted: true,
        })
        let live = 0
        const entityIds: string[] = []
        for (const row of rows) {
          if (typeof row.id === 'string' && row.id.length > 0) entityIds.push(row.id)
          if (row.deleted_at == null) live += 1
        }
        counts[entity] = live
        ids[entity] = entityIds
      }
    } catch {
      failRead({ ok: false, where: 'local', reason: 'local-throw' })
      return
    }

    let res: Response
    try {
      res = await authedFetch('/v1/sync/manifest?ids=1')
    } catch {
      failRead({ ok: false, where: 'server', reason: 'network' })
      return
    }

    if (res.status === 401) {
      failRead({ ok: false, where: 'server', reason: 'auth' })
      return
    }
    if (!res.ok) {
      failRead({ ok: false, where: 'server', reason: 'server' })
      return
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      failRead({ ok: false, where: 'server', reason: 'malformed' })
      return
    }

    const snapshot = parseManifest(body)
    if (!snapshot) {
      failRead({ ok: false, where: 'server', reason: 'malformed' })
      return
    }

    // Retain the single successful snapshot. Downstream screens reuse these
    // values and never issue a second manifest request or re-read local counts.
    setLocalCounts(counts)
    setLocalIds(ids)
    setManifest(snapshot)
    const next = detectBranch({ ok: true, local: counts, server: snapshot.counts })
    setBranch(next)

    if (next.kind === 'A') setView('A')
    else if (next.kind === 'B') setView('B')
    else if (next.kind === 'C') setView('C')
    // Branch D renders no branch UI; Task 3 proceeds straight to execution.
  }, [failRead])

  // Run detection once per signed-in subject whenever the gate opens. A pause
  // closes the gate; clearing the pause later re-runs detection from scratch.
  useEffect(() => {
    if (!active) {
      detectKeyRef.current = null
      return
    }
    const key = subject ?? 'no-subject'
    if (detectKeyRef.current === key) return
    detectKeyRef.current = key
    void detect()
  }, [active, subject, detect])

  // Branch D renders nothing: detecting flows straight into a silent commit.
  useEffect(() => {
    if (!active) {
      branchDoneRef.current = false
      return
    }
    if (view !== 'detecting' || branch?.kind !== 'D') return
    if (branchDoneRef.current) return
    branchDoneRef.current = true
    void executeBranchD()
  }, [active, view, branch])

  // Focus follows the view: the panel while detecting/executing, the primary
  // action on A/B and failure, the selected option on C, the safe action (返回)
  // on the destructive confirmations.
  useEffect(() => {
    if (!active) return
    if (view === 'error' || view === 'A' || view === 'B') {
      primaryRef.current?.focus()
      return
    }
    if (view === 'C') {
      const index = CHOICES.findIndex((option) => option.value === choice)
      radioRefs.current[index]?.focus()
      return
    }
    if (view === 'confirm-local' || view === 'confirm-cloud') {
      backRef.current?.focus()
      return
    }
    panelRef.current?.focus()
  }, [active, view, choice])

  const handleLater = useCallback(() => {
    // "稍后再说": close, keep the session and every local row, and pause sync.
    // No entity or outbox write happens here.
    setMeta((previous) => (previous ? { ...previous, paused: true } : previous))
    void setSyncPaused(db, true).catch(() => {
      // If the pause write fails the gate stays open on the next metadata read;
      // never fall through to a data mutation.
    })
    restoreFocus()
  }, [restoreFocus])

  const handleRetry = useCallback(() => {
    void detect()
  }, [detect])

  const handleRelogin = useCallback(() => {
    // Local-only: clear the session and close. No server call, no Dexie write.
    clearSession()
    restoreFocus()
  }, [restoreFocus])

  /**
   * Branch A / C keep-both: reset the queue to local state, force the cursor to
   * 0, run ONE awaited bootstrap sync (push then pull-from-zero through the real
   * engine), and only then commit completion.
   */
  async function performKeepBoth() {
    const accountId = subjectRef.current
    if (!accountId) throw new Error('缺少账号身份')
    await setSyncCursor(db, 0)
    await setSyncValue(db, SYNC_KEYS.status, 'idle')
    await resetOutboxToLocalState(db)
    // Bootstrap upload is a full-state reconciliation, not an accidental bulk
    // delete: local tombstones propagate as intended (and are no-ops onto an
    // empty cloud). Skip the bulk-delete pre-flight/prompt.
    const result = await requestSync('manual', {
      bootstrap: true,
      allowBulkDelete: true,
    })
    if (!result.ok) throw new Error('首次同步没有完成')
    await commitBootstrapComplete(db, accountId)
    startSyncEngine()
  }

  /**
   * Branch C use-local: recompute the cloud-only id set from the RETAINED
   * manifest, purge them (purge, never soft delete), and run one explicitly
   * guarded bulk-delete cycle. Completion is committed only after it resolves ok.
   */
  async function performUseLocal() {
    const accountId = subjectRef.current
    if (!accountId) throw new Error('缺少账号身份')
    if (!manifest || !localIds) throw new Error('缺少首次同步快照')

    const serverOnly = serverOnlyIdsByEntity(manifest.ids, localIds)
    await setSyncCursor(db, 0)
    await setSyncValue(db, SYNC_KEYS.status, 'idle')
    await resetOutboxToLocalState(db)
    await enqueuePurges(db, serverOnly)

    const declared = countCoalescedDeleteIntents(await readOutbox(db))
    const result = await requestSync('manual', {
      bootstrap: true,
      allowBulkDelete: true,
      declaredDeleteTotal: declared,
    })
    if (!result.ok) throw new Error('以本机为准的同步没有完成')
    await commitBootstrapComplete(db, accountId)
    startSyncEngine()
  }

  /**
   * Branch B / use-cloud: adopt the cloud snapshot as the local baseline.
   *
   * Branch B may still hold local tombstones; push them first (pushOnly) so a
   * same-id cloud row cannot resurrect. The paginated download validates every
   * page before its single atomic apply; a failure leaves local data untouched
   * and completion false. No `replaceAll`, no echo upload.
   */
  async function performDownload() {
    const accountId = subjectRef.current
    if (!accountId) throw new Error('缺少账号身份')

    if (branch?.kind === 'B' && localIds) {
      let physicalRows = 0
      for (const entity of ENTITY_ORDER) {
        physicalRows += localIds[entity]?.length ?? 0
      }
      if (physicalRows > 0) {
        await resetOutboxToLocalState(db)
        const declared = countCoalescedDeleteIntents(await readOutbox(db))
        const pushed = await requestSync('manual', {
          bootstrap: true,
          pushOnly: true,
          allowBulkDelete: true,
          declaredDeleteTotal: declared,
        })
        if (!pushed.ok) throw new Error('本机删除记录没有同步完成')
      }
    }

    await downloadCloudBaseline({
      repo: getLocalRepository(),
      fetchFn: (path) => authedFetch(path),
      accountId,
      epoch: (await getDatasetEpoch(db)) + 1,
    })
    startSyncEngine()
  }

  /** Branch D: both sides are empty — commit and close with no data transfer. */
  async function performBranchD() {
    const accountId = subjectRef.current
    if (!accountId) throw new Error('缺少账号身份')
    await setSyncCursor(db, 0)
    await setSyncValue(db, SYNC_KEYS.status, 'idle')
    await commitBootstrapComplete(db, accountId)
    startSyncEngine()
  }

  async function executeBranchD() {
    try {
      await performBranchD()
      restoreFocus()
    } catch {
      setError({ kind: 'exec' })
      setView('error')
    }
  }

  const beginExecution = useCallback(
    (copy: string, work: () => Promise<void>) => {
      setBackupError(null)
      setExecutingCopy(copy)
      setView('executing')
      void (async () => {
        try {
          await work()
          restoreFocus()
        } catch {
          // Any failure keeps the outbox and leaves completion false; retry
          // re-runs detection from scratch.
          setError({ kind: 'exec' })
          setView('error')
        }
      })()
    },
    [restoreFocus],
  )

  const backToChoice = useCallback(() => {
    setBackupError(null)
    setView('C')
  }, [])

  const handleContinue = useCallback(() => {
    if (choice === 'keep-both') {
      beginExecution(KEEP_BOTH_EXECUTING_COPY, performKeepBoth)
      return
    }
    setBackupError(null)
    setView(choice === 'use-local' ? 'confirm-local' : 'confirm-cloud')
  }, [choice, beginExecution])

  const handleExportCloud = useCallback(async () => {
    setBackupError(null)
    try {
      await exportCloudBackup({ fetchFn: (path) => authedFetch(path) })
    } catch {
      setBackupError('导出失败，请重试。')
    }
  }, [])

  const handleExportLocal = useCallback(async () => {
    setBackupError(null)
    try {
      await exportData()
    } catch {
      setBackupError('导出失败，请重试。')
    }
  }, [])

  function handleRadioKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const key = event.key
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return
    }
    event.preventDefault()
    const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1
    const nextIndex = (index + direction + CHOICES.length) % CHOICES.length
    setChoice(CHOICES[nextIndex].value)
    radioRefs.current[nextIndex]?.focus()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (view === 'executing') return
      if (view === 'confirm-local' || view === 'confirm-cloud') {
        backToChoice()
        return
      }
      handleLater()
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

  if (!mounted || !active) return null

  let localLive = 0
  let serverLive = 0
  if (branch?.kind === 'A' || branch?.kind === 'C') localLive = branch.localLive
  if (branch?.kind === 'B' || branch?.kind === 'C') serverLive = branch.serverLive

  // Both diffs come from the ONE retained manifest/local snapshot. No screen
  // issues a second manifest request.
  const cloudOnlyCount =
    manifest && localIds
      ? ENTITY_ORDER.reduce(
          (total, entity) =>
            total + serverOnlyIds(manifest.ids[entity] ?? [], localIds[entity] ?? []).length,
          0,
        )
      : 0
  const localOnlyCount =
    manifest && localIds
      ? ENTITY_ORDER.reduce(
          (total, entity) =>
            total + serverOnlyIds(localIds[entity] ?? [], manifest.ids[entity] ?? []).length,
          0,
        )
      : 0

  const errorCopy =
    error === null
      ? null
      : error.kind === 'exec'
        ? EXEC_ERROR_COPY
        : readErrorCopy(error.reason)

  const choiceOptions: ReadonlyArray<{
    value: BootstrapChoice
    label: string
    description: string
  }> = [
    {
      value: 'keep-both',
      label: '保留双方',
      description: '两边的数据都会保留，同名条目可能重复。',
    },
    {
      value: 'use-local',
      label: '使用本机',
      description: `以本机为准，永久删除云端独有的 ${cloudOnlyCount} 条数据。`,
    },
    {
      value: 'use-cloud',
      label: '使用云端',
      description: `以云端为准，替换本机现有的 ${localLive} 条数据。`,
    },
  ]

  function countCellStyle(value: number): CSSProperties {
    return {
      padding: '8px 0',
      borderBottom: '1px solid var(--border)',
      fontSize: '13px',
      lineHeight: 1.4,
      textAlign: 'right',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      color: value === 0 ? 'var(--muted)' : 'var(--foreground)',
      fontWeight: value === 0 ? 400 : 600,
    }
  }

  function renderScreen() {
    if (view === 'error' && errorCopy) {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            {errorCopy.title}
          </h2>
          <p id={BODY_ID} role="alert" style={BODY_STYLE}>
            {errorCopy.body}
          </p>
          <p style={REASSURE_STYLE}>本机数据未被修改。</p>
          <div style={BUTTON_GROUP_STYLE}>
            <button
              ref={primaryRef}
              type="button"
              className={FOCUS_RING}
              onClick={
                error?.kind === 'read' && error.reason === 'auth'
                  ? handleRelogin
                  : handleRetry
              }
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              {errorCopy.primary}
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={handleLater}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              稍后再说
            </button>
          </div>
        </>
      )
    }

    if (view === 'A' && branch?.kind === 'A') {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            首次同步
          </h2>
          <p id={BODY_ID} style={BODY_STYLE}>
            {`本机有 ${branch.localLive} 条数据，云端为空。上传后，这台设备的数据会同步到云端。`}
          </p>
          <div style={BUTTON_GROUP_STYLE}>
            <button
              ref={primaryRef}
              type="button"
              className={FOCUS_RING}
              onClick={() =>
                beginExecution(
                  `正在把 ${branch.localLive} 条数据上传到云端。请保持网络连接。`,
                  performKeepBoth,
                )
              }
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              上传到云端
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={handleLater}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              稍后再说
            </button>
          </div>
        </>
      )
    }

    if (view === 'B' && branch?.kind === 'B') {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            首次同步
          </h2>
          <p id={BODY_ID} style={BODY_STYLE}>
            {`云端有 ${branch.serverLive} 条数据，本机为空。下载后，这台设备会显示云端数据。`}
          </p>
          <div style={BUTTON_GROUP_STYLE}>
            <button
              ref={primaryRef}
              type="button"
              className={FOCUS_RING}
              onClick={() => beginExecution(BRANCH_B_EXECUTING_COPY, performDownload)}
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              下载到本机
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={handleLater}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              稍后再说
            </button>
          </div>
        </>
      )
    }

    if (view === 'C' && branch?.kind === 'C' && localCounts && manifest) {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            首次同步
          </h2>
          <p id={BODY_ID} style={BODY_STYLE}>
            本机与云端都有数据。选择如何合并，默认保留双方。
          </p>

          <table style={TABLE_STYLE}>
            <caption className="sr-only">本机与云端数据条数</caption>
            <thead>
              <tr>
                <th scope="col" style={{ ...TH_STYLE, textAlign: 'left' }}>
                  项目
                </th>
                <th scope="col" style={{ ...TH_STYLE, textAlign: 'right' }}>
                  本机
                </th>
                <th scope="col" style={{ ...TH_STYLE, textAlign: 'right' }}>
                  云端
                </th>
              </tr>
            </thead>
            <tbody>
              {ENTITY_ORDER.map((entity) => (
                <tr key={entity}>
                  <td style={TD_LABEL_STYLE}>{ENTITY_LABELS[entity]}</td>
                  <td style={countCellStyle(localCounts[entity])}>
                    {localCounts[entity]}
                  </td>
                  <td style={countCellStyle(manifest.counts[entity])}>
                    {manifest.counts[entity]}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={TF_LABEL_STYLE}>合计</td>
                <td style={TF_COUNT_STYLE}>{localLive}</td>
                <td style={TF_COUNT_STYLE}>{serverLive}</td>
              </tr>
            </tfoot>
          </table>

          <div role="radiogroup" aria-label="合并方式" style={RADIO_GROUP_STYLE}>
            {choiceOptions.map((option, index) => {
              const selected = choice === option.value
              return (
                <button
                  key={option.value}
                  ref={(el) => {
                    radioRefs.current[index] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setChoice(option.value)}
                  onKeyDown={(event) => handleRadioKeyDown(event, index)}
                  className={FOCUS_RING}
                  style={{
                    ...RADIO_OPTION_STYLE,
                    borderColor: selected ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      ...RADIO_DOT_STYLE,
                      borderColor: selected ? 'var(--accent)' : 'var(--border)',
                    }}
                  >
                    {selected ? <span style={RADIO_INNER_DOT_STYLE} /> : null}
                  </span>
                  <span style={RADIO_CONTENT_STYLE}>
                    <span style={RADIO_TITLE_STYLE}>{option.label}</span>
                    <span style={RADIO_DESCRIPTION_STYLE}>{option.description}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <div style={BUTTON_GROUP_STYLE}>
            <button
              ref={primaryRef}
              type="button"
              className={FOCUS_RING}
              onClick={handleContinue}
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              继续
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={handleLater}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              稍后再说
            </button>
          </div>
        </>
      )
    }

    if (view === 'confirm-local' && branch?.kind === 'C' && localCounts && manifest) {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            使用本机数据？
          </h2>
          <p id={BODY_ID} style={BODY_STYLE}>
            {`本机 ${localLive} 条数据将上传到云端；云端独有的 ${cloudOnlyCount} 条数据将被永久删除，其他设备上也会消失。`}
          </p>
          <p style={HELPER_STYLE}>建议先导出云端备份。</p>
          <p style={HELPER_STYLE}>本机备份不包含云端独有的数据。</p>
          {backupError ? <p style={ERROR_DETAIL_STYLE}>{backupError}</p> : null}
          <div style={BUTTON_GROUP_STYLE}>
            <button
              type="button"
              className={`${FOCUS_RING} hover:underline hover:underline-offset-[3px]`}
              onClick={() => void handleExportCloud()}
              style={ACCENT_TEXT_STYLE}
            >
              导出云端备份
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={() => beginExecution(USE_LOCAL_EXECUTING_COPY, performUseLocal)}
              style={DESTRUCTIVE_CONFIRM_STYLE}
            >
              使用本机数据
            </button>
            <button
              ref={backRef}
              type="button"
              className={FOCUS_RING}
              onClick={backToChoice}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              返回
            </button>
          </div>
        </>
      )
    }

    if (view === 'confirm-cloud' && branch?.kind === 'C' && localCounts && manifest) {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            使用云端数据？
          </h2>
          <p id={BODY_ID} style={BODY_STYLE}>
            {`云端的数据将替换本机现有 ${localLive} 条数据，其中 ${localOnlyCount} 条是云端没有的。此操作无法撤销。`}
          </p>
          <p style={HELPER_STYLE}>建议先导出本机备份。</p>
          {backupError ? <p style={ERROR_DETAIL_STYLE}>{backupError}</p> : null}
          <div style={BUTTON_GROUP_STYLE}>
            <button
              type="button"
              className={`${FOCUS_RING} hover:underline hover:underline-offset-[3px]`}
              onClick={() => void handleExportLocal()}
              style={ACCENT_TEXT_STYLE}
            >
              导出本机备份
            </button>
            <button
              type="button"
              className={FOCUS_RING}
              onClick={() => beginExecution(USE_CLOUD_EXECUTING_COPY, performDownload)}
              style={DESTRUCTIVE_CONFIRM_STYLE}
            >
              使用云端数据
            </button>
            <button
              ref={backRef}
              type="button"
              className={FOCUS_RING}
              onClick={backToChoice}
              style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
            >
              返回
            </button>
          </div>
        </>
      )
    }

    if (view === 'executing') {
      return (
        <>
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            正在同步…
          </h2>
          <p id={BODY_ID} role="status" aria-live="polite" style={BODY_STYLE}>
            {executingCopy}
          </p>
        </>
      )
    }

    return (
      <>
        <h2 id={TITLE_ID} style={TITLE_STYLE}>
          首次同步
        </h2>
        <p id={BODY_ID} role="status" aria-live="polite" style={BODY_STYLE}>
          正在检查本机与云端的数据…
        </p>
      </>
    )
  }

  return (
    <div
      className="orbit-bootstrap-scrim fixed inset-0 flex items-end justify-center sm:items-center"
      role="presentation"
      onKeyDown={handleKeyDown}
      style={{ background: 'rgba(0,0,0,0.32)', zIndex: 70 }}
    >
      <div
        id={PANEL_ID}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={BODY_ID}
        aria-busy={view === 'executing' ? true : undefined}
        className="orbit-bootstrap-sheet w-full max-h-[90vh] overflow-y-auto rounded-t-2xl sm:max-w-[448px] sm:rounded-2xl"
        style={PANEL_STYLE}
      >
        {renderScreen()}
      </div>
    </div>
  )
}
