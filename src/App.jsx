import { useState, lazy, Suspense, useEffect, useCallback, useRef } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import { supabase } from './lib/supabase'
import { useToast } from './components/Toast'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { ROLE_LABELS, ROLE_COLORS } from './lib/supabase'
import DbVersionBanner from './components/DbVersionBanner'
import { ShieldCheck, ScanLine, RefreshCw, AlertTriangle, Wrench, ChevronDown, Check } from 'lucide-react'
import { PAGES } from './lib/pages'

// ── Maintenance mode — flip to false to restore portal ──
const MAINTENANCE_MODE = false
const MAINTENANCE_MESSAGE = 'Under Maintenance - Will be up and running by 10:45'

function MaintenanceScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f7fb', padding: '1.5rem' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '2.5rem 2rem', boxShadow: '0 8px 30px rgba(15,23,42,0.08)', border: '1px solid #e2e8f0', maxWidth: 560, width: '100%', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
          <div style={{ width: 56, height: 56, borderRadius: 999, background: '#fffbeb', border: '1px solid #fde68a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b45309' }}>
            <Wrench size={26} />
          </div>
        </div>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#0f172a', marginBottom: '0.5rem' }}>{MAINTENANCE_MESSAGE}</h1>
        <p style={{ color: '#64748b', fontSize: '0.9rem', lineHeight: 1.5, margin: 0 }}>The portal is temporarily under maintenance. Please check back after 10:45. Your data is safe and no progress will be lost.</p>
      </div>
    </div>
  )
}

