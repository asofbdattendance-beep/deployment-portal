// @vitest-environment jsdom
/**
 * UserImportDialog — bulk .xlsx import of portal users.
 * Covers the template round-trip, the pick → preview → confirm → results
 * flow, per-row validation (incl. password min-6), a11y, and the
 * never-log-passwords guarantee.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import UserImportDialog, { parseImportRows, TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROW } from './UserImportDialog'

// Keep the real xlsx builders so the template round-trip is a true read-back;
// only the file system boundary (read) and the download trigger are mocked.
const mocks = vi.hoisted(() => ({
  readWorkbookRows: vi.fn(),
  saveBlob: vi.fn(() => true),
  actualExcel: null,
}))

vi.mock('../lib/excel', async (importOriginal) => {
  mocks.actualExcel = await importOriginal()
  return {
    ...mocks.actualExcel,
    readWorkbookRows: (...a) => mocks.readWorkbookRows(...a),
    saveBlob: (...a) => mocks.saveBlob(...a),
  }
})

const onClose = vi.fn()
const baseProps = { open: true, onClose, onBulkCreate: async () => [], busy: false }

beforeEach(() => {
  onClose.mockReset()
  mocks.readWorkbookRows.mockReset()
  mocks.saveBlob.mockClear()
})

afterEach(() => { cleanup() })

// ── parseImportRows (pure) ───────────────────────────────────────────────

describe('parseImportRows', () => {
  it('accepts a full valid row carrying all seven template columns', () => {
    const { valid, errors } = parseImportRows([
      { name: 'A', email: 'a@x.com', role: 'centre_user', badge: 'FB1', centre: 'Bhati', password: 'secret1', location: 'Bhati Gate 2' },
    ])
    expect(errors).toHaveLength(0)
    expect(valid).toEqual([
      { name: 'A', email: 'a@x.com', role: 'centre_user', badge: 'FB1', centre: 'Bhati', password: 'secret1', location: 'Bhati Gate 2' },
    ])
  })

  it('treats location as optional — missing location still validates', () => {
    const { valid, errors } = parseImportRows([
      { name: 'A', email: 'a@x.com', role: 'scanner', badge: 'FB1', centre: '', password: 'secret1' },
    ])
    expect(errors).toHaveLength(0)
    expect(valid[0].location).toBe('')
  })

  it('rejects missing name, email and role with 1-indexed spreadsheet rows', () => {
    const { valid, errors } = parseImportRows([
      { email: 'a@x.com', role: 'centre_user', password: 'secret1' }, // row 2: no name
      { name: 'B', role: 'centre_user', password: 'secret1' },          // row 3: no email
      { name: 'C', email: 'c@x.com', password: 'secret1' },             // row 4: no role
    ])
    expect(valid).toHaveLength(0)
    expect(errors).toEqual([
      { row: 2, message: 'Missing name' },
      { row: 3, message: 'Missing email' },
      { row: 4, message: 'Missing role' },
    ])
  })

  it('rejects a malformed email', () => {
    const { errors } = parseImportRows([{ name: 'A', email: 'not-an-email', role: 'centre_user', password: 'secret1' }])
    expect(errors[0].message).toBe('Invalid email')
  })

  it('rejects an unknown role', () => {
    const { errors } = parseImportRows([{ name: 'A', email: 'a@x.com', role: 'wizard', password: 'secret1' }])
    expect(errors[0].message).toContain('Unknown role')
  })

  it('rejects an unknown role with the original label in the message', () => {
    const { valid, errors } = parseImportRows([{ name: 'A', email: 'a@x.com', role: 'wizard', password: 'secret1' }])
    expect(valid).toHaveLength(0)
    expect(errors[0].message).toBe('Unknown role "wizard"')
  })

  it('resolves role labels to their canonical base role and stores it on the valid row', () => {
    const { valid, errors } = parseImportRows([
      { name: 'A', email: 'a@x.com', role: 'ASO', password: 'secret1' },
      { name: 'B', email: 'b@x.com', role: 'SCANNER', password: 'secret1' },
      { name: 'C', email: 'c@x.com', role: 'DEPTINC (LANGAR)', password: 'secret1' },
      { name: 'D', email: 'd@x.com', role: 'VSS OPERATOR', password: 'secret1' },
      { name: 'E', email: 'e@x.com', role: 'SUPER ADMIN', password: 'secret1' },
      { name: 'F', email: 'f@x.com', role: 'CENTRE USER', password: 'secret1' },
    ])
    expect(errors).toHaveLength(0)
    expect(valid.map((r) => r.role)).toEqual([
      'aso',
      'scanner',
      'dept_incharge',
      'vss_operator',
      'super_admin',
      'centre_user',
    ])
  })

  it('still accepts canonical base roles unchanged', () => {
    const { valid, errors } = parseImportRows([
      { name: 'A', email: 'a@x.com', role: 'centre_admin', password: 'secret1' },
    ])
    expect(errors).toHaveLength(0)
    expect(valid[0].role).toBe('centre_admin')
  })

  it('rejects a password shorter than 6 characters (min-6 hint)', () => {
    const { valid, errors } = parseImportRows([{ name: 'A', email: 'a@x.com', role: 'centre_user', password: '123' }])
    expect(valid).toHaveLength(0)
    expect(errors[0].message).toMatch(/at least 6 characters/)
  })

  it('treats badge and centre as optional passthroughs', () => {
    const { valid, errors } = parseImportRows([{ name: 'A', email: 'a@x.com', role: 'aso', password: 'secret1' }])
    expect(errors).toHaveLength(0)
    expect(valid[0]).toMatchObject({ badge: '', centre: '' })
  })

  it('accepts badge_number as an alias for badge (export round-trip)', () => {
    const { valid, errors } = parseImportRows([
      { name: 'A', email: 'a@x.com', role: 'scanner', badge_number: 'SC9', centre: '', password: 'secret1' },
    ])
    expect(errors).toHaveLength(0)
    expect(valid[0].badge).toBe('SC9')
  })
})

// ── Template ──────────────────────────────────────────────────────────────

describe('template', () => {
  it('declares the exact headers in order', () => {
    expect(TEMPLATE_HEADERS).toEqual(['email', 'badge', 'password', 'name', 'role', 'centre', 'location'])
  })

  it('ships one fully-populated example row', () => {
    for (const h of TEMPLATE_HEADERS) expect(TEMPLATE_EXAMPLE_ROW).toHaveProperty(h)
  })

  it('downloads a real .xlsx whose headers and example row round-trip', async () => {
    render(<UserImportDialog {...baseProps} />)
    fireEvent.click(screen.getByText('Download template'))
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalled())

    const blob = mocks.saveBlob.mock.calls[0][0]
    // jsdom File/Blob lack arrayBuffer(); read via FileReader and hand the
    // real reader a minimal file-like object.
    const buf = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsArrayBuffer(blob)
    })
    const rows = await mocks.actualExcel.readWorkbookRows({ name: 'template.xlsx', arrayBuffer: async () => buf })

    expect(rows).toHaveLength(1)
    const row = rows[0]
    for (const h of TEMPLATE_HEADERS) expect(row).toHaveProperty(h)
    expect(row.email).toBe(TEMPLATE_EXAMPLE_ROW.email)
    expect(row.role).toBe(TEMPLATE_EXAMPLE_ROW.role)
  })
})

// ── Dialog flow ───────────────────────────────────────────────────────────

describe('UserImportDialog flow', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<UserImportDialog {...baseProps} open={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('opens as a modal dialog with aria-modal and closes on Escape', async () => {
    render(<UserImportDialog {...baseProps} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(baseProps.onClose).toHaveBeenCalled())
  })

  it('previews valid and rejected rows after a file is picked', async () => {
    mocks.readWorkbookRows.mockResolvedValue([
      { name: 'A', email: 'a@x.com', role: 'centre_user', badge: 'FB1', centre: 'Bhati', password: 'secret1' },
      { name: '', email: 'b@x.com', role: 'centre_user', password: 'secret1' },
    ])
    render(<UserImportDialog {...baseProps} />)
    fireEvent.change(screen.getByLabelText('Choose an .xlsx file to import'), {
      target: { files: [{ name: 'users.xlsx' }] },
    })

    await waitFor(() => expect(screen.getByText('1 valid')).toBeTruthy())
    expect(screen.getByText('1 rejected')).toBeTruthy()
    expect(screen.getByText('a@x.com')).toBeTruthy()
    expect(screen.getByText('Row 3: Missing name')).toBeTruthy()
  })

  it('confirms by calling onBulkCreate with only the valid rows', async () => {
    const onBulkCreate = vi.fn(async () => [{ email: 'a@x.com', status: 'created', error: null }])
    mocks.readWorkbookRows.mockResolvedValue([
      { name: 'A', email: 'a@x.com', role: 'centre_user', password: 'secret1' },
      { name: '', email: 'b@x.com', role: 'centre_user', password: 'secret1' },
    ])
    render(<UserImportDialog {...baseProps} onBulkCreate={onBulkCreate} />)
    fireEvent.change(screen.getByLabelText('Choose an .xlsx file to import'), {
      target: { files: [{ name: 'users.xlsx' }] },
    })
    await waitFor(() => expect(screen.getByText('Import 1 user')).toBeTruthy())

    fireEvent.click(screen.getByText('Import 1 user'))
    await waitFor(() => expect(onBulkCreate).toHaveBeenCalled())
    expect(onBulkCreate).toHaveBeenCalledWith([
      { name: 'A', email: 'a@x.com', role: 'centre_user', badge: '', centre: '', password: 'secret1', location: '' },
    ])
  })

  it('shows per-row results {email, status, error} after import', async () => {
    const onBulkCreate = vi.fn(async () => [
      { email: 'a@x.com', status: 'created', error: null },
      { email: 'b@x.com', status: 'error', error: 'Duplicate email' },
    ])
    mocks.readWorkbookRows.mockResolvedValue([
      { name: 'A', email: 'a@x.com', role: 'centre_user', password: 'secret1' },
      { name: 'B', email: 'b@x.com', role: 'centre_user', password: 'secret2' },
    ])
    render(<UserImportDialog {...baseProps} onBulkCreate={onBulkCreate} />)
    fireEvent.change(screen.getByLabelText('Choose an .xlsx file to import'), {
      target: { files: [{ name: 'users.xlsx' }] },
    })
    await waitFor(() => expect(screen.getByText('Import 2 users')).toBeTruthy())
    fireEvent.click(screen.getByText('Import 2 users'))

    await waitFor(() => expect(screen.getByText('1 created')).toBeTruthy())
    expect(screen.getByText('1 failed')).toBeTruthy()
    expect(screen.getByText('a@x.com')).toBeTruthy()
    expect(screen.getByText('Duplicate email')).toBeTruthy()
  })

  it('disables Confirm when every row is rejected', async () => {
    mocks.readWorkbookRows.mockResolvedValue([{ name: '', email: '', role: '', password: '' }])
    render(<UserImportDialog {...baseProps} />)
    fireEvent.change(screen.getByLabelText('Choose an .xlsx file to import'), {
      target: { files: [{ name: 'users.xlsx' }] },
    })
    await waitFor(() => expect(screen.getByText('0 valid')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Import/ }).disabled).toBe(true)
  })

  it('never renders or logs passwords', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mocks.readWorkbookRows.mockResolvedValue([
      { name: 'A', email: 'a@x.com', role: 'centre_user', password: 'supersecret', badge: 'FB1', centre: 'Bhati' },
    ])
    render(<UserImportDialog {...baseProps} />)
    fireEvent.change(screen.getByLabelText('Choose an .xlsx file to import'), {
      target: { files: [{ name: 'users.xlsx' }] },
    })
    await waitFor(() => expect(screen.getByText('1 valid')).toBeTruthy())

    expect(screen.queryByText('supersecret')).toBeNull()
    const logged = logSpy.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain('supersecret')
    logSpy.mockRestore()
  })
})
