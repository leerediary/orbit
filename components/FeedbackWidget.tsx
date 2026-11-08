'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  buildFeedbackMarkdown,
  clampFeedbackPosition,
  FEEDBACK_ITEMS_KEY,
  FEEDBACK_POSITION_KEY,
  formatFeedbackTimestamp,
  parseFeedbackItems,
  parseFeedbackPosition,
} from '@/lib/feedback'
import type { FeedbackItem, FeedbackPosition } from '@/lib/feedback'

const PANEL_ID = 'feedback-panel'

/** Default dock sits above the 56px FAB (24px inset + FAB + 16px gap). */
const FAB_SIZE = 56
const EDGE = 24
const FAB_GAP = 16

const FAB_STYLE: CSSProperties = {
  position: 'fixed',
  right: `max(${EDGE}px, env(safe-area-inset-right))`,
  bottom: `max(${EDGE}px, env(safe-area-inset-bottom))`,
  zIndex: 40,
  width: `${FAB_SIZE}px`,
  height: `${FAB_SIZE}px`,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '9999px',
  border: 'none',
  background: 'var(--accent)',
  color: '#ffffff',
  boxShadow: 'var(--card-shadow)',
  cursor: 'pointer',
}

const PANEL_BASE_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 40,
  width: 'min(340px, calc(100vw - 32px))',
  maxHeight: 'min(70vh, 520px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '16px',
  boxShadow: 'var(--card-shadow)',
  overflow: 'hidden',
}

const DRAG_HANDLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  padding: '8px 8px 8px 16px',
  borderBottom: '1px solid var(--border)',
  cursor: 'grab',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  flex: '0 0 auto',
}

const ICON_BUTTON_STYLE: CSSProperties = {
  width: '44px',
  height: '44px',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  borderRadius: '8px',
  color: 'var(--muted)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '96px',
  boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  resize: 'vertical',
}

