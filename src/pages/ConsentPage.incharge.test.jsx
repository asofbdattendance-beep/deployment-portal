// @vitest-environment jsdom
// ConsentPage — department incharge for a CENTRE with sub-centres.
// The incharge picker lists every consented sewadar in the CENTRE's subtree,
// and the DB (trg_check_incharge) accepts any sewadar whose ROOT centre
// matches. Before this fix the page only accepted sewadars whose OWN centre
// was the root: picking a sub-centre sewadar did nothing, and a sub-centre
// incharge already in the DB was DELETED as "stale" on the next save.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import ConsentPage from './ConsentPage'
import { __reset as resetQueryCache } from '../lib/queryCache'

const ROOT = 'FARIDABAD'
const SUB = 'NIT - 2'
const SCHEDULE = { id: 's1', name: 'December2026', status: 'open', deadline: '2099-01-01T00:00:00Z' }
const SECURITY = { id: 'd-sec', name: 'SECURITY', min_days: 1, is_active: true }
const LANGAR = { id: 'd-lan', name: 'LANGAR', min_days: 1, is_active: true }
const ROOT_BADGE = 'FB0001GA0001'
const SUB_BADGE = 'FB0002GA0002'

let savedIncharges = []
let subFinalDept = null
let rootFinalDept = null
const writes = []

