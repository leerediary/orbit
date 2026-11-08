'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { exportData } from '@/lib/data-export'
import { importData, prepareImport } from '@/lib/data-import'
import {
  cloudOnlyIds,
  executeImportDisconnect,
  executeImportOverride,
} from '@/lib/import-sync'
import { shouldShowInstallGuide } from '@/lib/pwa-install'
import { isSyncConfigured } from '@/lib/api-url'
import { BUILD_VERSION } from '@/lib/build-version'
import { readSession, readSessionSubject, type StoredSession } from '@/lib/auth-storage'
import {
  authErrorMessage,
  authedFetch,
  login,
  logout,
  type AuthErrorKind,
} from '@/lib/auth-client'
import { deriveDeviceName } from '@/lib/device-name'
import { deleteCloudAccount, type AccountDeleteError } from '@/lib/account-delete'
import { exportCloudBackup } from '@/lib/cloud-backup'
import { db } from '@/lib/local-db'
import { SYNC_UI_ENABLED } from '@/lib/sync-config'
import { startSyncEngine } from '@/lib/sync-engine'
import {
  getBootstrapAccountId,
  getBootstrapComplete,
  isSyncPaused,
  notifySyncMetadata,
  setSyncPaused,
  subscribeSyncMetadata,
} from '@/lib/sync-store'
import SyncDiagnosticsSheet from '@/components/SyncDiagnosticsSheet'
import DuplicateCleanupSheet from '@/components/DuplicateCleanupSheet'

interface SettingsSheetProps {
  onClose: () => void
  /** Page-owned refresh: re-reads goals, archived, and task progress after a replace. */
  onImported: () => Promise<void> | void
}

const TITLE_ID = 'settings-sheet-title'
const IMPORT_WARNING_ID = 'settings-sheet-import-warning'
const INSTALL_LABEL_ID = 'settings-sheet-install-label'
const CLOUD_SYNC_TITLE_ID = 'settings-cloud-sync-title'
const CLOUD_SYNC_EMAIL_ID = 'settings-cloud-sync-email'
const CLOUD_SYNC_PASSWORD_ID = 'settings-cloud-sync-password'

const FOCUS_RING = 'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'
// Full-width rows span the sheet, so their ring sits inside the row.
const ROW_FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'
const PRESS_CLASS = 'active:opacity-60'

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

const ACTION_ROW_STYLE: CSSProperties = {
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

const BODY_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

/** 17-UI-SPEC §2 — solid accent primary, matching GoalSheet's save button. */
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

const AUTH_LABEL_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const AUTH_INPUT_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '12px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  width: '100%',
  minWidth: 0,
}

const AUTH_HELPER_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

/** 20-UI-SPEC shared primitives — muted/foreground helper lines. */
const MUTED_LINE_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const SUBTLE_LINE_STYLE: CSSProperties = {
  ...MUTED_LINE_STYLE,
  margin: '4px 0 0',
}

const ERROR_LINE_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const DESTRUCTIVE_TEXT_STYLE: CSSProperties = {
  width: 'auto',
  minHeight: '44px',
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--destructive)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
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

/** 20-UI-SPEC §4 — single-select option rows (import sync choice). */
const RADIO_OPTION_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '16px',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '12px',
  background: 'var(--card)',
  borderRadius: '8px',
  textAlign: 'left',
  transition: 'border-color 120ms ease-out',
}

const RADIO_DOT_STYLE: CSSProperties = {
  width: '20px',
  height: '20px',
  flex: '0 0 20px',
  borderRadius: '9999px',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
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

const RADIO_DESC_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const CHECKBOX_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  marginTop: '16px',
  borderRadius: '8px',
  cursor: 'pointer',
}

const CHECKBOX_TEXT_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

/** Sum of the cloud-only ids across entities (the `{N}` in the copy). */
function totalIdCount(map: Record<string, string[]> | null): number {
  if (!map) return 0
  let total = 0
  for (const ids of Object.values(map)) total += ids.length
  return total
}

/**
 * Validate the manifest enough to trust its id inventory.
 *
 * Both `counts` and `ids` must be objects (the plan requires this shape) and
 * every id list must be an array of strings. Anything else returns null, which
 * the caller turns into `importManifestError` so the override option is
 * disabled — a failed read is never rendered as zero cloud-only rows.
 */
function parseManifestIds(body: unknown): Record<string, string[]> | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  const obj = body as Record<string, unknown>
  const counts = obj.counts
  if (counts == null || typeof counts !== 'object' || Array.isArray(counts)) return null
  const rawIds = obj.ids
  if (rawIds == null || typeof rawIds !== 'object' || Array.isArray(rawIds)) return null

  const ids: Record<string, string[]> = {}
  for (const [entity, list] of Object.entries(rawIds as Record<string, unknown>)) {
    if (!Array.isArray(list)) return null
    const entityIds: string[] = []
    for (const item of list) {
      if (typeof item !== 'string') return null
      entityIds.push(item)
    }
    ids[entity] = entityIds
  }
  return ids
}

const DELETE_ERROR_COPY: Record<AccountDeleteError, string> = {
  auth: '登录已过期，请重新登录后再试。',
  network: '无法连接服务器，请检查网络。',
  server: '删除失败，请稍后再试。',
  unknown: '删除失败，请稍后再试。',
}

type View =
  | 'actions'
  | 'confirm'
  | 'import-sync-choice'
  | 'import-override'
  | 'account-delete-1'
  | 'account-delete-2'
type Feedback =
  | { kind: 'success'; detail?: string }
  | { kind: 'error'; message: string; reassure?: boolean }

