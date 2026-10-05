/**
 * Visit data-layer contract, proven through the UI's real RPC fan-out.
 * The hook fires 2 + 2×N calls (centre daily + per-date present/absent +
 * sewadar summary) with exact params, never touches a previsit_* RPC in
 * the visit lens, never fires day_badges without a window, and surfaces
 * a failed feed as a named error instead of a silent zero.
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

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('fan-out shape: 2 + 2N calls, ascending dates, both modes', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedSchedule(request, { visit_start_date: D1, visit_end_date: D3 })
  await seedProfile(request, { role: 'aso' })
  await seedMock(request, {
    attendance_day_badges: {
      __byParams: {
        [`${D1}|present`]: [
          {
            badge_number: 'FB0001',
            sewadar_name: 'RAM',
            sewadar_centre: 'DELHI',
            department_id: 'dept-1',
            dept_name: 'MEDICAL',
            is_vss: false,
          },
        ],
      },
    },
    attendance_centre_daily: [],
    attendance_sewadar_summary: [],
  })
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

  // Single-shot feeds fire with just the schedule (at least once each).
  const daily = calls.filter((c) => c.rpc === 'attendance_centre_daily')
  expect(daily.length).toBeGreaterThanOrEqual(1)
  expect(daily[0].params).toEqual({ p_schedule: 'sched-1' })
  const summary = calls.filter((c) => c.rpc === 'attendance_sewadar_summary')
  expect(summary.length).toBeGreaterThanOrEqual(1)
  expect(summary[0].params).toEqual({ p_schedule: 'sched-1' })

  // Per-date pair: ascending dates, present before absent is not required,
  // but every (date, mode) pair must be asked.
  const pairs = [...new Set(
    calls
      .filter((c) => c.rpc === 'attendance_day_badges')
      .map((c) => `${c.params.p_date}|${c.params.p_mode}`),
  )].sort()
  expect(pairs).toEqual([D1, D2, D3].flatMap((d) => [`${d}|absent`, `${d}|present`]).sort())

  // No previsit RPC in the visit lens — the cutover holds at the wire level.
  expect(calls.filter((c) => String(c.rpc).startsWith('previsit_'))).toEqual([])
  errors.assertEmpty()
})

test('failed feed raises an alert, never a silent zero', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedSchedule(request, { visit_start_date: D1, visit_end_date: D3 })
  await seedProfile(request, { role: 'aso' })
  await seedMock(request, { attendance_day_badges: 'error' })
  await loginAs(page, 'aso@example.com')
  await openVisitReports(page)

  // fetchAllRpc surfaces the backend text verbatim (no RPC-name prefix) —
  // what matters is the alert, not a healthy-looking zero.
  await expect(page.locator('.card[role="alert"]')).toContainText('seeded error')
  errors.assertEmpty()
})

test('windowless schedule fires no day_badges at all', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  // Default sched-1 has no window: the lens is Bhati Visit with an honest
  // empty dashboard, and the per-date hook never fires — not even once.
  await seedProfile(request, { role: 'aso' })
  await loginAs(page, 'aso@example.com')
  await page.getByRole('tab', { name: 'Attendance' }).click()
  await page.locator('button.tab-btn', { hasText: 'Home' }).click()
  await expect(page.getByText('No visit dates set for this schedule')).toBeVisible()

  // Give the page every chance to fire a stray call, then assert none did.
  await page.waitForTimeout(2000)
  const calls = await mockCalls(request)
  expect(calls.filter((c) => c.rpc === 'attendance_day_badges')).toEqual([])
  // The dashboard still loads its single-shot feed (empty rows → honest
  // empty state), while the previsit lens fires nothing at all.
  expect(calls.filter((c) => c.rpc === 'attendance_centre_daily').length).toBeGreaterThanOrEqual(1)
  expect(calls.filter((c) => String(c.rpc).startsWith('previsit_'))).toEqual([])
  errors.assertEmpty()
})
