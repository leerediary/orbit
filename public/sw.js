// Hand-written cache-first offline app-shell service worker (classic worker).
// No Serwist — this project is Turbopack, Serwist needs webpack.
// Decision logic lives in the single-source sw-policy.js (vitest-tested).
// Relative importScripts resolves against sw.js's own URL (MDN confirmed).
//
// SW_BUILD must equal public/sw-policy.js CACHE_VERSION on every release. The
// browser's update check byte-compares THIS main script first and bails out if
// unchanged, so a sw-policy.js-only bump would never reach an installed PWA —
// importScripts deps are only re-checked once the main script differs (Chrome
// 78+ / Firefox 56+ / Safari). This literal is what actually pushes a new shell.
//
// Orbit is fully local-first (D-06): there is NO cloud pass-through. The
// cross-origin guard below is retained as a safety net so an accidental
// third-party fetch can never be cache-trapped or failed-close.
const SW_BUILD = 'orbit-v26'
importScripts('sw-policy.js')
const P = self.SWPolicy

// Derive basePath prefix from registration scope (e.g. 'https://host/orbit/').
// new URL(scope).pathname = '/orbit/'; strip trailing slash → '/orbit'
// On root deploy: scope = 'https://host/', pathname = '/', prefix = ''
const _scope = self.registration.scope
const _prefix = new URL(_scope).pathname.replace(/\/$/, '') // '' or '/orbit'
P.configure(_prefix)

const PREFIXED_PRECACHE = P.PRECACHE_URLS.map(function (u) { return _prefix + u })

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(P.CACHE_VERSION)
      await c.addAll(PREFIXED_PRECACHE)
      self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k !== P.CACHE_VERSION) await caches.delete(k)
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  // Cross-origin safety net: network-only pass-through. Never respondWith —
  // let it hit the network normally. Orbit has no cross-origin startup calls,
  // so this should never fire in practice.
  if (P.isBypass(req.url, self.location.origin)) return

  // Content-hashed Next assets: cache-first, populate on first hit.
  if (P.isImmutableAsset(req.url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(P.CACHE_VERSION)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res && res.ok) await cache.put(req, res.clone()).catch(() => {})
        return res
      })()
    )
    return
  }

  // Navigations: cache-first against the mapped shell, then network, then
  // fall back to the precached shell (or '/'); never throw offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(P.CACHE_VERSION)
        const shell = P.shellForPath(new URL(req.url).pathname)
        const cachedShell = await cache.match(shell)
        if (cachedShell) return cachedShell
        try {
          const res = await fetch(req)
          if (res && res.ok) await cache.put(shell, res.clone()).catch(() => {})
          return res
        } catch (e) {
          const fallback = (await cache.match(shell)) || (await cache.match(_prefix + '/'))
          if (fallback) return fallback
          return new Response('', { status: 504, statusText: 'Offline' })
        }
      })()
    )
    return
  }

  // All other same-origin GET: cache-first then network.
  event.respondWith(
    (async () => {
      const cache = await caches.open(P.CACHE_VERSION)
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res && res.ok) {
        try {
          await cache.put(req, res.clone())
        } catch {
          // Cache writes are best-effort — a quota rejection must not break the response.
        }
      }
      return res
    })()
  )
})
