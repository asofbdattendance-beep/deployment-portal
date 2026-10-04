import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, fetchAllRpc } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { deptInchargeKpis, timeAgo, VISIT_DAYS, UNASSIGNED_CENTRE, visitColumns, buildAttendanceMatrixFromDayBadges, shortDayLabel } from '../lib/attendance'
import { scheduleWindow, expandDateRange, clampDateToWindow } from '../lib/sewaMode'
import { todayStrIST } from '../lib/scannerUtils'
import { fileSlug } from '../lib/excel'
import { exportAttendanceWorkbook, buildAttendanceBlob } from '../lib/attendanceExcel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useExport } from '../hooks/useExport'
import ExportSheet from '../components/mobile/ExportSheet'
import PrintPdfButton from '../components/PrintPdfButton'
import FilterSheet, { MobileFilterBar } from '../components/mobile/FilterSheet'
import AttendanceMatrix from '../components/AttendanceMatrix'
import {
  LayoutDashboard, Clock, RefreshCw, Download,
  Loader2, ArrowUpRight, Search,
} from 'lucide-react'
import PageHeader, { ViewOnlyPill } from '../components/PageHeader'
import KpiTile from '../components/KpiTile'
import { reportRealtimeStatus } from '../lib/realtime'

/**
 * Unwrap a supabase-js PostgREST result into rows, THROWING on a returned
 * error. supabase-js resolves with `{ error }` rather than rejecting, so a
 * `.catch(() => [])` chain would turn "function does not exist" (PGRST202),
 * an RLS denial or a dropped connection into a clean empty dashboard that looks
 * exactly like a visit with no scans. Same helper the other analytics pages
 * keep locally — see DashboardPage.jsx:56.
 *
 * @param {string} name RPC name
 * @param {object} params RPC arguments
 * @returns {Promise<Array<object>>}
 */
async function rpcRows(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const msg = error.message || error.code || 'Unknown error'
    throw new Error(`${name}: ${msg}`)
  }
  return Array.isArray(data) ? data : []
}

// Rate band → bar class. Same map the ASO dashboard uses, so a
// department that reads amber there reads amber here.
const BAND_BAR = { full: 'success', partial: '', low: 'warn', none: 'danger' }
const bandBar = (band) => (BAND_BAR[band] === '' ? '' : ` ${BAND_BAR[band] || ''}`.trim())

// The shared KpiTile now carries the tile contract (extracted from this
// page's TILE) — see src/components/KpiTile.jsx.

/** The live "updated Ns ago" dot — opacity toggle, no new keyframes. */
function LiveDot() {
  const [lit, setLit] = useState(true)
  useEffect(() => {
    const t = setInterval(() => setLit((v) => !v), 1600)
    return () => clearInterval(t)
  }, [])
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
        background: 'var(--success)', boxShadow: '0 0 0 3px var(--success-soft)',
        opacity: lit ? 1 : 0.3, transition: 'opacity 0.6s ease-in-out',
      }}
    />
  )
}

/** One failed RPC blanks ONE panel; the page, header and other tiles stay live. */
function SectionError({ label, error, onRetry }) {
  return (
    <div
      role="alert"
      className="card"
      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', background: 'var(--danger-soft)', border: '1px solid #fecaca' }}
    >
      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--err)' }}>{label} unavailable</span>
      <span style={{ fontSize: '0.78rem', color: '#7f1d1d' }}>{error?.message || 'Could not be read.'}</span>
      <button onClick={onRetry} className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '0.2rem 0.5rem', fontSize: '0.74rem' }}>
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  )
}

