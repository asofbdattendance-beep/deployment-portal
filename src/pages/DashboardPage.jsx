import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import {
  buildDailyRows,
  buildScannerRows,
  anomalyCounts,
  dailyTotals,
  scannerStatus,
  timeAgo,
  rateBand,
  UNASSIGNED_CENTRE,
  VISIT_DAYS,
  shortDayLabel,
} from '../lib/attendance'
import { todayStrIST, withTimeout } from '../lib/scannerUtils'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import PageHeader, { ViewOnlyPill } from '../components/PageHeader'
import KpiTile from '../components/KpiTile'
import EmptyState from '../components/EmptyState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  LayoutDashboard, Users, Clock, AlertTriangle, ArrowUpRight,
  CalendarClock, RefreshCw, Loader2,
} from 'lucide-react'

// Trend bars reuse the `.progress-bar` modifiers rather than a chart library.
const BAND_BAR = { full: 'success', partial: '', low: 'warn', none: 'danger' }
const bandBar = (band) => (BAND_BAR[band] === '' ? '' : ` ${BAND_BAR[band] || ''}`.trim())

/**
 * Unwrap a supabase-js PostgREST result into rows, THROWING on a returned
 * error. supabase-js resolves with `{ error }` rather than rejecting, so a
 * `.catch(() => [])` chain would turn "function does not exist" (PGRST202),
 * an RLS denial or a dropped connection into a clean empty dashboard that looks
 * exactly like a visit with no scans.
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

/**
 * The LIVE dot. A pulse without a new @keyframes rule: opacity is toggled on a
 * 1.6s interval and CSS-transitioned, which is a real fade cycle and costs the
 * stylesheet nothing. Pure opacity, so there is no motion-sickness surface.
 */
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

/** '6h 12m' / '42m' — a compact left-until label for the deadline alert. */
function msLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** scanner_ops.last_scan_time is a bare IST wall clock for the queried date. */
function scanEpoch(lastScanTime, dateStr) {
  if (!lastScanTime || !dateStr) return NaN
  return Date.parse(`${dateStr}T${lastScanTime}+05:30`)
}

/**
 * Dashboard — the aso / super_admin landing tab.
 *
 * THIN LAUNCHER (Phase 4): KPI tiles + alerts only. Every tile navigates to
 * its single-owner detail page (Reports / Attendance / Anomalies) — the
 * department snapshot, centre × department matrix, leaderboard, scanner
 * feed, trend strip and snapshot export that used to re-render those pages
 * here are gone. Three RPCs (daily, ops, anomalies) feed the tiles; the
 * visit summary and trend feeds are no longer fetched.
 *
 * Status, above the fold, and nothing to fill in. Every figure comes from the
 * v45 read-only RPCs; the page never reads a table directly and never writes.
 *
 * SCOPE IS ENFORCED SERVER-SIDE (v39's `attendance_scope_centres` /
 * `attendance_allowed_depts` run inside each function), so this page renders
 * exactly what the RPCs return and does NOT filter by role — a client-side gate
 * would only mask a DB scope bug. See the AttendancePage header note.
 *
 * The RPCs here return HOME centres (`deployments.centre` / `sewadar_centre`).
 * The physical scan venue is informational and is never a scope or reporting
 * key — see CONTEXT.md v40. Nothing on this page reads it.
 */
