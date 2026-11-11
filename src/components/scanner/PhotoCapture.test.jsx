// @vitest-environment jsdom
/**
 * PhotoCapture — the camera hand-off and the operator feedback around one
 * photo. Decoding itself is covered by photoDecode.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  decode: vi.fn(),
  bitmap: vi.fn(),
  beep: vi.fn(),
  vibrate: vi.fn(),
}))

vi.mock('./photoDecode', () => ({
  decodeBadgePhoto: (...a) => mocks.decode(...a),
  loadPhotoBitmap: (...a) => mocks.bitmap(...a),
  readBitmapFrame: vi.fn(),
  createNativePhotoDetector: () => Promise.resolve(null),
}))
vi.mock('./zxingCppEngine', () => ({ loadZxingCpp: () => Promise.resolve(vi.fn()) }))
vi.mock('../../lib/mobile', () => ({
  playScanBeep: (...a) => mocks.beep(...a),
  vibrate: (...a) => mocks.vibrate(...a),
}))

import PhotoCapture from './PhotoCapture'

const BADGE = 'FB5978GA0013'

function setup(props = {}) {
  const handlers = {
    onResult: vi.fn(() => 'accepted'),
    onBeforeOpen: vi.fn(),
    onAfterClose: vi.fn(),
    ...props,
  }
  render(<PhotoCapture {...handlers} />)
  const input = screen.getByTestId('photo-input')
  const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
  return { handlers, input, clickSpy }
}

async function choosePhoto(input) {
  const file = new File(['x'], 'badge.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    fireEvent.change(input)
    await new Promise(r => setTimeout(r, 0))
  })
}

beforeEach(() => {
  mocks.bitmap.mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() })
  mocks.decode.mockReset()
  mocks.beep.mockReset()
  mocks.vibrate.mockReset()
})
afterEach(() => cleanup())

describe('PhotoCapture', () => {
  it('releases the live camera before opening the camera app', () => {
    const { handlers, clickSpy } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    expect(handlers.onBeforeOpen).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(handlers.onBeforeOpen.mock.invocationCallOrder[0]).toBeLessThan(clickSpy.mock.invocationCallOrder[0])
  })

  it('opens the rear camera for an image', () => {
    const { input } = setup()
    expect(input.getAttribute('accept')).toBe('image/*')
    expect(input.getAttribute('capture')).toBe('environment')
  })

  it('hands a read badge to onResult and gives the camera back', async () => {
    mocks.decode.mockResolvedValue({ status: 'ok', badge: BADGE, badges: [BADGE], engine: 'ZXingCpp' })
    const { handlers, input } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    await choosePhoto(input)
    expect(handlers.onResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', badge: BADGE, ms: expect.any(Number) }))
    expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
    expect(mocks.beep).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Camera not reading? Use a photo.')
  })

  it('explains a photo with no badge and buzzes', async () => {
    mocks.decode.mockResolvedValue({ status: 'none', badge: null, badges: [] })
    const { handlers, input } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    await choosePhoto(input)
    expect(screen.getByRole('status').textContent).toMatch(/No badge found/)
    expect(mocks.beep).toHaveBeenCalledWith('error')
    expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
  })

  it('says so when the page declines the scan', async () => {
    mocks.decode.mockResolvedValue({ status: 'ok', badge: BADGE, badges: [BADGE] })
    const { input } = setup({ onResult: vi.fn(() => 'declined') })
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    await choosePhoto(input)
    expect(screen.getByRole('status').textContent).toMatch(/Finish the open scan result/)
  })

  it('reports an image the browser cannot open', async () => {
    mocks.bitmap.mockRejectedValue(new Error('bad image'))
    const { input } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    await choosePhoto(input)
    expect(mocks.decode).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toMatch(/Could not open that photo/)
  })

  it('gives the camera back when the operator cancels', () => {
    const { handlers, input } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    fireEvent(input, new Event('cancel'))
    expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
    expect(handlers.onResult).not.toHaveBeenCalled()
  })

  it('falls back to window focus when the browser fires no cancel event', () => {
    vi.useFakeTimers()
    try {
      const { handlers } = setup()
      fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
      window.dispatchEvent(new Event('focus'))
      act(() => { vi.advanceTimersByTime(1600) })
      expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the camera back only once even if cancel and focus both fire', () => {
    vi.useFakeTimers()
    try {
      const { handlers, input } = setup()
      fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
      window.dispatchEvent(new Event('focus'))
      fireEvent(input, new Event('cancel'))
      act(() => { vi.advanceTimersByTime(1600) })
      expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the camera back when no picker ever opens (no blur, no events)', () => {
    vi.useFakeTimers()
    try {
      const { handlers } = setup()
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
      act(() => { vi.advanceTimersByTime(3000) })
      expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting while the picker is open (window lost focus)', () => {
    vi.useFakeTimers()
    try {
      const { handlers } = setup()
      fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
      window.dispatchEvent(new Event('blur'))
      act(() => { vi.advanceTimersByTime(10000) })
      expect(handlers.onAfterClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart the camera on focus while a chosen file is still arriving', () => {
    vi.useFakeTimers()
    try {
      const { handlers, input } = setup()
      fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
      window.dispatchEvent(new Event('blur'))
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'b.jpg')], configurable: true })
      window.dispatchEvent(new Event('focus'))
      act(() => { vi.advanceTimersByTime(2000) })
      expect(handlers.onAfterClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second tap after a flow that never resolved still opens the camera', () => {
    const { handlers, clickSpy } = setup()
    const button = screen.getByRole('button', { name: 'Take a photo of the badge' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(clickSpy).toHaveBeenCalledTimes(2)
    expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
  })

  it('gives the camera back if it unmounts mid-flow', () => {
    const { handlers } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo of the badge' }))
    cleanup()
    expect(handlers.onAfterClose).toHaveBeenCalledTimes(1)
  })

  it('highlights the button when the scanner suggests a photo', () => {
    render(<PhotoCapture onResult={vi.fn()} highlight />)
    expect(screen.getByText('Not reading? Take a photo instead.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Take a photo of the badge' }).dataset.highlight).toBe('true')
  })
})
