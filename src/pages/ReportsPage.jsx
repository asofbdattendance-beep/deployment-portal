import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, fetchCentres } from '../lib/supabase'
import { useToast } from '../components/Toast'
import {
  buildVisitRows,
  buildDailyRows,
  dailyTotals,
  rateBand,
  searchRows,
  filterByCentre,
  filterByDept,
  buildCentreTree,
  rootCentreOf,
  UNASSIGNED_CENTRE,
  VISIT_DAYS,
} from '../lib/attendance'
// `exportWorkbook` runs every sheet name through `sheetName` internally, so
// sheetName() is deliberately NOT imported here — the `Summary {date}` and
// `{label} list` names still get the ≤31-char / illegal-char treatment for free.
import { exportWorkbook, fileSlug } from '../lib/excel'
import { todayStrIST } from '../lib/scannerUtils'
import {
  BarChart3, Users, Radio, Download, Search,
  RefreshCw, Loader2, AlertTriangle, Lock, ChevronRight, ChevronDown,
} from 'lucide-react'
import { reportRealtimeStatus } from '../lib/realtime'

// Rate band → pill colour. One place, copied verbatim from AttendancePage so the
// two dashboards read the same number the same way.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none

/**
 * Unwrap a supabase-js PostgREST result.
 *
 * supabase-js RESOLVES with `{ error }` on a failed RPC — it does not reject —
 * so a `.catch(() => [])` chain silently turns "function does not exist"
 * (PGRST202), an RLS/permission denial or a dropped connection into an empty
 * array, and a broken database then looks exactly like a visit with no scans.
 * Throwing here is what makes the page render a real error panel instead.
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
 * A percentage, or null when there is no denominator. A6 from AttendancePage:
 * a group with nothing deployed has no rate — it must never read as 0%.
 * @param {number} part
 * @param {number} whole
 * @returns {number|null}
 */
function pct(part, whole) {
  const p = Number(part) || 0
  const w = Number(whole) || 0
  if (w <= 0) return null
  return Math.round((p / w) * 100)
}

/**
 * Render a rate, or an em-dash when there was no denominator to take it over.
 * @param {number|null} rate
 * @returns {string}
 */
function rateLabel(rate) {
  return rate === null ? '—' : `${rate}%`
}

/**
 * Case-insensitive substring match across the given fields. Matrix rows carry
 * `centre` / `deptName` rather than the sewadar-row fields the shared helpers
 * match on, so this applies the same rule AttendancePage's Daily/Scanner tables
 * use. Module-level and pure, so it is a stable useMemo dependency.
 * @param {string} term
 * @param {...any} fields
 * @returns {boolean}
 */
function matchText(term, ...fields) {
  const q = String(term || '').trim().toLowerCase()
  if (!q) return true
  return fields.some((f) => String(f || '').toLowerCase().includes(q))
}

/**
 * Does this matrix row's centre fall under the chosen centre filter? 'all' (or
 * empty) keeps everything; UNASSIGNED_CENTRE matches the bucket that stands in
 * for an unresolved home centre.
 * @param {string} value the row's centre
 * @param {string} filterCentre
 * @returns {boolean}
 */
function centreMatches(value, filterCentre) {
  if (!filterCentre || filterCentre === 'all') return true
  if (filterCentre === UNASSIGNED_CENTRE) return value === UNASSIGNED_CENTRE
  return value === filterCentre
}

/**
 * Reports — read-only attendance roll-ups over the v45 RPCs.
 *
 * SCOPE IS ENFORCED SERVER-SIDE, exactly as on AttendancePage: the RPCs resolve
 * the caller's own scope inside the function and return zero rows for a role
 * they do not cover, so this page never filters by role. Do NOT add a client-side
 * role gate — it would only mask a DB scope bug.
 *
 * The `centre` column these RPCs return is the SEWADAR'S HOME CENTRE, not the
 * single physical scan venue — it is the only centre value that may be grouped
 * or filtered on here. `dp_attendance_sessions.centre` (the venue) is never read.
 */
