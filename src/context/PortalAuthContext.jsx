import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const PortalAuthContext = createContext(null)

// A PASSWORD_RECOVERY session means the user came from the reset link and
// must set a new password before using the portal. sessionStorage keeps the
// flag across a reload while the recovery session is live.
const RECOVERY_FLAG = 'portal_recovery_pending'

export function PortalAuthProvider({ children }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [profileError, setProfileError] = useState(null)
  const [isRecovery, setIsRecovery] = useState(false)

  const fetchProfile = useCallback(async () => {
    setProfileError(null)
    const { data, error } = await supabase.rpc('get_portal_profile')

    if (error) {
      console.error('Error fetching portal profile:', error)
      setProfileError(error.message || 'Could not load your profile')
      return null
    }
    return data
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
        const p = await fetchProfile()
        if (mounted) setProfile(p)
      }
      setLoading(false)
    }).catch((err) => {
      // Never leave the app stuck on the boot spinner (e.g. Supabase
      // unreachable) — route into the recoverable profile-error screen.
      console.error('Boot session load failed:', err)
      if (!mounted) return
      setProfileError(err?.message || 'Could not reach the authentication service')
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
      // INITIAL_SESSION duplicates the getSession() boot path above — skip it
      // so the profile RPC doesn't fire twice on every load
      if (s?.user && event !== 'INITIAL_SESSION') {
        const p = await fetchProfile()
        if (mounted) setProfile(p)
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
  }

  const signOut = async () => {
    try { await supabase.auth.signOut() } catch (e) { console.warn('signOut error', e) }
    sessionStorage.removeItem(RECOVERY_FLAG)
    setIsRecovery(false)
    setProfile(null)
    setSession(null)
    setProfileError(null)
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
