// @vitest-environment jsdom
// Offline queue against a real (fake) IndexedDB.
//
// The security-relevant behaviour here is the OWNER TAGGING (decision D1a):
// a shared device must never sync one user's queued scans under another
// user's login, so getQueuedScans must hide other users' rows and the
// drain must skip null-owner rows. Those are asserted explicitly below.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Which user the mock believes is signed in. `null` = logged out.
let currentUserId = 'user-A'

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: currentUserId ? { user: { id: currentUserId } } : null },
      }),
    },
  },
}))

const { enqueueScan, getQueuedScans, removeQueued, markFailed, clearFailedQueue, clearLiveQueue, clearOrphanedQueue, drainQueue, classifyScanError, isNetworkNotReached, isStrandedRow, listStrandedQueue, getDrainTiming, __resetDrainState, __getConsecutiveFailures, cacheSet, getCachedDeployed, preloadDeployed, installDrainListeners } = await import('./offlineQueue')

/** Read EVERY row in the store, bypassing the owner filter — test-only helper. */
function allRows() {
  return import('./offlineQueue').then(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open('sewadar_offline_q', 2)
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('scan_queue')) { db.close(); return resolve([]) }
        const all = db.transaction('scan_queue', 'readonly').objectStore('scan_queue').getAll()
        all.onsuccess = () => { const rows = all.result || []; db.close(); resolve(rows) }
        all.onerror = () => { db.close(); resolve([]) }
      }
      req.onerror = () => resolve([])
    })
  })
}

/** Put a row straight into the store with explicit fields (incl. owner). */
function putRaw(row) {
  return new Promise((resolve) => {
    const req = indexedDB.open('sewadar_offline_q', 2)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('scan_queue')) {
        db.close(); return resolve(false)
      }
      const tx = db.transaction('scan_queue', 'readwrite')
      tx.objectStore('scan_queue').put(row)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    }
    req.onerror = () => resolve(false)
  })
}

beforeEach(async () => {
  currentUserId = 'user-A'
  // Warm the schema through the module FIRST: a raw indexedDB.open() on a
  // missing DB creates an empty v2 with NO stores (onupgradeneeded never
  // fires), which makes every later transaction throw NotFoundError.
  // The warm result is ignored — a leftover-full queue reports 'full' here
  // and the clear below makes room before the asserted init.
  await enqueueScan({ id: '__warm__', badge: 'FB5971GA0000', schedule_id: 's', action: 'IN' })
  // Clear SECOND: cap-filling tests leave 2000 rows behind, and the init below
  // would hit 'full' if it ran before the clear (A1 contract).
  for (const r of await allRows()) await removeQueued(r.id)
  // Initialise the schema through the module's own safeOpenDB path first, so
  // the `scan_queue` object store actually exists before any raw access.
  // Asserted: a silently-failed init would make every later test vacuous.
  expect((await enqueueScan({ id: '__init__', badge: 'FB5971GA0000', schedule_id: 's', action: 'IN' })).ok).toBe(true)
  for (const r of await allRows()) await removeQueued(r.id)
})

describe('enqueueScan', () => {
  it('stores a scan and tags it with the signed-in user', async () => {
    const res = await enqueueScan({ badge: 'FB5971GA0001', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T09:00:00Z' })
    expect(res).toEqual({ ok: true, id: expect.any(String) })
    const rows = await getQueuedScans()
    expect(rows).toHaveLength(1)
    expect(rows[0].badge).toBe('FB5971GA0001')
    expect(rows[0].owner).toBe('user-A')
  })

  it('honours a caller-supplied id (the offline nonce used for idempotency)', async () => {
    const res = await enqueueScan({ id: 'nonce-123', badge: 'VS001', schedule_id: 'sched-1', action: 'IN' })
    expect(res).toEqual({ ok: true, id: 'nonce-123' })
    expect((await getQueuedScans())[0].id).toBe('nonce-123')
  })

  it('stores a null owner when no session resolves (logged out)', async () => {
    currentUserId = null
    await enqueueScan({ badge: 'FB5971GA0002', schedule_id: 'sched-1', action: 'IN' })
    const rows = await allRows()
    expect(rows[0].owner).toBeNull()
  })
})

/** Insert N rows in ONE transaction — 200 single-row opens is needlessly slow. */
function putMany(rows) {
  return new Promise((resolve) => {
    const req = indexedDB.open('sewadar_offline_q', 2)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('scan_queue')) { db.close(); return resolve(false) }
      const tx = db.transaction('scan_queue', 'readwrite')
      const store = tx.objectStore('scan_queue')
      for (const r of rows) store.put(r)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
    }
    req.onerror = () => resolve(false)
  })
}

/** A live, owned, non-failed queue row. */
const liveRow = (i, extra = {}) => ({
  id: `fill-${i}`, badge: `VS${String(i).padStart(4, '0')}`, schedule_id: 's',
  action: 'IN', createdAt: 1, attempts: 0, synced: false, owner: 'user-A', ...extra,
})

