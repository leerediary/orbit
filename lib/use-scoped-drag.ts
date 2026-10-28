'use client'

import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

interface UseScopedDragOptions<T> {
  items: readonly T[]
  idOf: (item: T) => string
  onCommit: (finalOrder: T[], baseline: T[]) => Promise<void> | void
  /** Group container; only its matching descendants are measured. */
  containerRef: RefObject<HTMLElement | null>
  /** Selector for the draggable siblings inside the container. */
  itemSelector: string
}

interface DragSession<T> {
  item: T
  original: T[]
  rects: Array<{ id: string; mid: number }>
  startY: number
  started: boolean
  order: T[] | null
  dropIndex: number | null
}

interface UseScopedDragResult<T> {
  dragId: string | null
  dragOrder: T[] | null
  dropIndex: number | null
  onHandlePointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: T,
  ) => void
}

/**
 * Scoped pointer-drag reorder extracted from the Phase 2 goals list.
 *
 * Measures only siblings matching `itemSelector` inside `containerRef`, so a
 * drag can never cross groups (D-06). Pointer-only by design — there is no
 * keyboard reorder (03-UI-SPEC "Drag reorder — scoped"). Persists only on drop;
 * Escape / pointercancel / a sub-4px gesture write nothing.
 */
export function useScopedDrag<T>({
  items,
  idOf,
  onCommit,
  containerRef,
  itemSelector,
}: UseScopedDragOptions<T>): UseScopedDragResult<T> {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOrder, setDragOrder] = useState<T[] | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragRef = useRef<DragSession<T> | null>(null)

  function resetDrag() {
    dragRef.current = null
    setDragId(null)
    setDragOrder(null)
    setDropIndex(null)
  }

  function onHandlePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    item: T,
  ) {
    if (dragRef.current) return
    // Ignore non-primary mouse buttons; touch/pen pointers have button 0.
    if (event.pointerType === 'mouse' && event.button !== 0) return

    const draggedId = idOf(item)
    const container = containerRef.current
    const nodes = container
      ? Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
      : []

    // Measure every OTHER sibling in this group only. `data-drag-id` is the
    // generic id hook; index alignment is the fallback (DOM order mirrors the
    // rendered item order).
    const rects = nodes
      .map((element, index) => {
        const id = element.dataset.dragId ?? (items[index] ? idOf(items[index]) : '')
        if (!id || id === draggedId) return null
        const rect = element.getBoundingClientRect()
        return { id, mid: rect.top + rect.height / 2 }
      })
      .filter((rect): rect is { id: string; mid: number } => rect !== null)

    if (rects.length === 0) return

    event.preventDefault()

    const session: DragSession<T> = {
      item,
      original: [...items],
      rects,
      startY: event.clientY,
      started: false,
      order: null,
      dropIndex: null,
    }
    dragRef.current = session

    function onMove(moveEvent: PointerEvent) {
      const current = dragRef.current
      if (!current) return

      // 4px movement threshold prevents accidental drags.
      if (!current.started) {
        if (Math.abs(moveEvent.clientY - current.startY) < 4) return
        current.started = true
        setDragId(idOf(current.item))
      }

      // Insertion index is over the OTHER items only; counting the dragged
      // item's own midpoint shifts downward drags one slot too far.
      let target = current.rects.length
      for (let index = 0; index < current.rects.length; index += 1) {
        if (moveEvent.clientY < current.rects[index].mid) {
          target = index
          break
        }
      }

      if (current.dropIndex === target && current.order) return

      const draggedId = idOf(current.item)
      const others = current.original.filter((entry) => idOf(entry) !== draggedId)
      others.splice(target, 0, current.item)
      current.order = others
      current.dropIndex = target
      setDragOrder(others)
      setDropIndex(target)
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }

    function onUp() {
      cleanup()
      const current = dragRef.current
      if (!current) return
      if (!current.started || !current.order) {
        // Below the threshold or no valid position: cancel with no writes.
        resetDrag()
        return
      }
      const finalOrder = current.order
      const baseline = current.original
      resetDrag()
      void onCommit(finalOrder, baseline)
    }

    function onCancel() {
      cleanup()
      resetDrag()
    }

    function onKey(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      cleanup()
      resetDrag()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  return { dragId, dragOrder, dropIndex, onHandlePointerDown }
}
