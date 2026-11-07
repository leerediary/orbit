'use client'

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Task } from '@/lib/types'
import { formatValue } from '@/lib/format'

interface ProgressSheetProps {
  task: Task
  onConfirm: (amount: number) => void
  onCancel: () => void
  /** Persistence-failure copy (kept so the typed amount survives a retry). */
  error?: string | null
}

const TITLE_ID = 'progress-sheet-title'
const AMOUNT_ID = 'progress-sheet-amount'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

/**
 * Quantity add-progress sheet (feedback 2026-11-01). Replaces the inline
 * row form: click a quantity task's name → this sheet → type 本次增加量 → 确认.
 * Backdrop click / Escape cancel (the typed amount is discarded, matching the
 * previous inline form). Amount + validation are local; persistence failures
 * come back via `error` and keep the sheet open.
 */
export default function ProgressSheet({
  task,
  onConfirm,
  onCancel,
  error = null,
}: ProgressSheetProps) {
  const [amount, setAmount] = useState('')
  const [amountError, setAmountError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const amountInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    amountInputRef.current?.focus()
  }, [])

  const current = task.current_value ?? 0
  const target = task.target_value ?? 0
  const unitText = (task.unit ?? '').trim()
  const ratio = target > 0 ? Math.min(current / target, 1) : 0

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return

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
    const currentEl = document.activeElement
    const inside = currentEl instanceof Node && root.contains(currentEl)

    if (event.shiftKey) {
      if (!inside || currentEl === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || currentEl === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleConfirm() {
    const parsed = Number(amount.trim())
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setAmountError('请输入大于 0 的数字。')
      amountInputRef.current?.focus()
      return
    }
    setAmountError(null)
    onConfirm(parsed)
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
        onClick={onCancel}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
          onClick={(event) => event.stopPropagation()}
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
            添加进度
          </h2>

          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--muted)',
                  overflowWrap: 'anywhere',
                }}
              >
                {task.name}
              </span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span
                  style={{
                    fontSize: '17px',
                    fontWeight: 400,
                    lineHeight: 1.47,
                    color: 'var(--foreground)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatValue(current)} / {formatValue(target)}
                  {unitText ? ` ${unitText}` : ''}
                </span>
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                  }}
                >
                  已完成
                </span>
              </div>
              <div
                style={{
                  height: '4px',
                  width: '100%',
                  background: 'var(--border)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  aria-hidden="true"
                  className="motion-reduce:transition-none"
                  style={{
                    height: '100%',
                    width: `${ratio * 100}%`,
                    borderRadius: '2px',
                    background: ratio >= 1 ? 'var(--accent)' : 'var(--muted)',
                    transition: 'width 120ms ease-out, background-color 120ms ease-out',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label
                htmlFor={AMOUNT_ID}
                style={{
                  fontSize: '13px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--muted)',
                }}
              >
                本次增加量
              </label>
              <input
                id={AMOUNT_ID}
                ref={amountInputRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value)
                  if (amountError) setAmountError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  if (event.nativeEvent.isComposing) return
                  event.preventDefault()
                  handleConfirm()
                }}
                placeholder="例如：5"
                aria-invalid={amountError !== null}
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
              {amountError ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--foreground)',
                  }}
                >
                  {amountError}
                </p>
              ) : null}
              {error ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--foreground)',
                  }}
                >
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button
              type="button"
              onClick={handleConfirm}
              className={FOCUS_RING}
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
                cursor: 'pointer',
              }}
            >
              确认
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
              取消
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