export default function ReportsPage({ schedules = [], scheduleId, onNavigate, initialCentre }) {
  const toast = useToast()
  const schedule = schedules.find((s) => s.id === scheduleId)

  const [view, setView] = useState('visit') // visit | today
  const [date, setDate] = useState(() => todayStrIST())
  const [visitRaw, setVisitRaw] = useState([])
  const [dailyRaw, setDailyRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportKind, setExportKind] = useState(null) // present | absent
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterDept, setFilterDept] = useState('all')
  // dp_centres rows ({name, parent_centre}) for the collapsible CENTRE tree.
  // A failed fetch degrades to a flat list — it must never blank the report.
  const [centresList, setCentresList] = useState([])
  // Roots the operator opened. Cleared on schedule change with the filters.
  const [expanded, setExpanded] = useState(() => new Set())
  // An RPC failure must render a visible error panel, not a silent [].
  const [loadError, setLoadError] = useState(null)
  // Which schedule the rows in state actually belong to. Rows from the previous
  // schedule must never be shown (or exported) under the new one.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load for date A must not
  // overwrite a fast load for date B.
  const seqRef = useRef(0)
  // Once the operator picks a day by hand, window-focus must stop moving it.
  const dateTouchedRef = useRef(false)

  // `todayStrIST()` was evaluated once at mount, so a page left open across IST
  // midnight would show yesterday until a manual refresh. Re-sync on mount and on
  // window focus — no busy interval. A day the operator chose is left alone.
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

  // ─── Load. The two RPCs are independent, so fire them together. ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      // Never send an empty p_date — Postgres rejects '' with "invalid input
      // syntax for type date" and the result would look like a day with no data.
      // The date-keyed RPC is skipped entirely and an inline message is rendered.
      const dayCall = date
        ? rpcRows('attendance_daily_summary', { p_schedule: scheduleId, p_date: date })
        : Promise.resolve([])
      const [visitR, dayR, centresR] = await Promise.allSettled([
        rpcRows('attendance_visit_summary', { p_schedule: scheduleId }),
        dayCall,
        // Centres are reference data, not report data: a failure here degrades
        // the tree to a flat list instead of failing the whole load.
        fetchCentres().catch(() => []),
      ])
      // Drop a stale response that landed after a newer one.
      if (!mountedRef.current || seq !== seqRef.current) return
      // allSettled, not all: with `all` a single failure is reported and the
      // other message is lost, so a partial outage reads as one vague error.
      const failed = [visitR, dayR].filter((r) => r.status === 'rejected')
      if (failed.length) {
        throw new Error(failed.map((r) => r.reason?.message || 'Unknown error').join(' · '))
      }
      if (centresR.status === 'fulfilled' && Array.isArray(centresR.value)) {
        setCentresList(centresR.value)
      }
      setVisitRaw(visitR.value)
      setDailyRaw(dayR.value)
      setRowsScheduleId(scheduleId)
      setLoadError(null)
    } catch (e) {
      if (!mountedRef.current || seq !== seqRef.current) return
      // Friendly on screen; the detail (including every RPC that failed, since
      // allSettled collects them all) is logged so it stays recoverable without
      // exposing SQL/RLS internals to a centre user.
      console.error('[Reports] load failed:', e)
      setVisitRaw([])
      setDailyRaw([])
      setCentresList([])
      setRowsScheduleId(scheduleId)
      setLoadError(e?.message || 'Unknown error')
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // A filter value that was valid for the previous schedule can vanish from the
  // new one's option list — the <select> would then read "All centres" while
  // state still held the old value, showing 0 rows behind a valid-looking filter.
  useEffect(() => {
    setFilterCentre('all')
    setFilterDept('all')
    setExpanded(new Set())
  }, [scheduleId])

  // Mark the in-flight rows as belonging to nothing the moment the schedule
  // changes, so the previous schedule's figures are never rendered or exported
  // under the new schedule's name.
  useEffect(() => {
    setRowsScheduleId((cur) => (cur === scheduleId ? cur : null))
  }, [scheduleId])

  // Realtime: a scan landing mid-visit should update the report without a manual
  // refresh. Debounced so a burst of scans triggers ONE reload, not dozens. No
  // write-echo logic is needed — this page never writes.
  useEffect(() => {
    if (!scheduleId) return
    let alive = true
    let timer = null
    const reload = () => {
      if (!alive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (alive) load().catch(() => {}) }, 400)
    }
    const channel = supabase
      .channel(`reports-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-34: deployments changes (ASO finalizes, rows become deployed)
      // move the expected denominators behind these numbers — sessions
      // alone leave them stale until a manual refresh.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-40: realtime membership is not guaranteed — a dead channel
      // used to fail silently. Name the state so it lands in devtools.
      .subscribe((status) => {
        reportRealtimeStatus('reports', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

  // ─── Derived rows ───
  // Until the in-flight load for THIS schedule lands, there are no rows. Feeding
  // the builders an empty list blanks the tables instead of leaving the previous
  // schedule's rows on screen under the new schedule's name.
  const rowsAreCurrent = rowsScheduleId === scheduleId

  /**
   * One uniform row shape for BOTH views, so the matrices, the totals and the
   * filters never branch on which dataset is active. `deployed` is the visit's
   * deployment count in the Visit view and the day's expected count in the Today
   * view — in both cases it is the denominator the rate is taken over.
   */
  const matrix = useMemo(() => {
    if (view === 'visit') {
      const { rows, totals } = buildVisitRows(rowsAreCurrent ? visitRaw : [])
      return {
        rows: rows.map((r) => ({
          key: `${r.centre}::${r.department_id ?? r.deptName}`,
          centre: r.centre,
          deptName: r.deptName,
          deployed: r.deployed,
          present: r.everPresent,
          absent: r.neverPresent,
          openNow: r.openNow,
        })),
        totals: {
          deployed: totals.deployed,
          present: totals.everPresent,
          absent: totals.neverPresent,
          openNow: totals.openNow,
        },
        presentLabel: 'scanned on ≥1 day',
      }
    }
    // `buildDailyRows` DROPS rows with no centre, so an unresolved home centre
    // would vanish from the Today view while still counting in the totals.
    // Bucketing it to UNASSIGNED_CENTRE first keeps the row and makes it
    // reachable through the centre filter, matching buildVisitRows.
    const rows = buildDailyRows(
      (rowsAreCurrent ? dailyRaw : []).map((r) => ({ ...r, centre: r?.centre || UNASSIGNED_CENTRE }))
    )
    const t = dailyTotals(rows)
    return {
      rows: rows.map((r) => ({
        key: `${r.centre}::${r.dept_name}`,
        centre: r.centre,
        deptName: r.dept_name || '—',
        deployed: r.expected,
        present: r.present,
        absent: r.absent,
        openNow: r.open_now,
      })),
      totals: { deployed: t.expected, present: t.present, absent: t.absent, openNow: t.open_now },
      presentLabel: `present on ${date || 'the picked day'}`,
    }
  }, [view, visitRaw, dailyRaw, rowsAreCurrent, date])

  const allRows = matrix.rows

  // Department options are derived from the CENTRE-FILTERED rows: building them
  // from the unfiltered set let the operator pick a centre × department pair
  // that can never match, showing 0 rows behind an apparently valid filter.
  // A parent-centre filter matches its whole subtree: picking DELHI keeps
  // DELHI-1's rows. Without this the aggregate would silently drop the
  // children and read as the parent's own numbers.
  const centreFiltered = useMemo(() => {
    if (filterCentre === 'all') return allRows
    return allRows.filter((r) => {
      if (centreMatches(r.centre, filterCentre)) return true
      return rootCentreOf(centresList, r.centre) === filterCentre
    })
  }, [allRows, filterCentre, centresList])
  const depts = useMemo(
    () => [...new Set(centreFiltered.map((r) => r.deptName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [centreFiltered]
  )
  const centres = useMemo(
    () => [...new Set(allRows.map((r) => r.centre).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [allRows]
  )

  // Drop a filter value whose option no longer exists, so the <select> value and
  // the option list can never disagree.
  useEffect(() => {
    if (filterCentre !== 'all' && !centres.includes(filterCentre)) setFilterCentre('all')
  }, [centres, filterCentre])
  // Deep-link entry: App passes the dashboard's centre through on remount
  // (tab switches remount pages). Applies once per distinct value — the
  // appliedRef guard stops realtime reloads (which rebuild the centres array
  // identity) from clobbering a hand-picked filter afterwards. Manual tab
  // clicks clear it in App.
  const appliedCentreRef = useRef(null)
  useEffect(() => {
    if (initialCentre && initialCentre !== appliedCentreRef.current && centres.includes(initialCentre)) {
      appliedCentreRef.current = initialCentre
      setFilterCentre(initialCentre)
    }
  }, [initialCentre, centres])
  useEffect(() => {
    if (filterDept !== 'all' && !depts.includes(filterDept)) setFilterDept('all')
  }, [depts, filterDept])

  // centre → dept → search, in that order, so the option lists stay scoped to
  // what the caller can actually see.
  const visible = useMemo(
    () => centreFiltered
      .filter((r) => filterDept === 'all' || r.deptName === filterDept)
      .filter((r) => matchText(search, r.centre, r.deptName)),
    [centreFiltered, filterDept, search]
  )

  const filtering = filterCentre !== 'all' || filterDept !== 'all' || search.trim() !== ''

  // Departments across the top, in a stable sorted order.
  const deptCols = useMemo(
    () => [...new Set(visible.map((r) => r.deptName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [visible]
  )
  // Parent-centre groups with collapsed aggregates (built over the VISIBLE
  // rows, so the tree always describes the filtered view, never the schedule).
  const tree = useMemo(() => buildCentreTree(visible, centresList), [visible, centresList])
  // Per-department column footers over the same visible rows.
  const deptTotals = useMemo(() => {
    const map = new Map()
    for (const r of visible) {
      const d = r.deptName || '—'
      let c = map.get(d)
      if (!c) {
        c = { deployed: 0, present: 0, absent: 0, openNow: 0 }
        map.set(d, c)
      }
      c.deployed += r.deployed
      c.present += r.present
      c.absent += r.absent
      c.openNow += r.openNow
    }
    return map
  }, [visible])
  const toggleExpand = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  // While a centre filter is active the tree would lie (a collapsed aggregate
  // would hide that it only covers the filtered child), so the view drops to
  // flat centre rows instead. A plain memo here — it must live with the other
  // hooks above the early-return guards, never beside the render helpers.
  const flatCentreView = filterCentre !== 'all'
  const flatRows = useMemo(() => {
    if (!flatCentreView) return null
    const out = []
    for (const g of tree) {
      if (g.own) out.push({ key: `${g.key}::own`, label: g.own.label, entry: g.own })
      for (const c of g.children) out.push({ key: `${g.key}::${c.label}`, label: c.label, entry: c })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }, [flatCentreView, tree])
  // The footers total the VISIBLE rows, so a filtered matrix never presents its
  // own numbers as the schedule's totals.
  const visibleTotals = useMemo(
    () => visible.reduce(
      (t, r) => ({ deployed: t.deployed + r.deployed, present: t.present + r.present, absent: t.absent + r.absent, openNow: t.openNow + r.openNow }),
      { deployed: 0, present: 0, absent: 0, openNow: 0 }
    ),
    [visible]
  )

  /**
   * Badge rows honour the same filter set, but the day_badges RPC carries the
   * sewadar-row field names, so the shared helpers apply here directly.
   */
  const filterBadges = (rows) => searchRows(
    filterByDept(
      filterByCentre(rows, filterCentre, (n) => rootCentreOf(centresList, n)),
      filterDept
    ),
    search
  )

  // ─── Export. Detail sheets honour the active filters; the Summary sheet is
  // always the full schedule, so a filtered download can never be mistaken for
  // the whole picture. ───
  const download = async (mode) => {
    if (!date) {
      toast.warning('Pick a day before downloading')
      return
    }
    setExporting(true)
    setExportKind(mode)
    try {
      const badgeRows = filterBadges(await rpcRows('attendance_day_badges', {
        p_schedule: scheduleId,
        p_date: date,
        p_mode: mode,
      }))
      const summaryRows = buildDailyRows(
        (rowsAreCurrent ? dailyRaw : []).map((r) => ({ ...r, centre: r?.centre || UNASSIGNED_CENTRE }))
      )
      const t = dailyTotals(summaryRows)
      const label = mode === 'present' ? 'Present' : 'Absent'
      // exportWorkbook skips empty sheets and writes nothing when all of them
      // are empty, returning 0 — which is the "nothing to export" case.
      const written = await exportWorkbook(
        `${fileSlug(schedule?.name)}_${date}_${mode}.xlsx`,
        [
          {
            name: `Summary ${date}`,
            rows: [
              ...summaryRows.map((r) => ({
                Centre: r.centre,
                Department: r.dept_name || '—',
                Expected: r.expected,
                Present: r.present,
                Absent: r.absent,
                'Day Attendance %': pct(r.present, r.expected) ?? '—',
              })),
              {
                Centre: 'TOTAL',
                Department: '',
                Expected: t.expected,
                Present: t.present,
                Absent: t.absent,
                'Day Attendance %': pct(t.present, t.expected) ?? '—',
              },
            ],
          },
          {
            name: `${label} list`,
            rows: badgeRows.map((r, i) => ({
              'S.No.': i + 1,
              Centre: r.sewadar_centre || UNASSIGNED_CENTRE,
              Badge: r.badge_number,
              Name: r.sewadar_name,
              Type: r.is_vss ? 'VSS' : 'Regular',
              Department: r.dept_name || '—',
            })),
          },
        ]
      )
      if (!written) {
        toast.warning('Nothing to export')
        return
      }
      // I2: the Summary sheet always carries a TOTAL row, so `written` is
      // never 0 — without this an empty list still toasted a full success
      // and shipped a file with no list sheet in it.
      if (badgeRows.length === 0) {
        toast.warning(`No ${label.toLowerCase()} sewadars — summary exported without a list`)
        return
      }
      toast.success(`${label} list exported`)
    } catch (e) {
      console.error('[Reports] export failed:', e)
      toast.error(e?.message || 'Export failed')
    } finally {
      setExporting(false)
      setExportKind(null)
    }
  }

  // ─── Guards (early returns, so no hooks run after them) ───
  if (!schedules.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }
  if (loading && !allRows.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card"><div className="empty"><div className="spin" style={{ width: 24, height: 24, border: '2px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin .6s linear infinite' }} /><div className="empty-text">Loading reports…</div></div></div>
      </div>
    )
  }

  // An RPC failure is NOT an empty visit. A missing function (PGRST202), an RLS
  // denial or a dropped connection all land here and say so, instead of
  // rendering zeros and "nothing to report". The panel is deliberately FRIENDLY:
  // the raw backend text is not shown to the operator, while `load` still
  // console.errors every failure so the detail stays in devtools.
  if (loadError) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '1.5rem', maxWidth: 720, margin: '0 auto' }} role="alert">
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <AlertTriangle size={18} style={{ color: '#b91c1c' }} />
            <h3 className="empty-title" style={{ margin: 0 }}>Could not load reports</h3>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', margin: 0 }}>
            The attendance reports could not be read from the server.
          </p>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.75rem 0 0' }}>
            The report functions may not be installed on this database, or your role may not be
            permitted to read them. No figures are shown, because none could be loaded.
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

  // One filter set drives the view, both matrices and both downloads, so the
  // "Showing N of M" pill below can stay honest.
  const totalRate = pct(visibleTotals.present, visibleTotals.deployed)
  // I1: the KPI tiles below read the FILTERED totals, so the absent rate is
  // computed on that same filtered set instead of the whole schedule.
  const visibleAbsentRate = pct(visibleTotals.absent, visibleTotals.deployed)
  // ─── Transposed matrix: departments across the top, centres down the
  // side. Parent CENTREs render collapsed (whole-subtree aggregate + child
  // count) until opened, when the aggregate splits into the parent's own row
  // + one row per child. The flat-rows memo lives with the other hooks above.
  // ─── Heat tint: per-cell background wash by attendance rate so the eye
  // finds signal without reading every fraction. Subdued washes only — the
  // numbers stay the source of truth (tests pin the present/deployed text).
  const heatFor = (present, deployed) => {
    if (!deployed) return { band: 'none', style: {} }
    const band = rateBand(Math.round((present / deployed) * 100))
    if (band === 'full') return { band, style: { background: '#f0fdf4' } }
    if (band === 'partial') return { band, style: { background: '#eff6ff' } }
    if (band === 'low') return { band, style: { background: '#fffbeb' } }
    return { band, style: { background: '#fef2f2' } }
  }
  const HEAT_LEGEND = [
    { band: 'full', label: 'All scanned', dot: '#10b981' },
    { band: 'partial', label: 'Half or more', dot: '#3b82f6' },
    { band: 'low', label: 'Some scanned', dot: '#f59e0b' },
    { band: 'none', label: 'None scanned', dot: '#fca5a5' },
  ]
  const BAND_FILL = { full: '#10b981', partial: '#3b82f6', low: '#f59e0b', none: '#e2e8f0' }
  const deptCell = (byDept, d) => {
    const c = byDept.get(d)
    if (!c) {
      return <td key={d} data-label={d} style={{ textAlign: 'center', color: '#cbd5e1' }}>—</td>
    }
    const heat = heatFor(c.present, c.deployed)
    return (
      <td key={d} data-label={d} data-band={heat.band} title={`${c.present} of ${c.deployed} scanned`} style={{ textAlign: 'center', whiteSpace: 'nowrap', ...heat.style }}>
        <span style={{ fontWeight: 700 }}>{c.present}</span>
        <span style={{ color: '#94a3b8' }}>/{c.deployed}</span>
      </td>
    )
  }

  const tailCells = (t, keyPrefix) => {
    const rate = pct(t.present, t.deployed)
    return (
      <>
        <td key={`${keyPrefix}-t`} data-label="Total" style={{ textAlign: 'center', whiteSpace: 'nowrap', borderLeft: '2px solid #cbd5e1', background: '#f8fafc' }}>
          <span style={{ fontWeight: 700 }}>{t.present}</span>
          <span style={{ color: '#94a3b8' }}>/{t.deployed}</span>{' '}
          <span className={`pill ${bandPill(rateBand(rate ?? 0))}`}>{rateLabel(rate)}</span>
        </td>
        <td key={`${keyPrefix}-a`} data-label="Absent" style={{ textAlign: 'center', fontWeight: t.absent ? 700 : undefined, color: t.absent ? '#b91c1c' : undefined }}>{t.absent}</td>
        <td
          key={`${keyPrefix}-o`}
          data-label="Open now"
          style={{ textAlign: 'center', color: t.openNow ? '#b45309' : undefined }}
        >
          {t.openNow}
        </td>
      </>
    )
  }

  const centreLabelCell = (label, { childCount = 0, isOpen = false, onToggle = null, indent = false } = {}) => (
    <td
      data-label="Centre"
      style={{
        position: 'sticky', left: 0, background: '#fff', zIndex: 1,
        paddingLeft: indent ? '1.75rem' : undefined,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label}`}
            style={{ background: 'none', border: 0, padding: '0.1rem', cursor: 'pointer', color: '#64748b', display: 'inline-flex' }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : null}
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate('reports', { centre: label })}
            title={`Filter to ${label}`}
            style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: '#4f46e5', cursor: 'pointer', textAlign: 'left', fontWeight: indent ? 400 : 600 }}
          >
            {label}
          </button>
        ) : (
          <span style={{ fontWeight: indent ? 400 : 600 }}>{label}</span>
        )}
        {childCount > 0 ? (
          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 600 }}>(+{childCount})</span>
        ) : null}
      </span>
    </td>
  )

  const matrixCard = () => (
    <div className="card">
      <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
        <div className="section-title">
          <BarChart3 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} />
          Centre × department matrix
        </div>
      </div>
      {/* ── Department summary: department-wise counts above, centre rows below.
          Divs only (never a <table>): the suite queries tables document-wide. */}
      <div data-testid="dept-strip" style={{ padding: '0.9rem 1.25rem 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b' }}>Departments</span>
          <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{deptCols.length} departments · {visibleTotals.present} of {visibleTotals.deployed} scanned</span>
          <span className={`pill ${bandPill(rateBand(totalRate ?? 0))}`} style={{ marginLeft: 'auto' }}>{rateLabel(totalRate)} overall</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
          {deptCols.map((d) => {
            const c = deptTotals.get(d) || { deployed: 0, present: 0, absent: 0 }
            const rate = pct(c.present, c.deployed)
            const heat = heatFor(c.present, c.deployed)
            return (
              <div key={d} data-band={heat.band} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.65rem', ...heat.style }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.78rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d}>{d}</span>
                  <span className={`pill ${bandPill(rateBand(rate ?? 0))}`} style={{ marginLeft: 'auto', fontSize: '0.62rem' }}>{rateLabel(rate)}</span>
                </div>
                <div style={{ marginTop: '0.15rem', fontVariantNumeric: 'tabular-nums', fontSize: '0.85rem' }}>
                  <span style={{ fontWeight: 800 }}>{c.present}</span>
                  <span style={{ color: '#64748b' }}> of {c.deployed} scanned</span>
                </div>
                <div style={{ height: 6, borderRadius: 999, background: '#eef2f7', marginTop: '0.35rem', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 999, background: BAND_FILL[heat.band], width: `${rate ?? 0}%` }} />
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.6rem', fontSize: '0.7rem', color: '#64748b' }}>
          {HEAT_LEGEND.map((l) => (
            <span key={l.band} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: l.dot, flexShrink: 0 }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      {tree.length === 0 ? (
        <div className="empty">
          <div className="empty-title">Nothing to show</div>
          <div className="empty-text">{filtering ? 'Try clearing the filters.' : 'No deployed sewadars for this schedule yet.'}</div>
        </div>
      ) : (
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0, padding: '0 1.25rem 1.25rem' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, top: 0, background: '#fff', zIndex: 3 }}>Centre</th>
                {deptCols.map((d) => <th key={d} title={d} style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', maxWidth: 130, whiteSpace: 'normal' }}>{d}</th>)}
                <th style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', borderLeft: '2px solid #cbd5e1', background: '#eef2ff', color: '#4f46e5' }}>Total</th>
                <th style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', background: '#eef2ff', color: '#4f46e5' }}>Absent</th>
                <th style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', background: '#eef2ff', color: '#4f46e5' }}>Open now</th>
              </tr>
            </thead>
            <tbody>
              {flatCentreView
                ? flatRows.map((r) => (
                  <tr key={r.key}>
                    {centreLabelCell(r.label, {})}
                    {deptCols.map((d) => deptCell(r.entry.byDept, d))}
                    {tailCells(r.entry.total, r.key)}
                  </tr>
                ))
                : tree.map((g) => {
                  const isOpen = expanded.has(g.key)
                  if (!g.isParent) {
                    const entry = g.own || { byDept: new Map(), total: { deployed: 0, present: 0, absent: 0, openNow: 0 } }
                    return (
                      <tr key={g.key}>
                        {centreLabelCell(g.label, {})}
                        {deptCols.map((d) => deptCell(entry.byDept, d))}
                        {tailCells(entry.total, g.key)}
                      </tr>
                    )
                  }
                  if (!isOpen) {
                    return (
                      <tr key={g.key} style={{ borderTop: '2px solid #e2e8f0' }}>
                        {centreLabelCell(g.label, { childCount: g.childCount, isOpen: false, onToggle: () => toggleExpand(g.key) })}
                        {deptCols.map((d) => deptCell(g.byDept, d))}
                        {tailCells(g.total, g.key)}
                      </tr>
                    )
                  }
                  const rows = []
                  if (g.own) {
                    rows.push(
                      <tr key={`${g.key}::own`} style={{ borderTop: '2px solid #e2e8f0' }}>
                        {centreLabelCell(g.label, { isOpen: true, onToggle: () => toggleExpand(g.key) })}
                        {deptCols.map((d) => deptCell(g.own.byDept, d))}
                        {tailCells(g.own.total, `${g.key}::own`)}
                      </tr>
                    )
                  } else {
                    rows.push(
                      <tr key={`${g.key}::own-empty`} style={{ borderTop: '2px solid #e2e8f0' }}>
                        {centreLabelCell(g.label, { isOpen: true, onToggle: () => toggleExpand(g.key) })}
                        {deptCols.map((d) => (
                          <td key={d} data-label={d} style={{ textAlign: 'center', color: '#cbd5e1' }}>—</td>
                        ))}
                        {tailCells({ deployed: 0, present: 0, absent: 0, openNow: 0 }, `${g.key}::own-empty`)}
                      </tr>
                    )
                  }
                  for (const c of g.children) {
                    rows.push(
                      <tr key={`${g.key}::${c.label}`}>
                        {centreLabelCell(c.label, { indent: true })}
                        {deptCols.map((d) => deptCell(c.byDept, d))}
                        {tailCells(c.total, `${g.key}::${c.label}`)}
                      </tr>
                    )
                  }
                  return rows
                })}
              <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                <td style={{ fontWeight: 800 }}>TOTAL</td>
                {deptCols.map((d) => {
                  const c = deptTotals.get(d) || { deployed: 0, present: 0, absent: 0 }
                  return (
                    <td key={d} data-label={d} style={{ textAlign: 'center', fontWeight: 800, whiteSpace: 'nowrap' }}>
                      <span>{c.present}</span>
                      <span style={{ color: '#94a3b8' }}>/{c.deployed}</span>
                    </td>
                  )
                })}
                <td data-label="Total" style={{ textAlign: 'center', fontWeight: 800, whiteSpace: 'nowrap', borderLeft: '2px solid #cbd5e1' }}>
                  <span>{visibleTotals.present}</span>
                  <span style={{ color: '#94a3b8' }}>/{visibleTotals.deployed}</span>{' '}
                  <span className={`pill ${bandPill(rateBand(totalRate ?? 0))}`}>{rateLabel(totalRate)}</span>
                </td>
                <td data-label="Absent" style={{ textAlign: 'center', fontWeight: 800 }}>{visibleTotals.absent}</td>
                <td data-label="Open now" style={{ textAlign: 'center', fontWeight: 800, color: visibleTotals.openNow ? '#b45309' : undefined }}>{visibleTotals.openNow}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><BarChart3 size={22} /> Reports</h2>
          <div className="page-sub">Deployment and attendance roll-ups, by department and by centre · WED – SUN visit</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" title="Reports are read-only here — scans are recorded on the Scanner and Dept Incharge pages" style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={() => download('present')} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting && exportKind === 'present' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download Present
            </button>
            <button onClick={() => download('absent')} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting && exportKind === 'absent' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download Absent
            </button>
            {filtering && (
                <span className="pill pill-indigo" title="The matrix and the downloaded detail lists show this filtered set">
                Showing {visible.length} of {allRows.length}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Report day</div>
          <input
            type="date"
            value={date}
            onChange={(e) => { dateTouchedRef.current = true; setDate(e.target.value) }}
            className="input"
            style={{ height: 36 }}
            aria-label="Report day"
            aria-invalid={!date || undefined}
          />
          {!date && (
            <div role="alert" style={{ fontSize: '0.72rem', color: '#b91c1c', marginTop: '0.25rem', maxWidth: 220 }}>
              Pick a report day — the date is empty, so the Today view and the downloads cannot load.
            </div>
          )}
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Deployed</div>
          <div className="stat-value">{visibleTotals.deployed}</div>
          <div className="stat-sub">{filtering ? `of ${matrix.totals.deployed} overall` : (view === 'visit' ? 'across the whole visit' : `expected on ${date || 'the picked day'}`)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Present</div>
          <div className="stat-value">{visibleTotals.present}</div>
          <div className="stat-sub">{matrix.presentLabel}{filtering ? ' · filtered view' : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Absent</div>
          <div className="stat-value">{visibleTotals.absent}</div>
          <div className="stat-sub">{view === 'visit' ? 'never scanned' : `missing on ${date || 'the picked day'}`}{filtering ? ' · filtered view' : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open now</div>
          <div className="stat-value" style={{ color: visibleTotals.openNow ? '#b45309' : undefined }}>{visibleTotals.openNow}</div>
          <div className="stat-sub">IN, not yet OUT{filtering ? ' · filtered view' : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Absent rate</div>
          <div className="stat-value" style={{ color: visibleAbsentRate > 0 ? '#b91c1c' : undefined }}>{rateLabel(visibleAbsentRate)}</div>
          <div className="stat-sub">of {visibleTotals.deployed} deployed{filtering ? ' · filtered view' : ''}</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {[
              { key: 'visit', label: 'Visit' },
              { key: 'today', label: 'Today' },
            ].map((t) => (
              <button key={t.key} onClick={() => setView(t.key)} className={`seg-btn ${view === t.key ? 'seg-active' : ''}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
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
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search centre / department..." className="input" style={{ width: '100%', paddingLeft: 30 }} aria-label="Search reports" />
          </div>
        </div>
      </div>

      {allRows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No attendance records</div>
            <div className="empty-text">
              {view === 'today' && !date
                ? 'Pick a report day above.'
                : view === 'today'
                  ? 'No deployments were expected on this day, or none have been scanned.'
                  : 'No sewadars have been deployed for this schedule yet.'}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {matrixCard()}
        </div>
      )}

      <div className="page-sub" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <Radio size={13} />
        Visit days: {VISIT_DAYS.join(' · ')} · scope is enforced by the database for your role
      </div>
    </div>
  )
}