/**
 * Dashboard — the landing tab for a `dept_incharge` (v51).
 *
 * SCOPE IS ENFORCED SERVER-SIDE. Since v51 a dept_incharge is scoped by the
 * DEPARTMENT, across EVERY centre, so this page renders exactly what the RPCs
 * return and never filters by role itself: `attendance_scope_centres` hands
 * them every centre and `attendance_allowed_depts` narrows to the departments
 * granted by `get_my_dept_ids`. A role with no grant receives zero rows
 * (fail-closed). Do NOT add a client-side centre/role filter — it would only
 * mask a DB scope bug.
 *
 * Two distinct counts, deliberately kept apart: `today` is a point-in-time
 * present/absent against deployed sewadars, `visit` is "ever scanned during
 * the visit". `deptInchargeKpis` folds both out of the two RPC shapes.
 */
export default function DeptInchargeDashboardPage({ schedules = [], scheduleId, onNavigate }) {
  const toast = useToast()
  const schedule = schedules.find((s) => s.id === scheduleId)
  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  // Bhati Visit shows visit-days data only: pin the picker inside the
  // window (windowless schedules pass through untouched).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])
  const [dailyRaw, setDailyRaw] = useState([])
  const [visitRaw, setVisitRaw] = useState([])
  // Matrix arms: the per-date present/absent-badge lists behind the
  // Badge × day grid. (The visit trend is still fetched so a failed trend
  // keeps its explicit error state, but its rows never become columns —
  // columns are the schedule window only.)
  const [badgesByDate, setBadgesByDate] = useState({})
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [errs, setErrs] = useState({})
  // A13: which schedule AND date the rows in state belong to. Rows from a
  // previous schedule — or a previous scan day — must never be shown (or
  // exported) under the new one. Stamped whenever at least one arm lands, so a
  // half-failed load still owns its date instead of reading as another day.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const [rowsDate, setRowsDate] = useState(null)
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  const [lastRefreshAt, setLastRefreshAt] = useState(null)
  // Ticks once a minute so the LIVE "updated Ns ago" pill advances without an
  // RPC — freshness is a function of the clock, not of the data.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // Re-sync "today" across an IST midnight and on window focus, but never
  // overwrite a day the incharge picked by hand.
  const dateTouchedRef = useRef(false)
  useEffect(() => {
    const sync = () => {
      if (dateTouchedRef.current) return
      const t = todayStrIST()
      setDate((d) => (d === t ? d : t))
    }
    sync()
    const onFocus = () => sync()
    window.addEventListener('focus', onFocus)
    const id = setInterval(sync, 30000)
    return () => { window.removeEventListener('focus', onFocus); clearInterval(id) }
  }, [])

  const load = useCallback(async () => {
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    const [daily, visit, trend] = await Promise.allSettled([
      rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date }),
      rpcRows('attendance_visit_summary', { p_schedule: scheduleId }),
      rpcRows('attendance_trend', { p_schedule: scheduleId }),
    ])
    if (!mountedRef.current || seq !== seqRef.current) return
    const next = {}
    if (daily.status === 'fulfilled') setDailyRaw(daily.value); else next.daily = daily.reason
    if (visit.status === 'fulfilled') setVisitRaw(visit.value); else next.visit = visit.reason
    if (trend.status !== 'fulfilled') next.trend = trend.reason
    // The present/absent-badge lists fan out over the visit columns, which
    // are EXACTLY the schedule's visit window — trend rows never add one,
    // so a previsit scan can never grow a Bhati Visit day. Without a window
    // there are no visit days to fetch (Previsit owns every scan date).
    if (trend.status === 'fulfilled') {
      const win = scheduleWindow((schedules || []).find((s) => s.id === scheduleId))
      const cols = visitColumns(expandDateRange(win.start, win.end))
      if (cols.length === 0) {
        setBadgesByDate({})
      } else {
        const settled = await Promise.allSettled(
          cols.flatMap((col) => [
            // per-badge rows → paginated (complete matrix + Excel snapshot)
            fetchAllRpc('attendance_day_badges', { p_schedule: scheduleId, p_date: col, p_mode: 'present' }),
            fetchAllRpc('attendance_day_badges', { p_schedule: scheduleId, p_date: col, p_mode: 'absent' }),
          ])
        )
        if (!mountedRef.current || seq !== seqRef.current) return
        const failed = settled.find((s) => s.status === 'rejected')
        if (failed) {
          next.badges = failed.reason
          setBadgesByDate({})
        } else {
          const map = {}
          cols.forEach((col, i) => {
            const present = settled[2 * i].status === 'fulfilled' ? settled[2 * i].value : []
            const absent = settled[2 * i + 1].status === 'fulfilled' ? settled[2 * i + 1].value : []
            map[col] = { present, absent }
          })
          setBadgesByDate(map)
        }
      }
    } else {
      setBadgesByDate({})
    }
    setErrs(next)
    if (daily.status === 'fulfilled' || visit.status === 'fulfilled' || trend.status === 'fulfilled') {
      setRowsScheduleId(scheduleId)
      setRowsDate(date)
      setLastRefreshAt(Date.now())
    }
    setLoading(false)
  }, [schedules, scheduleId, date])

  // A schedule or scan-day change invalidates the rows on screen until the new
  // load lands — the previous day's tiles must never read as this day's.
  useEffect(() => {
    setRowsScheduleId((cur) => (cur === scheduleId ? cur : null))
    setRowsDate((cur) => (cur === date ? cur : null))
  }, [scheduleId, date])

  // The mount flag is re-asserted HERE, in the same effect that loads. A
  // cleanup-only `useEffect(() => () => { mountedRef.current = false }, [])`
  // leaves the flag false forever under React.StrictMode (main.jsx), which
  // double-invokes effects: the first cleanup runs, the second body never
  // restores it, and `load()` bails at its `!mountedRef.current` guard BEFORE
  // `setLoading(false)` — an infinite "Loading your department dashboard…".
  // Same shape as AttendancePage.jsx / DashboardPage.jsx.
  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // Realtime: keep the live "present now" counts honest without polling.
  // DEBOUNCED at 400ms, matching DashboardPage.jsx:241-251. Scanning writes a
  // row per IN and per OUT, so an undebounced handler fires `load()` — two
  // aggregate RPCs — once per event; during a busy bhati that is a continuous
  // stampede of identical queries and the page feels like it is permanently
  // 1-2 s behind. Coalescing keeps the numbers live at a fraction of the cost.
  useEffect(() => {
    if (!scheduleId) return
    let alive = true
    let timer = null
    const reload = () => {
      if (!alive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (alive) load().catch(() => {}) }, 400)
    }
    const ch = supabase
      .channel(`incharge-dash-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // a row becoming deployed moves the denominator behind every tile
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, reload)
      .subscribe((status) => {
        reportRealtimeStatus('incharge-dashboard', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); try { supabase.removeChannel(ch) } catch { /* already torn down */ } }
  }, [scheduleId, load])

  const rowsAreCurrent = rowsScheduleId === scheduleId && rowsDate === date
  // Until the load for THIS schedule and scan day lands there are no rows —
  // the previous day's tiles must never read as this day's.
  const kpis = useMemo(
    () => deptInchargeKpis(rowsAreCurrent ? dailyRaw : [], rowsAreCurrent ? visitRaw : []),
    [dailyRaw, visitRaw, rowsAreCurrent]
  )

  // Centres contributing to the department — informational, never a scope.
  // An unresolved home centre is bucketed rather than dropped, so the count
  // matches the rows above it (every other page does the same via
  // UNASSIGNED_CENTRE in src/lib/attendance.js).
  const centreCount = useMemo(
    () => new Set((rowsAreCurrent && Array.isArray(dailyRaw) ? dailyRaw : []).map((r) => r?.centre || UNASSIGNED_CENTRE)).size,
    [dailyRaw, rowsAreCurrent]
  )

  // ── Attendance matrix ──
  // Identity is the union of badges across the per-date present + absent
  // lists (see buildAttendanceMatrixFromDayBadges), so deployed-never-scanned
  // sewadars are listed, and presence is keyed by badge only — centres are
  // never compared. The columns are EXACTLY the schedule's visit window:
  // trend rows never contribute a column (hard rule — a previsit scan must
  // never appear in Bhati Visit). No window ⇒ no columns (see noWindow).
  const windowDates = useMemo(() => expandDateRange(visitWin.start, visitWin.end), [visitWin])
  const noWindow = windowDates.length === 0
  const matrixColumns = useMemo(
    () => visitColumns(windowDates),
    [windowDates]
  )
  const dayBadges = useMemo(
    () => (rowsAreCurrent ? badgesByDate : {}),
    [badgesByDate, rowsAreCurrent]
  )
  const matrix = useMemo(
    () => buildAttendanceMatrixFromDayBadges(dayBadges, matrixColumns),
    [dayBadges, matrixColumns]
  )
  // The grid needs BOTH arms: columns without presence (or presence without
  // columns) would print absences that are really a failed RPC.
  const matrixReady = rowsAreCurrent && !errs.trend && !errs.badges

  // ── Matrix view filters (search + centre) ──
  // Lifted to the page (not inside AttendanceMatrix) so the Excel snapshot
  // below exports exactly the rows on screen — the same contract the Dept
  // Incharge list page keeps (`exportList` reads `filteredList`).
  const [matrixQuery, setMatrixQuery] = useState('')
  const [matrixCentre, setMatrixCentre] = useState('')
  // A new schedule brings a new centre list — a stale selection would read
  // as "no sewadars" for a reason that does not exist.
  useEffect(() => {
    setMatrixQuery('')
    setMatrixCentre('')
  }, [scheduleId])
  const matrixCentreOptions = useMemo(
    () => [...new Set(matrix.rows.map((r) => r?.centre).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [matrix]
  )
  useEffect(() => {
    if (matrixCentre && !matrixCentreOptions.includes(matrixCentre)) setMatrixCentre('')
  }, [matrixCentre, matrixCentreOptions])
  const matrixForView = useMemo(() => {
    const q = matrixQuery.trim().toLowerCase()
    const rows = matrix.rows.filter((r) => {
      if (matrixCentre && r.centre !== matrixCentre) return false
      if (!q) return true
      return [r.badge_number, r.sewadar_name, r.centre, r.dept_name]
        .some((v) => String(v || '').toLowerCase().includes(q))
    })
    return { columns: matrix.columns, rows }
  }, [matrix, matrixCentre, matrixQuery])
  const matrixFiltersActive = matrixQuery.trim() !== '' || matrixCentre !== ''
  const [matrixFiltersOpen, setMatrixFiltersOpen] = useState(false)
  const clearMatrixFilters = () => { setMatrixQuery(''); setMatrixCentre('') }
  const matrixChips = useMemo(() => {
    const chips = []
    if (matrixQuery.trim()) chips.push({ key: 'q', label: `"${matrixQuery.trim()}"` })
    if (matrixCentre) chips.push({ key: 'centre', label: matrixCentre })
    return chips
  }, [matrixQuery, matrixCentre])
  const clearMatrixChip = (key) => {
    if (key === 'q') setMatrixQuery('')
    else if (key === 'centre') setMatrixCentre('')
  }
  // The two matrix controls, shared by the desktop toolbar and the phone
  // sheet (same state, same handlers, two presentations).
  const matrixFiltersNode = (<>
    <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 0 }}>
      <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <input
        value={matrixQuery}
        onChange={(e) => setMatrixQuery(e.target.value)}
        placeholder="Search badge / name / centre / dept..."
        className="input"
        style={{ width: '100%', paddingLeft: 30 }}
        aria-label="Search attendance matrix"
      />
    </div>
    <select
      value={matrixCentre}
      onChange={(e) => setMatrixCentre(e.target.value)}
      className="select"
      style={{ width: '100%' }}
      aria-label="Filter matrix by centre"
    >
      <option value="">All centres ({matrixCentreOptions.length})</option>
      {matrixCentreOptions.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  </>)

  const exportFilename = `${fileSlug(schedule?.name)}_incharge_${date}.xlsx`

  // Mobile export delivery (share sheet + save fallback). Desktop keeps the
  // direct download inside exportSnapshot below.
  const isMobile = useIsMobile()
  const mobileExport = useExport()
  const [exportSheetOpen, setExportSheetOpen] = useState(false)
  const onExportPress = useCallback(async () => {
    setExportSheetOpen(true)
    await mobileExport.prepare(async () => {
      const { blob, sheetsWritten } = await buildAttendanceBlob({
        scheduleName: schedule?.name || '',
        date,
        kpis,
        matrix: matrixForView,
      })
      if (!sheetsWritten) return null
      return { blob, filename: exportFilename }
    })
  }, [mobileExport, schedule?.name, date, kpis, matrixForView, exportFilename])

  const exportSnapshot = useCallback(async () => {
    // A snapshot over a half-failed load would print one half's numbers as
    // the whole truth — every arm must have landed.
    if (errs.daily || errs.visit || errs.trend || errs.badges) {
      toast.warning('One half of the snapshot failed to load — retry before exporting')
      return
    }
    // Mobile: same workbook, delivered through the share sheet.
    if (isMobile) { await onExportPress(); return }
    setExporting(true)
    try {
      // Styled workbook (lazy exceljs): same sheets and P/A contract as the
      // old xlsx export, plus title row, frozen header, widths and green/red
      // day cells on the Attd Matrix sheet — see src/lib/attendanceExcel.js.
      const n = await exportAttendanceWorkbook({
        filename: exportFilename,
        scheduleName: schedule?.name || '',
        date,
        kpis,
        matrix: matrixForView,
      })
      if (n === 0) toast.error('Nothing to export for this schedule yet')
    } catch (e) {
      toast.error(e?.message || 'Could not export the snapshot')
    } finally {
      setExporting(false)
    }
  }, [schedule?.name, date, kpis, matrixForView, errs, toast, isMobile, onExportPress, exportFilename])

  if (loading && !rowsAreCurrent) {
    return (
      <div className="page" style={{ maxWidth: 1200 }}>
        <div className="card">
          <div className="empty">
            <div className="spin" style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin .6s linear infinite' }} />
            <div className="empty-text">Loading your department dashboard…</div>
          </div>
        </div>
      </div>
    )
  }

  const go = (target, payload) => onNavigate?.(target, payload)
  // "No department assigned" requires BOTH arms to have actually answered:
  // a failed visit RPC leaves visitRaw empty, which would otherwise read as
  // zero deployed and blame the login instead of the outage.
  const noScope = rowsAreCurrent && !errs.daily && !errs.visit && kpis.today.deployed === 0 && kpis.visit.deployed === 0

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      {/* ── Header ── */}
      <PageHeader
        icon={<LayoutDashboard size={22} />}
        title="Dashboard"
        sub={<>Your department&rsquo;s attendance · {VISIT_DAYS.join(' · ')}</>}
        pills={(
          <>
            <span className="pill" style={{ background: 'var(--success-soft)', color: '#047857', fontWeight: 600 }} title={lastRefreshAt ? `Last reload at ${new Date(lastRefreshAt).toLocaleTimeString('en-IN')}` : 'Not loaded yet'}>
              <LiveDot /> LIVE · updated {timeAgo(lastRefreshAt, now)}
            </span>
            <ViewOnlyPill title="Attendance is read-only here — scans are recorded on the Dept Incharge page" />
          </>
        )}
        actions={(
          <>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={exportSnapshot} disabled={exporting || mobileExport.building || !rowsAreCurrent || noWindow || errs.daily || errs.visit || errs.trend || errs.badges} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting || mobileExport.building ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export Attd Matrix
            </button>
            <PrintPdfButton className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }} />
          </>
        )}
        aside={(
          <>
            <div>
              <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Schedule</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>
                {schedule?.name || '—'}{' '}
                <span className={`pill ${schedule?.status === 'done' ? 'pill-gray' : 'pill-green'}`} style={{ marginLeft: '0.25rem' }}>
                  {schedule?.status === 'done' ? 'Done' : 'Open'}
                </span>
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Scan day (IST)</div>
              <input
                type="date"
                value={date}
                min={visitWin.start || undefined}
                max={visitWin.end || undefined}
                onChange={(e) => { dateTouchedRef.current = true; setDate(clampDateToWindow(e.target.value, visitWin)) }}
                className="input"
                aria-label="Scan day"
                style={{ minHeight: 44 }}
              />
            </div>
          </>
        )}
      />

      {noScope && (
        <div role="status" className="card" style={{ background: 'var(--warning-soft)', border: '1px solid #fde68a', color: '#92400e', fontSize: '0.85rem', fontWeight: 600, marginBottom: '1rem' }}>
          No department is assigned to this login for the selected schedule, so there is nothing to show. Ask the ASO office to assign your department from the Users page.
        </div>
      )}

      {/* ── Today (the point-in-time present/absent tiles) ── */}
      {errs.daily ? (
        <SectionError label="Today’s attendance" error={errs.daily} onRetry={load} />
      ) : (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <KpiTile
            label="Total deployed"
            value={kpis.today.deployed}
            sub={`in your department${centreCount > 0 ? ` · ${centreCount} centre${centreCount === 1 ? '' : 's'}` : ''} · ${shortDayLabel(date)}`}
            onPress={() => go('reports')}
            title="Open the Dept Incharge lists"
          />
          <KpiTile
            label="Present today"
            value={kpis.today.present}
            tone="#047857"
            sub={`of ${kpis.today.deployed} deployed · ${shortDayLabel(date)}`}
            onPress={() => go('reports')}
            title="Open the Dept Incharge lists"
          />
          <KpiTile
            label="Absent today"
            value={kpis.today.absent}
            tone={kpis.today.absent > 0 ? 'var(--err)' : undefined}
            sub={`expected but not scanned · ${shortDayLabel(date)}`}
            onPress={() => go('reports')}
            title="Open the Dept Incharge lists"
          />
          <KpiTile
            label="Attendance %"
            value={(
              <div style={{ paddingTop: '0.35rem' }}>
                <div className="progress" style={{ height: 10 }}>
                  <div className={`progress-bar${bandBar(kpis.today.band)}`} style={{ width: `${kpis.today.rate}%` }} />
                </div>
              </div>
            )}
            sub={`${kpis.today.rate}% present on ${shortDayLabel(date)}`}
            onPress={() => go('reports')}
            title="Open the Dept Incharge lists"
          />
          <KpiTile
            label="Open now"
            value={kpis.today.openNow}
            tone={kpis.today.openNow > 0 ? '#b45309' : undefined}
            sub="scanned in, not out"
            title="Sessions still open right now"
          />
        </div>
      )}

      {/* ── Whole visit ── */}
      {errs.visit ? (
        <div style={{ marginTop: '1rem' }}><SectionError label="Whole-visit attendance" error={errs.visit} onRetry={load} /></div>
      ) : (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginTop: '1rem' }}>
          <KpiTile
            label="Ever present (visit)"
            value={kpis.visit.present}
            tone="#047857"
            sub="scanned at least once"
          />
          <KpiTile
            label="Never present (visit)"
            value={kpis.visit.absent}
            tone={kpis.visit.absent > 0 ? 'var(--err)' : undefined}
            sub="no scan all visit"
          />
          <KpiTile
            label="Visit coverage"
            value={(
              <div style={{ paddingTop: '0.35rem' }}>
                <div className="progress" style={{ height: 10 }}>
                  <div className={`progress-bar${bandBar(kpis.visit.band)}`} style={{ width: `${kpis.visit.rate}%` }} />
                </div>
              </div>
            )}
            sub={`${kpis.visit.rate}% of ${kpis.visit.deployed} deployed`}
          />
        </div>
      )}

      {/* ── Attendance matrix ── */}
      {(errs.trend || errs.badges) ? (
        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {errs.trend && <SectionError label="Attendance matrix (trend)" error={errs.trend} onRetry={load} />}
          {errs.badges && <SectionError label="Attendance matrix (daily presence)" error={errs.badges} onRetry={load} />}
        </div>
      ) : (!noScope && matrixReady && noWindow) ? (
        <div role="status" className="card" style={{ marginTop: '1rem', background: 'var(--warning-soft)', border: '1px solid #fde68a', color: '#92400e', fontSize: '0.85rem', fontWeight: 600, padding: '1rem 1.25rem' }}>
          No visit dates are set for this schedule, so there is no Bhati Visit attendance to show. Ask the ASO office to set the visit window on Schedule Maker — every scan date shows under Previsit until then.
        </div>
      ) : (!noScope && matrixReady && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-header" style={{ padding: '1.1rem 1.25rem 0' }}>
            <div>
              <div className="section-title">Attendance matrix</div>
              <div className="card-sub">Badge × day — green present, red absent</div>
            </div>
          </div>
          {isMobile && (
            <div style={{ padding: '0.75rem 1.25rem 0' }}>
              <MobileFilterBar
                onOpen={() => setMatrixFiltersOpen(true)}
                chips={matrixChips}
                onClearChip={clearMatrixChip}
                onClearAll={clearMatrixFilters}
                resultText={`${matrixForView.rows.length} of ${matrix.rows.length} sewadars`}
                activeCount={matrixChips.length}
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.75rem 1.25rem 0' }}>
            {!isMobile && matrixFiltersNode}
            <span role="status" className="matrix-count">
              {matrixForView.rows.length} of {matrix.rows.length} sewadars
            </span>
            {matrixFiltersActive && !isMobile && (
              <button onClick={clearMatrixFilters} className="btn btn-ghost" style={{ fontSize: '0.75rem' }}>
                Clear
              </button>
            )}
          </div>
          <div style={{ padding: '0 1.25rem 1.25rem' }}>
            {matrixForView.rows.length === 0 && matrix.rows.length > 0 ? (
              <div className="att-matrix">
                <div className="att-empty">No sewadars match this search or filter.</div>
              </div>
            ) : (
              <AttendanceMatrix columns={matrixForView.columns} rows={matrixForView.rows} highlightDate={date} />
            )}
          </div>
        </div>
      ))}

      <div style={{ marginTop: '1rem', fontSize: '0.78rem', color: 'var(--text-sec)' }}>
        <Clock size={12} style={{ verticalAlign: '-1px', marginRight: '0.2rem' }} />
        Present/absent reflects scans for the selected day. &ldquo;Ever present&rdquo; covers the whole visit. Scans are recorded on the{' '}
        <button onClick={() => go('reports')} className="btn btn-ghost" style={{ padding: '0 0.2rem', fontSize: '0.78rem' }}>Reports <ArrowUpRight size={11} /></button> page.
      </div>

      <FilterSheet
        open={isMobile && matrixFiltersOpen}
        onClose={() => setMatrixFiltersOpen(false)}
        title="Matrix filters"
        resultText={`${matrixForView.rows.length} of ${matrix.rows.length} sewadars`}
        onClearAll={clearMatrixFilters}
        hasActive={matrixChips.length > 0}
      >
        {matrixFiltersNode}
      </FilterSheet>

      <ExportSheet
        open={isMobile && exportSheetOpen}
        onClose={() => { setExportSheetOpen(false); mobileExport.reset() }}
        filename={exportFilename}
        file={mobileExport.file?.blob || null}
        building={mobileExport.building}
        buildError={mobileExport.buildError}
        delivering={mobileExport.delivering}
        deliveredVia={mobileExport.deliveredVia}
        onDeliver={mobileExport.deliver}
        onRetry={onExportPress}
      />
    </div>
  )
}
