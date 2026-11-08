import { describe, expect, it } from 'vitest'
import { shouldShowInstallGuide } from '@/lib/pwa-install'
import type { InstallSignals } from '@/lib/pwa-install'

/**
 * Pure install-gating contract (D-05 / D-06).
 *
 *  - Show the "安装到主屏幕" guidance only for iOS clients that are NOT already
 *    running standalone.
 *  - iPadOS reports itself as MacIntel with a touch screen, so MacIntel +
 *    maxTouchPoints > 1 counts as iOS; a real Mac has maxTouchPoints === 0.
 *  - Non-iOS clients hide regardless of install state (Android install prompts
 *    are out of scope, D-05).
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPAD_AS_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

function signals(overrides: Partial<InstallSignals> = {}): InstallSignals {
  return {
    userAgent: IPHONE_UA,
    platform: 'iPhone',
    maxTouchPoints: 5,
    standalone: undefined,
    displayModeStandalone: false,
    ...overrides,
  }
}

describe('shouldShowInstallGuide', () => {
  it('shows the guide for iPhone Safari not already standalone', () => {
    expect(shouldShowInstallGuide(signals())).toBe(true)
  })

  it('treats iPadOS (MacIntel + touch) as iOS', () => {
    expect(
      shouldShowInstallGuide(
        signals({ userAgent: IPAD_AS_MAC_UA, platform: 'MacIntel', maxTouchPoints: 5 }),
      ),
    ).toBe(true)
  })

  it('hides the guide on a real Mac desktop (MacIntel, no touch)', () => {
    expect(
      shouldShowInstallGuide(
        signals({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 0 }),
      ),
    ).toBe(false)
  })

  it('hides the guide on Android', () => {
    expect(
      shouldShowInstallGuide(
        signals({ userAgent: ANDROID_UA, platform: 'Linux armv8l', maxTouchPoints: 5 }),
      ),
    ).toBe(false)
  })

  it('hides the guide when the userAgent is empty', () => {
    expect(shouldShowInstallGuide(signals({ userAgent: '' }))).toBe(false)
  })

  it('hides the guide on iOS when navigator.standalone is true', () => {
    expect(shouldShowInstallGuide(signals({ standalone: true }))).toBe(false)
  })

  it('hides the guide on iOS when display-mode is standalone', () => {
    expect(shouldShowInstallGuide(signals({ displayModeStandalone: true }))).toBe(false)
  })

  it('hides the guide on non-iOS regardless of install state (D-05)', () => {
    expect(
      shouldShowInstallGuide(
        signals({
          userAgent: ANDROID_UA,
          platform: 'Linux armv8l',
          maxTouchPoints: 5,
          standalone: true,
        }),
      ),
    ).toBe(false)
  })
})
