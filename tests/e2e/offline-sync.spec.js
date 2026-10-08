/**
 * App-level offline sync (offlineSync.js): the drain loop that survives page
 * navigation. The old per-scanner-page drainer unmounted with the page, so a
 * reconnect anywhere else never synced. These specs prove the fix through a
 * real browser: queue on the Attendance tab, LEAVE it, reconnect, and the
 * row still drains — plus the reload round trip with zero further
 * interaction.
 *
 * Shared invariants: zero pageerrors per spec, zero lost rows (synced,
 * still queued, or failed-with-reason — never silently dropped).
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedProfile,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
  loginAsIncharge,
  gotoTab,
  manualScan,
  inchargeScan,
  queueRows,
} from './helpers.mjs'

test.describe('app-level offline sync', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('queued scans drain after leaving the scanner page and reconnecting', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await seedProfile(request, {
      role: 'dept_incharge',
      centre: 'DELHI',
      badge_number: 'INCH01',
      name: 'Incharge One',
    })
    await loginAsIncharge(page)

    await context.setOffline(true)
    await inchargeScan(page, 'FB5971GA2001')
    // Explicit choice first: the unreachable lookup offers Mark IN, and the
    // tap queues it.
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const queued = await queueRows(page)
    const row = queued.find((r) => r.badge === 'FB5971GA2001' && r.action === 'IN')
    expect(row).toBeTruthy()

    // Leave the scanner: the scanner page (and the old page-scoped drainer
    // with it) unmounts here. Reconnecting now must still sync.
    await gotoTab(page, 'Dashboard')
    await expect(page.getByPlaceholder('Enter badge manually (FB/VS)')).toHaveCount(0)

    await context.setOffline(false)
    // The app-level engine replays the queued row with p_nonce = the queue
    // row id, so the server dedupes a commit-then-lost-response replay.
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

  test('queued scans drain after a reload with no further interaction', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)

    await context.setOffline(true)
    await manualScan(page, 'FB5971GA2002')
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const queued = await queueRows(page)
    const row = queued.find((r) => r.badge === 'FB5971GA2002' && r.action === 'IN')
    expect(row).toBeTruthy()

    // Park on a blank page BEFORE reconnecting: the live engine would
    // otherwise race the reload (an in-flight replay torn down mid-RPC
    // records a server call without removing the row), making the replay
    // count non-deterministic. about:blank runs no app code, so the only
    // replay comes from the fresh boot below.
    await page.goto('about:blank')
    // A reload needs the network for the document itself. Boot installs the
    // app-level engine, which kicks a drain immediately — no scan, no
    // navigation, no waiting for an interval tick.
    await context.setOffline(false)
    await page.goto('/')
    await expect(page.getByPlaceholder('Manual FB/VS badge')).toBeVisible()

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(request)
          return calls.filter((c) => c.rpc === 'scan_in' && c.params?.p_nonce === row.id).length
        },
        { timeout: 25000 },
      )
      .toBe(1)

    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.id === row.id).length, {
        timeout: 25000,
      })
      .toBe(0)

    guard.assertEmpty()
  })
})
