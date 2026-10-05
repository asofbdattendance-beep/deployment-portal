import { useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

/**
 * useManageLogin — thin React hook wrapping the `manage-login` Edge Function.
 *
 * Every method invokes the function, parses error.context.json for the real
 * error message (FunctionsHttpError.message is always generic), and returns
 * { data, error } so callers can toast or branch without re-parsing.
 *
 * `busy` is true while any operation is in flight.
 */

/**
 * Invoke manage-login and unwrap the response.
 * Returns { data, error } where error is a human-readable string or null.
 */
async function invokeManageLogin(body) {
  const { data, error } = await supabase.functions.invoke('manage-login', { body })
  if (error) {
    let realMsg = ''
    try {
      const ctx = error.context
      if (ctx && typeof ctx.json === 'function') {
        const parsed = await ctx.json()
        realMsg = parsed?.error || parsed?.message || ''
      }
    } catch { /* context already consumed or not JSON */ }
    return { data: null, error: realMsg || error.message || 'Request failed' }
  }
  if (data?.error) {
    return { data: null, error: data.error }
  }
  return { data, error: null }
}

export function useManageLogin() {
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (body) => {
    setBusy(true)
    try {
      return await invokeManageLogin(body)
    } finally {
      setBusy(false)
    }
  }, [])

  const deleteUser = useCallback(
    (userId) => run({ action: 'delete_user', user_id: userId }),
    [run]
  )

  const setPassword = useCallback(
    (userId, password) => run({ action: 'set_password', user_id: userId, password }),
    [run]
  )

  const signOutAll = useCallback(
    (userId) => run({ action: 'sign_out_all', user_id: userId }),
    [run]
  )

  const loadMeta = useCallback(
    () => run({ action: 'load_meta' }),
    [run]
  )

  const bulkCreate = useCallback(
    (users) => run({ action: 'bulk_create', users }),
    [run]
  )

  const sendInvite = useCallback(
    (email, role) => run({ action: 'send_invite', email, role }),
    [run]
  )

  return {
    busy,
    deleteUser,
    setPassword,
    signOutAll,
    loadMeta,
    bulkCreate,
    sendInvite,
  }
}
