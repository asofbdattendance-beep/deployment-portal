import { useState, lazy, Suspense, useEffect, useCallback } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import { supabase } from './lib/supabase'
import { useToast } from './components/Toast'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { ROLE_LABELS, ROLE_COLORS } from './lib/supabase'
import { Calendar, Users, ClipboardCheck, ShieldCheck, Star, Tags, RefreshCw, AlertTriangle } from 'lucide-react'

// Code-split each page so the initial bundle stays small (xlsx etc. only
// loads when the page that uses it is actually opened).
const DeploymentPage = lazy(() => import('./pages/DeploymentPage'))
const ScheduleMakerPage = lazy(() => import('./pages/ScheduleMakerPage'))
const ConsentPage = lazy(() => import('./pages/ConsentPage'))
const VssPage = lazy(() => import('./pages/VssPage'))
const DeploymentAllocationPage = lazy(() => import('./pages/DeploymentAllocationPage'))

const PAGES = {
  schedule: { label: 'Schedule', icon: Calendar, roles: ['aso', 'super_admin'] },
  consent: { label: 'Consent & Deploy', icon: ClipboardCheck, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin'] },
  vss: { label: 'VSS', icon: Star, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin'] },
  alloc: { label: 'Finalize Deployment', icon: Tags, roles: ['aso', 'super_admin'] },
  deployment: { label: 'Overview', icon: Users, roles: ['aso', 'super_admin'] },
}

function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
    </div>
  )
}

function Dashboard() {
  const { profile, signOut } = usePortalAuth()
  const toast = useToast()
  const visiblePages = Object.entries(PAGES).filter(([, cfg]) => cfg.roles.includes(profile?.role))
  const [activePage, setActivePage] = useState(visiblePages[0]?.[0] || 'consent')
  const [schedules, setSchedules] = useState([])
  const [scheduleId, setScheduleId] = useState('')

  const currentPage = visiblePages.some(([k]) => k === activePage) ? activePage : (visiblePages[0]?.[0] || 'consent')

  // keep the browser tab title in sync with the visible page
  useEffect(() => {
    document.title = `${PAGES[currentPage]?.label || 'Deployment Portal'} · Deployment Portal`
  }, [currentPage])

  // ONE schedule dropdown drives the query on every page below. ScheduleMakerPage
  // mutates schedules (create/status/deadline/delete), so it reports back via
  // refreshSchedules to keep this list (and the Consent page's deadline pill) fresh.
  const loadSchedules = useCallback(async () => {
    const { data, error } = await supabase.from('deployment_schedules').select('id, name, status, deadline').order('created_at', { ascending: false })
    if (error) { toast.error(error.message); return }
    setSchedules(data || [])
    setScheduleId(prev => (prev && (data || []).some(s => s.id === prev)) ? prev : (data?.[0]?.id || ''))
  }, [toast])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7fb' }}>
      {/* ── top bar: brand + schedule dropdown + user ── */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexShrink: 0, flexWrap: 'wrap' }}>
          <div className="brand-logo">
            <ShieldCheck size={18} />
          </div>
          <h1 className="brand-title">Deployment Portal</h1>
          <select value={scheduleId} onChange={e => setScheduleId(e.target.value)} className="select" aria-label="Select schedule" style={{ marginLeft: '0.35rem', maxWidth: 260 }}>
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="header-actions">
          <span className="header-user">{profile?.name}</span>
          <span className="role-badge" style={{ background: ROLE_COLORS[profile?.role] || '#888' }}>
            {ROLE_LABELS[profile?.role] || profile?.role}
          </span>
          {profile?.centre && <span className="header-centre">({profile.centre})</span>}
          <button onClick={signOut} className="btn btn-ghost signout-btn">
            Sign out
          </button>
        </div>
      </header>

      {/* ── separate tab navbar ── */}
      <nav className="tab-nav">
        {visiblePages.map(([key, cfg]) => {
          const active = currentPage === key
          return (
            <button
              key={key}
              onClick={() => setActivePage(key)}
              className={`tab-btn ${active ? 'tab-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <cfg.icon size={17} />
              <span>{cfg.label}</span>
            </button>
          )
        })}
      </nav>

      <main style={{ flex: 1 }}>
        <Suspense fallback={<PageFallback />}>
          {currentPage === 'schedule' && <ScheduleMakerPage refreshSchedules={loadSchedules} />}
          {currentPage === 'consent' && <ConsentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'vss' && <VssPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'deployment' && <DeploymentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'alloc' && <DeploymentAllocationPage schedules={schedules} scheduleId={scheduleId} />}
        </Suspense>
      </main>
    </div>
  )
}

function AccessDenied({ signOut }) {
  return (
    <div style={{ maxWidth: 400, margin: '4rem auto', padding: '0 1rem', textAlign: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <h1 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Access Denied</h1>
        <p style={{ color: '#6b7280' }}>You don't have access to this portal.</p>
        <button onClick={signOut} style={{ marginTop: '1rem', padding: '0.5rem 1rem', border: 'none', borderRadius: 8, background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>
          Sign Out
        </button>
      </div>
    </div>
  )
}

function ProfileError({ message, onRetry, onSignOut }) {
  return (
    <div style={{ maxWidth: 440, margin: '4rem auto', padding: '0 1rem', textAlign: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.75rem' }}>
          <AlertTriangle size={28} style={{ color: '#b45309' }} />
        </div>
        <h1 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Couldn't load your profile</h1>
        <p style={{ color: '#6b7280', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
          {message || 'Something went wrong while loading your account. This is usually temporary.'}
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={onRetry} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <RefreshCw size={15} /> Try again
          </button>
          <button onClick={onSignOut} className="btn">Sign out</button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { isAuthenticated, loading, profile, profileError, signOut, refreshProfile, isRecovery } = usePortalAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f6f7fb' }}>
        <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
      </div>
    )
  }

  // User arrived via the forgot-password link — they must set a new password
  // before the portal unlocks (PASSWORD_RECOVERY session).
  if (isRecovery && isAuthenticated) return <ResetPasswordPage />

  if (!isAuthenticated) return <LoginPage />

  // Authenticated but the profile RPC failed (transient / config issue):
  // show a retry screen instead of a cryptic access-denied.
  if (!profile) {
    if (profileError) {
      return <ProfileError message={profileError} onRetry={refreshProfile} onSignOut={signOut} />
    }
    return <AccessDenied signOut={signOut} />
  }

  const allowedRoles = ['centre_user', 'centre_admin', 'aso', 'super_admin']
  if (!allowedRoles.includes(profile.role)) return <AccessDenied signOut={signOut} />

  return <Dashboard />
}
