/**
 * offlineSync.js — app-level offline-sync engine (singleton).
 *
 * Root-cause fix for "offline sync not working": the queue drain used to live
 * and die with the scanner page mount (`installDrainListeners` inside
 * `useScannerSession` — now deprecated, see offlineQueue.js). Leaving the
 * scanner tab unmounted the drainer, so queued scans never synced until the
 * operator returned to a scanner page and stayed visible. This module owns
 * ONE drain loop for the whole app: it is installed once at boot (main.jsx),
 * survives page navigation, kicks a drain immediately (mount / enqueue /
 * reconnect — never waits for the first interval tick), and completes the
 * dead Background Sync path (the SW posts SYNC_QUEUED but no client ever
 * listened).
 *
 * Design notes:
 * - The drain itself (`drainQueue`) self-gates: logged out or an empty queue
 *   resolves 0 with zero RPCs, so kicking often is cheap.
 * - Event-driven kicks (online / SYNC_QUEUED / queue-changed) bypass the
 *   visibility gate: a reconnect that lands while the PWA is backgrounded
 *   must not be dropped. The slow poll stays visible-only to save battery.
 * - Retry cadence is deliberate: a failed drain attempt does NOT kick an
 *   immediate retry (that would burn all MAX_DRAIN_ATTEMPTS in seconds and
 *   quarantine rows a transient outage could have cleared). Recovery comes
 *   from the poll, reconnect/foreground events, and genuinely new work.
 * - Count refreshes are coalesced (trailing edge): a 200-row drain fires
 *   hundreds of queue mutations, and each snapshot is getSession() + a full
 *   getAll() + a subscriber render — refreshing per row is an O(n²) storm.
 * - Subscribers (scanner hooks, the global status pill) get `{ queued }`
 *   snapshots; a subscriber must never be able to break sync, so delivery
 *   is exception-proof, and a failed snapshot read emits NOTHING (stale
 *   counts beat a false "clean queue").
 * - `navigator.locks` inside drainQueue keeps concurrent kicks (two tabs,
 *   overlapping events) to a single in-flight drain.
 * - Same-tab only: `window` events do not cross tabs, so a second tab
 *   refreshes via the poll (visible) or its own events — a hidden second
 *   tab can stay stale until foregrounded.
 */
import { drainQueue, getQueuedScans, QUEUE_CHANGED_EVENT } from './offlineQueue'
import { supabase } from './supabase'

export const SYNC_MESSAGE_TYPE = 'SYNC_QUEUED'
const SYNC_TAG = 'sewadar-sync'
// Enqueue-to-drain delay: long enough to coalesce a burst of scans (and let
// the queue write settle), short enough that "Queued offline" becomes
// "syncing" while the operator still watches.
const KICK_DEBOUNCE_MS = 1200
// Snapshot coalescing window (trailing edge) — see the O(n²) note above.
const REFRESH_COALESCE_MS = 400
// Slow safety net for links where `navigator.onLine` lies (jammers,
// captive portals): the online event never fires, so poll while visible.
// Injectable for tests (same pattern as offlineQueue's drain timing).
const DEFAULT_POLL_MS = 15000
function getPollMs() {
  try {
    if (typeof globalThis === 'undefined') return DEFAULT_POLL_MS
    const override = Number(globalThis.__OFFLINESYNC_POLL_MS__)
    return Number.isFinite(override) && override > 0 ? override : DEFAULT_POLL_MS
  } catch {
    return DEFAULT_POLL_MS
  }
}

let installed = false
let teardown = null
let kickTimer = null
let refreshTimer = null
const subscribers = new Set()

// The literal matches QUEUE_CHANGED_EVENT in offlineQueue.js; the fallback
// keeps boot alive if a consumer ever bundles a partial mock of that module
// (addEventListener(undefined) throws — a cryptic crash for a trivial drift).
const QUEUE_EVENT = QUEUE_CHANGED_EVENT || 'portal-queue-changed'

const safeWindow = () => (typeof window !== 'undefined' ? window : null)
const safeDocument = () => (typeof document !== 'undefined' ? document : null)

