/**
 * DB version banner — the guard behind the v74 floor. Proven as the user
 * sees it: silent when current, loud with the floor version when behind,
 * honest when unconfirmed; dismiss lasts the session, never the reload.
 * Seeds land BEFORE login: the handshake fires once per mount.
 */
import { test, expect } from '@playwright/test'
import {
  resetMock,
  seedMock,
  mockCalls,
  collectPageErrors,
  loginAsScanner,
} from './helpers.mjs'

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('current database: no banner at all', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedMock(request, { portal_app_version: 'v74' })
  await loginAsScanner(page)

  await expect(page.locator('.db-version-banner')).toHaveCount(0)
  const calls = await mockCalls(request)
  expect(calls.filter((c) => c.rpc === 'portal_app_version').length).toBeGreaterThan(0)
  errors.assertEmpty()
})

test('behind database: banner names the version and the floor', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedMock(request, { portal_app_version: 'v45' })
  await loginAsScanner(page)

  const banner = page.locator('.db-version-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('v45')
  await expect(banner).toContainText('v74+')
  errors.assertEmpty()
})

test('dismiss hides it for the session, reload brings it back', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedMock(request, { portal_app_version: 'v45' })
  await loginAsScanner(page)

  const banner = page.locator('.db-version-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.db-version-banner')).toBeVisible()
  errors.assertEmpty()
})

test('unparseable version: honest unknown state, not a green lie', async ({ page, request }) => {
  const errors = collectPageErrors(page)
  await seedMock(request, { portal_app_version: 'junk' })
  await loginAsScanner(page)

  await expect(page.locator('.db-version-banner')).toContainText("Couldn't confirm")
  errors.assertEmpty()
})
