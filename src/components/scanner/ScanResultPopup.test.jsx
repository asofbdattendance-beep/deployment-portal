// @vitest-environment jsdom
// ScanResultPopup — the v44 confirm gates.
//
// The popup is how the scanner asks "this toggle is too close to the last one,
// are you sure?". Three things must hold, and none of them is cosmetic:
//
//  1. The question is ACTUALLY ASKED. The title has to say which direction the
//     next entry is, or the operator is being asked to confirm an action they
//     cannot see.
//  2. The secondary button must read "Cancel", never "Done". "Done" on a
//     yes/no gate is the exact misread the gate exists to prevent — it reads
//     as "yes, go ahead" and the OUT is written.
//  3. Both answers must be reachable: primary -> onConfirm, secondary /
//     backdrop / ESC -> onClose. A gate the operator cannot decline is not a
//     gate, it is a delay.
//
// No @testing-library/jest-dom in this project, so every assertion below is a
// plain textContent / toBeNull check.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ScanResultPopup from './ScanResultPopup'

afterEach(cleanup)

// The global `keydown` listener and the rAF visibility transition are the only
// things that would leak between renders; rAF is not needed to assert content.
function open(status, props = {}) {
  return render(
    <ScanResultPopup open status={status} badge="FB5971GA0001" {...props} />
  )
}

