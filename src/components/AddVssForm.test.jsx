// @vitest-environment jsdom
// AddVssForm delete regression: RLS silently matches zero rows once a
// registration is assigned (v37), so a stale "Pending" row's delete returned
// no error — the form toasted "Registration deleted" AND had already removed
// the photo from storage before the (no-op) DB delete.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import AddVssForm from './AddVssForm'

const h = vi.hoisted(() => ({ deleteResult: { data: [], error: null }, removeMock: null, ops: [] }))
h.removeMock = vi.fn(() => Promise.resolve({ error: null }))

vi.mock('../lib/supabase', () => {
  const qb = () => {
    const self = {}
    ;['delete', 'eq', 'select', 'update', 'insert'].forEach(k => { self[k] = vi.fn((...a) => { h.ops.push([k, ...a]); return self }) })
    self.then = (res, rej) => Promise.resolve(h.deleteResult).then(res, rej)
    return self
  }
  return {
    supabase: {
      from: () => qb(),
      storage: { from: () => ({ remove: (...a) => h.removeMock(...a), upload: vi.fn() }) },
      rpc: vi.fn(),
    },
    fetchCentres: () => Promise.resolve([{ name: 'C1', parent_centre: '' }]),
    fetchAllRows: () => Promise.resolve([
      { id: 'reg-1', temp_vss_id: 'TMP1', status: 'pending', sewadar_name: 'Pending Person', centre: 'C1', photo_url: 'reg/p1.jpg', created_at: '2026-10-01T00:00:00Z' },
    ]),
    vssPhotoUrl: () => Promise.resolve(null),
  }
})

const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('./Toast', () => ({ useToast: () => toast }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { name: 'Centre User', role: 'centre_user', centre: 'C1' } }),
}))

beforeEach(() => {
  h.ops.length = 0
  h.removeMock.mockClear()
  Object.values(toast).forEach(f => f.mockReset())
})
afterEach(() => cleanup())

async function deleteThePendingRow() {
  render(<AddVssForm creationOpen windowOpen creationOverride={null} />)
  await screen.findByText('Pending Person')
  fireEvent.click(screen.getByTitle('Delete registration'))
  fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
}

describe('AddVssForm delete', () => {
  it('a zero-row (RLS-locked) delete is an error and keeps the photo', async () => {
    h.deleteResult = { data: [], error: null }
    await deleteThePendingRow()
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(h.removeMock).not.toHaveBeenCalled()
  })

  it('a real delete removes the row and then its photo', async () => {
    h.deleteResult = { data: [{ id: 'reg-1' }], error: null }
    await deleteThePendingRow()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Registration deleted'))
    expect(h.removeMock).toHaveBeenCalledWith(['reg/p1.jpg'])
  })
})