describe('enqueueScan result contract (Task A1: L-01 / L-02)', () => {
  const CAP = 2000 // MAX_QUEUE_SIZE — module-private, mirrored deliberately.

  it('never rejects: resolves a result object on the happy path', async () => {
    await expect(
      enqueueScan({ badge: 'VS7200', schedule_id: 's', action: 'IN' })
    ).resolves.toEqual({ ok: true, id: expect.any(String) })
  })

  it('resolves { ok:false, reason:"unavailable" } when IndexedDB is missing', async () => {
    // The top-level module instance is memoised with a live connection, so the
    // unavailable path needs a fresh import. safeOpenDB reads window.indexedDB
    // (=== globalThis under jsdom) and resolves null.
    vi.resetModules()
    vi.stubGlobal('indexedDB', undefined)
    try {
      const fresh = await import('./offlineQueue')
      await expect(
        fresh.enqueueScan({ badge: 'VS0100', schedule_id: 's', action: 'IN' })
      ).resolves.toEqual({ ok: false, reason: 'unavailable' })
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('resolves { ok:false, reason:"full" } at the live-row cap, and writes nothing', async () => {
    await putMany(Array.from({ length: CAP }, (_, i) => liveRow(i)))
    const res = await enqueueScan({ id: 'overflow', badge: 'VS9999', schedule_id: 's', action: 'IN' })
    expect(res).toEqual({ ok: false, reason: 'full' })
    expect((await allRows()).map(r => r.id)).not.toContain('overflow')
  })

  it('counts only LIVE rows — terminally failed rows do not fill the cap (D1b)', async () => {
    await putMany([
      ...Array.from({ length: CAP - 1 }, (_, i) => liveRow(i)),
      ...Array.from({ length: 50 }, (_, i) => liveRow(`dead-${i}`, { failed: true, status: 'failed' })),
    ])
    const res = await enqueueScan({ id: 'survivor', badge: 'VS8888', schedule_id: 's', action: 'IN' })
    expect(res.ok).toBe(true)
    expect((await allRows()).map(r => r.id)).toContain('survivor')
  })

  it('resolves write-failed (never rejects) when the write transaction errors', async () => {
    const orig = IDBDatabase.prototype.transaction
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (stores, mode) {
      if (mode === 'readwrite' && stores === 'scan_queue') {
        const fake = { error: new Error('quota exceeded'), objectStore: () => ({ put: () => {} }) }
        // Only onerror fires — oncomplete/onabort stay plain no-op props, so
        // only the error path can settle the promise.
        Object.defineProperty(fake, 'onerror', { set: (f) => { setTimeout(() => f({ target: fake }), 0) } })
        return fake
      }
      return orig.call(this, stores, mode) // readiness read still real
    })
    try {
      await expect(
        enqueueScan({ badge: 'VS7300', schedule_id: 's', action: 'IN' })
      ).resolves.toMatchObject({ ok: false, reason: 'write-failed' })
    } finally { spy.mockRestore() }
  })

  it('resolves write-failed (never rejects) when the put throws synchronously', async () => {
    // A non-cloneable field makes the structured clone fail inside the
    // transaction. Passes whether the impl throws at put() or errors the request.
    const res = await enqueueScan({ badge: 'VS7000', schedule_id: 's', action: 'IN', nope: () => {} })
    expect(res).toMatchObject({ ok: false, reason: 'write-failed' })
    expect(await allRows()).toHaveLength(0)
  })

  it('resolves write-failed (never rejects) when the readiness read itself errors', async () => {
    const orig = IDBDatabase.prototype.transaction
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (stores, mode) {
      if (mode === 'readonly' && stores === 'scan_queue') {
        const req = { error: new Error('read failed') }
        Object.defineProperty(req, 'onerror', { set: (f) => { setTimeout(() => f({ target: req }), 0) } })
        return { objectStore: () => ({ getAll: () => req }) }
      }
      return orig.call(this, stores, mode)
    })
    try {
      const res = await enqueueScan({ badge: 'VS7100', schedule_id: 's', action: 'IN' })
      expect(res).toMatchObject({ ok: false, reason: 'write-failed' })
      expect(res.error).toBeTruthy()
    } finally { spy.mockRestore() }
  })
})

describe('owner scoping (D1a — shared-device safety)', () => {
  it('hides another user\'s queued rows', async () => {
    await putRaw({ id: 'mine', badge: 'VS001', schedule_id: 's', action: 'IN', owner: 'user-A' })
    await putRaw({ id: 'theirs', badge: 'VS002', schedule_id: 's', action: 'IN', owner: 'user-B' })
    const visible = await getQueuedScans()
    expect(visible.map((r) => r.id)).toEqual(['mine'])
  })

  it('shows null-owner rows ONLY while logged out', async () => {
    await putRaw({ id: 'anon', badge: 'VS003', schedule_id: 's', action: 'IN', owner: null })
    // logged in as user-A → the anonymous row is not theirs
    expect(await getQueuedScans()).toHaveLength(0)
    currentUserId = null
    const loggedOut = await getQueuedScans()
    expect(loggedOut.map((r) => r.id)).toEqual(['anon'])
  })

  it('removeQueued can delete another user\'s row only by explicit id (never by listing)', async () => {
    await putRaw({ id: 'theirs', badge: 'VS002', schedule_id: 's', action: 'IN', owner: 'user-B' })
    expect(await getQueuedScans()).toHaveLength(0)
    await removeQueued('theirs')
    expect(await allRows()).toHaveLength(0)
  })
})

describe('markFailed', () => {
  it('increments attempts and only fails terminally at the cap', async () => {
    await enqueueScan({ id: 'x', badge: 'VS001', schedule_id: 's', action: 'IN' })
    for (let i = 1; i < 12; i++) {
      await markFailed('x')
      const r = (await allRows())[0]
      expect(r.attempts).toBe(i)
      expect(r.failed).toBeFalsy()
      expect(r.status).toBeUndefined()
    }
    await markFailed('x') // 12th attempt → terminal
    const r = (await allRows())[0]
    expect(r.attempts).toBe(12)
    expect(r.failed).toBe(true)
    expect(r.status).toBe('failed')
  })

  it('is a no-op for an unknown id', async () => {
    await expect(markFailed('nope')).resolves.toBeUndefined()
  })
})

describe('orphan sweep (A3 / L-03)', () => {
  const orphan = (i) => ({ id: `orphan-${i}`, badge: `VS${String(i).padStart(4, '0')}`, schedule_id: 's', action: 'IN', createdAt: 1, attempts: 0, synced: false, owner: null })

  it('null-owner orphans do not consume the logged-in cap (no wedge)', async () => {
    await putMany(Array.from({ length: 2000 }, (_, i) => orphan(i)))
    const res = await enqueueScan({ id: 'after-orphans', badge: 'VS9999', schedule_id: 's', action: 'IN' })
    expect(res.ok).toBe(true)
  })

  it('logged-out queueing is still capped at 2000 own rows', async () => {
    currentUserId = null
    await putMany(Array.from({ length: 2000 }, (_, i) => orphan(i)))
    const res = await enqueueScan({ id: 'overflow-anon', badge: 'VS9999', schedule_id: 's', action: 'IN' })
    expect(res).toEqual({ ok: false, reason: 'full' })
  })

  it('clearOrphanedQueue removes null-owner rows only while logged out', async () => {
    await putMany([orphan(1), orphan(2)])
    await enqueueScan({ id: 'mine', badge: 'VS0001', schedule_id: 's', action: 'IN' })
    // Logged in: no-op, orphans intact.
    await expect(clearOrphanedQueue()).resolves.toBe(0)
    expect((await allRows()).map(r => r.id).sort()).toEqual(['mine', 'orphan-1', 'orphan-2'])
    // Logged out: removes exactly the orphans.
    currentUserId = null
    await expect(clearOrphanedQueue()).resolves.toBe(2)
    expect((await allRows()).map(r => r.id)).toEqual(['mine'])
  })
})

describe('clearFailedQueue', () => {  it('removes only terminally failed rows belonging to the current user', async () => {
    await putRaw({ id: 'ok', badge: 'VS001', schedule_id: 's', action: 'IN', owner: 'user-A' })
    await putRaw({ id: 'bad-mine', badge: 'VS002', schedule_id: 's', action: 'IN', owner: 'user-A', failed: true, status: 'failed' })
    await putRaw({ id: 'bad-theirs', badge: 'VS003', schedule_id: 's', action: 'IN', owner: 'user-B', failed: true, status: 'failed' })

    const removed = await clearFailedQueue()
    expect(removed).toBe(1)
    const left = (await allRows()).map((r) => r.id).sort()
    expect(left).toEqual(['bad-theirs', 'ok'])
  })

  it('returns 0 when there is nothing failed to clear', async () => {
    await enqueueScan({ id: 'ok', badge: 'VS001', schedule_id: 's', action: 'IN' })
    await expect(clearFailedQueue()).resolves.toBe(0)
  })
})

describe('drainQueue scan_out contract', () => {
  // scan_out declares (p_badge, p_schedule, p_ts, p_open_id) only — an extra
  // p_nonce makes PostgREST return PGRST202, which the drain treats as a
  // failure and head-of-line-blocks the whole queue behind.
  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('replays a queued OUT without the undeclared p_nonce argument', async () => {
    const calls = []
    await enqueueScan({ id: 'out-1', badge: 'FB5971GA0001', schedule_id: 'sched-1', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'open-1' })
    const drained = await drainQueue(fakeSupabase(calls))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('scan_out')
    expect(calls[0][1]).toEqual({ p_badge: 'FB5971GA0001', p_schedule: 'sched-1', p_ts: '2026-09-24T13:00:00.000Z', p_open_id: 'open-1' })
    expect(calls[0][1]).not.toHaveProperty('p_nonce')
    expect(await getQueuedScans()).toHaveLength(0)
  })

  it('treats an ok/dedup OUT replay as synced, not failed', async () => {
    const calls = []
    await enqueueScan({ id: 'out-2', badge: 'FB5971GA0002', schedule_id: 'sched-1', action: 'OUT', ts: '2026-09-24T13:05:00Z', open_id: 'open-2' })
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: { ok: true, dedup: true }, error: null })))
    expect(drained).toBe(1)
    expect(await getQueuedScans()).toHaveLength(0)
  })
})