const tables = () => ({
  dp_sewadars: [
    { badge_number: ROOT_BADGE, sewadar_name: 'ROOT SEWADAR', department: 'ADMIN', centre: ROOT, is_initiated: true, gender: 'M' },
    { badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR', department: 'ADMIN', centre: SUB, is_initiated: true, gender: 'M' },
  ],
  sewadar_consents: [
    { id: 'c1', schedule_id: 's1', centre: ROOT, badge_number: ROOT_BADGE, sewadar_name: 'ROOT SEWADAR', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false },
    { id: 'c2', schedule_id: 's1', centre: SUB, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false },
  ],
  deployment_departments: [SECURITY, LANGAR],
  centre_allocations: [
    { id: 'a1', schedule_id: 's1', department_id: SECURITY.id, centre: ROOT, max_count: 30 },
    { id: 'a2', schedule_id: 's1', department_id: LANGAR.id, centre: ROOT, max_count: 30 },
  ],
  deployments: [
    { id: 'p1', schedule_id: 's1', centre: ROOT, badge_number: ROOT_BADGE, sewadar_name: 'ROOT SEWADAR', department_id: SECURITY.id, deployed_department_id: rootFinalDept, status: rootFinalDept ? 'finalized' : 'requested' },
    { id: 'p2', schedule_id: 's1', centre: SUB, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR', department_id: SECURITY.id, deployed_department_id: subFinalDept, status: subFinalDept ? 'finalized' : 'requested' },
  ],
  prev_year_deployments: [],
})

function builder(table) {
  const state = { table, op: 'select', payload: null, filters: [] }
  const result = () => {
    if (table === 'centre_locks') return { data: null, error: null }
    if (table === 'department_incharges' && state.op === 'select') return { data: savedIncharges, error: null }
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
  const centres = [{ name: 'FARIDABAD', parent_centre: '' }, { name: 'NIT - 2', parent_centre: 'FARIDABAD' }]
  return {
    supabase: {
      from: (t) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => ch,
      removeChannel: () => {},
    },
    fetchSubtreeCentres: () => Promise.resolve({ centres, subtree: ['FARIDABAD', 'NIT - 2'] }),
    fetchCentres: () => Promise.resolve(centres),
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
  usePortalAuth: () => ({ profile: { role: 'centre_admin', centre: ROOT, name: 'TEST ADMIN' } }),
}))

const renderPage = () => render(<ConsentPage schedules={[SCHEDULE]} scheduleId="s1" />)
const inchargeDeletes = () => writes.filter(w => w.table === 'department_incharges' && w.op === 'delete')
const inchargeUpserts = () => writes.filter(w => w.table === 'department_incharges' && w.op === 'upsert')

beforeEach(() => {
  savedIncharges = []
  subFinalDept = null
  rootFinalDept = null
  writes.length = 0
  resetQueryCache()
  Object.values(toast).forEach(f => f.mockReset())
  // jsdom has no layout; pickers only open once their button has a size
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 130, left: 100, right: 250, width: 150, height: 30, x: 100, y: 100, toJSON: () => ({}) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pickIncharge = async (name) => {
  const btn = await waitFor(() => {
    const el = document.getElementById(`incharge-btn-${SECURITY.id}`)
    if (!el) throw new Error('incharge picker not rendered')
    return el
  })
  fireEvent.click(btn)
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }))
  return btn
}

describe('ConsentPage — incharge from a sub-centre', () => {
  it('lists both root and sub-centre sewadars as eligible incharges', async () => {
    renderPage()
    const btn = await waitFor(() => document.getElementById(`incharge-btn-${SECURITY.id}`) || Promise.reject(new Error('no picker')))
    fireEvent.click(btn)
    expect(await screen.findByRole('option', { name: /ROOT SEWADAR/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /SUB SEWADAR/ })).toBeTruthy()
  })

  it('selecting a sub-centre sewadar sets the incharge and saves it against the root centre', async () => {
    renderPage()
    const btn = await pickIncharge('SUB SEWADAR')
    expect(btn.textContent).toContain(SUB_BADGE)
    await waitFor(() => {
      expect(inchargeUpserts().at(-1)?.payload).toEqual([
        { schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR' },
      ])
    }, { timeout: 3000 })
    expect(inchargeDeletes()).toEqual([])
  })

  it('selecting a root-centre sewadar still works', async () => {
    renderPage()
    const btn = await pickIncharge('ROOT SEWADAR')
    expect(btn.textContent).toContain(ROOT_BADGE)
    await waitFor(() => {
      expect(inchargeUpserts().at(-1)?.payload).toEqual([
        expect.objectContaining({ centre: ROOT, badge_number: ROOT_BADGE }),
      ])
    }, { timeout: 3000 })
    expect(inchargeDeletes()).toEqual([])
  })

  it('never deletes an existing sub-centre incharge when an unrelated edit is saved', async () => {
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR' }]
    renderPage()
    await waitFor(() => expect(document.getElementById(`incharge-btn-${SECURITY.id}`)?.textContent).toContain(SUB_BADGE))
    // unrelated edit triggers a full save
    fireEvent.click(await screen.findByLabelText(`Stay at bhati for ${ROOT_BADGE}`))
    await waitFor(() => {
      expect(writes.find(w => w.table === 'sewadar_consents' && w.op === 'update')).toBeTruthy()
    }, { timeout: 3000 })
    // let the rest of the save run
    await new Promise(r => setTimeout(r, 50))
    expect(inchargeDeletes()).toEqual([])
    expect(document.getElementById(`incharge-btn-${SECURITY.id}`).textContent).toContain(SUB_BADGE)
  })
})

describe('ConsentPage — lock gate follows the ASO final department', () => {
  it('lists an ASO-moved sewadar as eligible in the department they were moved to', async () => {
    subFinalDept = LANGAR.id
    renderPage()
    const btn = await waitFor(() => document.getElementById(`incharge-btn-${LANGAR.id}`) || Promise.reject(new Error('no picker')))
    fireEvent.click(btn)
    expect(await screen.findByRole('option', { name: /SUB SEWADAR/ })).toBeTruthy()
  })

  it('asks only for departments that someone can actually be incharge of', async () => {
    // SUB requested SECURITY, ASO moved them to LANGAR. SECURITY still has
    // ROOT, LANGAR has SUB — both need (and can get) an incharge.
    subFinalDept = LANGAR.id
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: ROOT_BADGE, sewadar_name: 'ROOT SEWADAR' }]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Lock deployment/i }))
    expect(await screen.findByText('Add incharges before locking')).toBeTruthy()
    // LANGAR is the missing one; SECURITY already has its incharge
    const dialog = screen.getByText('Add incharges before locking').parentElement
    expect(dialog.textContent).toContain('LANGAR')
    expect(dialog.textContent).not.toContain('SECURITY')
  })

  it('does not block the lock on a department the ASO emptied', async () => {
    // both sewadars requested SECURITY; the ASO moved both to LANGAR. Before
    // the fix SECURITY still "needed" an incharge that nobody could be, so
    // the centre could never lock.
    subFinalDept = LANGAR.id
    rootFinalDept = LANGAR.id
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: LANGAR.id, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR' }]
    renderPage()
    await waitFor(() => expect(document.getElementById(`incharge-btn-${LANGAR.id}`)?.textContent).toContain(SUB_BADGE))
    fireEvent.click(await screen.findByRole('button', { name: /Lock deployment/i }))
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByText('Add incharges before locking')).toBeNull()
    expect(writes.filter(w => w.table === 'centre_locks')).toEqual([])  // only the confirm step, nothing written
  })
})

