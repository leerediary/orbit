'use client'

export type Section = 'goals' | 'today' | 'pomodoro' | 'checkin'

const TABS: Array<{ id: Section; label: string }> = [
  { id: 'goals', label: '长期计划' },
  { id: 'today', label: '今日待办' },
  { id: 'pomodoro', label: '番茄钟' },
  { id: 'checkin', label: '习惯打卡' },
]

/**
 * Top-level section navigation, modeled on Apple's global nav: small (12px),
 * near-black (--foreground, not pure black), decorative, NO visual selected
 * state. Each item sizes to its label and the tabs are separated by a fixed 3em
 * gap, so the labels sit 3 character-widths apart (tighter than the old fixed
 * 7em module). `gap: 3em` keeps them evenly spaced on every viewport; labels
 * never wrap (nowrap). The page hero title carries the "you are here";
 * aria-current is kept for screen readers.
 *
 * An optional `onSettings` renders a 44x44 muted gear icon as the last item of
 * the row — a peer of the text tabs with the same `3em` gap — so the global
 * settings entry is reachable from every section.
 */
export default function TopNav({
  value,
  onChange,
  onSettings,
}: {
  value: Section
  onChange: (section: Section) => void
  onSettings?: () => void
}) {
  return (
    <nav
      aria-label="主导航"
      className="flex items-center justify-center"
      style={{ width: '100%' }}
    >
      <div className="flex items-center" style={{ gap: '3em' }}>
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
                flex: '0 0 auto',
                whiteSpace: 'nowrap',
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
        {onSettings ? (
          <button
            type="button"
            aria-label="设置"
            data-settings-button
            onClick={onSettings}
            className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
            style={{
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
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        ) : null}
      </div>
    </nav>
  )
}
