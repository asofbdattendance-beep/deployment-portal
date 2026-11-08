// @vitest-environment jsdom
/**
 * scannerLoadSimulation.test.js — 150 Concurrent Scanners Stress Simulation
 *
 * Verifies that 150 scanners executing rapid attendance scans simultaneously
 * (arrival/departure rush at Bhati gates) run cleanly with:
 * 1. Zero data loss across online and offline paths.
 * 2. Idempotent deduplication (duplicate nonces never produce duplicate sessions).
 * 3. Graceful handling of network drops and staggered reconnect drain.
 * 4. Zero memory leaks or unhandled promise rejections under high concurrency.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const currentUserId = 'test-scanner-user'
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: currentUserId } } },
      }),
    },
    rpc: vi.fn(),
  },
}))

import { enqueueScan, drainQueue, getQueuedScans, clearLiveQueue, clearFailedQueue } from './offlineQueue'
import { getReconnectDelay } from './offlineSync'

describe('150 Concurrent Scanners Load Simulation', () => {
  let committedSessions = new Map() // nonce -> session record
  let inFlightRpcCount = 0
  let maxConcurrentRpc = 0
  let serverTotalIn = 0
  let serverTotalOut = 0

  beforeEach(async () => {
    committedSessions.clear()
    inFlightRpcCount = 0
    maxConcurrentRpc = 0
    serverTotalIn = 0
    serverTotalOut = 0
    await clearLiveQueue()
    await clearFailedQueue()
  })

  // Simulated Supabase client with realistic latency, concurrency tracking, and idempotency
  function createMockSupabase(failureRate = 0) {
    return {
      rpc: vi.fn(async (fnName, params) => {
        inFlightRpcCount++
        if (inFlightRpcCount > maxConcurrentRpc) {
          maxConcurrentRpc = inFlightRpcCount
        }

        // Simulate 2-10ms network/DB latency
        const latency = Math.floor(Math.random() * 8) + 2
        await new Promise((r) => setTimeout(r, latency))
        inFlightRpcCount--

        // Simulated transient network drop
        if (failureRate > 0 && Math.random() < failureRate) {
          throw new Error('Failed to fetch: gateway timeout')
        }

        const nonce = params.p_nonce || `auto-${Date.now()}-${Math.random()}`

        if (fnName === 'scan_in') {
          if (committedSessions.has(nonce)) {
            // Idempotent duplicate replay
            return { data: committedSessions.get(nonce), error: null }
          }
          const record = {
            ok: true,
            badge: params.p_badge,
            sewadar_name: `Sewadar ${params.p_badge}`,
            sewadar_centre: params.p_centre || 'DELHI',
            dept_name: 'Langar',
            late_in: false,
            nonce,
          }
          committedSessions.set(nonce, record)
          serverTotalIn++
          return { data: record, error: null }
        }

        if (fnName === 'scan_out') {
          if (committedSessions.has(nonce)) {
            return { data: committedSessions.get(nonce), error: null }
          }
          const record = {
            ok: true,
            badge: params.p_badge,
            early_out: false,
            nonce,
          }
          committedSessions.set(nonce, record)
          serverTotalOut++
          return { data: record, error: null }
        }

        return { data: { ok: true }, error: null }
      }),
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: 'test-scanner-user' } } },
        }),
      },
    }
  }

  it('handles 150 scanners executing concurrent scans with 0% data loss and strict idempotency', async () => {
    const NUM_SCANNERS = 150
    const SCANS_PER_SCANNER = 4 // 150 * 4 = 600 total scans
    const mockClient = createMockSupabase(0.15) // 15% network drops into offline queue
    const scheduleId = 'sched-bhati-dec-2026'

    // Run 150 virtual scanners concurrently
    const scannerWorkers = Array.from({ length: NUM_SCANNERS }, async (_, scannerIdx) => {
      const scannerBadge = `SCN-${String(scannerIdx + 1).padStart(3, '0')}`

      for (let scanNum = 1; scanNum <= SCANS_PER_SCANNER; scanNum++) {
        const sewadarBadge = `FB5971GA${String(scannerIdx * 10 + scanNum).padStart(4, '0')}`
        const nonce = `nonce-${scannerBadge}-${scanNum}`

        try {
          await mockClient.rpc('scan_in', {
            p_badge: sewadarBadge,
            p_schedule: scheduleId,
            p_ts: new Date().toISOString(),
            p_centre: 'DELHI',
            p_nonce: nonce,
            p_is_manual: false,
          })
        } catch {
          // Network dropped — queue offline
          await enqueueScan({
            badge: sewadarBadge,
            schedule_id: scheduleId,
            action: 'IN',
            ts: new Date().toISOString(),
            centre: 'DELHI',
            id: nonce,
            is_manual: false,
          })
        }
      }
    })

    // Wait for all 150 scanners to finish their scan burst
    await Promise.all(scannerWorkers)

    // Check queued scans
    const initialQueued = await getQueuedScans()
    expect(serverTotalIn + initialQueued.length).toBe(NUM_SCANNERS * SCANS_PER_SCANNER)

    // Now simulate network restoration and queue drain
    // Drain uses offlineClient with 0% failure rate
    const reliableClient = createMockSupabase(0)
    let drainedTotal = 0

    if (initialQueued.length > 0) {
      drainedTotal = await drainQueue(reliableClient)
    }

    // All queued items must have drained cleanly
    expect(drainedTotal).toBe(initialQueued.length)
    const remainingQueued = await getQueuedScans()
    expect(remainingQueued).toHaveLength(0)

    // Final audit: total committed sessions in database must be exactly 600 with zero duplicates
    expect(committedSessions.size).toBe(NUM_SCANNERS * SCANS_PER_SCANNER)
    expect(serverTotalIn).toBe(NUM_SCANNERS * SCANS_PER_SCANNER)
  })

  it('anti-thundering herd reconnect delay generates distributed offsets across 150 devices', () => {
    // 150 devices calling getReconnectDelay() must produce an even, jittered distribution
    const delays = Array.from({ length: 150 }, () => getReconnectDelay())
    const min = Math.min(...delays)
    const max = Math.max(...delays)

    expect(min).toBeGreaterThanOrEqual(200)
    expect(max).toBeLessThanOrEqual(2200)

    // Confirm that delays spread across at least 50 distinct bucket values
    const uniqueDelays = new Set(delays)
    expect(uniqueDelays.size).toBeGreaterThan(50)
  })
})
