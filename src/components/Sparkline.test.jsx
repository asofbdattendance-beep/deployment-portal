// @vitest-environment jsdom
// Sparkline — single-colour inline SVG; null on empty; flat line on one point.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import Sparkline from './Sparkline'

afterEach(() => { cleanup() })

describe('Sparkline', () => {
  it('renders an aria-hidden svg polyline for a series', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const d = svg.querySelector('path').getAttribute('d')
    expect(d.startsWith('M ')).toBe(true)
    expect(d).toContain(' L ')
  })

  it('renders nothing when there are no finite values', () => {
    const { container } = render(<Sparkline values={[]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders a flat line for a single point', () => {
    const { container } = render(<Sparkline values={[7]} width={72} />)
    const d = container.querySelector('path').getAttribute('d')
    expect(d).toBe(`M 0,14.0 L 72,14.0`)
  })
})
