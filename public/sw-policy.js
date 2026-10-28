// Single source of truth for the service worker's pure decision logic.
// Dual-target (no build step): the worker loads it via importScripts('/sw-policy.js')
// (attaches to self.SWPolicy); vitest loads it via require() (module.exports).
// Pure functions only — no fetch, no caches, no side effects beyond attaching P.
(function (g) {
  var _prefix = '' // set by configure() before first use; defaults to '' (root deploy)

  var P = {
    // Bump on ANY sw.js / asset-policy change — activate sweeps every
    // non-current cache. This is the ONLY stale-shell defense (headers()
    // unsupported under output:'export'). MUST equal sw.js SW_BUILD.
    CACHE_VERSION: 'orbit-v26',

    // Called by sw.js immediately after importScripts to inject basePath.
    configure: function (prefix) {
      _prefix = (prefix || '').replace(/\/$/, '') // strip trailing slash
    },

    // Clean route URLs (NOT *.html) — that is what the browser requests for a
    // navigation and what the SW scope serves. Orbit Phase 1 has one route.
    // Bare paths (no prefix). sw.js prepends _prefix when calling addAll().
    PRECACHE_URLS: [
      '/',
      '/manifest.webmanifest',
      '/icon-192.png',
      '/icon-512.png',
      '/apple-touch-icon.png',
    ],

    // Cross-origin = network-only pass-through. Orbit has no cloud calls, but
    // retaining this guard prevents any accidental third-party request from
    // being cached or failed-close by the SW.
    isBypass: function (urlString, selfOrigin) {
      try {
        return new URL(urlString).origin !== selfOrigin
      } catch (e) {
        return true // unparseable → don't intercept
      }
    },

    // Content-hashed Next assets → safe to cache-first forever (old hashes
    // purged by the activate version sweep). Caller has already excluded
    // cross-origin via isBypass.
    // Prefix-aware: under /orbit, immutable assets are /orbit/_next/static/
    isImmutableAsset: function (urlString) {
      try {
        return new URL(urlString).pathname.indexOf(_prefix + '/_next/static/') === 0
      } catch (e) {
        return false
      }
    },

    // Map a navigation pathname to its precached shell. Caller passes a
    // pathname only. Orbit Phase 1 has a single shell: every path → '/'.
    // Prefix-aware: strip _prefix, match, then restore _prefix in the return.
    shellForPath: function (pathname) {
      var rel = _prefix ? (pathname.slice(_prefix.length) || '/') : pathname
      var shell
      if (rel === '/') shell = '/'
      else shell = '/'
      return _prefix + shell
    },
  }

  g.SWPolicy = P
  if (typeof module !== 'undefined' && module.exports) module.exports = P
})(typeof self !== 'undefined' ? self : globalThis)
