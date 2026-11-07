/**
 * Electron desktop bridge helpers. The main window's preload exposes
 * `window.orbitDesktop`; these read it defensively so the static export (which
 * has no preload) stays safe.
 */
interface OrbitDesktopBridge {
  isElectron?: boolean
  showFloating?: () => void
}

function bridge(): OrbitDesktopBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { orbitDesktop?: OrbitDesktopBridge }).orbitDesktop ?? null
}

/** True only inside the Electron desktop shell. */
export function isDesktopElectron(): boolean {
  return bridge()?.isElectron === true
}

/** Ask the Electron main process to (re)open the always-on-top floating window. */
export function showFloatingWindow(): void {
  bridge()?.showFloating?.()
}
