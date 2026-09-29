/**
 * T2 rig, first specs (Phase D): boot-to-scanner against the mock backend,
 * then the offline-queue round trip the unit suite cannot prove — a real
 * browser going offline, a real IndexedDB row, a real drain on reconnect.
 *
 * Invariants every spec in this file holds:
 * - zero pageerrors (an unhandled rejection anywhere fails the spec), and
 * - zero lost rows (everything queued offline is either synced or still
 *   queued with a reason — never silently dropped).
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
  manualScan,
  queueRows,
} from './helpers.mjs'

test.describe('scanner offline round trip', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('boots through login to the scanner with a live RPC path', async ({ page, request }) => {
    const guard = collectPageErrors(page)

    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA0001')
    await expect(page.getByText('Checked In')).toBeVisible()

    const calls = await mockCalls(request)
    expect(calls.some((c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA0001')).toBe(true)
    guard.assertEmpty()
  })

  test('offline scans queue in IndexedDB and drain on reconnect with the queued nonce', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)

    await loginAsScanner(page)

    await context.setOffline(true)
    await manualScan(page, 'FB5971GA0002')
    // Exact: the popup message ("Queued offline — will sync when online")
    // contains the title as a substring, so a loose match is ambiguous.
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const queued = await queueRows(page)
    const row = queued.find((r) => r.badge === 'FB5971GA0002' && r.action === 'IN')
    expect(row).toBeTruthy()

    await context.setOffline(false)
    // The drain replays the queued row with p_nonce = the queue row id (D-3),
    // so the server can dedupe a commit-then-lost-response replay.
    await expect
      .poll(
        async () => {
          const calls = await mockCalls(request)
          return calls.filter((c) => c.rpc === 'scan_in' && c.params?.p_nonce === row.id).length
        },
        { timeout: 25000 },
      )
      .toBe(1)

    // Synced rows leave the queue — nothing lost, nothing stuck.
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.id === row.id).length, {
        timeout: 25000,
      })
      .toBe(0)

    guard.assertEmpty()
  })
})
