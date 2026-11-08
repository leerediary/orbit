'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react'
import { authedFetch } from '@/lib/auth-client'
import { readSession, readSessionSubject, subscribeAuthChange } from '@/lib/auth-storage'
import { BUILD_VERSION } from '@/lib/build-version'
import { exportCloudBackup } from '@/lib/cloud-backup'
import { exportData } from '@/lib/data-export'
import { db } from '@/lib/local-db'
import { countOutbox } from '@/lib/outbox'
import { getLocalRepository } from '@/lib/repository-provider'
import { ENTITY_LABELS, ENTITY_ORDER } from '@/lib/sync-bootstrap'
import {
  SERVER_ERROR_COPY,
  clearQuarantineEntries,
  formatDeviceLastSeen,
  formatDiagnosticTime,
  formatSnapshotDate,
  isServerVersionMismatch,
  localOnlyIds,
  readCloudManifest,
  readDiagnostics,
  readLocalInventory,
  readServerVersion,
  sanitizeQuarantineReason,
  serverOnlyIdsFromManifest,
  totalIds,
  type CloudManifest,
  type DiagnosticsSnapshot,
  type LocalInventory,
  type ServerErrorReason,
} from '@/lib/sync-diagnostics'
import { requestSync, type SyncRunOptions } from '@/lib/sync-engine'
import {
  fetchDevices,
  fetchSnapshots,
  restoreSnapshot,
  revokeDevice,
  type DeviceInfo,
  type SnapshotInfo,
} from '@/lib/sync-ops-client'
import { resyncFromCloud, resyncToCloud, type ResyncFailure } from '@/lib/sync-resync'

/**
 * Phase 21 / OPS-01 — the diagnostics sheet (21-UI-SPEC §2 and §3).
 *
 * A z-60 sibling of SettingsSheet: it opens on top of Settings, owns its own
 * focus trap, and closes back to the Settings entry row. Everything the sheet
 * renders is metadata — cursor, counts, error code, versions, quarantine labels
 * and dates. Entity names, bodies and notes are never read into this render
 * tree, and a failed local read is always the error view, never "0 items".
 *
 * The resync escape hatch follows "numbers, then choice, then a second
 * confirmation": a two-sided count table precedes either direction, and the
 * destructive push additionally requires an explicit risk acknowledgement.
 * The browser global / Dexie / fetch calls all live in effects and handlers, so
 * importing this module is safe during the static-export prerender.
 */

const TITLE_ID = 'orbit-diagnostics-title'
const QUARANTINE_ID = 'orbit-diagnostics-quarantine'

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

const HELPER_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

/** A muted helper line promoted to foreground for a real consequence. */
const CONSEQUENCE_STYLE: CSSProperties = {
  ...HELPER_STYLE,
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

const STATUS_LINE_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  minHeight: '44px',
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
}

const DT_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const DD_STYLE: CSSProperties = {
  margin: 0,
  minWidth: 0,
  textAlign: 'right',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
  fontVariantNumeric: 'tabular-nums',
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
  cursor: 'pointer',
}

const INLINE_ACCENT_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 0 0 8px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

/** Destructive confirm: destructive text + 1px outline, never a red fill. */
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
  cursor: 'pointer',
}

/** Row action: destructive text only, no fill (21-UI-SPEC §4–§5). */
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

/** Two-line snapshot / device row: content column plus a fixed action (56px). */
const LIST_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '16px',
  minHeight: '56px',
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
}

const LIST_TITLE_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const LIST_META_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

/** Non-interactive `当前设备` marker: border + muted text, never accent. */
const CURRENT_DEVICE_CHIP_STYLE: CSSProperties = {
  flex: '0 0 auto',
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const TABLE_STYLE: CSSProperties = {
  width: '100%',
  marginTop: '16px',
  borderCollapse: 'collapse',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
}

const TABLE_HEAD_STYLE: CSSProperties = {
  padding: '0 0 8px',
  borderBottom: '1px solid var(--border)',
  fontSize: '13px',
  fontWeight: 400,
  color: 'var(--muted)',
  textAlign: 'left',
}

const TABLE_HEAD_NUM_STYLE: CSSProperties = {
  ...TABLE_HEAD_STYLE,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

const TABLE_LABEL_STYLE: CSSProperties = {
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
  color: 'var(--foreground)',
}

const TABLE_NUM_STYLE: CSSProperties = {
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
}

const tableTotalLabelStyle: CSSProperties = {
  padding: '8px 0',
  borderTop: '1px solid var(--border)',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
}

const tableTotalNumStyle: CSSProperties = {
  padding: '8px 0',
  borderTop: '1px solid var(--border)',
  textAlign: 'right',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
}

/** Zero is muted/400, a real count is foreground/600 (21-UI-SPEC §Shared). */
function countCellStyle(value: number): CSSProperties {
  return {
    ...TABLE_NUM_STYLE,
    color: value > 0 ? 'var(--foreground)' : 'var(--muted)',
    fontWeight: value > 0 ? 600 : 400,
  }
}

function totalCellStyle(value: number): CSSProperties {
  return {
    ...tableTotalNumStyle,
    color: value > 0 ? 'var(--foreground)' : 'var(--muted)',
  }
}

function radioOptionStyle(selected: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: '44px',
    padding: '16px',
    background: 'none',
    border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '16px',
    textAlign: 'left',
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'border-color 120ms ease-out',
  }
}

function radioDotStyle(selected: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    width: '20px',
    height: '20px',
    borderRadius: '9999px',
    border: selected ? '1.5px solid var(--accent)' : '1.5px solid var(--muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    transition: 'border-color 120ms ease-out',
  }
}

