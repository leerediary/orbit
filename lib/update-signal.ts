/**
 * Module-scoped "a new app version is available" signal. RegisterSW marks it
 * when the service worker's updatefound fires; UpdateBanner subscribes to show
 * the refresh prompt. Module scope (not React state) matters: the async SW
 * update check can resolve long after React has mounted, and a late subscriber
 * must still be able to learn the update already happened — hence the replay
 * in subscribeUpdateAvailable().
 */

let available = false
const subscribers = new Set<() => void>()

export function markUpdateAvailable(): void {
  if (available) return
  available = true
  for (const fn of subscribers) fn()
}

export function isUpdateAvailable(): boolean {
  return available
}

export function subscribeUpdateAvailable(fn: () => void): () => void {
  subscribers.add(fn)
  if (available) fn() // replay if the update fired before this subscriber mounted
  return () => {
    subscribers.delete(fn)
  }
}
