'use client'

import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Goal } from '@/lib/types'
import ProgressIndicator from '@/components/ProgressIndicator'

interface GoalCardProps {
  goal: Goal
  variant: 'active' | 'archived'
  progress?: { completed: number; total: number }
  onOpen?: (goal: Goal) => void
  onRestore?: (goal: Goal) => void
  onDragHandlePointerDown?: (event: ReactPointerEvent<HTMLButtonElement>, goal: Goal) => void
  isDragging?: boolean
  showDropLine?: boolean
}

const FOCUS_RING_INSET = 'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * Name → date → clamped description, in that exact order (02-UI-SPEC §3/§4).
 * Shared by the active and archived variants so the type scale can never drift.
 */
function CardBody({ goal }: { goal: Goal }) {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        textAlign: 'left',
      }}
    >
      <span
        style={{
          fontSize: '17px',
          fontWeight: 600,
          lineHeight: 1.47,
          color: 'var(--foreground)',
          overflowWrap: 'anywhere',
        }}
      >
        {goal.name}
      </span>
      <span
        style={{
          fontSize: '13px',
          fontWeight: 400,
          lineHeight: 1.4,
          color: 'var(--muted)',
        }}
      >
        {formatDate(goal.created_at)}
      </span>
      {goal.description ? (
        <span
          style={{
            fontSize: '17px',
            fontWeight: 400,
            lineHeight: 1.47,
            color: 'var(--foreground)',
            marginTop: '4px',
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {goal.description}
        </span>
      ) : null}
    </span>
  )
}

/**
 * A single goal card (02-UI-SPEC §3/§4).
 *
 * Active: the whole main region is a `<button>`; the drag handle is a SEPARATE
 * sibling button (never nested — nested buttons are invalid HTML). Archived: the
 * main region is static and the only action is 恢复目标.
 */
export default function GoalCard({
  goal,
  variant,
  progress,
  onOpen,
  onRestore,
  onDragHandlePointerDown,
  isDragging = false,
  showDropLine = false,
}: GoalCardProps) {
  return (
    <li
      data-goal-card
      data-goal-id={goal.id}
      className={variant === 'active' ? 'flex flex-col' : 'flex'}
      style={{
        position: 'relative',
        gap: variant === 'active' ? '16px' : '8px',
        alignItems: variant === 'archived' ? 'flex-start' : undefined,
        padding: '16px',
        minWidth: 0,
        background: 'var(--card)',
        borderRadius: '12px',
        boxShadow: 'var(--card-shadow)',
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      {showDropLine ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '2px',
            background: 'var(--accent)',
          }}
        />
      ) : null}

      {variant === 'active' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
            <button
              type="button"
              data-goal-main
              data-goal-id={goal.id}
              onClick={() => onOpen?.(goal)}
              className={`${FOCUS_RING_INSET} active:opacity-60`}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                display: 'block',
                padding: 0,
                margin: 0,
                background: 'none',
                border: 'none',
                color: 'var(--foreground)',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <CardBody goal={goal} />
            </button>
            <button
              type="button"
              aria-label="调整顺序"
              onPointerDown={(event) => onDragHandlePointerDown?.(event, goal)}
              className={FOCUS_RING_INSET}
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
                touchAction: 'none',
                cursor: 'grab',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <line
                  x1="3"
                  y1="7"
                  x2="15"
                  y2="7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <line
                  x1="3"
                  y1="11"
                  x2="15"
                  y2="11"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          {variant === 'active' && progress && progress.total > 0 ? (
            <ProgressIndicator
              completed={progress.completed}
              total={progress.total}
              label="目标进度"
            />
          ) : null}
        </>
      ) : (
        <>
          <div data-goal-main data-goal-id={goal.id} style={{ flex: '1 1 auto', minWidth: 0 }}>
            <CardBody goal={goal} />
          </div>
          <button
            type="button"
            onClick={() => onRestore?.(goal)}
            className={FOCUS_RING_INSET}
            style={{
              flex: '0 0 auto',
              height: '44px',
              padding: '0 4px',
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: '17px',
              fontWeight: 400,
              lineHeight: 1.47,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            恢复目标
          </button>
        </>
      )}
    </li>
  )
}
