// @vitest-environment jsdom
// VssPage (centre VSS deploy table) autosave regressions:
//  1) consent No→Yes restores the auto-set days (was rendered "null day");
//  2) when the VSS switch closes inside the autosave debounce, the pending
//     user edit must not be silently dropped (dirty cleared → Save Draft said
//     "everything is already saved").
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import VssPage from './VssPage'

const h = vi.hoisted(() => ({
  settings: { vss_deployment_open: true },
  handlers: {},
  writes: [],
}))

const FIX = {
  vss_sewadars: [{ badge_number: 'VS001', sewadar_name: 'Vee Ess', gender: 'M', is_initiated: true, is_active: true, remarks: '', centre: 'C1', department: 'SANGAT' }],
  sewadar_consents: [{ id: 'c1', centre: 'C1', badge_number: 'VS001', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false }],
  deployment_departments: [{ id: 'd1', name: 'TRAFFIC', is_active: true, include_vss: true }],
  centre_allocations: [{ id: 'a1', department_id: 'd1', centre: 'C1', max_count: 5 }],
  deployments: [],
}

vi.mock('../lib/supabase', async (importOriginal) => {
  const mod = await importOriginal()
  const qb = (table) => {
    const self = {}
    ;['select', 'eq', 'in', 'or', 'update', 'upsert', 'delete', 'maybeSingle'].forEach(k => {
      self[k] = vi.fn((...a) => { if (['update', 'upsert', 'delete'].includes(k)) h.writes.push([table, k, ...a]); return self })
    })
    self.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return self
  }
  return {
    ...mod,
    supabase: {
      from: (t) => qb(t),
      rpc: () => Promise.resolve({ data: { vss_deployment_open: h.settings.vss_deployment_open }, error: null }),
      channel: () => {
        const ch = { on: (_e, f, cb) => { h.handlers[f.table] = cb; return ch }, subscribe: () => ch }
        return ch
      },
      removeChannel: () => {},
    },
    fetchSubtreeCentres: () => Promise.resolve({ centres: [{ name: 'C1', parent_centre: '' }], subtree: ['C1'] }),
    fetchCentres: () => Promise.resolve([{ name: 'C1', parent_centre: '' }]),
    fetchAllRows: (table) => Promise.resolve((FIX[table] || []).map(r => ({ ...r }))),
    fetchAsoDeptKeys: () => Promise.resolve(new Set()),
    fetchPortalSettings: () => Promise.resolve({ ...h.settings }),
    fetchVssOverrides: () => Promise.resolve([]),
  }
})

vi.mock('../components/VssDashboard', () => ({ default: () => null }))
vi.mock('../components/AddVssForm', () => ({ default: () => null }))
vi.mock('../components/VssRoster', () => ({ default: () => null }))

const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../components/Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { name: 'Centre User', role: 'centre_user', centre: 'C1' } }),
}))

const SCHEDULES = [{ id: 's1', name: 'Dec 2026', status: 'open', deadline: null }]

beforeEach(() => {
  h.settings = { vss_deployment_open: true }
  h.handlers = {}
  h.writes.length = 0
  Object.values(toast).forEach(f => f.mockReset())
})
afterEach(() => cleanup())

async function renderTable() {
  render(<VssPage schedules={SCHEDULES} scheduleId="s1" />)
  const name = await screen.findByText('Vee Ess')
  const row = name.closest('tr')
  const consent = row.querySelector('select')
  await waitFor(() => expect(consent.disabled).toBe(false))
  return { row, consent }
}

describe('VssPage deploy table', () => {
  it('consent No→Yes restores the auto-set days', async () => {
    const { consent } = await renderTable()
    fireEvent.change(consent, { target: { value: 'no' } })
    fireEvent.change(consent, { target: { value: 'yes' } })
    await waitFor(() => expect(screen.getByText('Vee Ess').closest('tr').textContent).toContain('5 days'))
  })

  it('keeps a pending edit dirty (and says so) when the VSS switch closes mid-debounce', async () => {
    const { consent } = await renderTable()
    fireEvent.change(consent, { target: { value: 'no' } })
    // the ASO closes the VSS switch before the 800ms autosave fires
    h.settings = { vss_deployment_open: false }
    h.handlers.portal_settings()
    await waitFor(() => expect(screen.getByText('Vee Ess').closest('tr').querySelector('select').disabled).toBe(true))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/not saved/)), { timeout: 2500 })
    // nothing was written while closed, and the edit is still pending
    expect(h.writes.filter(w => w[0] === 'sewadar_consents')).toHaveLength(0)
    // the ASO reopens the switch — Save Draft must still persist the edit
    h.settings = { vss_deployment_open: true }
    h.handlers.portal_settings()
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }))
    expect(toast.info).not.toHaveBeenCalledWith(expect.stringMatching(/already saved/))
    await waitFor(() => expect(h.writes).toContainEqual(['sewadar_consents', 'update', expect.objectContaining({ consent_given: false })]))
  })
})
