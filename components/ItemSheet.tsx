'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Habit } from '@/lib/types'
import PomodoroPickerSheet from '@/components/PomodoroPickerSheet'
import type { PomodoroPickerGroup } from '@/components/PomodoroPickerSheet'

interface BaseSheetProps {
  /** Edit-state sheet title. Defaults to 编辑目标 / 编辑里程碑 / 编辑任务 by mode. */
  title?: string
  initialName: string
  onDelete: () => void
  onCancel: () => void
  saving?: boolean
  saveError?: string | null
  deleteError?: string | null
  confirmState: boolean
  onRequestDelete: () => void
  onCancelDelete: () => void
}

/** Object payload for goal saves (name + habit link in one write). */
export interface GoalSavePayload {
  name: string
  habit_id: string | null
}

interface GoalSheetProps extends BaseSheetProps {
  mode: 'goal'
  /** Live milestones that will be cascade-deleted with the goal. */
  liveMilestoneCount?: number
  /** Live direct tasks that will be cascade-deleted with the goal. */
  liveDirectTaskCount?: number
  /** Active habits only, already sorted by the caller (sortHabits). */
  habits?: Habit[]
  habitsLoading?: boolean
  habitsError?: string | null
  onRetryHabits?: () => void
  /** Draft initial value for the habit link (null = not linked). */
  initialHabitId?: string | null
  onSave: (payload: GoalSavePayload) => void
}

interface MilestoneSheetProps extends BaseSheetProps {
  mode: 'milestone'
  /** Live tasks that will be cascade-deleted with the milestone. */
  liveTaskCount?: number
  onSave: (name: string) => void
}

/** Object payload for task saves (progress mode + quantity fields in one write). */
interface TaskSavePayload {
  name: string
  progress_type: 'checkbox' | 'quantity'
  unit: string | null
  target_value: number | null
  current_value: number | null
}

interface TaskSheetProps extends BaseSheetProps {
  mode: 'task'
  /** True when this task has live children — progress is derived, not editable. */
  isContainer?: boolean
  /** True when this task is under a milestone at depth ≤ 2 (L1/L2). */
  canAddSubtask?: boolean
  onAddSubtask?: () => void
  /** Live descendants that will be cascade-deleted with this task. */
  liveTaskCount?: number
  /** Edit-mode prefill for the progress-type control (§9). */
  initialProgressType?: 'checkbox' | 'quantity'
  initialUnit?: string | null
  initialTarget?: number | null
  initialCurrent?: number | null
  onSave: (payload: TaskSavePayload) => void
}

type ItemSheetProps = GoalSheetProps | MilestoneSheetProps | TaskSheetProps

const TITLE_ID = 'item-sheet-title'
const NAME_ID = 'item-sheet-name'
const UNIT_ID = 'item-sheet-unit'
const TARGET_ID = 'item-sheet-target'
const CURRENT_ID = 'item-sheet-current'

const PROGRESS_TYPES = [
  { value: 'checkbox', label: '勾选' },
  { value: 'quantity', label: '数量' },
] as const

const SHEET_INPUT_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '10px 12px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
}

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

const LABEL_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
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
}

const ACCENT_TEXT_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const COPY = {
  goal: { title: '编辑目标', save: '保存目标', del: '删除目标', confirm: '删除目标？' },
  milestone: { title: '编辑里程碑', save: '保存里程碑', del: '删除里程碑', confirm: '删除里程碑？' },
  task: { title: '编辑任务', save: '保存任务', del: '删除任务', confirm: '删除任务？' },
} as const

/**
 * Shared goal/milestone/task editor sheet (07-UI-SPEC §Sheets). Reuses the
 * CategorySheet chrome with unique animation class names. Presentational:
 * GoalDetail owns persistence, sort_order, and the tombstone. This component is
 * purely presentational; delete only calls `onDelete()`.
 *
 * A task's parent is fixed to its milestone — there is no parent selector.
 */