describe('classifyScanError (Task 1: L-04 + L-08)', () => {
  it.each([
    ['Already IN — OUT first (open since 2026-09-24 09:00)', 'dedup'],
    ['No open session to close', 'dedup'],
    ['Invalid badge format', 'drop'],
    ['Badge not found', 'drop'],
    ['Session does not match badge/schedule', 'drop'],
    ['Not authorized to scan', 'permanent'],
    ['Timestamp cannot be in the future', 'permanent'],
    ['Timestamp too old (more than 30 days)', 'permanent'],
    ['Failed to fetch', 'retry'],
    ['Drain IN timed out after 10000ms', 'retry'],
    ['PGRST202 whatever', 'retry'],
    ['', 'retry'],
  ])('classifies %p as %p', (msg, expected) => {
    expect(classifyScanError(msg)).toBe(expected)
  })

  it('classifies unique-constraint open-session violations as dedup (V5)', () => {
    // Benign concurrent double-IN: the open-session index fired, so the scan
    // is already recorded server-side — drop the row, keep draining.
    expect(classifyScanError('duplicate key value violates unique constraint "uq_dp_one_open_per_badge_schedule"')).toBe('dedup')
    expect(classifyScanError('duplicate key value violates unique constraint "uq_dp_one_open_per_badge_schedule" for badge FB5971GA0001')).toBe('dedup')
    expect(classifyScanError('duplicate key value violates unique constraint "dp_attendance_sessions_pkey" on table dp_attendance_sessions')).toBe('dedup')
    // A duplicate-key error on an unrelated table is NOT this benign case.
    expect(classifyScanError('duplicate key value violates unique constraint "portal_users_email_key"')).toBe('retry')
  })

  it('honours err.code: 401/403/42501 and PGRST3xx are permanent (T8)', () => {
    // RLS / auth denials can never succeed — quarantine, never retry.
    expect(classifyScanError('forbidden', { code: 401 })).toBe('permanent')
    expect(classifyScanError('forbidden', { code: '401' })).toBe('permanent')
    expect(classifyScanError('forbidden', { code: 403 })).toBe('permanent')
    expect(classifyScanError('insufficient_privilege', { code: '42501' })).toBe('permanent')
    expect(classifyScanError('insufficient_privilege', { code: 42501 })).toBe('permanent')
    expect(classifyScanError('policy violation', { code: 'PGRST301' })).toBe('permanent')
    expect(classifyScanError('policy violation', { code: 'pgrst301' })).toBe('permanent')
  })

  it('classifies RLS/JWT message shapes as permanent with no err.code (T8)', () => {
    expect(classifyScanError('permission denied for table dp_attendance_sessions')).toBe('permanent')
    expect(classifyScanError('new row violates row-level security policy')).toBe('permanent')
    expect(classifyScanError('invalid JWT signature')).toBe('permanent')
    expect(classifyScanError('Not Authorized: missing role')).toBe('permanent')
    expect(classifyScanError('request failed with code 42501')).toBe('permanent')
    expect(classifyScanError('PGRST301 ambiguous thing')).toBe('permanent')
  })

  it('keeps PGRST202 (missing function = deploy ordering) as retry (T8)', () => {
    expect(classifyScanError('PGRST202 whatever')).toBe('retry')
    expect(classifyScanError('function does not exist', { code: 'PGRST202' })).toBe('retry')
    // PGRST202 in text does not leak into the PGRST3 permanent rule either.
    expect(classifyScanError('PGRST202: Could not find the function')).toBe('retry')
  })

  it('keeps pure network/timeout shapes as retry (T8)', () => {
    expect(classifyScanError('Failed to fetch')).toBe('retry')
    expect(classifyScanError('Failed to fetch', { code: '' })).toBe('retry')
    expect(classifyScanError('Drain IN timed out after 10000ms')).toBe('retry')
    expect(classifyScanError('')).toBe('retry')
  })

  it('exposes injectable drain timing for T2', () => {
    expect(getDrainTiming()).toEqual({ base: 7000, max: 60000 })
    globalThis.__OFFLINEQ_BASE_INTERVAL__ = 100
    globalThis.__OFFLINEQ_MAX_INTERVAL__ = 200
    expect(getDrainTiming()).toEqual({ base: 100, max: 200 })
    delete globalThis.__OFFLINEQ_BASE_INTERVAL__
    delete globalThis.__OFFLINEQ_MAX_INTERVAL__
  })
})

