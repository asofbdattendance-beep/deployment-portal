// @vitest-environment jsdom
// AttendanceCards — the phone-first card renderers for the virtualised
// attendance lists.
//
// Worth protecting: each card mirrors its table row cell-for-cell (badge,
// centre, dept, days with the no-dept fallback, rate pill band, open /
// undeployed flags, in→out times) — a card that drops a field is data the
// operator can no longer see on a phone.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SewadarCard, ScannerCard } from './AttendanceCards'

afterEach(() => { cleanup() })

const sewadar = {
  badge_number: 'A123',
  sewadar_name: 'Ramesh Kumar',
  sewadar_centre: 'SECTOR-15-A',
  dept_name: 'TRAFFIC OUTSIDE BHATI',
  is_vss: false,
  days_present: 3,
  expected_days: 3,
  rate: 100,
  band: 'full',
  first_in_date: '2026-10-08',
  first_in_time: '06:12:00',
  last_out_date: '2026-10-08',
  last_out_time: '11:20:00',
  still_open: false,
  open_sessions: 0,
  undeployed_scan: false,
}

describe('SewadarCard', () => {
  it('shows identity, centre, department, days and rate', () => {
    render(<SewadarCard r={sewadar} />)
    expect(screen.getByText('Ramesh Kumar')).not.toBeNull()
    expect(screen.getByText('A123')).not.toBeNull()
    expect(screen.getByText('SECTOR-15-A')).not.toBeNull()
    expect(screen.getByText('TRAFFIC OUTSIDE BHATI')).not.toBeNull()
    expect(screen.getByText('3/3')).not.toBeNull()
    expect(screen.getByText('100%')).not.toBeNull()
  })

  it('marks a VSS badge', () => {
    render(<SewadarCard r={{ ...sewadar, is_vss: true }} />)
    expect(screen.getByText('VSS')).not.toBeNull()
  })

  it('never renders a 0/5 rate for a sewadar with no department', () => {
    // A6 law: no department = no expected-days denominator.
    const { container } = render(
      <SewadarCard r={{ ...sewadar, dept_name: null, expected_days: 0, days_present: 0 }} />,
    )
    expect(screen.queryByText('0/5')).toBeNull()
    expect(screen.queryByText('0/0')).toBeNull()
    expect(screen.queryByText(/0%/)).toBeNull()
    expect(screen.queryByText('(no dept)')).toBeNull()
    expect(container.querySelectorAll('span').length).toBeGreaterThan(0)
  })

  it('shows "still IN" instead of an out time for an open session', () => {
    render(<SewadarCard r={{ ...sewadar, last_out_date: null, still_open: true, open_sessions: 1 }} />)
    expect(screen.getByText(/still IN/)).not.toBeNull()
    expect(screen.getByText('Open')).not.toBeNull()
  })

  it('flags an undeployed scan', () => {
    render(<SewadarCard r={{ ...sewadar, undeployed_scan: true }} />)
    expect(screen.getByText('Undeployed')).not.toBeNull()
  })
})

describe('SewadarCard fallbacks', () => {
  it('renders a nameless scanner-less row without crashing', () => {
    const { container } = render(<SewadarCard r={{ badge_number: 'B9' }} />)
    expect(screen.getByText('B9')).not.toBeNull()
    expect(container.textContent).toContain('—')
  })

  it('shows "(no dept)" days when present but unscheduled', () => {
    render(<SewadarCard r={{ ...sewadar, dept_name: null, days_present: 2, expected_days: 0 }} />)
    expect(screen.getByText('2 (no dept)')).not.toBeNull()
  })

  it('marks a still-open session even when no out time was ever recorded', () => {
    // last_out_time missing but still_open false → '—', not 'still IN'
    const { container } = render(<SewadarCard r={{ ...sewadar, last_out_date: null, still_open: false, open_sessions: 0 }} />)
    expect(container.textContent).not.toContain('still IN')
  })

  it('shows both flags together', () => {
    const { container } = render(<SewadarCard r={{ ...sewadar, open_sessions: 2, undeployed_scan: true }} />)
    expect(screen.getByText('Open')).not.toBeNull()
    expect(screen.getByText('Undeployed')).not.toBeNull()
    expect(container.querySelectorAll('.pill').length).toBeGreaterThan(1)
  })
})

describe('ScannerCard', () => {
  it('shows scanner identity, centre and in/out/open/manual counts', () => {
    render(
      <ScannerCard
        r={{
          scanner_name: 'Asha Verma',
          scanner_badge: 'S-9',
          scanner_centre: 'DELHI MC',
          scans_in: 12, scans_out: 10, open_now: 2, manual_scans: 1,
          first_in_time: '06:00:00', last_scan_time: '11:45:00',
        }}
      />,
    )
    expect(screen.getByText('Asha Verma')).not.toBeNull()
    expect(screen.getByText('S-9')).not.toBeNull()
    expect(screen.getByText('DELHI MC')).not.toBeNull()
    expect(screen.getByText('12')).not.toBeNull()
    expect(screen.getByText('10')).not.toBeNull()
    expect(screen.getByText('2')).not.toBeNull()
    expect(screen.getByText('06:00 → 11:45')).not.toBeNull()
  })
})