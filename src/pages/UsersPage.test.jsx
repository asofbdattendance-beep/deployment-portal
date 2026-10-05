// @vitest-environment jsdom
// UsersPage (v48) — smoke + validation tests. Realtime is inert; the supabase
// query builder is a generic chainable mock; toasts are stable fns.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import UsersPage from './UsersPage'

const rpc = vi.fn()
// Records every fetchAllRows request (table + stable key) so tests can pin
// the R6/R7 contract: unique keys only — a non-unique created_at key lets
// the Map dedupe collapse same-transaction rows (grants) into one.
const fetchAllRowsCalls = []
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
const getSessionMock = vi.fn()

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
      auth: {
        resetPasswordForEmail: (...args) => resetPwMock(...args),
        getSession: (...args) => getSessionMock(...args),
      },
      functions: { invoke: (...args) => invokeMock(...args) },
    },
    fetchAllRows: (table, _select, _filters, stableKey) => {
      fetchAllRowsCalls.push({ table, stableKey })
      if (table === 'portal_users') return Promise.resolve(usersFixture)
      if (table === 'custom_roles') return Promise.resolve([])
      if (table === 'portal_invitations') return Promise.resolve(invitesFixture)
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

// ── v69 lifecycle mocks ────────────────────────────────────────────────────
// useManageLogin is mocked at the module boundary so drawer / bulk / import
// tests can drive deterministic { data, error } results and assert the exact
// manage-login bodies — the real hook would need invokeMock to emulate the
// FunctionsHttpError context parsing.
const manageMock = {
  busy: false,
  deleteUser: vi.fn(() => Promise.resolve({ data: null, error: null })),
  setPassword: vi.fn(() => Promise.resolve({ data: null, error: null })),
  signOutAll: vi.fn(() => Promise.resolve({ data: null, error: null })),
  loadMeta: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  bulkCreate: vi.fn(() => Promise.resolve({ data: { results: [] }, error: null })),
  sendInvite: vi.fn(() => Promise.resolve({ data: { invited: true }, error: null })),
}
vi.mock('../hooks/useManageLogin', () => ({
  useManageLogin: () => manageMock,
}))

// The import dialog is mocked to a marker: tests assert the page wires
// open / onClose / onBulkCreate / busy, then drive onBulkCreate directly —
// the real dialog's file ingestion (xlsx + FileReader) is covered by its
// own suite.
const h = vi.hoisted(() => ({ importProps: null }))
vi.mock('../components/UserImportDialog', () => ({
  default: (props) => {
    h.importProps = props
    return props.open ? <div data-testid="import-dialog" /> : null
  },
}))

const USERS = [
  { id: 'u1', auth_id: 'a1', name: 'Ram Centre', email: 'ram@example.com', role: 'centre_user', custom_role_id: null, centre: 'DELHI', badge_number: 'FB5971GA0001', is_active: true, created_at: '2026-09-01T00:00:00Z' },
  { id: 'u2', auth_id: 'a2', name: 'Old Scanner', email: 'old@example.com', role: 'scanner', custom_role_id: null, centre: null, badge_number: 'SC01', is_active: false, created_at: '2026-08-01T00:00:00Z' },
]

// Mutable fixtures — describes swap these to exercise the phase filter, the
// archived status, bulk selection and the drawer without touching the shared
// default rows above.
let usersFixture = USERS
let invitesFixture = []

beforeEach(() => {
  rpc.mockReset()
  fromMock.mockClear()
  invokeMock.mockReset()
  resetPwMock.mockClear()
  // signed-in by default — the create-login session guard only trips in the
  // test that explicitly clears the session
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null })
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  // v69: reset the manage-login mock to its default happy-path results
  manageMock.busy = false
  manageMock.deleteUser.mockReset().mockResolvedValue({ data: null, error: null })
  manageMock.setPassword.mockReset().mockResolvedValue({ data: null, error: null })
  manageMock.signOutAll.mockReset().mockResolvedValue({ data: null, error: null })
  manageMock.loadMeta.mockReset().mockResolvedValue({ data: {}, error: null })
  manageMock.bulkCreate.mockReset().mockResolvedValue({ data: { results: [] }, error: null })
  manageMock.sendInvite.mockReset().mockResolvedValue({ data: { invited: true }, error: null })
  h.importProps = null
  usersFixture = USERS
  invitesFixture = []
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

  it('keys the grants + schedule lists on unique columns, never created_at (R6/R7)', async () => {
    await renderPage()
    const keyOf = (t) => fetchAllRowsCalls.find((c) => c.table === t)?.stableKey
    // created_at is NOT unique (one transaction now() for a whole save) — a
    // created_at key collapses N department grants to 1 in the dedupe Map.
    expect(keyOf('department_incharge_assignments')).toBe('id')
    expect(keyOf('deployment_schedules')).toBe('id')
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

  it('sends the optional location on the create-login body', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, user_id: 'u9' }, error: null })
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('login@example.com'), { target: { value: 'newram@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Set a password'), { target: { value: 'ram-pass-1' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Bhati Gate 2'), { target: { value: 'Bhati Gate 2' } })
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'create-login',
      expect.objectContaining({ body: expect.objectContaining({
        email: 'newram@example.com',
        location: 'Bhati Gate 2',
      }) })
    ))
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

  // ── overlap repair: complete existing records, surface REAL errors ────
  const fillDirectForm = async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search sewadar by badge number or name'), { target: { value: 'FB5971' } })
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('login@example.com'), { target: { value: 'overlap@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Set a password'), { target: { value: 'overlap-1' } })
  }

  it('refuses to invoke while signed out — never fires a headerless request (401 guard)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null })
    await fillDirectForm()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/session/i)))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('shows the function’s REAL error body instead of the generic non-2xx text', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      response: { status: 409 },
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { status: 409, json: async () => ({ error: 'A login already exists for this email — edit or reinstate it instead' }) },
      }),
    })
    await fillDirectForm()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/edit or reinstate it instead/i)
    ))
  })

  it('names the overlap completion when the function reuses an existing record', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, user_id: 'u12', mode: 'overlap-completed' }, error: null })
    await fillDirectForm()
    fireEvent.click(screen.getByRole('button', { name: /Create login/i }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/existing portal record completed/i)
    ))
  })
})

