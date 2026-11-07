'use client'

import { useRef } from 'react'

/** One option in a segmented control. `tabId`/`panelId` are optional so the
 *  control can drive either standalone state (番茄 / 圣女果) or an ARIA
 *  tablist ↔ tabpanel pair (the original 活跃 / 已归档 use). */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  tabId?: string
  panelId?: string
}

interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel: string
}

/**
 * Generic two-or-more option segmented control (02-UI-SPEC §2 visual contract).
 *
 * Selection is expressed with surface contrast + weight only — never an accent
 * fill. Uses the ARIA tabs pattern with a roving tabIndex: ArrowLeft/ArrowRight
 * move selection, Enter/Space activate via the native button click. `id` and
 * `aria-controls` are emitted only when an option supplies them, so callers that
 * are not wiring a tabpanel do not create dangling ARIA references.
 */
export default function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function selectAndFocus(next: T) {
    onChange(next)
    const index = options.findIndex((option) => option.value === next)
    refs.current[index]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        minHeight: '44px',
        padding: '4px',
        background: 'var(--background)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
      }}
    >
      {options.map((option, index) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="tab"
            id={option.tabId}
            aria-controls={option.panelId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              event.preventDefault()
              const direction = event.key === 'ArrowRight' ? 1 : -1
              const nextIndex = (index + direction + options.length) % options.length
              selectAndFocus(options[nextIndex].value)
            }}
            className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
            style={{
              flex: '1 1 0',
              minWidth: '120px',
              height: '36px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 12px',
              borderRadius: '8px',
              border: selected ? '1px solid var(--border)' : '1px solid transparent',
              background: selected ? 'var(--card)' : 'transparent',
              color: selected ? 'var(--foreground)' : 'var(--muted)',
              fontSize: '17px',
              fontWeight: selected ? 600 : 400,
              lineHeight: 1.2,
              fontFamily: 'inherit',
              cursor: 'pointer',
              transition: 'background 120ms ease-out, color 120ms ease-out',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
