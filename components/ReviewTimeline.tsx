'use client'

import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatReviewTimestamp } from '@/lib/review-time'
import type { Review } from '@/lib/types'

interface ReviewTimelineProps {
  /** Already sorted newest-first by the caller (sortReviewsNewestFirst). */
  reviews: Review[]
  /** REJECTS on failure so this component preserves the composer draft. */
  onCreate: (content: string) => Promise<void>
  onOpenEdit: (review: Review) => void
}

const LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const CARD_STYLE: CSSProperties = {
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
  padding: '16px',
  minWidth: 0,
}

const MUTED_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--muted)',
}

const TIMESTAMP_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  flex: '1 1 auto',
}

const ENTRY_BODY_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const COMPOSER_TEXTAREA_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  padding: '10px 12px',
  minHeight: '96px',
  resize: 'none',
}

const SAVE_BUTTON_STYLE: CSSProperties = {
  alignSelf: 'flex-end',
  minWidth: '44px',
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

const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

const MORE_BUTTON_STYLE: CSSProperties = {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
}

/**
 * The third detail section「复盘」(D-02 / D-04, REV-01 / REV-02).
 *
 * Presentational only: the caller supplies `reviews` already sorted newest-first
 * (D-01) and owns persistence through `onCreate` / `onOpenEdit`. This component
 * owns just the composer draft + save error. Note content renders exclusively as
 * a JSX text node — React escaping, no raw HTML injection (T-05-XSS).
 *
 * Saving is the explicit 保存复盘 button only — Enter stays native and inserts a
 * newline in the multi-line textarea (D-05). On success the draft clears and the
 * textarea keeps focus; on rejection the draft is preserved with inline copy.
 */
export default function ReviewTimeline({
  reviews,
  onCreate,
  onOpenEdit,
}: ReviewTimelineProps) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const hasEntries = reviews.length > 0

  async function handleSave() {
    const trimmed = draft.trim()
    if (!trimmed || saving) return

    setSaving(true)
    setSaveError(null)
    try {
      await onCreate(trimmed)
      setDraft('')
      // Keep focus so rapid follow-up capture never needs a re-tap.
      textareaRef.current?.focus()
    } catch {
      // Preserve the typed text on failure; the textarea keeps focus.
      setSaveError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="goal-reviews-heading"
      className="flex flex-col"
      style={{ gap: '8px' }}
    >
      <h2 id="goal-reviews-heading" style={LABEL_STYLE}>
        复盘
      </h2>

      <div className="flex flex-col" style={{ ...CARD_STYLE, gap: '8px' }}>
        {reviews.length === 0 ? (
          <p style={MUTED_BODY_STYLE}>
            还没有复盘。在下方写下这个目标最近的进展和想法。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {reviews.map((review, index) => (
              <li
                key={review.id}
                data-review-entry
                data-review-id={review.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '8px 0',
                  minWidth: 0,
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: '44px',
                  }}
                >
                  <time dateTime={review.created_at} style={TIMESTAMP_STYLE}>
                    {formatReviewTimestamp(review.created_at)}
                  </time>
                  <button
                    type="button"
                    data-review-more
                    aria-label="复盘操作"
                    onClick={() => onOpenEdit(review)}
                    className={FOCUS_RING_INSET}
                    style={MORE_BUTTON_STYLE}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 18 18"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <circle cx="9" cy="4" r="1.5" fill="currentColor" />
                      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                      <circle cx="9" cy="14" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                </div>

                <p style={ENTRY_BODY_STYLE}>{review.content}</p>
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            marginTop: '8px',
            paddingTop: hasEntries ? '16px' : 0,
            borderTop: hasEntries ? '1px solid var(--border)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            alignItems: 'stretch',
          }}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaveError(null)
            }}
            rows={3}
            maxLength={2000}
            aria-label="复盘内容"
            placeholder="写下这个目标最近的进展…"
            data-review-composer
            disabled={saving}
            className={FOCUS_RING}
            style={COMPOSER_TEXTAREA_STYLE}
          />

          {saveError ? (
            <p style={INLINE_ERROR_STYLE}>保存失败，请重试。</p>
          ) : null}

          <button
            type="button"
            onClick={handleSave}
            disabled={!draft.trim() || saving}
            aria-busy={saving}
            className={FOCUS_RING}
            style={{
              ...SAVE_BUTTON_STYLE,
              cursor: !draft.trim() || saving ? 'default' : 'pointer',
              opacity: !draft.trim() || saving ? 0.4 : 1,
            }}
          >
            保存复盘
          </button>
        </div>
      </div>
    </section>
  )
}