// ── v69 lifecycle: phase filter, archived status, bulk guards, drawer ─────
// Fixture roles and their userPhaseGroup() mapping (via phasesForRole):
//   centre_user → both · scanner → attendance · vss_operator → deployment

describe('UsersPage — phase group filter', () => {
  it('renders the four phase chips with All pressed', async () => {
    await renderPage()
    for (const name of ['All', 'Deployment', 'Attendance', 'Both']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('groups rows under phase headers via userPhaseGroup (all)', async () => {
    await renderPage()
    // u1 centre_user → both, u2 scanner → attendance
    expect(screen.getByText('Deployment + Attendance (1)')).toBeTruthy()
    expect(screen.getByText('Attendance (1)')).toBeTruthy()
  })

  it('filters to the attendance group and hides the headers', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Attendance' }))
    await waitFor(() => expect(screen.queryByText('Ram Centre')).toBeNull())
    expect(screen.getByText('Old Scanner')).toBeTruthy()
    expect(screen.queryByText('Attendance (1)')).toBeNull()
    expect(screen.getByRole('button', { name: 'Attendance' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('filters to the deployment group (vss_operator fixture)', async () => {
    usersFixture = [...USERS, { id: 'u3', auth_id: 'a3', name: 'VSS Desk', email: 'vss@example.com', role: 'vss_operator', custom_role_id: null, centre: null, badge_number: 'VSS01', is_active: true, created_at: '2026-07-01T00:00:00Z' }]
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Deployment' }))
    await waitFor(() => expect(screen.getByText('VSS Desk')).toBeTruthy())
    expect(screen.queryByText('Ram Centre')).toBeNull()
    expect(screen.queryByText('Old Scanner')).toBeNull()
  })

  it('shows the empty state when the phase group has no logins', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Deployment' }))
    await waitFor(() => expect(screen.getByText('No logins match these filters.')).toBeTruthy())
  })

  it('filters to the both group', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    await waitFor(() => expect(screen.getByText('Ram Centre')).toBeTruthy())
    expect(screen.queryByText('Old Scanner')).toBeNull()
  })

  it('groups centre_admin under Deployment, never Both (deployment-side, not scanning)', async () => {
    usersFixture = [...USERS, { id: 'u3', auth_id: 'a3', name: 'Anil Admin', email: 'anil@example.com', role: 'centre_admin', custom_role_id: null, centre: 'DELHI', badge_number: null, is_active: true, created_at: '2026-07-01T00:00:00Z' }]
    await renderPage()
    expect(screen.getByText('Deployment (1)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Deployment' }))
    await waitFor(() => expect(screen.getByText('Anil Admin')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    await waitFor(() => expect(screen.queryByText('Anil Admin')).toBeNull())
  })
})

describe('UsersPage — archived status', () => {
  it('shows the Archived pill and swaps Archive for Restore', async () => {
    usersFixture = [{ ...USERS[0], archived_at: '2026-09-01T00:00:00Z' }]
    await renderPage()
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Restore/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull()
  })

  it('excludes archived logins from Active-only and includes them in Archived-only', async () => {
    usersFixture = [{ ...USERS[0], archived_at: '2026-09-01T00:00:00Z' }]
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } })
    await waitFor(() => expect(screen.getByText('No logins match these filters.')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'archived' } })
    await waitFor(() => expect(screen.getByText('Ram Centre')).toBeTruthy())
  })
})

describe('UsersPage — bulk selection and guards', () => {
  const selectAll = () => fireEvent.click(screen.getByLabelText('Select all logins'))
  const bulkBar = () => screen.getByText(/\d+ selected/).closest('.bulk-bar')
  // Each from('portal_users') builds a fresh qb — collect them all; the ones
  // whose update() ran carry the lifecycle patch.
  const portalQbs = () => fromMock.mock.results.map(r => r.value).filter(qb => qb.update?.mock?.calls?.length)

  it('reveals the bulk bar with Archive/Restore/Suspend/Delete when rows are selected', async () => {
    await renderPage()
    selectAll()
    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy())
    const bar = bulkBar()
    for (const name of ['Archive', 'Restore', 'Suspend', 'Delete']) {
      expect(within(bar).getByRole('button', { name })).toBeTruthy()
    }
  })

  it('skips the signed-in admin (self) and reports it', async () => {
    usersFixture = [{ ...USERS[0], auth_id: 'root-auth' }, USERS[1]]
    await renderPage()
    selectAll()
    fireEvent.click(within(bulkBar()).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/Skipped Ram Centre/)))
    // the remaining eligible login still reaches the confirm modal
    expect(screen.getByRole('dialog', { name: 'Archive 1 login?' })).toBeTruthy()
  })

  it('skips the last active super_admin and opens no confirm', async () => {
    usersFixture = [{ ...USERS[0], role: 'super_admin', auth_id: 'other-auth' }]
    await renderPage()
    selectAll()
    fireEvent.click(within(bulkBar()).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/Skipped Ram Centre/)))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('bulk-archives the eligible logins with the archived_at patch', async () => {
    await renderPage()
    selectAll()
    fireEvent.click(within(bulkBar()).getByRole('button', { name: 'Archive' }))
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Archive 2 logins?' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/2 logins archived/)))
    // the patch really carries the archive stamp for both rows
    const qbs = portalQbs()
    expect(qbs.length).toBe(2)
    const patch = qbs[0].update.mock.calls[0][0]
    expect(patch.archived_at).toEqual(expect.any(String))
    expect(patch.archived_by).toBe('Root Admin')
    expect(patch.is_active).toBe(false)
    expect(qbs.flatMap(qb => qb.eq.mock.calls)).toEqual([['id', 'u1'], ['id', 'u2']])
  })

  it('bulk-deletes via the manage-login function', async () => {
    await renderPage()
    selectAll()
    fireEvent.click(within(bulkBar()).getByRole('button', { name: 'Delete' }))
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Delete 2 logins?' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(manageMock.deleteUser).toHaveBeenCalledWith('u1'))
    expect(manageMock.deleteUser).toHaveBeenCalledWith('u2')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Deleted 2 logins/)))
  })
})

