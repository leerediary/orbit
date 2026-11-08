'use client'

import type { CSSProperties } from 'react'

interface TodayRemoveButtonProps {
  /** Item name, carried by the icon-only control's aria-label. */
  name: string
  /** Linked entry → 移出今天 (reversible unmark); standalone → 删除待办. */
  action: 'unmark' | 'delete'
  onRemove: () => void
}

const BUTTON_STYLE: CSSProperties = {
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
 * Shared 44×44 icon-only remove control for 今日 rows (09-UI-SPEC §4, §Copywriting
 * → Destructive). Immediate, no confirmation: linked removal is a reversible
 * unmark and standalone removal is a lightweight soft-delete. The muted 18×18
 * minus-circle carries no accent (accent budget) and the aria-label names the
 * item so the icon-only control stays unambiguous.
 */
export default function TodayRemoveButton({
  name,
  action,
  onRemove,
}: TodayRemoveButtonProps) {
  const ariaLabel = action === 'unmark' ? `移出今天：${name}` : `删除待办：${name}`

  return (
    <button
      type="button"
      data-remove-today
      aria-label={ariaLabel}
      onClick={onRemove}
      className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]"
      style={BUTTON_STYLE}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line
          x1="5"
          y1="9"
          x2="13"
          y2="9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
