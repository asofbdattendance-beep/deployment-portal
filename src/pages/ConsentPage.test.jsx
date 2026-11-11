// @vitest-environment jsdom
// ConsentPage — v86 "edit until lock". A centre admin who has said Yes and
// assigned a department must still be able to change that sewadar's consent,
// department, stay at Bhati and chair pass until the centre LOCKS. Before v86
// the row turned into a read-only "SECURITY · DEPLOYED" pill.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import ConsentPage from './ConsentPage'
import { __reset as resetQueryCache } from '../lib/queryCache'

const CENTRE = 'SECTOR-15-A'
const SCHEDULE = { id: 's1', name: 'December2026', status: 'open', deadline: '2099-01-01T00:00:00Z' }
const SECURITY = { id: 'd-sec', name: 'SECURITY', min_days: 1, is_active: true }
const LANGAR = { id: 'd-lan', name: 'LANGAR', min_days: 1, is_active: true }
const ROHIT = 'FB5978GA0016'
const AARTI = 'FB5978LA0020'

let role = 'centre_admin'
let lockRow = null
const writes = []

const tables = () => ({
  dp_sewadars: [
    { badge_number: ROHIT, sewadar_name: 'ROHIT VERMA', department: 'ADMINISTRATION', centre: CENTRE, is_initiated: true, gender: 'M' },
    { badge_number: AARTI, sewadar_name: 'AARTI', department: 'PANDAL', centre: CENTRE, is_initiated: true, gender: 'F' },
  ],
  sewadar_consents: [
    { id: 'c1', schedule_id: 's1', centre: CENTRE, badge_number: ROHIT, sewadar_name: 'ROHIT VERMA', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false },
  ],
  deployment_departments: [SECURITY, LANGAR],
  centre_allocations: [
    { id: 'a1', schedule_id: 's1', department_id: SECURITY.id, centre: CENTRE, max_count: 30 },
    { id: 'a2', schedule_id: 's1', department_id: LANGAR.id, centre: CENTRE, max_count: 12 },
  ],
  deployments: [
    { id: 'p1', schedule_id: 's1', centre: CENTRE, badge_number: ROHIT, sewadar_name: 'ROHIT VERMA', department_id: SECURITY.id, deployed_department_id: null, status: 'requested' },
  ],
  prev_year_deployments: [],
})

// chainable, thenable query builder that records write operations
function builder(table) {
  const state = { table, op: 'select', payload: null, filters: [] }
  const result = () => {
    if (table === 'centre_locks') return { data: lockRow, error: null }
    return { data: [], error: null }
  }
  const b = {
    select: () => b,
    eq: (...a) => { state.filters.push(['eq', ...a]); return b },
    in: (...a) => { state.filters.push(['in', ...a]); return b },
    or: (...a) => { state.filters.push(['or', ...a]); return b },
    maybeSingle: () => Promise.resolve(result()),
    upsert: (payload) => { state.op = 'upsert'; state.payload = payload; writes.push(state); return b },
    update: (payload) => { state.op = 'update'; state.payload = payload; writes.push(state); return b },
    delete: () => { state.op = 'delete'; writes.push(state); return b },
    insert: (payload) => { state.op = 'insert'; state.payload = payload; writes.push(state); return b },
    then: (res, rej) => Promise.resolve(result()).then(res, rej),
  }
  return b
}

vi.mock('../lib/supabase', async () => {
  const logic = await vi.importActual('../lib/logic')
  const ch = { on: () => ch, subscribe: () => ch }
  return {
    supabase: {
      from: (t) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => ch,
      removeChannel: () => {},
    },
    fetchSubtreeCentres: () => Promise.resolve({ centres: [{ name: CENTRE, parent_centre: '' }], subtree: [CENTRE] }),
    fetchCentres: () => Promise.resolve([{ name: CENTRE, parent_centre: '' }]),
    fetchAllRows: (table) => Promise.resolve(tables()[table] || []),
    fetchAsoDeptKeys: () => Promise.resolve(new Set()),
    fetchPortalSettings: () => Promise.resolve({ sewadar_deployment_open: true }),
    getRootCentre: logic.getRootCentre,
    eligibleBadgeStatusFilter: logic.eligibleBadgeStatusFilter,
    isAssoDepartment: logic.isAssoDepartment,
    shouldHideFromConsent: logic.shouldHideFromConsent,
  }
})

