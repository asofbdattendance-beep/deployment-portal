// @vitest-environment jsdom
// Finalize Deployment autosave regressions:
//  1) a consent-No row that HAS a deployment (v21 override / vss_operator /
//     bypass deploys) must not be deleted by an unrelated save;
//  2) a realtime reload timer armed BEFORE an edit must not wipe that edit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import DeploymentAllocationPage from './DeploymentAllocationPage'

const calls = []
const realtime = { handlers: [] }

function qb(table) {
  const rec = { table, ops: [] }
  calls.push(rec)
  const result = Promise.resolve({ data: [], error: null })
  const self = {}
  ;['insert', 'update', 'upsert', 'delete', 'select', 'eq', 'in', 'order'].forEach(k => {
    self[k] = vi.fn((...args) => { rec.ops.push([k, ...args]); return self })
  })
  self.then = (res, rej) => result.then(res, rej)
  return self
}

const FIX = {
  deployment_departments: [
    { id: 'd1', name: 'TRAFFIC', is_active: true },
    { id: 'd2', name: 'LANGAR', is_active: true },
  ],
  dp_sewadars: [
    { badge_number: 'B1', sewadar_name: 'Override Deployed', department: 'X', centre: 'C1', is_initiated: true, badge_status: 'OPEN' },
    { badge_number: 'B2', sewadar_name: 'Regular Yes', department: 'X', centre: 'C1', is_initiated: true, badge_status: 'OPEN' },
  ],
  vss_sewadars: [],
  sewadar_consents: [
    { centre: 'C1', badge_number: 'B1', consent_given: false, available_days_count: null, stay_at_bhati: false, chair_pass: false },
    { centre: 'C1', badge_number: 'B2', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false },
  ],
  deployments: [
    { id: 'dep-1', centre: 'C1', badge_number: 'B1', department_id: 'd1', deployed_department_id: null },
    { id: 'dep-2', centre: 'C1', badge_number: 'B2', department_id: 'd1', deployed_department_id: null },
  ],
  dp_centres: [{ name: 'C1', parent_centre: '' }],
  centre_allocations: [],
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => qb(table),
    channel: () => {
      const ch = { on: (_e, _f, cb) => { realtime.handlers.push(cb); return ch }, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
  },
  fetchAllRows: (table) => Promise.resolve(FIX[table] ? FIX[table].map(r => ({ ...r })) : []),
}))

const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../components/Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { name: 'Root', role: 'super_admin' } }),
}))

const SCHEDULES = [{ id: 's1', name: 'Dec 2026', status: 'open', deadline: null }]

beforeEach(() => {
  calls.length = 0
  realtime.handlers.length = 0
  Object.values(toast).forEach(f => f.mockReset())
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => cleanup())

const writes = (table, op) => calls.filter(c => c.table === table && c.ops.some(o => o[0] === op))

async function renderEditable() {
  render(<DeploymentAllocationPage schedules={SCHEDULES} scheduleId="s1" />)
  await screen.findByText('Regular Yes')
  fireEvent.click(screen.getByLabelText(/Enable editing/))
}

function finalSelectOf(name) {
  const row = screen.getByText(name).closest('tr')
  // [consent, finalized deployment]
  return within(row).getAllByRole('combobox')[1]
}

describe('DeploymentAllocationPage autosave', () => {
  it('keeps a consent-No deployment when an unrelated row is saved', async () => {
    await renderEditable()
    fireEvent.change(finalSelectOf('Regular Yes'), { target: { value: 'd2' } })
    await waitFor(() => expect(writes('deployments', 'update').length).toBe(1), { timeout: 2500 })
    const upd = writes('deployments', 'update')[0].ops
    expect(upd).toContainEqual(['update', { deployed_department_id: 'd2' }])
    expect(upd).toContainEqual(['in', 'id', ['dep-2']])
    // the override-deployed consent-No row must survive the save
    expect(writes('deployments', 'delete')).toHaveLength(0)
  })

  it('still deletes a deployment whose consent was flipped to No in this session', async () => {
    await renderEditable()
    const row = screen.getByText('Regular Yes').closest('tr')
    fireEvent.change(within(row).getAllByRole('combobox')[0], { target: { value: 'no' } })
    await waitFor(() => expect(writes('deployments', 'delete').length).toBe(1), { timeout: 2500 })
    expect(writes('deployments', 'delete')[0].ops).toContainEqual(['in', 'id', ['dep-2']])
  })

  it('a realtime reload armed before an edit does not wipe that edit', async () => {
    await renderEditable()
    expect(realtime.handlers.length).toBeGreaterThan(0)
    // a centre write arrives while nothing is dirty → 500ms reload armed
    realtime.handlers[0]()
    // the ASO edits inside that window
    fireEvent.change(finalSelectOf('Regular Yes'), { target: { value: 'd2' } })
    // the edit must still be saved (the reload must defer, not reset rows)
    await waitFor(() => expect(writes('deployments', 'update').length).toBe(1), { timeout: 2500 })
    expect(writes('deployments', 'update')[0].ops).toContainEqual(['update', { deployed_department_id: 'd2' }])
  })
})
