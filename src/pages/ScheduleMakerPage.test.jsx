// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ScheduleMakerPage from './ScheduleMakerPage'

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toast = { error: toastError, success: toastSuccess, info: vi.fn(), warning: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({
    profile: { name: 'Root Admin', email: 'root@example.com', role: 'super_admin' },
  }),
}))

const mockDepartments = [
  {
    id: 'dept-1',
    name: 'MEDICAL',
    is_active: true,
    min_days: 1,
    requires_stay_at_bhati: false,
    requires_initiated: false,
    include_vss: false,
    expected_in_time: '08:00:00',
    expected_out_time: '17:00:00',
  },
]

const mockSchedules = [
  {
    id: 'sched-1',
    name: 'December 2026 Visit',
    status: 'open',
    visit_start_date: '2026-12-09',
    visit_end_date: '2026-12-13',
  },
]

let updateCalls = []

function createQueryBuilder(table) {
  let resolveData = []
  if (table === 'deployment_schedules') resolveData = mockSchedules
  if (table === 'deployment_departments') resolveData = mockDepartments

  const self = {
    _table: table,
    select: vi.fn(() => self),
    order: vi.fn(() => self),
    eq: vi.fn((col, val) => {
      self._eqCol = col
      self._eqVal = val
      return self
    }),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    insert: vi.fn((payload) => Promise.resolve({ data: payload, error: null })),
    update: vi.fn((payload) => {
      self._updatePayload = payload
      return self
    }),
    upsert: vi.fn((payload) => {
      updateCalls.push({ table, payload, type: 'upsert' })
      return Promise.resolve({ data: payload, error: null })
    }),
    delete: vi.fn(() => self),
    then: (resolve) => {
      if (self._updatePayload) {
        updateCalls.push({ table, payload: self._updatePayload, eqCol: self._eqCol, eqVal: self._eqVal })
      }
      return resolve({ data: resolveData, error: null })
    },
  }
  return self
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn((table) => createQueryBuilder(table)),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  fetchAllRows: vi.fn((table) => {
    if (table === 'deployment_schedules') return Promise.resolve(mockSchedules)
    if (table === 'deployment_departments') return Promise.resolve(mockDepartments)
    return Promise.resolve([])
  }),
  getCount: vi.fn(() => Promise.resolve(0)),
  fetchCentres: vi.fn(() => Promise.resolve([])),
}))

describe('ScheduleMakerPage - Department Shift Cutoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateCalls = []
  })

  it('renders Expected IN and Expected OUT cutoff inputs in department rules and updates them on save', async () => {
    render(<ScheduleMakerPage />)

    // Wait for the department to appear
    await waitFor(() => {
      expect(screen.getAllByText('MEDICAL').length).toBeGreaterThan(0)
    })

    // Click "Rules" button for MEDICAL department
    const rulesBtn = screen.getByRole('button', { name: /rules/i })
    fireEvent.click(rulesBtn)

    // Check that Expected IN and OUT inputs are visible
    const inInput = screen.getByLabelText(/expected in time \(cutoff\)/i)
    const outInput = screen.getByLabelText(/expected out time \(cutoff\)/i)

    expect(inInput).toBeTruthy()
    expect(outInput).toBeTruthy()

    // Change shift cutoffs
    fireEvent.change(inInput, { target: { value: '07:30' } })
    fireEvent.change(outInput, { target: { value: '18:00' } })

    // Save rules
    const saveBtn = screen.getByRole('button', { name: /save rules/i })
    fireEvent.click(saveBtn)

    // Verify update was dispatched with new cutoffs
    await waitFor(() => {
      const deptUpdate = updateCalls.find(c => c.table === 'deployment_departments')
      expect(deptUpdate).toBeDefined()
      expect(deptUpdate.payload).toMatchObject({
        expected_in_time: '07:30',
        expected_out_time: '18:00',
      })
    })
  })
})
