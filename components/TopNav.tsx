'use client'

export type Section = 'goals' | 'pomodoro' | 'checkin'

const TABS: Array<{ id: Section; label: string }> = [
  { id: 'goals', label: '长期计划' },
  { id: 'pomodoro', label: '番茄钟' },
  { id: 'checkin', label: '早起打卡' },
]

/**
 * Top-level section navigation, modeled on Apple's global nav: small (12px),
 * near-black (--foreground, not pure black), decorative, NO visual selected
 * state. Each item is a fixed 8em-wide module with its label centered, so the
 * labels are evenly spaced apart (like "--长期计划--"). The page hero title
 * carries the "you are here"; aria-current is kept for screen readers.
 */
export default function TopNav({
  value,
  onChange,
}: {
  value: Section
  onChange: (section: Section) => void
}) {
  return (
    <nav aria-label="主导航" className="flex items-center" style={{ gap: 0 }}>
      {TABS.map((tab) => {
        const current = value === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={current ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
            className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
            style={{
              padding: 0,
              width: '8em',
              textAlign: 'center',
              background: 'none',
              border: 'none',
              color: 'var(--foreground)',
              fontSize: '11px',
              fontWeight: 400,
              lineHeight: 1.47,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}
