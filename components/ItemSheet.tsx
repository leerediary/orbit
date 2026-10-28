'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'

interface BaseSheetProps {
  /** Edit-state sheet title. Defaults to 编辑里程碑 / 编辑任务 by mode. */
  title?: string
  initialName: string
  onDelete: () => void
  onCancel: () => void
  saving?: boolean
  saveError?: string | null
  deleteError?: string | null
  confirmState: boolean
  onRequestDelete: () => void
  onCancelDelete: () => void
}

interface MilestoneSheetProps extends BaseSheetProps {
  mode: 'milestone'
  /** Live tasks that will move to 直接任务 on delete. */
  liveTaskCount?: number
  onSave: (name: string) => void
}

interface TaskSheetProps extends BaseSheetProps {
  mode: 'task'
  /** Effective current parent (dangling ids already resolved to null). */
  initialParentId: string | null
  /** 直接任务 first, then this goal's live milestones in current order. */
  parentOptions: ReadonlyArray<{ id: string | null; label: string }>
  onSave: (payload: { name: string; milestone_id: string | null }) => void
}

type ItemSheetProps = MilestoneSheetProps | TaskSheetProps

const TITLE_ID = 'item-sheet-title'
const NAME_ID = 'item-sheet-name'
const PARENT_ID = 'item-sheet-parent'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

const LABEL_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
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

/**
 * Shared milestone/task editor sheet — 03-UI-SPEC §9/§10. Reuses the GoalSheet
 * chrome with unique animation class names. Presentational: GoalDetail owns
 * persistence, sort_order, and the tombstone. This component is purely
 * presentational; delete only calls `onDelete()`.
 */
