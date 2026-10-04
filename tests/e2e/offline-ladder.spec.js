/**
 * Offline ladder: basics to advanced, from scratch, like a real user.
 *
 * Every test starts clean (resetMock + fresh browser context) and walks the
 * scanner the way an operator does — open, scan, read the popup, lose the
 * network, queue, reconnect, verify. Later rungs cover the fixed failure
 * modes: ordering, poison neighbours, the permanent circuit breaker,
 * bursts, and two tabs sharing one outbox.
 *
 * Shared invariants: zero pageerrors per test, zero lost rows (synced,
 * still queued, or failed-with-reason — never silently dropped).
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedMock,
  mockCalls,
  waitForRpc,
  collectPageErrors,
  loginAsScanner,
  manualScan,
  queueRows,
} from './helpers.mjs'

test.describe('offline ladder', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('L1 basics: login lands on a working scanner', async ({ page }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await expect(page.getByText('Scanner One')).toBeVisible()
    await expect(page.getByText('Online', { exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible()
    guard.assertEmpty()
  })

  test('L2 online IN names the sewadar in the success popup', async ({
    page,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA4002')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(dialog.getByText('Checked In')).toBeVisible()
    await expect(dialog.getByText('RAM')).toBeVisible()
    await expect(dialog.getByText('DELHI')).toBeVisible()
    await expect(dialog.getByText('MEDICAL', { exact: true })).toBeVisible()
    const sent = await waitForRpc(request, (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA4002')
    expect(typeof sent.params.p_nonce).toBe('string')
    guard.assertEmpty()
  })

  test('L3 online OUT closes the open session', async ({ page, request }) => {
    const guard = collectPageErrors(page)
    // A same-day open session (<12h) takes the explicit confirm path; an
    // older one would take the forgot-OUT form instead.
    const istToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const istHourAgo = new Date(Date.now() - 3600000).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    })
    await seedMock(request, {
      get_scan_state: {
        open: { id: 'open-9', status: 'OPEN', in_date: istToday, in_time: istHourAgo },
        last_out: null,
      },
    })
    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA4003')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark OUT', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark OUT', exact: true }).click()
    await expect(dialog.getByText('Checked Out')).toBeVisible()
    const sent = await waitForRpc(
      request,
      (c) => c.rpc === 'scan_out' && c.params?.p_open_id === 'open-9',
    )
    expect(sent.params.p_badge).toBe('FB5971GA4003')
    guard.assertEmpty()
  })

  test('L4 offline scan queues with a healthy row, then drains on reconnect', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA4004')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const queued = await queueRows(page)
    const row = queued.find((r) => r.badge === 'FB5971GA4004')
    expect(row).toMatchObject({ action: 'IN', owner: 'user-scanner-1', synced: false })
    expect(row.attempts || 0).toBe(0)
    expect(typeof row.id).toBe('string')

    // Nothing reached the server while offline.
    expect((await mockCalls(request)).filter((c) => c.rpc === 'scan_in')).toHaveLength(0)

    await context.setOffline(false)
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

  test('L5 rapid double input queues exactly once', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    const manual = page.getByPlaceholder('Manual FB/BH/VS badge')
    await manual.fill('FB5971GA4005')
    await manual.press('Enter')
    // A second scan while the decision popup is open is dropped, not queued.
    await manual.fill('FB5971GA4005')
    await manual.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.badge === 'FB5971GA4005').length, {
        timeout: 10000,
      })
      .toBe(1)
    await context.setOffline(false)
    guard.assertEmpty()
  })

  test('L6 offline IN then OUT drains in order', async ({ page, context, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA4006')
    let dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    // The queued popup auto-dismisses (~2.5s); the pending IN then offers OUT.
    await manualScan(page, 'FB5971GA4006')
    dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark OUT', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark OUT', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    expect(await queueRows(page)).toHaveLength(2)

    await context.setOffline(false)
    await expect
      .poll(async () => (await mockCalls(request)).filter((c) => c.rpc === 'scan_in').length, {
        timeout: 25000,
      })
      .toBe(1)
    await expect
      .poll(async () => (await mockCalls(request)).filter((c) => c.rpc === 'scan_out').length, {
        timeout: 25000,
      })
      .toBe(1)
    // IN replayed before OUT (lock-step drain order).
    const calls = await mockCalls(request)
    expect(calls.map((c) => c.rpc).filter((r) => r === 'scan_in' || r === 'scan_out')).toEqual([
      'scan_in',
      'scan_out',
    ])
    await expect.poll(async () => (await queueRows(page)).length, { timeout: 25000 }).toBe(0)
    guard.assertEmpty()
  })

  test('L7 poison row quarantines with reason while the neighbour drains', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await seedMock(request, {
      scan_in_error_for: {
        FB5971GA4011: { message: 'Not authorized to scan', code: '42501' },
      },
    })
    await context.setOffline(true)
    for (const badge of ['FB5971GA4011', 'FB5971GA4012']) {
      await manualScan(page, badge)
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
      await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
      // Let the queued ack dismiss before the next scan.
      await expect(page.getByText('Queued offline', { exact: true })).toBeHidden({ timeout: 10000 })
    }
    await context.setOffline(false)
    await expect
      .poll(
        async () =>
          (await mockCalls(request)).filter(
            (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA4012',
          ).length,
        { timeout: 25000 },
      )
      .toBe(1)
    // The good row synced; the poison row is failed-with-visibility, not silent
    // (both the global sync pill and the scanner recovery bar surface it —
    // assert the recovery bar's exact pill).
    await expect(page.getByText('1 failed', { exact: true })).toBeVisible({ timeout: 25000 })
    const rows = await queueRows(page)
    expect(rows.find((r) => r.badge === 'FB5971GA4011')?.failed).toBe(true)
    expect(rows.find((r) => r.badge === 'FB5971GA4012')).toBeUndefined()
    guard.assertEmpty()
  })

  test('L8 systemic failure breaks the pass instead of mass-quarantining', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(90000)
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await seedMock(request, {
      scan_in_error_for: {
        FB5971GA4021: { message: 'Not authorized to scan', code: '42501' },
        FB5971GA4022: { message: 'Not authorized to scan', code: '42501' },
        FB5971GA4023: { message: 'Not authorized to scan', code: '42501' },
      },
    })
    await context.setOffline(true)
    for (const badge of ['FB5971GA4021', 'FB5971GA4022', 'FB5971GA4023', 'FB5971GA4024']) {
      await manualScan(page, badge)
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
      await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
      await expect(page.getByText('Queued offline', { exact: true })).toBeHidden({ timeout: 10000 })
    }
    await context.setOffline(false)
    // Three consecutive permanents trip the breaker: the tail stays live and
    // drains on a later pass instead of being terminally quarantined unseen.
    await expect
      .poll(async () => (await queueRows(page)).filter((r) => r.failed).length, {
        timeout: 25000,
      })
      .toBe(3)
    const spared = (await queueRows(page)).find((r) => r.badge === 'FB5971GA4024')
    expect(spared.failed).not.toBe(true)
    await expect
      .poll(
        async () =>
          (await mockCalls(request)).filter(
            (c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA4024',
          ).length,
        { timeout: 40000 },
      )
      .toBe(1)
    await expect.poll(async () => (await queueRows(page)).filter((r) => !r.failed).length, {
      timeout: 25000,
    }).toBe(0)
    guard.assertEmpty()
  })

  test('L9 burst of five drains completely', async ({ page, context, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    for (let i = 0; i < 5; i++) {
      const badge = `FB5971GA403${i}`
      await manualScan(page, badge)
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
      await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
      await expect(page.getByText('Queued offline', { exact: true })).toBeHidden({ timeout: 10000 })
    }
    expect(await queueRows(page)).toHaveLength(5)
    await context.setOffline(false)
    await expect
      .poll(async () => (await mockCalls(request)).filter((c) => c.rpc === 'scan_in').length, {
        timeout: 25000,
      })
      .toBe(5)
    await expect.poll(async () => (await queueRows(page)).length, { timeout: 25000 }).toBe(0)
    guard.assertEmpty()
  })

  test('L10 two tabs share one outbox with exactly one replay', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await context.setOffline(true)
    await manualScan(page, 'FB5971GA4101')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()
    const row = (await queueRows(page)).find((r) => r.badge === 'FB5971GA4101')
    expect(row).toBeTruthy()

    // Reconnect, then open a second tab on the same origin: both engines
    // race the same row, the Web Lock serializes them, exactly one replay.
    await context.setOffline(false)
    const pageB = await context.newPage()
    await pageB.goto('/')
    await expect(pageB.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible()
    await expect
      .poll(
        async () => {
          const calls = await mockCalls(request)
          return calls.filter((c) => c.rpc === 'scan_in' && c.params?.p_nonce === row.id).length
        },
        { timeout: 25000 },
      )
      .toBe(1)
    await expect.poll(async () => (await queueRows(page)).length, { timeout: 25000 }).toBe(0)
    await pageB.close()
    guard.assertEmpty()
  })
})