/**
 * Read the current queue snapshot. Resolves null (never rejects) when the
 * read fails — callers keep last-known-good state instead of flashing a
 * false "clean queue".
 */
async function readSnapshot() {
  try {
    const queued = await getQueuedScans()
    return { queued: Array.isArray(queued) ? queued : [], at: Date.now() }
  } catch {
    return null
  }
}

function emit(snapshot) {
  if (!snapshot) return
  for (const cb of Array.from(subscribers)) {
    try {
      cb(snapshot)
    } catch {
      // A subscriber must never break sync.
    }
  }
}

/** Push a fresh queue snapshot to every subscriber. Never rejects. */
export async function refreshOfflineSync() {
  emit(await readSnapshot())
}

/** Coalesced refresh (trailing edge) for hot paths like per-row progress. */
function refreshSoon() {
  const w = safeWindow()
  if (!w) return
  try {
    if (refreshTimer) return // one trailing refresh already covers this burst
    refreshTimer = w.setTimeout(() => {
      refreshTimer = null
      refreshOfflineSync().catch(() => {})
    }, REFRESH_COALESCE_MS)
  } catch {
    // Timers unavailable — skip the refresh, the next event covers it.
  }
}

async function runDrain() {
  try {
    // Guarded for test rigs that mock offlineQueue without drainQueue, and
    // for logged-out/empty states (drainQueue resolves 0, no RPCs).
    if (typeof drainQueue === 'function') {
      await drainQueue(supabase, () => refreshSoon())
    }
  } catch {
    // Backoff + the next tick own the retry — never throw out of the engine.
  }
  // Background Sync tags are one-shot: re-arm after every drain so the next
  // background window can wake us again.
  try {
    await registerBackgroundSync().catch(() => {})
  } catch {
    // Registration best-effort only.
  }
  await refreshOfflineSync().catch(() => {})
}

/**
 * Ask the engine to drain soon. `delayMs <= 0` is urgent: it pre-empts any
 * armed coalesced kick and fires on the next tick (reconnects must not wait
 * behind a burst). Positive delays debounce (enqueue bursts collapse into
 * one drain). Safe to call from anywhere. Never throws.
 */
export function requestDrain(delayMs = KICK_DEBOUNCE_MS) {
  const w = safeWindow()
  if (!w) return
  try {
    if (kickTimer) {
      w.clearTimeout(kickTimer)
      kickTimer = null
    }
    const delay = Math.max(0, Number(delayMs) || 0)
    kickTimer = w.setTimeout(
      () => {
        kickTimer = null
        runDrain()
      },
      delay,
    )
  } catch {
    // Timers unavailable — skip the kick, the poll covers it.
  }
}

function onOnline() {
  requestDrain(0)
}

/**
 * Session-available kick: call when sign-in (or session restore) completes.
 * A boot drain that reads an empty pre-login queue would otherwise wait for
 * the 15s poll — this closes that hole. Never throws, never awaited.
 */
export function notifySessionAvailable() {
  requestDrain(0)
}

function onVisibility() {
  const d = safeDocument()
  if (d && d.visibilityState === 'visible') requestDrain(0)
}

function onQueueChanged() {
  refreshSoon()
  requestDrain()
}

function onServiceWorkerMessage(e) {
  if (e?.data?.type === SYNC_MESSAGE_TYPE) requestDrain(0)
}

/**
 * Register the Background Sync tag the service worker already handles
 * (`sw.js` posts SYNC_QUEUED on `sewadar-sync`) — previously nothing ever
 * registered it, so the whole path was dead code. Feature-detected:
 * iOS Safari has no `SyncManager`, where the app-level listeners above
 * remain the sync path. Resolves true when registered, false otherwise.
 *
 * Bounded: `serviceWorker.ready` never settles when no worker can ever
 * activate (e.g. a dev server that 404s /sw.js), and this function is
 * awaited inside the drain's Web Lock — an unbounded wait would hold the
 * lock forever and stall every later drain. The 3s race caps that.
 */