function checkboxStyle(checked: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    width: '22px',
    height: '22px',
    borderRadius: '9999px',
    border: checked ? 'none' : '1.5px solid var(--muted)',
    background: checked ? 'var(--accent)' : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    transition: 'background 120ms ease-out',
  }
}

function readFailureCopy(reason: 'local' | ServerErrorReason | null): string {
  if (reason === 'local') return '读取本机数据失败，请刷新页面后重试。'
  if (reason === null) return SERVER_ERROR_COPY.unknown
  return SERVER_ERROR_COPY[reason]
}

/** One `<dl>` row. The last row drops its divider (21-UI-SPEC §Shared). */
function DiagnosticRow({
  label,
  last,
  children,
}: {
  label: string
  last?: boolean
  children: ReactNode
}) {
  return (
    <div style={{ ...ROW_STYLE, borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <dt style={DT_STYLE}>{label}</dt>
      <dd style={DD_STYLE}>{children}</dd>
    </div>
  )
}

/** One full-width radio option for the resync direction group. */
function ResyncOption({
  selected,
  label,
  description,
  radioRef,
  onSelect,
}: {
  selected: boolean
  label: string
  description: string
  radioRef: RefObject<HTMLButtonElement | null>
  onSelect: () => void
}) {
  return (
    <button
      ref={radioRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={FOCUS_RING}
      style={radioOptionStyle(selected)}
    >
      <span aria-hidden="true" style={radioDotStyle(selected)}>
        {selected ? (
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
      <span style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        <span
          style={{
            fontSize: '17px',
            fontWeight: 600,
            lineHeight: 1.47,
            color: 'var(--foreground)',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 400,
            lineHeight: 1.4,
            color: 'var(--muted)',
            overflowWrap: 'anywhere',
          }}
        >
          {description}
        </span>
      </span>
    </button>
  )
}

type ResyncDirection = 'pull' | 'push'

type View =
  | 'overview'
  | 'quarantine-clear'
  | 'resync-loading'
  | 'resync-choice'
  | 'resync-pull-confirm'
  | 'resync-push-confirm'
  | 'resync-executing'
  | 'resync-error'
  | 'snapshots'
  | 'snapshot-confirm'
  | 'devices'
  | 'device-confirm'

/**
 * Current device first, then most-recent activity, with unknown activity last.
 * The server already orders this way; sorting again keeps the list stable after
 * a client-side revoke removes a row.
 */
function sortDevices(list: DeviceInfo[], currentDeviceId: string | null): DeviceInfo[] {
  return [...list].sort((a, b) => {
    const aCurrent = a.id === currentDeviceId
    const bCurrent = b.id === currentDeviceId
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1

    const aMs = a.last_seen_at === null ? null : Date.parse(a.last_seen_at)
    const bMs = b.last_seen_at === null ? null : Date.parse(b.last_seen_at)
    const aKnown = aMs !== null && Number.isFinite(aMs)
    const bKnown = bMs !== null && Number.isFinite(bMs)
    if (!aKnown && !bKnown) return 0
    if (!aKnown) return 1
    if (!bKnown) return -1
    return (bMs as number) - (aMs as number)
  })
}

interface SyncDiagnosticsSheetProps {
  onClose: () => void
}

export default function SyncDiagnosticsSheet({ onClose }: SyncDiagnosticsSheetProps) {
  const [view, setView] = useState<View>('overview')
  const [loading, setLoading] = useState(true)
  const [localError, setLocalError] = useState(false)
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [serverVersion, setServerVersion] = useState<number | null>(null)
  const [serverVersionReason, setServerVersionReason] = useState<ServerErrorReason | null>(null)
  const [quarantineOpen, setQuarantineOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusLine, setStatusLine] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Resync (21-UI-SPEC §3).
  const [resyncDirection, setResyncDirection] = useState<ResyncDirection>('pull')
  const [resyncInventory, setResyncInventory] = useState<LocalInventory | null>(null)
  const [resyncManifest, setResyncManifest] = useState<CloudManifest | null>(null)
  const [resyncOutboxCount, setResyncOutboxCount] = useState(0)
  const [resyncFailure, setResyncFailure] = useState<'local' | ServerErrorReason | null>(null)
  const [resyncFailureReason, setResyncFailureReason] = useState<ResyncFailure | null>(null)
  const [resyncErrorDirection, setResyncErrorDirection] = useState<ResyncDirection>('pull')
  const [resyncBusyDirection, setResyncBusyDirection] = useState<ResyncDirection>('pull')
  const [pushAcknowledged, setPushAcknowledged] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Snapshots (21-UI-SPEC §4). A failure holds `snapshotsError`; the list stays
  // null so nothing can render as "0 snapshots".
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null)
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState<ServerErrorReason | null>(null)
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotInfo | null>(null)
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [snapshotActionError, setSnapshotActionError] = useState<string | null>(null)

  // Device sessions (21-UI-SPEC §5).
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState<ServerErrorReason | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceActionError, setDeviceActionError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)
  const pullOptionRef = useRef<HTMLButtonElement | null>(null)
  const pushOptionRef = useRef<HTMLButtonElement | null>(null)
  const busyRef = useRef(false)
  const resyncRunningRef = useRef(false)
  const snapshotRunningRef = useRef(false)
  const deviceRunningRef = useRef(false)

  /**
   * Local and server reads run together. A local failure replaces the overview
   * with the error view and clears the snapshot (never a zero-filled one); a
   * server failure only nulls the version row and leaves every other row alone.
   */
  const loadDiagnostics = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true)

    const [local, server] = await Promise.all([
      readDiagnostics(db),
      readServerVersion(authedFetch),
    ])

    if (local.ok) {
      setSnapshot(local.snapshot)
      setLocalError(false)
    } else {
      setSnapshot(null)
      setLocalError(true)
    }

    if (server.ok) {
      setServerVersion(server.version)
      setServerVersionReason(null)
    } else {
      setServerVersion(null)
      setServerVersionReason(server.reason)
    }

    if (initial) setLoading(false)
  }, [])

  useEffect(() => {
    void loadDiagnostics(true)
    // Initial focus lands on the panel itself (21-UI-SPEC §2).
    panelRef.current?.focus()
  }, [loadDiagnostics])

  // Logging out anywhere closes the diagnostics surface.
  useEffect(() => {
    const unsubscribe = subscribeAuthChange((signedIn) => {
      if (!signedIn) onClose()
    })
    return unsubscribe
  }, [onClose])

  // Focus follows the safety hierarchy: the selected option, the safe action,
  // or the panel while work is in flight.
  useEffect(() => {
    if (view === 'quarantine-clear') {
      cancelButtonRef.current?.focus()
      return
    }
    if (view === 'snapshot-confirm' || view === 'device-confirm') {
      cancelButtonRef.current?.focus()
      return
    }
    if (view === 'snapshots' || view === 'devices') {
      panelRef.current?.focus()
      return
    }
    if (view === 'resync-loading' || view === 'resync-executing') {
      panelRef.current?.focus()
      return
    }
    if (view === 'resync-choice') {
      const target = resyncDirection === 'pull' ? pullOptionRef : pushOptionRef
      target.current?.focus()
      return
    }
    if (
      view === 'resync-pull-confirm' ||
      view === 'resync-push-confirm' ||
      view === 'resync-error'
    ) {
      backButtonRef.current?.focus()
    }
  }, [view, resyncDirection])

  function backToOverview() {
    setExportError(null)
    setPushAcknowledged(false)
    setSelectedSnapshot(null)
    setSnapshotActionError(null)
    setSelectedDevice(null)
    setDeviceActionError(null)
    setView('overview')
    void loadDiagnostics(false)
  }

  /**
   * Read both sides and the outbox before offering a direction. Any failure is
   * the error view — a partial table or a zero count is never rendered.
   */
  const startResyncLoad = useCallback(async () => {
    setResyncFailure(null)
    setResyncFailureReason(null)
    setExportError(null)
    setPushAcknowledged(false)
    setView('resync-loading')

    let local: Awaited<ReturnType<typeof readLocalInventory>>
    let manifest: Awaited<ReturnType<typeof readCloudManifest>>
    let outbox: number
    try {
      ;[local, manifest, outbox] = await Promise.all([
        readLocalInventory(db),
        readCloudManifest(authedFetch),
        countOutbox(db),
      ])
    } catch {
      // countOutbox is the only local read that can reject here.
      setResyncFailure('local')
      setView('resync-error')
      return
    }

    if (!local.ok) {
      setResyncFailure('local')
      setView('resync-error')
      return
    }
    if (!manifest.ok) {
      setResyncFailure(manifest.reason)
      setView('resync-error')
      return
    }

    setResyncInventory(local.inventory)
    setResyncManifest(manifest.manifest)
    setResyncOutboxCount(outbox)
    setResyncDirection('pull')
    setView('resync-choice')
  }, [])

  /**
   * Execute the confirmed direction. The production `requestSync(reason, opts)`
   * signature is adapted to the opts-only `ResyncDeps.runSync`; passing it bare
   * would drop `bootstrap`/`allowBulkDelete` and block the re-push.
   */
  const runResync = useCallback(
    async (direction: ResyncDirection) => {
      if (resyncRunningRef.current) return
      resyncRunningRef.current = true
      setResyncBusyDirection(direction)
      setResyncErrorDirection(direction)
      setResyncFailureReason(null)
      setExportError(null)
      setView('resync-executing')

      const accountId = readSessionSubject(readSession()) ?? ''
      if (accountId === '') {
        // An empty subject is an auth failure; never run an anonymous reset.
        setResyncFailureReason('auth')
        setView('resync-error')
        resyncRunningRef.current = false
        return
      }

      try {
        const deps = {
          db,
          repo: getLocalRepository(),
          fetchFn: authedFetch,
          accountId,
          runSync: (opts?: SyncRunOptions) => requestSync('manual', opts),
        }
        const result =
          direction === 'pull' ? await resyncFromCloud(deps) : await resyncToCloud(deps)

        if (result.ok) {
          await loadDiagnostics(false)
          setStatusLine(
            direction === 'pull' ? '已从云端重新下载。' : '已用本机数据覆盖云端。',
          )
          setView('overview')
        } else {
          setResyncFailureReason(result.reason)
          setResyncErrorDirection(direction)
          setView('resync-error')
        }
      } catch {
        setResyncFailureReason('unknown')
        setResyncErrorDirection(direction)
        setView('resync-error')
      } finally {
        resyncRunningRef.current = false
      }
    },
    [loadDiagnostics],
  )

  function handleContinueResync() {
    setExportError(null)
    setPushAcknowledged(false)
    setView(resyncDirection === 'pull' ? 'resync-pull-confirm' : 'resync-push-confirm')
  }

  function handleConfirmResync(direction: ResyncDirection) {
    // The checkbox is the gate; re-check it here as well as on the button.
    if (direction === 'push' && !pushAcknowledged) return
    void runResync(direction)
  }

  async function handleExportLocal() {
    setExportError(null)
    try {
      await exportData()
    } catch {
      setExportError('导出失败，请重试。')
    }
  }

  async function handleExportCloud() {
    setExportError(null)
    try {
      await exportCloudBackup({ fetchFn: authedFetch })
    } catch {
      setExportError('导出失败，请重试。')
    }
  }

  async function loadSnapshots() {
    setSnapshotsLoading(true)
    setSnapshotsError(null)
    // Never keep a previous list visible while a new read is in flight.
    setSnapshots(null)
    const result = await fetchSnapshots(authedFetch)
    if (result.ok) {
      setSnapshots(result.snapshots)
    } else {
      setSnapshotsError(result.reason)
    }
    setSnapshotsLoading(false)
  }

  function openSnapshots() {
    setExportError(null)
    setSelectedSnapshot(null)
    setSnapshotActionError(null)
    setView('snapshots')
    void loadSnapshots()
  }

  async function loadDevices() {
    setDevicesLoading(true)
    setDevicesError(null)
    setDevices(null)
    setCurrentDeviceId(readSession()?.deviceId ?? null)
    const result = await fetchDevices(authedFetch)
    if (result.ok) {
      setDevices(result.devices)
    } else {
      setDevicesError(result.reason)
    }
    setDevicesLoading(false)
  }

  function openDevices() {
    setExportError(null)
    setSelectedDevice(null)
    setDeviceActionError(null)
    setView('devices')
    void loadDevices()
  }

  /**
   * Restore = server rollback, then a local re-pull. Both steps must succeed
   * before we claim anything: the server may have already rolled back when the
   * pull fails, so a failure never says "cloud unchanged" (T-21-07-02).
   */
  async function handleConfirmSnapshotRestore() {
    if (snapshotRunningRef.current || !selectedSnapshot) return
    snapshotRunningRef.current = true
    setSnapshotBusy(true)
    setSnapshotActionError(null)
    const target = selectedSnapshot

    try {
      const accountId = readSessionSubject(readSession())
      if (accountId === null || accountId === '') {
        // Without an identity we cannot re-pull; do not POST a restore we cannot follow.
        setSnapshotActionError('恢复没有完成，请重试。')
        return
      }

      const restored = await restoreSnapshot(authedFetch, target.date)
      if (!restored.ok) {
        setSnapshotActionError('恢复没有完成，请重试。')
        return
      }

      const resync = await resyncFromCloud({
        db,
        repo: getLocalRepository(),
        fetchFn: authedFetch,
        accountId,
        // opts-only adapter: bare requestSync would drop bootstrap/allowBulkDelete.
        runSync: (opts?: SyncRunOptions) => requestSync('manual', opts),
      })
      if (!resync.ok) {
        // The cloud may already be rolled back; never claim it is unchanged.
        setSnapshotActionError('恢复没有完成，请重试。')
        return
      }

      await loadDiagnostics(false)
      setStatusLine(`已恢复到 ${formatSnapshotDate(target.date, new Date())} 的快照。`)
      setView('overview')
    } catch {
      setSnapshotActionError('恢复没有完成，请重试。')
    } finally {
      snapshotRunningRef.current = false
      setSnapshotBusy(false)
    }
  }

  async function handleConfirmDeviceRevoke() {
    if (deviceRunningRef.current || !selectedDevice) return
    const target = selectedDevice
    if (currentDeviceId === null || target.id === currentDeviceId) {
      // The UI never offers this; the server rejection is the second gate.
      setDeviceActionError('撤销失败，请稍后重试。')
      return
    }

    deviceRunningRef.current = true
    setDeviceBusy(true)
    setDeviceActionError(null)

    try {
      const result = await revokeDevice(authedFetch, target.id, currentDeviceId)
      if (!result.ok) {
        setDeviceActionError('撤销失败，请稍后重试。')
        return
      }
      setDevices((current) =>
        current === null ? current : current.filter((device) => device.id !== target.id),
      )
      setSelectedDevice(null)
      setStatusLine(`已撤销 ${target.name ?? '未命名设备'} 的会话。`)
      setView('devices')
    } catch {
      setDeviceActionError('撤销失败，请稍后重试。')
    } finally {
      deviceRunningRef.current = false
      setDeviceBusy(false)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // This sheet is a sibling of Settings, but stop these events regardless so
    // the Settings trap can never observe them.
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (busyRef.current) return
      // No cancel while a resync read/run, restore or revoke is in flight.
      if (view === 'resync-loading' || view === 'resync-executing') return
      if (snapshotRunningRef.current || deviceRunningRef.current) return
      if (view === 'snapshot-confirm') {
        setView('snapshots')
        return
      }
      if (view === 'device-confirm') {
        setView('devices')
        return
      }
      if (view === 'snapshots' || view === 'devices') {
        backToOverview()
        return
      }
      if (view === 'resync-pull-confirm' || view === 'resync-push-confirm') {
        setView('resync-choice')
        return
      }
      if (view === 'resync-choice' || view === 'resync-error') {
        backToOverview()
        return
      }
      if (view === 'quarantine-clear') {
        // Back to the overview with the quarantine list still expanded.
        setView('overview')
        return
      }
      onClose()
      return
    }

    if (event.key !== 'Tab') return

    // Hand-rolled focus trap scoped to this panel (never Settings' dialogRef).
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

  function handleRadioKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setResyncDirection('push')
      pushOptionRef.current?.focus()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setResyncDirection('pull')
      pullOptionRef.current?.focus()
    }
  }

  async function handleClearQuarantine() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    setStatusLine(null)
    try {
      await clearQuarantineEntries(db)
      await loadDiagnostics(false)
      setView('overview')
      setStatusLine('隔离项已清除。')
    } catch {
      // Stay in the confirmation view; the records may not have been cleared.
      setActionError('清除失败，请重试。')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const quarantine = snapshot?.quarantine ?? []
  const quarantineCount = quarantine.length
  const serverVersionKnown = serverVersion !== null
  const versionMismatch = serverVersionKnown && isServerVersionMismatch(serverVersion)

  const resyncTotalLocal = resyncInventory
    ? ENTITY_ORDER.reduce((sum, entity) => sum + (resyncInventory.counts[entity] ?? 0), 0)
    : 0
  const resyncTotalCloud = resyncManifest
    ? ENTITY_ORDER.reduce((sum, entity) => sum + (resyncManifest.counts[entity] ?? 0), 0)
    : 0
  const localOnlyCount =
    resyncInventory && resyncManifest
      ? totalIds(localOnlyIds(resyncInventory, resyncManifest))
      : 0
  const serverOnlyCount =
    resyncInventory && resyncManifest
      ? totalIds(serverOnlyIdsFromManifest(resyncInventory, resyncManifest))
      : 0

  const executionFailed = resyncFailureReason !== null
  const resyncErrorBody = executionFailed
    ? resyncErrorDirection === 'pull'
      ? '本机数据未被修改。请重试。'
      : '云端可能只更新了一部分，请重试。'
    : readFailureCopy(resyncFailure)

  let heading = localError ? '无法读取同步状态' : '同步诊断'
  if (view === 'quarantine-clear') {
    heading = '清除隔离项？'
  } else if (view === 'resync-loading' || view === 'resync-choice') {
    heading = '全量重同步'
  } else if (view === 'resync-pull-confirm') {
    heading = '从云端全量重拉？'
  } else if (view === 'resync-push-confirm') {
    heading = '从本机全量重推？'
  } else if (view === 'resync-executing') {
    heading = '正在重同步…'
  } else if (view === 'resync-error') {
    heading = executionFailed
      ? '重同步没有完成'
      : resyncFailure === 'local'
        ? '无法读取本机数据'
        : '无法读取云端数据'
  } else if (view === 'snapshots') {
    heading = snapshotsError ? '无法读取快照' : '快照恢复'
  } else if (view === 'snapshot-confirm' && selectedSnapshot) {
    heading = `恢复到 ${formatSnapshotDate(selectedSnapshot.date, new Date())} 的快照？`
  } else if (view === 'devices') {
    heading = devicesError ? '无法读取设备列表' : '设备会话'
  } else if (view === 'device-confirm') {
    heading = '撤销这台设备？'
  }

  return (
    <div
      className="orbit-diagnostics-scrim fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
      role="presentation"
      onKeyDown={handleKeyDown}
      style={{ background: 'rgba(0,0,0,0.32)' }}
    >
      <style>{`
        @keyframes orbit-diagnostics-scrim-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes orbit-diagnostics-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-diagnostics-scrim { animation: orbit-diagnostics-scrim-in 150ms ease-out both; }
        .orbit-diagnostics-sheet { animation: orbit-diagnostics-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-diagnostics-scrim, .orbit-diagnostics-sheet { animation: none !important; }
        }
      `}</style>

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-busy={
          busy || snapshotBusy || deviceBusy || view === 'resync-executing'
            ? true
            : undefined
        }
        className="orbit-diagnostics-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          padding: '24px',
          paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          boxShadow: 'none',
        }}
      >
        <h2 id={TITLE_ID} style={TITLE_STYLE}>
          {heading}
        </h2>

        {view === 'quarantine-clear' ? (
          <div>
            <p style={BODY_STYLE}>
              清除后这些记录不再出现在诊断里。不会删除或修改任何数据，也不会重新同步这些条目。
            </p>
            {actionError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {actionError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void handleClearQuarantine()}
                disabled={busy}
                aria-busy={busy}
                className={FOCUS_RING}
                style={{
                  ...PRIMARY_BUTTON_STYLE,
                  opacity: busy ? 0.4 : 1,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {busy ? '正在清除…' : '清除'}
              </button>
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setView('overview')}
                disabled={busy}
                className={FOCUS_RING}
                style={{
                  ...SECONDARY_BUTTON_STYLE,
                  opacity: busy ? 0.4 : 1,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : view === 'resync-loading' ? (
          <div>
            <p style={BODY_STYLE}>选择以哪一侧为准。重同步会整库替换，不能撤销。</p>
            <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
              正在读取本机与云端的数据…
            </p>
          </div>
        ) : view === 'resync-choice' ? (
          <div>
            <p style={BODY_STYLE}>选择以哪一侧为准。重同步会整库替换，不能撤销。</p>

            {resyncInventory && resyncManifest ? (
              <table style={TABLE_STYLE} aria-label="本机与云端数据计数">
                <thead>
                  <tr>
                    <th scope="col" style={TABLE_HEAD_STYLE}>
                      项目
                    </th>
                    <th scope="col" style={TABLE_HEAD_NUM_STYLE}>
                      本机
                    </th>
                    <th scope="col" style={TABLE_HEAD_NUM_STYLE}>
                      云端
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ENTITY_ORDER.map((entity) => {
                    const localCount = resyncInventory.counts[entity] ?? 0
                    const cloudCount = resyncManifest.counts[entity] ?? 0
                    return (
                      <tr key={entity}>
                        <td style={TABLE_LABEL_STYLE}>{ENTITY_LABELS[entity]}</td>
                        <td style={countCellStyle(localCount)}>{localCount}</td>
                        <td style={countCellStyle(cloudCount)}>{cloudCount}</td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td style={tableTotalLabelStyle}>合计</td>
                    <td style={totalCellStyle(resyncTotalLocal)}>{resyncTotalLocal}</td>
                    <td style={totalCellStyle(resyncTotalCloud)}>{resyncTotalCloud}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            <div
              role="radiogroup"
              aria-label="重同步方向"
              onKeyDown={handleRadioKeyDown}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '16px',
              }}
            >
              <ResyncOption
                selected={resyncDirection === 'pull'}
                label="从云端全量重拉"
                description="清空本机数据，再从云端重新下载。云端是权威。"
                radioRef={pullOptionRef}
                onSelect={() => setResyncDirection('pull')}
              />
              <ResyncOption
                selected={resyncDirection === 'push'}
                label="从本机全量重推"
                description="清空云端数据，再用本机数据覆盖云端。其他设备也会被替换。"
                radioRef={pushOptionRef}
                onSelect={() => setResyncDirection('push')}
              />
            </div>

            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={handleContinueResync}
                className={FOCUS_RING}
                style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                继续
              </button>
              <button
                type="button"
                onClick={backToOverview}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                取消
              </button>
            </div>
          </div>
        ) : view === 'resync-pull-confirm' ? (
          <div>
            <p style={BODY_STYLE}>
              本机数据会被清空，然后从云端重新下载。其他设备不受影响。此操作无法撤销。
            </p>
            <p style={resyncOutboxCount > 0 ? CONSEQUENCE_STYLE : HELPER_STYLE}>
              {resyncOutboxCount > 0
                ? `待同步的 ${resyncOutboxCount} 项改动会丢失。`
                : '本机没有待同步的改动。'}
            </p>
            <p style={localOnlyCount > 0 ? CONSEQUENCE_STYLE : HELPER_STYLE}>
              {localOnlyCount > 0
                ? `本机独有的 ${localOnlyCount} 条数据将被删除。`
                : '本机没有云端缺少的数据。'}
            </p>
            <p style={HELPER_STYLE}>建议先导出本机备份。</p>
            <button
              type="button"
              onClick={() => void handleExportLocal()}
              className={FOCUS_RING}
              style={ACCENT_TEXT_STYLE}
            >
              导出本机备份
            </button>
            {exportError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {exportError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => handleConfirmResync('pull')}
                className={FOCUS_RING}
                style={DESTRUCTIVE_CONFIRM_STYLE}
              >
                从云端全量重拉
              </button>
              <button
                ref={backButtonRef}
                type="button"
                onClick={() => setView('resync-choice')}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                返回
              </button>
            </div>
          </div>
        ) : view === 'resync-push-confirm' ? (
          <div>
            <p style={BODY_STYLE}>
              云端数据会被清空，然后用本机数据重新上传。其他设备上的数据也会被替换。此操作无法撤销。
            </p>
            <p style={serverOnlyCount > 0 ? CONSEQUENCE_STYLE : HELPER_STYLE}>
              {serverOnlyCount > 0
                ? `云端独有的 ${serverOnlyCount} 条数据将被永久删除。`
                : '云端没有本机缺少的数据。'}
            </p>
            <p style={HELPER_STYLE}>建议先导出云端备份。</p>
            <p style={HELPER_STYLE}>本机备份不包含云端独有的数据。</p>
            <button
              type="button"
              role="checkbox"
              aria-checked={pushAcknowledged}
              onClick={() => setPushAcknowledged((checked) => !checked)}
              className={FOCUS_RING}
              style={{
                width: '100%',
                minHeight: '44px',
                padding: 0,
                background: 'none',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                textAlign: 'left',
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true" style={checkboxStyle(pushAcknowledged)}>
                {pushAcknowledged ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 6.5 4.5 9 10 3"
                      stroke="#ffffff"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span
                style={{
                  fontSize: '17px',
                  fontWeight: 400,
                  lineHeight: 1.47,
                  color: 'var(--foreground)',
                }}
              >
                我明白要用本机数据覆盖云端
              </span>
            </button>
            <button
              type="button"
              onClick={() => void handleExportCloud()}
              className={FOCUS_RING}
              style={ACCENT_TEXT_STYLE}
            >
              导出云端备份
            </button>
            {exportError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {exportError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => handleConfirmResync('push')}
                disabled={!pushAcknowledged}
                className={FOCUS_RING}
                style={{
                  ...DESTRUCTIVE_CONFIRM_STYLE,
                  opacity: pushAcknowledged ? 1 : 0.4,
                  cursor: pushAcknowledged ? 'pointer' : 'default',
                }}
              >
                从本机全量重推
              </button>
              <button
                ref={backButtonRef}
                type="button"
                onClick={() => setView('resync-choice')}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                返回
              </button>
            </div>
          </div>
        ) : view === 'resync-executing' ? (
          <div role="status" aria-live="polite">
            <p style={BODY_STYLE}>
              {resyncBusyDirection === 'pull'
                ? '正在从云端重新下载本机数据。请保持网络连接。'
                : '正在用本机数据覆盖云端。请保持网络连接。'}
            </p>
          </div>
        ) : view === 'resync-error' ? (
          <div>
            <p style={BODY_STYLE}>{resyncErrorBody}</p>
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => {
                  if (executionFailed) {
                    void runResync(resyncErrorDirection)
                  } else {
                    void startResyncLoad()
                  }
                }}
                className={FOCUS_RING}
                style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                重试
              </button>
              <button
                ref={backButtonRef}
                type="button"
                onClick={backToOverview}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                {executionFailed ? '返回' : '取消'}
              </button>
            </div>
          </div>
        ) : view === 'snapshots' ? (
          <div>
            {snapshotsError ? null : (
              <p style={HELPER_STYLE}>每天自动保存一份快照，保留最近 30 天。</p>
            )}
            {snapshotsLoading ? (
              <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                正在读取快照…
              </p>
            ) : snapshotsError ? (
              <div>
                <p style={BODY_STYLE}>{SERVER_ERROR_COPY[snapshotsError]}</p>
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={() => void loadSnapshots()}
                    className={FOCUS_RING}
                    style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : snapshots && snapshots.length === 0 ? (
              <div>
                <p style={BODY_STYLE}>还没有快照。</p>
                <p style={HELPER_STYLE}>每天自动保存一份快照。</p>
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : snapshots ? (
              <div>
                <div style={{ marginTop: '16px' }}>
                  {snapshots.map((item) => (
                    <div key={item.date} style={LIST_ROW_STYLE}>
                      <div
                        style={{
                          flex: '1 1 auto',
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <span style={LIST_TITLE_STYLE}>
                          {formatSnapshotDate(item.date, new Date())}
                        </span>
                        <span style={LIST_META_STYLE}>{`共 ${item.total} 条`}</span>
                      </div>
                      <div style={{ flex: '0 0 auto', alignSelf: 'center' }}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSnapshot(item)
                            setSnapshotActionError(null)
                            setView('snapshot-confirm')
                          }}
                          aria-label={`恢复到 ${item.date} 的快照`}
                          className={FOCUS_RING}
                          style={DESTRUCTIVE_TEXT_STYLE}
                        >
                          恢复
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : view === 'snapshot-confirm' && selectedSnapshot ? (
          <div>
            <p style={BODY_STYLE}>
              云端数据会回退到该快照，其他设备上的数据也会随之改变。本机将重新下载云端数据。此操作无法撤销。
            </p>
            <p style={selectedSnapshot.total > 0 ? HELPER_STYLE : CONSEQUENCE_STYLE}>
              {selectedSnapshot.total > 0
                ? `该快照共 ${selectedSnapshot.total} 条数据。`
                : '该快照没有任何数据，恢复后云端会被清空。'}
            </p>
            <p style={HELPER_STYLE}>建议先导出云端备份。</p>
            <button
              type="button"
              onClick={() => void handleExportCloud()}
              className={FOCUS_RING}
              style={ACCENT_TEXT_STYLE}
            >
              导出云端备份
            </button>
            {exportError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {exportError}
              </p>
            ) : null}
            {snapshotActionError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {snapshotActionError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void handleConfirmSnapshotRestore()}
                disabled={snapshotBusy}
                aria-busy={snapshotBusy}
                className={FOCUS_RING}
                style={{
                  ...DESTRUCTIVE_CONFIRM_STYLE,
                  opacity: snapshotBusy ? 0.4 : 1,
                  cursor: snapshotBusy ? 'default' : 'pointer',
                }}
              >
                {snapshotBusy ? '正在恢复…' : '恢复到此快照'}
              </button>
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setView('snapshots')}
                disabled={snapshotBusy}
                className={FOCUS_RING}
                style={{
                  ...SECONDARY_BUTTON_STYLE,
                  opacity: snapshotBusy ? 0.4 : 1,
                  cursor: snapshotBusy ? 'default' : 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : view === 'devices' ? (
          <div>
            {devices && !devicesError ? (
              <p style={HELPER_STYLE}>
                {`共 ${devices.length} 台设备。撤销后，那台设备需要重新登录才能继续同步。`}
              </p>
            ) : null}
            {devicesLoading ? (
              <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                正在读取设备…
              </p>
            ) : devicesError ? (
              <div>
                <p style={BODY_STYLE}>{SERVER_ERROR_COPY[devicesError]}</p>
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={() => void loadDevices()}
                    className={FOCUS_RING}
                    style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : devices && devices.length === 0 ? (
              <div>
                <p style={BODY_STYLE}>没有设备记录。</p>
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : devices ? (
              <div>
                <div style={{ marginTop: '16px' }}>
                  {sortDevices(devices, currentDeviceId).map((device) => {
                    const isCurrent = device.id === currentDeviceId
                    return (
                      <div key={device.id} style={LIST_ROW_STYLE}>
                        <div
                          style={{
                            flex: '1 1 auto',
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              flexWrap: 'wrap',
                            }}
                          >
                            <span style={LIST_TITLE_STYLE}>
                              {device.name ?? '未命名设备'}
                            </span>
                            {isCurrent ? (
                              <span style={CURRENT_DEVICE_CHIP_STYLE}>当前设备</span>
                            ) : null}
                          </div>
                          <span style={LIST_META_STYLE}>
                            {formatDeviceLastSeen(device.last_seen_at, Date.now())}
                          </span>
                        </div>
                        <div style={{ flex: '0 0 auto', alignSelf: 'center' }}>
                          {isCurrent ? (
                            <span style={LIST_META_STYLE}>当前设备不可撤销。</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedDevice(device)
                                setDeviceActionError(null)
                                setView('device-confirm')
                              }}
                              aria-label={`撤销 ${device.name ?? '未命名设备'} 的会话`}
                              className={FOCUS_RING}
                              style={DESTRUCTIVE_TEXT_STYLE}
                            >
                              撤销
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {statusLine ? (
                  <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                    {statusLine}
                  </p>
                ) : null}
                <div style={BUTTON_GROUP_STYLE}>
                  <button
                    type="button"
                    onClick={backToOverview}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    返回
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : view === 'device-confirm' && selectedDevice ? (
          <div>
            <p style={BODY_STYLE}>
              {`${selectedDevice.name ?? '未命名设备'} 会立即退出登录，需要重新登录才能继续同步。数据不会被删除。`}
            </p>
            {selectedDevice.last_seen_at !== null ? (
              <p style={HELPER_STYLE}>
                {`${formatDeviceLastSeen(selectedDevice.last_seen_at, Date.now())}。`}
              </p>
            ) : null}
            {deviceActionError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {deviceActionError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void handleConfirmDeviceRevoke()}
                disabled={deviceBusy}
                aria-busy={deviceBusy}
                className={FOCUS_RING}
                style={{
                  ...DESTRUCTIVE_CONFIRM_STYLE,
                  opacity: deviceBusy ? 0.4 : 1,
                  cursor: deviceBusy ? 'default' : 'pointer',
                }}
              >
                {deviceBusy ? '正在撤销…' : '撤销会话'}
              </button>
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setView('devices')}
                disabled={deviceBusy}
                className={FOCUS_RING}
                style={{
                  ...SECONDARY_BUTTON_STYLE,
                  opacity: deviceBusy ? 0.4 : 1,
                  cursor: deviceBusy ? 'default' : 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : loading ? (
          <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
            正在读取同步状态…
          </p>
        ) : localError ? (
          <div>
            <p style={BODY_STYLE}>读取本机数据失败，请刷新页面后重试。</p>
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void loadDiagnostics(true)}
                className={FOCUS_RING}
                style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                重试
              </button>
              <button
                type="button"
                onClick={onClose}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                关闭
              </button>
            </div>
          </div>
        ) : snapshot ? (
          <div>
            <p style={HELPER_STYLE}>只显示计数与错误码，不显示数据内容。</p>

            <dl style={{ margin: '16px 0 0', padding: 0 }}>
              <DiagnosticRow label="游标">{snapshot.cursor}</DiagnosticRow>
              <DiagnosticRow label="待同步">{`${snapshot.outboxCount} 项`}</DiagnosticRow>
              <DiagnosticRow label="隔离项">
                <span>{`${quarantineCount} 项`}</span>
                {quarantineCount > 0 ? (
                  <button
                    type="button"
                    aria-expanded={quarantineOpen}
                    aria-controls={QUARANTINE_ID}
                    onClick={() => setQuarantineOpen((open) => !open)}
                    className={FOCUS_RING}
                    style={INLINE_ACCENT_STYLE}
                  >
                    {quarantineOpen ? '收起' : '查看'}
                  </button>
                ) : null}
              </DiagnosticRow>
              <DiagnosticRow label="上次错误">{snapshot.lastError ?? '无'}</DiagnosticRow>
              <DiagnosticRow label="客户端版本">{BUILD_VERSION}</DiagnosticRow>
              <DiagnosticRow label="服务端版本" last>
                <span
                  style={
                    serverVersionKnown ? undefined : { color: 'var(--muted)' }
                  }
                >
                  {serverVersionKnown ? String(serverVersion) : '无法读取'}
                </span>
              </DiagnosticRow>
            </dl>

            {quarantineOpen && quarantineCount > 0 ? (
              <div id={QUARANTINE_ID} style={{ padding: '0 0 8px' }}>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {quarantine.map((entry, index) => (
                    <li
                      key={index}
                      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}
                    >
                      <div
                        style={{
                          fontSize: '17px',
                          fontWeight: 400,
                          lineHeight: 1.47,
                          color: 'var(--foreground)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {ENTITY_LABELS[entry.entity]}
                      </div>
                      <div
                        style={{
                          marginTop: '4px',
                          fontSize: '13px',
                          fontWeight: 400,
                          lineHeight: 1.4,
                          color: 'var(--muted)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {`${formatDiagnosticTime(entry.at)} · ${sanitizeQuarantineReason(
                          entry.kind,
                          entry.reason,
                        )}`}
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setView('quarantine-clear')}
                  className={FOCUS_RING}
                  style={ACCENT_TEXT_STYLE}
                >
                  清除全部隔离项
                </button>
              </div>
            ) : null}

            {versionMismatch ? (
              <p style={STATUS_LINE_STYLE}>服务端版本与客户端不一致，请更新应用。</p>
            ) : null}
            {serverVersionReason === 'auth' ? (
              <p style={STATUS_LINE_STYLE}>登录已过期，请重新登录。</p>
            ) : null}

            {statusLine ? (
              <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                {statusLine}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {actionError}
              </p>
            ) : null}

            <div
              style={{
                marginTop: '24px',
                paddingTop: '8px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <button
                type="button"
                onClick={() => void startResyncLoad()}
                className={FOCUS_RING}
                style={ACCENT_TEXT_STYLE}
              >
                全量重同步
              </button>
              <button
                type="button"
                onClick={openSnapshots}
                className={FOCUS_RING}
                style={ACCENT_TEXT_STYLE}
              >
                快照恢复
              </button>
              <button
                type="button"
                onClick={openDevices}
                className={FOCUS_RING}
                style={ACCENT_TEXT_STYLE}
              >
                设备会话
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className={FOCUS_RING}
              style={{ ...SECONDARY_BUTTON_STYLE, marginTop: '24px', cursor: 'pointer' }}
            >
              关闭
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