export default function ItemSheet(props: ItemSheetProps) {
  const { initialName, onCancel, confirmState, onRequestDelete, onCancelDelete } = props
  const saving = props.saving ?? false
  const saveError = props.saveError ?? null
  const deleteError = props.deleteError ?? null
  const isTask = props.mode === 'task'

  const [name, setName] = useState(initialName)
  const [nameError, setNameError] = useState<string | null>(null)
  const [parentValue, setParentValue] = useState<string>(
    props.mode === 'task' ? (props.initialParentId ?? '') : '',
  )

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  // Edit state starts on 名称; the confirm state starts on the safe 取消 button.
  useEffect(() => {
    if (confirmState) {
      cancelButtonRef.current?.focus()
    } else {
      nameInputRef.current?.focus()
    }
  }, [confirmState])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!saving) onCancel()
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

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('名称不能为空')
      nameInputRef.current?.focus()
      return
    }
    setNameError(null)
    if (props.mode === 'task') {
      props.onSave({
        name: trimmed,
        milestone_id: parentValue === '' ? null : parentValue,
      })
    } else {
      props.onSave(trimmed)
    }
  }

  const count = props.mode === 'milestone' ? (props.liveTaskCount ?? 0) : 0
  const confirmBody =
    count > 0
      ? `「${initialName}」将被删除，其下的 ${count} 个任务会移到「直接任务」，且本阶段无法从界面恢复。`
      : `「${initialName}」将被删除，且本阶段无法从界面恢复。`

  const resolvedTitle =
    props.title ?? (isTask ? '编辑任务' : '编辑里程碑')
  const saveLabel = isTask ? '保存任务' : '保存里程碑'
  const deleteLabel = isTask ? '删除任务' : '删除里程碑'
  const confirmTitle = isTask ? '删除任务？' : '删除里程碑？'
  // The direct option is a contract of task mode: guarantee it even if a caller
  // omits it, so the select always has a matching option for milestone_id null.
  const parentOptions: ReadonlyArray<{ id: string | null; label: string }> =
    props.mode === 'task'
      ? props.parentOptions.some((option) => option.id === null)
        ? props.parentOptions
        : [{ id: null, label: '直接任务' }, ...props.parentOptions]
      : []

  return (
    <>
      <style>{`
        @keyframes orbit-item-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-item-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-item-scrim { animation: orbit-item-scrim-in 150ms ease-out both; }
        .orbit-item-sheet { animation: orbit-item-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-item-scrim, .orbit-item-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-item-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog" aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-item-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '24px',
            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          }}
        >
          <h2
            id={TITLE_ID}
            style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: 600,
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            {confirmState ? confirmTitle : resolvedTitle}
          </h2>

          {confirmState ? (
            <div>
              <p
                style={{
                  margin: '16px 0 0',
                  fontSize: '17px',
                  fontWeight: 400,
                  lineHeight: 1.47,
                  color: 'var(--foreground)',
                  overflowWrap: 'anywhere',
                }}
              >
                {confirmBody}
              </p>

              {deleteError ? (
                <p style={{ ...INLINE_ERROR_STYLE, marginTop: '16px' }}>{deleteError}</p>
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
                  onClick={props.onDelete}
                  disabled={saving}
                  aria-busy={saving}
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
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.4 : 1,
                  }}
                >
                  确认删除
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={onCancelDelete}
                  className={FOCUS_RING}
                  style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} noValidate>
                <div
                  style={{
                    marginTop: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label htmlFor={NAME_ID} style={LABEL_STYLE}>
                      名称
                    </label>
                    <input
                      id={NAME_ID}
                      ref={nameInputRef}
                      type="text"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                        if (nameError) setNameError(null)
                      }}
                      maxLength={100}
                      required
                      aria-required="true"
                      aria-invalid={nameError !== null}
                      className={FOCUS_RING}
                      style={{
                        minHeight: '44px',
                        padding: '10px 12px',
                        fontSize: '17px',
                        fontWeight: 400,
                        lineHeight: 1.47,
                        fontFamily: 'inherit',
                        color: 'var(--foreground)',
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                      }}
                    />
                    {nameError ? <p style={INLINE_ERROR_STYLE}>{nameError}</p> : null}
                  </div>

                  {props.mode === 'task' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label htmlFor={PARENT_ID} style={LABEL_STYLE}>
                        所属里程碑
                      </label>
                      <div style={{ position: 'relative' }}>
                        <select
                          id={PARENT_ID}
                          value={parentValue}
                          onChange={(event) => setParentValue(event.target.value)}
                          className={FOCUS_RING}
                          style={{
                            appearance: 'none',
                            WebkitAppearance: 'none',
                            width: '100%',
                            minHeight: '44px',
                            padding: '10px 36px 10px 12px',
                            fontSize: '17px',
                            fontWeight: 400,
                            lineHeight: 1.47,
                            fontFamily: 'inherit',
                            color: 'var(--foreground)',
                            background: 'var(--card)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                          }}
                        >
                          {parentOptions.map((option) => (
                            <option key={option.id ?? '__direct'} value={option.id ?? ''}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 18 18"
                          aria-hidden="true"
                          focusable="false"
                          style={{
                            position: 'absolute',
                            right: '12px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            color: 'var(--muted)',
                            pointerEvents: 'none',
                          }}
                        >
                          <polyline
                            points="5 7 9 11 13 7"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    </div>
                  ) : null}
                </div>

                {saveError ? (
                  <p style={{ ...INLINE_ERROR_STYLE, marginTop: '24px' }}>{saveError}</p>
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
                    type="submit"
                    disabled={saving}
                    aria-busy={saving}
                    style={{
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
                      cursor: saving ? 'default' : 'pointer',
                      opacity: saving ? 0.4 : 1,
                    }}
                  >
                    {saveLabel}
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    取消编辑
                  </button>
                </div>
              </form>

              <div
                style={{
                  marginTop: '24px',
                  paddingTop: '24px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  onClick={onRequestDelete}
                  disabled={saving}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: saving ? 'default' : 'pointer',
                  }}
                >
                  {deleteLabel}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
