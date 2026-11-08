'use client'

import type { ReactNode } from 'react'

interface PomodoroDialProps {
  /** Outer diameter in px (the SVG viewBox matches it exactly). */
  size: number
  /** Remaining fraction in [0, 1]; clamped defensively. */
  ratio: number
  /** Ring thickness; defaults to 8px for large dials, 4px for small ones. */
  strokeWidth?: number
  /** Centered content, typically the MM:SS readout. */
  children?: ReactNode
  /** Optional className on the outer wrapper (e.g. a one-time celebration). */
  className?: string
}

/**
 * Reusable non-interactive countdown ring (quick task 261101-e27).
 *
 * Two concentric circles share one center: a `var(--border)` track and a
 * `var(--accent)` progress arc driven by `strokeDashoffset`. Used at 220px in
 * the 番茄钟 tab and 64px in the floating mini timer. No shadows, no gradients,
 * no animation library — the depth comes from the layout, not CSS effects.
 */
export default function PomodoroDial({
  size,
  ratio,
  strokeWidth,
  children,
  className,
}: PomodoroDialProps) {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const width = strokeWidth ?? (size >= 160 ? 8 : 4)
  const radius = (size - width) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: `min(${size}px, 100%)`,
        aspectRatio: '1 / 1',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={width}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          transform={`rotate(-90 ${center} ${center})`}
          className="motion-reduce:transition-none"
          style={{ transition: 'stroke-dashoffset 120ms linear' }}
        />
      </svg>
      {children ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          {children}
        </div>
      ) : null}
    </div>
  )
}