/**
 * Settings sheet — 06-UI-SPEC §2-§7.
 *
 * Reuses GoalSheet's chrome/focus trap and ItemSheet's in-place confirm-state
 * pattern. Presentational around persistence: exportData()/importData() own the
 * data contract, the page owns the post-import refresh (onImported). Import is
 * confirmation-gated because it is a whole-store replace (D-01..D-04).
 *
 * All navigator/matchMedia reads live in a mount effect — the static export
 * prerenders in Node, where browser globals do not exist.
 */
export default function SettingsSheet({ onClose, onImported }: SettingsSheetProps) {
  const [view, setView] = useState<View>('actions')
  const [pendingJson, setPendingJson] = useState<string | null>(null)
  // Sync-aware import choice (20-UI-SPEC §4): defaults to the network-free
  // disconnect path. `importCloudOnly` is null only when the manifest read
  // failed, and `importManifestError` then disables the override option.
  const [importChoice, setImportChoice] = useState<'disconnect' | 'override'>('disconnect')
  const [importCloudOnly, setImportCloudOnly] = useState<Record<string, string[]> | null>(null)
  const [importCheckbox, setImportCheckbox] = useState(false)
  const [importManifestError, setImportManifestError] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInstall, setShowInstall] = useState(false)

  // Cloud sync: 'unknown' until the stored session is read after mount, so no
  // signed-out form flashes before an existing session is discovered.
  const [authState, setAuthState] = useState<'unknown' | 'signed-out' | 'signed-in'>(
    'unknown',
  )
  const [session, setSession] = useState<StoredSession | null>(null)
  const [emailInput, setEmailInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [authError, setAuthError] = useState<AuthErrorKind | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [justLoggedOut, setJustLoggedOut] = useState(false)
  const [accountDeleted, setAccountDeleted] = useState(false)

  // Two-step account deletion (D-09/D-10): the checkbox is the enforced gate;
  // the export button is advisory and never enables 继续.
  const [deleteChecked, setDeleteChecked] = useState(false)
  const [deleteError, setDeleteError] = useState<AccountDeleteError | null>(null)
  const [deleteExportFailed, setDeleteExportFailed] = useState(false)

  // Per-device first-sync state for the signed-in account. `bootstrapped` means
  // THIS account completed bootstrap on this device (ids must match), and
  // `paused` is the "稍后再说 / 断开同步" runtime gate.
  const [syncStatus, setSyncStatus] = useState<{
    bootstrapped: boolean
    paused: boolean
  }>({ bootstrapped: false, paused: false })

  const runningRef = useRef(false)
  // Which action row receives focus when the sheet returns to the action list.
  const returnFocusRef = useRef<'export' | 'import'>('export')

  // The diagnostics and duplicate sheets are sibling overlays: Settings stays
  // open beneath them. The two flags are mutually exclusive.
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const hadDiagnosticsRef = useRef(false)
  const [showDuplicates, setShowDuplicates] = useState(false)
  const hadDuplicatesRef = useRef(false)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const exportButtonRef = useRef<HTMLButtonElement | null>(null)
  const importButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const importChoiceRef = useRef<HTMLButtonElement | null>(null)
  const importOverrideRef = useRef<HTMLButtonElement | null>(null)
  const emailInputRef = useRef<HTMLInputElement | null>(null)
  const passwordInputRef = useRef<HTMLInputElement | null>(null)
  const logoutButtonRef = useRef<HTMLButtonElement | null>(null)
  const diagnosticsButtonRef = useRef<HTMLButtonElement | null>(null)
  const duplicatesButtonRef = useRef<HTMLButtonElement | null>(null)

  // iOS Safari username/password autofill can set the input DOM values without
  // firing React's onChange, leaving emailInput/passwordInput empty and the
  // login button stuck disabled. Sync state from the DOM on native `input`
  // events (and once when the form mounts) so autofilled credentials work.
  useEffect(() => {
    if (authState !== 'signed-out') return
    const emailEl = emailInputRef.current
    const passwordEl = passwordInputRef.current
    const sync = () => {
      if (emailEl) setEmailInput((prev) => (emailEl.value !== prev ? emailEl.value : prev))
      if (passwordEl) setPasswordInput((prev) => (passwordEl.value !== prev ? passwordEl.value : prev))
    }
    emailEl?.addEventListener('input', sync)
    passwordEl?.addEventListener('input', sync)
    sync()
    // iOS Safari Keychain autofill can set the input value without firing the
    // `input` event (or fires it before React is listening); poll as a fallback
    // so the login button enables within ~400ms even for autofilled credentials.
    const id = setInterval(sync, 400)
    return () => {
      emailEl?.removeEventListener('input', sync)
      passwordEl?.removeEventListener('input', sync)
      clearInterval(id)
    }
  }, [authState])

  // Install gating: resolve iOS/standalone after mount, never during prerender.
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean }
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)')
        : null
    setShowInstall(
      shouldShowInstallGuide({
        userAgent: nav.userAgent,
        platform: nav.platform ?? '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        standalone: nav.standalone,
        displayModeStandalone: mq?.matches ?? false,
      }),
    )
  }, [])

  // The only storage read during mount: browser storage does not exist in the
  // static export's Node prerender, which is why authState starts 'unknown'
  // and this section renders nothing until the effect has resolved.
  useEffect(() => {
    const stored = readSession()
    setSession(stored)
    setAuthState(stored ? 'signed-in' : 'signed-out')
  }, [])

  // Resolve bootstrap/pause metadata for the signed-in account and re-read it
  // whenever a metadata write notifies. This lets a bootstrap completed by the
  // sibling SyncBootstrap modal update an already-open Settings sheet without a
  // reload, and it keeps the unfinished/paused copy tied to the current sub.
  useEffect(() => {
    if (authState !== 'signed-in' || !session) {
      setSyncStatus({ bootstrapped: false, paused: false })
      return
    }

    let cancelled = false
    const resolve = async () => {
      try {
        const [complete, accountId, paused] = await Promise.all([
          getBootstrapComplete(db),
          getBootstrapAccountId(db),
          isSyncPaused(db),
        ])
        if (cancelled) return
        const sub = readSessionSubject(session)
        setSyncStatus({
          bootstrapped: complete === true && sub !== null && accountId === sub,
          paused: paused === true,
        })
      } catch {
        // A metadata read failure is not a sync-state claim; keep the previous
        // value rather than inventing "unfinished".
      }
    }

    void resolve()
    const unsubscribe = subscribeSyncMetadata(() => {
      void resolve()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [authState, session])

  // Focus follows the view: the safe action (取消) on every confirmation
  // screen, 导出备份 on open, and the row that started the action when
  // returning to the list.
  useEffect(() => {
    if (
      view === 'confirm' ||
      view === 'import-override' ||
      view === 'account-delete-1' ||
      view === 'account-delete-2'
    ) {
      cancelButtonRef.current?.focus()
      return
    }
    if (view === 'import-sync-choice') {
      // The default choice is the safe, network-free one.
      importChoiceRef.current?.focus()
      return
    }
    if (returnFocusRef.current === 'import') {
      importButtonRef.current?.focus()
    } else {
      exportButtonRef.current?.focus()
    }
  }, [view])

  // When the sibling diagnostics sheet closes, return focus to its entry row.
  // If that row is gone (e.g. the session ended), fall back to the body.
  useEffect(() => {
    if (showDiagnostics) {
      hadDiagnosticsRef.current = true
      return
    }
    if (!hadDiagnosticsRef.current) return
    hadDiagnosticsRef.current = false
    requestAnimationFrame(() => {
      const node = diagnosticsButtonRef.current
      if (node) node.focus()
      else document.body.focus()
    })
  }, [showDiagnostics])

  // The same focus-return contract for the duplicate cleanup sheet.
  useEffect(() => {
    if (showDuplicates) {
      hadDuplicatesRef.current = true
      return
    }
    if (!hadDuplicatesRef.current) return
    hadDuplicatesRef.current = false
    requestAnimationFrame(() => {
      const node = duplicatesButtonRef.current
      if (node) node.focus()
      else document.body.focus()
    })
  }, [showDuplicates])

  function openDiagnostics() {
    // Opening does not close Settings or change its view. Only one nested
    // sheet may be open at a time.
    setShowDuplicates(false)
    setShowDiagnostics(true)
  }

  function closeDiagnostics() {
    setShowDiagnostics(false)
  }

  function openDuplicates() {
    setShowDiagnostics(false)
    setShowDuplicates(true)
  }

  function closeDuplicates() {
    setShowDuplicates(false)
  }

  function backToActions(focusOn: 'export' | 'import') {
    returnFocusRef.current = focusOn
    setPendingJson(null)
    setView('actions')
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (busy || loginBusy) return
      if (view === 'confirm') {
        backToActions('import')
        return
      }
      if (view === 'import-sync-choice') {
        backToActions('import')
        return
      }
      if (view === 'import-override') {
        // Step back to the choice screen; the parsed backup is still pending.
        setView('import-sync-choice')
        return
      }
      if (view === 'account-delete-1') {
        setDeleteChecked(false)
        setDeleteError(null)
        setDeleteExportFailed(false)
        backToActions('export')
        return
      }
      if (view === 'account-delete-2') {
        setDeleteError(null)
        setView('account-delete-1')
        return
      }
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    // Hand-rolled focus trap: cycle Tab/Shift+Tab within the dialog.
    const root = dialogRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, select, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    if (focusable.length === 0) return

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

  async function handleExport() {
    if (runningRef.current) return
    runningRef.current = true
    setFeedback(null)
    try {
      // The OS share sheet / downloaded file is the success feedback.
      await exportData()
    } catch {
      setFeedback({ kind: 'error', message: '导出失败，请重试。' })
    } finally {
      runningRef.current = false
    }
  }

  function openFilePicker() {
    const input = fileInputRef.current
    if (!input) return
    setFeedback(null)
    input.value = '' // selecting the same file twice still fires change
    input.click()
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return // picker cancelled — a no-op, not an error

    try {
      const json = await file.text()

      // Inactive sync keeps the original confirm flow unchanged.
      if (!syncActive) {
        setPendingJson(json)
        setView('confirm')
        return
      }

      // Active sync: validate first. A malformed file surfaces the existing
      // import error and never opens the choice (T-20-46).
      let plan: Awaited<ReturnType<typeof prepareImport>>
      try {
        plan = await prepareImport(json)
      } catch (e) {
        setFeedback({
          kind: 'error',
          message: e instanceof Error ? e.message : '导入失败，请重试。',
          reassure: true,
        })
        return
      }

      // Read the cloud id inventory to compute the cloud-only diff. Any failure
      // disables override; it is never rendered as a zero count (T-20-47).
      let cloudOnly: Record<string, string[]> | null = null
      let manifestError = false
      try {
        const res = await authedFetch('/v1/sync/manifest?ids=1')
        if (!res.ok) {
          manifestError = true
        } else {
          const ids = parseManifestIds(await res.json())
          if (ids) {
            cloudOnly = cloudOnlyIds(ids, plan.ids)
          } else {
            manifestError = true
          }
        }
      } catch {
        manifestError = true
      }

      setPendingJson(json)
      setImportCloudOnly(cloudOnly)
      setImportManifestError(manifestError)
      setImportChoice('disconnect')
      setImportCheckbox(false)
      setView('import-sync-choice')
    } catch {
      setFeedback({ kind: 'error', message: '导入失败：无法读取文件，请重试。' })
    }
  }

  async function handleConfirmImport() {
    if (runningRef.current || pendingJson == null) return
    runningRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await importData(pendingJson)
      // Refresh the list underneath BEFORE reporting success (Pitfall 10).
      await onImported()
      setFeedback({ kind: 'success' })
    } catch (e) {
      setFeedback({
        kind: 'error',
        message: e instanceof Error ? e.message : '导入失败，请重试。',
        reassure: true,
      })
    } finally {
      runningRef.current = false
      setBusy(false)
      backToActions('import')
    }
  }

  function handleImportChoiceKey(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: 'disconnect' | 'override',
  ) {
    const key = event.key
    if (
      key !== 'ArrowDown' &&
      key !== 'ArrowUp' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return
    }
    event.preventDefault()
    if (importManifestError) {
      // Only the safe option exists; keep focus there.
      setImportChoice('disconnect')
      importChoiceRef.current?.focus()
      return
    }
    const next = current === 'disconnect' ? 'override' : 'disconnect'
    setImportChoice(next)
    if (next === 'override') importOverrideRef.current?.focus()
    else importChoiceRef.current?.focus()
  }

  function handleImportChoicePrimary() {
    if (importChoice === 'override') {
      if (!importCheckbox) return
      // Second screen: the override is never executed from the choice row.
      setView('import-override')
      return
    }
    void handleDisconnectImport()
  }

  /**
   * Default, network-free import path (D-05). `executeImportDisconnect` pauses
   * sync and clears bootstrap completion before the local replace; this handler
   * adds no fetch, no engine call, and no cloud write of its own.
   */
  async function handleDisconnectImport() {
    if (runningRef.current || pendingJson == null) return
    runningRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await executeImportDisconnect({ db, json: pendingJson })
      // Refresh the list underneath BEFORE reporting success (Pitfall 10).
      await onImported()
      setFeedback({ kind: 'success', detail: '同步已断开，数据只保存在本机。' })
    } catch (e) {
      setFeedback({
        kind: 'error',
        message: e instanceof Error ? e.message : '导入失败，请重试。',
        reassure: true,
      })
    } finally {
      runningRef.current = false
      setBusy(false)
      backToActions('import')
    }
  }

  /**
   * Explicit override (D-05/D-06), reachable only from the second screen.
   * `executeImportOverride` awaits the guarded push internally, so success is
   * reported only after the cloud overwrite actually completed (T-20-59).
   */
  async function handleOverrideConfirm() {
    if (runningRef.current || pendingJson == null) return
    runningRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const r = await executeImportOverride({
        db,
        json: pendingJson,
        cloudOnly: importCloudOnly ?? {},
      })
      if (r.ok) {
        await onImported()
        setFeedback({ kind: 'success', detail: '云端数据已覆盖。' })
      } else {
        // imported:true means the local store was already replaced; tone the
        // failure truthfully and never show 当前数据未被修改。 (T-20-49).
        await onImported()
        setFeedback({
          kind: 'error',
          message: '导入成功，但云端覆盖未完成。请稍后重试。',
        })
      }
    } catch (e) {
      // The local import itself threw; nothing was replaced.
      setFeedback({
        kind: 'error',
        message: e instanceof Error ? e.message : '导入失败，请重试。',
        reassure: true,
      })
    } finally {
      runningRef.current = false
      setBusy(false)
      backToActions('import')
    }
  }

  function handleAuthInputChange(setter: (value: string) => void, value: string) {
    setter(value)
    // Editing either field clears the previous failure (GoalSheet's rule).
    if (authError) setAuthError(null)
    if (justLoggedOut) setJustLoggedOut(false)
    if (accountDeleted) setAccountDeleted(false)
  }

  async function handleLoginSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = emailInput.trim()
    if (!email || passwordInput === '' || loginBusy) return

    setLoginBusy(true)
    setAuthError(null)
    setJustLoggedOut(false)
    try {
      // login() writes the session through lib/auth-storage; this UI only
      // reflects the returned session. No sync module is involved (SC5).
      const result = await login(email, passwordInput)
      if (result.ok) {
        setSession(result.session)
        setAuthState('signed-in')
        setPasswordInput('')
        requestAnimationFrame(() => logoutButtonRef.current?.focus())
      } else {
        setAuthError(result.error)
      }
    } finally {
      setLoginBusy(false)
    }
  }

  function handleLogout() {
    // Local-only (D-09): clears orbit.auth.v1, keeps the device id and every
    // local database row. Never calls the server or Dexie.
    logout()
    setEmailInput(session?.email ?? emailInput)
    setPasswordInput('')
    setAuthError(null)
    setSession(null)
    setJustLoggedOut(true)
    setAccountDeleted(false)
    setAuthState('signed-out')
    requestAnimationFrame(() => emailInputRef.current?.focus())
  }

  function cancelAccountDelete() {
    setDeleteChecked(false)
    setDeleteError(null)
    setDeleteExportFailed(false)
    backToActions('export')
  }

  function openAccountDelete() {
    if (runningRef.current) return
    setDeleteChecked(false)
    setDeleteError(null)
    setDeleteExportFailed(false)
    setView('account-delete-1')
  }

  async function handleExportCloudBackup() {
    if (runningRef.current) return
    runningRef.current = true
    setDeleteExportFailed(false)
    try {
      await exportCloudBackup({ fetchFn: authedFetch })
    } catch {
      // Advisory only: a failed export is surfaced but never gates deletion.
      setDeleteExportFailed(true)
    } finally {
      runningRef.current = false
    }
  }

  async function handleConfirmAccountDelete() {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    setDeleteError(null)
    try {
      const result = await deleteCloudAccount()
      if (result.ok) {
        // Cloud is gone; local entity tables are untouched. Return to the
        // signed-out form and show the same mute-line slot as a plain logout.
        setAccountDeleted(true)
        setJustLoggedOut(false)
        setEmailInput(session?.email ?? emailInput)
        setPasswordInput('')
        setAuthError(null)
        setSession(null)
        setAuthState('signed-out')
        setDeleteChecked(false)
        setDeleteExportFailed(false)
        setPendingJson(null)
        setFeedback(null)
        setView('actions')
        requestAnimationFrame(() => emailInputRef.current?.focus())
      } else {
        // Failure keeps the session and every metadata key; stay on step 2.
        setDeleteError(result.error)
      }
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  /**
   * 开始首次同步 / 重新开启同步.
   *
   * Clearing the pause is metadata-only (never an entity-table write). The
   * notification reopens the sibling bootstrap modal when this device has not
   * completed first sync; once bootstrapped it restarts the engine instead.
   */
  async function handleStartOrResumeSync() {
    if (runningRef.current) return
    runningRef.current = true
    try {
      await setSyncPaused(db, false)
      notifySyncMetadata()
      setSyncStatus((prev) => ({ ...prev, paused: false }))
      if (syncStatus.bootstrapped) startSyncEngine()
    } catch {
      // Leave the previous state visible; the user can retry the action.
    } finally {
      runningRef.current = false
    }
  }

  const deviceName = session
    ? session.deviceName ||
      (typeof navigator !== 'undefined'
        ? deriveDeviceName(navigator.userAgent)
        : '浏览器')
    : '浏览器'
  const loginDisabled = loginBusy || emailInput.trim() === '' || passwordInput === ''

  // BOOT-03: sync is "active" only when the release gate, build configuration,
  // session, per-device first sync, and the runtime pause gate all pass.
  const syncActive =
    SYNC_UI_ENABLED &&
    isSyncConfigured &&
    session !== null &&
    syncStatus.bootstrapped &&
    !syncStatus.paused
  const overrideTotal = totalIdCount(importCloudOnly)

  return (
    <>
      <style>{`
        @keyframes orbit-settings-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-settings-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-settings-scrim { animation: orbit-settings-scrim-in 150ms ease-out both; }
        .orbit-settings-sheet { animation: orbit-settings-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-settings-scrim, .orbit-settings-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-settings-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          aria-describedby={view === 'confirm' ? IMPORT_WARNING_ID : undefined}
          className="orbit-settings-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '24px',
            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          }}
        >
          <h2 id={TITLE_ID} style={TITLE_STYLE}>
            {view === 'confirm' || view === 'import-sync-choice'
              ? '导入备份？'
              : view === 'import-override'
                ? '覆盖云端数据？'
                : view === 'account-delete-1'
                  ? '删除云账号？'
                  : view === 'account-delete-2'
                    ? '永久删除云账号？'
                    : '设置'}
          </h2>

          {view === 'confirm' ? (
            <div>
              <p id={IMPORT_WARNING_ID} style={BODY_STYLE}>
                将覆盖当前所有数据，确定导入？
              </p>

              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={handleConfirmImport}
                  disabled={busy}
                  aria-busy={busy}
                  className={FOCUS_RING}
                  style={{
                    width: '100%',
                    minHeight: '44px',
                    padding: '0 16px',
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--foreground)',
                    fontSize: '17px',
                    fontWeight: 600,
                    lineHeight: 1.47,
                    fontFamily: 'inherit',
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  确认导入
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => backToActions('import')}
                  disabled={busy}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : view === 'import-sync-choice' ? (
            <div>
              <p style={BODY_STYLE}>同步已开启。导入会整库替换本机数据。</p>

              <div
                role="radiogroup"
                aria-label="导入方式"
                style={{
                  marginTop: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  ref={importChoiceRef}
                  type="button"
                  role="radio"
                  aria-checked={importChoice === 'disconnect'}
                  tabIndex={importChoice === 'disconnect' ? 0 : -1}
                  onClick={() => {
                    setImportChoice('disconnect')
                    setImportCheckbox(false)
                  }}
                  onKeyDown={(event) => handleImportChoiceKey(event, 'disconnect')}
                  className={ROW_FOCUS_RING}
                  style={{
                    ...RADIO_OPTION_STYLE,
                    border: `1px solid ${
                      importChoice === 'disconnect' ? 'var(--accent)' : 'var(--border)'
                    }`,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      ...RADIO_DOT_STYLE,
                      border: `1.5px solid ${
                        importChoice === 'disconnect' ? 'var(--accent)' : 'var(--border)'
                      }`,
                    }}
                  >
                    {importChoice === 'disconnect' ? (
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '9999px',
                          background: 'var(--accent)',
                        }}
                      />
                    ) : null}
                  </span>
                  <span style={RADIO_CONTENT_STYLE}>
                    <span style={RADIO_TITLE_STYLE}>先断开同步再导入</span>
                    <span style={RADIO_DESC_STYLE}>
                      只改本机数据，不写入云端。导入后可重新开启同步。
                    </span>
                  </span>
                </button>

                <button
                  ref={importOverrideRef}
                  type="button"
                  role="radio"
                  aria-checked={importChoice === 'override'}
                  aria-disabled={importManifestError || undefined}
                  tabIndex={importChoice === 'override' ? 0 : -1}
                  disabled={importManifestError}
                  onClick={() => {
                    if (importManifestError) return
                    setImportChoice('override')
                  }}
                  onKeyDown={(event) => handleImportChoiceKey(event, 'override')}
                  className={ROW_FOCUS_RING}
                  style={{
                    ...RADIO_OPTION_STYLE,
                    border: `1px solid ${
                      importChoice === 'override' ? 'var(--accent)' : 'var(--border)'
                    }`,
                    cursor: importManifestError ? 'default' : 'pointer',
                    opacity: importManifestError ? 0.4 : 1,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      ...RADIO_DOT_STYLE,
                      border: `1.5px solid ${
                        importChoice === 'override' ? 'var(--accent)' : 'var(--border)'
                      }`,
                    }}
                  >
                    {importChoice === 'override' ? (
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '9999px',
                          background: 'var(--accent)',
                        }}
                      />
                    ) : null}
                  </span>
                  <span style={RADIO_CONTENT_STYLE}>
                    <span style={RADIO_TITLE_STYLE}>覆盖云端</span>
                    {!importManifestError ? (
                      <span style={RADIO_DESC_STYLE}>
                        {`把本机数据替换为备份，并删除云端独有的 ${overrideTotal} 条数据。`}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>

              {importManifestError ? (
                <p role="status" aria-live="polite" style={ERROR_LINE_STYLE}>
                  无法读取云端数据，暂时不能覆盖云端。请稍后重试，或先断开同步再导入。
                </p>
              ) : null}

              {!importManifestError && importChoice === 'override' ? (
                <label
                  className="has-[:focus-visible]:[outline:2px_solid_var(--accent)] has-[:focus-visible]:[outline-offset:2px]"
                  style={CHECKBOX_LABEL_STYLE}
                >
                  <input
                    type="checkbox"
                    checked={importCheckbox}
                    onChange={(event) => setImportCheckbox(event.target.checked)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    style={{
                      width: '22px',
                      height: '22px',
                      flex: '0 0 22px',
                      borderRadius: '9999px',
                      boxSizing: 'border-box',
                      border: importCheckbox ? 'none' : '1.5px solid var(--muted)',
                      background: importCheckbox ? 'var(--accent)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {importCheckbox ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <polyline
                          points="2.4 6.2 4.9 8.7 9.6 3.4"
                          fill="none"
                          stroke="#ffffff"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </span>
                  <span style={CHECKBOX_TEXT_STYLE}>
                    {`我明白将删除云端独有的 ${overrideTotal} 条数据`}
                  </span>
                </label>
              ) : null}

              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={handleImportChoicePrimary}
                  disabled={busy || (importChoice === 'override' && !importCheckbox)}
                  aria-busy={busy}
                  className={FOCUS_RING}
                  style={{
                    ...PRIMARY_BUTTON_STYLE,
                    cursor:
                      busy || (importChoice === 'override' && !importCheckbox)
                        ? 'default'
                        : 'pointer',
                    opacity:
                      busy || (importChoice === 'override' && !importCheckbox) ? 0.4 : 1,
                  }}
                >
                  {importChoice === 'override' ? '继续' : '断开同步并导入'}
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => backToActions('import')}
                  disabled={busy}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : view === 'import-override' ? (
            <div>
              <p style={BODY_STYLE}>
                {`云端独有的 ${overrideTotal} 条数据将被永久删除，其他设备上的数据也会被替换。此操作无法撤销。`}
              </p>
              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={handleOverrideConfirm}
                  disabled={busy}
                  aria-busy={busy}
                  className={FOCUS_RING}
                  style={{
                    ...DESTRUCTIVE_CONFIRM_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  永久覆盖云端
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => setView('import-sync-choice')}
                  disabled={busy}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : view === 'account-delete-1' ? (
            <div>
              <p style={BODY_STYLE}>
                云端数据会被永久删除，其他设备上的数据也会随之消失。本机数据会保留。此操作无法撤销。
              </p>
              <p style={MUTED_LINE_STYLE}>建议先导出备份。</p>
              <p style={SUBTLE_LINE_STYLE}>导出的是云端的数据。</p>
              <button
                type="button"
                onClick={handleExportCloudBackup}
                className={FOCUS_RING}
                style={{ ...ACTION_ROW_STYLE, marginTop: '8px', cursor: 'pointer' }}
              >
                导出云端备份
              </button>
              {deleteExportFailed ? (
                <p role="status" aria-live="polite" style={ERROR_LINE_STYLE}>
                  导出失败，请重试。
                </p>
              ) : null}
              <label
                className="has-[:focus-visible]:[outline:2px_solid_var(--accent)] has-[:focus-visible]:[outline-offset:2px]"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  minHeight: '44px',
                  marginTop: '16px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={deleteChecked}
                  onChange={(event) => setDeleteChecked(event.target.checked)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  style={{
                    width: '22px',
                    height: '22px',
                    flex: '0 0 22px',
                    borderRadius: '9999px',
                    boxSizing: 'border-box',
                    border: deleteChecked ? 'none' : '1.5px solid var(--muted)',
                    background: deleteChecked ? 'var(--accent)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {deleteChecked ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <polyline
                        points="2.4 6.2 4.9 8.7 9.6 3.4"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    fontSize: '17px',
                    fontWeight: 400,
                    lineHeight: 1.47,
                    color: 'var(--foreground)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  我了解风险，仍要删除云账号
                </span>
              </label>
              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null)
                    setView('account-delete-2')
                  }}
                  disabled={!deleteChecked}
                  className={FOCUS_RING}
                  style={{
                    ...PRIMARY_BUTTON_STYLE,
                    cursor: deleteChecked ? 'pointer' : 'default',
                    opacity: deleteChecked ? 1 : 0.4,
                  }}
                >
                  继续
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={cancelAccountDelete}
                  className={FOCUS_RING}
                  style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : view === 'account-delete-2' ? (
            <div>
              <p style={BODY_STYLE}>云端数据将立即永久删除。本机数据保留。</p>
              {deleteError ? (
                <p role="status" aria-live="polite" style={ERROR_LINE_STYLE}>
                  {DELETE_ERROR_COPY[deleteError]}
                </p>
              ) : null}
              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={handleConfirmAccountDelete}
                  disabled={busy}
                  aria-busy={busy}
                  className={FOCUS_RING}
                  style={{
                    ...DESTRUCTIVE_CONFIRM_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  永久删除云账号
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={cancelAccountDelete}
                  disabled={busy}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              {feedback ? (
                <div role="status" aria-live="polite" style={{ marginTop: '16px' }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '17px',
                      fontWeight: 400,
                      lineHeight: 1.47,
                      color: 'var(--foreground)',
                    }}
                  >
                    {feedback.kind === 'success' ? '导入成功' : feedback.message}
                  </p>
                  {feedback.kind === 'success' && feedback.detail ? (
                    <p
                      style={{
                        margin: '4px 0 0',
                        fontSize: '13px',
                        fontWeight: 400,
                        lineHeight: 1.4,
                        color: 'var(--muted)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {feedback.detail}
                    </p>
                  ) : null}
                  {feedback.kind === 'error' && feedback.reassure ? (
                    <p
                      style={{
                        margin: '4px 0 0',
                        fontSize: '13px',
                        fontWeight: 400,
                        lineHeight: 1.4,
                        color: 'var(--muted)',
                      }}
                    >
                      当前数据未被修改。
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div style={{ marginTop: feedback ? '16px' : '24px' }}>
                <button
                  ref={exportButtonRef}
                  type="button"
                  data-settings-export
                  onClick={handleExport}
                  className={`${ROW_FOCUS_RING} ${PRESS_CLASS}`}
                  style={{ ...ACTION_ROW_STYLE, cursor: 'pointer' }}
                >
                  导出备份
                </button>
                <button
                  ref={importButtonRef}
                  type="button"
                  data-settings-import
                  onClick={openFilePicker}
                  className={`${ROW_FOCUS_RING} ${PRESS_CLASS}`}
                  style={{
                    ...ACTION_ROW_STYLE,
                    borderTop: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  导入备份
                </button>
              </div>

              {showInstall ? (
                <section
                  aria-labelledby={INSTALL_LABEL_ID}
                  style={{
                    marginTop: '24px',
                    paddingTop: '24px',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <h3
                    id={INSTALL_LABEL_ID}
                    style={{
                      margin: 0,
                      fontSize: '17px',
                      fontWeight: 600,
                      lineHeight: 1.47,
                      color: 'var(--foreground)',
                    }}
                  >
                    安装到主屏幕
                  </h3>
                  <p
                    style={{
                      margin: '8px 0 0',
                      fontSize: '17px',
                      fontWeight: 400,
                      lineHeight: 1.47,
                      color: 'var(--muted)',
                    }}
                  >
                    分享 → 添加到主屏幕
                  </p>
                  <p
                    style={{
                      margin: '4px 0 0',
                      fontSize: '13px',
                      fontWeight: 400,
                      lineHeight: 1.4,
                      color: 'var(--muted)',
                    }}
                  >
                    请在 Safari 中打开 Orbit 后操作。
                  </p>
                </section>
              ) : null}

              {SYNC_UI_ENABLED && isSyncConfigured && authState !== 'unknown' ? (
                <section
                  aria-labelledby={CLOUD_SYNC_TITLE_ID}
                  style={{
                    marginTop: '24px',
                    paddingTop: '24px',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <h3
                    id={CLOUD_SYNC_TITLE_ID}
                    style={{
                      margin: 0,
                      fontSize: '17px',
                      fontWeight: 600,
                      lineHeight: 1.47,
                      color: 'var(--foreground)',
                    }}
                  >
                    云同步
                  </h3>

                  {authState === 'signed-out' ? (
                    <>
                      <p style={AUTH_HELPER_STYLE}>
                        用预置账号登录，本机数据归属于你的账号。
                      </p>
                      {accountDeleted ? (
                        <p
                          style={{
                            margin: '4px 0 0',
                            fontSize: '13px',
                            fontWeight: 400,
                            lineHeight: 1.4,
                            color: 'var(--muted)',
                          }}
                        >
                          云端数据已删除，本机数据保留。
                        </p>
                      ) : justLoggedOut ? (
                        <p
                          style={{
                            margin: '4px 0 0',
                            fontSize: '13px',
                            fontWeight: 400,
                            lineHeight: 1.4,
                            color: 'var(--muted)',
                          }}
                        >
                          退出不会删除本机数据。
                        </p>
                      ) : null}

                      <form
                        onSubmit={handleLoginSubmit}
                        noValidate
                        style={{ marginTop: '16px' }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '16px',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <label htmlFor={CLOUD_SYNC_EMAIL_ID} style={AUTH_LABEL_STYLE}>
                              邮箱
                            </label>
                            <input
                              id={CLOUD_SYNC_EMAIL_ID}
                              ref={emailInputRef}
                              type="email"
                              inputMode="email"
                              autoComplete="username"
                              autoCapitalize="none"
                              spellCheck={false}
                              maxLength={254}
                              placeholder="you@example.com"
                              enterKeyHint="go"
                              value={emailInput}
                              onChange={(event) =>
                                handleAuthInputChange(setEmailInput, event.target.value)
                              }
                              className={FOCUS_RING}
                              style={AUTH_INPUT_STYLE}
                            />
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <label htmlFor={CLOUD_SYNC_PASSWORD_ID} style={AUTH_LABEL_STYLE}>
                              密码
                            </label>
                            <input
                              id={CLOUD_SYNC_PASSWORD_ID}
                              ref={passwordInputRef}
                              type="password"
                              autoComplete="current-password"
                              maxLength={256}
                              enterKeyHint="go"
                              value={passwordInput}
                              onChange={(event) =>
                                handleAuthInputChange(setPasswordInput, event.target.value)
                              }
                              className={FOCUS_RING}
                              style={AUTH_INPUT_STYLE}
                            />
                          </div>
                        </div>

                        <button
                          type="submit"
                          disabled={loginDisabled}
                          aria-busy={loginBusy}
                          className={FOCUS_RING}
                          style={{
                            ...PRIMARY_BUTTON_STYLE,
                            marginTop: '8px',
                            cursor: loginDisabled ? 'default' : 'pointer',
                            opacity: loginDisabled ? 0.4 : 1,
                          }}
                        >
                          登录
                        </button>

                        {authError ? (
                          <p
                            role="status"
                            aria-live="polite"
                            style={{
                              margin: '16px 0 0',
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: '1.4',
                              color: 'var(--foreground)',
                            }}
                          >
                            {authErrorMessage(authError)}
                          </p>
                        ) : null}
                      </form>
                    </>
                  ) : session ? (
                    <>
                      <p
                        style={{
                          margin: '8px 0 0',
                          fontSize: '17px',
                          fontWeight: 400,
                          lineHeight: 1.47,
                          color: 'var(--foreground)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {session.email}
                      </p>
                      <p
                        style={{
                          margin: '4px 0 0',
                          fontSize: '13px',
                          fontWeight: 400,
                          lineHeight: 1.4,
                          color: 'var(--muted)',
                        }}
                      >
                        {`已在 ${deviceName} 登录`}
                      </p>
                      {!syncStatus.bootstrapped ? (
                        <>
                          <p
                            style={{
                              margin: '8px 0 0',
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: 1.4,
                              color: 'var(--muted)',
                            }}
                          >
                            首次同步未完成。
                          </p>
                          <p
                            style={{
                              margin: '4px 0 0',
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: 1.4,
                              color: 'var(--muted)',
                            }}
                          >
                            完成后才会开始同步。
                          </p>
                          <button
                            type="button"
                            onClick={handleStartOrResumeSync}
                            className={FOCUS_RING}
                            style={{ ...ACTION_ROW_STYLE, marginTop: '8px', cursor: 'pointer' }}
                          >
                            开始首次同步
                          </button>
                        </>
                      ) : syncStatus.paused ? (
                        <>
                          <p
                            style={{
                              margin: '8px 0 0',
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: 1.4,
                              color: 'var(--muted)',
                            }}
                          >
                            同步已断开。
                          </p>
                          <button
                            type="button"
                            onClick={handleStartOrResumeSync}
                            className={FOCUS_RING}
                            style={{ ...ACTION_ROW_STYLE, marginTop: '8px', cursor: 'pointer' }}
                          >
                            重新开启同步
                          </button>
                        </>
                      ) : null}
                      <div style={{ marginTop: '16px' }}>
                        <button
                          ref={diagnosticsButtonRef}
                          type="button"
                          data-settings-diagnostics
                          onClick={openDiagnostics}
                          className={`${ROW_FOCUS_RING} ${PRESS_CLASS}`}
                          style={{ ...ACTION_ROW_STYLE, cursor: 'pointer' }}
                        >
                          同步诊断
                        </button>
                        <button
                          ref={duplicatesButtonRef}
                          type="button"
                          data-settings-duplicates
                          onClick={openDuplicates}
                          className={`${ROW_FOCUS_RING} ${PRESS_CLASS}`}
                          style={{
                            ...ACTION_ROW_STYLE,
                            borderTop: '1px solid var(--border)',
                            marginTop: 0,
                            cursor: 'pointer',
                          }}
                        >
                          重复清理
                        </button>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: '16px',
                          flexWrap: 'wrap',
                          marginTop: '24px',
                        }}
                      >
                        <button
                          ref={logoutButtonRef}
                          type="button"
                          onClick={handleLogout}
                          className={FOCUS_RING}
                          style={{
                            width: 'auto',
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
                            cursor: 'pointer',
                          }}
                        >
                          退出登录
                        </button>
                        <button
                          type="button"
                          onClick={openAccountDelete}
                          className={FOCUS_RING}
                          style={DESTRUCTIVE_TEXT_STYLE}
                        >
                          删除云账号
                        </button>
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}

              <button
                type="button"
                onClick={onClose}
                className={FOCUS_RING}
                style={{
                  ...SECONDARY_BUTTON_STYLE,
                  marginTop: '24px',
                  cursor: 'pointer',
                }}
              >
                关闭设置
              </button>
              <p
                style={{
                  margin: '16px 0 0',
                  fontSize: '13px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--muted)',
                  textAlign: 'center',
                }}
              >
                版本 {BUILD_VERSION}
              </p>
            </>
          )}

          {/* Programmatic file picker; the visible 导入备份 row is the control.
              tabIndex={-1} keeps Tab out of the trap's input selector. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            tabIndex={-1}
            onChange={handleFileChange}
          />
        </div>
      </div>

      {/* Sibling overlay, not a child of the Settings dialog: it owns its own
          z-60 layer and Tab/Escape scope while Settings stays open. */}
      {showDiagnostics ? <SyncDiagnosticsSheet onClose={closeDiagnostics} /> : null}
      {showDuplicates ? <DuplicateCleanupSheet onClose={closeDuplicates} /> : null}
    </>
  )
}
