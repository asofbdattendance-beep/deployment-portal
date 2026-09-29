// @vitest-environment jsdom
// UsersPage (v48) — smoke + validation tests. Realtime is inert; the supabase
// query builder is a generic chainable mock; toasts are stable fns.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import UsersPage from './UsersPage'

const rpc = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

function qb(resolveData = []) {
  const thenable = Promise.resolve({ data: resolveData, error: null })
  const self = {}
  ;['insert', 'update', 'upsert', 'delete', 'select', 'eq', 'order', 'ilike', 'limit', 'or', 'in', 'neq'].forEach(k => { self[k] = vi.fn(() => self) })
  self.single = vi.fn(() => Promise.resolve({ data: { id: 'r1' }, error: null }))
  self.then = (res, rej) => thenable.then(res, rej)
  return self
}
const fromMock = vi.fn(() => qb())
const invokeMock = vi.fn()
const resetPwMock = vi.fn(() => Promise.resolve({ error: null }))

const noopChannel = () => {
  const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch }
  return ch
}

vi.mock('../lib/supabase', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    supabase: {
      rpc: (...args) => rpc(...args),
      from: (...args) => fromMock(...args),
      channel: () => noopChannel(),
      removeChannel: () => {},
      auth: { resetPasswordForEmail: (...args) => resetPwMock(...args) },
      functions: { invoke: (...args) => invokeMock(...args) },
    },
    fetchAllRows: (table) => {
      if (table === 'portal_users') return Promise.resolve(USERS)
      if (table === 'custom_roles') return Promise.resolve([])
      if (table === 'portal_invitations') return Promise.resolve([])
      // v51: the department-grant picker needs a schedule + department list.
      if (table === 'deployment_schedules') return Promise.resolve([
        { id: 'sched-1', name: 'October 2026 Visit', status: 'open' },
      ])
      if (table === 'deployment_departments') return Promise.resolve([
        { id: 'd-traffic', name: 'Traffic' },
      ])
      return Promise.resolve([])
    },
    fetchCentres: () => Promise.resolve([{ name: 'DELHI' }, { name: 'DELHI-1' }]),
  }
})

const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }
vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({
    profile: { name: 'Root Admin', email: 'root@example.com', role: 'super_admin', auth_id: 'root-auth' },
  }),
}))

const USERS = [
  { id: 'u1', auth_id: 'a1', name: 'Ram Centre', email: 'ram@example.com', role: 'centre_user', custom_role_id: null, centre: 'DELHI', badge_number: 'FB5971GA0001', is_active: true, created_at: '2026-09-01T00:00:00Z' },
  { id: 'u2', auth_id: 'a2', name: 'Old Scanner', email: 'old@example.com', role: 'scanner', custom_role_id: null, centre: null, badge_number: 'SC01', is_active: false, created_at: '2026-08-01T00:00:00Z' },
]

beforeEach(() => {
  rpc.mockReset()
  fromMock.mockClear()
  resetPwMock.mockClear()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
})

afterEach(() => {
  cleanup()
})

async function renderPage() {
  const utils = render(<UsersPage />)
  await waitFor(() => expect(screen.queryByText('Active logins')).toBeTruthy())
  return utils
}

// Two role selects render at once (invitations + create-login-directly), so
// scope to the one in the direct-create card — the card holding "Login email".
function directRoleSelect() {
  const card = screen.getByPlaceholderText('login@example.com').closest('section')
  return within(card).getByDisplayValue('Centre User')
}

describe('UsersPage — renders', () => {
  it('shows the title, stats and the login rows', async () => {
    await renderPage()
    expect(screen.getByRole('heading', { name: 'Users' })).toBeTruthy()
    expect(screen.getByText('Ram Centre')).toBeTruthy()
    expect(screen.getByText('ram@example.com')).toBeTruthy()
  })

  it('marks suspended logins', async () => {
    await renderPage()
    expect(screen.getByText('Old Scanner')).toBeTruthy()
    expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0)
  })
})

describe('UsersPage — invite validation', () => {
  it('refuses a malformed email without touching the database', async () => {
    await renderPage()
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), { target: { value: 'not-an-email' } })
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Nobody' } })
    fireEvent.click(screen.getByRole('button', { name: /Create invite/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/valid email/i)))
    expect(fromMock).not.toHaveBeenCalled()
  })
})

