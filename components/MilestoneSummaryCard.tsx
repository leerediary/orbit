'use client'

import type { Milestone } from '@/lib/types'

/**
 * A fixed-size milestone summary card for the flat goal list (06-redesign):
 * uniform width/height so every card in a horizontal row is the same size, and
 * it shows only a brief summary — name + derived task progress. Full task
 * management lives behind the goal drill-in, not here.
 */
export default function MilestoneSummaryCard({
  milestone,
  completed,
  total,
  onClick,
}: {
  milestone: Milestone
  completed: number
  total: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-milestone-summary
      data-milestone-id={milestone.id}
      onClick={onClick}
      className="milestone-summary-card focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px] active:opacity-60"
      style={{
        aspectRatio: '5 / 4',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '16px',
        background: 'var(--card)',
        borderRadius: '12px',
        boxShadow: 'var(--card-shadow)',
        textAlign: 'left',
        cursor: 'pointer',
        // Reset button defaults.
        border: 'none',
        color: 'var(--foreground)',
        fontFamily: 'inherit',
      }}
    >
      <span
        style={{
          margin: 0,
          fontSize: '17px',
          fontWeight: 600,
          lineHeight: 1.35,
          color: 'var(--foreground)',
          overflowWrap: 'anywhere',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {milestone.name}
      </span>
      <span style={{ margin: 0, fontSize: '13px', fontWeight: 400, lineHeight: 1.4, color: 'var(--muted)' }}>
        {total > 0 ? `${completed}/${total} 任务` : '暂无任务'}
      </span>
    </button>
  )
}
