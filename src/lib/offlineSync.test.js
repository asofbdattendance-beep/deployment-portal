// @vitest-environment jsdom
// offlineSync — the app-level drain engine.
//
// Proves the architectural fix directly: the drain loop is installed once at
// boot and fires WITHOUT any page subscriber (the old per-page drainer died
// on unmount), on `online`, on queue mutations, and on the service worker's
// SYNC_QUEUED message (previously posted but never listened for).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const drainQueue = vi.fn()
const getQueuedScans = vi.fn()

vi.mock('./offlineQueue', () => ({
  drainQueue: (...args) => drainQueue(...args),
  getQueuedScans: (...args) => getQueuedScans(...args),
  QUEUE_CHANGED_EVENT: 'portal-queue-changed',
}))

vi.mock('./supabase', () => ({
  supabase: { rpc: vi.fn() },
}))

const {
  installOfflineSync,
  uninstallOfflineSync,
  subscribeOfflineSync,
  refreshOfflineSync,
  requestDrain,
  registerBackgroundSync,
  notifySessionAvailable,
  __resetOfflineSyncForTests,
} = await import('./offlineSync')

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

function mockServiceWorker() {
  const listeners = {}
  const sw = {
    addEventListener: vi.fn((type, cb) => {
      listeners[type] = listeners[type] || []
      listeners[type].push(cb)
    }),
    removeEventListener: vi.fn((type, cb) => {
      listeners[type] = (listeners[type] || []).filter((c) => c !== cb)
    }),
    ready: Promise.resolve({}),
    __listeners: listeners,
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true })
  return sw
}

function unmockServiceWorker() {
  try {
    delete navigator.serviceWorker
  } catch {
    // Already absent.
  }
}

beforeEach(() => {
  __resetOfflineSyncForTests()
  drainQueue.mockReset()
  getQueuedScans.mockReset()
  drainQueue.mockResolvedValue(0)
  getQueuedScans.mockResolvedValue([])
})

afterEach(() => {
  uninstallOfflineSync()
  __resetOfflineSyncForTests()
  unmockServiceWorker()
})

