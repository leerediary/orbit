'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { balancedColumns } from '@/lib/balanced-columns'

interface BalancedColumnsProps {
  items: Array<{ key: string; node: ReactNode }>
}

/**
 * Lays cards into order-preserving balanced columns (2 or 3) to minimise
 * whitespace. Cards are measured with ResizeObserver, so the layout re-balances
 * automatically when content grows or shrinks (a habit is toggled, a task is
 * added, …). On narrow screens the grid is a single column; the caller lets the
 * lg: breakpoint switch it to the balanced column count.
 *
 * T15: card heights depend on the rendered column width, so a bare cost
 * comparison feeds back into the measurements and can flap between 2 and 3
 * columns indefinitely. Pass the current count with a hysteresis margin so a
 * switch requires a meaningful improvement.
 */
export default function BalancedColumns({ items }: BalancedColumnsProps) {
  const [heights, setHeights] = useState<number[]>(() => items.map(() => 0))
  const [columnCount, setColumnCount] = useState<number | null>(null)
  const cardRefs = useRef<Array<HTMLDivElement | null>>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const next = cardRefs.current.map((el) => (el ? el.offsetHeight : 0))
      setHeights((prev) =>
        prev.length === next.length && prev.every((h, i) => h === next[i]) ? prev : next,
      )
    }
    // T12: cards populate asynchronously, so heights can change in a burst and
    // re-balancing on every tick makes the columns visibly jump mid-load. Debounce
    // so the layout only re-balances once heights have settled.
    const schedule = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(measure, 120)
    }
    const observer = new ResizeObserver(schedule)
    cardRefs.current.forEach((el) => el && observer.observe(el))
    measure()
    return () => {
      observer.disconnect()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // Re-observe only when the card set changes (count of items).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  const ready = heights.length === items.length && heights.every((h) => h > 0)
  const columns = ready
    ? balancedColumns(heights, 3, 2, {
        current: columnCount ?? undefined,
        hysteresis: 0.15,
      })
    : items.map((_, i) => [i])

  // Remember the committed column count so the next measurement compares
  // against it (hysteresis). Only meaningful once real heights exist.
  useEffect(() => {
    if (ready && columns.length !== columnCount) {
      setColumnCount(columns.length)
    }
  }, [ready, columns.length, columnCount])

  const gridClass = columns.length === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'

  return (
    <div className={`grid grid-cols-1 items-start gap-4 ${gridClass}`}>
      {columns.map((col, ci) => (
        <div key={ci} className="flex flex-col" style={{ gap: '16px', minWidth: 0 }}>
          {col.map((idx) => (
            <div
              key={items[idx].key}
              ref={(el) => {
                cardRefs.current[idx] = el
              }}
            >
              {items[idx].node}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
