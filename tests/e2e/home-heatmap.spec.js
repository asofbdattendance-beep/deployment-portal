/**
 * ASO Home in Bhati Visit mode — the dashboard that used to show no heatmap.
 * Seeds all six sources (plus a stray out-of-window row and a zero-deployed
 * centre), then proves the day strip, centre heatmap and dept matrix render
 * from visit dates — and that one failed feed degrades instead of lying.
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
const STRAY = istDate(10)

const istTime = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date())

async function loginAs(page, email) {
  await page.goto('/')
  await page.getByPlaceholder('Email or badge number').fill(email)
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()
}

async function openHome(page) {
  await page.getByRole('tab', { name: 'Attendance' }).click()
  await page.locator('button.tab-btn', { hasText: 'Home' }).click()
  await expect(page.getByText('Visit status at a glance')).toBeVisible()
}

// Tile buttons carry their value in the accessible name
// ('Attendance % 87% present today' also contains 'present today'), so every
// tile lookup is anchored to the START of its label.
const tileValue = (page, label) =>
  page.getByRole('button', { name: new RegExp(`^${label}`) }).locator('.stat-value')

async function seedHomeSources(request, overrides = {}, { stray = true } = {}) {
  await seedSchedule(request, { visit_start_date: D1, visit_end_date: D3 })
  await seedProfile(request, { role: 'aso' })
  const centreDaily = [
    { event_date: D1, centre: 'DELHI', present: 3, open_now: 0, deployed: 4 },
    { event_date: D2, centre: 'DELHI', present: 2, open_now: 0, deployed: 4 },
    { event_date: D3, centre: 'DELHI', present: 4, open_now: 1, deployed: 4 },
    { event_date: D1, centre: 'MUMBAI', present: 1, open_now: 0, deployed: 2 },
    { event_date: D2, centre: 'MUMBAI', present: 1, open_now: 0, deployed: 2 },
    { event_date: D3, centre: 'MUMBAI', present: 1, open_now: 0, deployed: 2 },
    { event_date: D1, centre: 'EMPTY', present: 0, open_now: 0, deployed: 0 },
  ]
  if (stray) {
    // Stray out-of-window row: the heatmap must never grow a column for it.
    // (The v74 RPC is window-only in prod, so this is defense-in-depth.)
    centreDaily.push({ event_date: STRAY, centre: 'DELHI', present: 9, open_now: 0, deployed: 4 })
  }
  await seedMock(request, {
    attendance_daily_summary: [
      { centre: 'DELHI', dept_name: 'MEDICAL', expected: 4, present: 3, absent: 1, open_now: 1 },
      { centre: 'MUMBAI', dept_name: 'MEDICAL', expected: 2, present: 1, absent: 1, open_now: 0 },
    ],
    attendance_scanner_ops: [
      {
        scanner_badge: 'SC01',
        scanner_name: 'Scanner One',
        scanner_centre: 'DELHI',
        scans_in: 5,
        scans_out: 4,
        open_now: 1,
        manual_scans: 0,
        first_in_time: '09:00:00',
        last_scan_time: istTime(),
      },
      {
        scanner_badge: 'SC02',
        scanner_name: 'Scanner Two',
        scanner_centre: 'MUMBAI',
        scans_in: 1,
        scans_out: 1,
        open_now: 0,
        manual_scans: 0,
        first_in_time: '08:00:00',
        last_scan_time: '00:00:01',
      },
    ],
    attendance_anomalies: [{ rule: 'open_session' }, { rule: 'undeployed_scan' }],
    attendance_centre_daily: centreDaily,
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
      {
        centre: 'MUMBAI',
        department_id: 'dept-1',
        dept_name: 'MEDICAL',
        deployed: 2,
        ever_present: 1,
        never_present: 1,
        open_now: 0,
      },
    ],
    ...overrides,
  })
}

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('KPI tiles read the visit feeds, LIVE pill shows a clean reload', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedHomeSources(request)
  await loginAs(page, 'aso@example.com')
  await openHome(page)

  await expect(tileValue(page, 'Present today')).toHaveText('4')
  await expect(
    page.getByRole('button', { name: /^Present today/ }).locator('.stat-sub'),
  ).toContainText('of 6 deployed')
  await expect(tileValue(page, 'Scanners active')).toHaveText('1/2')
  await expect(tileValue(page, 'Anomalies')).toHaveText('2')

  // The LIVE pill carries the failed-sources suffix only when something
  // actually failed — all green here means a bare reload timestamp.
  const pill = page.locator('.pill-green', { hasText: 'LIVE' })
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute('title', /^Last successful reload/)
  await expect(pill).not.toHaveAttribute('title', /sources failed/)
  errors.assertEmpty()
})

test('present-by-visit-day strip: one row per window day, newest first', async ({
  page,
  request,
}) => {
  const errors = collectPageErrors(page)
  // No stray row here: the day strip renders one row per distinct feed date,
  // and the shared fixture's stray would add a fourth.
  await seedHomeSources(request, {}, { stray: false })
  await loginAs(page, 'aso@example.com')
  await openHome(page)

  await expect(page.getByText('Present by visit day')).toBeVisible()
  const rows = page.locator('.pd-day')
  await expect(rows).toHaveCount(3)
  await expect(rows.first().locator('.pd-day-label')).toHaveAttribute('title', D3)
  await expect(rows.first().locator('.pd-day-count')).toContainText('present')
  errors.assertEmpty()
})

test('centre heatmap: per-day ratios, zero-deployed dash, no stray column', async ({
  page,
  request,
}) => {
  const errors = collectPageErrors(page)
  await seedHomeSources(request)
  await loginAs(page, 'aso@example.com')
  await openHome(page)

  await expect(page.getByText('Attendance by centre')).toBeVisible()
  const table = page.locator('table.att-table-centre')
  await expect(table).toBeVisible()
  await expect(table.locator('thead th.att-day')).toHaveCount(3)
  await expect(table.locator(`thead th.att-day[title="${STRAY}"]`)).toHaveCount(0)

  const delhi = table.locator('tbody tr').filter({
    has: page.locator('th.att-col-badge', { hasText: 'DELHI' }),
  })
  await expect(delhi).toContainText('3/4')
  await expect(delhi).toContainText('4/4')
  const mumbai = table.locator('tbody tr').filter({
    has: page.locator('th.att-col-badge', { hasText: 'MUMBAI' }),
  })
  await expect(mumbai).toContainText('1/2')
  // Zero-deployed centres never enter the matrix: EMPTY has a feed row but
  // no denominator, so it renders nowhere and inflates no total.
  await expect(table.locator('tbody tr', { hasText: 'EMPTY' })).toHaveCount(0)
  await expect(table.locator('tbody tr', { hasText: 'All centres' })).toBeVisible()
  errors.assertEmpty()
})

test('centre × department matrix renders for the visit', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedHomeSources(request)
  await loginAs(page, 'aso@example.com')
  await openHome(page)

  await expect(page.getByText('Centre × department matrix')).toBeVisible()
  await expect(page.getByTestId('matrix-table')).toBeVisible()
  errors.assertEmpty()
})

test('fail-soft: dead visit feed shows an alert, tiles stay green', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  // No stray row here: the day strip renders one row per distinct feed date,
  // and the shared fixture's stray would add a fourth.
  await seedHomeSources(request, { attendance_centre_daily: 'error' })
  await loginAs(page, 'aso@example.com')
  await openHome(page)

  // getByRole name-matching does not cross an alert's nested Retry button
  // (probed live), so the fail-soft assertion filters on text instead.
  const alert = page.getByRole('alert').filter({ hasText: /Visit day totals could not be loaded/ })
  await expect(alert).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible()
  // The five healthy tiles are unaffected by the one dead feed.
  await expect(tileValue(page, 'Present today')).toHaveText('4')
  errors.assertEmpty()
})
