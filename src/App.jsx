import { useState, lazy, Suspense, useEffect, useCallback, useMemo } from 'react'
import { usePortalAuth } from './context/PortalAuthContext'
import { supabase } from './lib/supabase'
import { useToast } from './components/Toast'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { ROLE_LABELS, ROLE_COLORS } from './lib/supabase'
import DbVersionBanner from './components/DbVersionBanner'
import { ShieldCheck, RefreshCw, AlertTriangle, Wrench, LogOut } from 'lucide-react'
import { PAGES, PHASES } from './lib/pages'
import PhaseSwitch from './components/PhaseSwitch'
import { phasesForRole, resolveActivePhase, readStoredPhase, storeActivePhase, pagesForRolePhase } from './lib/phase'
import { useIsMobile } from './hooks/useMediaQuery'
import MobileTabBar, { flattenNavItems, splitBarItems } from './components/mobile/MobileTabBar'
import MoreSheet from './components/mobile/MoreSheet'
import { SEWA_MODE_VISIT, SEWA_MODE_PREVISIT, canUsePrevisitMode, scheduleWindow, resolveSewaMode, isTestLogin } from './lib/sewaMode'
import { todayStrIST } from './lib/scannerUtils'

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
const DeptInchargeDashboardPage = lazy(() => import('./pages/DeptInchargeDashboardPage'))
const ScannerPage = lazy(() => import('./pages/ScannerPage'))
const AttendancePage = lazy(() => import('./pages/AttendancePage'))
const InchargeScannerPage = lazy(() => import('./pages/InchargeScannerPage'))
const ControlPanelPage = lazy(() => import('./pages/ControlPanelPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
// Previously dead code — present in the repo with tests, but neither in PAGES
// nor in the page switch, so no role could ever open them.
const LiveScannersPage = lazy(() => import('./pages/LiveScannersPage'))
const AnomaliesPage = lazy(() => import('./pages/AnomaliesPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const PrevisitView = lazy(() => import('./components/PrevisitView'))
const PrevisitDashboard = lazy(() => import('./components/PrevisitDashboard'))

// Exported for UsersPage's permission matrix (single source: page → roles).
export { PAGES } from './lib/pages';

// The old `group` dropdown mechanism is retired with the two-phase IA — the
// navbar renders one phase's pages as flat tabs, switched by PhaseSwitch.

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
  // ── Two-phase IA: the navbar shows one phase at a time. Landing = first
  // visible page of the active phase; the stored preference wins when the
  // role can still see it, otherwise the role default (Phase 1 for centre /
  // ASO roles, Phase 2 for dept_incharge / scanner).
  const availablePhases = useMemo(() => phasesForRole(profile?.role), [profile?.role])
  const [activePhase, setActivePhase] = useState(() => resolveActivePhase(profile?.role, readStoredPhase()))
  useEffect(() => {
    setActivePhase((prev) => (phasesForRole(profile?.role).includes(prev)
      ? prev
      : resolveActivePhase(profile?.role, readStoredPhase())))
  }, [profile?.role])
  const phasePages = useMemo(() => pagesForRolePhase(profile?.role, activePhase), [profile?.role, activePhase])
  const [activePage, setActivePage] = useState(phasePages[0]?.[0] || 'consent')
  const [schedules, setSchedules] = useState([])
  const [scheduleId, setScheduleId] = useState('')
  // ── Global sewa mode: Previsit vs Bhati Visit. Calendar auto-view for
  // REAL accounts, derived from the selected schedule's visit window +
  // today (IST); a schedule with no window reads as previsit-only. The
  // manual toggle is a TEST-login DEMO privilege only (email contains
  // "test", on a previsit-capable role): demo accounts open on the
  // calendar-correct side but the toggle is theirs and sticks — auto
  // never takes the view back. Real operators never see the switch, so
  // the view can never claim "Bhati Visit" while showing previsit-date
  // data. The override is VIEW-ONLY and resets on schedule change —
  // scanning writes the same session row in both modes and the scan date
  // classifies it, so the switch can never misfile a record. Roles without
  // previsit access (centre roles, vss_operator) are pinned to the visit
  // view they already have.
  const [sewaModeOverride, setSewaModeOverride] = useState(null)
  // A schedule change clears any manual lens synchronously (in the select
  // handler below) and here for programmatic changes — schedule B must
  // never paint under schedule A's override, even for one frame.
  useEffect(() => { setSewaModeOverride(null) }, [scheduleId])
  // The auto lens follows the wall clock: a tab left open across midnight
  // (or a laptop waking from sleep) recomputes on visibility/focus instead
  // of keeping yesterday's mode and pill.
  const [modeTick, setModeTick] = useState(0)
  useEffect(() => {
    const bump = () => setModeTick((t) => t + 1)
    document.addEventListener('visibilitychange', bump)
    window.addEventListener('focus', bump)
    return () => {
      document.removeEventListener('visibilitychange', bump)
      window.removeEventListener('focus', bump)
    }
  }, [])
  const schedule = schedules.find((s) => s.id === scheduleId)
  const win = scheduleWindow(schedule)
  const autoSewaMode = useMemo(
    () => resolveSewaMode(win.start, win.end, todayStrIST()),
    // modeTick/scheduleId are invalidation-only deps: the wall clock has
    // no reactive source, so the tick re-reads it on visibility/focus and
    // the schedule id re-reads it on switch (win.* cover date edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [win.start, win.end, modeTick, scheduleId]
  )
  const canOverrideSewaMode = canUsePrevisitMode(profile?.role) && isTestLogin(profile)
  // Hard rule: a manual Bhati Visit pin is meaningless without visit dates —
  // the schedule window is the only source of visit days, so the pin falls
  // back to auto (previsit) instead of rendering a visit view with no dates.
  const windowUsable = Boolean(win.start && win.end)
  const effectiveOverride = sewaModeOverride === SEWA_MODE_VISIT && !windowUsable ? null : sewaModeOverride
  const sewaMode = canUsePrevisitMode(profile?.role)
    ? (canOverrideSewaMode ? (effectiveOverride || autoSewaMode) : autoSewaMode)
    : SEWA_MODE_VISIT
  // Deep-link payload for cross-page jumps (dashboard tiles/rows → a page
  // with a filter pre-applied). Tab switches remount pages, so a prop is
  // enough — no router, no context. Cleared on manual tab clicks.
  const [navFilter, setNavFilter] = useState(null)
  // dept_incharge identity: assigned department names shown next to the role
  // badge. Fail-silent — the badge hides on any error or empty grant.
  const [deptNames, setDeptNames] = useState([])
  // Cross-phase aware: dashboard tiles and page links can target a page in
  // the other phase — the shell switches phase first so the target is visible.
  const handleNavigate = useCallback((page, filter) => {
    const targetPhase = PAGES[page]?.phase
    if ((targetPhase === 1 || targetPhase === 2) && targetPhase !== activePhase && phasesForRole(profile?.role).includes(targetPhase)) {
      storeActivePhase(targetPhase)
      setActivePhase(targetPhase)
    }
    setNavFilter({ page, ...(filter || {}) })
    setActivePage(page)
  }, [activePhase, profile?.role])
  const selectPhase = useCallback((phase) => {
    if (!phasesForRole(profile?.role).includes(phase)) return
    storeActivePhase(phase)
    setActivePhase(phase)
    setNavFilter(null)
    const first = pagesForRolePhase(profile?.role, phase)[0]?.[0]
    if (first) setActivePage(first)
  }, [profile?.role])

  const currentPage = phasePages.some(([k]) => k === activePage) ? activePage : (phasePages[0]?.[0] || 'consent')

  // ── Mobile shell (≤768px): bottom tab bar + More sheet replace the
  // wrapping desktop pill navbar. Desktop renders neither (useIsMobile is
  // false at ≥769px) so the laptop DOM is untouched. PAGES stays the
  // single source — the bar flattens the same visiblePages the navbar uses.
  const isMobile = useIsMobile()
  const [moreOpen, setMoreOpen] = useState(false)
  const mobileItems = useMemo(() => flattenNavItems(phasePages), [phasePages])
  const mobileOverflow = useMemo(() => splitBarItems(mobileItems).overflow, [mobileItems])
  // Full sitemap for the More sheet, sectioned by phase (the bar itself only
  // carries the active phase — the sheet is where cross-phase jumps happen).
  const mobileSections = useMemo(() => availablePhases.map((p) => ({
    phase: p,
    label: PHASES[p],
    items: flattenNavItems(pagesForRolePhase(profile?.role, p)),
  })), [availablePhases, profile?.role])
  const handleMobileSelect = useCallback((key) => {
    setMoreOpen(false)
    handleNavigate(key, null)
  }, [handleNavigate])

  // keep the browser tab title in sync with the visible page
  useEffect(() => {
    document.title = `${PAGES[currentPage]?.label || 'Deployment Portal'} · Deployment Portal`
  }, [currentPage])

  // Single-row navbar: a tab switch to an off-screen-right tab would look
  // like a no-op, so the active pill is always scrolled into the bar's view
  // (same idiom MobileTabBar uses for the bottom bar).
  useEffect(() => {
    try {
      document.querySelector('.tab-nav .tab-active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
    } catch { /* jsdom has no layout scrolling */ }
  }, [currentPage])

  // ONE schedule dropdown drives the query on every page below. ScheduleMakerPage
  // mutates schedules (create/status/deadline/delete), so it reports back via
  // refreshSchedules to keep this list (and the Consent page's deadline pill) fresh.
  // Offline boot cache: the list is pure reference data, so an offline reload
  // hydrates the last known schedules (and selection) instead of landing the
  // scanner on "No schedules" with no camera. Keyed as one object so the
  // selection can never point at a schedule that is not in the list.
  const loadSchedules = useCallback(async () => {
    const readSchedulesCache = () => {
      try {
        const parsed = JSON.parse(localStorage.getItem('portal_schedules_cache') || 'null')
        if (parsed && Array.isArray(parsed.rows)) return parsed
      } catch { /* corrupted cache reads as absent */ }
      return null
    }
    const { data, error } = await supabase.from('deployment_schedules').select('id, name, status, deadline, visit_start_date, visit_end_date').order('created_at', { ascending: false })
    if (error) {
      const cached = readSchedulesCache()
      if (cached && cached.rows.length > 0) {
        setSchedules(cached.rows)
        setScheduleId(prev => (prev && cached.rows.some(s => s.id === prev)) ? prev : (cached.selectedId && cached.rows.some(s => s.id === cached.selectedId)) ? cached.selectedId : (cached.rows[0]?.id || ''))
        toast.warning('Offline — showing saved schedules')
        return
      }
      toast.error(error.message); return
    }
    setSchedules(data || [])
    setScheduleId(prev => {
      const next = (prev && (data || []).some(s => s.id === prev)) ? prev : (data?.[0]?.id || '')
      try { localStorage.setItem('portal_schedules_cache', JSON.stringify({ rows: data || [], selectedId: next, at: Date.now() })) } catch { /* persistence best-effort */ }
      return next
    })
  }, [toast])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  useEffect(() => {
    if (profile?.role !== 'dept_incharge' || !scheduleId) { setDeptNames([]); return }
    let alive = true
    supabase.rpc('get_my_dept_ids', { p_schedule: scheduleId }).then(async ({ data, error }) => {
      if (!alive || error || !Array.isArray(data) || data.length === 0) {
        if (alive) setDeptNames([])
        return
      }
      const { data: depts, error: deptError } = await supabase.from('deployment_departments').select('name').in('id', data)
      if (!alive || deptError) return
      setDeptNames((depts || []).map(d => d.name).filter(Boolean))
    }).catch(() => {})
    return () => { alive = false }
  }, [profile, scheduleId])

  return (
    <div className="app-shell" style={{ display: 'flex', flexDirection: 'column', background: '#f6f7fb' }}>
      {/* ── top bar: brand + schedule dropdown + user ── */}
      <header className="app-header">
        {/* Shrinkable: flexShrink:0 + no min-width made this row refuse to
            shrink and push the whole document ~64px wide at 320px. */}
        <div className="app-header-lead">
          <div className="brand-logo">
            <ShieldCheck size={18} />
          </div>
          <h1 className="brand-title">Deployment Portal</h1>
            <select value={scheduleId} onChange={e => { setSewaModeOverride(null); setScheduleId(e.target.value); try { const cached = JSON.parse(localStorage.getItem('portal_schedules_cache') || 'null'); if (cached) localStorage.setItem('portal_schedules_cache', JSON.stringify({ ...cached, selectedId: e.target.value })) } catch { /* best-effort */ } }} className="select" aria-label="Select schedule" style={{ marginLeft: '0.35rem', maxWidth: 260 }}>
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {canOverrideSewaMode && (
            <div role="group" aria-label="Sewa mode" title={sewaModeOverride ? 'Manual view — scanning is unaffected (the scan date decides)' : (sewaMode === SEWA_MODE_VISIT ? 'Auto: today is a visit day' : ((!win.start || !win.end) ? 'Auto: no visit dates set' : 'Auto: today is outside the visit window'))} style={{ display: 'inline-flex', marginLeft: '0.35rem' }}>
              <button
                type="button"
                onClick={() => setSewaModeOverride(SEWA_MODE_VISIT)}
                className={`seg-btn ${sewaMode === SEWA_MODE_VISIT ? 'seg-active' : ''}`}
                aria-pressed={sewaMode === SEWA_MODE_VISIT}
              >
                Bhati Visit
              </button>
              <button
                type="button"
                onClick={() => setSewaModeOverride(SEWA_MODE_PREVISIT)}
                className={`seg-btn ${sewaMode === SEWA_MODE_PREVISIT ? 'seg-active' : ''}`}
                aria-pressed={sewaMode === SEWA_MODE_PREVISIT}
              >
                Previsit
              </button>
            </div>
          )}
        </div>
        <div className="header-actions">
          <div
            className="user-chip"
            title={[profile?.name, profile?.badge_number, deptNames.join(', ')].filter(Boolean).join(' · ')}
          >
            <span className="user-avatar" aria-hidden="true">
              {(profile?.name || '?').trim().charAt(0).toUpperCase()}
            </span>
            <span className="header-user">{profile?.name}</span>
            {profile?.badge_number && <span className="header-centre">{profile.badge_number}</span>}
            <span className="role-badge" style={{ background: ROLE_COLORS[profile?.role] || '#888' }}>
              {ROLE_LABELS[profile?.role] || profile?.role}
            </span>
            {deptNames.length > 0 && <span className="header-centre header-depts">{deptNames.join(', ')}</span>}
          </div>
          <button onClick={signOut} className="btn btn-ghost signout-btn" title="Sign out" aria-label="Sign out">
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* L-07 handshake: warn when the database predates this frontend. */}
      <DbVersionBanner />

      {/* ── phase switch + single-phase tab navbar ── */}
      {availablePhases.length > 1 && (
        <div className="phase-row" style={{ display: 'flex', padding: '0.6rem 1rem 0' }}>
          <PhaseSwitch activePhase={activePhase} availablePhases={availablePhases} onChange={selectPhase} />
        </div>
      )}
      <nav className="tab-nav" aria-label="Primary">
        {phasePages.map(([key, cfg]) => {
          const active = currentPage === key
          const Icon = cfg.icon
          return (
            <button
              key={key}
              onClick={() => { setNavFilter(null); setActivePage(key) }}
              className={`tab-btn ${active ? 'tab-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={17} />
              <span>{cfg.label}</span>
            </button>
          )
        })}
      </nav>

      <main style={{ flex: 1, paddingBottom: isMobile ? 'calc(84px + env(safe-area-inset-bottom, 0px))' : undefined }}>
        <Suspense fallback={<PageFallback />}>
          {currentPage === 'schedule' && <ScheduleMakerPage refreshSchedules={loadSchedules} />}
          {currentPage === 'consent' && <ConsentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'vss' && <VssPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'deployment' && <DeploymentPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'alloc' && <DeploymentAllocationPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'centreLists' && <CentreListsPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'inchargeDashboard' && (sewaMode === SEWA_MODE_PREVISIT ? <PrevisitDashboard schedules={schedules} scheduleId={scheduleId} /> : <DeptInchargeDashboardPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />)}
          {currentPage === 'scanner' && <ScannerPage schedules={schedules} scheduleId={scheduleId} sewaMode={autoSewaMode} />}
          {currentPage === 'attendance' && (profile?.role === 'dept_incharge' ? <InchargeScannerPage schedules={schedules} scheduleId={scheduleId} sewaMode={autoSewaMode} /> : sewaMode === SEWA_MODE_PREVISIT ? <PrevisitView schedules={schedules} scheduleId={scheduleId} initialTab="present" /> : <AttendancePage schedules={schedules} scheduleId={scheduleId} />)}
          {currentPage === 'dashboard' && (sewaMode === SEWA_MODE_PREVISIT ? <PrevisitDashboard schedules={schedules} scheduleId={scheduleId} /> : <DashboardPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />)}
          {currentPage === 'reports' && (sewaMode === SEWA_MODE_PREVISIT ? <PrevisitView schedules={schedules} scheduleId={scheduleId} initialTab="total" /> : <ReportsPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} initialCentre={navFilter?.page === 'reports' ? navFilter?.centre : undefined} />)}
          {currentPage === 'liveScanners' && <LiveScannersPage schedules={schedules} scheduleId={scheduleId} />}
          {currentPage === 'anomalies' && (sewaMode === SEWA_MODE_PREVISIT ? <PrevisitView schedules={schedules} scheduleId={scheduleId} initialTab="attention" /> : <AnomaliesPage schedules={schedules} scheduleId={scheduleId} onNavigate={handleNavigate} />)}
          {currentPage === 'control' && <ControlPanelPage schedules={schedules} scheduleId={scheduleId} refreshSchedules={loadSchedules} />}
          {currentPage === 'users' && <UsersPage />}
        </Suspense>
      </main>

      {/* Mobile-only bottom navigation (see MobileTabBar). Desktop keeps .tab-nav. */}
      {isMobile && (
        <MobileTabBar
          items={mobileItems}
          currentPage={currentPage}
          onSelect={handleMobileSelect}
          onMore={() => setMoreOpen(true)}
        />
      )}
      <MoreSheet
        open={isMobile && moreOpen}
        items={mobileOverflow}
        sections={mobileSections}
        phaseHeader={availablePhases.length > 1 ? (
          <PhaseSwitch compact activePhase={activePhase} availablePhases={availablePhases} onChange={selectPhase} />
        ) : null}
        currentPage={currentPage}
        onSelect={handleMobileSelect}
        onClose={() => setMoreOpen(false)}
      />
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
