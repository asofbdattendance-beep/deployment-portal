/**
 * Bhati-first cutover — real-user routing flows.
 *
 * Proves the sewa-mode lens the way users meet it: which dashboard renders,
 * whether the header toggle exists, and what the scanner pill reads —
 * before the cutoff, after the cutoff, for test vs real logins, and with
 * no window at all. Schedule windows are computed relative to the real
 * today (IST); nothing is hardcoded.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedProfile,
  seedSchedule,
  istDate,
  mockCalls,
  collectPageErrors,
} from './helpers.mjs'

async function loginAs(page, email) {
  await page.goto('/')
  await page.getByPlaceholder('Email or badge number').fill(email)
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()
}

async function gotoAttendance(page) {
  await page.getByRole('tab', { name: 'Attendance' }).click()
}

async function gotoTab(page, label) {
  await page.locator('button.tab-btn', { hasText: label }).click()
}

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('pre-cutoff: test login sees previsit + working toggle', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  // Today is strictly before visit_start - 1 day → previsit still open.
  await seedSchedule(request, { visit_start_date: istDate(5), visit_end_date: istDate(9) })
  // The toggle belongs to the *profile* email, not the login form: the mock
  // profile email must contain 'test'.
  await seedProfile(request, { role: 'aso', email: 'test-aso@example.com' })
  await loginAs(page, 'test-aso@example.com')
  await gotoAttendance(page)
  await gotoTab(page, 'Home')

  // Auto lens is previsit.
  await expect(page.getByRole('heading', { name: /Previsit Sewa Dashboard/ })).toBeVisible()
  await expect(page.getByText('No previsit sewa recorded')).toBeVisible()

  // The test login gets the switch, and it actually flips the lens.
  const toggle = page.getByRole('group', { name: 'Sewa mode' })
  await expect(toggle).toBeVisible()
  await toggle.getByRole('button', { name: 'Bhati Visit' }).click()
  await expect(page.getByRole('heading', { name: /Bhati Visit Register|Home/ })).toBeVisible()
  await toggle.getByRole('button', { name: 'Previsit' }).click()
  await expect(page.getByRole('heading', { name: /Previsit Sewa Dashboard/ })).toBeVisible()
  errors.assertEmpty()
})

test('post-cutoff: everyone is pinned to Bhati Visit, no toggle', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  // Cutoff (start - 1 day) has passed → Bhati Visit for every role.
  await seedSchedule(request, { visit_start_date: istDate(-1), visit_end_date: istDate(3) })
  await seedProfile(request, { role: 'aso' })
  await loginAs(page, 'test-aso@example.com')
  await gotoAttendance(page)
  await gotoTab(page, 'Home')

  await expect(page.getByText('Visit status at a glance')).toBeVisible()
  await expect(page.locator('[aria-label="Sewa mode"]')).toHaveCount(0)

  await gotoTab(page, 'Reports')
  await expect(page.getByRole('heading', { name: /Bhati Visit Register/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Absent/ })).toHaveCount(0)

  // No previsit RPC was ever asked in the visit lens.
  const calls = await mockCalls(request)
  expect(calls.filter((c) => String(c.rpc).startsWith('previsit_'))).toEqual([])
  errors.assertEmpty()
})

test('pre-cutoff: real login gets no toggle', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedSchedule(request, { visit_start_date: istDate(5), visit_end_date: istDate(9) })
  await seedProfile(request, { role: 'aso' })
  await loginAs(page, 'aso@example.com')
  await gotoAttendance(page)
  await gotoTab(page, 'Home')

  await expect(page.getByRole('heading', { name: /Previsit Sewa Dashboard/ })).toBeVisible()
  await expect(page.locator('[aria-label="Sewa mode"]')).toHaveCount(0)
  errors.assertEmpty()
})

test('scanner pill follows the automatic mode', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedSchedule(request, { visit_start_date: istDate(5), visit_end_date: istDate(9) })
  await seedProfile(request, { role: 'scanner' })
  await loginAs(page, 'scanner@example.com')
  await expect(page.getByText('Previsit sewa', { exact: true }).first()).toBeVisible()

  await seedSchedule(request, { visit_start_date: istDate(-1), visit_end_date: istDate(3) })
  await page.reload()
  await expect(page.getByText('Bhati visit', { exact: true }).first()).toBeVisible()
  errors.assertEmpty()
})

test('windowless schedule: honest visit empty, no crash', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  // Default sched-1 carries no visit window: the lens is Bhati Visit (there
  // is no previsit to show without a window) and the dashboard says so
  // instead of rendering zeros or throwing.
  await seedProfile(request, { role: 'aso' })
  await loginAs(page, 'aso@example.com')
  await gotoAttendance(page)
  await gotoTab(page, 'Home')

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(page.getByText('No visit dates set for this schedule')).toBeVisible()
  await expect(page.locator('[aria-label="Sewa mode"]')).toHaveCount(0)
  errors.assertEmpty()
})

test('seed helper sanity: mock serves the injected window', async ({ request }) => {
  await seedSchedule(request, { visit_start_date: istDate(5), visit_end_date: istDate(9) })
  const res = await request.get('http://127.0.0.1:54321/rest/v1/deployment_schedules?select=id')
  const rows = await res.json()
  expect(rows[0].visit_start_date).toBe(istDate(5))
  expect(rows[0].visit_end_date).toBe(istDate(9))
})