// Code-split each page so the initial bundle stays small (xlsx etc. only
// loads when the page that uses it is actually opened).
const DeploymentPage = lazy(() => import('./pages/DeploymentPage'))
const ScheduleMakerPage = lazy(() => import('./pages/ScheduleMakerPage'))
const ConsentPage = lazy(() => import('./pages/ConsentPage'))
const VssPage = lazy(() => import('./pages/VssPage'))
const DeploymentAllocationPage = lazy(() => import('./pages/DeploymentAllocationPage'))
const CentreListsPage = lazy(() => import('./pages/CentreListsPage'))
const DeptInchargePage = lazy(() => import('./pages/DeptInchargePage'))
const ScannerPage = lazy(() => import('./pages/ScannerPage'))
const AttendancePage = lazy(() => import('./pages/AttendancePage'))
const ControlPanelPage = lazy(() => import('./pages/ControlPanelPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const LiveScannersPage = lazy(() => import('./pages/LiveScannersPage'))
const AnomaliesPage = lazy(() => import('./pages/AnomaliesPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))

// Exported for UsersPage's permission matrix (single source: page → roles).
export { PAGES } from './lib/pages';

const GROUPS = {
  attendance: { label: 'Attendance', icon: ScanLine },
}

// One navbar dropdown for a page group. A group with a single visible page
// (e.g. Attendance for centre roles) renders as a plain tab — never a
// one-item menu. Keyboard: Escape closes (focus returns to the button),
// arrows/Home/End move between items, Tab leaves naturally.
function NavGroup({ id, label, icon: Icon, items, currentPage, onSelect }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const active = items.some(([k]) => k === currentPage)
  useEffect(() => {
    if (!open) return
    const onPointer = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        wrapRef.current?.querySelector(':scope > button')?.focus()
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open ])
  const moveFocus = (e) => {
    const menuItems = [...(wrapRef.current?.querySelectorAll('[role="menuitem"]') || [])]
    if (!menuItems.length) return
    const i = menuItems.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); (menuItems[i + 1] || menuItems[0]).focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (menuItems[i - 1] || menuItems[menuItems.length - 1]).focus() }
    else if (e.key === 'Home') { e.preventDefault(); menuItems[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); menuItems[menuItems.length - 1].focus() }
  }
  return (
    <div className="tab-group" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`tab-btn${active ? ' tab-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`nav-menu-${id}`}
        title={items.map(([, c]) => c.label).join(' · ')}
      >
        <Icon size={17} />
        <span>{label}</span>
        <ChevronDown size={14} style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div id={`nav-menu-${id}`} role="menu" aria-label={`${label} pages`} className="tab-menu" onKeyDown={moveFocus}>
          {items.map(([key, cfg]) => {
            const itemActive = currentPage === key
            const ItemIcon = cfg.icon
            return (
              <button
                key={key}
                type="button"
                role="menuitem"
                aria-current={itemActive ? 'page' : undefined}
                onClick={() => { setOpen(false); onSelect(key) }}
                className={`tab-menu-item${itemActive ? ' tab-menu-active' : ''}`}
              >
                <ItemIcon size={16} />
                <span>{cfg.label}</span>
                {itemActive && <Check size={14} style={{ marginLeft: 'auto' }} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
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
  // Deep-link payload for cross-page jumps (dashboard tiles/rows → a page
  // with a filter pre-applied). Tab switches remount pages, so a prop is
  // enough — no router, no context. Cleared on manual tab clicks.
  const [navFilter, setNavFilter] = useState(null)
  const handleNavigate = useCallback((page, filter) => {
    setNavFilter({ page, ...(filter || {}) })
    setActivePage(page)
  }, [])

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
          {profile?.role === 'vss_operator'
            ? <span className="header-centre">(All centres)</span>
            : profile?.centre && <span className="header-centre">({profile.centre})</span>}
          <button onClick={signOut} className="btn btn-ghost signout-btn">
            Sign out
          </button>
        </div>
      </header>

      {/* L-07 handshake: warn when the database predates this frontend. */}
      <DbVersionBanner />

      {/* ── separate tab navbar ── */}
      <nav className="tab-nav" aria-label="Primary">
        {(() => {
          const items = []
          const seenGroups = new Set()
          visiblePages.forEach(([key, cfg]) => {
            if (!cfg.group) { items.push({ type: 'page', key, cfg }); return }
            if (seenGroups.has(cfg.group)) return
            seenGroups.add(cfg.group)
            const groupItems = visiblePages.filter(([, c]) => c.group === cfg.group)
            // single visible child → plain tab, never a one-item menu
            if (groupItems.length === 1) items.push({ type: 'page', key: groupItems[0][0], cfg: groupItems[0][1] })
            else items.push({ type: 'group', id: cfg.group, items: groupItems })
          })
          return items.map((item) => {
            if (item.type === 'group') {
              const g = GROUPS[item.id] || { label: item.id, icon: ScanLine }
              return (
                <NavGroup
                  key={`group-${item.id}`}
                  id={item.id}
                  label={g.label}
                  icon={g.icon}
                  items={item.items}
                  currentPage={currentPage}
                  onSelect={(key) => { setNavFilter(null); setActivePage(key) }}
                />
              )
            }
            const active = currentPage === item.key
            return (
              <button
                key={item.key}
                onClick={() => { setNavFilter(null); setActivePage(item.key) }}
                className={`tab-btn ${active ? 'tab-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <item.cfg.icon size={17} />
                <span>{item.cfg.label}</span>
              </button>
            )
          })
        })()}
      </nav>

      <main style={{ flex: 1 }}>
        <Suspense fallback={<PageFallback />}>
          {currentPage === 'schedule' && <ScheduleMakerPage refreshSchedules={loadSchedules} />}
          {currentPage === 'consent' && <ConsentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'vss' && <VssPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'deployment' && <DeploymentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'alloc' && <DeploymentAllocationPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'centreLists' && <CentreListsPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'deptIncharge' && <DeptInchargePage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'scanner' && <ScannerPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'attendance' && <AttendancePage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'dashboard' && <DashboardPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />}
          {currentPage === 'reports' && <ReportsPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} initialCentre={navFilter?.page === 'reports' ? navFilter?.centre : undefined} />}
          {currentPage === 'liveScanners' && <LiveScannersPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />}
          {currentPage === 'anomalies' && <AnomaliesPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />}
          {currentPage === 'control' && <ControlPanelPage schedules={schedules} scheduleId={scheduleId} refreshSchedules={loadSchedules} />}
          {currentPage === 'users' && <UsersPage />}
        </Suspense>
      </main>
    </div>
  )
}

