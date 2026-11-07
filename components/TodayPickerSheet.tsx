'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import type { PickableLeaf } from '@/lib/today-list'
import { groupLeavesByParent } from '@/lib/today-list'

/** One milestone's candidate leaves, or a goal's direct tasks (milestoneId null). */
export interface PickerMilestoneGroup {
  milestoneId: string | null
  milestoneName: string | null
  leaves: PickableLeaf[]
}

export interface PickerGoalGroup {
  goalId: string
  goalName: string
  milestoneGroups: PickerMilestoneGroup[]
}

export interface PickerCategoryGroup {
  categoryId: string
  categoryName: string
  goals: PickerGoalGroup[]
}

interface TodayPickerSheetProps {
  open: boolean
  groups: PickerCategoryGroup[]
  onClose: () => void
  onConfirm: (taskIds: string[]) => Promise<void>
  returnFocusRef: RefObject<HTMLElement | null>
}

const TITLE_ID = 'today-picker-title'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const EMPTY_STYLE: CSSProperties = {
  margin: '24px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const GOAL_HEADING_STYLE: CSSProperties = {
  margin: 0,
  // 09-UI-SPEC §8: goal headers are 17px/600.
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

// Category is the top grouping level: a quiet 13px label above its goals.
const CATEGORY_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.4,
  letterSpacing: '0.02em',
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

// Milestone (and the synthetic 直接任务 group) sit under a goal as a quieter
// sub-header, mirroring GoalDetail's milestone-section / direct-task split.
const MILESTONE_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

// Collapsible level header (category/goal/milestone): chevron + label.
const EXPANDER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  width: '100%',
  minWidth: 0,
  minHeight: '44px',
  padding: 0,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}

const ROW_NAME_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

