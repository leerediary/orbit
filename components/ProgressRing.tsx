'use client'

interface ProgressRingProps {
  /** Completion fraction; clamped to [0, 1] defensively. */
  ratio: number
}

const RADIUS = 9
// 2πr ≈ 56.55 — the full circumference used for the dash offset.
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * 22×22 non-interactive progress ring (08-UI-SPEC §11). Purely presentational:
 * used as the leading slot for container tasks and quantity leaves so names stay
 * aligned with checkbox rows. State is conveyed to assistive tech by the visible
 * name / quantity meta and ancestor progress bars, so the SVG is aria-hidden.
 *
 * Incomplete: a muted track plus a muted partial arc (the locked spec makes both
 * var(--muted); the meaningful completion signal is the accent fill below).
 * Complete: the ring fills with the accent and shows the same white check as the
 * checkbox — matching the checkbox's "done" signal.
 */
export default function ProgressRing({ ratio }: ProgressRingProps) {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const complete = clamped >= 1

  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      {complete ? (
        <>
          <circle cx="11" cy="11" r={RADIUS} fill="var(--accent)" />
          <polyline
            points="7 11.4 9.8 14.2 15 8.6"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="11"
            cy="11"
            r={RADIUS}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="1.5"
          />
          {clamped > 0 ? (
            <circle
              cx="11"
              cy="11"
              r={RADIUS}
              fill="none"
              stroke="var(--muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - clamped)}
              transform="rotate(-90 11 11)"
              className="motion-reduce:transition-none"
              style={{ transition: 'stroke-dashoffset 120ms ease-out' }}
            />
          ) : null}
        </>
      )}
    </svg>
  )
}
