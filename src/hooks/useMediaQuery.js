import { useState, useEffect } from 'react'
import { MOBILE_QUERY, DEVICE_TIERS, tierForWidth } from '../lib/mobile'

/**
 * useMediaQuery — SSR-safe matchMedia hook.
 *
 * Device-tier contract (see index.css "Device-tier contract" and
 * lib/mobile.js DEVICE_TIERS): T0–T4 get the mobile shell + card tables.
 * Mobile chrome activates at ≤768px OR on a short landscape viewport with
 * a coarse pointer (a phone held sideways is ≥769px wide, so width alone
 * misses it). Returns false when matchMedia is unavailable (SSR, old
 * webviews) — desktop is the safe default, never mobile.
 */
export { MOBILE_QUERY, DEVICE_TIERS, tierForWidth }

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

/** Convenience: true when the viewport is phone-sized (T0–T4) or a landscape phone. */
export function useIsMobile(query = MOBILE_QUERY) {
  return useMediaQuery(query)
}

/**
 * Current device tier name ('tiny' … 'desktop').
 * Tracks innerWidth; falls back to 'desktop' (SSR-safe).
 */
export function useDeviceTier() {
  const [tier, setTier] = useState(() =>
    typeof window === 'undefined' ? 'desktop' : tierForWidth(window.innerWidth),
  )
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setTier(tierForWidth(window.innerWidth))
    onResize()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return tier
}
