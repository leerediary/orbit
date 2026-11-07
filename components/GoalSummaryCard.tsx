'use client'

import type { Goal } from '@/lib/types'
import ProgressIndicator from '@/components/ProgressIndicator'

/**
 * A fixed-size goal summary card for the category horizontal row:
 * uniform width/height so every card in a row is the same size, and it shows
 * only a brief summary — name + derived goal progress. Full goal management
 * lives behind the goal drill-in, not here.
 */
export default function GoalSummaryCard({
  goal,
  completed,
  total,
  onClick,
}: {
  goal: Goal
  completed: number
  total: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-goal-summary
      data-goal-summary-id={goal.id}
      onClick={onClick}
      className="goal-summary-card focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px] active:opacity-60"
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
        {goal.name}
      </span>
      {total > 0 ? (
        <ProgressIndicator completed={completed} total={total} label="目标进度" format="percent" />
      ) : (
        <span style={{ margin: 0, fontSize: '13px', fontWeight: 400, lineHeight: 1.4, color: 'var(--muted)' }}>
          暂无任务
        </span>
      )}
    </button>
  )
}
