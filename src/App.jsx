import { useState } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import LoginPage from './pages/LoginPage'
import DeploymentPage from './pages/DeploymentPage'
import ScheduleMakerPage from './pages/ScheduleMakerPage'
import ConsentPage from './pages/ConsentPage'
import VssPage from './pages/VssPage'
import { ROLE_LABELS, ROLE_COLORS } from './lib/supabase'
import { Calendar, Users, ClipboardCheck, ShieldCheck, Star } from 'lucide-react'

const PAGES = {
  schedule: { label: 'Schedule', icon: Calendar, roles: ['aso', 'super_admin'] },
  consent: { label: 'Consent & Deploy', icon: ClipboardCheck, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin'] },
  vss: { label: 'VSS', icon: Star, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin'] },
  deployment: { label: 'Overview', icon: Users, roles: ['aso', 'super_admin'] },
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
        {currentPage === 'schedule' && <ScheduleMakerPage />}
        {currentPage === 'consent' && <ConsentPage />}
        {currentPage === 'vss' && <VssPage />}
        {currentPage === 'deployment' && <DeploymentPage />}
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

export default function App() {
  const { isAuthenticated, loading, profile, signOut } = usePortalAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f6f7fb' }}>
        <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
      </div>
    )
  }

  if (!isAuthenticated) return <LoginPage />

  const allowedRoles = ['centre_user', 'centre_admin', 'aso', 'super_admin']
  if (!profile || !allowedRoles.includes(profile.role)) return <AccessDenied signOut={signOut} />

  return <Dashboard />
}