const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../components/Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { role, centre: CENTRE, name: 'SACHIN AHUJA' } }),
}))

const renderPage = () => render(<ConsentPage schedules={[SCHEDULE]} scheduleId="s1" />)
const rohitRow = async () => {
  const consent = await screen.findByLabelText(`Consent for ${ROHIT}`)
  return consent.closest('tr')
}

beforeEach(() => {
  role = 'centre_admin'
  lockRow = null
  writes.length = 0
  resetQueryCache()
  Object.values(toast).forEach(f => f.mockReset())
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ConsentPage — deployed sewadars stay editable until lock (v86)', () => {
  it('keeps consent, stay, chair pass and department editable for a deployed sewadar', async () => {
    renderPage()
    const row = await rohitRow()
    expect(within(row).getByLabelText(`Consent for ${ROHIT}`).disabled).toBe(false)
    expect(within(row).getByLabelText(`Stay at bhati for ${ROHIT}`).disabled).toBe(false)
    expect(within(row).getByLabelText(`Chair pass for ${ROHIT}`).disabled).toBe(false)
    const deptBtn = row.querySelector(`[id="dept-btn-${CENTRE}|${ROHIT}"]`)
    expect(deptBtn).toBeTruthy()
    expect(deptBtn.disabled).toBe(false)
    expect(deptBtn.textContent).toContain('SECURITY')
    expect(within(row).getByText('Deployed')).toBeTruthy()
    expect(screen.getByText('Editing is open until you lock')).toBeTruthy()
  })

  it('saves a department change for an already-deployed sewadar', async () => {
    renderPage()
    const row = await rohitRow()
    // jsdom has no layout; DeptDropdown only opens once its button has a size
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 130, left: 100, right: 250, width: 150, height: 30, x: 100, y: 100, toJSON: () => ({}) })
    fireEvent.click(row.querySelector(`[id="dept-btn-${CENTRE}|${ROHIT}"]`))
    fireEvent.click(await screen.findByRole('option', { name: /LANGAR/ }))
    expect(within(row).getByText('Unsaved')).toBeTruthy()
    await waitFor(() => {
      const up = writes.find(w => w.table === 'deployments' && w.op === 'upsert')
      expect(up?.payload).toEqual([expect.objectContaining({ badge_number: ROHIT, department_id: LANGAR.id })])
    }, { timeout: 3000 })
  })

  it('saves stay at Bhati for an already-deployed sewadar', async () => {
    renderPage()
    const row = await rohitRow()
    fireEvent.click(within(row).getByLabelText(`Stay at bhati for ${ROHIT}`))
    await waitFor(() => {
      const patch = writes.find(w => w.table === 'sewadar_consents' && w.op === 'update')
      expect(patch?.payload).toEqual({ stay_at_bhati: true })
    }, { timeout: 3000 })
  })

  it('asks before consent No removes a deployed sewadar, then removes the deployment', async () => {
    renderPage()
    const row = await rohitRow()
    fireEvent.change(within(row).getByLabelText(`Consent for ${ROHIT}`), { target: { value: 'no' } })
    expect(await screen.findByText('Set consent to No?')).toBeTruthy()
    expect(within(row).getByLabelText(`Consent for ${ROHIT}`).value).toBe('yes')
    fireEvent.click(screen.getByRole('button', { name: 'Set No and remove' }))
    await waitFor(() => {
      expect(writes.find(w => w.table === 'sewadar_consents' && w.op === 'update')?.payload).toMatchObject({ consent_given: false })
      const del = writes.find(w => w.table === 'deployments' && w.op === 'delete')
      expect(del?.filters).toContainEqual(['in', 'badge_number', [ROHIT]])
    }, { timeout: 3000 })
  })

  it('makes everything read-only once the centre is locked', async () => {
    lockRow = { schedule_id: 's1', centre: CENTRE, locked_by: 'SACHIN AHUJA', locked_at: '2026-11-10T10:42:00Z' }
    renderPage()
    expect(await screen.findByText('Deployment locked')).toBeTruthy()
    const row = await rohitRow()
    await waitFor(() => expect(within(row).getByLabelText(`Consent for ${ROHIT}`).disabled).toBe(true))
    expect(within(row).getByLabelText(`Stay at bhati for ${ROHIT}`).disabled).toBe(true)
    expect(row.querySelector(`[id="dept-btn-${CENTRE}|${ROHIT}"]`).disabled).toBe(true)
  })
})