describe('ScanResultPopup — confirm gates', () => {
  it('confirm_out asks the OUT question by name', () => {
    open('confirm_out', { onConfirm: vi.fn(), onClose: vi.fn() })
    expect(screen.getByText('Already IN — mark OUT?')).toBeTruthy()
    expect(screen.getByText('CONFIRM OUT')).toBeTruthy()
  })

  it('confirm_in asks the IN question by name', () => {
    open('confirm_in', { onConfirm: vi.fn(), onClose: vi.fn() })
    expect(screen.getByText('Already OUT — mark IN?')).toBeTruthy()
    expect(screen.getByText('CONFIRM IN')).toBeTruthy()
  })

  it('labels the secondary button Cancel, never Done', () => {
    open('confirm_out', { onConfirm: vi.fn(), onClose: vi.fn() })
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
  })

  it('shows the elapsed-time reason the gate fired', () => {
    open('confirm_out', {
      onConfirm: vi.fn(), onClose: vi.fn(),
      message: "Only 8 min since IN at 09:02 — mark OUT?",
    })
    expect(screen.getByText(/Only 8 min since IN at 09:02/)).toBeTruthy()
  })

  it('Confirm calls onConfirm and Cancel calls onClose', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    open('confirm_out', { onConfirm, onClose })
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('uses confirmLabel when the caller supplies one', () => {
    open('confirm_out', { onConfirm: vi.fn(), onClose: vi.fn(), confirmLabel: 'Yes, mark OUT' })
    expect(screen.getByText('Yes, mark OUT')).toBeTruthy()
    expect(screen.queryByText('Confirm')).toBeNull()
  })

  it('backdrop and ESC are Cancel — declining must always be reachable', () => {
    const onClose = vi.fn()
    const { container } = open('confirm_out', { onConfirm: vi.fn(), onClose })

    const overlay = container.firstChild
    fireEvent.click(overlay)                       // backdrop
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders no OUT-time input — that belongs to the forgot prompt only', () => {
    open('confirm_out', { onConfirm: vi.fn(), onClose: vi.fn() })
    expect(document.querySelector('#scan-forgot-time')).toBeNull()
  })

  it('regression: the forgot prompt keeps its own time input and labels', () => {
    open('forgot', { onConfirm: vi.fn(), onClose: vi.fn(), outTime: '17:30', onOutTimeChange: vi.fn() })
    expect(screen.getByText('Forgot OUT?')).toBeTruthy()
    expect(screen.getByText('Close OUT then IN')).toBeTruthy()
    expect(document.querySelector('#scan-forgot-time')).toBeTruthy()
  })

  it('regression: a plain IN popup still says Done, not Cancel', () => {
    open('in', { onConfirm: vi.fn(), onClose: vi.fn() })
    // L-12: one ack, one button. The old second "Done" called the same
    // onClose as the first — pure AT noise. What matters is that the single
    // button is not "Cancel", which would imply a choice this popup does not
    // offer.
    expect(screen.getAllByText('Done')).toHaveLength(1)
    expect(screen.queryByText('Cancel')).toBeNull()
  })
})

describe('ScanResultPopup — explicit choice (choose)', () => {
  // A scan never writes: the popup shows the details and the ONE valid
  // direction. The opposite direction is unrepresentable, so an invalid
  // write cannot be tapped into existence.
  it('choose IN shows details with a single Mark IN button', () => {
    open('choose', { action: 'IN', onConfirm: vi.fn(), onClose: vi.fn(), name: 'Test Sewadar', centre: 'CENTRE-A', deptName: 'LANGAR' })
    expect(screen.getByText('Mark IN?')).toBeTruthy()
    expect(screen.getByText('MARK IN')).toBeTruthy()
    expect(screen.getByText('Mark IN')).toBeTruthy()
    expect(screen.getByText('Test Sewadar')).toBeTruthy()
    expect(screen.getByText('CENTRE-A')).toBeTruthy()
    expect(screen.getByText('LANGAR')).toBeTruthy()
    // The invalid direction is not offered at all.
    expect(screen.queryByText('Mark OUT')).toBeNull()
    expect(screen.queryByText('MARK OUT')).toBeNull()
  })

  it('choose OUT shows details with a single Mark OUT button', () => {
    open('choose', { action: 'OUT', onConfirm: vi.fn(), onClose: vi.fn(), openSince: '2026-09-26 09:02:00' })
    expect(screen.getByText('Mark OUT?')).toBeTruthy()
    expect(screen.getByText('MARK OUT')).toBeTruthy()
    expect(screen.getByText('Mark OUT')).toBeTruthy()
    expect(screen.getByText(/Currently IN since/)).toBeTruthy()
    expect(screen.queryByText('Mark IN')).toBeNull()
  })

  it('labels the secondary button Cancel, never Done', () => {
    open('choose', { action: 'IN', onConfirm: vi.fn(), onClose: vi.fn() })
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
  })

  it('Mark IN calls onConfirm and Cancel calls onClose', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    open('choose', { action: 'IN', onConfirm, onClose })
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Mark IN'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('backdrop and ESC are Cancel — declining must always be reachable', () => {
    const onClose = vi.fn()
    const { container } = open('choose', { action: 'OUT', onConfirm: vi.fn(), onClose })

    const overlay = container.firstChild
    fireEvent.click(overlay)                       // backdrop
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('uses confirmLabel when the caller supplies one', () => {
    open('choose', { action: 'IN', onConfirm: vi.fn(), onClose: vi.fn(), confirmLabel: 'Yes, mark IN' })
    expect(screen.getByText('Yes, mark IN')).toBeTruthy()
    expect(screen.queryByText('Mark IN')).toBeNull()
  })
})

describe('ScanResultPopup — ack statuses render one button (L-12)', () => {
  // The pages pass onConfirm=closePopup as a fallback for every non-decision
  // status, so in/out/queued/flagged rendered TWO identical "Done" buttons
  // that both just close — AT noise inviting a mis-tap. One ack, one button.
  it.each(['in', 'out', 'queued', 'flagged'])('%s shows a single Done', (status) => {
    open(status, { onConfirm: vi.fn(), onClose: vi.fn() })
    expect(screen.getAllByText('Done')).toHaveLength(1)
    expect(screen.queryByText('Cancel')).toBeNull()
  })
})

describe('ScanResultPopup — date + time (in/out) event stamp', () => {
  // The operator's "when?" question. The row is an OWN block (not inside the
  // name/centre/dept <dl>) precisely so a badge the server cannot name still
  // shows when it was scanned — which is the blank-popup failure mode.
  it('shows Date and Time (IN) on an IN moment', () => {
    open('choose', { action: 'IN', eventDate: '2026-10-04', eventTime: '14:03:11' })
    expect(screen.getByText('Date')).toBeTruthy()
    expect(screen.getByText('2026-10-04')).toBeTruthy()
    expect(screen.getByText('Time (IN)')).toBeTruthy()
    expect(screen.getByText('14:03:11')).toBeTruthy()
  })

  it('labels the OUT moment Time (OUT)', () => {
    open('choose', { action: 'OUT', eventDate: '2026-10-04', eventTime: '18:22:09' })
    expect(screen.getByText('Time (OUT)')).toBeTruthy()
    expect(screen.getByText('18:22:09')).toBeTruthy()
    // The OUT choice still carries its history line alongside the new stamp.
    expect(screen.queryByText(/Currently IN since/)).toBeNull() // no openSince passed
  })

  it('labels the result popups by their own direction, not the choice', () => {
    open('in', { eventDate: '2026-10-04', eventTime: '09:00:00' })
    expect(screen.getByText('Time (IN)')).toBeTruthy()
    cleanup()
    open('out', { eventDate: '2026-10-04', eventTime: '17:45:02' })
    expect(screen.getByText('Time (OUT)')).toBeTruthy()
  })

  it('falls back to a bare "Time" when the popup has no direction', () => {
    open('queued', { eventDate: '2026-10-04', eventTime: '09:00:00' })
    expect(screen.getByText('Time')).toBeTruthy()
    expect(screen.queryByText(/Time \(/)).toBeNull()
  })

  it('omits the whole row when no event stamp is passed (error/busy paths)', () => {
    open('error', { message: 'Scanner busy' })
    expect(screen.queryByText('Date')).toBeNull()
    expect(screen.queryByText('Time')).toBeNull()
  })

  it('shows identity AND the event stamp together — the fresh-badge report', () => {
    open('choose', {
      action: 'IN',
      name: 'Sita Devi',
      centre: 'DELHI-9',
      deptName: 'Traffic',
      eventDate: '2026-10-04',
      eventTime: '14:03:11',
    })
    expect(screen.getByText('Sita Devi')).toBeTruthy()
    expect(screen.getByText('DELHI-9')).toBeTruthy()
    expect(screen.getByText('Traffic')).toBeTruthy()
    expect(screen.getByText('2026-10-04')).toBeTruthy()
    expect(screen.getByText('Time (IN)')).toBeTruthy()
  })
})
