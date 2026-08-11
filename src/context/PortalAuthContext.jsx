import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const PortalAuthContext = createContext(null)

export function PortalAuthProvider({ children }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [profileError, setProfileError] = useState(null)

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
      if (s?.user) {
        const p = await fetchProfile()
        if (mounted) setProfile(p)
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      // events can still fire after this effect's cleanup (e.g. token refresh
      // racing an unmount) — guard every state write with `mounted`
      if (!mounted) return
      setSession(s)
      if (s?.user) {
        const p = await fetchProfile()
        if (mounted) setProfile(p)
      } else {
        setProfile(null)
        setProfileError(null)
      }
    })

    return () => { mounted = false; subscription?.unsubscribe() }
  }, [fetchProfile])

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signOut = async () => {
    try { await supabase.auth.signOut() } catch (e) { console.warn('signOut error', e) }
    setProfile(null)
    setSession(null)
    setProfileError(null)
  }

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