describe('ConsentPage — incharge regressions around the fix', () => {
  it('still removes a sub-centre incharge whose consent is set to No (matches the DB rule)', async () => {
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR' }]
    renderPage()
    await waitFor(() => expect(document.getElementById(`incharge-btn-${SECURITY.id}`)?.textContent).toContain(SUB_BADGE))
    fireEvent.change(await screen.findByLabelText(`Consent for ${SUB_BADGE}`), { target: { value: 'no' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Set No and remove' }))
    await waitFor(() => {
      const del = inchargeDeletes()
      expect(del).toHaveLength(1)
      expect(del[0].filters).toEqual([['eq', 'schedule_id', 's1'], ['eq', 'centre', ROOT], ['eq', 'department_id', SECURITY.id]])
    }, { timeout: 3000 })
  })

  it('does not touch the ROOT incharge when an unrelated sub-centre sewadar changes', async () => {
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: ROOT_BADGE, sewadar_name: 'ROOT SEWADAR' }]
    renderPage()
    await waitFor(() => expect(document.getElementById(`incharge-btn-${SECURITY.id}`)?.textContent).toContain(ROOT_BADGE))
    fireEvent.click(await screen.findByLabelText(`Stay at bhati for ${SUB_BADGE}`))
    await waitFor(() => expect(writes.find(w => w.table === 'sewadar_consents' && w.op === 'update')).toBeTruthy(), { timeout: 3000 })
    await new Promise(r => setTimeout(r, 50))
    expect(inchargeDeletes()).toEqual([])
    expect(inchargeUpserts()).toEqual([])
  })

  it('writes a picked sub-centre incharge once, not again on the next save', async () => {
    renderPage()
    await pickIncharge('SUB SEWADAR')
    await waitFor(() => expect(inchargeUpserts()).toHaveLength(1), { timeout: 3000 })
    fireEvent.click(await screen.findByLabelText(`Stay at bhati for ${ROOT_BADGE}`))
    await waitFor(() => expect(writes.find(w => w.table === 'sewadar_consents' && w.op === 'update')).toBeTruthy(), { timeout: 3000 })
    await new Promise(r => setTimeout(r, 50))
    expect(inchargeUpserts()).toHaveLength(1)
    expect(inchargeDeletes()).toEqual([])
  })

  it('clearing the incharge removes only that department row', async () => {
    savedIncharges = [{ schedule_id: 's1', centre: ROOT, department_id: SECURITY.id, badge_number: SUB_BADGE, sewadar_name: 'SUB SEWADAR' }]
    renderPage()
    const btn = await waitFor(() => {
      const el = document.getElementById(`incharge-btn-${SECURITY.id}`)
      if (!el?.textContent.includes(SUB_BADGE)) throw new Error('not loaded')
      return el
    })
    fireEvent.click(btn)
    const options = await screen.findAllByRole('option')
    fireEvent.click(options[0]) // first option is "clear" when an incharge is set
    await waitFor(() => expect(inchargeDeletes()).toHaveLength(1), { timeout: 3000 })
    expect(inchargeDeletes()[0].filters).toContainEqual(['eq', 'department_id', SECURITY.id])
  })
})
