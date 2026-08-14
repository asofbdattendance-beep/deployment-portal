import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import { KeyRound, AlertCircle, ArrowLeft, Users } from 'lucide-react'

// Shown when the user arrives via Supabase's password-recovery link
// (PASSWORD_RECOVERY session). Sets the new password, then signs in
// normally so the recovery session is replaced by a regular one.
export default function ResetPasswordPage() {
  const { session, clearRecovery, signIn, signOut } = usePortalAuth()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const email = session?.user?.email || ''

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      const { error: upErr } = await supabase.auth.updateUser({ password })
      if (upErr) throw upErr
      // normalize the session — the recovery token is consumed, so re-sign in
      await signIn(email, password)
      clearRecovery()
      toast.success('Password updated — you are signed in')
    } catch (err) {
      setError(err.message || 'Could not update password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', marginBottom: '1.25rem' }}>
          <Users size={24} />
        </div>

        <h1>Set a new password</h1>
        <p className="login-subtitle">You opened a password-reset link{email ? <> for <b>{email}</b></> : null}</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat the new password"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div className="error-message">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="login-submit" disabled={loading || !password || !confirm}>
            <KeyRound size={16} />
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>

        <button onClick={signOut} className="back-to-login">
          <ArrowLeft size={14} /> Cancel and sign out
        </button>
      </div>
    </div>
  )
}