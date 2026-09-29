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

const { enqueueScan, getQueuedScans, removeQueued, markFailed, clearFailedQueue, drainQueue, classifyScanError, getDrainTiming, __resetDrainState } = await import('./offlineQueue')

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
  // Initialise the schema through the module's own safeOpenDB path first, so
  // the `scan_queue` object store actually exists before any raw access.
  await enqueueScan({ id: '__init__', badge: 'FB5971GA0000', schedule_id: 's', action: 'IN' })
  for (const r of await allRows()) await removeQueued(r.id)
})

describe('enqueueScan', () => {
  it('stores a scan and tags it with the signed-in user', async () => {
    const id = await enqueueScan({ badge: 'FB5971GA0001', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T09:00:00Z' })
    expect(id).toBeTruthy()
    const rows = await getQueuedScans()
    expect(rows).toHaveLength(1)
    expect(rows[0].badge).toBe('FB5971GA0001')
    expect(rows[0].owner).toBe('user-A')
  })

  it('honours a caller-supplied id (the offline nonce used for idempotency)', async () => {
    const id = await enqueueScan({ id: 'nonce-123', badge: 'VS001', schedule_id: 'sched-1', action: 'IN' })
    expect(id).toBe('nonce-123')
    expect((await getQueuedScans())[0].id).toBe('nonce-123')
  })

  it('stores a null owner when no session resolves (logged out)', async () => {
    currentUserId = null
    await enqueueScan({ badge: 'FB5971GA0002', schedule_id: 'sched-1', action: 'IN' })
    const rows = await allRows()
    expect(rows[0].owner).toBeNull()
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

describe('clearFailedQueue', () => {
  it('removes only terminally failed rows belonging to the current user', async () => {
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

  it('exposes injectable drain timing for T2', () => {
    expect(getDrainTiming()).toEqual({ base: 7000, max: 60000 })
    globalThis.__OFFLINEQ_BASE_INTERVAL__ = 100
    globalThis.__OFFLINEQ_MAX_INTERVAL__ = 200
    expect(getDrainTiming()).toEqual({ base: 100, max: 200 })
    delete globalThis.__OFFLINEQ_BASE_INTERVAL__
    delete globalThis.__OFFLINEQ_MAX_INTERVAL__
  })
})

describe('drainQueue poison-row behaviour (L-04)', () => {
  function fakeSupabase(calls, impl) {
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

  it('drops a stale open_id row and keeps draining (L-08)', async () => {
    __resetDrainState()
    const calls = []
    await enqueueScan({ id: 'stale', badge: 'FB5971GA0003', schedule_id: 'sched-1', action: 'OUT', ts: '2026-09-24T13:00:00Z', open_id: 'wrong-id' })
    await enqueueScan({ id: 'next', badge: 'FB5971GA0004', schedule_id: 'sched-1', action: 'IN', ts: '2026-09-24T13:01:00Z' })
    const drained = await drainQueue(fakeSupabase(calls, (name, params) => {
      if (params.p_open_id === 'wrong-id') return { data: null, error: new Error('Session does not match badge/schedule') }
      return { data: { ok: true }, error: null }
    }))
    expect(drained).toBe(2)
    expect(calls).toHaveLength(2)
    expect(await getQueuedScans()).toHaveLength(0)
  })
})
