/**
 * Phone fit for the Home Bhati Visit heatmap (Pixel 5 project only).
 * The heatmap is a wide grid by nature: on a phone the PAGE must never
 * scroll sideways — the grid scrolls inside its own region instead.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedMock,
  seedProfile,
  seedSchedule,
  istDate,
  collectPageErrors,
} from './helpers.mjs'

const D1 = istDate(-1)
const D2 = istDate(0)
const D3 = istDate(1)

test.beforeEach(async ({ request }) => {
  await resetMock(request)
  await seedSchedule(request, { visit_start_date: D1, visit_end_date: D3 })
  await seedProfile(request, { role: 'aso' })
  await seedMock(request, {
    attendance_daily_summary: [
      { centre: 'DELHI', dept_name: 'MEDICAL', expected: 4, present: 3, absent: 1, open_now: 1 },
    ],
    attendance_scanner_ops: [],
    attendance_anomalies: [],
    attendance_centre_daily: [
      { event_date: D1, centre: 'DELHI', present: 3, open_now: 0, deployed: 4 },
      { event_date: D2, centre: 'DELHI', present: 2, open_now: 0, deployed: 4 },
      { event_date: D3, centre: 'DELHI', present: 4, open_now: 1, deployed: 4 },
    ],
    attendance_visit_summary: [
      {
        centre: 'DELHI',
        department_id: 'dept-1',
        dept_name: 'MEDICAL',
        deployed: 4,
        ever_present: 3,
        never_present: 1,
        open_now: 1,
      },
    ],
  })
})

test('heatmap fits a phone: page never scrolls sideways', async ({ page }) => {
  const guard = collectPageErrors(page)
  await page.goto('/')
  await page.getByPlaceholder('Email or badge number').fill('aso@example.com')
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()

  await expect(page.locator('nav.mobile-tabbar')).toBeVisible()
  await expect(page.locator('nav.tab-nav')).toBeHidden()

  await page.getByRole('tab', { name: 'Attendance' }).click()
  await page.locator('nav.mobile-tabbar').getByRole('button', { name: 'Home' }).click()

  const table = page.locator('table.att-table-centre')
  await expect(table).toBeVisible()
  await expect(table.locator('thead th.att-day')).toHaveCount(3)

  // The grid region scrolls internally; the document itself must not.
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    region: (() => {
      const r = document.querySelector('.att-scroll[role="region"]')
      if (!r) return -1
      return r.scrollWidth - r.clientWidth
    })(),
  }))
  expect(overflow.doc).toBeLessThanOrEqual(1)
  expect(overflow.region).toBeGreaterThanOrEqual(0)

  // Content survived the squeeze: ratios still render.
  await expect(table).toContainText('3/4')
  guard.assertEmpty()
})
