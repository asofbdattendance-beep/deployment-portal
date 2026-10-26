// @vitest-environment jsdom
// ConsentDashboard regression: supabase.rpc resolves { error } (never
// throws), so a failed get_parent_consent_matrix silently rendered every
// CENTRE as 0 consented. It must surface the failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import ConsentDashboard from './ConsentDashboard'

const h = vi.hoisted(() => ({ rpcResult: null }))

vi.mock('../lib/supabase', () => {
  const qb = () => {
    const self = {}
    ;['select', 'eq', 'order', 'limit', 'delete'].forEach(k => { self[k] = vi.fn(() => self) })
    self.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
    return self
  }
  return {
    supabase: { rpc: () => Promise.resolve(h.rpcResult), from: () => qb() },
    fetchCentres: () => Promise.resolve([{ name: 'C1', parent_centre: '' }]),
    fetchAllRows: () => Promise.resolve([]),
    fetchPortalSettings: () => Promise.resolve({ sewadar_deployment_open: true }),
  }
})
vi.mock('../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }))

const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('./Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { name: 'Aso', role: 'aso' } }),
}))

const SCHEDULES = [{ id: 's1', name: 'Dec 2026', status: 'open', deadline: null }]

beforeEach(() => { Object.values(toast).forEach(f => f.mockReset()) })
afterEach(() => cleanup())

describe('ConsentDashboard', () => {
  it('surfaces a failed consent-matrix RPC instead of showing zeros silently', async () => {
    h.rpcResult = { data: null, error: { message: 'permission denied' } }
    render(<ConsentDashboard schedules={SCHEDULES} scheduleId="s1" />)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/consent matrix: permission denied/)))
  })

  it('stays quiet on a successful load', async () => {
    h.rpcResult = { data: [{ parent_centre: 'C1', total_badges: 3, consented: 2 }], error: null }
    render(<ConsentDashboard schedules={SCHEDULES} scheduleId="s1" />)
    await screen.findAllByText('C1')
    expect(toast.error).not.toHaveBeenCalled()
  })
})
