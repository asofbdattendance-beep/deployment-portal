// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import LockReadinessPanel from './LockReadinessPanel'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const counts = { total: 10, consented: 8, deployed: 6, seats: 6, inchargesNeeded: 2, inchargesMissing: 0 }

describe('LockReadinessPanel', () => {
  it('says editing is open, including deployed sewadars, and shows the checklist', () => {
    render(<LockReadinessPanel locked={false} counts={counts} canLockHere onLock={() => {}} />)
    expect(screen.getByText('Editing is open until you lock')).toBeTruthy()
    expect(screen.getByText(/including sewadars already deployed/)).toBeTruthy()
    expect(screen.getByText('8/10')).toBeTruthy()
    expect(screen.getByText('6/6')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
  })

  it('calls onLock from the Lock button', () => {
    const onLock = vi.fn()
    render(<LockReadinessPanel locked={false} counts={counts} canLockHere onLock={onLock} />)
    fireEvent.click(screen.getByRole('button', { name: /lock deployment/i }))
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('shows the incharge blocker but keeps the button clickable (it opens the missing list)', () => {
    const onLock = vi.fn()
    render(<LockReadinessPanel locked={false} counts={{ ...counts, inchargesMissing: 1 }} canLockHere onLock={onLock} />)
    expect(screen.getByText('Add the missing incharge to lock')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /lock deployment/i }))
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('disables the button while locking', () => {
    render(<LockReadinessPanel locked={false} counts={counts} canLockHere lockBusy onLock={() => {}} />)
    expect(screen.getByRole('button', { name: /locking/i }).disabled).toBe(true)
  })

  it('hides the Lock button for an SC_SP account', () => {
    render(<LockReadinessPanel locked={false} counts={counts} canLockHere={false} onLock={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/CENTRE account locks/)).toBeTruthy()
  })

  it('renders the read-only notice with who locked once locked', () => {
    render(<LockReadinessPanel locked lockInfo={{ locked_by: 'Asha' }} counts={counts} canLockHere onLock={() => {}} />)
    expect(screen.getByText('Deployment locked')).toBeTruthy()
    expect(screen.getByText(/Locked by Asha\. .*read-only/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
