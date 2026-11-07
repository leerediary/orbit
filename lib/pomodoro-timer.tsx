'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { MODE_RANGES, earlyFinishDurationSec, remainingSec } from '@/lib/pomodoro'

/**
 * Quick task 261101-e27 — one global pomodoro timer.
 *
 * Before this module the five-phase timer state machine lived inside
 * PomodoroView, so switching sections unmounted the view and destroyed any
 * running session. The provider is mounted once in the root layout (above the
 * section switcher), so the countdown survives tab changes while the dial and
 * the mini floating timer both read the same state.
 *
 * SSR contract: the first render is ALWAYS the 25-minute 番茄 idle state.
 * localStorage / matchMedia / AudioContext / Notification are only touched in
 * effects or event handlers, so the static export stays prerenderable.
 */

export type PomodoroPhase = 'idle' | 'running' | 'summary' | 'break-idle' | 'break-running'
export type PomodoroModeKey = 'tomato' | 'cherry'

/** A frozen session identity for the summary sheet (id + start + duration). */
export interface PomodoroSummarySeed {
  id: string
  startedAt: string
  durationSec: number
}

export const DURATION_KEYS: Record<PomodoroModeKey, string> = {
  tomato: 'orbit_pomodoro_duration_min',
  cherry: 'orbit_pomodoro_cherry_duration_min',
}
export const BREAK_KEY = 'orbit_pomodoro_break_duration_sec'
export const DEFAULT_BREAK_SEC = 5 * 60
export const MIN_BREAK_SEC = 60
export const MAX_BREAK_SEC = 60 * 60

