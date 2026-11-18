// @vitest-environment jsdom
// SwUpdatePrompt — prompt-driven service-worker updates.
//
// Worth protecting: silent until `portal-sw-update` fires, then offers
// Reload; Reload posts SKIP_WAITING to the waiting worker (never swaps
// code without the user's tap).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import SwUpdatePrompt from './SwUpdatePrompt'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SwUpdatePrompt', () => {
  it('renders nothing before any update event', () => {
    const { container } = render(<SwUpdatePrompt />)
    expect(container.firstChild).toBeNull()
  })

  it('shows Reload on update and posts SKIP_WAITING on tap', () => {
    const postMessage = vi.fn()
    const getRegistration = vi.fn().mockResolvedValue({ waiting: { postMessage } })
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      writable: true,
      value: { getRegistration },
    })
    render(<SwUpdatePrompt />)
    act(() => {
      window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: {} } }))
    })
    expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    return Promise.resolve().then(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
      delete window.navigator.serviceWorker
    })
  })
})

describe('SwUpdatePrompt reload timing', () => {
  it('reloads on controllerchange, not on a fixed beat before the new worker controls the page', async () => {
    vi.useFakeTimers()
    try {
      const listeners = {}
      const postMessage = vi.fn()
      const getRegistration = vi.fn().mockResolvedValue({ waiting: { postMessage } })
      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        writable: true,
        value: { getRegistration, addEventListener: (t, fn) => { listeners[t] = fn } },
      })
      const reloadPage = vi.fn()
      render(<SwUpdatePrompt reloadPage={reloadPage} />)
      act(() => {
        window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: {} } }))
      })
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
      // the new worker is slow to activate: still no reload after the old 400ms beat
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(reloadPage).not.toHaveBeenCalled()
      // the new worker takes control → exactly one reload
      act(() => { listeners.controllerchange() })
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(reloadPage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      delete window.navigator.serviceWorker
    }
  })
})

describe('SwUpdatePrompt auto-apply', () => {
  const mockSw = (postMessage) => Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: { getRegistration: vi.fn().mockResolvedValue({ waiting: { postMessage } }), addEventListener: () => {} },
  })

  it('applies the update by itself after the idle window', async () => {
    vi.useFakeTimers()
    try {
      const postMessage = vi.fn()
      mockSw(postMessage)
      render(<SwUpdatePrompt reloadPage={vi.fn()} idleMs={1000} />)
      act(() => { window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: {} } })) })
      await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); await Promise.resolve() })
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    } finally {
      vi.useRealTimers()
      delete window.navigator.serviceWorker
    }
  })

  it('applies the update when the tab is hidden', async () => {
    const postMessage = vi.fn()
    mockSw(postMessage)
    render(<SwUpdatePrompt reloadPage={vi.fn()} idleMs={60_000} />)
    act(() => { window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: {} } })) })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); await Promise.resolve() })
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    delete document.hidden
    delete window.navigator.serviceWorker
  })
})

describe('SwUpdatePrompt never loses unsaved work', () => {
  it('does not auto-apply or manually reload while work is unsaved', async () => {
    const { registerUnsavedWork } = await import('../../lib/unsavedWork')
    vi.useFakeTimers()
    const off = registerUnsavedWork(() => true)
    try {
      const postMessage = vi.fn()
      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true, writable: true,
        value: { getRegistration: vi.fn().mockResolvedValue({ waiting: { postMessage } }), addEventListener: () => {} },
      })
      const reloadPage = vi.fn()
      render(<SwUpdatePrompt reloadPage={reloadPage} idleMs={1000} />)
      act(() => { window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: {} } })) })
      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve() })
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(postMessage).not.toHaveBeenCalled()
      expect(reloadPage).not.toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toContain('Save or finish your changes first')
    } finally {
      off()
      vi.useRealTimers()
      delete window.navigator.serviceWorker
    }
  })
})