export function registerBackgroundSync() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(false)
    const timeout = new Promise((resolve) => {
      try {
        setTimeout(() => resolve(false), 3000)
      } catch {
        resolve(false)
      }
    })
    return Promise.race([
      navigator.serviceWorker.ready.then(
        (reg) => {
          if (!reg?.sync || typeof reg.sync.register !== 'function') return false
          return reg.sync.register(SYNC_TAG).then(() => true).catch(() => false)
        },
        () => false,
      ),
      timeout,
    ])
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Install the app-level engine. Idempotent: the second and later calls are
 * no-ops returning the shared uninstaller. Kicks an immediate drain so
 * rows queued in a previous session (or before this mount) do not wait for
 * the first poll tick. Never throws — a sync engine must not break boot.
 */
export function installOfflineSync() {
  if (installed) return () => uninstallOfflineSync()
  const w = safeWindow()
  const d = safeDocument()
  if (!w) return () => {}
  const attached = []
  try {
    const on = (target, type, fn) => {
      target.addEventListener(type, fn)
      attached.push([target, type, fn])
    }
    on(w, 'online', onOnline)
    if (d) on(d, 'visibilitychange', onVisibility)
    on(w, QUEUE_EVENT, onQueueChanged)
    try {
      if (navigator.serviceWorker?.addEventListener) {
        navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage)
        attached.push([navigator.serviceWorker, 'message', onServiceWorkerMessage])
      }
    } catch {
      // Service workers unavailable — the DOM listeners still sync.
    }
    const pollId = w.setInterval(() => {
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return
        if (d && d.visibilityState !== 'visible') return
        runDrain()
      } catch {
        // Never let the safety net throw.
      }
    }, getPollMs())
    teardown = () => {
      for (const [target, type, fn] of attached.splice(0)) {
        try {
          target.removeEventListener(type, fn)
        } catch {
          // Detach best-effort.
        }
      }
      try {
        w.clearInterval(pollId)
      } catch {
        // Best-effort.
      }
      if (kickTimer) {
        try {
          w.clearTimeout(kickTimer)
        } catch {
          // Best-effort.
        }
        kickTimer = null
      }
      if (refreshTimer) {
        try {
          w.clearTimeout(refreshTimer)
        } catch {
          // Best-effort.
        }
        refreshTimer = null
      }
    }
    installed = true
  } catch {
    // Partial attach must never wedge the flag: detach what landed and stay
    // uninstalled so a later call retries cleanly.
    for (const [target, type, fn] of attached.splice(0)) {
      try {
        target.removeEventListener(type, fn)
      } catch {
        // Best-effort.
      }
    }
    teardown = null
    installed = false
    return () => {}
  }
  // Immediate kick: boot with queued rows must start syncing now (D3).
  runDrain()
  try {
    registerBackgroundSync().catch(() => {})
  } catch {
    // Registration best-effort only.
  }
  return () => uninstallOfflineSync()
}

export function uninstallOfflineSync() {
  try {
    if (teardown) teardown()
  } catch {
    // Uninstall best-effort.
  }
  teardown = null
  installed = false
}

/**
 * Subscribe to `{ queued }` snapshots. Ensures the engine is installed (so a
 * component that mounts before main.jsx's boot still syncs), then pushes an
 * immediate snapshot so the first paint already shows queued counts.
 * Returns an unsubscribe function that removes ONLY this subscriber — the
 * engine itself outlives any single subscriber. That is the fix.
 */
export function subscribeOfflineSync(cb) {
  if (typeof cb === 'function') subscribers.add(cb)
  try {
    installOfflineSync()
  } catch {
    // The engine is best-effort; the snapshot below still serves this caller.
  }
  refreshOfflineSync().catch(() => {})
  return () => {
    subscribers.delete(cb)
  }
}

/** Test-only: reset module state between suites. */
export function __resetOfflineSyncForTests() {
  uninstallOfflineSync()
  subscribers.clear()
  kickTimer = null
  refreshTimer = null
}
