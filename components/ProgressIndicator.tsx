'use client'

import type { CSSProperties } from 'react'
import { formatProgressCount } from '@/lib/format'

interface ProgressIndicatorProps {
  completed: number
  total: number
  label: '分类进度' | '目标进度' | '里程碑进度'
  /** 'count' → "2/5"; 'percent' → "40%". */
  format?: 'count' | 'percent'
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  width: '100%',
  minWidth: 0,
  alignItems: 'center',
  gap: '8px',
}

const TRACK_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  height: '4px',
  background: 'var(--border)',
  borderRadius: '2px',
  overflow: 'hidden',
}

const COUNT_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

/**
 * Shared derived-progress display (04-UI-SPEC §1, D-01/D-02/D-05).
 *
 * Read-only: a 4px bar plus a `completed/total` count. Renders nothing when the
 * caller has no tasks (D-02). The count is the source of truth; the bar is the
 * at-a-glance signal. Fills with the accent only when every task is complete.
 */
export default function ProgressIndicator({
  completed,
  total,
  label,
  format = 'count',
}: ProgressIndicatorProps) {
  if (total === 0) return null

  // Float-safe (D-03): `completed` is a fractional leaf sum, so equality is too
  // brittle; the bar also clamps in case a caller ever over-reports.
  const isComplete = completed >= total
  const ratio = Math.min(completed / total, 1)
  const countText =
    format === 'percent'
      ? `${Math.round(ratio * 100)}%`
      : `${formatProgressCount(completed)}/${total}`

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.round(completed * 100) / 100}
      aria-valuetext={countText}
      aria-label={label}
      style={ROW_STYLE}
    >
      <div style={TRACK_STYLE}>
        <div
          aria-hidden="true"
          className="motion-reduce:transition-none"
          style={{
            height: '100%',
            width: `${ratio * 100}%`,
            borderRadius: '2px',
            background: isComplete ? 'var(--accent)' : 'var(--muted)',
            transition: 'width 120ms ease-out, background-color 120ms ease-out',
          }}
        />
      </div>
      <span aria-hidden="true" style={COUNT_STYLE}>
        {countText}
      </span>
    </div>
  )
}
