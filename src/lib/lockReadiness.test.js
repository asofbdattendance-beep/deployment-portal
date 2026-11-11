import { describe, it, expect } from 'vitest'
import { lockReadiness, lockedByLine } from './lockReadiness'

const base = { total: 40, consented: 30, deployed: 20, seats: 25, inchargesNeeded: 3, inchargesMissing: 1 }

describe('lockReadiness', () => {
  it('reports consent, seats and incharges as three checklist items', () => {
    const { items } = lockReadiness(base)
    expect(items.map(i => i.id)).toEqual(['consent', 'seats', 'incharges'])
    expect(items[0]).toMatchObject({ value: '30/40', tone: 'info' })
    expect(items[1]).toMatchObject({ value: '20/25', hint: '5 seats still open', tone: 'todo' })
    expect(items[2]).toMatchObject({ value: '2/3', hint: '1 department without an incharge', tone: 'todo' })
  })

  it('blocks locking while any incharge is missing', () => {
    expect(lockReadiness(base)).toMatchObject({ canLock: false, blocker: 'Add the missing incharge to lock' })
    expect(lockReadiness({ ...base, inchargesMissing: 2 }).blocker).toBe('Add 2 missing incharges to lock')
  })

  it('allows locking and marks items done when seats and incharges are complete', () => {
    const r = lockReadiness({ ...base, deployed: 25, inchargesMissing: 0 })
    expect(r.canLock).toBe(true)
    expect(r.blocker).toBeNull()
    expect(r.items[1]).toMatchObject({ tone: 'done', hint: 'All allocated seats filled' })
    expect(r.items[2]).toMatchObject({ tone: 'done', hint: 'Every department has one' })
  })

  it('handles an empty centre without negative or NaN values', () => {
    const r = lockReadiness({})
    expect(r.items.map(i => i.value)).toEqual(['0/0', '0', '0/0'])
    expect(r.items[1].hint).toBe('No seats allocated yet')
    expect(r.items[2].hint).toBe('Assign sewadars first')
    expect(r.canLock).toBe(true)
  })

  it('clamps missing incharges to the number needed', () => {
    expect(lockReadiness({ ...base, inchargesNeeded: 1, inchargesMissing: 5 }).items[2].value).toBe('0/1')
  })
})

describe('lockedByLine', () => {
  it('returns empty for no lock', () => {
    expect(lockedByLine(null)).toBe('')
  })
  it('names who locked, and when if known', () => {
    expect(lockedByLine({ locked_by: 'Asha' })).toBe('Locked by Asha')
    expect(lockedByLine({ locked_by: 'Asha', locked_at: '2026-11-10T10:42:00Z' })).toMatch(/^Locked by Asha · \d{1,2} Nov/)
    expect(lockedByLine({ locked_at: '2026-11-10T10:42:00Z' })).toMatch(/^Locked \d{1,2} Nov/)
  })
  it('ignores an unparseable timestamp', () => {
    expect(lockedByLine({ locked_by: 'Asha', locked_at: 'nope' })).toBe('Locked by Asha')
  })
})
