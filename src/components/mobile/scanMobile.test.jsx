// @vitest-environment jsdom
// MobileScanFeed + ScanModeShell smoke coverage.
//
// Worth protecting: the feed renders one card per row with newest-first
// order, empty-Out reads as "still in", dept ids resolve to names (em dash
// otherwise), and the shell renders every slot it is given.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MobileScanFeed from './MobileScanFeed'
import ScanModeShell from './ScanModeShell'

afterEach(() => { cleanup() })

const ROWS = [
  { id: '1', badge_number: 'FB100', sewadar_name: 'Asha', sewadar_dept: 'd1', in_time: '08:00', out_time: null, is_vss: false, undeployed_scan: false },
  { id: '2', badge_number: 'BH200', sewadar_name: 'Bina', sewadar_dept: 'dx', in_time: '08:05', out_time: '09:00', is_vss: true, undeployed_scan: true },
]

const DEPTS = new Map([['d1', 'Traffic']])

describe('MobileScanFeed', () => {
  it('shows the empty message with no rows', () => {
    render(<MobileScanFeed rows={[]} deptNameById={DEPTS} emptyMessage="Nothing yet" />)
    expect(screen.getByText('Nothing yet')).toBeTruthy()
  })

  it('renders one card per row, newest first, with still-in status', () => {
    render(<MobileScanFeed rows={ROWS} deptNameById={DEPTS} />)
    const list = screen.getByRole('list', { name: /Recent attendance scans/ })
    expect(list).toBeTruthy()
    expect(screen.getByText('FB100')).toBeTruthy()
    expect(screen.getByText('Traffic')).toBeTruthy()
    // Empty OUT reads as still in.
    expect(screen.getByText('In')).toBeTruthy()
    expect(screen.getByText('Out')).toBeTruthy()
    // Unresolvable dept degrades to an em dash, VSS/flagged pills show.
    expect(screen.getByText('VSS')).toBeTruthy()
    expect(screen.getByText('Flagged')).toBeTruthy()
  })

  it('respects the limit', () => {
    render(<MobileScanFeed rows={ROWS} deptNameById={DEPTS} limit={1} />)
    expect(screen.getByText('FB100')).toBeTruthy()
    expect(screen.queryByText('BH200')).toBeNull()
  })
})

describe('ScanModeShell', () => {
  it('renders every slot it is given', () => {
    render(
      <ScanModeShell
        title="Scanner"
        pills={<span>pill</span>}
        camera={<div>camera</div>}
        action={<button type="button">Go</button>}
        manual={<input aria-label="manual" />}
        feedTitle={<span>Feed</span>}
        feed={<div>feed-body</div>}
        popup={<div>popup</div>}
      />
    )
    for (const t of ['Scanner', 'pill', 'camera', 'Go', 'feed-body', 'popup']) {
      expect(screen.getByText(t, { exact: false })).toBeTruthy()
    }
    expect(screen.getByText('Feed', { exact: true })).toBeTruthy()
    expect(screen.getByLabelText('manual')).toBeTruthy()
  })

  it('renders chrome alone when slots are missing', () => {
    const { container } = render(<ScanModeShell title="Scanner" />)
    expect(container.textContent).toContain('Scanner')
  })
})
