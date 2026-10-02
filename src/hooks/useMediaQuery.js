import { useState, useEffect } from 'react'

/**
 * useMediaQuery — SSR-safe matchMedia hook.
 *
 * The mobile-first attendance layer activates at ≤768px; every structural
 * swap (bottom tab bar, scan-mode shell, filter sheet) reads this hook so
 * the desktop DOM at ≥769px is byte-identical to today. Returns false when
 * matchMedia is unavailable (SSR, old webviews) — desktop is the safe
 * default, never mobile.
 */
export const MOBILE_QUERY = '(max-width: 768px)'

function snapshot(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => snapshot(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let mql
    try {
      mql = window.matchMedia(query)
    } catch {
      return undefined
    }
    const onChange = (e) => setMatches(Boolean(e && e.matches))
    // Modern browsers: addEventListener. Old Safari/webviews: addListener.
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
    else if (typeof mql.addListener === 'function') mql.addListener(onChange)
    setMatches(mql.matches)
    return () => {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange)
      else if (typeof mql.removeListener === 'function') mql.removeListener(onChange)
    }
  }, [query])

  return matches
}

/** Convenience: true when the viewport is phone-sized (≤768px). */
export function useIsMobile(query = MOBILE_QUERY) {
  return useMediaQuery(query)
}
