import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import {
  buildDailyRows,
  buildScannerRows,
  buildVisitRows,
  buildTrendRows,
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
import { scheduleWindow, expandDateRange, clampDateToWindow } from '../lib/sewaMode'
import { exportWorkbook, exportWorkbookBlob, fileSlug } from '../lib/excel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useExport } from '../hooks/useExport'
import ExportSheet from '../components/mobile/ExportSheet'
import {
  LayoutDashboard, Users, UserX, Percent, Clock, Radio, AlertTriangle,
  CalendarClock, RefreshCw, Download, FileDown, ArrowUp, ArrowDown,
  ArrowUpRight, Loader2, Lock, TrendingUp, Building2, ListOrdered,
} from 'lucide-react'
import { reportRealtimeStatus } from '../lib/realtime'

// Rate band → pill colour. Same map the Attendance tables use, so a centre that
// reads amber there reads amber here.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none

// Trend bars reuse the `.progress-bar` modifiers rather than a chart library.
const BAND_BAR = { full: 'success', partial: '', low: 'warn', none: 'danger' }
const bandBar = (band) => (BAND_BAR[band] === '' ? '' : ` ${BAND_BAR[band] || ''}`.trim())

// A `<button className="stat">` reuses the existing tile skin (including its
// :hover lift) while staying a real, focusable, keyboard-operable control —
// a div with onClick would be invisible to keyboard and to screen readers.
const TILE = {
  appearance: 'none',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  width: '100%',
}

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
        background: '#10b981', boxShadow: '0 0 0 3px rgba(16,185,129,0.16)',
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

/** 'WED' from an ISO 'YYYY-MM-DD'. Parsed as UTC so the weekday never shifts. */
function dayLabel(day) {
  // buildTrendRows emits weekday labels ('WED'…'SUN') — pass them through.
  if (/^(WED|THU|FRI|SAT|SUN|MON|TUE)$/i.test(String(day || '').trim())) return String(day).toUpperCase()
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(day || '—').slice(0, 2)
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

/** scanner_ops.last_scan_time is a bare IST wall clock for the queried date. */
function scanEpoch(lastScanTime, dateStr) {
  if (!lastScanTime || !dateStr) return NaN
  return Date.parse(`${dateStr}T${lastScanTime}+05:30`)
}

/**
 * One failed RPC blanks ONE section. The page, the other four sections and the
 * header stay live, because a dashboard that refuses to render over a single
 * missing function is indistinguishable from a broken one.
 */
function SectionError({ label, onRetry }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
        background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
        padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: '#b91c1c',
      }}
    >
      <AlertTriangle size={15} />
      <span><strong>{label}</strong> could not be loaded — the rest of the dashboard is live.</span>
      <button onClick={onRetry} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.72rem' }}>
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  )
}

