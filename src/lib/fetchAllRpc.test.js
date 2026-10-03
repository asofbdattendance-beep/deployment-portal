import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same programmable PostgREST stand-in as fetchAllRows.test.js, but keyed on
// .rpc(): each call resolves the next scripted page so we can replay multi-
// page result sets, boundary dup/drop, count drift and infinite full pages.
// The proxy defers to globalThis.__mockSupabase at CALL time because the
// module under test is imported once while the mock is re-armed per test.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => new Proxy({}, {
    get: (_t, prop) => (...args) => globalThis.__mockSupabase[prop](...args),
  })),
}))

vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

const { fetchAllRpc, RPC_PAGE_SPECS } = await import('./supabase.js')

function makeRpcMock(plan) {
  // plan: array of { rows, count? } consumed one per rpc page request.
  const calls = []
  const state = { attempt: 0 }
  const rpc = (name, params, opts) => {
    const call = { name, params, opts, orders: [], range: null }
    const q = {
      order: (col, o) => { call.orders.push([col, o]); return q },
      range: (a, b) => { call.range = [a, b]; return q },
      then: (resolve, reject) => {
        calls.push(call)
        try {
          const step = plan[state.attempt] || plan[plan.length - 1]
          state.attempt += 1
          const rows = typeof step.rows === 'function' ? step.rows(call) : step.rows
          resolve({ data: rows, error: step.error || null, count: step.count })
        } catch (e) { reject(e) }
      },
    }
    return q
  }
  globalThis.__mockSupabase = { rpc: vi.fn(rpc) }
  return { calls, state }
}

function rows(n, prefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({
    badge_number: `${prefix}${String(i).padStart(5, '0')}`,
    sewadar_centre: 'C',
    sewadar_name: `N${i}`,
  }))
}

describe('fetchAllRpc complete-or-throw pagination', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('merges a multi-page RPC exactly once per row (2500 rows → 3 pages)', async () => {
    const all = rows(2500)
    const { calls } = makeRpcMock([
      { rows: all.slice(0, 1000), count: 2500 },
      { rows: all.slice(1000, 2000) },
      { rows: all.slice(2000) },
    ])
    const out = await fetchAllRpc('attendance_sewadar_summary', { p_schedule: 's' })
    expect(out).toHaveLength(2500)
    expect(new Set(out.map(r => r.badge_number)).size).toBe(2500)
    expect(calls).toHaveLength(3)
    // Page 1 asks for the exact count; later pages do not.
    expect(calls[0].opts).toEqual({ count: 'exact' })
    expect(calls[1].opts).toBeUndefined()
    // Ranges are contiguous 1000-row windows.
    expect(calls.map(c => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('collapses boundary duplicates and recovers via count-assert retry', async () => {
    const clean = rows(2500)
    // Page 2 repeats the last 10 rows of page 1 and drops 10 others (the
    // GURGAON signature): count says 2500, only 2490 unique arrive → retry.
    const dropped = new Set(clean.slice(500, 510).map(r => r.badge_number))
    const p1 = clean.slice(0, 1000)
    const p2 = [...clean.slice(990, 1000), ...clean.slice(1000, 1990).filter(r => !dropped.has(r.badge_number))]
    makeRpcMock([
      { rows: p1, count: 2500 },
      { rows: p2 },
      { rows: clean.slice(1990) },
      // retry attempt: stable snapshot
      { rows: clean.slice(0, 1000), count: 2500 },
      { rows: clean.slice(1000, 2000) },
      { rows: clean.slice(2000) },
    ])
    const out = await fetchAllRpc('attendance_sewadar_summary', { p_schedule: 's' })
    expect(out).toHaveLength(2500)
    expect(new Set(out.map(r => r.badge_number)).size).toBe(2500)
  })

  it('throws loudly when the server persistently disagrees (never truncates)', async () => {
    const all = rows(1500)
    makeRpcMock([
      { rows: all.slice(0, 1000), count: 1500 },
      { rows: all.slice(1000, 1490) }, // 10 rows missing, both attempts
      { rows: all.slice(0, 1000), count: 1500 },
      { rows: all.slice(1000, 1490) },
    ])
    await expect(fetchAllRpc('attendance_sewadar_summary', {})).rejects.toThrow(/count mismatch after retry/)
  })

  it('replicates the SQL order and appends only the missing key tail', async () => {
    const { calls } = makeRpcMock([{ rows: rows(3), count: 3 }])
    await fetchAllRpc('previsit_sewadars', { p_schedule: 's' })
    expect(calls[0].orders).toEqual([
      ['event_date', { ascending: false }],
      ['in_time', { ascending: false }],
      ['badge_number', { ascending: true }], // key tail — no re-sort of event_date
    ])
  })

  it('orders every page identically (stable OFFSET windows)', async () => {
    const { calls } = makeRpcMock([
      { rows: rows(1000), count: 1200 },
      { rows: rows(200) },
    ])
    await fetchAllRpc('attendance_day_badges', { p_schedule: 's' })
    expect(calls[1].orders).toEqual(calls[0].orders)
  })

  it('throws for an RPC with no page spec (refuses keyless pagination)', async () => {
    await expect(fetchAllRpc('some_unregistered_fn', {})).rejects.toThrow(/no page spec/)
    expect(RPC_PAGE_SPECS.attendance_sewadar_summary.stableKey).toBe('badge_number')
  })

  it('propagates a returned { error }', async () => {
    makeRpcMock([{ rows: [], count: 0, error: { message: 'boom', code: 'XX000' } }])
    await expect(fetchAllRpc('attendance_sewadar_summary', {})).rejects.toMatchObject({ message: 'boom' })
  })

  it('trips the page guard instead of looping forever', async () => {
    // server keeps returning full pages forever
    makeRpcMock([{ rows: rows(1000), count: 999999 }])
    await expect(fetchAllRpc('attendance_sewadar_summary', {})).rejects.toThrow(/page guard tripped|count mismatch/)
  }, 15000)

  it('terminates on a short page when count is unavailable (null count)', async () => {
    const all = rows(1200)
    const { calls } = makeRpcMock([
      { rows: all.slice(0, 1000) }, // count: undefined → null
      { rows: all.slice(1000) },
    ])
    const out = await fetchAllRpc('attendance_sewadar_summary', {})
    expect(out).toHaveLength(1200)
    expect(calls).toHaveLength(2)
  })
})