describe('UsersPage — drawer lifecycle (archive / restore / delete)', () => {
  const openDrawerFor = async (name) => {
    fireEvent.click(screen.getByText(name))
    return waitFor(() => screen.getByRole('dialog', { name: /User details/ }))
  }

  it('opens the drawer with identity, status and phase pills', async () => {
    await renderPage()
    const drawer = await openDrawerFor('Ram Centre')
    expect(within(drawer).getByText('Identity')).toBeTruthy()
    expect(within(drawer).getByText('Active')).toBeTruthy()
    expect(within(drawer).getByText('Deployment + Attendance')).toBeTruthy()
  })

  it('archives from the drawer with the archived_at patch', async () => {
    await renderPage()
    const drawer = await openDrawerFor('Ram Centre')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Archive' }))
    const confirm = await waitFor(() => screen.getByRole('dialog', { name: 'Archive Ram Centre?' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Login archived/)))
    const patch = fromMock.mock.results.map(r => r.value).find(qb => qb.update?.mock?.calls?.length).update.mock.calls[0][0]
    expect(patch.archived_at).toEqual(expect.any(String))
    expect(patch.is_active).toBe(false)
  })

  it('restores an archived login from the drawer', async () => {
    usersFixture = [{ ...USERS[1], archived_at: '2026-09-01T00:00:00Z' }]
    await renderPage()
    const drawer = await openDrawerFor('Old Scanner')
    expect(within(drawer).getByText('Archived')).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Restore' }))
    const confirm = await waitFor(() => screen.getByRole('dialog', { name: 'Restore Old Scanner?' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Login restored/)))
    const patch = fromMock.mock.results.map(r => r.value).find(qb => qb.update?.mock?.calls?.length).update.mock.calls[0][0]
    expect(patch.archived_at).toBeNull()
    expect(patch.is_active).toBe(true)
  })

  it('deletes from the drawer via the manage-login function', async () => {
    await renderPage()
    const drawer = await openDrawerFor('Old Scanner')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete' }))
    const confirm = await waitFor(() => screen.getByRole('dialog', { name: /Delete Old Scanner permanently/ }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(manageMock.deleteUser).toHaveBeenCalledWith('u2'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Login deleted permanently/)))
  })

  it('blocks archiving your own login', async () => {
    usersFixture = [{ ...USERS[0], auth_id: 'root-auth' }, USERS[1]]
    await renderPage()
    const drawer = await openDrawerFor('Ram Centre')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/cannot be archived/)))
    expect(screen.queryByRole('dialog', { name: /Archive/ })).toBeNull()
  })

  it('opens the role-changing Edit dialog from the drawer Edit button', async () => {
    await renderPage()
    const drawer = await openDrawerFor('Ram Centre')
    fireEvent.click(within(drawer).getByRole('button', { name: /Edit \/ Change Role/ }))
    // drawer closes, Edit modal opens with role + location fields
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /User details/ })).toBeNull())
    const editModal = screen.getByText('Edit login').closest('.modal')
    expect(within(editModal).getByText('Role (permissions)')).toBeTruthy()
    expect(within(editModal).getByText('Location (optional)')).toBeTruthy()
  })
})

