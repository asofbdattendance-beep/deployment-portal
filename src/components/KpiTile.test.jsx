// @vitest-environment jsdom
// KpiTile — .stat contract; button only when pressable; tone colours the value.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import KpiTile from './KpiTile'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('KpiTile', () => {
  it('renders the static div tile with label / value / sub', () => {
    const { container } = render(<KpiTile label="Present today" value={42} sub="of 100 deployed" />)
    const tile = container.querySelector('.stat')
    expect(tile?.tagName).toBe('DIV')
    expect(tile.querySelector('.stat-label').textContent).toBe('Present today')
    expect(tile.querySelector('.stat-value').textContent).toBe('42')
    expect(tile.querySelector('.stat-sub').textContent).toBe('of 100 deployed')
  })

  it('renders a real button with the tile skin when pressable', () => {
    const onPress = vi.fn()
    const { container } = render(<KpiTile label="Anomalies" value={3} onPress={onPress} title="Open anomalies" />)
    const btn = container.querySelector('button.stat')
    expect(btn).toBeTruthy()
    expect(btn.type).toBe('button')
    expect(btn.title).toBe('Open anomalies')
    fireEvent.click(btn)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('applies the tone colour to the value only', () => {
    const { container } = render(<KpiTile label="Absent" value={5} tone="#b91c1c" />)
    expect(container.querySelector('.stat-value').style.color).toBe('rgb(185, 28, 28)')
    expect(container.querySelector('.stat-label').style.color).toBe('')
  })

  it('omits the sub row when no sub is given', () => {
    const { container } = render(<KpiTile label="Scanners" value={2} />)
    expect(container.querySelector('.stat-sub')).toBeNull()
  })
})
