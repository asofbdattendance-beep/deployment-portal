import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import {
  buildSewadarRows,
  buildDailyRows,
  buildScannerRows,
  dailyTotals,
  attendanceStats,
  searchRows,
  filterByCentre,
  filterByDept,
  centreOptions,
  deptOptions,
  hasExpectedDays,
  sessionMinutes,
  formatDuration,
  FULL_VISIT_DAYS,
  UNASSIGNED_CENTRE,
  VISIT_DAYS,
  shortDayLabel,
} from '../lib/attendance'
import { todayStrIST, withTimeout } from '../lib/scannerUtils'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import { exportWorkbook, fileSlug } from '../lib/excel'
import {
  ScanLine, Users, Clock, Download, Search, RefreshCw, Loader2,
  AlertTriangle, CheckCircle2, Radio, Lock,
} from 'lucide-react'
import { reportRealtimeStatus } from '../lib/realtime'

// Rate band → pill colour. One place, used by both the sewadar and daily tables.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none

/**
 * Unwrap a supabase-js PostgREST result.
 *
 * supabase-js RESOLVES with `{ error }` on a failed RPC — it does not reject —
 * so a `.catch(() => [])` chain silently turns "function does not exist"
 * (PGRST202), an RLS/permission denial or a dropped connection into an empty
 * array. A broken database then looks exactly like a visit with no scans. This
 * helper is the single place that turns a returned `error` into a thrown one so
 * the caller can render a real error state.
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
 * Session duration for a sewadar row: the gap between the first IN and the last
 * OUT across days (L-06: time-only math read Wed 09:00 → Sun 16:00 as "7h").
 * 'still IN' when the last session is open, '—' when there is nothing to
 * measure. This is the consumer that makes `sessionMinutes` / `formatDuration`
 * live code rather than a tested-but-unused pair.
 *
 * @param {object} r a display row from buildSewadarRows
 * @returns {string}
 */
function sessionDuration(r) {
  if (!r?.first_in_time) return '—'
  if (!r.last_out_time) return r.still_open ? 'still IN' : '—'
  return formatDuration(sessionMinutes(r.first_in_time, r.last_out_time, r.first_in_date, r.last_out_date))
}

/**
 * Attendance — read-only analytics over the v39 RPCs.
 *
 * SCOPE IS ENFORCED SERVER-SIDE. `attendance_scope_centres` /
 * `attendance_allowed_depts` resolve the caller's own scope inside the
 * function, so this page never filters by role itself: it renders exactly
 * what the RPCs return. aso / super_admin see every centre, centre roles
 * their subtree, dept_incharge their own departments, and every other role
 * receives zero rows (fail-closed). Do NOT add a client-side role filter —
 * it would only mask a DB scope bug.
 */
