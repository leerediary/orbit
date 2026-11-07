'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { clampFeedbackPosition, parseFeedbackPosition } from '@/lib/feedback'
import type { FeedbackPosition } from '@/lib/feedback'
import { formatMmss, usePomodoroTimer } from '@/lib/pomodoro-timer'
import { isDesktopElectron } from '@/lib/desktop'

const MINIPOMODORO_POSITION_KEY = 'orbit_minipomodoro_position'
const PIP_CHANNEL = 'orbit-pomodoro-pip'

interface DragState {
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  moved: boolean
}

const PILL_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 12px',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  boxShadow: 'none',
  cursor: 'grab',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}

const TIME_STYLE: CSSProperties = {
  fontSize: '16px',
  fontWeight: 600,
  lineHeight: 1,
  letterSpacing: '-0.01em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--foreground)',
}

const ACTION_STYLE: CSSProperties = {
  minHeight: '32px',
  padding: '0 14px',
  background: 'var(--card)',
  color: 'var(--accent)',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  fontSize: '14px',
  fontWeight: 400,
  lineHeight: 1,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const POPOUT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '32px',
  padding: '0 10px',
  margin: 0,
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

// The always-on-top Picture-in-Picture window is a separate same-origin
// document, so it gets a plain HTML/CSS/JS widget (no React) and speaks to the
// main window over a BroadcastChannel.
const PIP_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: #ffffff; overflow: hidden; }
.pill { display: flex; align-items: center; gap: 10px; height: 100vh; padding: 0 14px; }
#pom-time { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; color: #1d1d1f; }
#pom-action { font-size: 13px; min-height: 30px; padding: 0 14px; border-radius: 9999px; border: 1px solid #d2d2d7; background: #ffffff; color: #0066cc; cursor: pointer; font-family: inherit; }
#pom-action:active { background: #f5f5f7; }
`

const PIP_SCRIPT = `
(function () {
  var time = document.getElementById('pom-time')
  var action = document.getElementById('pom-action')
  var channel = new BroadcastChannel('orbit-pomodoro-pip')

  function fmt(totalSec) {
    var safe = Math.max(0, Math.floor(totalSec))
    var m = String(Math.floor(safe / 60)).padStart(2, '0')
    var s = String(safe % 60).padStart(2, '0')
    return m + ':' + s
  }

  function render(state) {
    if (!state) return
    if (state.phase === 'running' || state.phase === 'break-running') time.textContent = fmt(state.remaining)
    else if (state.phase === 'break-idle') time.textContent = fmt(state.breakSec)
    else if (state.phase === 'summary') time.textContent = '00:00'
    else time.textContent = fmt(state.durationMin * 60)

    if (state.phase === 'idle') { action.textContent = '开始'; action.onclick = function () { send('startFocus') } }
    else if (state.phase === 'running') { action.textContent = '终止'; action.onclick = function () { send('cancelFocus') } }
    else if (state.phase === 'break-idle') { action.textContent = '休息'; action.onclick = function () { send('startBreak') } }
    else if (state.phase === 'break-running') { action.textContent = '跳过'; action.onclick = function () { send('skipBreak') } }
    else { action.textContent = '完成'; action.onclick = null }
  }

  function send(action) { channel.postMessage({ type: 'control', action: action }) }

  channel.onmessage = function (event) { if (event.data && event.data.type === 'state') render(event.data) }
  channel.postMessage({ type: 'ready' })
})()
`

/**
 * Always-on floating pomodoro (feedback 2026-11-01): a draggable pill with an
 * MM:SS readout + a contextual 开始/终止 button, replacing the old 64px circle.
 *
 * In Chrome/Edge the pill has a 置顶 button that opens a Document
 * Picture-in-Picture window floating above every app, mirroring the same readout
 * + button, synced both ways over a BroadcastChannel (state out, control in).
 * A focus session auto-opens the PiP window and auto-closes it when it ends.
 * Other browsers hide the button.
 */
export default function MiniPomodoro() {
  const {
    phase,
    durationMin,
    remaining,
    breakSec,
    startFocus,
    cancelFocus,
    startBreak,
    skipBreak,
  } = usePomodoroTimer()

  // null = default dock bottom-left; an object = freely dragged position.
  const [pos, setPos] = useState<FeedbackPosition | null>(null)
  const [mounted, setMounted] = useState(false)
  const [pipSupported, setPipSupported] = useState(false)
  const [pipOpen, setPipOpen] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const pipWindowRef = useRef<Window | null>(null)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const autoOpenedRef = useRef(false)

  // Latest values for the BroadcastChannel handlers, which run from the
  // mount-only effect closure and must never read stale state.
  const stateRef = useRef({ phase, durationMin, remaining, breakSec })
  stateRef.current = { phase, durationMin, remaining, breakSec }
  const actionsRef = useRef({ startFocus, cancelFocus, startBreak, skipBreak })
  actionsRef.current = { startFocus, cancelFocus, startBreak, skipBreak }

  // Hydrate the dragged position and detect PiP support once (never during
  // render — the static export has no localStorage / documentPictureInPicture).
  useEffect(() => {
    try {
      setPos(parseFeedbackPosition(localStorage.getItem(MINIPOMODORO_POSITION_KEY)))
    } catch {
      // Storage unavailable — keep the default dock.
    }
    setPipSupported(
      typeof window !== 'undefined' && 'documentPictureInPicture' in window,
    )
    setIsElectron(isDesktopElectron())
    setMounted(true)
  }, [])

  // Persist a dragged position once hydration has landed. A null position means
  // "default dock", so there is nothing to write until the user actually drags.
  useEffect(() => {
    if (!mounted || pos === null) return
    try {
      localStorage.setItem(MINIPOMODORO_POSITION_KEY, JSON.stringify(pos))
    } catch {
      // Quota / unavailable storage — the position just won't survive a reload.
    }
  }, [pos, mounted])

  // One BroadcastChannel for the PiP window: state out + control in.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(PIP_CHANNEL)
    channelRef.current = channel
    channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; action?: string } | null
      if (!msg) return
      if (msg.type === 'ready') {
        channel.postMessage({ type: 'state', ...stateRef.current })
      } else if (msg.type === 'control') {
        const actions = actionsRef.current
        if (msg.action === 'startFocus') actions.startFocus()
        else if (msg.action === 'cancelFocus') actions.cancelFocus()
        else if (msg.action === 'startBreak') actions.startBreak()
        else if (msg.action === 'skipBreak') actions.skipBreak()
      }
    }
    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [])

  // Push the latest state whenever the timer changes.
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'state', ...stateRef.current })
  }, [phase, durationMin, remaining, breakSec])

  // Close the PiP window if this component ever unmounts.
  useEffect(() => {
    return () => {
      pipWindowRef.current?.close()
    }
  }, [])

  function gotoPomodoro() {
    window.dispatchEvent(new CustomEvent('orbit:goto-pomodoro'))
  }

  async function openPip(manual: boolean) {
    const api = (
      window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (options: { width: number; height: number }) => Promise<Window>
        }
      }
    ).documentPictureInPicture
    if (!api) return
    try {
      const pipWindow = await api.requestWindow({ width: 224, height: 60 })
      pipWindowRef.current = pipWindow
      setPipOpen(true)
      if (!manual) autoOpenedRef.current = true
      populatePipWindow(pipWindow)
      pipWindow.addEventListener('pagehide', () => {
        pipWindowRef.current = null
        setPipOpen(false)
        autoOpenedRef.current = false
      })
    } catch (error) {
      console.warn('orbit: Picture-in-Picture open failed', error)
      setPipOpen(false)
      autoOpenedRef.current = false
    }
  }

  function closePip() {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
    setPipOpen(false)
    autoOpenedRef.current = false
  }

  function togglePip() {
    if (pipOpen) closePip()
    else void openPip(true)
  }

  // Open the always-on-top window synchronously within the start gesture.
  // requestWindow needs transient activation, which a passive effect has already
  // lost — so startFocus dispatches this event and we open inside the same call
  // stack as the click.
  useEffect(() => {
    const handler = () => {
      if (pipSupported && !pipOpen) void openPip(false)
    }
    window.addEventListener('orbit:pomodoro-start', handler)
    return () => window.removeEventListener('orbit:pomodoro-start', handler)
  }, [pipSupported, pipOpen])

  // Pull the auto-opened window back once the focus session leaves 'running'.
  useEffect(() => {
    if (phase !== 'running' && autoOpenedRef.current) {
      closePip()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  function populatePipWindow(pipWindow: Window) {
    const doc = pipWindow.document
    const style = doc.createElement('style')
    style.textContent = PIP_CSS
    doc.head.appendChild(style)
    // innerHTML does not execute <script>; the widget logic is appended as a
    // real script element so it runs in the PiP document.
    doc.body.innerHTML =
      '<div class="pill"><span id="pom-time">25:00</span><button id="pom-action">开始</button></div>'
    const script = doc.createElement('script')
    script.textContent = PIP_SCRIPT
    doc.body.appendChild(script)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Primary pointer / left button only, so right-clicks and secondary touches
    // never start a drag.
    if (event.button !== 0 || !event.isPrimary) return
    // Buttons are click targets, not drag handles: pressing one must not move
    // the pill (their own onClick handles it).
    if ((event.target as HTMLElement).closest('button')) return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    // 4px threshold separates a tap (navigate) from a drag (move).
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true
    if (!drag.moved) return
    event.preventDefault()
    setPos(
      clampFeedbackPosition(
        { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
        { width: window.innerWidth, height: window.innerHeight },
        { width: drag.width, height: drag.height },
      ),
    )
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released — nothing to do.
    }
    // A tap on the pill body (not a button) jumps to the 番茄钟 tab.
    if (!drag.moved) gotoPomodoro()
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released — nothing to do.
    }
  }

  let timeText: string
  if (phase === 'running' || phase === 'break-running') timeText = formatMmss(remaining)
  else if (phase === 'break-idle') timeText = formatMmss(breakSec)
  else if (phase === 'summary') timeText = '00:00'
  else timeText = formatMmss(durationMin * 60)

  let action: { label: string; run: () => void } | null
  if (phase === 'idle') action = { label: '开始', run: startFocus }
  else if (phase === 'running') action = { label: '终止', run: cancelFocus }
  else if (phase === 'break-idle') action = { label: '休息', run: startBreak }
  else if (phase === 'break-running') action = { label: '跳过', run: skipBreak }
  else action = null

  const positionStyle: CSSProperties =
    pos === null
      ? {
          left: 'max(24px, env(safe-area-inset-left))',
          bottom: 'max(24px, env(safe-area-inset-bottom))',
        }
      : {
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          right: 'auto',
          bottom: 'auto',
        }

  // Inside the Electron shell the always-on-top native floating window replaces
  // this in-page pill, so hide it (the BroadcastChannel sync stays live).
  if (isElectron) return null

  return (
    <div
      role="group"
      aria-label="番茄钟浮窗"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{ ...PILL_STYLE, ...positionStyle }}
    >
      <span aria-hidden="true" style={TIME_STYLE}>
        {timeText}
      </span>
      {action ? (
        <button type="button" onClick={action.run} style={ACTION_STYLE}>
          {action.label}
        </button>
      ) : null}
      {pipSupported ? (
        <button
          type="button"
          aria-label={pipOpen ? '关闭置顶浮窗' : '置顶浮窗'}
          aria-pressed={pipOpen}
          onClick={togglePip}
          style={POPOUT_STYLE}
        >
          {pipOpen ? '收回' : '置顶'}
        </button>
      ) : null}
    </div>
  )
}
