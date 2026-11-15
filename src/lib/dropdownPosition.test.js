import { describe, it, expect } from 'vitest'
import {
  computeMenuPosition, isRectOffscreen, filterItems,
  MENU_GUTTER, MENU_MAX_HEIGHT, MENU_MIN_HEIGHT, MENU_MIN_WIDTH,
} from './dropdownPosition'

const vp = { width: 1280, height: 800 }
const rect = (top, left = 100, width = 160, height = 30) => ({ top, bottom: top + height, left, right: left + width, width, height })

describe('computeMenuPosition', () => {
  it('opens below the trigger with full height when there is room', () => {
    const p = computeMenuPosition(rect(100), vp)
    expect(p.above).toBe(false)
    expect(p.top).toBe(134)
    expect(p.maxHeight).toBe(MENU_MAX_HEIGHT)
    expect(p.width).toBe(MENU_MIN_WIDTH)
  })

  it('flips above when the trigger is near the bottom of the screen', () => {
    const p = computeMenuPosition(rect(720), vp)
    expect(p.above).toBe(true)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(720)
    expect(p.top).toBeGreaterThanOrEqual(MENU_GUTTER)
  })

  it('shrinks height to fit the space below instead of overflowing the viewport', () => {
    const p = computeMenuPosition(rect(440), vp)
    expect(p.maxHeight).toBeLessThan(MENU_MAX_HEIGHT)
    expect(p.above).toBe(false)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(vp.height - MENU_GUTTER)
  })

  it('never goes below the minimum usable height', () => {
    const p = computeMenuPosition(rect(10, 100, 160, 30), { width: 400, height: 120 })
    expect(p.maxHeight).toBe(MENU_MIN_HEIGHT)
  })

  it('clamps horizontally inside the viewport on narrow screens', () => {
    const p = computeMenuPosition(rect(100, 300), { width: 360, height: 700 })
    expect(p.left).toBeGreaterThanOrEqual(MENU_GUTTER)
    expect(p.left + p.width).toBeLessThanOrEqual(360 - MENU_GUTTER)
  })
})

describe('isRectOffscreen', () => {
  it('detects a trigger scrolled out of view', () => {
    expect(isRectOffscreen(rect(-50), vp)).toBe(true)
    expect(isRectOffscreen(rect(900), vp)).toBe(true)
    expect(isRectOffscreen(rect(300), vp)).toBe(false)
  })
})

describe('filterItems', () => {
  const items = [{ name: 'LANGAR' }, { name: 'SECURITY' }, { name: 'Parking' }]
  it('returns all items for an empty query', () => {
    expect(filterItems(items, '  ')).toBe(items)
  })
  it('matches case-insensitively on substring', () => {
    expect(filterItems(items, 'ar').map(i => i.name)).toEqual(['LANGAR', 'Parking'])
  })
})
