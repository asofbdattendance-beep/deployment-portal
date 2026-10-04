// @vitest-environment jsdom
// OfflineSyncStatus — the global queue pill outside the scanner pages.
// Protects: (1) no pills when the queue is clean (the live-region wrapper
// always mounts so announcements work), (2) pending/failed counts follow
// store snapshots on EVERY page (the Dashboard-blindness fix), (3) failed
// and null-owner rows never raise the pending count or the spinner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import OfflineSyncStatus from './OfflineSyncStatus'

const subscribeOfflineSync = vi.fn(() => vi.fn())

vi.mock('../../lib/offlineSync', () => ({
  subscribeOfflineSync: (...args) => subscribeOfflineSync(...args),
}))
vi.mock('../../lib/offlineQueue', () => ({
  isFailedQueueRow: (r) => !!r && (r.status === 'failed' || r.failed === true),
  isOrphanedQueueRow: (r) =>
    !(!!r && (r.status === 'failed' || r.failed === true)) && (r?.owner ?? null) === null && !r?.synced,
}))

beforeEach(() => {
  subscribeOfflineSync.mockReset()
  subscribeOfflineSync.mockReturnValue(vi.fn())
})
afterEach(() => cleanup())

describe('OfflineSyncStatus', () => {
  it('shows no pills when the queue is clean (live region still mounted)', () => {
    subscribeOfflineSync.mockImplementation((cb) => {
      cb({ queued: [] })
      return vi.fn()
    })
    const { container } = render(<OfflineSyncStatus />)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.querySelector('.queue-pill')).toBeNull()
  })

  it('shows pending and failed counts from store snapshots', async () => {
    let sub = null
    subscribeOfflineSync.mockImplementation((cb) => {
      sub = cb
      return vi.fn()
    })
    render(<OfflineSyncStatus />)
    await act(async () => {
      sub({
        queued: [
          { id: 'a', synced: false, owner: 'me' },
          { id: 'b', synced: false, failed: true, owner: 'me' },
        ],
      })
    })
    expect(screen.getByText(/1 queued/)).not.toBeNull()
    expect(screen.getByText(/1 failed/)).not.toBeNull()
  })

  it('ignores failed and null-owner rows in the pending count and spinner', async () => {
    let sub = null
    subscribeOfflineSync.mockImplementation((cb) => {
      sub = cb
      return vi.fn()
    })
    const { container } = render(<OfflineSyncStatus />)
    await act(async () => {
      sub({
        queued: [
          // Null-owner rows can never drain (logged-out snapshot) — they
          // must not paint a permanent "syncing" pill.
          { id: 'orphan', synced: false, owner: null },
          { id: 'poison', synced: false, failed: true, owner: 'me' },
        ],
      })
    })
    expect(container.querySelector('.queue-pill.pill-amber')).toBeNull()
    expect(screen.getByText(/1 failed/)).not.toBeNull()
  })

  it('clears when the queue drains', async () => {
    let sub = null
    subscribeOfflineSync.mockImplementation((cb) => {
      sub = cb
      return vi.fn()
    })
    const { container } = render(<OfflineSyncStatus />)
    await act(async () => { sub({ queued: [{ id: 'a', synced: false, owner: 'me' }] }) })
    expect(container.querySelector('.queue-pill')).not.toBeNull()
    await act(async () => { sub({ queued: [] }) })
    expect(container.querySelector('.queue-pill')).toBeNull()
  })
})