/** MM:SS, always two digits on each side (tabular-nums keeps the width fixed). */
export function formatMmss(totalSec: number): string {
  const safe = Math.max(0, totalSec)
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (safe % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

/** Step the break length by whole minutes, clamped to [1, 60] and returned in seconds. */
export function clampBreakSec(currentSec: number, deltaMinutes: number): number {
  const currentMinutes = Math.round(currentSec / 60)
  const nextMinutes = Math.max(1, Math.min(60, currentMinutes + deltaMinutes))
  return nextMinutes * 60
}

// ── localStorage readers (only ever called from effects/handlers) ──
function readStoredDuration(mode: PomodoroModeKey): number {
  const range = MODE_RANGES[mode]
  try {
    const raw = localStorage.getItem(DURATION_KEYS[mode])
    const value = raw === null ? NaN : Number.parseInt(raw, 10)
    if (Number.isInteger(value) && value >= range.min && value <= range.max) {
      return value
    }
  } catch {
    // localStorage unavailable — fall through to the mode default.
  }
  return range.default
}

function readStoredBreakSec(): number {
  try {
    const raw = localStorage.getItem(BREAK_KEY)
    const value = raw === null ? NaN : Number.parseInt(raw, 10)
    if (Number.isInteger(value) && value >= MIN_BREAK_SEC && value <= MAX_BREAK_SEC) {
      return value
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return DEFAULT_BREAK_SEC
}

function persistDuration(mode: PomodoroModeKey, minutes: number) {
  try {
    localStorage.setItem(DURATION_KEYS[mode], String(minutes))
  } catch {
    // ignore storage failures
  }
}

export interface PomodoroTimerValue {
  phase: PomodoroPhase
  mode: PomodoroModeKey
  durationMin: number
  remaining: number
  /** Total seconds of the current session (focus snapshot or break length). */
  totalSec: number
  breakSec: number
  announcement: string
  summarySession: PomodoroSummarySeed | null
  startFocus: () => void
  earlyFinish: () => void
  cancelFocus: () => void
  startBreak: () => void
  skipBreak: () => void
  enterBreakIdle: () => void
  switchMode: (next: PomodoroModeKey) => void
  changeDuration: (next: number) => void
  changeBreakMinutes: (delta: number) => void
}

const PomodoroTimerContext = createContext<PomodoroTimerValue | null>(null)

export function PomodoroTimerProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<PomodoroPhase>('idle')
  const [mode, setMode] = useState<PomodoroModeKey>('tomato')
  const [durationMin, setDurationMin] = useState<number>(MODE_RANGES.tomato.default)
  const [remaining, setRemaining] = useState<number>(MODE_RANGES.tomato.default * 60)
  const [totalSec, setTotalSec] = useState<number>(MODE_RANGES.tomato.default * 60)
  const [breakSec, setBreakSec] = useState<number>(DEFAULT_BREAK_SEC)
  const [announcement, setAnnouncement] = useState('')
  const [summarySession, setSummarySession] = useState<PomodoroSummarySeed | null>(null)

  // Per-mode remembered duration, validated once on mount.
  const storedDurationRef = useRef<Record<PomodoroModeKey, number>>({
    tomato: MODE_RANGES.tomato.default,
    cherry: MODE_RANGES.cherry.default,
  })
  // Snapshot of the duration at 开始 press time; the tick reads this, never live
  // duration state (the session must not change if the stepper is nudged later).
  const runningDurationSecRef = useRef<number>(MODE_RANGES.tomato.default * 60)
  const breakDurationSecRef = useRef<number>(DEFAULT_BREAK_SEC)
  // Mirrors the live duration for handlers that run from a stale closure.
  const durationMinRef = useRef<number>(MODE_RANGES.tomato.default)
  const startedAtRef = useRef<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const announcedMinuteRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)

  // ── Mount-only preference read (never during render) ──
  useEffect(() => {
    const tomatoDuration = readStoredDuration('tomato')
    const cherryDuration = readStoredDuration('cherry')
    storedDurationRef.current = { tomato: tomatoDuration, cherry: cherryDuration }
    setDurationMin(tomatoDuration)
    setRemaining(tomatoDuration * 60)
    setTotalSec(tomatoDuration * 60)
    runningDurationSecRef.current = tomatoDuration * 60
    durationMinRef.current = tomatoDuration
    setBreakSec(readStoredBreakSec())

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [])

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // ── Audio + notification (created inside user gestures / tick handlers) ──
  const ensureAudio = useCallback(() => {
    try {
      if (typeof window === 'undefined') return
      if (audioCtxRef.current === null) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (Ctor) audioCtxRef.current = new Ctor()
      }
      const ctx = audioCtxRef.current
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume().catch(() => {})
      }
    } catch {
      // Autoplay restrictions / missing support — the timer keeps running.
    }
  }, [])

  const playChime = useCallback(() => {
    try {
      const ctx = audioCtxRef.current
      if (!ctx) return
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      // Short 0.18s envelope: silent → audible → silent.
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.2)
    } catch {
      // Best-effort chime — a failure must not affect the state machine.
    }
  }, [])

  const requestNotifyPermission = useCallback(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => {})
      }
    } catch {
      // Permission API unavailable — degrade to the audio chime.
    }
  }, [])

  const notify = useCallback(
    (kind: 'focus' | 'break') => {
      playChime()
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(kind === 'focus' ? '专注结束' : '休息结束', {
            body:
              kind === 'focus'
                ? '完成一个番茄，休息一下吧。'
                : '休息结束，开始下一个番茄吧。',
            tag: 'orbit-pomodoro',
            // Never double up with the self-synthesized chime.
            silent: true,
          })
        }
      } catch {
        // Notification constructor can throw on unsupported platforms.
      }
    },
    [playChime],
  )

  /** Break end / skip: clear the links state and return to idle with the
   *  persisted focus duration — never the hardcoded default. */
  const endBreak = useCallback(
    (shouldNotify: boolean) => {
      clearTimer()
      startedAtRef.current = null
      setSummarySession(null)
      setAnnouncement('')
      const focusSec = durationMinRef.current * 60
      setRemaining(focusSec)
      setTotalSec(focusSec)
      setPhase('idle')
      if (shouldNotify) notify('break')
    },
    [clearTimer, notify],
  )

  const focusTick = useCallback(() => {
    const startedAt = startedAtRef.current
    if (startedAt === null) return
    // Recompute from the wall clock every tick (no accumulation), so a throttled
    // background interval cannot leave a stale value.
    const next = remainingSec(startedAt, runningDurationSecRef.current, Date.now())
    setRemaining(next)
    if (!announcedMinuteRef.current && next > 0 && next <= 60) {
      announcedMinuteRef.current = true
      setAnnouncement('还剩 1 分钟')
    }
    if (next === 0) {
      clearTimer()
      startedAtRef.current = null
      const durationSec = runningDurationSecRef.current
      // Fresh id + frozen start for THIS summary entry. Natural completion
      // derives the start from the duration snapshot taken at 开始.
      setSummarySession({
        id: crypto.randomUUID(),
        startedAt: new Date(Date.now() - durationSec * 1000).toISOString(),
        durationSec,
      })
      setAnnouncement('')
      setPhase('summary')
      notify('focus')
    }
  }, [clearTimer, notify])

  const breakTick = useCallback(() => {
    const startedAt = startedAtRef.current
    if (startedAt === null) return
    const next = remainingSec(startedAt, breakDurationSecRef.current, Date.now())
    setRemaining(next)
    if (next === 0) endBreak(true)
  }, [endBreak])

  function startFocus() {
    // Snapshot the duration NOW; the tick never reads live duration state.
    const snapshot = durationMin * 60
    runningDurationSecRef.current = snapshot
    startedAtRef.current = Date.now()
    announcedMinuteRef.current = false
    // Both browser APIs must be primed inside this user gesture.
    ensureAudio()
    requestNotifyPermission()
    setSummarySession(null)
    setAnnouncement('')
    setTotalSec(snapshot)
    setRemaining(snapshot)
    setPhase('running')
    clearTimer()
    intervalRef.current = setInterval(focusTick, 500)
    // Synchronously notify the floating pill so it can open the always-on-top
    // Picture-in-Picture window within this same user gesture (requestWindow
    // requires transient activation, which a passive effect has already lost).
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('orbit:pomodoro-start'))
    }
  }

  /** Early finish records the actual elapsed time rounded to whole minutes
   *  (minimum one), then jumps to the summary seam. User-initiated → no chime. */
  function earlyFinish() {
    const startedAt = startedAtRef.current
    if (startedAt === null) return
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000)
    const durationSec = earlyFinishDurationSec(elapsedSec)
    clearTimer()
    startedAtRef.current = null
    setSummarySession({
      id: crypto.randomUUID(),
      startedAt: new Date(startedAt).toISOString(),
      durationSec,
    })
    setRemaining(0)
    setAnnouncement('')
    setPhase('summary')
  }

  /** Discard the running focus without recording a session, and return to
   *  idle. User-initiated → no chime/notification. */
  function cancelFocus() {
    endBreak(false)
  }

  function startBreak() {
    breakDurationSecRef.current = breakSec
    startedAtRef.current = Date.now()
    setTotalSec(breakSec)
    setRemaining(breakSec)
    setPhase('break-running')
    clearTimer()
    intervalRef.current = setInterval(breakTick, 500)
  }

  function skipBreak() {
    endBreak(false)
  }

  function enterBreakIdle() {
    clearTimer()
    startedAtRef.current = null
    setSummarySession(null)
    setAnnouncement('')
    setRemaining(breakSec)
    setTotalSec(breakSec)
    setPhase('break-idle')
  }

  function switchMode(next: PomodoroModeKey) {
    if (phase !== 'idle' || next === mode) return
    const nextDuration = storedDurationRef.current[next]
    setMode(next)
    setDurationMin(nextDuration)
    setRemaining(nextDuration * 60)
    setTotalSec(nextDuration * 60)
    runningDurationSecRef.current = nextDuration * 60
    durationMinRef.current = nextDuration
    persistDuration(next, nextDuration)
  }

  function changeDuration(next: number) {
    if (phase !== 'idle') return
    const range = MODE_RANGES[mode]
    const clamped = Math.max(range.min, Math.min(range.max, next))
    if (clamped === durationMin) return
    setDurationMin(clamped)
    setRemaining(clamped * 60)
    setTotalSec(clamped * 60)
    runningDurationSecRef.current = clamped * 60
    durationMinRef.current = clamped
    storedDurationRef.current = { ...storedDurationRef.current, [mode]: clamped }
    persistDuration(mode, clamped)
  }

  function changeBreakMinutes(delta: number) {
    if (phase !== 'break-idle') return
    const nextSec = clampBreakSec(breakSec, delta)
    if (nextSec === breakSec) return
    setBreakSec(nextSec)
    setRemaining(nextSec)
    setTotalSec(nextSec)
    try {
      localStorage.setItem(BREAK_KEY, String(nextSec))
    } catch {
      // ignore storage failures
    }
  }

  // ── Background recomputation on tab return ──
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (phase === 'running') focusTick()
      else if (phase === 'break-running') breakTick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [phase, focusTick, breakTick])

  const value: PomodoroTimerValue = {
    phase,
    mode,
    durationMin,
    remaining,
    totalSec,
    breakSec,
    announcement,
    summarySession,
    startFocus,
    earlyFinish,
    cancelFocus,
    startBreak,
    skipBreak,
    enterBreakIdle,
    switchMode,
    changeDuration,
    changeBreakMinutes,
  }

  return <PomodoroTimerContext.Provider value={value}>{children}</PomodoroTimerContext.Provider>
}

export function usePomodoroTimer(): PomodoroTimerValue {
  const context = useContext(PomodoroTimerContext)
  if (context === null) {
    throw new Error('usePomodoroTimer must be used within PomodoroTimerProvider')
  }
  return context
}
