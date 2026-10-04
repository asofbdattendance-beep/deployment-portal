/**
 * Offline reload keeps the scanner alive with REAL identity (PWA gate →
 * the `mobile-pwa` preview project, because only a production build has a
 * service worker to serve the reloaded document with no network).
 *
 * Proves, through a real browser: log in online, seed the offline identity
 * caches, cut the network, RELOAD, and the scanner still scans — the
 * explicit-choice popup names the sewadar (name + home centre + deployed
 * dept, all from local caches) and the tap queues. Also proves nothing the
 * page needed failed to load (no dead chunks, no dead engine).
 *
 * Shared invariants: zero pageerrors, zero lost rows.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
  queueRows,
  seedOfflineIdentity,
} from './helpers.mjs'

test.describe('offline reload identity', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('an offline reload still scans with name, centre and dept in the popup', async ({
    page,
    context,
    request,
  }) => {
    const guard = collectPageErrors(page)
    // Anything the page needed but could not load (a chunk that missed the
    // precache, the scan engine, data) surfaces here. Supabase attempts are
    // expected to fail while offline, so they are filtered below.
    const failedRequests = []
    page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), type: r.resourceType() }))

    await loginAsScanner(page)
    // Wait for the service worker to control this page before cutting the
    // network — otherwise the offline reload has no document to serve.
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return
      await navigator.serviceWorker.ready.catch(() => {})
    })

    await seedOfflineIdentity(page, {
      badge: 'FB5971GA3001',
      name: 'RAM PRASAD',
      centre: 'DELHI',
      deptId: 'dept-1',
      deptName: 'MEDICAL',
    })

    await context.setOffline(true)
    await page.reload()
    // The app boots offline from the precached shell + the localStorage
    // caches (profile, schedules) — the scanner is reachable with no
    // network at all.
    await expect(page.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible({ timeout: 20000 })

    // The scanner is alive: scan → the unreachable lookup offers Mark IN.
    const manual = page.getByPlaceholder('Manual FB/BH/VS badge')
    await manual.fill('FB5971GA3001')
    await manual.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible()
    // Real results, all from local caches: name + home centre from the
    // directory snapshot, deployed dept via the cached department map.
    await expect(dialog.getByText('RAM PRASAD')).toBeVisible()
    await expect(dialog.getByText('DELHI')).toBeVisible()
    await expect(dialog.getByText('MEDICAL', { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Mark IN', exact: true }).click()
    await expect(page.getByText('Queued offline', { exact: true })).toBeVisible()

    const queued = await queueRows(page)
    expect(queued.find((r) => r.badge === 'FB5971GA3001' && r.action === 'IN')).toBeTruthy()

    // Nothing the shell, the chunks, or the scan engine needed failed to
    // load — only the (expected, offline) Supabase attempts may fail.
    const bad = failedRequests.filter(
      ({ url, type }) =>
        !url.includes('127.0.0.1:54321') &&
        ['document', 'script', 'stylesheet', 'fetch', 'xhr', 'worker'].includes(type),
    )
    expect(bad).toEqual([])

    // And nothing reached the server while offline — the write survived locally.
    const calls = await mockCalls(request)
    expect(calls.filter((c) => c.rpc === 'scan_in')).toHaveLength(0)

    await context.setOffline(false)
    guard.assertEmpty()
  })
})
