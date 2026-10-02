/**
 * T2 offline-queue matrix (Phase D): the fixed queue behaviours, proven
 * through a real browser — real offline toggles, real IndexedDB rows,
 * real drains against the mock. Each row maps to its ledger finding.
 *
 * Shared invariants: zero pageerrors per spec, zero lost rows (synced,
 * still queued, or failed-with-reason — never silently dropped).
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedMock,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
  manualScan,
  queueRows,
  putRawRows,
  liveRow,
  waitForRpc,
} from './helpers.mjs'

const OLD_OPEN = {
  open: { id: 'open-9', status: 'OPEN', in_date: '2026-09-10', in_time: '09:00:00' },
  last_out: null,
}

test.describe('queue matrix', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('M1 full queue reports itself distinctly (L-02)', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    // Freeze the scheduled drain so the fixture survives setup: a hanging
    // RPC never mutates rows, it only burns the attempt's timeout.
    await seedMock(page.request, { scan_in: 'hang' })
    await putRawRows(
      page,
      Array.from({ length: 200 }, (_, i) => liveRow({ id: `fill-${i}`, badge: 'FB5971GA1001' })),
    )
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1002')
    // Explicit choice: the unreachable lookup offers Mark IN; the tap
    // attempts the write, which fails offline and hits the full queue.
    await expect(page.getByRole('button', { name: 'Mark IN' })).toBeVisible()
    await page.getByRole('button', { name: 'Mark IN' }).click()
    // Exact: the popup message contains the toast text as a substring.
    await expect(page.getByText('Offline queue is full', { exact: true })).toBeVisible()
    expect((await queueRows(page)).length).toBe(200)
    guard.assertEmpty()
  })

  test('M2 offline rapid taps deduplicate (L-09)', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    // Tap via keyboard Enter, not the button: the button shifts under
    // toasts/popups (stability waits blow the 2s dupe window), while Enter
    // calls the identical handleScan path. Each tap only OFFERS the choice
    // (nothing is written until tapped): tap 1 offers Mark IN (no pending
    // IN) and the tap queues IN; tap 2 sees the pending IN and offers Mark
    // OUT (C4) and the tap queues OUT; tap 3 lands inside the OUT dupe
    // window and is refused.
    const tap = (badge) =>
      page
        .getByPlaceholder('Manual FB/BH/VS badge')
        .fill(badge)
        .then(() => page.getByPlaceholder('Manual FB/BH/VS badge').press('Enter'))
    const choose = (name) =>
      expect(page.getByRole('button', { name })).toBeVisible().then(() => page.getByRole('button', { name }).click())
    await tap('FB5971GA1003')
    await choose('Mark IN')
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    await tap('FB5971GA1003')
    await choose('Mark OUT')
    // Tap 3 must land AFTER tap 2 completes (else the busy flag swallows it
    // silently) but INSIDE the 2s OUT dupe window from tap 2's enqueue.
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.badge === 'FB5971GA1003').length)
      .toBe(2)
    await tap('FB5971GA1003')
    await choose('Mark OUT')
    await expect(page.getByText(/Already queued/)).toBeVisible()
    const rows = (await queueRows(page)).filter((r) => r.badge === 'FB5971GA1003')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.action).sort()).toEqual(['IN', 'OUT'])
    guard.assertEmpty()
  })

  test('M3 forgot-OUT queues offline with the open session (L-36)', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await seedMock(request, { get_scan_state: OLD_OPEN })
    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA1004')
    await expect(page.getByText('Forgot OUT?')).toBeVisible()

    await context.setOffline(true)
    await page.getByRole('button', { name: 'Close OUT then IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const rows = await queueRows(page)
    const row = rows.find((r) => r.badge === 'FB5971GA1004')
    expect(row).toMatchObject({ action: 'OUT', open_id: 'open-9' })
    // Nothing reached the server while offline — the write survived locally.
    const calls = await mockCalls(request)
    expect(calls.filter((c) => c.rpc === 'scan_out')).toHaveLength(0)
    guard.assertEmpty()
  })

  test('M4 queued OUT drains with its open_id and timestamp', async ({ page, context, request }) => {
    const guard = collectPageErrors(page)
    await seedMock(request, { get_scan_state: OLD_OPEN })
    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA1005')
    await expect(page.getByText('Forgot OUT?')).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Close OUT then IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    await context.setOffline(false)
    const sent = await waitForRpc(
      request,
      (c) => c.rpc === 'scan_out' && c.params?.p_open_id === 'open-9',
    )
    expect(sent.params.p_badge).toBe('FB5971GA1005')
    expect(typeof sent.params.p_ts).toBe('string')
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.badge === 'FB5971GA1005').length, {
        timeout: 25000,
      })
      .toBe(0)
    guard.assertEmpty()
  })

  test('M5 poison row quarantines with reason while neighbours drain (L-04)', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1901')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    await manualScan(page, 'FB5971GA1902')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect.poll(async () => (await queueRows(page)).length).toBe(2)

    await seedMock(request, {
      scan_in_error_for: { FB5971GA1901: { message: 'Not authorized to scan', code: 'AUTH' } },
    })
    await context.setOffline(false)
    await waitForRpc(request, (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA1902')

    const rows = await queueRows(page)
    const poison = rows.find((r) => r.badge === 'FB5971GA1901')
    expect(poison?.failed).toBe(true)
    expect(poison?.failReason).toContain('Not authorized')
    expect(rows.find((r) => r.badge === 'FB5971GA1902')).toBeUndefined()
    guard.assertEmpty()
  })

  test('M6 bad-timestamp row quarantines without blocking the drain', async ({ page, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await putRawRows(page, [
      liveRow({ id: 'bad-ts-e2e', badge: 'FB5971GA1601', ts: 'not-a-date' }),
      liveRow({ id: 'good-ts-e2e', badge: 'FB5971GA1602' }),
    ])
    // No toggles: the scheduled drain fires on its own. End-state only —
    // whichever pass runs first converges to the same rows.
    await expect
      .poll(async () => (await queueRows(page)).find((r) => r.id === 'bad-ts-e2e')?.failed, {
        timeout: 25000,
      })
      .toBe(true)
    const rows = await queueRows(page)
    expect(rows.find((r) => r.id === 'bad-ts-e2e')?.failReason).toBe('bad-timestamp')
    expect(rows.find((r) => r.id === 'good-ts-e2e')).toBeUndefined()
    const calls = await mockCalls(request)
    expect(calls.some((c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA1602')).toBe(true)
    guard.assertEmpty()
  })

  test('M7 stale open_id drops while the drain continues (L-08)', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await seedMock(request, { get_scan_state: OLD_OPEN })
    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA1701')
    await expect(page.getByText('Forgot OUT?')).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Close OUT then IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    await manualScan(page, 'FB5971GA1702')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect.poll(async () => (await queueRows(page)).length).toBe(2)

    await seedMock(request, {
      scan_out_error_for: {
        FB5971GA1701: { message: 'Session does not match badge/schedule', code: 'MISMATCH' },
      },
    })
    await context.setOffline(false)
    // The IN behind it still syncs — one dead row never wedges the queue.
    await waitForRpc(request, (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA1702')
    await expect.poll(async () => (await queueRows(page)).length, { timeout: 25000 }).toBe(0)
    guard.assertEmpty()
  })

  test('M8 manual scans carry the manual flag end to end', async ({ page, context, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1801')
    // The choice popup carries the manual flag through to the commit, so the
    // queued row (and the drained scan_in) keeps its audit mark.
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const row = (await queueRows(page)).find((r) => r.badge === 'FB5971GA1801')
    expect(row?.is_manual).toBe(true)

    await context.setOffline(false)
    const sent = await waitForRpc(
      request,
      (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA1801',
    )
    expect(sent.params.p_is_manual).toBe(true)
    guard.assertEmpty()
  })

  test('M9 clear-failed-scans removes quarantined rows', async ({ page }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await putRawRows(page, [
      liveRow({ id: 'doomed-1', badge: 'FB5971GA1903', failed: true, status: 'failed', failReason: 'x' }),
    ])
    await page.reload()
    await expect(page.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible()
    await page.getByRole('button', { name: 'Clear failed scans' }).click()
    await expect.poll(async () => (await queueRows(page)).length, { timeout: 15000 }).toBe(0)
    guard.assertEmpty()
  })

  test('M10 queued rows survive a reload', async ({ page, context, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1101')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    const before = (await queueRows(page)).find((r) => r.badge === 'FB5971GA1101')
    expect(before).toBeTruthy()

    // A reload needs the network for the document itself, so come back
    // online — but freeze the drain first (a hanging RPC never mutates
    // rows), or the scheduled pass could sync the row before the assert.
    await seedMock(request, { scan_in: 'hang' })
    await context.setOffline(false)
    await page.reload()
    await expect(page.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible()
    // IndexedDB is independent of boot — the row must still be there.
    await expect
      .poll(async () => (await queueRows(page)).find((r) => r.id === before.id), { timeout: 15000 })
      .toBeTruthy()
    guard.assertEmpty()
  })

  test('M11 connectivity pill tracks the browser state', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await expect(page.getByText('Online', { exact: true }).first()).toBeVisible()
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1201')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    // A scan forces the state flush that re-renders the header pill.
    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible()
    guard.assertEmpty()
  })

  test('M12 server-applied replay dedupes instead of sticking (L-04)', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA1301')
    await page.getByRole('button', { name: 'Mark IN' }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    // The server already applied this scan (commit-then-lost-response): the
    // replay answers Already IN, and the row must drop, not stick.
    await seedMock(request, {
      scan_in_error_for: { FB5971GA1301: { message: 'Already IN — session open', code: 'DUP' } },
    })
    await context.setOffline(false)
    await waitForRpc(request, (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA1301')
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.badge === 'FB5971GA1301').length, {
        timeout: 25000,
      })
      .toBe(0)
    guard.assertEmpty()
  })
})
