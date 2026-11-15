// @vitest-environment jsdom
// DeptDropdown regression: centre users could not scroll the department
// list — any scroll (including the menu's own) closed the menu.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import DeptDropdown from './DeptDropdown'

const row = { centre: 'DELHI', badge_number: 'B1', sewadar_name: 'ROHIT', requested_dept: 'd2' }
const mkDepts = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, name: `DEPT ${String.fromCharCode(65 + i)}` }))

function mkItems(depts, { blocked = [] } = {}) {
  return depts.map(d => ({
    deptId: d.id,
    name: d.name,
    q: { effective: 1, max: 5, rem: 4 },
    reasons: blocked.includes(d.id) ? ['Allocated quota reached (5/5)'] : [],
    isCurrent: row.requested_dept === d.id,
    full: false,
  }))
}

function Harness({ depts, items, onSelect = () => {}, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen)
  const [reasons, setReasons] = useState(null)
  return (
    <DeptDropdown
      row={row}
      depts={depts}
      items={items}
      open={open}
      disabled={false}
      onToggle={close => setOpen(close === false ? false : !open)}
      onSelect={id => { onSelect(id); setOpen(false) }}
      openReasons={reasons}
      setOpenReasons={setReasons}
    />
  )
}

function setMatchMedia(matches) {
  window.matchMedia = vi.fn(q => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {} }))
}

beforeEach(() => {
  setMatchMedia(false)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 130, left: 100, right: 260, width: 160, height: 30, x: 100, y: 100, toJSON: () => ({}) })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 1 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const trigger = () => screen.getByRole('button', { name: /DEPT B|Select department/ })

describe('DeptDropdown', () => {
  it('opens a listbox portalled to body', () => {
    const depts = mkDepts(3)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    const list = screen.getByRole('listbox')
    expect(list.closest('.dd-root')).toBeNull()
    expect(screen.getAllByRole('option').length).toBe(4) // 3 + clear
  })

  it('stays open when the list itself is scrolled (the reported bug)', () => {
    const depts = mkDepts(12)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    const list = screen.getByRole('listbox')
    fireEvent.scroll(list)
    expect(screen.queryByRole('listbox')).not.toBeNull()
  })

  it('stays open and repositions when the page/table scrolls', () => {
    const depts = mkDepts(3)
    render(<div style={{ overflow: 'auto' }}><Harness depts={depts} items={mkItems(depts)} /></div>)
    fireEvent.click(trigger())
    HTMLElement.prototype.getBoundingClientRect.mockReturnValue({ top: 200, bottom: 230, left: 100, right: 260, width: 160, height: 30, x: 100, y: 200, toJSON: () => ({}) })
    act(() => { window.dispatchEvent(new Event('scroll')) })
    const menu = document.querySelector('.dd-menu')
    expect(menu).not.toBeNull()
    expect(menu.style.top).toBe('234px')
  })

  it('closes when the trigger scrolls out of view', () => {
    const depts = mkDepts(3)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    HTMLElement.prototype.getBoundingClientRect.mockReturnValue({ top: -100, bottom: -70, left: 100, right: 260, width: 160, height: 30, x: 100, y: -100, toJSON: () => ({}) })
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows a search box for long lists and filters options', () => {
    const depts = mkDepts(10)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    const search = screen.getByLabelText('Search departments')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'dept c' } })
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringContaining('DEPT C'), expect.stringContaining('Clear')])
  })

  it('Enter in the search selects the first eligible match', () => {
    const depts = mkDepts(10)
    const onSelect = vi.fn()
    render(<Harness depts={depts} items={mkItems(depts, { blocked: ['d4'] })} onSelect={onSelect} />)
    fireEvent.click(trigger())
    const search = screen.getByLabelText('Search departments')
    fireEvent.change(search, { target: { value: 'dept' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('d1')
  })

  it('hides the search box for short lists', () => {
    const depts = mkDepts(4)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    expect(screen.queryByLabelText('Search departments')).toBeNull()
  })

  it('selects an eligible option', () => {
    const depts = mkDepts(3)
    const onSelect = vi.fn()
    render(<Harness depts={depts} items={mkItems(depts)} onSelect={onSelect} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: /DEPT C/ }))
    expect(onSelect).toHaveBeenCalledWith('d3')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows reasons instead of selecting a blocked option', () => {
    const depts = mkDepts(3)
    const onSelect = vi.fn()
    render(<Harness depts={depts} items={mkItems(depts, { blocked: ['d3'] })} onSelect={onSelect} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: /DEPT C/ }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText(/Allocated quota reached/)).toBeTruthy()
  })

  it('clears the department', () => {
    const depts = mkDepts(3)
    const onSelect = vi.fn()
    render(<Harness depts={depts} items={mkItems(depts)} onSelect={onSelect} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: /Clear department/ }))
    expect(onSelect).toHaveBeenCalledWith('')
  })

  it('supports keyboard: ArrowDown opens, arrows move, Escape closes and restores focus', () => {
    const depts = mkDepts(3)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    const btn = trigger()
    btn.focus()
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    const current = screen.getByRole('option', { name: /DEPT B/ })
    expect(document.activeElement).toBe(current)
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    expect(document.activeElement.textContent).toContain('DEPT C')
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('renders as a bottom sheet with a backdrop on phones', () => {
    setMatchMedia(true)
    const depts = mkDepts(10)
    render(<Harness depts={depts} items={mkItems(depts)} />)
    fireEvent.click(trigger())
    expect(document.querySelector('.dd-sheet')).not.toBeNull()
    expect(screen.getByText('Choose department')).toBeTruthy()
    // no auto-focus into the search on phones (would pop the keyboard)
    expect(document.activeElement).not.toBe(screen.getByLabelText('Search departments'))
    fireEvent.click(document.querySelector('.dd-backdrop'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows a helpful empty state', () => {
    render(<Harness depts={[]} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Select department/ }))
    expect(screen.getByText(/No departments with an allocated quota/)).toBeTruthy()
  })
})
