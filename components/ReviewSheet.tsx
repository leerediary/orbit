'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Review } from '@/lib/types'

interface ReviewSheetProps {
  review: Review
  /** Called after local trim; GoalDetail owns the async upsert. */
  onSave: (content: string) => void
  /** Called immediately on 删除复盘 (no confirm). */
  onDelete: () => void
  onCancel: () => void
  saving?: boolean
  saveError?: string | null
  deleteError?: string | null
}

const TITLE_ID = 'review-sheet-title'
const CONTENT_ID = 'review-sheet-content'

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

/**
 * Review edit sheet — 05-UI-SPEC §"Component 4". Reuses the GoalSheet/ItemSheet
 * chrome with unique animation class names (D-07). Presentational: GoalDetail
 * owns persistence and passes saving/error state down. A note has exactly one
 * editable property: its content (created_at is never exposed).
 */
export default function ReviewSheet({
  review,
  onSave,
  onDelete,
  onCancel,
  saving = false,
  saveError = null,
  deleteError = null,
}: ReviewSheetProps) {
  const [content, setContent] = useState(review.content)
  const [contentError, setContentError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLTextAreaElement | null>(null)

  // Initial focus: the 内容 textarea, caret at the end of the prefilled content.
  // Mount-only — the sheet is remounted for each edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    contentRef.current?.focus()
    contentRef.current?.setSelectionRange(review.content.length, review.content.length)
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
    const trimmed = content.trim()
    if (!trimmed) {
      setContentError('复盘内容不能为空')
      contentRef.current?.focus()
      return
    }
    setContentError(null)
    onSave(trimmed)
  }

  return (
    <>
      <style>{`
        @keyframes orbit-review-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-review-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-review-scrim { animation: orbit-review-scrim-in 150ms ease-out both; }
        .orbit-review-sheet { animation: orbit-review-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-review-scrim, .orbit-review-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-review-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-review-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
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
            编辑复盘
          </h2>

          <form onSubmit={handleSubmit} noValidate>
            <div
              style={{
                marginTop: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <label htmlFor={CONTENT_ID} style={LABEL_STYLE}>
                内容
              </label>
              <textarea
                id={CONTENT_ID}
                ref={contentRef}
                rows={6}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value)
                  if (contentError) setContentError(null)
                }}
                maxLength={2000}
                aria-invalid={contentError !== null}
                className={FOCUS_RING}
                style={{
                  padding: '10px 12px',
                  minHeight: '160px',
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
              {contentError ? <p style={INLINE_ERROR_STYLE}>{contentError}</p> : null}
            </div>

            {saveError ? (
              <p style={{ ...INLINE_ERROR_STYLE, marginTop: '24px' }}>{saveError}</p>
            ) : null}
            {deleteError ? (
              <p style={{ ...INLINE_ERROR_STYLE, marginTop: '24px' }}>{deleteError}</p>
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
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.4 : 1,
                }}
              >
                保存复盘
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
              onClick={onDelete}
              disabled={saving}
              aria-busy={saving}
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
                opacity: saving ? 0.4 : 1,
              }}
            >
              删除复盘
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