export default function AttendancePage({ schedules = [], scheduleId }) {
  const toast = useToast()
  const schedule = schedules.find((s) => s.id === scheduleId)

  const [tab, setTab] = useState('sewadars') // sewadars | daily | scanners
  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  // Bhati Visit shows visit-days data only: pin the picker inside the
  // window (windowless schedules pass through untouched).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])
  const [sewadarRaw, setSewadarRaw] = useState([])
  const [dailyRaw, setDailyRaw] = useState([])
  const [scannerRaw, setScannerRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterDept, setFilterDept] = useState('all')
  // Per-RPC errors, not one all-or-nothing flag. Only the sewadar summary
  // failing blanks the page (every tab and tile is built on it); a daily or
  // scanner-ops failure degrades that tab in place while the healthy datasets
  // stay live — a partial outage must never read as "no attendance records".
  const [sewErr, setSewErr] = useState(null)
  const [dayErr, setDayErr] = useState(null)
  const [opsErr, setOpsErr] = useState(null)
  // A13: which schedule the rows in state actually belong to. Rows from the
  // previous schedule must never be shown (or exported) under the new one.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  // A3: a monotonically increasing request sequence — a slow load for date A
  // must not overwrite a fast load for date B.
  const seqRef = useRef(0)
  // A12: once the operator picks a scan day by hand, window-focus must stop
  // moving it.
  const dateTouchedRef = useRef(false)
  // Max-wait for the realtime debounce below: the timestamp of the last load
  // that actually fired, so a sustained burst cannot starve the reload.
  const lastReloadAt = useRef(0)

  // A12: `todayStrIST()` was evaluated once at mount, so a page left open across
  // IST midnight showed yesterday until a manual refresh. Re-sync on mount and
  // on every window focus — no busy interval. A date the operator chose
  // themselves is left alone.
  useEffect(() => {
    const sync = () => {
      if (dateTouchedRef.current) return
      const today = todayStrIST()
      setDate((d) => (d === today ? d : today))
    }
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])

  // ─── Load. The three RPCs are independent, so fire them together. ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    lastReloadAt.current = Date.now()
    setLoading(true)
    try {
      // A5: never send an empty p_date — Postgres rejects '' with
      // "invalid input syntax for type date" and the result would look like a
      // day with no data. The two date-keyed RPCs are skipped entirely and an
      // inline message is rendered instead.
      // Every RPC is wrapped in withTimeout: a hung function must surface a
      // friendly error, never latch the page on its spinner forever.
      const dayCalls = date
        ? [
            withTimeout(rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_daily_summary'),
            withTimeout(rpcRows('attendance_scanner_ops', { p_schedule: scheduleId, p_date: date }), 15000, 'attendance_scanner_ops'),
          ]
        : [Promise.resolve([]), Promise.resolve([])]
      const [sewR, dayR, opsR] = await Promise.allSettled([
        withTimeout(rpcRows('attendance_sewadar_summary', { p_schedule: scheduleId }), 15000, 'attendance_sewadar_summary'),
        dayCalls[0],
        dayCalls[1],
      ])
      // A3: drop a stale response that landed after a newer one.
      if (!mountedRef.current || seq !== seqRef.current) return
      // allSettled, not all: with `all` a single failure is reported and the
      // other two messages are lost, so a partial outage reads as one vague
      // error. Each section settles independently; a rejection keeps the
      // previous rows for that section rather than blanking healthy data.
      // The panel shown to the operator is friendly on purpose; the detail —
      // including every RPC that failed — is logged here so it is still
      // recoverable without exposing SQL/RLS internals on screen.
      if (sewR.status === 'fulfilled') {
        setSewadarRaw(sewR.value)
        setSewErr(null)
      } else {
        console.error('[Attendance] sewadar load failed:', sewR.reason)
        setSewErr(sewR.reason?.message || 'Unknown error')
        toast.error('Could not load attendance')
      }
      if (dayR.status === 'fulfilled') {
        setDailyRaw(dayR.value)
        setDayErr(null)
      } else {
        console.error('[Attendance] daily load failed:', dayR.reason)
        setDayErr(dayR.reason?.message || 'Unknown error')
      }
      if (opsR.status === 'fulfilled') {
        setScannerRaw(opsR.value)
        setOpsErr(null)
      } else {
        console.error('[Attendance] scanner-ops load failed:', opsR.reason)
        setOpsErr(opsR.reason?.message || 'Unknown error')
      }
      setRowsScheduleId(scheduleId)
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date, toast])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // A2: a filter value that was valid for the previous schedule can vanish from
  // the new one's option list — the <select> would then read "All centres"
  // while state still held the old value, showing 0 rows behind a valid-looking
  // filter. Reset both on every schedule change.
  useEffect(() => {
    setFilterCentre('all')
    setFilterDept('all')
  }, [scheduleId])

  // A13: mark the in-flight rows as belonging to nothing the moment the schedule
  // changes, so the previous schedule's table is never rendered or exported
  // under the new schedule's name.
  useEffect(() => {
    setRowsScheduleId((cur) => (cur === scheduleId ? cur : null))
  }, [scheduleId])

  // Realtime: a scan landing mid-visit should show up without a manual refresh.
  // Debounced so a burst of scans triggers ONE reload, not dozens.
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
    const channel = supabase
      .channel(`attendance-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-34: deployments changes (ASO finalizes, rows become deployed)
      // move the expected denominators behind these numbers — sessions
      // alone leave them stale until a manual refresh.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-40: realtime membership is not guaranteed — a dead channel
      // used to fail silently. Name the state so it lands in devtools.
      .subscribe((status) => {
        reportRealtimeStatus('attendance', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

  // ─── Derived rows ───
  // A13: until the in-flight load for THIS schedule lands, there are no rows.
  // Feeding the builders an empty list blanks the table instead of leaving the
  // previous schedule's rows on screen under the new schedule's name.
  const rowsAreCurrent = rowsScheduleId === scheduleId
  const allSewadars = useMemo(() => buildSewadarRows(rowsAreCurrent ? sewadarRaw : []), [sewadarRaw, rowsAreCurrent])
  const dailyRows = useMemo(() => buildDailyRows((rowsAreCurrent ? dailyRaw : []).map((r) => ({ ...r, centre: r?.centre || UNASSIGNED_CENTRE }))), [dailyRaw, rowsAreCurrent])
  const scannerRows = useMemo(() => buildScannerRows(rowsAreCurrent ? scannerRaw : []), [scannerRaw, rowsAreCurrent])

  const centres = useMemo(() => {
    // Union the sewadar rows AND the daily rows: a centre that is deployed
    // but unscanned has no sewadar row, and without the union it is not
    // selectable even though the Daily tab has figures for it.
    const set = new Set(centreOptions(allSewadars))
    for (const r of dailyRows) set.add(r.centre || UNASSIGNED_CENTRE)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [allSewadars, dailyRows])

  // A16: department options are derived from the CENTRE-FILTERED rows. Building
  // them from the unfiltered set let the operator pick a centre × department
  // pair that can never match, showing 0 rows behind an apparently valid filter.
  // Daily rows are unioned in for the same reason as `centres` above: a
  // deployed-but-unscanned department has no sewadar row.
  const centreFiltered = useMemo(() => filterByCentre(allSewadars, filterCentre), [allSewadars, filterCentre])
  const depts = useMemo(() => {
    const set = new Set(deptOptions(centreFiltered))
    for (const r of dailyRows) {
      if (!r.dept_name) continue
      if (filterCentre !== 'all' && r.centre !== filterCentre) continue
      set.add(r.dept_name)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [centreFiltered, dailyRows, filterCentre])

  // A2 (second half): drop a filter value whose option no longer exists, so the
  // <select> value and the option list can never disagree.
  useEffect(() => {
    if (filterCentre !== 'all' && !centres.includes(filterCentre)) setFilterCentre('all')
  }, [centres, filterCentre])
  useEffect(() => {
    if (filterDept !== 'all' && !depts.includes(filterDept)) setFilterDept('all')
  }, [depts, filterDept])

  // Filter on centre → dept → search, in that order, so the option lists stay
  // scoped to what the caller can actually see.
  const visible = useMemo(() => {
    let rows = centreFiltered
    rows = filterByDept(rows, filterDept)
    return searchRows(rows, search)
  }, [centreFiltered, filterDept, search])

  // L-45: the header tiles describe the same filter set as the tables and
  // the export (ReportsPage already totals its visible rows) — never the
  // whole schedule behind a filtered view. The filter OPTION lists above
  // stay unfiltered on purpose, so options never collapse under a filter.
  const stats = useMemo(() => attendanceStats(visible), [visible])

  // A4: the Daily and Scanner tables use the SAME centre/dept/search controls as
  // the Sewadars table, so the export and both tables describe one filter set.
  // Their rows carry `centre` / `scanner_centre` rather than `sewadar_centre`,
  // hence the small local matchers instead of the sewadar-shaped helpers.
  const matchText = (term, ...fields) => {
    const q = String(term || '').trim().toLowerCase()
    if (!q) return true
    return fields.some((f) => String(f || '').toLowerCase().includes(q))
  }
  const centreMatches = (value) => {
    if (filterCentre === 'all') return true
    // Daily/scanner rows are pre-normalised to the UNASSIGNED_CENTRE string
    // (never null), so matching only `!value` misses every one of them — the
    // filter read "Unassigned centre" and showed 0 rows behind it.
    if (filterCentre === UNASSIGNED_CENTRE) return !value || value === UNASSIGNED_CENTRE
    return value === filterCentre
  }

  const filtering = filterCentre !== 'all' || filterDept !== 'all' || search.trim() !== ''

  const visibleDaily = useMemo(() => {
    if (!filtering) return dailyRows
    return dailyRows.filter(
      (r) => centreMatches(r.centre) && (filterDept === 'all' || r.dept_name === filterDept) && matchText(search, r.centre, r.dept_name)
    )
    // `centreMatches` / `matchText` are pure helpers redefined each render; the
    // listed deps fully determine the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyRows, filterCentre, filterDept, search, filtering])
  const visibleTotals = useMemo(() => dailyTotals(visibleDaily), [visibleDaily])

  const visibleScanner = useMemo(() => {
    if (!filtering) return scannerRows
    // Scanners carry no department, so the dept filter does not apply here —
    // but it still narrows the export, so it is surfaced in the sheet title.
    return scannerRows.filter((r) => centreMatches(r.scanner_centre) && matchText(search, r.scanner_name, r.scanner_badge, r.scanner_centre))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerRows, filterCentre, search, filtering])

  // A4: every sheet title states the active filter, so a filtered export can
  // never be mistaken for a full one.
  const filterLabel = useMemo(() => {
    const parts = []
    if (filterCentre !== 'all') parts.push(filterCentre)
    if (filterDept !== 'all') parts.push(filterDept)
    if (search.trim()) parts.push(`"${search.trim()}"`)
    return parts.length ? ` · ${parts.join(' · ')}` : ''
  }, [filterCentre, filterDept, search])
  const centreSearchLabel = useMemo(() => {
    const parts = []
    if (filterCentre !== 'all') parts.push(filterCentre)
    if (search.trim()) parts.push(`"${search.trim()}"`)
    // Scanners carry no department, so a department filter CANNOT narrow this
    // sheet — the old comment claimed it did, which meant a dept-filtered
    // Scanner Ops export was byte-identical to an unfiltered one. Say so
    // rather than let a filtered export pass for a full one (A4).
    if (filterDept !== 'all') parts.push('dept filter does not apply to scanners')
    return parts.length ? ` · ${parts.join(' · ')}` : ''
  }, [filterCentre, search, filterDept])

  // ─── Export — one sheet per tab, ALL honouring the same active filters,
  // built through the shared excel.js driver (L-24/L-25) so filenames are
  // slugged and sheet names null-safe like every other reports surface. ───
  const exportExcel = async () => {
    setExporting(true)
    try {
      // A9: the two "Attendance %" columns measure different things — this one
      // is the whole-visit rate (days_present / expected_days), the Daily one
      // is a single day's rate. Distinct names, so nobody reads them as one.
      const written = await exportWorkbook(
        `${fileSlug(schedule?.name)}_${date || 'no-date'}_attendance.xlsx`,
        [
          {
            name: `Sewadars${filterLabel}`,
            rows: visible.map((r, i) => ({
              'S.No.': i + 1,
              Centre: r.sewadar_centre || UNASSIGNED_CENTRE,
              Badge: r.badge_number,
              Name: r.sewadar_name,
              Type: r.is_vss ? 'VSS' : 'Regular',
              Department: r.dept_name || '—',
              'Days Present': r.days_present,
              'Expected Days': hasExpectedDays(r) ? r.expected_days : '—',
              // A6: no department means no denominator — never a 0% rate.
              'Visit Attendance %': hasExpectedDays(r) ? r.rate : '—',
              'First In': r.first_in_date ? `${r.first_in_date} ${(r.first_in_time || '').slice(0, 5)}` : '—',
              'Last Out': r.last_out_date ? `${r.last_out_date} ${(r.last_out_time || '').slice(0, 5)}` : '—',
              Duration: sessionDuration(r),
              'Open Now': r.still_open ? 'Yes' : 'No',
              'Undeployed Scan': r.undeployed_scan ? 'Yes' : 'No',
            })),
          },
          {
            name: `Daily ${date || 'no date'}${filterLabel}`,
            rows: [
              ...visibleDaily.map((r) => ({
                Centre: r.centre || UNASSIGNED_CENTRE,
                Department: r.dept_name || '—',
                Expected: r.expected,
                Present: r.present,
                Absent: r.absent,
                'Open Now': r.open_now,
                'Day Attendance %': r.expected > 0 ? r.rate : '—',
              })),
              { Centre: 'TOTAL', Department: '', Expected: visibleTotals.expected, Present: visibleTotals.present, Absent: visibleTotals.absent, 'Open Now': visibleTotals.open_now, 'Day Attendance %': visibleTotals.expected > 0 ? visibleTotals.rate : '—' },
            ],
          },
          {
            name: `Scanner Ops${centreSearchLabel}`,
            rows: visibleScanner.map((r) => ({
              Scanner: r.scanner_name || r.scanner_badge, Badge: r.scanner_badge, Centre: r.scanner_centre || UNASSIGNED_CENTRE,
              'Scans In': r.scans_in, 'Scans Out': r.scans_out, 'Open Now': r.open_now,
              'Manual Scans': r.manual_scans, 'First Scan': (r.first_in_time || '').slice(0, 5), 'Last Scan': (r.last_scan_time || '').slice(0, 5),
            })),
          },
        ]
      )
      // The driver skips empty sheets and writes nothing when all of them
      // are empty, returning 0 — which is the "nothing to export" case.
      if (written === 0) toast.warning('Nothing to export')
      else toast.success('Attendance exported')
    } catch (e) {
      toast.error(e?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // ─── Guards (early returns, so no hooks run after them) ───
  if (!schedules.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }
  if (loading && !allSewadars.length && !dailyRows.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card"><div className="empty"><div className="spin" style={{ width: 24, height: 24, border: '2px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin .6s linear infinite' }} /><div className="empty-text">Loading attendance…</div></div></div>
      </div>
    )
  }

  // A11: a SEWADAR RPC failure is NOT an empty visit. Missing v39 function
  // (PGRST202), an RLS/permission denial or a dropped connection all land here
  // and say so, instead of rendering zeros and "No attendance records".
  //
  // The panel is deliberately FRIENDLY: the raw backend text (function names,
  // PGRST202, the server's own wording) is not shown to the operator. `load`
  // still collects every failure that occurred and `console.error`s it, so the
  // detail stays one devtools away for whoever has to debug it — without
  // putting SQL/RLS internals in front of a centre user.
  // Only the sewadar failure takes the whole page: daily/scanner failures
  // degrade their own tab in place (see the tab-level cards below).
  if (sewErr) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '1.5rem', maxWidth: 720, margin: '0 auto' }} role="alert">
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <AlertTriangle size={18} style={{ color: '#b91c1c' }} />
            <h3 className="empty-title" style={{ margin: 0 }}>Could not load attendance</h3>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', margin: 0 }}>
            The attendance figures could not be read from the server.
          </p>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.75rem 0 0' }}>
            The attendance analytics functions may not be installed on this database, or your role
            may not be permitted to read them. No figures are shown, because none could be loaded.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={load} disabled={loading} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  // A10: the tab list is NOT role-gated. The RPCs resolve the caller's scope
  // server-side and return zero rows for a role they do not cover, so a client
  // gate here would only mask a DB scope bug — see the header comment.
  const tabs = [
    { key: 'sewadars', label: 'Sewadars' },
    { key: 'daily', label: 'Daily' },
    { key: 'scanners', label: 'Scanner Ops' },
  ]

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><ScanLine size={22} /> Attendance</h2>
          <div className="page-sub">Who scanned in, on which day, and who is still open · WED – SUN visit</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" title="Attendance is read-only here — scans are recorded on the Scanner and Dept Incharge pages" style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={exportExcel} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export Excel
            </button>
            {filtering && tab === 'sewadars' && (
              <span className="pill pill-indigo" title="The table and all three Excel sheets show this filtered set">
                Showing {visible.length} of {allSewadars.length}
              </span>
            )}
            {filtering && tab === 'daily' && (
              <span className="pill pill-indigo" title="The Daily table and its Excel sheet show this filtered set">
                Showing {visibleDaily.length} of {dailyRows.length}
              </span>
            )}
            {filtering && tab === 'scanners' && (
              <span className="pill pill-indigo" title="The Scanner Ops table and its Excel sheet show this filtered set">
                Showing {visibleScanner.length} of {scannerRows.length}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Scan day</div>
            <input
              type="date"
              value={date}
              min={visitWin.start || undefined}
              max={visitWin.end || undefined}
              onChange={(e) => { dateTouchedRef.current = true; setDate(clampDateToWindow(e.target.value, visitWin)) }}
              className="input"
              style={{ height: 36 }}
              aria-label="Scan day"
              aria-invalid={!date || undefined}
            />
            {!date && (
              <div role="alert" style={{ fontSize: '0.72rem', color: '#b91c1c', marginTop: '0.25rem', maxWidth: 220 }}>
                Pick a scan day — the date is empty, so the Daily and Scanner tabs cannot load.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Scanned</div>
          <div className="stat-value">{stats.sewadars}</div>
          <div className="stat-sub">across {stats.centres} centres</div>
        </div>
        <div className="stat">
          <div className="stat-label">Present ≥1 day</div>
          <div className="stat-value">{stats.presentToday}</div>
          <div className="stat-sub">of {stats.sewadars} scanned</div>
        </div>
        {/* A7: `stats.full` counts rate >= 100, which for an OE ESCORTS sewadar
            is 3/3 — not a full 5-day visit. The label therefore says "every
            expected day" and the 5-day subset is reported alongside it. */}
        <div className="stat">
          <div className="stat-label">Full attendance</div>
          <div className="stat-value">{stats.full}</div>
          <div className="stat-sub">
            every expected day{stats.full !== stats.full5 ? ` · ${stats.full5} on ${FULL_VISIT_DAYS}-day depts` : ''}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Open now</div>
          <div className="stat-value" style={{ color: stats.openNow ? '#b45309' : undefined }}>{stats.openNow}</div>
          <div className="stat-sub">IN, not yet OUT</div>
        </div>
        <div className="stat">
          <div className="stat-label">Undeployed</div>
          <div className="stat-value" style={{ color: stats.flagged ? '#b91c1c' : undefined }}>{stats.flagged}</div>
          <div className="stat-sub">scanned but not deployed</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={`seg-btn ${tab === t.key ? 'seg-active' : ''}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          {/* A4: one filter set drives all three tabs, the three tables and all
              three export sheets, so the tooltip claim can stay honest. */}
          <select value={filterCentre} onChange={(e) => setFilterCentre(e.target.value)} className="select" aria-label="Filter by centre">
            <option value="all">All centres</option>
            {centres.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className="select" aria-label="Filter by department">
            <option value="all">All departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / badge / centre..." className="input" style={{ width: '100%', paddingLeft: 30 }} aria-label="Search attendance" />
          </div>
        </div>

        {tab === 'sewadars' && (
          visible.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Users size={22} /></div>
              <div className="empty-title">No attendance records</div>
              <div className="empty-text">
                {filtering ? 'Try clearing the filters.' : 'No scans have been recorded for this schedule yet.'}
              </div>
            </div>
          ) : (
            <div className="table-wrap table-wrap-sticky">
              <table className="table table-sticky">
                <thead>
                  <tr>
                    <th>Centre</th>
                    <th>Badge</th>
                    <th>Name</th>
                    <th>Department</th>
                    <th style={{ textAlign: 'center' }}>Days</th>
                    <th>First In</th>
                    <th>Last Out</th>
                    <th>Duration</th>
                    <th style={{ textAlign: 'center' }}>Rate</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    return (
                      // One row per badge: buildSewadarRows re-aggregates, so the
                      // badge alone is a unique key (dept_name is not).
                      <tr key={r.badge_number}>
                        <td>{r.sewadar_centre || UNASSIGNED_CENTRE}</td>
                        <td style={{ fontFamily: 'monospace' }}>
                          {r.badge_number}{' '}
                          {r.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
                        </td>
                        <td>{r.sewadar_name}</td>
                        <td>{r.dept_name || '—'}</td>
                        {/* A6: no department = no expected days. Showing "0/5"
                            would read as 0% attendance for someone who was never
                            scheduled to attend. */}
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>
                          {hasExpectedDays(r) ? `${r.days_present}/${r.expected_days}` : r.days_present > 0 ? `${r.days_present} (no dept)` : '—'}
                        </td>
                        <td>{r.first_in_date ? `${shortDayLabel(r.first_in_date)} ${(r.first_in_time || '').slice(0, 5)}` : '—'}</td>
                        <td>
                          {r.last_out_date
                            ? `${shortDayLabel(r.last_out_date)} ${(r.last_out_time || '').slice(0, 5)}`
                            : r.still_open ? <span className="pill pill-amber">still IN</span> : '—'}
                        </td>
                        <td>{sessionDuration(r)}</td>
                        <td style={{ textAlign: 'center' }}>
                          {hasExpectedDays(r)
                            ? <span className={`pill ${bandPill(r.band)}`}>{r.rate}%</span>
                            : <span className="pill pill-gray" title="No department, so there is no expected-days denominator">—</span>}
                        </td>
                        <td>
                          <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                            {r.open_sessions > 0 && <span className="pill pill-amber" title="Scanned IN, not yet OUT"><Clock size={11} /> Open</span>}
                            {r.undeployed_scan && <span className="pill pill-red" title="Scanned at the gate but not deployed to any department"><AlertTriangle size={11} /> Undeployed</span>}
                            {!r.open_sessions && !r.undeployed_scan && <span className="pill pill-gray">—</span>}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'daily' && (
          <>
            {dayErr && (
              <div
                role="alert"
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
                  padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: '#b91c1c', marginBottom: '0.75rem',
                }}
              >
                <AlertTriangle size={15} />
                <span><strong>Daily figures</strong> could not be loaded — the Sewadars and Scanner Ops tabs are unaffected.</span>
                <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.72rem' }}>
                  <RefreshCw size={12} /> Retry
                </button>
              </div>
            )}
            {!date ? (
            // A5: never claim "no deployment for this day" when no day was asked for.
            <div className="empty">
              <div className="empty-icon"><Clock size={22} /></div>
              <div className="empty-title">No scan day selected</div>
              <div className="empty-text">Pick a scan day above to load the daily summary.</div>
            </div>
          ) : visibleDaily.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Clock size={22} /></div>
              <div className="empty-title">No deployment for this day</div>
              <div className="empty-text">
                {filtering ? 'Try clearing the filters.' : 'Pick another scan day, or check that departments are allocated.'}
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Centre</th>
                    <th>Department</th>
                    <th style={{ textAlign: 'center' }}>Expected</th>
                    <th style={{ textAlign: 'center' }}>Present</th>
                    <th style={{ textAlign: 'center' }}>Absent</th>
                    <th style={{ textAlign: 'center' }}>Open</th>
                    <th style={{ textAlign: 'center' }}>Day Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDaily.map((r) => (
                    <tr key={`${r.centre}-${r.dept_name}`}>
                      <td>{r.centre || UNASSIGNED_CENTRE}</td>
                      <td>{r.dept_name || '—'}</td>
                      <td style={{ textAlign: 'center' }}>{r.expected}</td>
                      <td style={{ textAlign: 'center' }}>{r.present}</td>
                      <td style={{ textAlign: 'center', color: r.absent ? '#b91c1c' : undefined, fontWeight: r.absent ? 700 : 400 }}>{r.absent}</td>
                      <td style={{ textAlign: 'center' }}>{r.open_now}</td>
                      <td style={{ textAlign: 'center' }}>
                        {r.expected > 0
                          ? <span className={`pill ${bandPill(r.band)}`}>{r.rate}%</span>
                          : <span className="pill pill-gray" title="Nobody was expected, so there is no rate">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, background: '#f8fafc' }}>
                    <td>TOTAL</td>
                    <td>—</td>
                    <td style={{ textAlign: 'center' }}>{visibleTotals.expected}</td>
                    <td style={{ textAlign: 'center' }}>{visibleTotals.present}</td>
                    <td style={{ textAlign: 'center' }}>{visibleTotals.absent}</td>
                    <td style={{ textAlign: 'center' }}>{visibleTotals.open_now}</td>
                    <td style={{ textAlign: 'center' }}>{visibleTotals.expected > 0 ? `${visibleTotals.rate}%` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
          }
          </>
        )}

        {tab === 'scanners' && (
          <>
            {opsErr && (
              <div
                role="alert"
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
                  padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: '#b91c1c', marginBottom: '0.75rem',
                }}
              >
                <AlertTriangle size={15} />
                <span><strong>Scanner activity</strong> could not be loaded — the Sewadars and Daily tabs are unaffected.</span>
                <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.72rem' }}>
                  <RefreshCw size={12} /> Retry
                </button>
              </div>
            )}
            {!date ? (
            <div className="empty">
              <div className="empty-icon"><Radio size={22} /></div>
              <div className="empty-title">No scan day selected</div>
              <div className="empty-text">Pick a scan day above to load scanner activity.</div>
            </div>
          ) : visibleScanner.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Radio size={22} /></div>
              <div className="empty-title">No scanner activity</div>
              <div className="empty-text">
                {filtering ? 'Try clearing the filters.' : `No scans were recorded on ${date}.`}
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Scanner</th>
                    <th>Badge</th>
                    <th>Centre</th>
                    <th style={{ textAlign: 'center' }}>Scans In</th>
                    <th style={{ textAlign: 'center' }}>Scans Out</th>
                    <th style={{ textAlign: 'center' }}>Open</th>
                    <th style={{ textAlign: 'center' }}>Manual</th>
                    <th>First</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleScanner.map((r) => (
                    <tr key={r.scanner_badge}>
                      <td>{r.scanner_name || '—'}</td>
                      <td style={{ fontFamily: 'monospace' }}>{r.scanner_badge}</td>
                      <td>{r.scanner_centre || UNASSIGNED_CENTRE}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.scans_in}</td>
                      <td style={{ textAlign: 'center' }}>{r.scans_out}</td>
                      <td style={{ textAlign: 'center', color: r.open_now ? '#b45309' : undefined }}>{r.open_now}</td>
                      <td style={{ textAlign: 'center' }}>{r.manual_scans}</td>
                      <td>{(r.first_in_time || '').slice(0, 5) || '—'}</td>
                      <td>{(r.last_scan_time || '').slice(0, 5) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          }
          </>
        )}
      </div>

      <div className="page-sub" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <CheckCircle2 size={13} />
        Visit days: {VISIT_DAYS.join(' · ')} · scope is enforced by the database for your role
      </div>
    </div>
  )
}
