import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DeadlinePill, { fmtRemaining } from './DeadlinePill'

// Server-side render test of the countdown math + box layout. The 1-second
// ticking (useDeadlineCountdown) is unchanged and covered by the component
// re-using it; here we pin the deterministic math and the rendered markup
// (four zero-padded boxes + green badge).
describe('fmtRemaining countdown math', () => {
  it('returns null without a deadline', () => {
    expect(fmtRemaining(null, Date.now())).toBeNull()
    expect(fmtRemaining(undefined, Date.now())).toBeNull()
  })

  it('flags a passed deadline', () => {
    const r = fmtRemaining('2026-08-01T00:00:00Z', new Date('2026-08-09T12:00:00Z').getTime())
    expect(r.passed).toBe(true)
    expect(r.text).toBe('Deadline passed')
  })

  it('breaks a 7-day gap into days/hours/mins/secs', () => {
    const r = fmtRemaining('2026-08-16T12:00:00Z', new Date('2026-08-09T12:00:00Z').getTime())
    expect(r.passed).toBe(false)
    expect(r.days).toBe(7)
    expect(r.hours).toBe(0)
    expect(r.mins).toBe(0)
    expect(r.secs).toBe(0)
  })

  it('splits a sub-day gap correctly', () => {
    const r = fmtRemaining('2026-08-09T19:26:48Z', new Date('2026-08-09T12:00:00Z').getTime())
    expect(r.days).toBe(0)
    expect(r.hours).toBe(7)
    expect(r.mins).toBe(26)
    expect(r.secs).toBe(48)
  })
})

describe('DeadlinePill box layout', () => {
  it('renders four boxes with zero-padded values + the green badge', () => {
    const deadline = new Date(Date.now() + 90 * 86400000 + 4 * 3600000 + 3 * 60000 + 2 * 1000).toISOString()
    const html = renderToStaticMarkup(createElement(DeadlinePill, { deadline }))

    const boxes = html.match(/class="deadline-box"/g) || []
    expect(boxes).toHaveLength(4)

    // every box value is zero-padded to 2 digits (04 not 4)
    const values = html.match(/class="deadline-box-value">(\d+)</g) || []
    expect(values).toHaveLength(4)
    values.forEach(v => {
      expect(v.match(/(\d+)/)[1]).toMatch(/^\d{2}$/)
    })

    expect(html).toContain('Days')
    expect(html).toContain('Hours')
    expect(html).toContain('Minutes')
    expect(html).toContain('Seconds')
    expect(html).toContain('deadline-badge')
    // heading line above the boxes
    expect(html).toContain('Deployment Submission Window Closes In')
    expect(html).toContain('deadline-boxes-label')
  })

  it('renders the compact variant with the same four boxes', () => {
    const deadline = new Date(Date.now() + 3600000).toISOString()
    const html = renderToStaticMarkup(createElement(DeadlinePill, { deadline, small: true }))
    expect(html).toContain('deadline-boxes-small')
    expect((html.match(/class="deadline-box"/g) || [])).toHaveLength(4)
    // compact chip stays uncluttered — no heading line
    expect(html).not.toContain('Deployment Submission Window Closes In')
    expect(html).not.toContain('deadline-boxes-label')
  })

  it('renders a red "Deadline passed" pill once the deadline is gone', () => {
    const html = renderToStaticMarkup(createElement(DeadlinePill, { deadline: '2020-01-01T00:00:00Z' }))
    expect(html).toContain('Deadline passed')
    expect(html).not.toContain('deadline-box')
  })

  it('renders the plain date when showCountdown is false', () => {
    const html = renderToStaticMarkup(createElement(DeadlinePill, { deadline: '2026-08-16T12:00:00Z', showCountdown: false }))
    expect(html).toContain('deadline-date')
    expect(html).not.toContain('deadline-box')
  })
})