describe('offlineSync engine', () => {
  it('install is idempotent and kicks an immediate drain with zero subscribers', async () => {
    const off1 = installOfflineSync()
    installOfflineSync()
    // The immediate boot kick runs with NO page mounted — this is the fix:
    // rows queued in a previous session start syncing at boot.
    await tick()
    expect(drainQueue).toHaveBeenCalledTimes(1)
    expect(typeof off1).toBe('function')
  })

  it('an online event drains even with no subscriber (D4: backgrounded reconnect is not dropped)', async () => {
    installOfflineSync()
    await tick()
    drainQueue.mockClear()
    window.dispatchEvent(new Event('online'))
    await tick()
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })

  it('uninstall removes the listeners: online after uninstall drains nothing', async () => {
    installOfflineSync()
    await tick()
    uninstallOfflineSync()
    drainQueue.mockClear()
    window.dispatchEvent(new Event('online'))
    await tick(50)
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('a queue-changed event refreshes subscribers and kicks a drain', async () => {
    const seen = []
    subscribeOfflineSync((snap) => seen.push(snap))
    await tick()
    drainQueue.mockClear()
    const base = seen.length
    window.dispatchEvent(new CustomEvent('portal-queue-changed'))
    // Refresh is coalesced (trailing edge) so a drain burst does not post
    // hundreds of full-store reads; the drain follows the kick debounce.
    await tick(600)
    expect(seen.length).toBeGreaterThan(base)
    expect(seen[seen.length - 1]).toMatchObject({ queued: [] })
    await tick(1600)
    expect(drainQueue).toHaveBeenCalled()
  }, 10000)

  it('rapid requestDrain calls coalesce into one drain', async () => {
    installOfflineSync()
    await tick()
    drainQueue.mockClear()
    requestDrain(30)
    requestDrain(30)
    requestDrain(30)
    await tick(120)
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })

  it('SYNC_QUEUED from the service worker triggers a drain; other messages are ignored', async () => {
    const sw = mockServiceWorker()
    installOfflineSync()
    await tick()
    const onMessage = (sw.__listeners.message || [])[0]
    expect(typeof onMessage).toBe('function')
    drainQueue.mockClear()
    onMessage({ data: { type: 'SOMETHING_ELSE' } })
    await tick()
    expect(drainQueue).not.toHaveBeenCalled()
    // The message the SW actually posts on `sewadar-sync` (sw.js) — dead
    // before because no client ever listened.
    onMessage({ data: { type: 'SYNC_QUEUED' } })
    await tick()
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })

  it('registerBackgroundSync resolves false without SyncManager support', async () => {
    // No service worker at all (jsdom default, iOS Safari).
    await expect(registerBackgroundSync()).resolves.toBe(false)
    // Worker present but no Background Sync (ready resolves {}).
    mockServiceWorker()
    await expect(registerBackgroundSync()).resolves.toBe(false)
  })

  it('registerBackgroundSync resolves false when ready never settles (bounded wait)', async () => {
    // A dev server that 404s /sw.js leaves `ready` pending forever; awaiting
    // it unbounded inside the drain lock would stall every later drain.
    const sw = mockServiceWorker()
    sw.ready = new Promise(() => {})
    await expect(registerBackgroundSync()).resolves.toBe(false)
  }, 10000)

  it('registerBackgroundSync resolves true when the tag registers', async () => {
    const sw = mockServiceWorker()
    const register = vi.fn(async () => {})
    sw.ready = Promise.resolve({ sync: { register } })
    await expect(registerBackgroundSync()).resolves.toBe(true)
    expect(register).toHaveBeenCalledWith('sewadar-sync')
  })

  it('registerBackgroundSync resolves false when registration rejects', async () => {
    const sw = mockServiceWorker()
    sw.ready = Promise.resolve({ sync: { register: async () => { throw new Error('denied') } } })
    await expect(registerBackgroundSync()).resolves.toBe(false)
  })

  it('a visible foreground tick polls a drain (jammer safety net)', async () => {
    globalThis.__OFFLINESYNC_POLL_MS__ = 40
    try {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      installOfflineSync()
      await tick()
      drainQueue.mockClear()
      // The boot kick already ran; the poll must fire on its own cadence.
      await tick(200)
      expect(drainQueue).toHaveBeenCalled()
    } finally {
      delete globalThis.__OFFLINESYNC_POLL_MS__
    }
  })

  it('foregrounding the tab kicks a drain', async () => {
    installOfflineSync()
    await tick()
    drainQueue.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })

  it('subscribe delivers an immediate snapshot; unsubscribe stops updates', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: false }])
    const seen = []
    const off = subscribeOfflineSync((snap) => seen.push(snap))
    await tick()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].queued).toHaveLength(1)
    off()
    const frozen = seen.length
    await refreshOfflineSync()
    expect(seen.length).toBe(frozen)
  })

  it('a failing queue read emits nothing and never rejects', async () => {
    // Persistent (not Once): both the subscribe-time snapshot and the
    // explicit refresh below must fail to prove nothing is emitted.
    getQueuedScans.mockRejectedValue(new Error('IDB down'))
    const seen = []
    subscribeOfflineSync((snap) => seen.push(snap))
    // Must not throw, and must not overwrite last-known-good state with a
    // false "clean queue": without the null-skip the pills would flash
    // empty on every transient IDB blip.
    await refreshOfflineSync()
    expect(seen).toEqual([])
  })

  it('a throwing subscriber never breaks delivery to the others', async () => {
    const good = []
    subscribeOfflineSync(() => {
      throw new Error('bad subscriber')
    })
    subscribeOfflineSync((snap) => good.push(snap))
    await refreshOfflineSync()
    expect(good.length).toBeGreaterThan(0)
  })

  it('per-row drain progress reaches subscribers through the coalesced refresh', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-9', synced: false }])
    // The drain reports per-row progress; the engine coalesces it so a
    // 200-row drain does not post 200 full-store reads.
    drainQueue.mockImplementation(async (_client, onProgress) => {
      onProgress({ id: 'q-9' }, true)
      return 1
    })
    const seen = []
    subscribeOfflineSync((snap) => seen.push(snap))
    await tick()
    const progressSnapshots = seen.length
    await requestDrain(0)
    await tick(600)
    expect(seen.length).toBeGreaterThan(progressSnapshots)
    expect(seen[seen.length - 1].queued).toHaveLength(1)
  })

  it('an urgent kick pre-empts an armed coalesced kick', async () => {    installOfflineSync()
    await tick()
    drainQueue.mockClear()
    requestDrain(5000)
    // A reconnect landing mid-burst must drain now, not after the burst.
    requestDrain(0)
    await tick(150)
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })

  it('a completed drain re-arms Background Sync (one-shot tags)', async () => {
    const sw = mockServiceWorker()
    const register = vi.fn(async () => {})
    sw.ready = Promise.resolve({ sync: { register } })
    installOfflineSync()
    await tick(100)
    // Once at install, once after the boot drain completes.
    expect(register.mock.calls.filter(([tag]) => tag === 'sewadar-sync').length).toBeGreaterThanOrEqual(2)
  })

  it('a rejecting drain never throws and still refreshes subscribers', async () => {
    drainQueue.mockRejectedValueOnce(new Error('boom'))
    const seen = []
    subscribeOfflineSync((snap) => seen.push(snap))
    await tick()
    // The boot kick rejected internally; the completion refresh still ran.
    expect(seen.length).toBeGreaterThan(0)
  })

  it('invalid poll overrides fall back to the default cadence', async () => {
    for (const bad of [0, -5, NaN, 'junk']) {
      globalThis.__OFFLINESYNC_POLL_MS__ = bad
      installOfflineSync()
      await tick()
      uninstallOfflineSync()
      __resetOfflineSyncForTests()
    }
    delete globalThis.__OFFLINESYNC_POLL_MS__
    // No throw on any value; the engine installed every time.
    expect(drainQueue).toHaveBeenCalled()
  })

  it('rapid queue mutations coalesce into one refresh, not one per row', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: false }])
    const seen = []
    subscribeOfflineSync((snap) => seen.push(snap))
    await tick()
    const base = seen.length
    // A 200-row drain fires hundreds of mutations; the trailing-edge
    // refresh must collapse them instead of posting a full-store read each.
    window.dispatchEvent(new CustomEvent('portal-queue-changed'))
    window.dispatchEvent(new CustomEvent('portal-queue-changed'))
    window.dispatchEvent(new CustomEvent('portal-queue-changed'))
    await tick(600)
    expect(seen.length - base).toBeLessThanOrEqual(2)
    expect(seen[seen.length - 1].queued).toHaveLength(1)
  })

  it('subscribe without a callback still installs the engine', async () => {
    subscribeOfflineSync()
    await tick()
    expect(drainQueue).toHaveBeenCalled()
  })

  it('notifySessionAvailable kicks an immediate drain (sign-in path)', async () => {
    installOfflineSync()
    await tick()
    drainQueue.mockClear()
    notifySessionAvailable()
    await tick()
    expect(drainQueue).toHaveBeenCalledTimes(1)
  })
})
