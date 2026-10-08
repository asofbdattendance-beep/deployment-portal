/**
 * Mobile-first attendance smoke (Pixel 5 / iPhone 13 projects only — see
 * playwright.config.js testMatch). Proves the phone layer against the mock
 * backend: bottom tab bar replaces the desktop navbar, the immersive scan
 * shell captures a real scan, and the feed/export chrome is reachable.
 *
 * Invariants: zero pageerrors, and the desktop DOM (tab-nav) stays hidden
 * at phone widths.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
  manualScan,
} from './helpers.mjs'

test.describe('mobile attendance shell', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('phone shows the bottom bar and scan shell, never the desktop navbar', async ({ page }) => {
    const guard = collectPageErrors(page)

    await loginAsScanner(page)

    // The scanner role has one page: bar with no More button.
    await expect(page.locator('nav.mobile-tabbar')).toBeVisible()
    await expect(page.locator('nav.tab-nav')).toBeHidden()
    await expect(page.getByRole('button', { name: /More pages/ })).toBeHidden()

    // Immersive shell chrome.
    await expect(page.locator('.scan-shell')).toBeVisible()
    const go = page.locator('.scan-shell-go')
    await expect(go).toBeVisible()
    const box = await go.boundingBox()
    expect(box.height).toBeGreaterThanOrEqual(44)

    // Manual entry never triggers the iOS zoom (≥16px).
    const size = await page.getByPlaceholder('Manual FB/VS badge').evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize)
    )
    expect(size).toBeGreaterThanOrEqual(16)

    guard.assertEmpty()
  })

  test('a manual scan captures end-to-end inside the phone shell', async ({ page, request }) => {
    const guard = collectPageErrors(page)

    await loginAsScanner(page)
    await manualScan(page, 'FB5971GA0001')

    // Explicit choice popup renders as a bottom sheet on phones. Scoped to
    // the dialog with an exact name: the shell's own "Mark In/Out" action
    // also contains "Mark IN" as a substring.
    const markIn = page.getByRole('dialog').getByRole('button', { name: 'Mark IN', exact: true })
    await expect(markIn).toBeVisible()
    let calls = await mockCalls(request)
    expect(calls.some((c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA0001')).toBe(false)

    await markIn.click()
    await expect(page.getByText('Checked In')).toBeVisible()

    calls = await mockCalls(request)
    expect(calls.some((c) => c.rpc === 'scan_in' && c.params?.p_badge === 'FB5971GA0001')).toBe(true)

    // The shell's feed region is mounted (the mock backend answers scan_in
    // without persisting a session row, so row-level feed content is pinned
    // by the MobileScanFeed unit suite, not here).
    await expect(page.locator('.scan-shell-feed')).toBeVisible()

    guard.assertEmpty()
  })

  test('phone gets the PWA installability contract', async ({ page, request }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)

    // Safe-area viewport (viewport-fit=cover makes the insets real).
    const viewport = await page.getAttribute('meta[name="viewport"]', 'content')
    expect(viewport).toContain('viewport-fit=cover')

    // Manifest with standalone display + sized icons.
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href')
    expect(manifestHref).toBeTruthy()
    const res = await request.get(manifestHref)
    expect(res.ok()).toBe(true)
    const manifest = await res.json()
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true)

    guard.assertEmpty()
  })
})
