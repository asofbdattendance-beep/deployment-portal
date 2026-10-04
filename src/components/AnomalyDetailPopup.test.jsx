// @vitest-environment jsdom
// AnomalyDetailPopup — the click-through "info trail" for anomaly rows.
//
// Pinned: (1) IN/OUT with IN-BY/OUT-BY render on ONE compact line per
// session; (2) deployment requested→final and consent render as related
// info; (3) loading/error/empty states never masquerade as content;
// (4) close paths (button, overlay, Escape) all call onClose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AnomalyDetailPopup from './AnomalyDetailPopup'

const trail = vi.hoisted(() => ({ detail: null, loading: false, error: null }))

vi.mock('../hooks/useAnomalyDetail', () => ({
  useAnomalyDetail: () => ({ ...trail }),
}))
vi.mock('../hooks/useDeptNames', () => ({
  useDeptNames: () => [[{ id: 'dept-1', name: 'LANGAR' }, { id: 'dept-2', name: 'SEWA' }], vi.fn()],
  refreshDeptNames: vi.fn(),
}))

const ROW = {
  rule: 'STALE_OPEN', badge_number: 'FB5971GA0001', sewadar_name: 'Ram Sewak',
  sewadar_centre: 'CENTRE A', dept_name: 'LANGAR', detail: 'IN on 2026-09-28, no OUT', event_date: '2026-09-28',
}
const META = {
  STALE_OPEN: { label: 'Open session', pillClass: 'pill-amber', text: 'IN before today, no OUT' },
  MULTI_SESSION: { label: 'Many scans', pillClass: 'pill-amber', text: '3+ INs in a day' },
}
const DETAIL = {
  badge_number: 'FB5971GA0001',
  sessions: [{
    id: 's1', in_date: '2026-09-28', in_time: '09:12:00',
    in_scanner_badge: 'SC01', in_scanner_name: 'Scanner One',
    out_date: '2026-09-28', out_time: '18:30:00',
    out_scanner_badge: 'SC02', out_scanner_name: 'Scanner Two',
    status: 'CLOSED', centre: 'Bhati - Delhi MC', is_manual: true, undeployed_scan: false,
  }],
  deployment: { department_id: 'dept-1', deployed_department_id: 'dept-2' },
  consent: { consent_given: true, available_days_count: 5, stay_at_bhati: true, chair_pass: false },
}

beforeEach(() => {
  cleanup()
  trail.detail = DETAIL
  trail.loading = false
  trail.error = null
})

const open = (props = {}) => render(
  <AnomalyDetailPopup
    row={ROW}
    scheduleId="sched-1"
    related={[{ rule: 'MULTI_SESSION', detail: '4 INs', event_date: '2026-09-28' }]}
    ruleMeta={META}
    onClose={() => {}}
    {...props}
  />,
)

describe('AnomalyDetailPopup', () => {
  it('renders the trail with IN/OUT and by-whom plus related info', async () => {
    open()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('FB5971GA0001')).toBeTruthy()
    expect(screen.getByText(/Scanner One/)).toBeTruthy()
    expect(screen.getByText(/Scanner Two/)).toBeTruthy()
    expect(screen.getByText('LANGAR')).toBeTruthy()
    expect(screen.getByText('SEWA')).toBeTruthy()
    expect(screen.getByText(/5 day\(s\)/)).toBeTruthy()
    expect(screen.getByText(/4 INs/)).toBeTruthy()
  })

  it('shows loading and error states explicitly', async () => {
    trail.detail = null
    trail.loading = true
    const { unmount } = open()
    expect(await screen.findByRole('status')).toBeTruthy()
    unmount()
    trail.loading = false
    trail.error = { message: 'denied' }
    open()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('says so when there are no sessions and no consent', async () => {
    trail.detail = { ...DETAIL, sessions: [], deployment: null, consent: null }
    open({ related: [] })
    expect(await screen.findByText(/No sessions recorded/)).toBeTruthy()
    expect(screen.getByText(/Not deployed/)).toBeTruthy()
    expect(screen.getByText(/No consent recorded/)).toBeTruthy()
    expect(screen.getByText(/only one for the badge/)).toBeTruthy()
  })

  it('closes via button, overlay and Escape', async () => {
    const onClose = vi.fn()
    const { unmount } = open({ onClose })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByLabelText('Close anomaly details'))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    open({ onClose })
    await screen.findByRole('dialog')
    fireEvent.click(document.querySelector('.modal-overlay'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('AnomalyDetailPopup presentation fixes', () => {
  it('trims millisecond timestamps to HH:MM', async () => {
    trail.detail = {
      ...DETAIL,
      sessions: [{
        ...DETAIL.sessions[0],
        in_time: '09:17:59.931',
        out_time: '09:18:10.655',
      }],
    }
    open({ related: [] })
    await screen.findByRole('dialog')
    expect(screen.getByText('09:17')).toBeTruthy()
    expect(screen.getByText('09:18')).toBeTruthy()
    expect(screen.queryByText(/\.931/)).toBeNull()
  })

  it('omits the day count when consent has no recorded days', async () => {
    trail.detail = {
      ...DETAIL,
      consent: { consent_given: false, available_days_count: null, stay_at_bhati: false, chair_pass: false },
    }
    open({ related: [] })
    await screen.findByRole('dialog')
    expect(screen.getByText('No')).toBeTruthy()
    expect(screen.queryByText(/day\(s\)/)).toBeNull()
  })

  it('skips related rows that carry no rule, label or detail', async () => {
    open({ related: [{ event_date: '2026-09-28' }, { rule: 'MULTI_SESSION', detail: '4 INs', event_date: '2026-09-28' }] })
    await screen.findByRole('dialog')
    expect(screen.getByText(/Related anomalies \(2\)/)).toBeTruthy()
    expect(screen.getByText(/4 INs/)).toBeTruthy()
    expect(screen.queryByText('(2026-09-28)')).toBeNull()
  })
})
