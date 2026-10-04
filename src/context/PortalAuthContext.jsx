import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { notifySessionAvailable } from '../lib/offlineSync'

const PortalAuthContext = createContext(null)

// A PASSWORD_RECOVERY session means the user came from the reset link and
// must set a new password before using the portal. sessionStorage keeps the
// flag across a reload while the recovery session is live.
const RECOVERY_FLAG = 'portal_recovery_pending'

// Offline boot cache: the profile is pure reference data for UI gating —
// every write re-checks role/scope server-side (RLS + RPC gates), so a
// stale cached profile can only mis-gate the UI, never mis-write. Keyed by
// auth user id so a shared device never serves user A's profile to user B.
const PROFILE_CACHE_KEY = 'portal_profile_cache'

function readCachedProfile(userId) {
  try {
    if (!userId) return null
    const raw = localStorage.getItem(PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.userId !== userId) return null
    return parsed.profile ?? null
  } catch {
    return null
  }
}

function writeCachedProfile(userId, profile) {
  try {
    if (!userId || !profile) return
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ userId, profile, at: Date.now() }))
  } catch {
    // Private mode / quota — the session still works online, boot just has
    // no offline fallback. Never let persistence break auth.
  }
}

export function PortalAuthProvider({ children }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [profileError, setProfileError] = useState(null)
  const [isRecovery, setIsRecovery] = useState(false)
  // True while a profile fetch is in flight (boot or auth-event driven), so
  // callers can tell "still loading" apart from "loaded, no access".
  const [profilePending, setProfilePending] = useState(false)
  // Set when boot finds Supabase error params in the URL (e.g. an expired or
  // already-used reset link yields no session) — shown on the login screen.
  const [recoveryLinkError, setRecoveryLinkError] = useState(null)

  const fetchProfile = useCallback(async () => {
    setProfileError(null)
    // Transport blips (net::ERR_CONNECTION_CLOSED, Failed to fetch, brief
    // project wake-ups) must not kill boot on the first try — retry twice
    // with a short backoff. Only network-shaped errors are retried; a real
    // API/RLS error returns immediately.
    const isNetworkError = (err) => {
      if (!err) return false
      if (err.code) return false // PostgREST error (has code) — not transport
      return /failed to fetch|network|connection|abort|timeout|ERR_|load failed/i.test(
        `${err.message || ''} ${err.name || ''} ${String(err)}`,
      )
    }
    let lastError = null
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1200 * attempt))
      const { data, error } = await supabase.rpc('get_portal_profile')
      if (!error) {
        // Cache for offline boot (user id from the local session read —
        // no network — so the cache key can never cross users).
        try {
          const { data: { session: s } } = await supabase.auth.getSession()
          writeCachedProfile(s?.user?.id, data)
        } catch { /* cache best-effort only */ }
        return data
      }
      lastError = error
      if (!isNetworkError(error)) break
    }
    const error = lastError
    // Offline with a previous login: serve the cached profile instead of
    // the dead-end error screen — the scanner (and every role page) boots
    // from here, and writes stay server-gated regardless.
    if (isNetworkError(error)) {
      try {
        const { data: { session: s } } = await supabase.auth.getSession()
        const cached = readCachedProfile(s?.user?.id)
        if (cached) {
          console.warn('[Auth] offline — serving cached profile')
          return cached
        }
      } catch { /* fall through to the error below */ }
    }
    {
      console.error('Error fetching portal profile:', error)
      setProfileError(error.message || 'Could not load your profile')
      return null
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    setLoading(true)
    const p = await fetchProfile()
    if (p) setProfile(p)
    setLoading(false)
    return p
  }, [fetchProfile])

  useEffect(() => {
    let mounted = true
    // An expired/invalid recovery link lands back here with error params in
    // the hash/query and no session — surface an explanation on login.
    try {
      const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
      const queryParams = new URLSearchParams(window.location.search || '')
      if (hashParams.get('error') || queryParams.get('error')) {
        setRecoveryLinkError('Your reset link expired or was already used — request a new one')
      }
    } catch {
      // URL parsing must never break boot
    }
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (!mounted) return
      setSession(s)
      // the reset-link session survives a reload, but the PASSWORD_RECOVERY
      // event only fires once — the sessionStorage flag re-arms the reset UI
      if (s?.user && sessionStorage.getItem(RECOVERY_FLAG) === '1') {
        setIsRecovery(true)
      } else if (!s?.user) {
        sessionStorage.removeItem(RECOVERY_FLAG)
      }
      if (s?.user) {
        setProfilePending(true)
        // A boot drain that ran before the session restored reads an empty
        // queue — kick the app-level sync engine now that auth is available.
        // Fire-and-forget: auth must never wait on sync.
        try { notifySessionAvailable() } catch { /* sync best-effort */ }
        const p = await fetchProfile()
        if (!mounted) return
        setProfile(p)
        setProfilePending(false)
      }
      setLoading(false)
    }).catch((err) => {
      // Never leave the app stuck on the boot spinner (e.g. Supabase
      // unreachable) — route into the recoverable profile-error screen.
      console.error('Boot session load failed:', err)
      if (!mounted) return
      setProfileError(err?.message || 'Could not reach the authentication service')
      setProfilePending(false)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      // events can still fire after this effect's cleanup (e.g. token refresh
      // racing an unmount) — guard every state write with `mounted`
      if (!mounted) return
      setSession(s)
      if (event === 'PASSWORD_RECOVERY' && s?.user) {
        // user clicked the reset link — show the new-password screen first
        sessionStorage.setItem(RECOVERY_FLAG, '1')
        setIsRecovery(true)
      } else if (event === 'SIGNED_OUT') {
        sessionStorage.removeItem(RECOVERY_FLAG)
        setIsRecovery(false)
      }
      // Fetch the profile only on sign-in-ish events. TOKEN_REFRESHED
      // (hourly) and any other event must not re-hit the profile RPC.
      if (s?.user && ['SIGNED_IN', 'INITIAL_SESSION', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event)) {
        setProfilePending(true)
        // Kick the sync engine on every fresh session (not just boot):
        // queued rows must not wait for the poll after a sign-in.
        try { notifySessionAvailable() } catch { /* sync best-effort */ }
        const p = await fetchProfile()
        if (!mounted) return
        setProfile(p)
        setProfilePending(false)
      } else if (!s?.user) {
        setProfile(null)
        setProfileError(null)
      }
    })

    return () => { mounted = false; subscription?.unsubscribe() }
  }, [fetchProfile])

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // a normal sign-in means the recovery session (if any) is done
    sessionStorage.removeItem(RECOVERY_FLAG)
    setIsRecovery(false)
    setRecoveryLinkError(null)
  }

  const signOut = async () => {
    try { await supabase.auth.signOut() } catch (e) { console.warn('signOut error', e) }
    sessionStorage.removeItem(RECOVERY_FLAG)
    setIsRecovery(false)
    setProfile(null)
    setSession(null)
    setProfileError(null)
    setProfilePending(false)
    setRecoveryLinkError(null)
  }

  const clearRecovery = useCallback(() => {
    sessionStorage.removeItem(RECOVERY_FLAG)
    setIsRecovery(false)
  }, [])

  const hasPermission = useCallback((perm) => {
    if (!profile) return false
    if (profile.role === 'super_admin') return true
    return profile.permissions?.[perm] === true
  }, [profile])

  const value = {
    profile,
    session,
    loading,
    profileError,
    profilePending,
    recoveryLinkError,
    isRecovery,
    clearRecovery,
    refreshProfile,
    signIn,
    signOut,
    hasPermission,
    isAuthenticated: !!session,
  }

  return (
    <PortalAuthContext.Provider value={value}>
      {children}
    </PortalAuthContext.Provider>
  )
}

export function usePortalAuth() {
  const context = useContext(PortalAuthContext)
  if (!context) {
    throw new Error('usePortalAuth must be used within PortalAuthProvider')
  }
  return context
}
