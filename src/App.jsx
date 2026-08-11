import { useState, lazy, Suspense } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import LoginPage from './pages/LoginPage'
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
  const visiblePages = Object.entries(PAGES).filter(([, cfg]) => cfg.roles.includes(profile?.role))
  const [activePage, setActivePage] = useState(visiblePages[0]?.[0] || 'consent')

  const currentPage = visiblePages.some(([k]) => k === activePage) ? activePage : (visiblePages[0]?.[0] || 'consent')

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7fb' }}>
      {/* ── top bar: brand + user ── */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexShrink: 0 }}>
          <div className="brand-logo">
            <ShieldCheck size={18} />
          </div>
          <h1 className="brand-title">Deployment Portal</h1>
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
          {currentPage === 'schedule' && <ScheduleMakerPage />}
          {currentPage === 'consent' && <ConsentPage />}
          {currentPage === 'vss' && <VssPage />}
          {currentPage === 'deployment' && <DeploymentPage />}
          {currentPage === 'alloc' && <DeploymentAllocationPage />}
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
  const { isAuthenticated, loading, profile, profileError, signOut, refreshProfile } = usePortalAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f6f7fb' }}>
        <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
      </div>
    )
  }

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
