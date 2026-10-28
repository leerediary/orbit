/**
 * Install-gating helpers for the "安装到主屏幕" guidance (D-05 / D-06).
 *
 * Invariant: the guidance is iOS-only and hidden once the app is already
 * running standalone. Android/desktop install prompts are out of scope (D-05),
 * so non-iOS clients hide regardless of their install state.
 *
 * PURITY: every browser signal is read by the CALLER inside a mount effect
 * (see `components/RegisterSW.tsx` for the effect-only precedent — the static
 * export prerenders in Node, where browser globals do not exist). This module
 * only transforms an explicit signal object, so it is testable in Node without
 * a DOM and has no side effects.
 */

export interface InstallSignals {
  userAgent: string
  platform: string
  maxTouchPoints: number
  standalone: boolean | undefined
  displayModeStandalone: boolean
}

/**
 * True only for an iOS client that is not already installed standalone.
 *
 * iPadOS 13+ requests desktop sites by default: its UA says "Macintosh" and
 * its reported platform is "MacIntel", so touch support (`maxTouchPoints > 1`)
 * is the only reliable discriminator from a real Mac (which reports 0).
 */
export function shouldShowInstallGuide(s: InstallSignals): boolean {
  const isIOS =
    /iPad|iPhone|iPod/.test(s.userAgent) ||
    (s.platform === 'MacIntel' && s.maxTouchPoints > 1)
  const isStandalone = s.standalone === true || s.displayModeStandalone
  return isIOS && !isStandalone
}
