'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { exportData } from '@/lib/data-export'
import { importData } from '@/lib/data-import'
import { shouldShowInstallGuide } from '@/lib/pwa-install'

interface SettingsSheetProps {
  onClose: () => void
  /** Page-owned refresh: re-reads goals, archived, and task progress after a replace. */
  onImported: () => Promise<void> | void
}

const TITLE_ID = 'settings-sheet-title'
const IMPORT_WARNING_ID = 'settings-sheet-import-warning'
const INSTALL_LABEL_ID = 'settings-sheet-install-label'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'
// Full-width rows span the sheet, so their ring sits inside the row.
const ROW_FOCUS_RING =
  'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:-2px]'
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

type View = 'actions' | 'confirm'
type Feedback =
  | { kind: 'success' }
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
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)
  const [showInstall, setShowInstall] = useState(false)

  const runningRef = useRef(false)
  // Which action row receives focus when the sheet returns to the action list.
  const returnFocusRef = useRef<'export' | 'import'>('export')

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const exportButtonRef = useRef<HTMLButtonElement | null>(null)
  const importButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

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

  // Focus follows the view: 导出备份 on open, 取消 in the confirm state, and the
  // row that started the action when returning to the list.
  useEffect(() => {
    if (view === 'confirm') {
      cancelButtonRef.current?.focus()
      return
    }
    if (returnFocusRef.current === 'import') {
      importButtonRef.current?.focus()
    } else {
      exportButtonRef.current?.focus()
    }
  }, [view])

  function backToActions(focusOn: 'export' | 'import') {
    returnFocusRef.current = focusOn
    setPendingJson(null)
    setView('actions')
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (busy) return
      if (view === 'confirm') {
        backToActions('import')
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
      // Do NOT parse or validate before the confirm step: every validation
      // message comes verbatim from importData().
      setPendingJson(json)
      setView('confirm')
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
            {view === 'confirm' ? '导入备份？' : '设置'}
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
    </>
  )
}
