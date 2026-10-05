/**
 * PWA app-shell gate (pwa-*.spec.js → the `mobile-pwa` preview project).
 *
 * A service worker only exists in a PRODUCTION build (vite-plugin-pwa
 * `devOptions.enabled: false`), so these specs run against `vite preview`
 * rather than the dev server — asserting installability against a dev server
 * would be a test that can never fail.
 *
 * Proves: the SW registers and precaches the shell, the app boots with the
 * network cut, the global offline banner tracks connectivity, and the
 * manifest no longer locks rotation.
 */
import { test, expect } from '@playwright/test'
import {
  collectPageErrors,
  loginAsScanner,
  resetMock,
} from './helpers.mjs'

test.describe('PWA app shell', () => {
  // The mock server is shared across the whole run (workers: 1): an aso
  // profile seeded by an earlier suite would otherwise leak in here and the
  // scanner login would land on Schedule Maker instead of the scan shell.
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })
  test('the service worker registers and precaches the shell', async ({ page }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)

    const reg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null
      const r = await navigator.serviceWorker.ready.catch(() => null)
      return r ? { scope: r.scope, active: !!r.active } : null
    })
    expect(reg).not.toBeNull()
    expect(reg.active).toBe(true)

    guard.assertEmpty()
  })

  test('the app boots offline from the precached shell', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    // Wait for the SW to control this page before cutting the network.
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return
      await navigator.serviceWorker.ready.catch(() => {})
    })

    await context.setOffline(true)
    try {
      await page.reload()
      // The shell rendered from the precache. Data CANNOT load (Supabase is
      // NetworkOnly), so the app shows its own profile-load failure — that is
      // the proof: React mounted and ran with no network at all.
      await expect(page.locator('#root')).toBeVisible()
      // The offline banner only appears if the app's JS executed AND the
      // browser reports offline — i.e. this is not a cached static blob.
      await expect(page.locator('.offline-banner')).toBeVisible()
      await expect(page.locator('body')).toContainText(/Try again|Couldn|Sign in/i)
    } finally {
      await context.setOffline(false)
    }

    guard.assertEmpty()
  })

  test('the global offline banner appears when connectivity drops', async ({ page, context }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await expect(page.locator('.offline-banner')).toHaveCount(0)

    await context.setOffline(true)
    await expect(page.locator('.offline-banner')).toBeVisible()
    await context.setOffline(false)
    await expect(page.locator('.offline-banner')).toHaveCount(0)

    guard.assertEmpty()
  })

  test('the manifest allows rotation (no portrait lock)', async ({ page, request }) => {
    // Navigate first — `page` starts at about:blank, which has no manifest.
    await loginAsScanner(page)
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href')
    const manifest = await (await request.get(manifestHref)).json()
    // Decision D-B: the portal rotates freely — an installed PWA used to be
    // locked to portrait, which broke the scan shell in landscape.
    expect(manifest.orientation).toBeUndefined()
    expect(manifest.display).toBe('standalone')
    expect(manifest.id).toBeTruthy()
  })
})