// @vitest-environment jsdom
// QueueRecoveryBar — the single offline-queue state + recovery surface.
//
// Worth protecting: (1) nothing renders when the queue is clean, (2) pending
// EXCLUDES failed and orphaned rows so the sync pill cannot be inflated, (3)
// every recovery action calls the right offlineQueue function, and (4)
// deleting unsynced live rows is behind an explicit confirm.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import QueueRecoveryBar from './QueueRecoveryBar'

const mocks = vi.hoisted(() => ({
  clearFailedQueue: vi.fn(async () => {}),
  clearLiveQueue: vi.fn(async () => {}),
  clearOrphanedQueue: vi.fn(async () => {}),
  listStrandedQueue: vi.fn(async () => []),
  removeQueued: vi.fn(async () => {}),
}))

vi.mock('../../lib/offlineQueue', () => ({
  clearFailedQueue: mocks.clearFailedQueue,
  clearLiveQueue: mocks.clearLiveQueue,
  clearOrphanedQueue: mocks.clearOrphanedQueue,
  listStrandedQueue: mocks.listStrandedQueue,
  removeQueued: mocks.removeQueued,
  isFailedQueueRow: (r) => !!r && (r.status === 'failed' || r.failed === true),
  isOrphanedQueueRow: (r) => !(!!r && (r.status === 'failed' || r.failed === true)) && (r?.owner ?? null) === null && !r?.synced,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listStrandedQueue.mockResolvedValue([])
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const live = { id: 1, badge: 'FB1', action: 'IN', owner: 'me', synced: false }
const failed = { id: 2, badge: 'FB2', action: 'OUT', owner: 'me', synced: false, failed: true }
const orphaned = { id: 3, badge: 'FB3', action: 'IN', owner: null, synced: false }

describe('QueueRecoveryBar', () => {
  it('renders nothing when the queue is clean', () => {
    const { container } = render(<QueueRecoveryBar queued={[]} isOnline />)
    expect(container.firstChild).toBeNull()
  })

  it('counts pending separately from failed and orphaned rows', () => {
    render(<QueueRecoveryBar queued={[live, failed, orphaned]} isOnline />)
    expect(screen.getByText('1 queued')).not.toBeNull()
    expect(screen.getByText('1 failed')).not.toBeNull()
    expect(screen.getByText('1 orphaned')).not.toBeNull()
  })

  it('never counts a synced row as queued', () => {
    render(<QueueRecoveryBar queued={[{ ...live, synced: true }]} isOnline />)
    expect(screen.queryByText(/queued/)).toBeNull()
  })

  it('clears failed rows', async () => {
    render(<QueueRecoveryBar queued={[failed]} isOnline />)
    fireEvent.click(screen.getByRole('button', { name: /Clear failed/ }))
    await waitFor(() => expect(mocks.clearFailedQueue).toHaveBeenCalled())
  })

  it('clears orphaned rows', async () => {
    render(<QueueRecoveryBar queued={[orphaned]} isOnline />)
    fireEvent.click(screen.getByRole('button', { name: /Clear orphaned/ }))
    await waitFor(() => expect(mocks.clearOrphanedQueue).toHaveBeenCalled())
  })

  it('confirms before deleting unsynced live rows', async () => {
    render(<QueueRecoveryBar queued={[live]} isOnline />)
    fireEvent.click(screen.getByRole('button', { name: /Clear live queued/ }))
    await waitFor(() => expect(mocks.clearLiveQueue).toHaveBeenCalled())
    expect(window.confirm).toHaveBeenCalled()
  })

  it('does NOT delete live rows when the confirm is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<QueueRecoveryBar queued={[live]} isOnline />)
    fireEvent.click(screen.getByRole('button', { name: /Clear live queued/ }))
    expect(mocks.clearLiveQueue).not.toHaveBeenCalled()
  })

  it('surfaces stranded rows with a per-row clear', async () => {
    mocks.listStrandedQueue.mockResolvedValue([{ id: 9, badge: 'FB9', action: 'IN' }])
    render(<QueueRecoveryBar queued={[live]} isOnline />)
    await waitFor(() => expect(screen.getByText(/Stranded scans \(1\)/)).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(mocks.removeQueued).toHaveBeenCalledWith(9))
  })

  it('reports offline state and stale data', () => {
    render(<QueueRecoveryBar queued={[live]} isOnline={false} offline />)
    expect(screen.getByText('Offline')).not.toBeNull()
    expect(screen.getByText(/showing last data/)).not.toBeNull()
  })
})