function createId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through to the timestamp-based id
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface DragState {
  pointerId: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

/**
 * In-app feedback widget: a persistent Action Blue FAB in the bottom-right
 * corner that opens a draggable panel for jotting down issues. Notes and the
 * panel position live in localStorage only (`orbit_` prefix) — no Dexie entity,
 * no export-contract change, no new dependency.
 *
 * All browser access (window/localStorage/navigator) happens inside effects or
 * event handlers, never during render, so the static export stays prerenderable.
 */
export default function FeedbackWidget() {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [draft, setDraft] = useState('')
  // null = default dock on the right; an object = freely dragged position.
  const [pos, setPos] = useState<FeedbackPosition | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')

  const fabRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const hadOpenedRef = useRef(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hydrate once from localStorage. Reading in an effect keeps the module and
  // the render pass free of browser globals.
  useEffect(() => {
    try {
      setItems(parseFeedbackItems(localStorage.getItem(FEEDBACK_ITEMS_KEY)))
      setPos(parseFeedbackPosition(localStorage.getItem(FEEDBACK_POSITION_KEY)))
    } catch {
      // localStorage unavailable (private mode / disabled) — keep empty defaults.
    }
    setMounted(true)
  }, [])

  // Persist items. Guarded on `mounted` so the first commit (still [] before
  // hydration lands) never clobbers the stored list.
  useEffect(() => {
    if (!mounted) return
    try {
      localStorage.setItem(FEEDBACK_ITEMS_KEY, JSON.stringify(items))
    } catch {
      // Quota / unavailable storage — the in-memory list still works.
    }
  }, [items, mounted])

  // Persist a dragged position. A null position means "default dock"; there is
  // nothing to write until the user actually drags the panel.
  useEffect(() => {
    if (!mounted || pos === null) return
    try {
      localStorage.setItem(FEEDBACK_POSITION_KEY, JSON.stringify(pos))
    } catch {
      // Quota / unavailable storage — position just won't survive a reload.
    }
  }, [pos, mounted])

  // Move focus into the panel on open and back to the FAB on close (never on
  // the initial mount, when the panel has never been opened).
  useEffect(() => {
    if (open) {
      hadOpenedRef.current = true
      inputRef.current?.focus()
    } else if (hadOpenedRef.current) {
      fabRef.current?.focus()
    }
  }, [open])

  // Clear a pending "已复制" reset on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  function closePanel() {
    setOpen(false)
    setCopied(false)
    setCopyError(null)
  }

  function addItem() {
    const text = draft.trim()
    if (!text) return
    setItems((previous) => [
      ...previous,
      { id: createId(), text, createdAt: Date.now() },
    ])
    setDraft('')
    setCopyError(null)
    inputRef.current?.focus()
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    addItem()
  }

  // Enter (no Shift) commits; Shift+Enter inserts a newline. Shared by the
  // new-item textarea and the inline-edit textarea. IME composition is excluded
  // so confirming a Chinese composition never commits.
  function handleEditorKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    commit: () => void,
  ) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      commit()
    }
  }

  function startEdit(item: FeedbackItem) {
    setEditingId(item.id)
    setEditingDraft(item.text)
  }

  function saveEdit() {
    if (editingId === null) return
    const text = editingDraft.trim()
    setItems((previous) =>
      previous.map((item) =>
        item.id === editingId && text !== '' ? { ...item, text } : item,
      ),
    )
    setEditingId(null)
    setEditingDraft('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingDraft('')
  }

  function handleDelete(id: string) {
    setItems((previous) => previous.filter((item) => item.id !== id))
    if (editingId === id) {
      setEditingId(null)
      setEditingDraft('')
    }
  }

  async function handleCopyAll() {
    if (items.length === 0) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(buildFeedbackMarkdown(items, new Date()))
      setCopied(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, 1500)
    } catch {
      setCopied(false)
      setCopyError('复制失败，请重试。')
    }
  }

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    // Primary pointer / left button only.
    if (event.button !== 0 || !event.isPrimary) return
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    // Switch from the default dock to an absolute position at the current spot
    // so the panel doesn't jump when the drag begins.
    setPos({ x: rect.left, y: rect.top })
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  }

  function handleDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const next = clampFeedbackPosition(
      { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
      { width: window.innerWidth, height: window.innerHeight },
      { width: drag.width, height: drag.height },
    )
    setPos(next)
  }

  function handleDragEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released — nothing to do.
    }
  }

  const panelPositionStyle: CSSProperties =
    pos === null
      ? {
          right: `max(${EDGE}px, env(safe-area-inset-right))`,
          bottom: `calc(max(${EDGE}px, env(safe-area-inset-bottom)) + ${
            FAB_SIZE + FAB_GAP
          }px)`,
        }
      : {
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          right: 'auto',
          bottom: 'auto',
        }

  return (
    <>
      <style>{`
        @keyframes orbit-feedback-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .orbit-feedback-panel { animation: none !important; }
        }
      `}</style>

      <button
        ref={fabRef}
        type="button"
        data-feedback-fab
        aria-label="打开反馈"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((previous) => !previous)}
        style={FAB_STYLE}
      >
        <svg
          aria-hidden="true"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </button>

      {mounted && open ? (
        <div
          ref={panelRef}
          id={PANEL_ID}
          role="dialog"
          aria-modal="false"
          aria-label="反馈"
          data-feedback-panel
          className="orbit-feedback-panel"
          style={{
            ...PANEL_BASE_STYLE,
            ...panelPositionStyle,
            animation: 'orbit-feedback-in 150ms ease-out both',
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closePanel()
            }
          }}
        >
          <div
            data-feedback-drag-handle
            style={DRAG_HANDLE_STYLE}
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
          >
            <span
              style={{
                fontSize: '17px',
                fontWeight: 600,
                lineHeight: 1.2,
                color: 'var(--foreground)',
              }}
            >
              反馈
            </span>
            <button
              type="button"
              aria-label="关闭反馈"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={closePanel}
              style={ICON_BUTTON_STYLE}
            >
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form
            onSubmit={handleSubmit}
            style={{
              padding: '12px 16px',
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => handleEditorKeyDown(event, addItem)}
              placeholder="记一条问题…（Enter 提交，Shift+Enter 换行）"
              maxLength={2000}
              aria-label="记一条问题"
              rows={4}
              style={INPUT_STYLE}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                disabled={draft.trim() === ''}
                style={{
                  minHeight: '44px',
                  padding: '0 12px',
                  background: 'none',
                  border: 'none',
                  borderRadius: '8px',
                  color: 'var(--accent)',
                  fontSize: '17px',
                  fontWeight: 600,
                  lineHeight: 1.47,
                  fontFamily: 'inherit',
                  cursor: draft.trim() === '' ? 'default' : 'pointer',
                  opacity: draft.trim() === '' ? 0.4 : 1,
                }}
              >
                添加
              </button>
            </div>
          </form>

          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              padding: '0 16px',
            }}
          >
            {items.length === 0 ? (
              <p
                style={{
                  margin: '8px 0 12px',
                  fontSize: '13px',
                  lineHeight: 1.4,
                  color: 'var(--muted)',
                }}
              >
                还没有记录。
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((item) => {
                  const editing = editingId === item.id
                  return (
                    <li
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px',
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        {editing ? (
                          <textarea
                            autoFocus
                            value={editingDraft}
                            onChange={(event) => setEditingDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                event.stopPropagation()
                                cancelEdit()
                                return
                              }
                              handleEditorKeyDown(event, saveEdit)
                            }}
                            onBlur={saveEdit}
                            maxLength={2000}
                            aria-label="编辑这条反馈"
                            rows={3}
                            style={INPUT_STYLE}
                          />
                        ) : (
                          <>
                            <p
                              style={{
                                margin: 0,
                                fontSize: '17px',
                                fontWeight: 400,
                                lineHeight: 1.47,
                                color: 'var(--foreground)',
                                overflowWrap: 'anywhere',
                                whiteSpace: 'pre-wrap',
                              }}
                            >
                              {item.text}
                            </p>
                            <p
                              style={{
                                margin: '2px 0 0',
                                fontSize: '13px',
                                fontWeight: 400,
                                lineHeight: 1.4,
                                color: 'var(--muted)',
                              }}
                            >
                              {formatFeedbackTimestamp(item.createdAt)}
                            </p>
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={editing ? '保存这条反馈' : '编辑这条反馈'}
                        onClick={editing ? saveEdit : () => startEdit(item)}
                        style={ICON_BUTTON_STYLE}
                      >
                        <svg
                          aria-hidden="true"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          {editing ? (
                            <path d="M20 6 9 17l-5-5" />
                          ) : (
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                          )}
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="删除这条反馈"
                        onClick={() => handleDelete(item.id)}
                        style={ICON_BUTTON_STYLE}
                      >
                        <svg
                          aria-hidden="true"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div
            style={{
              flex: '0 0 auto',
              padding: '12px 16px',
              borderTop: '1px solid var(--border)',
            }}
          >
            {copyError ? (
              <p
                role="status"
                style={{
                  margin: '0 0 8px',
                  fontSize: '13px',
                  lineHeight: 1.4,
                  color: 'var(--foreground)',
                }}
              >
                {copyError}
              </p>
            ) : null}
            <button
              type="button"
              className="primary-button"
              onClick={handleCopyAll}
              disabled={items.length === 0}
              style={{ width: '100%' }}
            >
              {copied ? '已复制' : '复制全部'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
