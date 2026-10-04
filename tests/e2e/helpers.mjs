/**
 * Shared T2 rig helpers: mock control, login, manual scans, and direct
 * IndexedDB access (read + raw insert). Every spec owns its pageerror
 * collector via collectPageErrors().
 */
import { expect } from '@playwright/test'

export const API = 'http://127.0.0.1:54321'
export const OWNER = 'user-scanner-1'
export const SCHEDULE = 'sched-1'

export async function resetMock(request) {
  await request.post(`${API}/__test/reset`)
}

export async function seedMock(request, rpc) {
  await request.post(`${API}/__test/seed`, { data: { rpc } })
}

/**
 * Override the mock profile for the spec (e.g. a multi-tab role like
 * dept_incharge). Session identity (USER) is untouched, so the offline
 * queue owner still matches the signed-in user.
 */
export async function seedProfile(request, profile) {
  await request.post(`${API}/__test/seed`, { data: { profile } })
}

export async function mockCalls(request) {
  return (await request.get(`${API}/__test/calls`)).json()
}

/** Throws at the end of the spec on ANY unhandled rejection/exception. */
export function collectPageErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return {
    errors,
    assertEmpty: () => expect(errors).toEqual([]),
  }
}

export async function loginAsScanner(page) {
  await page.goto('/')
  await page.getByPlaceholder('your@email.com').fill('scanner@example.com')
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()
  // Role `scanner` sees only the Scanner tab, so a successful login lands
  // directly on the scan surface with its manual entry.
  await expect(page.getByPlaceholder('Manual FB/BH/VS badge')).toBeVisible()
}

export async function manualScan(page, badge) {
  await page.getByPlaceholder('Manual FB/BH/VS badge').fill(badge)
  await page.getByRole('button', { name: 'Mark In/Out' }).click()
}

/**
 * Log in as a dept_incharge (requires seedProfile with role dept_incharge
 * first) and open the Attendance tab (InchargeScannerPage). The mock
 * accepts any credentials; the role comes from the seeded profile.
 */
export async function loginAsIncharge(page) {
  await page.goto('/')
  await page.getByPlaceholder('your@email.com').fill('incharge@example.com')
  await page.getByPlaceholder('Enter password').fill('secret')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await gotoTab(page, 'Attendance')
  await expect(page.getByPlaceholder('Enter badge manually (FB/BH/VS)')).toBeVisible()
}

/** Click a desktop nav tab (scoped to .tab-btn so the mobile bar never collides). */
export async function gotoTab(page, label) {
  await page.locator('button.tab-btn', { hasText: label }).click()
}

/** Manual scan on the incharge surface (Enter key — the Go button shifts under popups). */
export async function inchargeScan(page, badge) {
  await page.getByPlaceholder('Enter badge manually (FB/BH/VS)').fill(badge)
  await page.getByPlaceholder('Enter badge manually (FB/BH/VS)').press('Enter')
}

/** All rows in the app's real IndexedDB offline queue. */
export async function queueRows(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('sewadar_offline_q')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('scan_queue')) {
            resolve([])
            return
          }
          const req = db.transaction('scan_queue', 'readonly').objectStore('scan_queue').getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        }
      }),
  )
}

/**
 * Insert raw queue rows (bypasses the app's cap/validation — the point is
 * fixtures the UI cannot produce: a full queue, a bad timestamp, a poison
 * row). Shape mirrors offlineQueue.enqueueScan's put().
 */
export async function putRawRows(page, rows) {
  return page.evaluate((rows) => {
    const open = indexedDB.open('sewadar_offline_q', 2)
    return new Promise((resolve, reject) => {
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('scan_queue')) {
          open.result.createObjectStore('scan_queue', { keyPath: 'id' })
        }
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('scan_queue', 'readwrite')
        for (const r of rows) tx.objectStore('scan_queue').put(r)
        tx.oncomplete = () => resolve(rows.length)
        tx.onerror = () => reject(tx.error)
      }
    })
  }, rows)
}

export const liveRow = (overrides = {}) => ({
  id: `q-${Math.random().toString(36).slice(2, 10)}`,
  badge: 'FB5971GA0001',
  schedule_id: SCHEDULE,
  action: 'IN',
  ts: new Date().toISOString(),
  centre: 'DELHI',
  createdAt: Date.now(),
  attempts: 0,
  synced: false,
  failed: false,
  owner: OWNER,
  ...overrides,
})

/** Wait until the mock saw an RPC matching predicate (drain assertions). */
export async function waitForRpc(request, predicate, timeout = 25000) {
  let found = null
  await expect
    .poll(
      async () => {
        const calls = await mockCalls(request)
        found = calls.find(predicate) || null
        return found ? 1 : 0
      },
      { timeout },
    )
    .toBe(1)
  return found
}

/**
 * Seed the offline identity caches directly (same shapes the app writes):
 * the per-schedule directory snapshot plus the global department map.
 * Lets a spec prove the offline popup path without depending on the
 * deployments fetch.
 */
export async function seedOfflineIdentity(page, { badge, name, centre, deptId, deptName, scheduleId = SCHEDULE } = {}) {
  return page.evaluate(
    ({ badge, name, centre, deptId, deptName, scheduleId }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('sewadar_offline_q', 2)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('sewadar_cache')) {
            db.close()
            reject(new Error('sewadar_cache store missing'))
            return
          }
          const now = Date.now()
          const tx = db.transaction('sewadar_cache', 'readwrite')
          const store = tx.objectStore('sewadar_cache')
          store.put({
            key: `dir:${scheduleId}`,
            value: {
              rows: [
                {
                  badge_number: badge,
                  sewadar_name: name,
                  centre,
                  deployed_department_id: deptId,
                  department_id: deptId,
                },
              ],
              vss: [],
            },
            at: now,
          })
          store.put({ key: `dir_at:${scheduleId}`, value: now, at: now })
          store.put({ key: 'dept_map', value: [{ id: deptId, name: deptName }], at: now })
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => reject(tx.error)
        }
      }),
    { badge, name, centre, deptId, deptName, scheduleId },
  )
}
