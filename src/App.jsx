import { useState } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import LoginPage from './pages/LoginPage'
import DeploymentPage from './pages/DeploymentPage'
import ScheduleMakerPage from './pages/ScheduleMakerPage'
import ConsentPage from './pages/ConsentPage'
import { ROLE_LABELS, ROLE_COLORS } from './lib/supabase'
import { Calendar, Users, ClipboardCheck } from 'lucide-react'

const PAGES = {
  schedule: { label: 'Schedule', icon: Calendar, roles: ['aso', 'super_admin'] },
  consent: { label: 'Consent & Deploy', icon: ClipboardCheck, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin'] },
  deployment: { label: 'Overview', icon: Users, roles: ['aso', 'super_admin'] },
}

function Dashboard() {
  const { profile, signOut } = usePortalAuth()
  const visiblePages = Object.entries(PAGES).filter(([, cfg]) => cfg.roles.includes(profile?.role))
  const [activePage, setActivePage] = useState(visiblePages[0]?.[0] || 'consent')

  const currentPage = visiblePages.some(([k]) => k === activePage) ? activePage : (visiblePages[0]?.[0] || 'consent')

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#f6f7fb' }}>
      <header style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(8px)', borderBottom: '1px solid #e2e8f0', padding: '0.65rem 1.5rem', position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
              <Users size={15} />
            </div>
            <h1 className="brand-title" style={{ fontSize: '1.05rem', fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>Deployment Portal</h1>
          </div>
          {visiblePages.length > 1 && (
            <nav className="nav-tabs" style={{ display: 'flex', gap: '0.25rem', background: '#f1f5f9', padding: '0.2rem', borderRadius: 10, overflowX: 'auto' }}>
              {visiblePages.map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => setActivePage(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.35rem',
                    padding: '0.35rem 0.85rem', border: 'none', borderRadius: 8, whiteSpace: 'nowrap',
                    background: currentPage === key ? '#fff' : 'transparent',
                    color: currentPage === key ? '#4f46e5' : '#64748b',
                    boxShadow: currentPage === key ? '0 1px 3px rgba(15,23,42,0.12)' : 'none',
                    cursor: 'pointer', fontSize: '0.82rem', fontWeight: currentPage === key ? 700 : 500,
                    transition: 'all 0.15s',
                  }}
                >
                  <cfg.icon size={14} />
                  {cfg.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
          <span className="header-user" style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 500 }}>{profile?.name}</span>
          <span style={{ background: ROLE_COLORS[profile?.role] || '#888', color: '#fff', padding: '0.15rem 0.55rem', borderRadius: 99, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
            {ROLE_LABELS[profile?.role] || profile?.role}
          </span>
          {profile?.centre && <span className="header-centre" style={{ fontSize: '0.8rem', color: '#94a3b8' }}>({profile.centre})</span>}
          <button onClick={signOut} className="btn btn-ghost" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
            Sign out
          </button>
        </div>
      </header>
      <main style={{ flex: 1 }}>
        {currentPage === 'schedule' && <ScheduleMakerPage />}
        {currentPage === 'consent' && <ConsentPage />}
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