describe('drainQueue poison-row behaviour (L-04)', () => {  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('drains past a permanent row without head-of-line block', async () => {
    __resetDrainState()
    const calls = []
    await enqueueScan({ id: 'poison', badge: 'FB5971GA0001', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T09:00:00Z' })
    await enqueueScan({ id: 'good', badge: 'FB5971GA0002', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T09:01:00Z' })
    const drained = await drainQueue(fakeSupabase(calls, (name, params) => {
      if (params.p_badge === 'FB5971GA0001') return { data: null, error: new Error('Not authorized to scan') }
      return { data: { ok: true }, error: null }
    }))
    // poison quarantined (terminal, skipped on next pass), good row synced
    expect(drained).toBe(1)
    expect(calls).toHaveLength(2)
    const rows = await getQueuedScans()
    expect(rows.map((r) => r.id)).toEqual(['poison'])
    expect(rows[0].failed).toBe(true)
    expect(rows[0].status).toBe('failed')
  })

  it('quarantines a stale open_id OUT and keeps draining (L-08 + C3)', async () => {
    // C3 changed the OUT half: a stale p_open_id ('Session does not match')
    // is quarantined for manual recovery, not deleted — the IN behind it
    // still drains.
    __resetDrainState()
    const calls = []
    await enqueueScan({ id: 'stale', badge: 'FB5971GA0003', schedule_id: 'sched-1', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'wrong-id' })
    await enqueueScan({ id: 'next', badge: 'FB5971GA0004', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T13:01:00Z' })
    const drained = await drainQueue(fakeSupabase(calls, (name, params) => {
      if (params.p_open_id === 'wrong-id') return { data: null, error: new Error('Session does not match badge/schedule') }
      return { data: { ok: true }, error: null }
    }))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(2)
    const rows = await allRows()
    expect(rows.map((r) => r.id)).toEqual(['stale'])
    expect(rows[0].failed).toBe(true)
    expect(rows[0].status).toBe('failed')
  })
})

describe('drain orphaned-OUT quarantine (T9)', () => {
  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('quarantines (not deletes) an OUT whose IN was quarantined this drain', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'qin', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    await putRaw({ id: 'qout', badge: 'VS0001', schedule_id: 's', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'open-1', createdAt: 2, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, (name, _params) => {
      // The IN is rejected terminally; the following OUT then finds no open
      // session — deleting it would leave zero rows and lose the pair.
      if (name === 'scan_in') return { data: null, error: new Error('Not authorized to scan') }
      return { data: null, error: new Error('No open session to close') }
    }))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(2)
    const rows = await allRows()
    const inRow = rows.find((r) => r.id === 'qin')
    const outRow = rows.find((r) => r.id === 'qout')
    expect(inRow.failed).toBe(true)
    expect(inRow.status).toBe('failed')
    // Quarantined, NOT deleted — both rows stay visible for manual recovery.
    expect(outRow.failed).toBe(true)
    expect(outRow.status).toBe('failed')
  })

  it('quarantines an OUT whose IN was quarantined in a previous drain', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'qin-old', badge: 'VS0002', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A', failed: true, status: 'failed' })
    await putRaw({ id: 'qout-new', badge: 'VS0002', schedule_id: 's', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'open-9', createdAt: 2, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('No open session to close') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1)
    const outRow = (await allRows()).find((r) => r.id === 'qout-new')
    expect(outRow.failed).toBe(true)
    expect(outRow.status).toBe('failed')
  })

  it('quarantines (not deletes) a lone OUT failing as dedup/drop (C3)', async () => {
    // C3: dedup-delete is IN-only. A lone OUT with 'No open session' means
    // the IN never landed anywhere this device can see — deleting it loses
    // the scan silently. Quarantine keeps it visible for manual recovery.
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'lone-out', badge: 'VS0003', schedule_id: 's', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'open-3', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('No open session to close') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1)
    const outRow = (await allRows()).find((r) => r.id === 'lone-out')
    expect(outRow.failed).toBe(true)
    expect(outRow.status).toBe('failed')
  })

  it('a drain-timeout burns ONE attempt but still breaks the drain (C1)', async () => {
    // C1: withTimeout abandons the race WITHOUT cancelling the in-flight
    // request, so the server may HAVE applied the scan — unlike a pure
    // network error it must burn one attempt (bounded by MAX_DRAIN_ATTEMPTS).
    __resetDrainState()
    const calls = []
    expect(isNetworkNotReached('Drain OUT timed out after 10000ms')).toBe(true)
    expect(isNetworkNotReached('Failed to fetch')).toBe(true)
    expect(isNetworkNotReached('unexpected server wobble 500')).toBe(false)
    await putRaw({ id: 'tout', badge: 'VS0004', schedule_id: 's', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'open-4', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Drain OUT timed out after 10000ms') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1)
    expect((await allRows()).find((r) => r.id === 'tout').attempts).toBe(1)
    expect(__getConsecutiveFailures()).toBe(1)
  })
})

describe('stranded rows (T10)', () => {
  const live = (id, extra = {}) => ({
    id, badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z',
    createdAt: 1, attempts: 0, synced: false, ...extra,
  })

  it('isStrandedRow matches only live, non-failed, non-synced null-owner rows', () => {
    expect(isStrandedRow(live('a', { owner: null }))).toBe(true)
    expect(isStrandedRow(live('b', { owner: 'user-A' }))).toBe(false)
    expect(isStrandedRow(live('c', { owner: null, failed: true, status: 'failed' }))).toBe(false)
    expect(isStrandedRow(live('d', { owner: null, failed: true }))).toBe(false)
    expect(isStrandedRow(live('e', { owner: null, synced: true }))).toBe(false)
    expect(isStrandedRow(live('f', {}))).toBe(true) // missing owner reads as null
    expect(isStrandedRow(null)).toBe(false)
  })

  it('listStrandedQueue returns null-owner live rows while logged in (read-only)', async () => {
    await putRaw(live('strand-1', { owner: null }))
    await putRaw(live('mine-1', { owner: 'user-A' }))
    await putRaw(live('dead-1', { owner: null, failed: true, status: 'failed' }))
    // getQueuedScans hides the stranded row while logged in (D1a)…
    expect((await getQueuedScans()).map((r) => r.id)).toEqual(['mine-1'])
    // …but the stranded list surfaces it regardless of login.
    expect((await listStrandedQueue()).map((r) => r.id)).toEqual(['strand-1'])
  })

  it('a stranded row is removable per-row via removeQueued and never drains', async () => {
    __resetDrainState()
    const calls = []
    const fake = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => { calls.push([name, params]); return { data: { ok: true }, error: null } },
    }
    await putRaw(live('strand-9', { owner: null }))
    // Drain skips null-owner rows (cross-user safety) — zero RPCs for it.
    await drainQueue(fake)
    expect(calls).toHaveLength(0)
    expect((await listStrandedQueue()).map((r) => r.id)).toEqual(['strand-9'])
    // Manual per-row clear removes exactly that row.
    await removeQueued('strand-9')
    expect(await listStrandedQueue()).toEqual([])
    expect(await allRows()).toHaveLength(0)
  })

  it('clearOrphanedQueue still returns 0 while logged in (semantics kept)', async () => {
    await putRaw(live('strand-2', { owner: null }))
    await expect(clearOrphanedQueue()).resolves.toBe(0)
    expect((await listStrandedQueue()).map((r) => r.id)).toEqual(['strand-2'])
  })
})

describe('unique-constraint dedup drain (V5)', () => {
  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('drain removes a unique-violation row and keeps draining without backoff climb (V5)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'dbl-in', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    await putRaw({ id: 'next-ok', badge: 'VS0002', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:01:00Z', createdAt: 2, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, (name, params) => {
      if (params.p_badge === 'VS0001') return { data: null, error: new Error('duplicate key value violates unique constraint "uq_dp_one_open_per_badge_schedule"') }
      return { data: { ok: true }, error: null }
    }))
    // No break: both rows attempted, both gone, the dedup counts as drained.
    expect(drained).toBe(2)
    expect(calls).toHaveLength(2)
    expect(await getQueuedScans()).toHaveLength(0)
    // Benign dedup must not climb the sticky backoff.
    expect(__getConsecutiveFailures()).toBe(0)
  })
})

describe('drainQueue owner + retry semantics (V12)', () => {
  function fakeSupabase(calls, impl, userId = 'user-A') {
    return {
      auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('logged-out drain is a no-op (V12)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'mine', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, null, null))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(0)
    // The row is untouched — it will drain under its owner's next login.
    expect((await allRows()).map((r) => r.id)).toEqual(['mine'])
  })

  it('drain skips other-user and null-owner rows (V12)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'mine', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    await putRaw({ id: 'theirs', badge: 'VS0002', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:01:00Z', createdAt: 2, attempts: 0, synced: false, owner: 'user-B' })
    await putRaw({ id: 'anon', badge: 'VS0003', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:02:00Z', createdAt: 3, attempts: 0, synced: false, owner: null })
    const drained = await drainQueue(fakeSupabase(calls))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0][1].p_badge).toBe('VS0001')
    // Other users' rows (and null-owner orphans) are never synced or deleted.
    expect((await allRows()).map((r) => r.id).sort()).toEqual(['anon', 'theirs'])
  })

  it('retry arm breaks and climbs backoff without burning attempts on network failures (V12 + T9)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'flaky-1', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    await putRaw({ id: 'flaky-2', badge: 'VS0002', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:01:00Z', createdAt: 2, attempts: 0, synced: false, owner: 'user-A' })
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Failed to fetch') })))
    expect(drained).toBe(0)
    // Head-of-line block: the drain stops at the first network error.
    expect(calls).toHaveLength(1)
    const rows = await allRows()
    // T9: the RPC was never reached, so no attempt is burned (a jammer must
    // not terminally lose scans that were never attempted).
    expect(rows.find((r) => r.id === 'flaky-1').attempts).toBe(0)
    // The row behind the failure is never attempted.
    expect(rows.find((r) => r.id === 'flaky-2').attempts).toBe(0)
    expect(__getConsecutiveFailures()).toBe(1)
  })

  it('forward progress decays the backoff one step at a time (V12)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'solo', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    // Two failed drains climb the backoff 0 → 1 → 2 (T9: network failures
    // climb the backoff but burn no attempts — the scan was never reached).
    await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Failed to fetch') })))
    expect(__getConsecutiveFailures()).toBe(1)
    await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Failed to fetch') })))
    expect(__getConsecutiveFailures()).toBe(2)
    expect((await allRows()).find((r) => r.id === 'solo').attempts).toBe(0)
    // One successful drain decays exactly one step (2 → 1), not a reset.
    const drained = await drainQueue(fakeSupabase(calls))
    expect(drained).toBe(1)
    expect(__getConsecutiveFailures()).toBe(1)
  })

  it('server-reached retry failures still burn attempts toward the cap (T9)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'srv', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    // An unknown server error reaches the RPC (not a network/timeout shape)
    // → retry AND markFailed, so poison-but-retryable rows still terminate.
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('unexpected server wobble 500') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1)
    expect((await allRows()).find((r) => r.id === 'srv').attempts).toBe(1)
    expect(__getConsecutiveFailures()).toBe(1)
  })
})