describe('UsersPage — direct provisioning', () => {
  const SEWADAR = { badge_number: 'FB5971GA0001', sewadar_name: 'RAM', centre: 'DELHI' }

  beforeEach(() => {
    invokeMock.mockReset()
    fromMock.mockImplementation((table) => {
      if (table === 'dp_sewadars') return qb([SEWADAR])
      return qb([])
    })
  })

  it('renders the badge search and the create form', async () => {
    await renderPage()
    expect(screen.getByText('Create login', { selector: '.section-title' })).toBeTruthy()
    expect(screen.getByLabelText('Search sewadar by badge number or name')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Create login/i })).toBeTruthy()
  })

  it('refuses to create without picking a sewadar', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/pick the sewadar/i)))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('searches badge and name together, tolerating spaces and dashes', async () => {
    await renderPage()
    fromMock.mockClear()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'fb 5971 ga' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    const ors = fromMock.mock.results.flatMap(r => r.value.or.mock.calls.map(c => c[0]))
    expect(ors.some(s => s.includes('sewadar_name.ilike'))).toBe(true)
    expect(ors.some(s => s.includes('badge_number.ilike') && s.includes('FB5971GA'))).toBe(true)
  })

  it('picks with ArrowDown + Enter from the keyboard', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.keyDown(screen.getByLabelText('Search sewadar by badge number or name'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByLabelText('Search sewadar by badge number or name'), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    // picked badge lands in the box, ready for creation
    expect(screen.getByLabelText('Search sewadar by badge number or name').value).toBe('FB5971GA0001')
  })

  it('creates the login from the picked badge with role + password', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, user_id: 'u9' }, error: null })
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('login@example.com'), { target: { value: 'newram@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Set a password'), { target: { value: 'ram-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'create-login',
      expect.objectContaining({ body: expect.objectContaining({
        email: 'newram@example.com',
        role: 'centre_user',
        badge_number: 'FB5971GA0001',
        password: 'ram-pass-1',
      }) })
    ))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Login created/i)))
  })

  // ── v51: a dept_incharge is created WITH its department grant ──────────
  const deptInchargeCreate = async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('login@example.com'), { target: { value: 'incharge@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Set a password'), { target: { value: 'incharge-1' } })
    // role → dept_incharge, then the schedule + department pickers appear
    fireEvent.change(directRoleSelect(), { target: { value: 'dept_incharge' } })
    await waitFor(() => expect(screen.getByText(/Pick a schedule first/)).toBeTruthy())
    fireEvent.change(screen.getByDisplayValue('— select schedule —'), { target: { value: 'sched-1' } })
    const deptBtn = await waitFor(() => screen.getByRole('button', { name: /Traffic/ }))
    fireEvent.click(deptBtn)
  }

  it('refuses a dept_incharge with no department picked', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('login@example.com'), { target: { value: 'incharge@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Set a password'), { target: { value: 'incharge-1' } })
    fireEvent.change(directRoleSelect(), { target: { value: 'dept_incharge' } })
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/schedule this department applies to/i)))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('sends the department grant on the create-login body and confirms success', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, user_id: 'u10' }, error: null })
    // the grant really lands, so the success toast is earned
    fromMock.mockImplementation((table) => {
      if (table === 'dp_sewadars') return qb([SEWADAR])
      if (table === 'department_incharge_assignments') return qb([{ department_id: 'd-traffic' }])
      return qb([])
    })
    await deptInchargeCreate()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'create-login',
      expect.objectContaining({ body: expect.objectContaining({
        role: 'dept_incharge',
        badge_number: 'FB5971GA0001',
        dept_schedule_id: 'sched-1',
        dept_ids: ['d-traffic'],
      }) })
    ))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Login created/i)))
  })

  it('reports LOUDLY when the grant cannot be applied — never a false "created"', async () => {
    // The function reports success but no assignment rows exist afterwards —
    // exactly what an OLD deployed function does (it ignores the new fields).
    invokeMock.mockResolvedValue({ data: { ok: true, user_id: 'u11' }, error: null })
    fromMock.mockImplementation((table) => {
      if (table === 'dp_sewadars') return qb([SEWADAR])
      if (table === 'department_incharge_assignments') return qb([])   // grant absent
      return qb([])
    })
    await deptInchargeCreate()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/department grant did not apply/i)
    ))
    // and the misleading success toast must NOT also have fired
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/Login created/i))
  })
})
