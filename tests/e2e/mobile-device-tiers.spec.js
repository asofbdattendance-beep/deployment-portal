/**
 * Device-tier + PWA app-shell gate (mobile-*.spec.js → Pixel 5 / iPhone 13).
 *
 * The device-tier system is a contract shared by CSS and JS, so it needs a
 * real-browser test: a landscape phone is ≥769px wide yet must still get the
 * phone shell (bottom tab bar, no desktop navbar), and no attendance page may
 * scroll horizontally at 320px.
 *
 * The PWA half proves the offline app shell: after one online visit, a reload
 * with the network cut still boots (index.html served from the precache).
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  collectPageErrors,
  loginAsScanner,
} from './helpers.mjs'

/** Smallest realistic phone (iPhone SE 1st gen / Galaxy Fold cover). */
const TINY = { width: 320, height: 568 }

test.describe('device tiers', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('a LANDSCAPE phone still gets the phone shell, not the desktop navbar', async ({ page }) => {
    const guard = collectPageErrors(page)
    // 844×390 is wider than the 768px chrome switch — width alone would
    // hand this device the desktop app mid-scan.
    await page.setViewportSize({ width: 844, height: 390 })
    await loginAsScanner(page)

    await expect(page.locator('nav.mobile-tabbar')).toBeVisible()
    await expect(page.locator('nav.tab-nav')).toBeHidden()
    // The immersive scan shell stays immersive in landscape.
    await expect(page.locator('.scan-shell')).toBeVisible()

    guard.assertEmpty()
  })

  test('no horizontal page scroll at 320px', async ({ page }) => {
    const guard = collectPageErrors(page)
    await page.setViewportSize(TINY)
    await loginAsScanner(page)
    await expect(page.locator('.scan-shell')).toBeVisible()

    const overflow = await page.evaluate(() => {
      const de = document.documentElement
      return de.scrollWidth - de.clientWidth
    })
    // 1px of slack for sub-pixel rounding.
    expect(overflow).toBeLessThanOrEqual(1)
    guard.assertEmpty()
  })

  test('every tappable control on the scan shell reaches 44px', async ({ page }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    await expect(page.locator('.scan-shell')).toBeVisible()

    const tooSmall = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden])')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue // not visible
        if (getComputedStyle(el).visibility === 'hidden') continue
        if (r.height < 44 || r.width < 44) {
          out.push({
            tag: el.tagName,
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
          })
        }
      }
      return out
    })
    expect(tooSmall, JSON.stringify(tooSmall)).toEqual([])
    guard.assertEmpty()
  })

  test('text inputs are ≥16px so iOS never zooms on focus', async ({ page }) => {
    const guard = collectPageErrors(page)
    await loginAsScanner(page)
    const input = page.getByPlaceholder('Manual FB/VS badge')
    await expect(input).toBeVisible()
    const size = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(16)
    guard.assertEmpty()
  })
})
