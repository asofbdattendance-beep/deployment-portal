import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the supabase client: a programmable PostgREST stand-in whose page
// responses are scripted per test (exact slices), so we can replay the
// proven GURGAON boundary defect (ties reordered across pages →
// duplicates + misses) and assert the helper neutralises it.
// The proxy defers to globalThis.__mockSupabase at CALL time because the
// module under test is imported once while the mock is re-armed per test.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => new Proxy({}, {
    get: (_t, prop) => (...args) => globalThis.__mockSupabase[prop](...args),
  })),
}))

vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

const { fetchAllRows } = await import('./supabase.js')

function makeBuilder(plan) {
  // plan: array of { rows } consumed in call order; each call also records
  // select/order/range so tests can assert the query shape.
  const calls = []
  const state = { attempt: 0 }
  const builder = () => {
    const call = { select: null, countOpt: undefined, orders: [], range: null, filters: [] }
    const q = {
      select: (s, o) => { call.select = s; call.countOpt = o; return q },
      eq: (c, v) => { call.filters.push(['eq', c, v]); return q },
      neq: (c, v) => { call.filters.push(['neq', c, v]); return q },
      in: (c, v) => { call.filters.push(['in', c, v]); return q },
      or: (f) => { call.filters.push(['or', f]); return q },
      gt: (c, v) => { call.filters.push(['gt', c, v]); return q },
      limit: (n) => { call.filters.push(['limit', n]); return q },
      order: (c, o) => { call.orders.push([c, o]); return q },
      range: (a, b) => { call.range = [a, b]; return q },
      then: (resolve) => {
        calls.push(call)
        const step = plan[state.attempt] || plan[plan.length - 1]
        state.attempt += 1
        const rows = typeof step.rows === 'function' ? step.rows(call) : step.rows
        resolve({ data: rows, error: step.error || null, count: step.count })
      },
    }
    return q
  }
  globalThis.__mockSupabase = { from: vi.fn(() => builder()) }
  return { calls, state }
}

function rows(n, prefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, centre: 'C', badge_number: `${prefix}${i}` }))
}

describe('fetchAllRows hardened pagination', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetches a multi-page table exactly once per row (clean pages)', async () => {
    const all = rows(2567)
    makeBuilder([
      { rows: all.slice(0, 1000), count: 2567 },
      { rows: all.slice(1000, 2000) },
      { rows: all.slice(2000) },
    ])
    const out = await fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', 's'), 'id')
    expect(out).toHaveLength(2567)
    expect(new Set(out.map(r => r.id)).size).toBe(2567)
  })

  it('collapses boundary duplicates and recovers via count-assert retry', async () => {
    const clean = rows(2567)
    // First attempt: page 2 repeats the last 10 rows of page 1 and drops 10
    // others — the exact GURGAON signature (31 dup / 10 missed). Count says
    // 2567 but only 2557 unique arrive -> retry on a stable snapshot.
    const dropped = new Set(clean.slice(500, 510).map(r => r.id))
    const p1 = clean.slice(0, 1000)
    const p2 = [...clean.slice(990, 1000), ...clean.slice(1000, 1990).filter(r => !dropped.has(r.id))]
    makeBuilder([
      { rows: p1, count: 2567 },
      { rows: p2 },
      { rows: clean.slice(1990) },
      // retry attempt: stable snapshot
      { rows: clean.slice(0, 1000), count: 2567 },
      { rows: clean.slice(1000, 2000) },
      { rows: clean.slice(2000) },
    ])
    const out = await fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', 's'), 'id')
    expect(out).toHaveLength(2567)
    expect(new Set(out.map(r => r.id)).size).toBe(2567)
    for (const b of [...dropped].map(id => id)) {
      expect(out.some(r => r.id === b)).toBe(true)
    }
  })

  it('throws loudly when the server persistently disagrees (never truncates)', async () => {
    const all = rows(1500)
    makeBuilder([
      { rows: all.slice(0, 1000), count: 1500 },
      { rows: all.slice(1000, 1490) }, // 10 rows missing, both attempts
      { rows: all.slice(0, 1000), count: 1500 },
      { rows: all.slice(1000, 1490) },
    ])
    await expect(fetchAllRows('t', '*', null, 'id')).rejects.toThrow(/count mismatch after retry/)
  })

  it('appends the unique tiebreaker last and keeps the caller order first', async () => {
    const { calls } = makeBuilder([{ rows: rows(5), count: 5 }])
    await fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', 's').order('centre'), 'id')
    expect(calls[0].orders.map(o => o[0])).toEqual(['centre', 'id'])
  })

  it('supports composite stable keys and adds missing key columns to select', async () => {
    const { calls } = makeBuilder([{ rows: [{ badge_number: 'b1', gender: 'M' }], count: 1 }])
    const out = await fetchAllRows('dp_sewadars', 'badge_number, gender', (q) => q.in('badge_number', ['b1']), ['centre', 'badge_number'])
    expect(calls[0].select).toContain('centre')
    expect(calls[0].orders.map(o => o[0])).toEqual(['centre', 'badge_number'])
    expect(out).toHaveLength(1)
  })

  it('works when applyFilters returns nothing', async () => {
    makeBuilder([{ rows: rows(3), count: 3 }])
    const out = await fetchAllRows('t', '*', () => undefined, 'id')
    expect(out).toHaveLength(3)
  })

  it('trips the page guard instead of looping forever', async () => {
    // server keeps returning full pages forever
    makeBuilder([{ rows: rows(1000), count: 999999 }])
    await expect(fetchAllRows('t', '*', null, 'id')).rejects.toThrow(/page guard tripped|count mismatch/)
  }, 15000)

  it('requests count:exact on page 1 by default (initial loads keep the guard)', async () => {
    const { calls } = makeBuilder([{ rows: rows(5), count: 5 }])
    const out = await fetchAllRows('t', '*', null, 'id')
    expect(calls[0].countOpt).toEqual({ count: 'exact' })
    expect(out).toHaveLength(5)
  })

  // v77 perf: the 15 s session polls must not pay count:'exact' (~3.2 s mean
  // on dp_attendance_sessions). { count: 'none' } skips the Prefer header AND
  // the count-mismatch retry, while the pagination loop still runs to a short
  // page — the result is still complete, only the cross-check is gone.
  it("skips the count on every page when opts.count is 'none'", async () => {
    const all = rows(1500)
    const { calls } = makeBuilder([
      { rows: all.slice(0, 1000) }, // no count — must NOT throw
      { rows: all.slice(1000) },
    ])
    const out = await fetchAllRows('t', '*', null, 'id', { count: 'none' })
    expect(calls[0].countOpt).toBeUndefined()
    expect(calls[1].countOpt).toBeUndefined()
    expect(out).toHaveLength(1500)
    expect(new Set(out.map(r => r.id)).size).toBe(1500)
  })
})
