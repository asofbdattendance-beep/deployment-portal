/**
 * Shared SewaView register in BHATI VISIT mode — the previsit UX ported
 * over, dates being the only difference. Seeds per (date, mode) present +
 * absent pairs, a stray out-of-window daily row, an open session and an
 * undeployed scan, then proves the register reads them the way previsit did.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedMock,
  seedProfile,
  seedSchedule,
  istDate,
  mockCalls,
  collectPageErrors,
} from './helpers.mjs'

const D1 = istDate(-1)
const D2 = istDate(0)
const D3 = istDate(1)
const STRAY = istDate(10)

const badge = (n, name, centre, dept = 'MEDICAL') => ({
  badge_number: n,
  sewadar_name: name,
  sewadar_centre: centre,
  department_id: 'dept-1',
  dept_name: dept,
  is_vss: false,
})

async function loginAs(page, email) {
  await page.goto('/')
  await page.getByPlaceholder('Email or badge number').fill(email)
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()
}

async function openVisitReports(page) {
  await page.getByRole('tab', { name: 'Attendance' }).click()
  await page.locator('button.tab-btn', { hasText: 'Reports' }).click()
  await expect(page.getByRole('heading', { name: /Bhati Visit Register/ })).toBeVisible()
}

async function seedVisitRegister(request) {
  await seedSchedule(request, { visit_start_date: D1, visit_end_date: D3 })
  await seedProfile(request, { role: 'aso' })
  const ram = badge('FB0001', 'RAM', 'DELHI')
  const shyam = badge('FB0002', 'SHYAM', 'DELHI')
  const ghanshyam = badge('FB0003', 'GHANSHYAM', 'MUMBAI')
  await seedMock(request, {
    attendance_day_badges: {
      __byParams: {
        [`${D1}|present`]: [ram, shyam],
        [`${D1}|absent`]: [ghanshyam],
        [`${D2}|present`]: [ram],
        [`${D2}|absent`]: [shyam, ghanshyam],
        [`${D3}|present`]: [ram],
        [`${D3}|absent`]: [shyam, ghanshyam],
      },
    },
    attendance_centre_daily: [
      { event_date: D1, centre: 'DELHI', present: 2, open_now: 0, deployed: 2 },
      { event_date: D2, centre: 'DELHI', present: 1, open_now: 0, deployed: 2 },
      { event_date: D3, centre: 'DELHI', present: 1, open_now: 1, deployed: 2 },
      { event_date: D1, centre: 'MUMBAI', present: 0, open_now: 0, deployed: 1 },
      { event_date: D2, centre: 'MUMBAI', present: 0, open_now: 0, deployed: 1 },
      { event_date: D3, centre: 'MUMBAI', present: 0, open_now: 0, deployed: 1 },
      // Stray out-of-window row: must never grow a column.
      { event_date: STRAY, centre: 'DELHI', present: 9, open_now: 0, deployed: 2 },
    ],
    attendance_sewadar_summary: [
      {
        badge_number: 'FB0001',
        sewadar_name: 'RAM',
        sewadar_centre: 'DELHI',
        dept_name: 'MEDICAL',
        is_vss: false,
        first_in_date: D3,
        first_in_time: '09:00:00',
        still_open: true,
        undeployed_scan: false,
      },
      {
        badge_number: 'FB9999',
        sewadar_name: 'UNDEPLOYED ONE',
        sewadar_centre: 'DELHI',
        dept_name: 'MEDICAL',
        is_vss: false,
        first_in_date: D2,
        first_in_time: '10:00:00',
        still_open: false,
        undeployed_scan: true,
      },
    ],
  })
}

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('register chrome: visit vocab, four tabs, never an Absent tab', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await expect(page.getByRole('tablist', { name: 'Visit list' })).toBeVisible()
  for (const name of ['Total', 'Present', 'Attention', 'Logs']) {
    await expect(page.getByRole('tab', { name: new RegExp(`^${name} \\(`) })).toBeVisible()
  }
  await expect(page.getByRole('tab', { name: /Absent/ })).toHaveCount(0)
  await expect(page.getByLabel('Search visit rows')).toBeVisible()
  errors.assertEmpty()
})

test('columns are pinned to the window: stray date never appears', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  const chips = page.locator('button.day-chip')
  await expect(chips).toHaveCount(4) // All + 3 window days
  for (const d of [D1, D2, D3]) {
    await expect(page.locator(`button.day-chip[title="${d}"]`)).toBeVisible()
  }
  await expect(page.locator(`button.day-chip[title="${STRAY}"]`)).toHaveCount(0)
  const dayHeads = page.locator('table.att-table thead th.att-day[title]')
  await expect(dayHeads).toHaveCount(3)
  await expect(page.locator(`table.att-table thead th.att-day[title="${STRAY}"]`)).toHaveCount(0)
  errors.assertEmpty()
})

test('total matrix: deployed union with per-day present/absent cells', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await page.getByRole('tab', { name: /^Total \(/ }).click()
  // RAM present all 3 days; GHANSHYAM deployed but never present.
  await expect(page.getByText('3/3').first()).toBeVisible()
  await expect(page.getByText('0/3').first()).toBeVisible()
  errors.assertEmpty()
})

test('present register filters by day chip + search', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await page.getByRole('tab', { name: /^Present \(/ }).click()
  await page.locator(`button.day-chip[title="${D2}"]`).click()
  await page.getByLabel('Search visit rows').fill('FB0002')
  await expect(page.getByText('No visit attendance recorded')).toBeVisible()

  await page.getByLabel('Search visit rows').fill('FB0001')
  // 1 filtered row of all 5 live rows (the count total ignores the day chip).
  await expect(page.locator('.previsit-count')).toContainText('1 of 5 records')
  errors.assertEmpty()
})

test('attention: open session + undeployed scan sections', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await page.getByRole('tab', { name: /^Attention \(/ }).click()
  // The register defaults to the newest day (D3): the D2 undeployed row
  // needs the All chip before its section can render.
  await page.locator('button.day-chip', { hasText: /^All/ }).click()
  await expect(page.getByText('Open sessions (1)')).toBeVisible()
  await expect(page.getByText('Undeployed scans (1)')).toBeVisible()
  await expect(page.getByText('FB9999')).toBeVisible()
  errors.assertEmpty()
})

test('row drill-in opens the scan-trail dialog', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await page.getByRole('tab', { name: /^Present \(/ }).click()
  await page.getByLabel('Open details for FB0001').click()
  await expect(page.getByRole('dialog', { name: 'Anomaly details for FB0001' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'This anomaly' })).toBeVisible()
  await page.getByLabel('Close anomaly details').click()
  errors.assertEmpty()
})

test('logs tab: empty scan log is honest, not an error', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  await page.getByRole('tab', { name: /^Logs \(/ }).click()
  await expect(page.getByText('No scans logged')).toBeVisible()
  errors.assertEmpty()
})

test('export downloads a visit-slugged workbook', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Excel' }).click(),
  ])
  const filename = download.suggestedFilename()
  expect(filename).toContain('visit')
  expect(filename).not.toContain('previsit')
  errors.assertEmpty()
})

test('visit fan-out: exact params, zero previsit calls', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedVisitRegister(request)
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  // Dev StrictMode double-mounts the hook (prod mounts once), so call
  // COUNTS vary by build: assert the covered (date, mode) SET instead.
  await expect
    .poll(async () =>
      [
        ...new Set(
          (await mockCalls(request))
            .filter((c) => c.rpc === 'attendance_day_badges')
            .map((c) => `${c.params.p_date}|${c.params.p_mode}`),
        ),
      ].sort(),
    )
    .toEqual([D1, D2, D3].flatMap((d) => [`${d}|absent`, `${d}|present`]).sort())
  const calls = await mockCalls(request)
  expect(calls.filter((c) => String(c.rpc).startsWith('previsit_'))).toEqual([])
  expect(calls.filter((c) => c.rpc === 'attendance_centre_daily').length).toBeGreaterThanOrEqual(1)
  expect(calls.filter((c) => c.rpc === 'attendance_sewadar_summary').length).toBeGreaterThanOrEqual(1)
  const badgeParams = [
    ...new Set(
      calls
        .filter((c) => c.rpc === 'attendance_day_badges')
        .map((c) => `${c.params.p_date}|${c.params.p_mode}`),
    ),
  ].sort()
  expect(badgeParams).toEqual(
    [D1, D2, D3].flatMap((d) => [`${d}|absent`, `${d}|present`]).sort(),
  )
  for (const c of calls.filter((c) => c.rpc === 'attendance_day_badges')) {
    expect(c.params.p_schedule).toBe('sched-1')
  }
  errors.assertEmpty()
})
