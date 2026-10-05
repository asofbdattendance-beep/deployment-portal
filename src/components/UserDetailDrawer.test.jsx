// @vitest-environment jsdom
// UserDetailDrawer — slide-in panel for portal user detail + admin actions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import UserDetailDrawer from './UserDetailDrawer'

const baseUser = {
  id: 'u1',
  name: 'Test User',
  email: 'test@example.com',
  role: 'centre_user',
  badge_number: 'B001',
  centre: 'Main Centre',
  sewadar_name: 'Test Sewadar',
  is_active: true,
  is_archived: false,
}

const baseMeta = {
  created_at: '2025-01-15T10:30:00Z',
  last_login: '2025-03-20T14:00:00Z',
}

const baseDeptGrants = [
  { id: 'g1', department_id: 'd1', department_name: 'Traffic', schedule_id: 's1', schedule_name: 'Spring 2025' },
]

const baseAuditRows = [
  { id: 'a1', action: 'user.created', created_at: '2025-01-15T10:30:00Z', detail: 'Initial provisioning' },
  { id: 'a2', action: 'user.role_changed', created_at: '2025-02-01T09:00:00Z', detail: 'Role updated to centre_admin' },
]

const defaultProps = {
  user: baseUser,
  open: true,
  onClose: vi.fn(),
  meta: baseMeta,
  deptGrants: baseDeptGrants,
  auditRows: baseAuditRows,
  onSetPassword: vi.fn(),
  onSignOutAll: vi.fn(),
  onSuspend: vi.fn(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onDelete: vi.fn(),
  busy: false,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('UserDetailDrawer', () => {
  it('returns null when open is false', () => {
    const { container } = render(<UserDetailDrawer {...defaultProps} open={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when user is null', () => {
    const { container } = render(<UserDetailDrawer {...defaultProps} user={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders identity section with name, email, role, badge, centre', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    expect(screen.getByText('Test User')).toBeTruthy()
    expect(screen.getByText('test@example.com')).toBeTruthy()
    expect(screen.getByText('B001')).toBeTruthy()
    expect(screen.getByText('Main Centre')).toBeTruthy()
    expect(screen.getByText('Test Sewadar')).toBeTruthy()
  })

  it('renders status pill and phase-group pill', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getAllByText(/Deployment/i).length).toBeGreaterThan(0)
  })

  it('renders phase-group pill as Attendance for scanner role', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, role: 'scanner' }} />)
    expect(screen.getByText('Attendance')).toBeTruthy()
  })

  it('renders phase-group pill as Both for super_admin role', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, role: 'super_admin' }} />)
    expect(screen.getByText('Deployment + Attendance')).toBeTruthy()
  })

  it('renders suspended status pill', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, is_active: false }} />)
    expect(screen.getByText('Suspended')).toBeTruthy()
  })

  it('renders archived status pill', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, is_archived: true }} />)
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('renders auth meta with created and last login dates', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    expect(screen.getByText('Created', { selector: 'dt' })).toBeTruthy()
    expect(screen.getByText('Last login', { selector: 'dt' })).toBeTruthy()
  })

  it('renders department grants list', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    expect(screen.getByText('Traffic')).toBeTruthy()
    expect(screen.getByText('Spring 2025')).toBeTruthy()
  })

  it('renders empty dept grants message when none', () => {
    render(<UserDetailDrawer {...defaultProps} deptGrants={[]} />)
    expect(screen.getByText(/No department grants/i)).toBeTruthy()
  })

  it('renders audit trail entries', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    expect(screen.getByText('user.created')).toBeTruthy()
    expect(screen.getByText('user.role_changed')).toBeTruthy()
    expect(screen.getByText(/Initial provisioning/)).toBeTruthy()
  })

  it('renders empty audit message when no rows', () => {
    render(<UserDetailDrawer {...defaultProps} auditRows={[]} />)
    expect(screen.getByText(/No audit entries/i)).toBeTruthy()
  })

  it('calls onSetPassword with user when Set Password clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /set password/i }))
    expect(defaultProps.onSetPassword).toHaveBeenCalledWith(baseUser)
  })

  it('calls onSignOutAll with user when Sign Out All clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /sign out all/i }))
    expect(defaultProps.onSignOutAll).toHaveBeenCalledWith(baseUser)
  })

  it('calls onSuspend with user when Suspend clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /suspend/i }))
    expect(defaultProps.onSuspend).toHaveBeenCalledWith(baseUser)
  })

  it('calls onArchive with user when Archive clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /archive/i }))
    expect(defaultProps.onArchive).toHaveBeenCalledWith(baseUser)
  })

  it('calls onDelete with user when Delete clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(defaultProps.onDelete).toHaveBeenCalledWith(baseUser)
  })

  it('shows Restore instead of Suspend when user is suspended', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, is_active: false }} />)
    expect(screen.queryByRole('button', { name: /suspend/i })).toBeNull()
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy()
  })

  it('shows Restore instead of Archive when user is archived', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, is_archived: true }} />)
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull()
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy()
  })

  it('calls onRestore with user when Restore clicked', () => {
    render(<UserDetailDrawer {...defaultProps} user={{ ...baseUser, is_active: false }} />)
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))
    expect(defaultProps.onRestore).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }))
  })

  it('disables all action buttons when busy is true', () => {
    render(<UserDetailDrawer {...defaultProps} busy />)
    const buttons = screen.getAllByRole('button')
    const actionButtons = buttons.filter(b => {
      const label = b.getAttribute('aria-label') || ''
      const text = b.textContent || ''
      return !/close/i.test(label) && !/close/i.test(text)
    })
    expect(actionButtons.length).toBeGreaterThan(0)
    actionButtons.forEach(b => expect(b.disabled).toBe(true))
  })

  it('has role=dialog and aria-modal', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('calls onClose when Escape is pressed', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('calls onClose when overlay is clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    const overlay = document.querySelector('.drawer-overlay')
    fireEvent.click(overlay)
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('does not call onClose when drawer body is clicked', () => {
    render(<UserDetailDrawer {...defaultProps} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('focuses the close button on open', async () => {
    render(<UserDetailDrawer {...defaultProps} />)
    await new Promise(r => setTimeout(r, 80))
    const closeBtn = screen.getByRole('button', { name: /close user details/i })
    expect(document.activeElement).toBe(closeBtn)
  })

  it('renders with minimal props (no optional callbacks)', () => {
    render(<UserDetailDrawer user={baseUser} open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Test User')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set password/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})
