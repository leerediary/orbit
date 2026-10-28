'use client'

import { useRef } from 'react'

export type GoalsTab = 'active' | 'archived'

interface SegmentedControlProps {
  value: GoalsTab
  onChange: (value: GoalsTab) => void
}

// Tab metadata owns the ARIA tab id ↔ panel id pairing consumed by app/page.tsx.
// Keeping it here means the ids can never drift between the tablist and panels.
const TABS = [
  { value: 'active', label: '活跃', tabId: 'goals-tab-active', panelId: 'goals-panel-active' },
  { value: 'archived', label: '已归档', tabId: 'goals-tab-archived', panelId: 'goals-panel-archived' },
] as const

/**
 * 活跃 / 已归档 segmented control (02-UI-SPEC §2).
 *
 * Selection is expressed with surface contrast + weight only — never an accent
 * fill. Uses the ARIA tabs pattern with a roving tabIndex: ArrowLeft/ArrowRight
 * move selection, Enter/Space activate via the native button click, and the
 * panels in app/page.tsx carry the matching ids.
 */
export default function SegmentedControl({ value, onChange }: SegmentedControlProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function selectAndFocus(next: GoalsTab) {
    onChange(next)
    const index = TABS.findIndex((tab) => tab.value === next)
    refs.current[index]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="目标视图"
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
      {TABS.map((tab, index) => {
        const selected = value === tab.value
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="tab"
            id={tab.tabId}
            aria-controls={tab.panelId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              event.preventDefault()
              const direction = event.key === 'ArrowRight' ? 1 : -1
              const nextIndex = (index + direction + TABS.length) % TABS.length
              selectAndFocus(TABS[nextIndex].value)
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
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
