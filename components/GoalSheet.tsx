'use client'

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Goal } from '@/lib/types'

interface GoalSheetProps {
  mode: 'create' | 'edit'
  initialGoal?: Goal
  onSave: (payload: { name: string; description: string }) => void
  onArchive?: () => void
  onCancel: () => void
  saving?: boolean
  saveError?: string | null
  archiveError?: string | null
}

const TITLE_ID = 'goal-sheet-title'
const NAME_ID = 'goal-sheet-name'
const DESCRIPTION_ID = 'goal-sheet-description'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

/**
 * Shared create/edit bottom sheet (mobile) / centered dialog (desktop)
 * — 02-UI-SPEC §5.
 *
 * Hand-rolled focus trap, no close "X" (the text dismiss button is the only
 * close affordance), backdrop click intentionally does nothing so a stray tap
 * can never destroy typed text. The page owns persistence and passes the
 * in-flight/error state down.
 */
export default function GoalSheet({
  mode,
  initialGoal,
  onSave,
  onArchive,
  onCancel,
  saving = false,
  saveError = null,
  archiveError = null,
}: GoalSheetProps) {
  const [name, setName] = useState(initialGoal?.name ?? '')
  const [description, setDescription] = useState(initialGoal?.description ?? '')
  const [nameError, setNameError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Initial focus: the 名称 input (02-UI-SPEC Accessibility Contract).
  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

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
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()

    if (!trimmedName) {
      setNameError('请填写目标名称')
      nameInputRef.current?.focus()
      return
    }

    setNameError(null)
    onSave({ name: trimmedName, description: trimmedDescription })
  }

  return (
    <>
      <style>{`
        @keyframes orbit-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-scrim { animation: orbit-scrim-in 150ms ease-out both; }
        .orbit-sheet { animation: orbit-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-scrim, .orbit-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
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
            {mode === 'create' ? '新建目标' : '编辑目标'}
          </h2>

          <form onSubmit={handleSubmit} noValidate>
            <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label
                  htmlFor={NAME_ID}
                  style={{
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                  }}
                >
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
                  placeholder="例如：完成 Orbit M1"
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
                {nameError ? (
                  <p
                    style={{
                      margin: 0,
                      fontSize: '13px',
                      fontWeight: 400,
                      lineHeight: 1.4,
                      color: 'var(--foreground)',
                    }}
                  >
                    {nameError}
                  </p>
                ) : null}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label
                  htmlFor={DESCRIPTION_ID}
                  style={{
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                  }}
                >
                  描述（可选）
                </label>
                <textarea
                  id={DESCRIPTION_ID}
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={2000}
                  placeholder="这个目标想达成什么？"
                  className={FOCUS_RING}
                  style={{
                    padding: '10px 12px',
                    fontSize: '17px',
                    fontWeight: 400,
                    lineHeight: 1.47,
                    fontFamily: 'inherit',
                    color: 'var(--foreground)',
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    resize: 'none',
                  }}
                />
              </div>
            </div>

            {saveError ? (
              <p
                style={{
                  margin: '24px 0 0',
                  fontSize: '13px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--foreground)',
                }}
              >
                {saveError}
              </p>
            ) : null}
            {archiveError ? (
              <p
                style={{
                  margin: '24px 0 0',
                  fontSize: '13px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--foreground)',
                }}
              >
                {archiveError}
              </p>
            ) : null}

            <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                保存目标
              </button>
              <button
                type="button"
                onClick={onCancel}
                className={FOCUS_RING}
                style={{
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
                  cursor: 'pointer',
                }}
              >
                {mode === 'create' ? '取消新建' : '取消编辑'}
              </button>
            </div>
          </form>

          {mode === 'edit' && onArchive ? (
            <div
              style={{
                marginTop: '24px',
                paddingTop: '24px',
                borderTop: '1px solid var(--border)',
              }}
            >
              <button
                type="button"
                onClick={onArchive}
                disabled={saving}
                className={FOCUS_RING}
                style={{
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
                  cursor: saving ? 'default' : 'pointer',
                }}
              >
                归档目标
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