function SigningIn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f6f7fb', gap: '1rem' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
      <p style={{ color: '#64748b', fontSize: '0.9rem', margin: 0 }}>Signing you in…</p>
    </div>
  )
}

// AccessDenied doubles as the invite-claim screen (v48): a signed-in user
// with no portal login can paste the code from their invite here. Suspended
// logins get an explicit message instead of the generic denial.
function AccessDenied({ signOut, mode }) {
  const [status, setStatus] = useState(null) // { has_login, active } | null while loading
  const [code, setCode] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState('')
  useEffect(() => {
    if (mode !== 'profile') return
    let alive = true
    supabase.rpc('my_access_status').then(({ data, error }) => {
      if (!alive || error) return
      setStatus(data || null)
    }).catch(() => {})
    return () => { alive = false }
  }, [mode])
  const claim = async () => {
    const token = code.trim()
    if (!token || claiming) return
    setClaiming(true)
    setClaimError('')
    try {
      const { data, error } = await supabase.rpc('claim_portal_invite', { p_token: token })
      if (error) { setClaimError(error.message); return }
      if (data?.ok) window.location.reload()
      else setClaimError('Could not link this invite — ask the ASO office for help')
    } catch (e) {
      setClaimError(e?.message || 'Could not link this invite')
    } finally {
      setClaiming(false)
    }
  }
  const suspended = mode === 'profile' && status && status.has_login && !status.active
  const noLogin = mode === 'profile' && status && !status.has_login
  return (
    <div style={{ maxWidth: 440, margin: '4rem auto', padding: '0 1rem', textAlign: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <h1 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
          {suspended ? 'Account Suspended' : 'Access Denied'}
        </h1>
        <p style={{ color: '#6b7280' }}>
          {suspended
            ? 'This login has been suspended. Contact the ASO office to restore access.'
            : noLogin
              ? 'No portal login is linked to this account yet. If the ASO office invited you, paste the invite code below.'
              : "You don't have access to this portal."}
        </p>
        {noLogin && (
          <div style={{ marginTop: '1.25rem', textAlign: 'left' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#334155', marginBottom: '0.35rem' }}>Invite code</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                value={code}
                onChange={e => setCode(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') claim() }}
                placeholder="e.g. 7KQ2M9XP"
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: '0.55rem 0.7rem', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', fontFamily: 'monospace', textTransform: 'uppercase' }}
              />
              <button onClick={claim} disabled={claiming || !code.trim()} className="btn btn-primary">
                {claiming ? 'Linking…' : 'Link login'}
              </button>
            </div>
            {claimError && <div className="error-message" style={{ marginTop: '0.6rem' }}>{claimError}</div>}
          </div>
        )}
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
  const { isAuthenticated, loading, profile, profileError, profilePending, signOut, refreshProfile, isRecovery } = usePortalAuth()

  if (MAINTENANCE_MODE) return <MaintenanceScreen />

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
    // Profile fetch still in flight (e.g. right after sign-in) — neutral
    // loading state. Access Denied is only for a definitive no-access.
    if (profilePending) {
      return <SigningIn />
    }
    return <AccessDenied signOut={signOut} mode="profile" />
  }

  const allowedRoles = ['centre_user', 'centre_admin', 'aso', 'super_admin', 'dept_incharge', 'scanner', 'vss_operator']
  if (!allowedRoles.includes(profile.role)) return <AccessDenied signOut={signOut} mode="role" />

  return <Dashboard />
}