// Ancestor breadcrumb shown under a leaf name so same-named chapters in
// different 部 (books) stay distinguishable (T2).
const BREADCRUMB_STYLE: CSSProperties = {
  display: 'block',
  marginTop: '2px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

/** Right-pointing chevron that rotates down when expanded. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
      style={{
        flexShrink: 0,
        color: 'var(--muted)',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 120ms ease-out',
      }}
    >
      <polyline
        points="6 3 12 9 6 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 加入今天 picker (09-UI-SPEC §8).
 *
 * Multi-select bottom sheet reusing ItemSheet's scrim/panel/animation/focus-trap
 * semantics with unique animation class names. Purely presentational over the
 * pre-grouped candidates: TodayView owns the ordering, the exclusion set, and
 * the linked-membership writes. Task names render as JSX text nodes only
 * (T-09-18 — never innerHTML).
 *
 * The hierarchy is COLLAPSED by default: only categories show; tapping a level
 * expands its children one level at a time (分类 → 目标 → 里程碑 → 任务).
 */
export default function TodayPickerSheet({
  open,
  groups,
  onClose,
  onConfirm,
  returnFocusRef,
}: TodayPickerSheetProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Collapsed-by-default hierarchy: which category/goal/milestone is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const panelRef = useRef<HTMLDivElement | null>(null)

  // Opened: reset the transaction state and land focus on the first candidate
  // checkbox (the panel itself when the candidate list is empty).
  useEffect(() => {
    if (!open) return
    setSelected(new Set())
    setError(null)
    setSaving(false)
    setExpanded(new Set())
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )
      ;(first ?? panelRef.current)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  function close() {
    onClose()
    const target = returnFocusRef.current
    if (target) requestAnimationFrame(() => target.focus())
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Escape is ignored while a save is in flight (09-UI-SPEC §8).
      if (!saving) close()
      return
    }
    if (event.key !== 'Tab') return

    // Hand-rolled focus trap: same algorithm as ItemSheet.
    const root = panelRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    const inside = current instanceof Node && root.contains(current)

    if (event.shiftKey) {
      if (!inside || current === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function toggle(taskId: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
    if (error) setError(null)
  }

  function toggleExpanded(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleConfirm() {
    if (saving || selected.size === 0) return
    setSaving(true)
    setError(null)
    // Groups order (not Set insertion order) defines the write order.
    const ids: string[] = []
    for (const category of groups) {
      for (const goal of category.goals) {
        for (const milestoneGroup of goal.milestoneGroups) {
          for (const leaf of milestoneGroup.leaves) {
            if (selected.has(leaf.task.id)) ids.push(leaf.task.id)
          }
        }
      }
    }
    try {
      // 写入顺序决定 added_at，而今日列表按 added_at 倒序展示——按计划顺序
      // 逆序写入，列表里才是计划正序（T16：批量添加书章节不再倒序/乱序）。
      await onConfirm(ids.reverse())
      close()
    } catch {
      // Keep the sheet open with the selection intact (09-UI-SPEC §8).
      setError('加入今天失败，请重试。')
      setSaving(false)
    }
  }

  if (!open) return null

  const hasCandidates = groups.some((category) =>
    category.goals.some((goal) =>
      goal.milestoneGroups.some((milestoneGroup) => milestoneGroup.leaves.length > 0),
    ),
  )
  const count = selected.size
  const primaryDisabled = count === 0 || saving

  return (
    <>
      <style>{`
        @keyframes orbit-picker-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-picker-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-picker-scrim { animation: orbit-picker-scrim-in 150ms ease-out both; }
        .orbit-picker-sheet { animation: orbit-picker-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-picker-scrim, .orbit-picker-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-picker-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) close()
        }}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          tabIndex={-1}
          className="orbit-picker-sheet w-full sm:max-w-[448px] rounded-t-2xl sm:rounded-2xl"
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '70vh',
            overflow: 'hidden',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '24px',
            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          }}
        >
          <h2
            id={TITLE_ID}
            style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: 600,
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            加入今天
          </h2>

          {hasCandidates ? (
            <div
              style={{
                marginTop: '24px',
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '24px',
              }}
            >
              {groups.map((category) =>
                category.goals.length === 0 ? null : (
                  <section
                    key={category.categoryId}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpanded(`c:${category.categoryId}`)}
                      aria-expanded={expanded.has(`c:${category.categoryId}`)}
                      className={FOCUS_RING}
                      style={EXPANDER_STYLE}
                    >
                      <Chevron open={expanded.has(`c:${category.categoryId}`)} />
                      <span style={CATEGORY_HEADING_STYLE}>{category.categoryName}</span>
                    </button>
                    {expanded.has(`c:${category.categoryId}`)
                      ? category.goals.map((goal) => (
                          <div
                            key={goal.goalId}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                              paddingLeft: '20px',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => toggleExpanded(`g:${goal.goalId}`)}
                              aria-expanded={expanded.has(`g:${goal.goalId}`)}
                              className={FOCUS_RING}
                              style={EXPANDER_STYLE}
                            >
                              <Chevron open={expanded.has(`g:${goal.goalId}`)} />
                              <span style={GOAL_HEADING_STYLE}>{goal.goalName}</span>
                            </button>
                            {expanded.has(`g:${goal.goalId}`)
                              ? goal.milestoneGroups.map((milestoneGroup) =>
                                  milestoneGroup.leaves.length === 0 ? null : (
                                    <div
                                      key={
                                        milestoneGroup.milestoneId ?? `d:${goal.goalId}`
                                      }
                                      style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '4px',
                                        paddingLeft: '20px',
                                      }}
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleExpanded(
                                            `m:${goal.goalId}:${
                                              milestoneGroup.milestoneId ?? 'd'
                                            }`,
                                          )
                                        }
                                        aria-expanded={expanded.has(
                                          `m:${goal.goalId}:${
                                            milestoneGroup.milestoneId ?? 'd'
                                          }`,
                                        )}
                                        className={FOCUS_RING}
                                        style={EXPANDER_STYLE}
                                      >
                                        <Chevron
                                          open={expanded.has(
                                            `m:${goal.goalId}:${
                                              milestoneGroup.milestoneId ?? 'd'
                                            }`,
                                          )}
                                        />
                                        <span style={MILESTONE_HEADING_STYLE}>
                                          {milestoneGroup.milestoneName ?? '直接任务'}
                                        </span>
                                      </button>
                                      {expanded.has(
                                        `m:${goal.goalId}:${
                                          milestoneGroup.milestoneId ?? 'd'
                                        }`,
                                      ) ? (
                                        <ul
                                          style={{
                                            listStyle: 'none',
                                            margin: 0,
                                            padding: 0,
                                            paddingLeft: '20px',
                                            display: 'flex',
                                            flexDirection: 'column',
                                          }}
                                        >
                                          {(() => {
                                            const { direct, groups } = groupLeavesByParent(
                                              milestoneGroup.leaves,
                                            )
                                            const renderRow = (
                                              leaf: PickableLeaf,
                                              index: number,
                                            ) => {
                                            const taskId = leaf.task.id
                                            const checked = selected.has(taskId)
                                            return (
                                              <li
                                                key={taskId}
                                                style={{
                                                  borderTop:
                                                    index === 0
                                                      ? 'none'
                                                      : '1px solid var(--border)',
                                                }}
                                              >
                                                <label
                                                  className="has-[:focus-visible]:[outline:2px_solid_var(--accent)] has-[:focus-visible]:[outline-offset:-2px]"
                                                  style={{
                                                    // Anchor the sr-only checkbox to this
                                                    // row so focusing it never scrolls the
                                                    // list back to the top (drift fix).
                                                    position: 'relative',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '8px',
                                                    minHeight: '44px',
                                                    padding: '4px 0',
                                                    minWidth: 0,
                                                    cursor: 'pointer',
                                                  }}
                                                >
                                                  <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggle(taskId)}
                                                    aria-label={leaf.task.name}
                                                    className="sr-only"
                                                  />
                                                  <span
                                                    aria-hidden="true"
                                                    className="motion-reduce:transition-none"
                                                    style={{
                                                      flex: '0 0 22px',
                                                      width: '22px',
                                                      height: '22px',
                                                      borderRadius: '50%',
                                                      boxSizing: 'border-box',
                                                      display: 'flex',
                                                      alignItems: 'center',
                                                      justifyContent: 'center',
                                                      background: checked
                                                        ? 'var(--accent)'
                                                        : 'transparent',
                                                      border: checked
                                                        ? 'none'
                                                        : '1.5px solid var(--muted)',
                                                      transition:
                                                        'background-color 120ms ease-out, border-color 120ms ease-out',
                                                    }}
                                                  >
                                                    {checked ? (
                                                      <svg
                                                        width="12"
                                                        height="12"
                                                        viewBox="0 0 12 12"
                                                        aria-hidden="true"
                                                        focusable="false"
                                                      >
                                                        <polyline
                                                          points="2 6 5 9 10 3"
                                                          fill="none"
                                                          stroke="#ffffff"
                                                          strokeWidth="2"
                                                          strokeLinecap="round"
                                                          strokeLinejoin="round"
                                                        />
                                                      </svg>
                                                    ) : null}
                                                  </span>
                                                  <span
                                                    style={{
                                                      flex: '1 1 auto',
                                                      minWidth: 0,
                                                    }}
                                                  >
                                                    <span style={ROW_NAME_STYLE}>
                                                      {leaf.task.name}
                                                    </span>
                                                    {leaf.breadcrumb ? (
                                                      <span style={BREADCRUMB_STYLE}>
                                                        {leaf.breadcrumb}
                                                      </span>
                                                    ) : null}
                                                  </span>
                                                </label>
                                              </li>
                                            )
                                            }
                                            return (
                                              <>
                                                {direct.map((leaf, index) =>
                                                  renderRow(leaf, index),
                                                )}
                                                {groups.map((group) => {
                                                  const pkey = `p:${goal.goalId}:${
                                                    milestoneGroup.milestoneId ?? 'd'
                                                  }:${group.parentId}`
                                                  const open = expanded.has(pkey)
                                                  return (
                                                    <li
                                                      key={group.parentId}
                                                      style={{ listStyle: 'none' }}
                                                    >
                                                      <button
                                                        type="button"
                                                        onClick={() => toggleExpanded(pkey)}
                                                        aria-expanded={open}
                                                        className={FOCUS_RING}
                                                        style={EXPANDER_STYLE}
                                                      >
                                                        <Chevron open={open} />
                                                        <span
                                                          style={MILESTONE_HEADING_STYLE}
                                                        >
                                                          {group.parentName}
                                                        </span>
                                                      </button>
                                                      {open ? (
                                                        <ul
                                                          style={{
                                                            listStyle: 'none',
                                                            margin: 0,
                                                            padding: 0,
                                                            paddingLeft: '20px',
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                          }}
                                                        >
                                                          {group.leaves.map((leaf, index) =>
                                                            renderRow(
                                                              { ...leaf, breadcrumb: null },
                                                              index,
                                                            ),
                                                          )}
                                                        </ul>
                                                      ) : null}
                                                    </li>
                                                  )
                                                })}
                                              </>
                                            )
                                          })()}
                                        </ul>
                                      ) : null}
                                    </div>
                                  ),
                                )
                              : null}
                          </div>
                        ))
                      : null}
                  </section>
                ),
              )}
            </div>
          ) : (
            <p style={EMPTY_STYLE}>
              还没有可加入的任务。先去长期计划里添加任务。
            </p>
          )}

          <div
            style={{
              marginTop: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              flexShrink: 0,
            }}
          >
            {error ? <p style={INLINE_ERROR_STYLE}>{error}</p> : null}

            {hasCandidates ? (
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={primaryDisabled}
                aria-busy={saving}
                className={FOCUS_RING}
                style={{
                  width: '100%',
                  minHeight: '44px',
                  padding: '0 16px',
                  background: 'var(--accent)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '15px',
                  fontWeight: 400,
                  lineHeight: 1.47,
                  fontFamily: 'inherit',
                  cursor: primaryDisabled ? 'default' : 'pointer',
                  opacity: primaryDisabled ? 0.4 : 1,
                }}
              >
                {count > 0 ? `加入今天（${count}）` : '加入今天'}
              </button>
            ) : null}

            <button
              type="button"
              onClick={close}
              className={FOCUS_RING}
              style={SECONDARY_BUTTON_STYLE}
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