export default function DashboardPage({ schedules = [], scheduleId, onNavigate }) {
  const schedule = schedules.find((s) => s.id === scheduleId)

  // The dashboard has no date picker: it always reports TODAY (IST). Re-sync on
  // mount and on window focus so a tab left open across IST midnight stops
  // reporting yesterday without a manual refresh.
  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [lastRefreshAt, setLastRefreshAt] = useState(null)
  // One slot per section, so a rejected RPC degrades in place.
  const [sec, setSec] = useState({
    daily: { rows: [], error: null },
    ops: { rows: [], error: null },
    anom: { rows: [], error: null },
  })
  // Which schedule the rows in state belong to. Rows from the previous schedule
  // must never be shown (or exported) under the new one's name.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load must not
  // overwrite a fast newer one.
  const seqRef = useRef(0)

  // Bhati Visit shows visit-days data only: the dashboard always reports
  // a clamped today (windowless schedules pass through untouched).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  const winRef = useRef(visitWin)
  winRef.current = visitWin
  useEffect(() => {
    const sync = () => setDate((d) => {
      const today = clampDateToWindow(todayStrIST(), winRef.current)
      return d === today ? d : today
    })
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])

  // The "updated Ns ago" label only needs second resolution, not a re-render
  // per second.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  // ─── Load. One Promise.allSettled over the three RPCs. ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      // Every RPC is wrapped in withTimeout: a hung function must surface a
      // friendly section error, never latch the page on its spinner forever.
      const results = await Promise.allSettled([
        withTimeout(rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_daily_summary'),
        withTimeout(rpcRows('attendance_scanner_ops', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_scanner_ops'),
        // p_date: null → the visit-wide anomaly sweep, not one day.
        withTimeout(rpcRows('attendance_anomalies', { p_schedule: scheduleId, p_date: null }), 15000, 'attendance_anomalies'),
      ])
      if (!mountedRef.current || seq !== seqRef.current) return
      const next = {}
      ;['daily', 'ops', 'anom'].forEach((key, i) => {
        const r = results[i]
        if (r.status === 'fulfilled') {
          next[key] = { rows: r.value, error: null }
        } else {
          // The backend text (function names, PGRST202) is logged, never shown.
          console.error(`[Dashboard] ${key} RPC failed:`, r.reason)
          next[key] = { rows: [], error: r.reason?.message || 'Unknown error' }
        }
      })
      setSec(next)
      setRowsScheduleId(scheduleId)
      // No silent freshness: the LIVE pill only advances when at least one
      // source actually answered — three rejections leave the old timestamp.
      if (results.some((r) => r.status === 'fulfilled')) setLastRefreshAt(Date.now())
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // Mark the in-flight rows as belonging to nothing the moment the schedule
  // changes, so the previous visit's figures are never rendered or exported
  // under the new visit's name.
  useEffect(() => {
    setRowsScheduleId((cur) => (cur === scheduleId ? cur : null))
  }, [scheduleId])

  // Realtime: a scan landing mid-visit should show without a manual refresh.
  // Debounced so a burst triggers ONE reload. `deployments` is included because
  // a row becoming deployed changes the expected denominator behind the numbers.
  useRealtimeRefresh({
    scheduleId,
    channelName: `dashboard-${scheduleId}`,
    subscriptions: [
      { table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` },
      { table: 'deployments', filter: `schedule_id=eq.${scheduleId}` },
    ],
    onReload: () => load().catch(() => {}),
    label: 'dashboard',
  })

  // ─── Derived rows ───
  // Until the in-flight load for THIS schedule lands there are no rows; feeding
  // the builders an empty list blanks the tiles instead of leaving the previous
  // visit's numbers on screen.
  const rowsAreCurrent = rowsScheduleId === scheduleId

  const dailyRows = useMemo(
    () => buildDailyRows((rowsAreCurrent ? sec.daily.rows : []).map((r) => ({ ...r, centre: r?.centre || UNASSIGNED_CENTRE }))),
    [sec.daily.rows, rowsAreCurrent]
  )
  const scannerRows = useMemo(() => buildScannerRows(rowsAreCurrent ? sec.ops.rows : []), [sec.ops.rows, rowsAreCurrent])
  const anomalyRows = useMemo(() => (rowsAreCurrent ? sec.anom.rows : []).filter((r) => r && r.rule), [sec.anom.rows, rowsAreCurrent])

  const totals = useMemo(() => dailyTotals(dailyRows), [dailyRows])
  const counts = useMemo(() => anomalyCounts(anomalyRows), [anomalyRows])
  const anomalyTotal = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts])

  // Sources that failed the last load — surfaced in the LIVE pill tooltip so
  // a partially-degraded dashboard never presents as fully fresh.
  const failedSources = ['daily', 'ops', 'anom'].filter((k) => sec[k].error).length
  // KPI tiles must never render a healthy 0 for a section that failed to
  // load: "—" in amber says "unknown", 0 says "nobody came". The amber tone
  // rides on each tile's `tone` prop.

  // Centre leaderboard: the daily rows folded up to one row per centre.
  const centreRows = useMemo(() => {
    const map = new Map()
    for (const r of dailyRows) {
      const key = r.centre || UNASSIGNED_CENTRE
      const cur = map.get(key) || { centre: key, expected: 0, present: 0, absent: 0, open_now: 0 }
      cur.expected += r.expected
      cur.present += r.present
      cur.absent += r.absent
      cur.open_now += r.open_now
      map.set(key, cur)
    }
    return [...map.values()].map((c) => {
      const rate = c.expected > 0 ? Math.round((c.present / c.expected) * 100) : 0
      return { ...c, rate, band: rateBand(rate) }
    })
  }, [dailyRows])

  // Scanner health, judged on the SAME ≤15-minute rule the Live Scanners page
  // uses, so the two never disagree.
  const scannerHealth = useMemo(() => scannerRows.map((r) => {
    const status = scannerStatus(r.last_scan_time, date, now)
    return { ...r, status, lastScanMs: scanEpoch(r.last_scan_time, date) }
  }), [scannerRows, date, now])
  const activeScanners = useMemo(() => scannerHealth.filter((s) => s.status === 'active').length, [scannerHealth])

  // ─── Alerts. At most three: severity first, then urgency. ───
  const alerts = useMemo(() => {
    const out = []
    if (anomalyTotal > 0) {
      out.push({
        key: 'anom', tone: 'red', icon: <AlertTriangle size={14} />,
        text: `${anomalyTotal} attendance ${anomalyTotal === 1 ? 'anomaly' : 'anomalies'} flagged for this visit`,
        target: 'anomalies',
      })
    }
    const dl = schedule?.deadline ? Date.parse(schedule.deadline) : NaN
    if (Number.isFinite(dl)) {
      const left = dl - now
      if (left > 0 && left <= 24 * 3600 * 1000) {
        out.push({
          key: 'deadline', tone: 'amber', icon: <CalendarClock size={14} />,
          text: `Deployment deadline is in ${msLeft(left)}`,
          // No page owns the deadline, so this one is informational — linking it
          // at an unrelated page would be a lie.
          target: null,
        })
      }
    }
    const low = centreRows.filter((c) => c.expected > 0 && c.rate < 50)
    if (low.length) {
      out.push({
        key: 'low', tone: 'amber', icon: <Users size={14} />,
        text: `${low.length} ${low.length === 1 ? 'centre is' : 'centres are'} under 50% today — ${low.slice(0, 2).map((c) => c.centre).join(', ')}${low.length > 2 ? ` +${low.length - 2} more` : ''}`,
        target: 'reports', payload: { centre: low[0].centre },
      })
    }
    if (totals.open_now > 0) {
      out.push({
        key: 'open', tone: 'amber', icon: <Clock size={14} />,
        text: `${totals.open_now} still IN with no matching OUT — stale open sessions`,
        target: 'reports',
      })
    }
    return out.slice(0, 3)
  }, [anomalyTotal, schedule, now, centreRows, totals.open_now])

  // ─── Guards ───
  if (!schedules.length) {
    return <div className="page"><div className="card"><EmptyState title="No schedules" hint="Ask an ASO to create a deployment schedule to begin tracking attendance." /></div></div>
  }
  if (loading && !rowsAreCurrent) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card">
          <div className="empty">
            <div className="spin" style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin .6s linear infinite' }} />
            <div className="empty-text">Loading dashboard…</div>
          </div>
        </div>
      </div>
    )
  }

  const go = (target, payload) => onNavigate?.(target, payload)
  const alertSkin = {
    red: { background: 'var(--danger-soft)', border: '1px solid #fecaca', color: 'var(--err)' },
    amber: { background: 'var(--warning-soft)', border: '1px solid #fde68a', color: '#92400e' },
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      {/* ── Header ── */}
      <PageHeader
        icon={<LayoutDashboard size={22} />}
        title="Home"
        sub={`Visit status at a glance · ${VISIT_DAYS.join(' · ')}`}
        pills={(
          <>
            <span
              className="pill pill-green"
              title={lastRefreshAt ? `Last successful reload at ${new Date(lastRefreshAt).toLocaleTimeString('en-IN')}${failedSources ? ` · ${failedSources} of 3 sources failed` : ''}` : 'Not loaded yet'}
              style={{ fontWeight: 600 }}
            >
              <LiveDot /> LIVE · updated {timeAgo(lastRefreshAt, now)}
            </span>
            <ViewOnlyPill title="Attendance is read-only here — scans are recorded on the Scanner and Dept Incharge pages" />
          </>
        )}
        actions={(
          <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
          </button>
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
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{shortDayLabel(date)}</div>
            </div>
          </>
        )}
      />

      {/* ── Alerts (max 3) ── */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {alerts.map((a) => (
            <div
              key={a.key}
              role="status"
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', borderRadius: 'var(--radius-md)', padding: '0.6rem 0.75rem', fontSize: '0.82rem', ...alertSkin[a.tone] }}
            >
              {a.icon}
              <span style={{ fontWeight: 600 }}>{a.text}</span>
              {a.target && (
                <button onClick={() => go(a.target, a.payload)} className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '0.15rem 0.45rem', fontSize: '0.72rem' }}>
                  Review <ArrowUpRight size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── KPI row — every tile links out to its single-owner page ── */}
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <KpiTile
          label="Present today"
          value={sec.daily.error ? <span title="Present today could not be loaded">—</span> : totals.present}
          sub={`of ${sec.daily.error ? '—' : totals.expected} deployed`}
          tone={sec.daily.error ? '#b45309' : undefined}
          onPress={() => go('reports')}
          title="Open the Attendance reports for today"
        />
        <KpiTile
          label="Attendance %"
          value={sec.daily.error ? <span title="Attendance rate could not be loaded">—</span> : (
            <div className="progress" style={{ height: 10 }}>
              <div className={`progress-bar${bandBar(rateBand(totals.rate))}`} style={{ width: `${totals.rate}%` }} />
            </div>
          )}
          sub={sec.daily.error ? 'could not be loaded' : `${totals.rate}% present today`}
          tone={sec.daily.error ? '#b45309' : undefined}
          onPress={() => go('reports')}
          title="Open the Attendance reports for today"
        />
        <KpiTile
          label="Absent today"
          value={sec.daily.error ? <span title="Absent today could not be loaded">—</span> : totals.absent}
          sub="expected but not scanned"
          tone={sec.daily.error ? '#b45309' : undefined}
          onPress={() => go('reports')}
          title="Open the Attendance reports for today"
        />
        <KpiTile
          label="Open now"
          value={sec.daily.error ? <span title="Open sessions could not be loaded">—</span> : totals.open_now}
          sub="IN, not yet OUT"
          tone={sec.daily.error ? '#b45309' : (totals.open_now ? '#b45309' : undefined)}
          onPress={() => go('reports')}
          title="Open the Attendance reports for today"
        />
        <KpiTile
          label="Scanners active"
          value={sec.ops.error ? <span title="Scanner activity could not be loaded">—</span> : `${activeScanners}/${scannerHealth.length}`}
          sub="scanned in the last 15 min"
          tone={sec.ops.error ? '#b45309' : undefined}
          onPress={() => go('attendance')}
          title="Open Attendance (Scanner Ops)"
        />
        <KpiTile
          label="Anomalies"
          value={sec.anom.error ? <span title="Anomalies could not be loaded">—</span> : anomalyTotal}
          sub={sec.anom.error ? 'could not be loaded' : (anomalyTotal ? `${Object.keys(counts).length} rules flagged` : 'nothing flagged')}
          tone={sec.anom.error ? '#b45309' : (anomalyTotal ? 'var(--err)' : undefined)}
          onPress={() => go('anomalies')}
          title="Open Attendance Anomalies"
        />
      </div>
    </div>
  )
}
