import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { deptInchargeKpis, timeAgo, VISIT_DAYS, UNASSIGNED_CENTRE } from '../lib/attendance'
import { todayStrIST } from '../lib/scannerUtils'
import { exportWorkbook, fileSlug } from '../lib/excel'
import {
  LayoutDashboard, Users, UserX, Percent, Clock, RefreshCw, Download,
  Loader2, Lock, Building2, ArrowUpRight,
} from 'lucide-react'
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

// Rate band → pill / bar class. Same maps the ASO dashboard uses, so a
// department that reads amber there reads amber here.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none
const BAND_BAR = { full: 'success', partial: '', low: 'warn', none: 'danger' }
const bandBar = (band) => (BAND_BAR[band] === '' ? '' : ` ${BAND_BAR[band] || ''}`.trim())

// A `<button className="stat">` reuses the existing tile skin while staying a
// real, focusable, keyboard-operable control.
const TILE = { appearance: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%' }

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
        background: '#10b981', boxShadow: '0 0 0 3px rgba(16,185,129,0.16)',
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
      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', background: '#fef2f2', border: '1px solid #fecaca' }}
    >
      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#b91c1c' }}>{label} unavailable</span>
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
  const [date, setDate] = useState(() => todayStrIST())
  const [dailyRaw, setDailyRaw] = useState([])
  const [visitRaw, setVisitRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [errs, setErrs] = useState({})
  // A13: which schedule the rows in state belong to. Rows from a previous
  // schedule must never be shown (or exported) under the new one.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  const [lastRefreshAt, setLastRefreshAt] = useState(null)

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
    const [daily, visit] = await Promise.allSettled([
      rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date }),
      rpcRows('attendance_visit_summary', { p_schedule: scheduleId }),
    ])
    if (!mountedRef.current || seq !== seqRef.current) return
    const next = {}
    if (daily.status === 'fulfilled') setDailyRaw(daily.value); else next.daily = daily.reason
    if (visit.status === 'fulfilled') setVisitRaw(visit.value); else next.visit = visit.reason
    setErrs(next)
    if (daily.status === 'fulfilled' || visit.status === 'fulfilled') {
      setRowsScheduleId(scheduleId)
      setLastRefreshAt(Date.now())
    }
    setLoading(false)
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

  const rowsAreCurrent = rowsScheduleId === scheduleId
  const kpis = useMemo(() => deptInchargeKpis(dailyRaw, visitRaw), [dailyRaw, visitRaw])

  // Centres contributing to the department — informational, never a scope.
  // An unresolved home centre is bucketed rather than dropped, so the count
  // matches the rows above it (every other page does the same via
  // UNASSIGNED_CENTRE in src/lib/attendance.js).
  const centreCount = useMemo(
    () => new Set((Array.isArray(dailyRaw) ? dailyRaw : []).map((r) => r?.centre || UNASSIGNED_CENTRE)).size,
    [dailyRaw]
  )

  const exportSnapshot = useCallback(async () => {
    setExporting(true)
    try {
      const n = await exportWorkbook(`${fileSlug(schedule?.name)}_incharge_${date}.xlsx`, [
        { name: 'Today', rows: [{ Metric: 'Deployed', Value: kpis.today.deployed }, { Metric: 'Present', Value: kpis.today.present }, { Metric: 'Absent', Value: kpis.today.absent }, { Metric: 'Open now', Value: kpis.today.openNow }, { Metric: 'Rate %', Value: kpis.today.rate }] },
        { name: 'Whole visit', rows: [{ Metric: 'Deployed', Value: kpis.visit.deployed }, { Metric: 'Ever present', Value: kpis.visit.present }, { Metric: 'Never present', Value: kpis.visit.absent }, { Metric: 'Rate %', Value: kpis.visit.rate }] },
        {
          name: 'By department',
          rows: kpis.byDepartment.map((d) => ({
            Department: d.deptName,
            'Deployed (today)': d.today.deployed,
            'Present (today)': d.today.present,
            'Absent (today)': d.today.absent,
            'Rate % (today)': d.today.rate,
            'Ever present (visit)': d.visit.present,
            'Never present (visit)': d.visit.absent,
          })),
        },
      ])
      if (n === 0) toast.error('Nothing to export for this schedule yet')
    } catch (e) {
      toast.error(e?.message || 'Could not export the snapshot')
    } finally {
      setExporting(false)
    }
  }, [schedule?.name, date, kpis, toast])

  if (loading && !rowsAreCurrent) {
    return (
      <div className="page" style={{ maxWidth: 1200 }}>
        <div className="card">
          <div className="empty">
            <div className="spin" style={{ width: 24, height: 24, border: '2px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin .6s linear infinite' }} />
            <div className="empty-text">Loading your department dashboard…</div>
          </div>
        </div>
      </div>
    )
  }

  const go = (target, payload) => onNavigate?.(target, payload)
  const noScope = rowsAreCurrent && kpis.today.deployed === 0 && kpis.visit.deployed === 0

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      {/* ── Header ── */}
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><LayoutDashboard size={22} /> Dashboard</h2>
          <div className="page-sub">Your department&rsquo;s attendance · {VISIT_DAYS.join(' · ')}</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" style={{ background: '#ecfdf5', color: '#047857', fontWeight: 600 }} title={lastRefreshAt ? `Last reload at ${new Date(lastRefreshAt).toLocaleTimeString('en-IN')}` : 'Not loaded yet'}>
              <LiveDot /> LIVE · updated {timeAgo(lastRefreshAt)}
            </span>
            <span className="pill pill-gray" title="Attendance is read-only here — scans are recorded on the Dept Incharge page" style={{ fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={exportSnapshot} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export snapshot
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
              onChange={(e) => { dateTouchedRef.current = true; setDate(e.target.value) }}
              className="input"
              style={{ fontSize: '0.82rem', padding: '0.25rem 0.4rem' }}
            />
          </div>
        </div>
      </div>

      {noScope && (
        <div role="status" className="card" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: '0.85rem', fontWeight: 600, marginBottom: '1rem' }}>
          No department is assigned to this login for the selected schedule, so there is nothing to show. Ask the ASO office to assign your department from the Users page.
        </div>
      )}

      {/* ── Today (the point-in-time present/absent tiles) ── */}
      {errs.daily ? (
        <SectionError label="Today’s attendance" error={errs.daily} onRetry={load} />
      ) : (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <button type="button" onClick={() => go('deptIncharge')} className="stat" style={TILE} title="Open the Dept Incharge lists">
            <div className="stat-label">Total deployed</div>
            <div className="stat-value">{kpis.today.deployed}</div>
            <div className="stat-sub">in your department{centreCount > 0 ? ` · ${centreCount} centre${centreCount === 1 ? '' : 's'}` : ''}</div>
          </button>
          <button type="button" onClick={() => go('deptIncharge')} className="stat" style={TILE} title="Open the Dept Incharge lists">
            <div className="stat-label">Present today</div>
            <div className="stat-value" style={{ color: '#047857' }}>{kpis.today.present}</div>
            <div className="stat-sub">of {kpis.today.deployed} deployed</div>
          </button>
          <button type="button" onClick={() => go('deptIncharge')} className="stat" style={TILE} title="Open the Dept Incharge lists">
            <div className="stat-label">Absent today</div>
            <div className="stat-value" style={{ color: kpis.today.absent > 0 ? '#b91c1c' : undefined }}>{kpis.today.absent}</div>
            <div className="stat-sub">expected but not scanned</div>
          </button>
          <button type="button" onClick={() => go('deptIncharge')} className="stat" style={TILE} title="Open the Dept Incharge lists">
            <div className="stat-label">Attendance %</div>
            <div className="stat-value" style={{ fontSize: '1.1rem', paddingTop: '0.35rem' }}>
              <div className="progress" style={{ height: 10 }}>
                <div className={`progress-bar${bandBar(kpis.today.band)}`} style={{ width: `${kpis.today.rate}%` }} />
              </div>
            </div>
            <div className="stat-sub">{kpis.today.rate}% present today</div>
          </button>
          <div className="stat" title="Sessions still open right now">
            <div className="stat-label">Open now</div>
            <div className="stat-value" style={{ color: kpis.today.openNow > 0 ? '#b45309' : undefined }}>{kpis.today.openNow}</div>
            <div className="stat-sub">scanned in, not out</div>
          </div>
        </div>
      )}

      {/* ── Whole visit ── */}
      {errs.visit ? (
        <div style={{ marginTop: '1rem' }}><SectionError label="Whole-visit attendance" error={errs.visit} onRetry={load} /></div>
      ) : (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginTop: '1rem' }}>
          <div className="stat">
            <div className="stat-label">Ever present (visit)</div>
            <div className="stat-value" style={{ color: '#047857' }}>{kpis.visit.present}</div>
            <div className="stat-sub">scanned at least once</div>
          </div>
          <div className="stat">
            <div className="stat-label">Never present (visit)</div>
            <div className="stat-value" style={{ color: kpis.visit.absent > 0 ? '#b91c1c' : undefined }}>{kpis.visit.absent}</div>
            <div className="stat-sub">no scan all visit</div>
          </div>
          <div className="stat">
            <div className="stat-label">Visit coverage</div>
            <div className="stat-value" style={{ fontSize: '1.1rem', paddingTop: '0.35rem' }}>
              <div className="progress" style={{ height: 10 }}>
                <div className={`progress-bar${bandBar(kpis.visit.band)}`} style={{ width: `${kpis.visit.rate}%` }} />
              </div>
            </div>
            <div className="stat-sub">{kpis.visit.rate}% of {kpis.visit.deployed} deployed</div>
          </div>
        </div>
      )}

      {/* ── Per-department breakdown ── */}
      {!errs.daily && !noScope && kpis.byDepartment.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-header" style={{ padding: '1.1rem 1.25rem 0' }}>
            <div>
              <div className="section-title"><Building2 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> By department</div>
              <div className="card-sub">Totals across every centre where these sewadars are deployed</div>
            </div>
          </div>
          <div className="table-wrap" style={{ padding: '0 1.25rem 1.25rem' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Deployed</th>
                  <th>Present today</th>
                  <th>Absent today</th>
                  <th>Today %</th>
                  <th>Ever present (visit)</th>
                  <th>Never present</th>
                </tr>
              </thead>
              <tbody>
                {kpis.byDepartment.map((d) => (
                  <tr key={d.department_id}>
                    <td><span className="pill pill-blue">{d.deptName}</span></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.today.deployed || d.visit.deployed}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.today.present}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: d.today.absent > 0 ? '#b91c1c' : undefined }}>{d.today.absent}</td>
                    <td><span className={`pill ${bandPill(d.today.band)}`}>{d.today.rate}%</span></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.visit.present}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.visit.absent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: '1rem', fontSize: '0.78rem', color: '#64748b' }}>
        <Clock size={12} style={{ verticalAlign: '-1px', marginRight: '0.2rem' }} />
        Present/absent reflects scans for the selected day. &ldquo;Ever present&rdquo; covers the whole visit. Scans are recorded on the{' '}
        <button onClick={() => go('deptIncharge')} className="btn btn-ghost" style={{ padding: '0 0.2rem', fontSize: '0.78rem' }}>Dept Incharge <ArrowUpRight size={11} /></button> page.
      </div>
    </div>
  )
}
