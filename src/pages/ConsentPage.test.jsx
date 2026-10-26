// @vitest-environment jsdom
// ConsentPage autosave regression: when the master switch closes inside the
// autosave debounce, the pending user edit stays queued (dirty) and the user
// is TOLD it was not saved — previously the skip was silent, so the page kept
// showing the edit as if it had saved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import ConsentPage from './ConsentPage'

const h = vi.hoisted(() => ({
  settings: { sewadar_deployment_open: true },
  handlers: {},
  writes: [],
}))

const FIX = {
  dp_sewadars: [{ badge_number: 'B1', sewadar_name: 'Regular One', department: 'X', centre: 'C1', is_initiated: true, gender: 'M' }],
  sewadar_consents: [{ id: 'c1', centre: 'C1', badge_number: 'B1', consent_given: true, available_days_count: 5, stay_at_bhati: false, chair_pass: false }],
  deployment_departments: [{ id: 'd1', name: 'TRAFFIC', is_active: true }],
  centre_allocations: [{ id: 'a1', department_id: 'd1', centre: 'C1', max_count: 5 }],
  deployments: [],
  prev_year_deployments: [],
}

vi.mock('../lib/supabase', async (importOriginal) => {
  const mod = await importOriginal()
  const qb = (table) => {
    const self = {}
    ;['select', 'eq', 'in', 'or', 'update', 'upsert', 'delete', 'insert', 'maybeSingle'].forEach(k => {
      self[k] = vi.fn((...a) => { if (['update', 'upsert', 'delete', 'insert'].includes(k)) h.writes.push([table, k, ...a]); return self })
    })
    self.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return self
  }
  return {
    ...mod,
    supabase: {
      from: (t) => qb(t),
      rpc: () => Promise.resolve({ data: {}, error: null }),
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
  }
})

vi.mock('../components/ConsentDashboard', () => ({ default: () => null }))

const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../components/Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { name: 'Centre User', role: 'centre_user', centre: 'C1' } }),
}))

const SCHEDULES = [{ id: 's1', name: 'Dec 2026', status: 'open', deadline: null }]

beforeEach(() => {
  h.settings = { sewadar_deployment_open: true }
  h.handlers = {}
  h.writes.length = 0
  Object.values(toast).forEach(f => f.mockReset())
})
afterEach(() => cleanup())

describe('ConsentPage autosave when editing closes mid-debounce', () => {
  it('reports the unsaved edit instead of dropping it silently', async () => {
    render(<ConsentPage schedules={SCHEDULES} scheduleId="s1" />)
    const consent = await screen.findByLabelText('Consent for B1')
    await waitFor(() => expect(consent.disabled).toBe(false))
    fireEvent.change(consent, { target: { value: 'no' } })
    // the ASO closes the master switch before the 800ms autosave fires
    h.settings = { sewadar_deployment_open: false }
    h.handlers.portal_settings()
    await waitFor(() => expect(screen.getByLabelText('Consent for B1').disabled).toBe(true))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/not saved/)), { timeout: 2500 })
    expect(h.writes.filter(w => w[0] === 'sewadar_consents')).toHaveLength(0)
  })
})