describe('UsersPage — drawer set password (min 6)', () => {
  const openPwModal = async (name) => {
    fireEvent.click(screen.getByText(name))
    const drawer = await waitFor(() => screen.getByRole('dialog', { name: /User details/ }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set Password' }))
    // the pw modal carries no role="dialog" — anchor on its h4 title
    const title = await waitFor(() => screen.getByText('Set password', { selector: 'h4' }))
    return title.closest('.modal')
  }

  it('refuses a password shorter than 6 characters', async () => {
    await renderPage()
    const modal = await openPwModal('Ram Centre')
    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'abc' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/at least 6 characters/)))
    expect(manageMock.setPassword).not.toHaveBeenCalled()
  })

  it('sets a valid password via the manage-login function', async () => {
    await renderPage()
    const modal = await openPwModal('Ram Centre')
    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'abcdef' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(manageMock.setPassword).toHaveBeenCalledWith('u1', 'abcdef'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Password set/)))
  })
})

describe('UsersPage — bulk import', () => {
  const openImport = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Import/ }))
    await waitFor(() => expect(h.importProps.open).toBe(true))
  }

  it('opens the import dialog from the Import button', async () => {
    await renderPage()
    await openImport()
    expect(screen.getByTestId('import-dialog')).toBeTruthy()
  })

  it('wires onBulkCreate to the manage-login bulk_create action', async () => {
    await renderPage()
    await openImport()
    const rows = [{ name: 'New Person', email: 'new@example.com', role: 'centre_user', password: 'secret1' }]
    const result = await h.importProps.onBulkCreate(rows)
    expect(manageMock.bulkCreate).toHaveBeenCalledWith(rows)
    expect(result).toEqual([{ email: 'new@example.com', status: 'created', error: null }])
  })

  it('maps a bulk_create failure to per-row error results', async () => {
    manageMock.bulkCreate.mockResolvedValue({ data: null, error: 'bulk failed' })
    await renderPage()
    await openImport()
    const rows = [{ name: 'New Person', email: 'new@example.com', role: 'centre_user', password: 'secret1' }]
    const result = await h.importProps.onBulkCreate(rows)
    expect(result).toEqual([{ email: 'new@example.com', status: 'error', error: 'bulk failed' }])
  })
})

describe('UsersPage — export', () => {
  it('renders the Export button', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
  })
})

describe('UsersPage — invite resend', () => {
  const INVITE = { id: 'inv1', name: 'Invited Person', email: 'invited@example.com', role: 'centre_user', code: 'ABC123', expires_at: '2099-01-01T00:00:00Z', claimed_at: null }

  it('resends a pending invite via the manage-login send_invite action', async () => {
    invitesFixture = [INVITE]
    await renderPage()
    expect(screen.getByText('Open invites (1)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Resend/ }))
    await waitFor(() => expect(manageMock.sendInvite).toHaveBeenCalledWith('invited@example.com', 'centre_user'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Invite email sent/)))
  })

  it('falls back to copying the code when the send fails', async () => {
    invitesFixture = [INVITE]
    manageMock.sendInvite.mockResolvedValue({ data: null, error: 'smtp down' })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Resend/ }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/code copied instead/)))
  })
})
