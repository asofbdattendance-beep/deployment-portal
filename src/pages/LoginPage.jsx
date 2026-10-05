import { useState } from 'react'
import { usePortalAuth } from '../context/PortalAuthContext'
import { supabase } from '../lib/supabase'
import { perfStart, perfMark } from '../lib/perfTimings'
import { LogIn, AlertCircle, Users, KeyRound, ArrowLeft, MailCheck } from 'lucide-react'

export default function LoginPage() {
  const { signIn, recoveryLinkError } = usePortalAuth()
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
    // Phase-0 latency tripwire: tap → resolve → auth → (profile continues in
    // PortalAuthContext under the same run id). Paste via __portalPerfDump.
    const runId = perfStart('login')
    try {
      const identifier = email.trim()
      let loginEmail = identifier
      // Dual login (additive): a badge number (no '@') resolves to the
      // account's EXISTING email via resolve-login, then the SAME
      // signIn(email, password) runs — password and auth flow unchanged.
      // The email path below never calls the edge function.
      if (identifier && !identifier.includes('@')) {
        perfMark('login', runId, 'resolve-start')
        const { data, error: fnError } = await supabase.functions.invoke('resolve-login', {
          body: { badge: identifier },
        })
        perfMark('login', runId, 'resolve-end')
        const resolved = data && data.email
        if (fnError || !resolved) {
          const status = fnError && (fnError.status || fnError.code)
          if (status === 429) throw new Error('Too many attempts — try again in 15 minutes')
          throw new Error('No account found for that badge number')
        }
        loginEmail = resolved
      }
      perfMark('login', runId, 'auth-start')
      await signIn(loginEmail, password)
      perfMark('login', runId, 'auth-end')
    } catch (err) {
      perfMark('login', runId, 'failed')
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
      // return the user here after setting a new password.
      // supabase-js resolves { error } instead of throwing — read it, or
      // every failure would wrongly show the success state.
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
        redirectTo: window.location.origin,
      })
      if (resetErr) {
        setResetError(resetErr.message || 'Could not send reset link')
      } else {
        setResetSent(true)
      }
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

            {recoveryLinkError && (
              <div className="error-message">
                <AlertCircle size={16} />
                <span>{recoveryLinkError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Email or badge number</label>
                <input
                  type="text"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Email or badge number"
                  required
                  autoFocus
                  autoComplete="username"
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
