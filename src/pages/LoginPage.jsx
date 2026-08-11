import { useState } from 'react'
import { usePortalAuth } from '../context/PortalAuthContext'
import { supabase } from '../lib/supabase'
import { LogIn, AlertCircle, Users, KeyRound, ArrowLeft, MailCheck } from 'lucide-react'

export default function LoginPage() {
  const { signIn } = usePortalAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // forgot-password mode
  const [resetMode, setResetMode] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetError, setResetError] = useState('')
  const [resetLoading, setResetLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const sendResetLink = async (e) => {
    e.preventDefault()
    setResetError('')
    setResetLoading(true)
    try {
      // redirectTo points back at this app so Supabase's reset page can
      // return the user here after setting a new password
      await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
        redirectTo: window.location.origin,
      })
      setResetSent(true)
    } catch (err) {
      setResetError(err.message || 'Could not send reset link')
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', marginBottom: '1.25rem' }}>
          <Users size={24} />
        </div>

        {resetMode ? (
          <>
            <h1>Reset password</h1>
            <p className="login-subtitle">We'll email you a link to set a new password</p>

            {resetSent ? (
              <div className="reset-sent">
                <MailCheck size={22} style={{ color: '#10b981' }} />
                <p style={{ fontSize: '0.88rem', color: '#64748b', textAlign: 'center' }}>
                  If an account exists for <b>{resetEmail}</b>, a reset link is on its way. Check your inbox (and spam folder).
                </p>
              </div>
            ) : (
              <form onSubmit={sendResetLink}>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                    autoFocus
                  />
                </div>

                {resetError && (
                  <div className="error-message">
                    <AlertCircle size={16} />
                    <span>{resetError}</span>
                  </div>
                )}

                <button type="submit" className="login-submit" disabled={resetLoading || !resetEmail.trim()}>
                  <KeyRound size={16} />
                  {resetLoading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            )}

            <button
              onClick={() => { setResetMode(false); setResetSent(false); setResetError('') }}
              className="back-to-login"
            >
              <ArrowLeft size={14} /> Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1>Deployment Portal</h1>
            <p className="login-subtitle">Sewadar Consent & Deployment</p>

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                />
              </div>

              {error && (
                <div className="error-message">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" className="login-submit" disabled={loading}>
                <LogIn size={16} />
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <button onClick={() => setResetMode(true)} className="forgot-link">
              Forgot password?
            </button>
          </>
        )}
      </div>
    </div>
  )
}
