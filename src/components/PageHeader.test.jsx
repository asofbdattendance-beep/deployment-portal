// @vitest-environment jsdom
// PageHeader — title/sub/pills/actions/aside slots render in the incumbent
// .page-header skeleton; ViewOnlyPill keeps the exact pill contract.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PageHeader, { ViewOnlyPill } from './PageHeader'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ViewOnlyPill', () => {
  it('renders the View-only marker with a reason', () => {
    render(<ViewOnlyPill title="Attendance is read-only here" />)
    const pill = screen.getByText('View-only')
    expect(pill.title).toBe('Attendance is read-only here')
    expect(pill.className).toContain('pill-gray')
  })
})

describe('PageHeader', () => {
  it('renders title, sub, pills, actions and aside in order', () => {
    render(
      <PageHeader
        title="Attendance"
        sub="Who scanned in, on which day"
        pills={<ViewOnlyPill />}
        actions={<button type="button">Refresh</button>}
        aside={<span>Scan day picker</span>}
      />
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Attendance' }).className).toContain('page-title')
    expect(screen.getByText('Who scanned in, on which day').className).toContain('page-sub')
    expect(screen.getByText('View-only')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.getByText('Scan day picker')).toBeTruthy()
  })

  it('omits the sub and pills/actions rows when not provided', () => {
    const { container } = render(<PageHeader title="Schedule" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Schedule' })).toBeTruthy()
    expect(container.querySelector('.page-sub')).toBeNull()
  })
})
