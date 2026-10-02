// @vitest-environment jsdom
// useMediaQuery — the gate every mobile structural swap reads.
//
// The behaviour worth protecting:
// - false when matchMedia is missing (SSR / old webviews) — desktop is
//   the safe default, never mobile.
// - follows the query live (change events flip the value).
// - legacy addListener/removeListener path works (old Safari).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useMediaQuery, useIsMobile, MOBILE_QUERY } from './useMediaQuery'

function Probe({ query }) {
  const m = useMediaQuery(query)
  return <div data-testid="m">{m ? 'yes' : 'no'}</div>
}

function MobileProbe() {
  const m = useIsMobile()
  return <div data-testid="mm">{m ? 'yes' : 'no'}</div>
}

// Controllable matchMedia stub: one mql object per query string.
function installMatchMedia(initial = {}) {
  const store = new Map()
  const stub = vi.fn((query) => {
    if (!store.has(query)) {
      store.set(query, {
        matches: Boolean(initial[query]),
        media: query,
        listeners: new Set(),
        legacy: new Set(),
        addEventListener(_t, fn) { this.listeners.add(fn) },
        removeEventListener(_t, fn) { this.listeners.delete(fn) },
        addListener(fn) { this.legacy.add(fn) },
        removeListener(fn) { this.legacy.delete(fn) },
      })
    }
    return store.get(query)
  })
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: stub })
  return { stub, store }
}

function setMatches(store, query, value) {
  const mql = store.get(query)
  mql.matches = value
  act(() => {
    mql.listeners.forEach((fn) => fn({ matches: value }))
    mql.legacy.forEach((fn) => fn({ matches: value }))
  })
}

const realMatchMedia = typeof window !== 'undefined' ? window.matchMedia : undefined

beforeEach(() => {
  installMatchMedia({ '(max-width: 768px)': false, '(min-width: 900px)': false })
})

afterEach(() => {
  cleanup()
  if (realMatchMedia) Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia })
  else delete window.matchMedia
  vi.restoreAllMocks()
})

describe('useMediaQuery', () => {
  it('returns false for a non-matching query', () => {
    render(<Probe query="(min-width: 900px)" />)
    expect(screen.getByTestId('m').textContent).toBe('no')
  })

  it('reflects an already-matching query on mount', () => {
    installMatchMedia({ '(min-width: 900px)': true })
    render(<Probe query="(min-width: 900px)" />)
    expect(screen.getByTestId('m').textContent).toBe('yes')
  })

  it('follows change events live', () => {
    const { store } = installMatchMedia({ '(min-width: 900px)': false })
    render(<Probe query="(min-width: 900px)" />)
    expect(screen.getByTestId('m').textContent).toBe('no')
    setMatches(store, '(min-width: 900px)', true)
    expect(screen.getByTestId('m').textContent).toBe('yes')
    setMatches(store, '(min-width: 900px)', false)
    expect(screen.getByTestId('m').textContent).toBe('no')
  })

  it('unsubscribes on unmount (no setState after unmount)', () => {
    const { store } = installMatchMedia({ '(min-width: 900px)': false })
    const { unmount } = render(<Probe query="(min-width: 900px)" />)
    unmount()
    const mql = store.get('(min-width: 900px)')
    expect(mql.listeners.size).toBe(0)
    expect(mql.legacy.size).toBe(0)
  })

  it('supports the legacy addListener path', () => {
    const mql = {
      matches: false,
      legacy: new Set(),
      addListener(fn) { this.legacy.add(fn) },
      removeListener(fn) { this.legacy.delete(fn) },
    }
    window.matchMedia = vi.fn(() => mql)
    render(<Probe query="(min-width: 900px)" />)
    expect(screen.getByTestId('m').textContent).toBe('no')
    act(() => { mql.matches = true; mql.legacy.forEach((fn) => fn({ matches: true })) })
    expect(screen.getByTestId('m').textContent).toBe('yes')
  })

  it('returns false when matchMedia is missing (SSR-safe)', () => {
    delete window.matchMedia
    render(<Probe query="(min-width: 900px)" />)
    expect(screen.getByTestId('m').textContent).toBe('no')
  })
})

describe('useIsMobile', () => {
  it(`reads the ${MOBILE_QUERY} query`, () => {
    const { store } = installMatchMedia({ [MOBILE_QUERY]: false })
    render(<MobileProbe />)
    expect(screen.getByTestId('mm').textContent).toBe('no')
    setMatches(store, MOBILE_QUERY, true)
    expect(screen.getByTestId('mm').textContent).toBe('yes')
  })
})