export default function ItemSheet(props: ItemSheetProps) {
  const { initialName, onCancel, confirmState, onRequestDelete, onCancelDelete } = props
  const saving = props.saving ?? false
  const saveError = props.saveError ?? null
  const deleteError = props.deleteError ?? null

  const [name, setName] = useState(initialName)
  const [nameError, setNameError] = useState<string | null>(null)

  // Goal mode: draft habit link + nested picker. Selection/clear only mutates
  // this draft; 保存目标 persists it together with the name (22-UI-SPEC).
  const [habitId, setHabitId] = useState<string | null>(
    props.mode === 'goal' ? (props.initialHabitId ?? null) : null,
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // Task mode: 进度方式 + quantity fields (UI-SPEC §9). Prefilled in edit mode so
  // editing a quantity task never silently resets it to checkbox/null.
  const [progressType, setProgressType] = useState<'checkbox' | 'quantity'>(
    props.mode === 'task' ? (props.initialProgressType ?? 'checkbox') : 'checkbox',
  )
  const [unit, setUnit] = useState(
    props.mode === 'task' ? (props.initialUnit ?? '') : '',
  )
  const [target, setTarget] = useState(
    props.mode === 'task' && props.initialTarget != null
      ? String(props.initialTarget)
      : '',
  )
  const [current, setCurrent] = useState(
    props.mode === 'task' && props.initialCurrent != null
      ? String(props.initialCurrent)
      : '0',
  )
  const [unitError, setUnitError] = useState<string | null>(null)
  const [targetError, setTargetError] = useState<string | null>(null)
  const [currentError, setCurrentError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const unitInputRef = useRef<HTMLInputElement | null>(null)
  const targetInputRef = useRef<HTMLInputElement | null>(null)
  const currentInputRef = useRef<HTMLInputElement | null>(null)
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([])
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const habitTriggerRef = useRef<HTMLButtonElement | null>(null)

  // Edit state starts on 名称; the confirm state starts on the safe 取消 button.
  useEffect(() => {
    if (confirmState) {
      cancelButtonRef.current?.focus()
    } else {
      nameInputRef.current?.focus()
    }
  }, [confirmState])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!saving) onCancel()
      return
    }
    if (event.key !== 'Tab') return

    // Hand-rolled focus trap: cycle Tab/Shift+Tab within the dialog.
    const root = dialogRef.current
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

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('名称不能为空')
      nameInputRef.current?.focus()
      return
    }
    setNameError(null)

    if (props.mode === 'goal') {
      props.onSave({ name: trimmed, habit_id: habitId })
      return
    }

    if (props.mode === 'milestone') {
      props.onSave(trimmed)
      return
    }

    // Containers derive progress from children; the control is hidden, so
    // preserve the stored mode/quantity fields rather than wiping them.
    if (props.isContainer) {
      const trimmedUnit = unit.trim()
      props.onSave({
        name: trimmed,
        progress_type: progressType,
        unit: trimmedUnit ? trimmedUnit : null,
        target_value: props.initialTarget ?? null,
        current_value: props.initialCurrent ?? null,
      })
      return
    }

    if (progressType === 'quantity') {
      const trimmedUnit = unit.trim()
      if (!trimmedUnit) {
        setUnitError('请填写单位。')
        unitInputRef.current?.focus()
        return
      }
      const targetValue = Number(target.trim())
      if (!Number.isFinite(targetValue) || targetValue <= 0) {
        setTargetError('目标量需大于 0。')
        targetInputRef.current?.focus()
        return
      }
      const currentValue = Number(current.trim())
      if (!Number.isFinite(currentValue) || currentValue < 0) {
        setCurrentError('已做量不能小于 0。')
        currentInputRef.current?.focus()
        return
      }
      props.onSave({
        name: trimmed,
        progress_type: 'quantity',
        unit: trimmedUnit,
        target_value: targetValue,
        current_value: currentValue,
      })
      return
    }

    // checkbox leaf: clear every quantity field.
    props.onSave({
      name: trimmed,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
    })
  }

  const copy = COPY[props.mode]
  const resolvedTitle = props.title ?? copy.title

  let confirmBody: string
  if (props.mode === 'goal') {
    const milestoneCount = props.liveMilestoneCount ?? 0
    const directCount = props.liveDirectTaskCount ?? 0
    confirmBody = `「${initialName}」将被删除，其下的 ${milestoneCount} 个里程碑、${directCount} 个直接任务（及其所有子任务）会一并删除，且本阶段无法从界面恢复。`
  } else if (props.mode === 'milestone') {
    const count = props.liveTaskCount ?? 0
    confirmBody =
      count > 0
        ? `「${initialName}」将被删除，其下的 ${count} 个任务（含子任务）会一并删除，且本阶段无法从界面恢复。`
        : `「${initialName}」将被删除，且本阶段无法从界面恢复。`
  } else {
    // Task mode is cascade-aware: containers report their live descendants.
    const count = props.liveTaskCount ?? 0
    confirmBody =
      count > 0
        ? `「${initialName}」将被删除，其下的 ${count} 个子任务会一并删除，且本阶段无法从界面恢复。`
        : `「${initialName}」将被删除，且本阶段无法从界面恢复。`
  }

  // Goal habit trigger copy (22-UI-SPEC State Matrix): linked name when live,
  // 不关联 when unlinked, 原习惯已存档 when the reference is archived/missing.
  const linkedHabit =
    props.mode === 'goal' && habitId != null
      ? ((props.habits ?? []).find((habit) => habit.id === habitId) ?? null)
      : null
  const habitLabel =
    habitId == null ? '不关联' : linkedHabit ? linkedHabit.name : '原习惯已存档'
  const habitMuted = linkedHabit === null
  const habitPickerGroups: PomodoroPickerGroup[] =
    props.mode === 'goal'
      ? [
          {
            title: '习惯',
            options: (props.habits ?? []).map((habit) => ({
              id: habit.id,
              label: habit.name,
              kind: 'habit' as const,
            })),
          },
        ]
      : []

  return (
    <>
      <style>{`
        @keyframes orbit-item-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-item-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-item-scrim { animation: orbit-item-scrim-in 150ms ease-out both; }
        .orbit-item-sheet { animation: orbit-item-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-item-scrim, .orbit-item-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-item-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog" aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-item-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
          style={{
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
            {confirmState ? copy.confirm : resolvedTitle}
          </h2>

          {confirmState ? (
            <div>
              <p
                style={{
                  margin: '16px 0 0',
                  fontSize: '17px',
                  fontWeight: 400,
                  lineHeight: 1.47,
                  color: 'var(--foreground)',
                  overflowWrap: 'anywhere',
                }}
              >
                {confirmBody}
              </p>

              {deleteError ? (
                <p style={{ ...INLINE_ERROR_STYLE, marginTop: '16px' }}>{deleteError}</p>
              ) : null}

              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={props.onDelete}
                  disabled={saving}
                  aria-busy={saving}
                  className={FOCUS_RING}
                  style={{
                    width: '100%',
                    minHeight: '44px',
                    padding: '0 16px',
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--foreground)',
                    fontSize: '17px',
                    fontWeight: 600,
                    lineHeight: 1.47,
                    fontFamily: 'inherit',
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.4 : 1,
                  }}
                >
                  确认删除
                </button>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={onCancelDelete}
                  className={FOCUS_RING}
                  style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} noValidate>
                <div
                  style={{
                    marginTop: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label htmlFor={NAME_ID} style={LABEL_STYLE}>
                      名称
                    </label>
                    <input
                      id={NAME_ID}
                      ref={nameInputRef}
                      type="text"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                        if (nameError) setNameError(null)
                      }}
                      maxLength={100}
                      required
                      aria-required="true"
                      aria-invalid={nameError !== null}
                      className={FOCUS_RING}
                      style={SHEET_INPUT_STYLE}
                    />
                    {nameError ? <p style={INLINE_ERROR_STYLE}>{nameError}</p> : null}
                  </div>

                  {props.mode === 'goal' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <span style={LABEL_STYLE}>关联习惯</span>

                      {props.habitsError ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: '8px',
                          }}
                        >
                          <p style={INLINE_ERROR_STYLE}>{props.habitsError}</p>
                          <button
                            type="button"
                            onClick={() => {
                              if (props.mode === 'goal') props.onRetryHabits?.()
                            }}
                            className={FOCUS_RING}
                            style={ACCENT_TEXT_BUTTON_STYLE}
                          >
                            重试
                          </button>
                        </div>
                      ) : (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              width: '100%',
                            }}
                          >
                            <button
                              ref={habitTriggerRef}
                              type="button"
                              aria-haspopup="dialog"
                              aria-label={`关联习惯：${habitLabel}`}
                              disabled={props.habitsLoading || saving}
                              onClick={() => setPickerOpen(true)}
                              className={FOCUS_RING}
                              style={{
                                ...SHEET_INPUT_STYLE,
                                flex: '1 1 auto',
                                minWidth: 0,
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '8px',
                                textAlign: 'left',
                                cursor:
                                  props.habitsLoading || saving ? 'default' : 'pointer',
                                opacity: props.habitsLoading || saving ? 0.4 : 1,
                              }}
                            >
                              <span
                                style={{
                                  minWidth: 0,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  color: habitMuted ? 'var(--muted)' : 'var(--foreground)',
                                }}
                              >
                                {props.habitsLoading ? '正在加载习惯…' : habitLabel}
                              </span>
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 18 18"
                                aria-hidden="true"
                                focusable="false"
                                style={{ flex: '0 0 18px' }}
                              >
                                <polyline
                                  points="5 7 9 11 13 7"
                                  fill="none"
                                  stroke="var(--muted)"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>

                            {habitId != null && !props.habitsLoading ? (
                              <button
                                type="button"
                                aria-label="清除关联习惯"
                                disabled={saving}
                                onClick={() => setHabitId(null)}
                                className={FOCUS_RING}
                                style={{
                                  flex: '0 0 44px',
                                  width: '44px',
                                  height: '44px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  padding: 0,
                                  background: 'none',
                                  border: 'none',
                                  color: 'var(--muted)',
                                  fontSize: '20px',
                                  lineHeight: 1,
                                  cursor: saving ? 'default' : 'pointer',
                                  opacity: saving ? 0.4 : 1,
                                }}
                              >
                                ×
                              </button>
                            ) : null}
                          </div>

                          <p style={{ ...LABEL_STYLE, margin: 0 }}>
                            该目标下的任务完成或推进时，会自动给这个习惯打卡。
                          </p>
                        </>
                      )}
                    </div>
                  ) : null}

                  {props.mode === 'task' && !props.isContainer ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <span style={LABEL_STYLE}>进度方式</span>
                      <div
                        role="radiogroup"
                        aria-label="进度方式"
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
                        {PROGRESS_TYPES.map((option, index) => {
                          const selected = progressType === option.value
                          return (
                            <button
                              key={option.value}
                              ref={(el) => {
                                radioRefs.current[index] = el
                              }}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              tabIndex={selected ? 0 : -1}
                              onClick={() => setProgressType(option.value)}
                              onKeyDown={(event) => {
                                if (
                                  event.key !== 'ArrowRight' &&
                                  event.key !== 'ArrowLeft'
                                ) {
                                  return
                                }
                                event.preventDefault()
                                const direction =
                                  event.key === 'ArrowRight' ? 1 : -1
                                const nextIndex =
                                  (index + direction + PROGRESS_TYPES.length) %
                                  PROGRESS_TYPES.length
                                setProgressType(PROGRESS_TYPES[nextIndex].value)
                                radioRefs.current[nextIndex]?.focus()
                              }}
                              className={FOCUS_RING}
                              style={{
                                flex: '1 1 0',
                                height: '36px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: '0 12px',
                                borderRadius: '8px',
                                border: selected
                                  ? '1px solid var(--border)'
                                  : '1px solid transparent',
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
                    </div>
                  ) : null}

                  {props.mode === 'task' &&
                  !props.isContainer &&
                  progressType === 'quantity' ? (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label htmlFor={UNIT_ID} style={LABEL_STYLE}>
                          单位
                        </label>
                        <input
                          id={UNIT_ID}
                          ref={unitInputRef}
                          type="text"
                          value={unit}
                          onChange={(event) => {
                            setUnit(event.target.value)
                            if (unitError) setUnitError(null)
                          }}
                          maxLength={10}
                          placeholder="如：页"
                          aria-required="true"
                          aria-invalid={unitError !== null}
                          className={FOCUS_RING}
                          style={SHEET_INPUT_STYLE}
                        />
                        {unitError ? <p style={INLINE_ERROR_STYLE}>{unitError}</p> : null}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label htmlFor={TARGET_ID} style={LABEL_STYLE}>
                          目标量
                        </label>
                        <input
                          id={TARGET_ID}
                          ref={targetInputRef}
                          type="text"
                          inputMode="decimal"
                          value={target}
                          onChange={(event) => {
                            setTarget(event.target.value)
                            if (targetError) setTargetError(null)
                          }}
                          placeholder="如：300"
                          aria-required="true"
                          aria-invalid={targetError !== null}
                          className={FOCUS_RING}
                          style={SHEET_INPUT_STYLE}
                        />
                        {targetError ? <p style={INLINE_ERROR_STYLE}>{targetError}</p> : null}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label htmlFor={CURRENT_ID} style={LABEL_STYLE}>
                          已做
                        </label>
                        <input
                          id={CURRENT_ID}
                          ref={currentInputRef}
                          type="text"
                          inputMode="decimal"
                          value={current}
                          onChange={(event) => {
                            setCurrent(event.target.value)
                            if (currentError) setCurrentError(null)
                          }}
                          placeholder="0"
                          aria-invalid={currentError !== null}
                          className={FOCUS_RING}
                          style={SHEET_INPUT_STYLE}
                        />
                        {currentError ? (
                          <p style={INLINE_ERROR_STYLE}>{currentError}</p>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {props.mode === 'task' && props.isContainer ? (
                    <p style={{ ...LABEL_STYLE, margin: 0 }}>进度由子任务自动汇总。</p>
                  ) : null}
                </div>

                {saveError ? (
                  <p style={{ ...INLINE_ERROR_STYLE, marginTop: '24px' }}>{saveError}</p>
                ) : null}

                <div
                  style={{
                    marginTop: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <button
                    type="submit"
                    disabled={saving}
                    aria-busy={saving}
                    style={{
                      width: '100%',
                      minHeight: '44px',
                      padding: '0 16px',
                      background: 'var(--accent)',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '17px',
                      fontWeight: 600,
                      lineHeight: 1.47,
                      fontFamily: 'inherit',
                      cursor: saving ? 'default' : 'pointer',
                      opacity: saving ? 0.4 : 1,
                    }}
                  >
                    {copy.save}
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    className={FOCUS_RING}
                    style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                  >
                    取消编辑
                  </button>
                </div>
              </form>

              {props.mode === 'task' && props.canAddSubtask && props.onAddSubtask ? (
                <div
                  style={{
                    marginTop: '24px',
                    paddingTop: '24px',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <button
                    type="button"
                    onClick={props.onAddSubtask}
                    disabled={saving}
                    className={FOCUS_RING}
                    style={{
                      ...ACCENT_TEXT_BUTTON_STYLE,
                      cursor: saving ? 'default' : 'pointer',
                      opacity: saving ? 0.4 : 1,
                    }}
                  >
                    添加子任务
                  </button>
                </div>
              ) : null}

              <div
                style={{
                  marginTop: '24px',
                  paddingTop: '24px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  onClick={onRequestDelete}
                  disabled={saving}
                  className={FOCUS_RING}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    cursor: saving ? 'default' : 'pointer',
                  }}
                >
                  {copy.del}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Nested picker is a SIBLING of the edit-sheet scrim (outside its
          onKeyDown subtree), so its Escape/Tab never bubbles into the edit
          sheet's focus trap. z-[60] still covers the z-50 sheet (T-22-12). */}
      {props.mode === 'goal' && pickerOpen ? (
        <PomodoroPickerSheet
          open={pickerOpen}
          title="选择关联习惯"
          groups={habitPickerGroups}
          selectedIds={habitId ? [habitId] : []}
          emptyText="还没有习惯。先到「习惯打卡」添加一个。"
          onSelect={(id) => setHabitId(id)}
          onClose={() => setPickerOpen(false)}
          returnFocusRef={habitTriggerRef}
        />
      ) : null}
    </>
  )
}
