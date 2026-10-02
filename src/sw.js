/* Portal service worker — built by vite-plugin-pwa (injectManifest).
 *
 * CACHING POSTURE (deliberately conservative):
 * - Precached: the built app shell (JS/CSS/index.html) + icons. This is
 *   what lets an installed phone open the portal with no network.
 * - Everything else: NetworkOnly. Supabase Auth, PostgREST, RPCs, storage
 *   and Realtime are NEVER cached (auth/PII must not sit in a cache).
 * - Navigations fall back to cached index.html (SPA) when offline.
 *
 * UPDATE POSTURE: no auto skipWaiting. A new SW waits until the user taps
 * "Reload" in the update prompt (SwUpdatePrompt), which posts
 * { type: 'SKIP_WAITING' }. This never swaps code mid-scan.
 *
 * KILL SWITCH: set SW_KILL = true, deploy, and every client unregisters
 * this SW and wipes its caches on next load. Use if a bad SW ever ships
 * (a bad SW is sticky — this is the escape hatch).
 */
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute, setCatchHandler, setDefaultHandler } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'

const SW_VERSION = 'portal-sw-v1'
const SW_KILL = false

// Old precaches from previous builds are purged on activate.
cleanupOutdatedCaches()

if (SW_KILL) {
  self.addEventListener('install', () => {
    self.skipWaiting()
  })
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        try {
          const names = await caches.keys()
          await Promise.all(names.map((n) => caches.delete(n)))
        } catch { /* ignore */ }
        try {
          await self.registration.unregister()
        } catch { /* ignore */ }
        const clients = await self.clients.matchAll({ type: 'window' })
        clients.forEach((c) => {
          try { c.navigate(c.url) } catch { /* ignore */ }
        })
      })(),
    )
  })
} else {
  // The build injects the precache manifest here.
  precacheAndRoute(self.__WB_MANIFEST)

  // SPA navigations serve cached index.html. Supabase + API hosts can never
  // match a document navigation, but the denylist makes that explicit.
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), {
      denylist: [/^https:\/\/.*\.supabase\.co\//, /^\/rest\//, /^\/auth\//],
    }),
  )

  // Default: network only. No runtime caching of any kind.
  setDefaultHandler(new NetworkOnly())

  // Offline document → cached app shell; anything else → network error.
  setCatchHandler(({ event }) => {
    if (event.request.destination === 'document') {
      return caches.match('index.html').then(
        (r) => r || Promise.resolve(Response.error()),
      )
    }
    return Promise.resolve(Response.error())
  })

  // Background Sync: wake the client so the offline scan queue drains.
  self.addEventListener('sync', (event) => {
    if (event.tag === 'sewadar-sync') {
      event.waitUntil(
        (async () => {
          const clients = await self.clients.matchAll({ type: 'window' })
          clients.forEach((c) => c.postMessage({ type: 'SYNC_QUEUED' }))
        })(),
      )
    }
  })

  // Prompt-driven activation (see SwUpdatePrompt).
  self.addEventListener('message', (event) => {
    if (event && event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting()
    }
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
  })

  console.debug(`[portal] ${SW_VERSION} active`)
}