/**
 * Dashboard — the aso / super_admin landing tab.
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
  const toast = useToast()
  const schedule = schedules.find((s) => s.id === scheduleId)

  // The dashboard has no date picker: it always reports TODAY (IST). Re-sync on
  // mount and on window focus so a tab left open across IST midnight stops
  // reporting yesterday without a manual refresh.
  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [leaderSort, setLeaderSort] = useState('asc') // worst-first | best-first
  const [lastRefreshAt, setLastRefreshAt] = useState(null)
  // One slot per section, so a rejected RPC degrades in place.
  const [sec, setSec] = useState({
    daily: { rows: [], error: null },
    visit: { rows: [], error: null },
    ops: { rows: [], error: null },
    anom: { rows: [], error: null },
    trend: { rows: [], error: null },
  })
  // Which schedule the rows in state belong to. Rows from the previous schedule
  // must never be shown (or exported) under the new one's name.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load must not
  // overwrite a fast newer one.
  const seqRef = useRef(0)
  // Max-wait for the realtime debounce below: the timestamp of the last load
  // that actually fired, so a sustained burst cannot starve the reload.
  const lastReloadAt = useRef(0)

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

  // ─── Load. One Promise.allSettled over the five RPCs. ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    lastReloadAt.current = Date.now()
    setLoading(true)
    try {
      // Every RPC is wrapped in withTimeout: a hung function must surface a
      // friendly section error, never latch the page on its spinner forever.
      const results = await Promise.allSettled([
        withTimeout(rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_daily_summary'),
        withTimeout(rpcRows('attendance_visit_summary', { p_schedule: scheduleId }), 15000, 'attendance_visit_summary'),
        withTimeout(rpcRows('attendance_scanner_ops', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_scanner_ops'),
        // p_date: null → the visit-wide anomaly sweep, not one day.
        withTimeout(rpcRows('attendance_anomalies', { p_schedule: scheduleId, p_date: null }), 15000, 'attendance_anomalies'),
        withTimeout(rpcRows('attendance_trend', { p_schedule: scheduleId }), 15000, 'attendance_trend'),
      ])
      if (!mountedRef.current || seq !== seqRef.current) return
      const next = {}
      ;['daily', 'visit', 'ops', 'anom', 'trend'].forEach((key, i) => {
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
      // source actually answered — five rejections leave the old timestamp.
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
  useEffect(() => {
    if (!scheduleId) return
    let alive = true
    let timer = null
    const reload = () => {
      if (!alive) return
      // Max-wait: the 400ms trailing debounce coalesces bursts, but a
      // sustained burst would re-arm it forever and starve the reload. Fire
      // immediately when the last actual load is more than 2000ms old.
      if (Date.now() - lastReloadAt.current > 2000) {
        if (timer) clearTimeout(timer)
        if (alive) load().catch(() => {})
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (alive) load().catch(() => {}) }, 400)
    }
    const onScan = { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }
    const onDeploy = { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }
    const channel = supabase
      .channel(`dashboard-${scheduleId}`)
      .on('postgres_changes', onScan, reload)
      .on('postgres_changes', onDeploy, reload)
      // L-40: realtime membership is not guaranteed — a dead channel
      // used to fail silently. Name the state so it lands in devtools.
      .subscribe((status) => {
        reportRealtimeStatus('dashboard', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

  // ─── Derived rows ───
  // Until the in-flight load for THIS schedule lands there are no rows; feeding
  // the builders an empty list blanks the tiles instead of leaving the previous
  // visit's numbers on screen.
  const rowsAreCurrent = rowsScheduleId === scheduleId

  const dailyRows = useMemo(
    () => buildDailyRows((rowsAreCurrent ? sec.daily.rows : []).map((r) => ({ ...r, centre: r?.centre || UNASSIGNED_CENTRE }))),
    [sec.daily.rows, rowsAreCurrent]
  )
  const visit = useMemo(() => buildVisitRows(rowsAreCurrent ? sec.visit.rows : []), [sec.visit.rows, rowsAreCurrent])
  const scannerRows = useMemo(() => buildScannerRows(rowsAreCurrent ? sec.ops.rows : []), [sec.ops.rows, rowsAreCurrent])
  const anomalyRows = useMemo(() => (rowsAreCurrent ? sec.anom.rows : []).filter((r) => r && r.rule), [sec.anom.rows, rowsAreCurrent])
  // The strip is window-scoped (hard rule): a previsit scan must never
  // land under a visit weekday, and a windowless schedule reads all-zero.
  const trend = useMemo(
    () => buildTrendRows(rowsAreCurrent ? sec.trend.rows : [], expandDateRange(visitWin.start, visitWin.end)),
    [sec.trend.rows, rowsAreCurrent, visitWin]
  )

  const totals = useMemo(() => dailyTotals(dailyRows), [dailyRows])
  const counts = useMemo(() => anomalyCounts(anomalyRows), [anomalyRows])
  const anomalyTotal = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts])

  // Sources that failed the last load — surfaced in the LIVE pill tooltip so
  // a partially-degraded dashboard never presents as fully fresh.
  const failedSources = ['daily', 'visit', 'ops', 'anom', 'trend'].filter((k) => sec[k].error).length
  // KPI tiles must never render a healthy 0 for a section that failed to
  // load: "—" in amber says "unknown", 0 says "nobody came". The SectionError
  // cards below still carry the retry.
  const errStyle = { color: '#b45309' }

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

  const sortedCentres = useMemo(() => {
    const dir = leaderSort === 'asc' ? 1 : -1
    return [...centreRows].sort((a, b) => dir * (a.rate - b.rate) || a.centre.localeCompare(b.centre))
  }, [centreRows, leaderSort])

  // Scanner health, judged on the SAME ≤15-minute rule the Live Scanners page
  // uses, so the two never disagree.
  const scannerHealth = useMemo(() => scannerRows.map((r) => {
    const status = scannerStatus(r.last_scan_time, date, now)
    return { ...r, status, lastScanMs: scanEpoch(r.last_scan_time, date) }
  }), [scannerRows, date, now])
  const activeScanners = useMemo(() => scannerHealth.filter((s) => s.status === 'active').length, [scannerHealth])

  // Anomaly feed: one entry per rule, most frequent first, with a single
  // example badge so the row is recognisable.
  const anomalyFeed = useMemo(() => {
    const map = new Map()
    for (const r of anomalyRows) {
      const cur = map.get(r.rule) || { rule: r.rule, count: 0, example: r.badge_number, detail: r.detail }
      cur.count += 1
      if (!cur.example && r.badge_number) cur.example = r.badge_number
      map.set(r.rule, cur)
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)).slice(0, 5)
  }, [anomalyRows])

  // Department snapshot: the visit-wide rows folded up per department.
  const deptRows = useMemo(() => {
    const map = new Map()
    for (const r of visit.rows) {
      const cur = map.get(r.deptName) || { deptName: r.deptName, deployed: 0, everPresent: 0, neverPresent: 0 }
      cur.deployed += r.deployed
      cur.everPresent += r.everPresent
      cur.neverPresent += r.neverPresent
      map.set(r.deptName, cur)
    }
    return [...map.values()]
      .map((d) => {
        const rate = d.deployed > 0 ? Math.round((d.everPresent / d.deployed) * 100) : 0
        return { ...d, rate, band: rateBand(rate) }
      })
      .sort((a, b) => b.deployed - a.deployed || a.deptName.localeCompare(b.deptName))
  }, [visit.rows])

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

  // ─── Export. The badge list is fetched at CLICK time, never on page load. ───
  // Returns { written, count }: `written` says a workbook actually landed on
  // disk. The old code returned an overloaded 0 for BOTH "no rows" and "write
  // produced nothing", so a half-success (present exported, absent empty)
  // warned "nothing exported" over a workbook that DID download.
  //
  // Mobile shares fetchDayRows/buildDaySheets (same rows, same sheets) and
  // delivers one file through the share sheet: the snapshot combines Present
  // + Absent into a single 4-sheet workbook instead of two downloads.
  const fetchDayRows = useCallback(async (mode) => {
    const rows = await withTimeout(
      rpcRows('attendance_day_badges', { p_schedule: scheduleId, p_date: date, p_mode: mode }),
      15000,
      'attendance_day_badges'
    )
    return Array.isArray(rows) ? rows : []
  }, [scheduleId, date])

  const buildDaySheets = (mode, rows) => {
    const label = mode === 'present' ? 'Present' : 'Absent'
    const byCentre = new Map()
    for (const r of rows) {
      const c = r.sewadar_centre || UNASSIGNED_CENTRE
      byCentre.set(c, (byCentre.get(c) || 0) + 1)
    }
    // The summary reconciles EXACTLY with the detail sheet — same rows, folded
    // by centre, plus a TOTAL. No second data source, so the two cannot disagree.
    const summary = [
      ...[...byCentre.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([centre, n]) => ({ Centre: centre, [label]: n })),
      { Centre: 'TOTAL', [label]: rows.length },
    ]
    return [
      { name: 'Summary', rows: summary },
      {
        name: label,
        rows: rows.map((r, i) => ({
          'S.No.': i + 1,
          Centre: r.sewadar_centre || UNASSIGNED_CENTRE,
          Badge: r.badge_number,
          Name: r.sewadar_name,
          Type: r.is_vss ? 'VSS' : 'Regular',
          Department: r.dept_name || '—',
        })),
      },
    ]
  }

  const dayFilename = useCallback((mode) => `${fileSlug(schedule?.name)}_${date}_${mode}.xlsx`, [schedule, date])

  const dayWorkbook = useCallback(async (mode) => {
    const rows = await fetchDayRows(mode)
    if (!rows.length) return { written: false, count: 0 }
    const written = await exportWorkbook(dayFilename(mode), buildDaySheets(mode, rows))
    return { written: written > 0, count: rows.length }
  }, [fetchDayRows, dayFilename])

  // Both workbooks, one after the other, inside the same click. Success is
  // toasted PER workbook that landed; the "nothing exported" warning fires
  // only when NEITHER workbook was written.
  const exportSnapshot = useCallback(async () => {
    setExporting(true)
    try {
      const present = await dayWorkbook('present')
      const absent = await dayWorkbook('absent')
      if (present.written) toast.success('Present list exported')
      if (absent.written) toast.success('Absent list exported')
      if (!present.written && !absent.written) toast.warning(`No attendance for ${shortDayLabel(date)} — nothing exported`)
    } catch (e) {
      console.error('[Dashboard] snapshot export failed:', e)
      toast.error('Could not export the snapshot')
    } finally {
      setExporting(false)
    }
  }, [dayWorkbook, toast, date])

  const runExport = useCallback(async (mode) => {
    setExporting(true)
    try {
      const result = await dayWorkbook(mode)
      if (result.written) toast.success(`${mode === 'present' ? 'Present' : 'Absent'} list exported`)
      else toast.warning(`No ${mode} sewadars for ${shortDayLabel(date)} — nothing exported`)
    } catch (e) {
      console.error(`[Dashboard] ${mode} export failed:`, e)
      toast.error(`Could not export the ${mode} list`)
    } finally {
      setExporting(false)
    }
  }, [dayWorkbook, toast, date])

  // Mobile export delivery (share sheet + save fallback). Desktop keeps the
  // direct downloads above. The snapshot combines Present + Absent into one
  // file on phones (one share instead of two downloads); per-list buttons
  // share their single list.
  const isMobile = useIsMobile()
  const mobileExport = useExport()
  const [exportSheetOpen, setExportSheetOpen] = useState(false)
  const [exportSheetName, setExportSheetName] = useState('')
  const prepareMobileExport = async (filename, sheets) => {
    setExportSheetName(filename)
    setExportSheetOpen(true)
    await mobileExport.prepare(async () => {
      const { blob, written } = await exportWorkbookBlob(filename, sheets)
      if (!written) return null
      return { blob, filename }
    })
  }
  const onListExportPress = async (mode) => {
    if (!isMobile) { await runExport(mode); return }
    try {
      const rows = await fetchDayRows(mode)
      if (!rows.length) { toast.warning(`No ${mode} sewadars for ${shortDayLabel(date)} — nothing exported`); return }
      await prepareMobileExport(dayFilename(mode), buildDaySheets(mode, rows))
    } catch (e) {
      console.error(`[Dashboard] ${mode} mobile export failed:`, e)
      toast.error(`Could not export the ${mode} list`)
    }
  }
  const onSnapshotPress = async () => {
    if (!isMobile) { await exportSnapshot(); return }
    setExporting(true)
    try {
      const [present, absent] = await Promise.all([fetchDayRows('present'), fetchDayRows('absent')])
      if (!present.length && !absent.length) {
        toast.warning(`No attendance for ${shortDayLabel(date)} — nothing exported`)
        return
      }
      const sheets = [
        ...(present.length ? buildDaySheets('present', present).map((s, i) => ({ ...s, name: i === 0 ? 'Present summary' : 'Present' })) : []),
        ...(absent.length ? buildDaySheets('absent', absent).map((s, i) => ({ ...s, name: i === 0 ? 'Absent summary' : 'Absent' })) : []),
      ]
      await prepareMobileExport(`${fileSlug(schedule?.name)}_${date}_snapshot.xlsx`, sheets)
    } catch (e) {
      console.error('[Dashboard] snapshot mobile export failed:', e)
      toast.error('Could not export the snapshot')
    } finally {
      setExporting(false)
    }
  }

  // ─── Guards ───
  if (!schedules.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }
  if (loading && !rowsAreCurrent) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card">
          <div className="empty">
            <div className="spin" style={{ width: 24, height: 24, border: '2px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin .6s linear infinite' }} />
            <div className="empty-text">Loading dashboard…</div>
          </div>
        </div>
      </div>
    )
  }

  const go = (target, payload) => onNavigate?.(target, payload)
  const alertSkin = {
    red: { background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' },
    amber: { background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' },
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      {/* ── Header ── */}
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><LayoutDashboard size={22} /> Dashboard</h2>
          <div className="page-sub">Visit status at a glance · {VISIT_DAYS.join(' · ')}</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              className="pill"
              title={lastRefreshAt ? `Last successful reload at ${new Date(lastRefreshAt).toLocaleTimeString('en-IN')}${failedSources ? ` · ${failedSources} of 5 sources failed` : ''}` : 'Not loaded yet'}
              style={{ background: '#ecfdf5', color: '#047857', fontWeight: 600 }}
            >
              <LiveDot /> LIVE · updated {timeAgo(lastRefreshAt, now)}
            </span>
            <span className="pill pill-gray" title="Attendance is read-only here — scans are recorded on the Scanner and Dept Incharge pages" style={{ fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={onSnapshotPress} disabled={exporting || mobileExport.building || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting || mobileExport.building ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export snapshot
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
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{shortDayLabel(date)}</div>
          </div>
        </div>
      </div>

      {/* ── Alerts (max 3) ── */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {alerts.map((a) => (
            <div
              key={a.key}
              role="status"
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', ...alertSkin[a.tone] }}
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

      {/* ── KPI row ── */}
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <button type="button" onClick={() => go('reports')} className="stat" style={TILE} title="Open the Attendance reports for today">
          <div className="stat-label">Present today</div>
          <div className="stat-value" style={sec.daily.error ? errStyle : undefined} title={sec.daily.error ? 'Present today could not be loaded' : undefined}>{sec.daily.error ? '—' : totals.present}</div>
          <div className="stat-sub">of {sec.daily.error ? '—' : totals.expected} deployed</div>
        </button>
        <button type="button" onClick={() => go('reports')} className="stat" style={TILE} title="Open the Attendance reports for today">
          <div className="stat-label">Attendance %</div>
          <div className="stat-value" style={{ fontSize: '1.1rem', paddingTop: '0.35rem', ...(sec.daily.error ? errStyle : {}) }} title={sec.daily.error ? 'Attendance rate could not be loaded' : undefined}>
            {sec.daily.error ? '—' : (
              <div className="progress" style={{ height: 10 }}>
                <div className={`progress-bar${bandBar(rateBand(totals.rate))}`} style={{ width: `${totals.rate}%` }} />
              </div>
            )}
          </div>
          <div className="stat-sub">{sec.daily.error ? 'could not be loaded' : `${totals.rate}% present today`}</div>
        </button>
        <button type="button" onClick={() => go('reports')} className="stat" style={TILE} title="Open the Attendance reports for today">
          <div className="stat-label">Absent today</div>
          <div className="stat-value" style={sec.daily.error ? errStyle : undefined} title={sec.daily.error ? 'Absent today could not be loaded' : undefined}>{sec.daily.error ? '—' : totals.absent}</div>
          <div className="stat-sub">expected but not scanned</div>
        </button>
        <button type="button" onClick={() => go('reports')} className="stat" style={TILE} title="Open the Attendance reports for today">
          <div className="stat-label">Open now</div>
          <div className="stat-value" style={{ color: sec.daily.error ? '#b45309' : (totals.open_now ? '#b45309' : undefined) }} title={sec.daily.error ? 'Open sessions could not be loaded' : undefined}>{sec.daily.error ? '—' : totals.open_now}</div>
          <div className="stat-sub">IN, not yet OUT</div>
        </button>
        <button type="button" onClick={() => go('attendance')} className="stat" style={TILE} title="Open Attendance (Scanner Ops)">
          <div className="stat-label">Scanners active</div>
          <div className="stat-value" style={sec.ops.error ? errStyle : undefined} title={sec.ops.error ? 'Scanner activity could not be loaded' : undefined}>{sec.ops.error ? '—' : `${activeScanners}/${scannerHealth.length}`}</div>
          <div className="stat-sub">scanned in the last 15 min</div>
        </button>
        <button type="button" onClick={() => go('anomalies')} className="stat" style={TILE} title="Open Attendance Anomalies">
          <div className="stat-label">Anomalies</div>
          <div className="stat-value" style={{ color: sec.anom.error ? '#b45309' : (anomalyTotal ? '#b91c1c' : undefined) }} title={sec.anom.error ? 'Anomalies could not be loaded' : undefined}>{sec.anom.error ? '—' : anomalyTotal}</div>
          <div className="stat-sub">{sec.anom.error ? 'could not be loaded' : (anomalyTotal ? `${Object.keys(counts).length} rules flagged` : 'nothing flagged')}</div>
        </button>
      </div>

      {/* ── Department snapshot (department-wise count, above centres) ── */}
      <div className="card" style={{ padding: '1.1rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <div className="section-title"><ListOrdered size={15} /> Department snapshot</div>
            <div className="page-sub" style={{ margin: 0 }}>Visit-wide: how many deployed sewadars have been seen at least once</div>
          </div>
        </div>
        {sec.visit.error ? (
          <SectionError label="The department snapshot" onRetry={load} />
        ) : deptRows.length === 0 ? (
          <div className="empty" style={{ padding: '0.75rem' }}>
            <div className="empty-text">Nothing is deployed on this schedule yet.</div>
          </div>
        ) : (
          <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Department</th>
                  <th style={{ textAlign: 'center' }}>Deployed</th>
                  <th style={{ textAlign: 'center' }}>Ever present</th>
                  <th style={{ textAlign: 'center' }}>Never present</th>
                  <th style={{ textAlign: 'center' }}>Seen rate</th>
                </tr>
              </thead>
              <tbody>
                {deptRows.map((d) => (
                  <tr key={d.deptName}>
                    <td data-label="Department" style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1, fontWeight: 600 }}>{d.deptName}</td>
                    <td data-label="Deployed" style={{ textAlign: 'center' }}>{d.deployed}</td>
                    <td data-label="Ever present" style={{ textAlign: 'center' }}>{d.everPresent}</td>
                    <td data-label="Never present" style={{ textAlign: 'center', color: d.neverPresent ? '#b91c1c' : undefined }}>{d.neverPresent}</td>
                    <td data-label="Seen rate" style={{ textAlign: 'center' }}>
                      {d.deployed > 0
                        ? <span className={`pill ${bandPill(d.band)}`}>{d.rate}%</span>
                        : <span className="pill pill-gray">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, background: '#f8fafc' }}>
                  <td data-label="Department" style={{ position: 'sticky', left: 0, background: '#f8fafc', zIndex: 1 }}>TOTAL</td>
                  <td data-label="Deployed" style={{ textAlign: 'center' }}>{visit.totals.deployed}</td>
                  <td data-label="Ever present" style={{ textAlign: 'center' }}>{visit.totals.everPresent}</td>
                  <td data-label="Never present" style={{ textAlign: 'center' }}>{visit.totals.neverPresent}</td>
                  <td data-label="Seen rate" style={{ textAlign: 'center' }}>{visit.totals.deployed > 0 ? `${Math.round((visit.totals.everPresent / visit.totals.deployed) * 100)}%` : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ── Body: leaderboard + right rail ── */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '1 1 520px', minWidth: 0, padding: '1.1rem' }}>
          <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <div className="section-title"><Building2 size={15} /> Centre leaderboard</div>
              <div className="page-sub" style={{ margin: 0 }}>Today&apos;s attendance by centre · click a row to drill in</div>
            </div>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setLeaderSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
              className="btn btn-ghost"
              style={{ padding: '0.25rem 0.55rem', fontSize: '0.74rem' }}
              title={leaderSort === 'asc' ? 'Worst attendance first — click for best first' : 'Best attendance first — click for worst first'}
            >
              {leaderSort === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              {leaderSort === 'asc' ? 'Worst first' : 'Best first'}
            </button>
          </div>

          {sec.daily.error ? (
            <SectionError label="Centre attendance" onRetry={load} />
          ) : sortedCentres.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Building2 size={22} /></div>
              <div className="empty-title">No deployment for today</div>
              <div className="empty-text">Nothing is deployed on this schedule, so there is no expected headcount to report against.</div>
            </div>
          ) : (
            <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Centre</th>
                    <th style={{ textAlign: 'center' }}>Present</th>
                    <th style={{ textAlign: 'center' }}>Absent</th>
                    <th style={{ textAlign: 'center' }}>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCentres.map((c) => (
                    <tr
                      key={c.centre}
                      onClick={() => go('reports', { centre: c.centre })}
                      style={{ cursor: 'pointer' }}
                    >
                      <td data-label="Centre" style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1, fontWeight: 600 }}>
                        <button type="button" className="btn btn-ghost" style={{ padding: 0, fontSize: 'inherit', fontWeight: 700, color: 'inherit', background: 'none', border: 'none' }}>
                          {c.centre}
                        </button>
                      </td>
                      <td data-label="Present" style={{ textAlign: 'center' }}>{c.present}</td>
                      <td data-label="Absent" style={{ textAlign: 'center', color: c.absent ? '#b91c1c' : undefined }}>{c.absent}</td>
                      <td data-label="Rate" style={{ textAlign: 'center' }}>
                        {c.expected > 0
                          ? <span className={`pill ${bandPill(c.band)}`}>{c.rate}%</span>
                          : <span className="pill pill-gray" title="Nobody was expected, so there is no rate">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, background: '#f8fafc' }}>
                    <td data-label="Centre" style={{ position: 'sticky', left: 0, background: '#f8fafc', zIndex: 1 }}>TOTAL</td>
                    <td data-label="Present" style={{ textAlign: 'center' }}>{totals.present}</td>
                    <td data-label="Absent" style={{ textAlign: 'center' }}>{totals.absent}</td>
                    <td data-label="Rate" style={{ textAlign: 'center' }}>{totals.expected > 0 ? `${totals.rate}%` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div style={{ flex: '0 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Scanner health */}
          <div className="card" style={{ padding: '1rem' }}>
            <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              <div className="section-title"><Radio size={15} /> Scanner health</div>
              <div style={{ flex: 1 }} />
              <button onClick={() => go('attendance')} className="btn btn-ghost" style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}>
                View all <ArrowUpRight size={12} />
              </button>
            </div>
            {sec.ops.error ? (
              <SectionError label="Scanner health" onRetry={load} />
            ) : scannerHealth.length === 0 ? (
              <div className="empty" style={{ padding: '0.75rem' }}>
                <div className="empty-text">No scanner activity recorded on {shortDayLabel(date)}.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.6rem' }}>
                {scannerHealth.slice(0, 6).map((s) => (
                  <div key={s.scanner_badge} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem' }}>
                    <span
                      aria-hidden="true"
                      title={s.status}
                      style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: s.status === 'active' ? '#10b981' : s.status === 'idle' ? '#f59e0b' : '#cbd5e1',
                      }}
                    />
                    <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.scanner_name || s.scanner_badge}
                    </span>
                    <span style={{ marginLeft: 'auto', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {Number.isFinite(s.lastScanMs) ? timeAgo(s.lastScanMs, now) : 'no scan'}
                    </span>
                    <span className={`pill ${s.open_now ? 'pill-amber' : 'pill-gray'}`} title="Scanned IN and not yet OUT">
                      {s.open_now} open
                    </span>
                  </div>
                ))}
                {scannerHealth.length > 6 && (
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    +{scannerHealth.length - 6} more scanners —{' '}
                    <button onClick={() => go('attendance')} className="btn btn-ghost" style={{ padding: 0, fontSize: '0.72rem', color: '#4f46e5' }}>view all</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Anomaly feed */}
          <div className="card" style={{ padding: '1rem' }}>
            <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              <div className="section-title"><AlertTriangle size={15} /> Anomalies</div>
              <div style={{ flex: 1 }} />
              <button onClick={() => go('anomalies')} className="btn btn-ghost" style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}>
                Review <ArrowUpRight size={12} />
              </button>
            </div>
            {sec.anom.error ? (
              <SectionError label="Anomalies" onRetry={load} />
            ) : anomalyFeed.length === 0 ? (
              <div className="empty" style={{ padding: '0.75rem' }}>
                <div className="empty-text">No anomalies flagged for this visit.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.6rem' }}>
                {anomalyFeed.map((a) => (
                  <div key={a.rule} style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', fontSize: '0.78rem' }}>
                    <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.rule}</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700, color: a.count ? '#b91c1c' : '#64748b' }}>{a.count}</span>
                    {a.example && <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#64748b' }}>{a.example}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 5-day trend */}
          <div className="card" style={{ padding: '1rem' }}>
            <div className="section-header">
              <div className="section-title"><TrendingUp size={15} /> 5-day trend</div>
            </div>
            {sec.trend.error ? (
              <SectionError label="The 5-day trend" onRetry={load} />
            ) : trend.length === 0 ? (
              <div className="empty" style={{ padding: '0.75rem' }}>
                <div className="empty-text">No day has attendance recorded yet.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.6rem' }}>
                {trend.map((t) => {
                  const band = rateBand(t.rate)
                  return (
                    <div key={t.day} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ width: 34, fontSize: '0.72rem', fontWeight: 700, color: '#64748b' }}>{dayLabel(t.day)}</span>
                      <div className="progress" style={{ flex: 1, height: 8 }}>
                        <div className={`progress-bar${bandBar(band)}`} style={{ width: `${t.rate}%` }} />
                      </div>
                      <span style={{ width: 38, textAlign: 'right', fontSize: '0.72rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{t.rate}%</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer quick actions ── */}
      <div className="card" style={{ padding: '0.9rem 1rem', marginTop: '1rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
          <div>
            <div className="section-title"><FileDown size={15} /> Quick actions</div>
            <div className="page-sub" style={{ margin: 0 }}>Lists for {shortDayLabel(date)} · each workbook has a per-centre Summary with a TOTAL plus the full badge list</div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => onListExportPress('present')} disabled={exporting || !rowsAreCurrent} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download Present workbook
          </button>
          <button onClick={() => onListExportPress('absent')} disabled={exporting || !rowsAreCurrent} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download Absent workbook
          </button>
          <button onClick={() => go('reports')} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            <Users size={13} /> Reports
          </button>
          <button onClick={() => go('attendance')} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            <Radio size={13} /> Scanner Ops
          </button>
          <button onClick={() => go('anomalies')} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
            <AlertTriangle size={13} /> Anomalies
          </button>
        </div>
      </div>

      <ExportSheet
        open={isMobile && exportSheetOpen}
        onClose={() => { setExportSheetOpen(false); mobileExport.reset() }}
        filename={exportSheetName}
        file={mobileExport.file?.blob || null}
        building={mobileExport.building}
        buildError={mobileExport.buildError}
        delivering={mobileExport.delivering}
        deliveredVia={mobileExport.deliveredVia}
        onDeliver={mobileExport.deliver}
        onRetry={onSnapshotPress}
      />
    </div>
  )
}