describe('drain quarantine + listeners + cache TTL (A5 / L-13)', () => {
  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }

  it('quarantines an unparseable-timestamp row and keeps draining past it', async () => {
    __resetDrainState()
    const calls = []
    await putRaw({ id: 'bad-ts', badge: 'VS0001', schedule_id: 's', action: 'IN', ts: 'not-a-date', createdAt: 1, attempts: 0, synced: false, owner: 'user-A' })
    await enqueueScan({ id: 'good-ts', badge: 'VS0002', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z' })
    const drained = await drainQueue(fakeSupabase(calls))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(1)
    const rows = await allRows()
    const bad = rows.find(r => r.id === 'bad-ts')
    expect(bad.failed).toBe(true)
    expect(bad.status).toBe('failed')
    expect(bad.failReason).toBe('bad-timestamp')
  })

  it('installDrainListeners fires on the injectable interval and cleanup stops it', async () => {
    __resetDrainState()
    // Real timers: fake timers wedge fake-indexeddb's internals (operations
    // started under fake time never settle after restore). Short real
    // intervals keep this under a second.
    globalThis.__OFFLINEQ_BASE_INTERVAL__ = 40
    globalThis.__OFFLINEQ_MAX_INTERVAL__ = 50
    try {
      const calls = []
      const sb = fakeSupabase(calls)
      // A row to sync: an empty queue drains silently with zero RPCs, which
      // would make "the listener fired" unobservable.
      await enqueueScan({ id: 'live-row', badge: 'VS0009', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z' })
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      const cleanup = installDrainListeners(sb)
      await new Promise(r => setTimeout(r, 400))
      expect(calls.length).toBeGreaterThan(0)
      expect(await getQueuedScans()).toHaveLength(0)
      const frozen = calls.length
      cleanup()
      await new Promise(r => setTimeout(r, 300))
      expect(calls.length).toBe(frozen)
    } finally {
      delete globalThis.__OFFLINEQ_BASE_INTERVAL__
      delete globalThis.__OFFLINEQ_MAX_INTERVAL__
    }
  }, 10000)

  it('getCachedDeployed honours the cache TTL', async () => {
    await preloadDeployed('sched-ttl', [{ badge_number: 'VS0001', deptId: 'd1', is_vss: false }])
    expect(await getCachedDeployed('sched-ttl')).toHaveLength(1)
    // Backdate past the 10-minute TTL: the cache must read as empty.
    await cacheSet('deployed_at:sched-ttl', Date.now() - 11 * 60 * 1000)
    expect(await getCachedDeployed('sched-ttl')).toEqual([])
  })
})

describe('worst-case data-loss fixes (C1/C3/C4/C5/C6 + cap policy)', () => {
  function fakeSupabase(calls, impl) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-A' } } } }) },
      rpc: async (name, params) => {
        calls.push([name, params])
        return impl ? impl(name, params) : { data: { ok: true }, error: null }
      },
    }
  }
  const live = (id, extra = {}) => ({
    id, badge: 'VS0001', schedule_id: 's', action: 'IN', ts: '2026-09-24T09:00:00Z',
    createdAt: 1, attempts: 0, synced: false, owner: 'user-A', ...extra,
  })

  it('C1: a drain-IN timeout burns ONE attempt but still breaks (server-possibly-reached)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('cin', { badge: 'VS0011' }))
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Drain IN timed out after 10000ms') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1)
    expect((await allRows()).find((r) => r.id === 'cin').attempts).toBe(1)
    expect(__getConsecutiveFailures()).toBe(1)
  })

  it('C1: repeated drain-timeouts still go terminal at MAX_DRAIN_ATTEMPTS (bounded)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('cbound', { badge: 'VS0012', attempts: 11 }))
    await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Drain IN timed out after 10000ms') })))
    const row = (await allRows()).find((r) => r.id === 'cbound')
    expect(row.attempts).toBe(12)
    expect(row.failed).toBe(true)
    expect(row.status).toBe('failed')
  })

  it('C4: PGRST202 (err.code) burns no attempt — self-healing deploy ordering', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('c4code', { badge: 'VS0013' }))
    const err = new Error('Could not find the function public.scan_in')
    err.code = 'PGRST202'
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: err })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1) // still breaks + backs off
    expect((await allRows()).find((r) => r.id === 'c4code').attempts).toBe(0)
    expect(__getConsecutiveFailures()).toBe(1)
  })

  it('C4: PGRST202 in message text alone burns no attempt', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('c4msg', { badge: 'VS0014' }))
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('PGRST202: Could not find the function') })))
    expect(drained).toBe(0)
    expect((await allRows()).find((r) => r.id === 'c4msg').attempts).toBe(0)
  })

  it('C3 gap: a bad-timestamp IN seeds failedInKeys, so its OUT is quarantined not deleted', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('cbad-in', { badge: 'VS0015', ts: 'not-a-date', createdAt: 1 }))
    await putRaw(live('cbad-out', { badge: 'VS0015', action: 'OUT', open_id: 'open-x', createdAt: 2 }))
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('No open session to close') })))
    expect(drained).toBe(0)
    expect(calls).toHaveLength(1) // only the OUT was attempted; the IN never RPCs
    const rows = await allRows()
    expect(rows.find((r) => r.id === 'cbad-in').failed).toBe(true)
    const outRow = rows.find((r) => r.id === 'cbad-out')
    expect(outRow.failed).toBe(true)
    expect(outRow.status).toBe('failed')
  })

  it('C3: a plain IN answered Already IN is still deleted (server holds the session)', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('cplain-in', { badge: 'VS0016' }))
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Already IN — OUT first') })))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(1)
    expect(await allRows()).toHaveLength(0)
  })

  it('C5: enqueue under a backward clock jump stays monotonic and drains in scan order', async () => {
    // This repo's jsdom has no localStorage (typeof === 'undefined'), so the
    // floor is exercised through a stubbed in-memory store — the impl reads
    // the bare global, which is exactly what the stub replaces.
    const mem = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v) },
      removeItem: (k) => { delete mem[k] },
    })
    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(realNow)
      const a = await enqueueScan({ id: 'c5-a', badge: 'VS0017', schedule_id: 's', action: 'IN', ts: new Date().toISOString() })
      expect(a.ok).toBe(true)
      nowSpy.mockReturnValue(realNow - 60000) // device clock jumps BACKWARD
      const b = await enqueueScan({ id: 'c5-b', badge: 'VS0018', schedule_id: 's', action: 'IN', ts: new Date().toISOString() })
      expect(b.ok).toBe(true)
      const rows = await allRows()
      const ca = rows.find((r) => r.id === 'c5-a').createdAt
      const cb = rows.find((r) => r.id === 'c5-b').createdAt
      expect(cb).toBeGreaterThan(ca)
      // …and the drain honours scan order, not wall-clock order.
      __resetDrainState()
      const calls = []
      const fake = fakeSupabase(calls)
      // drainQueue resolves owner via the injected client — same user.
      await drainQueue(fake)
      expect(calls.map((c) => c[1].p_badge)).toEqual(['VS0017', 'VS0018'])
    } finally {
      nowSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('C6: an uncertain IN answered Already IN attempts the OUT flow, then drops', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('c6', { badge: 'VS0019', uncertain: true }))
    const drained = await drainQueue(fakeSupabase(calls, (name) => {
      if (name === 'scan_in') return { data: null, error: new Error('Already IN — OUT first') }
      if (name === 'get_open_session') return { data: { id: 'open-9', badge_number: 'VS0019' }, error: null }
      return { data: { ok: true }, error: null } // scan_out
    }))
    expect(drained).toBe(1)
    expect(calls.map((c) => c[0])).toEqual(['scan_in', 'get_open_session', 'scan_out'])
    // The OUT closed exactly the resolved session — never a blind null id.
    expect(calls[2][1]).toMatchObject({ p_badge: 'VS0019', p_schedule: 's', p_open_id: 'open-9' })
    expect(await allRows()).toHaveLength(0)
  })

  it('C6: an uncertain IN whose OUT attempt fails is quarantined, never deleted', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('c6q', { badge: 'VS0020', uncertain: true }))
    const drained = await drainQueue(fakeSupabase(calls, (name) => {
      if (name === 'scan_in') return { data: null, error: new Error('Already IN — OUT first') }
      return { data: null, error: null } // get_open_session: no open session
    }))
    expect(drained).toBe(0)
    const row = (await allRows()).find((r) => r.id === 'c6q')
    expect(row.failed).toBe(true)
    expect(row.status).toBe('failed')
  })

  it('C6: a certain (non-uncertain) IN answered Already IN is still just deleted', async () => {
    __resetDrainState()
    const calls = []
    await putRaw(live('c6c', { badge: 'VS0021' }))
    const drained = await drainQueue(fakeSupabase(calls, () => ({ data: null, error: new Error('Already IN — OUT first') })))
    expect(drained).toBe(1)
    expect(calls).toHaveLength(1) // no get_open_session / scan_out follow-up
    expect(await allRows()).toHaveLength(0)
  })

  it('cap policy: clearLiveQueue removes only the current owner live rows', async () => {
    await putRaw(live('livemine', { badge: 'VS0031' }))
    await putRaw(live('deadmin', { badge: 'VS0032', failed: true, status: 'failed' }))
    await putRaw(live('theirs', { badge: 'VS0033', owner: 'user-B' }))
    await putRaw(live('anon', { badge: 'VS0034', owner: null }))
    await expect(clearLiveQueue()).resolves.toBe(1)
    expect((await allRows()).map((r) => r.id).sort()).toEqual(['anon', 'deadmin', 'theirs'])
  })

  it('cap policy: clearLiveQueue returns 0 when there is nothing live to clear', async () => {
    await putRaw(live('dead', { badge: 'VS0035', failed: true, status: 'failed' }))
    await expect(clearLiveQueue()).resolves.toBe(0)
  })
})
