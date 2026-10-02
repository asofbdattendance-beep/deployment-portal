import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
// `exportWorkbook` runs every sheet name through `sheetName` internally (≤31
// chars, no \ / * ? : [ ]), so one sheet per centre needs no extra trimming.
import { exportWorkbook, exportWorkbookBlob, fileSlug } from '../lib/excel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useExport } from '../hooks/useExport'
import ExportSheet from '../components/mobile/ExportSheet'
import { shortDayLabel } from '../lib/attendance'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import { todayStrIST, withTimeout } from '../lib/scannerUtils'
import {
  FileText, Download, Printer, Search,
  RefreshCw, Loader2, AlertTriangle, Lock, Users,
} from 'lucide-react'

/**
 * Unwrap a supabase-js PostgREST result.
 *
 * supabase-js RESOLVES with `{ error }` on a failed RPC — it does not reject —
 * so a `.catch(() => [])` chain silently turns "function does not exist"
 * (PGRST202), an RLS/permission denial or a dropped connection into an empty
 * array, and a broken database then looks exactly like a day nobody attended.
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
 * Normalize one `attendance_day_badges` row to the shape this page renders,
 * exports and prints. The RPC returns `sewadar_centre` (the sewadar's HOME
 * centre) — `dp_attendance_sessions.centre` (the single physical scan venue)
 * is never read here.
 *
 * @param {object} r raw RPC row
 * @returns {{badge_number:string,sewadar_name:string,centre:string,dept:string,is_vss:boolean}}
 */
function normalizeBadgeRow(r) {
  return {
    badge_number: r?.badge_number ?? r?.badge ?? '',
    sewadar_name: r?.sewadar_name ?? r?.name ?? '',
    centre: r?.sewadar_centre ?? r?.centre ?? '',
    dept: r?.dept_name ?? r?.department ?? '',
    is_vss: !!r?.is_vss,
  }
}

/** Dedup key for the Complete list: one row per centre × badge. */
function badgeKey(r) {
  return `${r.centre}|${r.badge_number}`
}

/** Sort: centre → name → badge, so every tab reads the same order. */
function compareBadgeRows(a, b) {
  const c = String(a.centre || '').localeCompare(String(b.centre || ''))
  if (c !== 0) return c
  const n = String(a.sewadar_name || '').localeCompare(String(b.sewadar_name || ''))
  if (n !== 0) return n
  return String(a.badge_number || '').localeCompare(String(b.badge_number || ''))
}

/**
 * Case-insensitive substring match across badge / name / centre / dept.
 * @param {object} r normalized row
 * @param {string} term raw search input
 * @returns {boolean}
 */
function matchesSearch(r, term) {
  const q = String(term || '').trim().toLowerCase()
  if (!q) return true
  return [r.badge_number, r.sewadar_name, r.centre, r.dept]
    .some((f) => String(f || '').toLowerCase().includes(q))
}

/**
 * Reports — shared day-wise present / absent lists over `attendance_day_badges`.
 *
 * SCOPE IS ENFORCED SERVER-SIDE, exactly as on AttendancePage: the RPC
 * resolves the caller's own scope inside the function and returns zero rows
 * for a role it does not cover, so this page never filters by role. Do NOT
 * add a client-side role filter — it would only mask a DB scope bug.
 *
 * Read-only for every role (View-only pill): aso / super_admin get a
 * "Download Excel" export, every other role gets a "Print PDF" button that
 * prints the per-centre `.centre-page` sections.
 */
export default function ReportsPage({ schedules = [], scheduleId, onNavigate, initialCentre }) {
  const toast = useToast()
  const { profile } = usePortalAuth()
  const schedule = schedules.find((s) => s.id === scheduleId)
  const canExport = profile?.role === 'aso' || profile?.role === 'super_admin'

  const [tab, setTab] = useState('complete') // complete | present | absent
  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  // Bhati Visit shows visit-days data only: pin the picker inside the
  // window (windowless schedules pass through untouched).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])
  const [presentRaw, setPresentRaw] = useState([])
  const [absentRaw, setAbsentRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState(initialCentre || 'all')
  // Per-RPC errors, not one all-or-nothing flag: a present-list failure must
  // not blank the absent list (and vice versa) — a partial outage must never
  // read as "nobody came".
  const [presentErr, setPresentErr] = useState(null)
  const [absentErr, setAbsentErr] = useState(null)
  // Which schedule AND date the rows in state actually belong to. Rows from
  // the previous schedule — or the previous date — must never be shown (or
  // exported) under the new one. Stamped on success AND on failure (a failed
  // load leaves empty rows that still belong to what was asked for).
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const [rowsDate, setRowsDate] = useState(null)
  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load for date A must
  // not overwrite a fast load for date B.
  const seqRef = useRef(0)
  // Once the operator picks a day by hand, window-focus must stop moving it.
  const dateTouchedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (initialCentre) setFilterCentre(initialCentre)
  }, [initialCentre])

  // `todayStrIST()` was evaluated once at mount, so a page left open across
  // IST midnight would show yesterday until a manual refresh. Re-sync on
  // mount and on window focus — no busy interval. A day the operator chose
  // is left alone.
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

  // ─── Load. The two modes are independent, so fire them together. ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      // Never send an empty p_date — Postgres rejects '' with "invalid input
      // syntax for type date" and the result would look like a day with no
      // data. Both arms resolve empty and an inline message is rendered.
      if (!date) {
        if (mountedRef.current && seq === seqRef.current) {
          setPresentRaw([])
          setAbsentRaw([])
          setPresentErr(null)
          setAbsentErr(null)
          setRowsScheduleId(scheduleId)
          setRowsDate(date)
          setLoading(false)
        }
        return
      }
      // Every RPC races a 15s timeout so a hung connection degrades to the
      // error panel instead of a permanent spinner.
      const [presentR, absentR] = await Promise.allSettled([
        withTimeout(rpcRows('attendance_day_badges', { p_schedule: scheduleId, p_date: date, p_mode: 'present' }), 15000, 'attendance_day_badges:present'),
        withTimeout(rpcRows('attendance_day_badges', { p_schedule: scheduleId, p_date: date, p_mode: 'absent' }), 15000, 'attendance_day_badges:absent'),
      ])
      // Drop a stale response that landed after a newer one.
      if (!mountedRef.current || seq !== seqRef.current) return
      // allSettled, not all: with `all` a single failure hides the healthy
      // arm, so a partial outage reads as one vague error. Each arm settles
      // independently; a rejection keeps the previous rows for that arm
      // rather than blanking healthy data.
      if (presentR.status === 'fulfilled') {
        setPresentRaw(presentR.value)
        setPresentErr(null)
      } else {
        console.error('[Reports] present load failed:', presentR.reason)
        setPresentErr(presentR.reason?.message || 'Unknown error')
        toast.error('Could not load present list')
      }
      if (absentR.status === 'fulfilled') {
        setAbsentRaw(absentR.value)
        setAbsentErr(null)
      } else {
        console.error('[Reports] absent load failed:', absentR.reason)
        setAbsentErr(absentR.reason?.message || 'Unknown error')
        toast.error('Could not load absent list')
      }
      setRowsScheduleId(scheduleId)
      setRowsDate(date)
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date, toast])

  useEffect(() => { load() }, [load])

  // ─── Derived rows ───
  const present = useMemo(
    () => presentRaw.map(normalizeBadgeRow).map((r) => ({ ...r, status: 'Present' })).sort(compareBadgeRows),
    [presentRaw],
  )
  const absent = useMemo(
    () => absentRaw.map(normalizeBadgeRow).map((r) => ({ ...r, status: 'Absent' })).sort(compareBadgeRows),
    [absentRaw],
  )
  // Complete = deduped union keyed centre|badge, Status from the present set:
  // a badge in both arms (should not happen — present + absent == deployed)
  // reads as Present, never twice.
  const complete = useMemo(() => {
    const map = new Map()
    for (const r of present) map.set(badgeKey(r), r)
    for (const r of absent) {
      if (!map.has(badgeKey(r))) map.set(badgeKey(r), r)
    }
    return [...map.values()].sort(compareBadgeRows)
  }, [present, absent])

  const centres = useMemo(() => {
    const set = new Set()
    for (const r of complete) {
      if (r.centre) set.add(r.centre)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [complete])

  const applyFilters = useCallback((rows) => rows.filter(
    (r) => (filterCentre === 'all' || r.centre === filterCentre) && matchesSearch(r, search),
  ), [filterCentre, search])

  const filteredComplete = useMemo(() => applyFilters(complete), [applyFilters, complete])
  const filteredPresent = useMemo(() => applyFilters(present), [applyFilters, present])
  const filteredAbsent = useMemo(() => applyFilters(absent), [applyFilters, absent])
  const activeRows = tab === 'present' ? filteredPresent : tab === 'absent' ? filteredAbsent : filteredComplete
  const tabLabel = tab === 'present' ? 'Present' : tab === 'absent' ? 'Absent' : 'Complete List'

  // Rows are current only when stamped for this exact schedule + date. While
  // a new schedule/date loads, the skeleton replaces the stale table — the
  // old rows (and the export button) must never appear under the new key.
  const rowsAreCurrent = rowsScheduleId === scheduleId && rowsDate === date

  // One sheet per centre for the export; the print-only section groups the
  // same active rows the same way.
  const groupsByCentre = useMemo(() => {
    const map = new Map()
    for (const r of activeRows) {
      const c = r.centre || 'Unassigned'
      if (!map.has(c)) map.set(c, [])
      map.get(c).push(r)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [activeRows])

  const toSheetRow = (r) => ({
    Badge: r.badge_number,
    Name: r.sewadar_name,
    Centre: r.centre,
    Dept: r.dept,
    Type: r.is_vss ? 'VSS' : 'Regular',
    Status: r.status,
  })

  const exportFilename = `${fileSlug(schedule?.name ?? 'schedule')}_${date}_${tab}.xlsx`
  // Sheet rows are built WITHOUT saving so desktop (direct download) and
  // mobile (share sheet) share one builder — the two paths can never drift.
  const buildExportSheets = () => groupsByCentre.map(([centre, rows]) => ({
    name: centre,
    rows: rows.map(toSheetRow),
  }))

  const isMobile = useIsMobile()

  const handleExport = async () => {
    if (!rowsAreCurrent) {
      toast.warning('Reports are still loading — try again in a moment')
      return
    }
    if (activeRows.length === 0) {
      toast.warning(`Nothing to export — no ${tabLabel.toLowerCase()} rows match the current filters`)
      return
    }
    // Mobile: same builder, delivered through the share sheet.
    if (isMobile) { await onExportPress(); return }
    setExporting(true)
    try {
      const written = await exportWorkbook(exportFilename, buildExportSheets())
      if (written === 0) {
        toast.warning('Nothing to export — no rows match the current filters')
      } else {
        toast.success(`${tabLabel} list exported`)
      }
    } catch (e) {
      console.error('[Reports] export failed:', e)
      toast.error('Export failed')
    } finally {
      if (mountedRef.current) setExporting(false)
    }
  }

  // Mobile export delivery (share sheet + save fallback). Desktop keeps the
  // direct download above.
  const mobileExport = useExport()
  const [exportSheetOpen, setExportSheetOpen] = useState(false)
  const onExportPress = async () => {
    setExportSheetOpen(true)
    await mobileExport.prepare(async () => {
      const { blob, written } = await exportWorkbookBlob(exportFilename, buildExportSheets())
      if (!written) return null
      return { blob, filename: exportFilename }
    })
  }

  const filtering = filterCentre !== 'all' || String(search || '').trim() !== ''

  if (!scheduleId) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card">
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No schedule selected</div>
            <div className="empty-text">Pick a schedule to view its day-wise reports.</div>
          </div>
        </div>
      </div>
    )
  }

  // New schedule/date still loading: skeleton, not the previous key's rows.
  if (loading && !rowsAreCurrent) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card">
          <div className="empty">
            <div className="empty-icon"><Loader2 size={22} className="spin" /></div>
            <div className="empty-title">Loading reports…</div>
          </div>
        </div>
      </div>
    )
  }

  const renderTable = (rows) => (
    <div className="table-wrap table-wrap-sticky">
      <table className="table table-sticky">
        <caption className="sr-only">Report rows</caption>
        <thead>
          <tr>
            <th>Badge</th>
            <th>Name</th>
            <th>Centre</th>
            <th>Dept</th>
            <th>Type</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={badgeKey(r)}>
              <td data-label="Badge" style={{ fontFamily: 'monospace' }}>{r.badge_number}</td>
              <td data-label="Name">{r.sewadar_name || '—'}</td>
              <td data-label="Centre">{r.centre || '—'}</td>
              <td data-label="Dept">{r.dept || '—'}</td>
              <td data-label="Type">{r.is_vss ? 'VSS' : 'Regular'}</td>
              <td data-label="Status">{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const emptyForTab = tab === 'present'
    ? { title: 'No present sewadars', text: date ? `No scans were recorded on ${shortDayLabel(date)}.` : 'Pick a report day above.' }
    : tab === 'absent'
      ? { title: 'No absent sewadars', text: date ? `Everyone deployed was scanned on ${shortDayLabel(date)}.` : 'Pick a report day above.' }
      : { title: 'No attendance records', text: !date ? 'Pick a report day above.' : 'No sewadars were deployed for this schedule, or none match the current filters.' }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header print-hide" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><FileText size={22} /> Reports</h2>
          <div className="page-sub">Day-wise present / absent lists{schedule ? ` · ${schedule.name}` : ''} · scope is enforced by the database for your role</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" title="Read-only — this page never writes attendance" style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            {onNavigate && (
              <button onClick={() => onNavigate?.()} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                Back
              </button>
            )}
            {canExport ? (
              <button onClick={handleExport} disabled={exporting || mobileExport.building || loading || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
                {exporting || mobileExport.building ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download Excel
              </button>
            ) : (
              <button onClick={() => window.print()} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
                <Printer size={13} /> Print PDF
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card print-hide" style={{ padding: '1.25rem' }}>
        <div className="previsit-toolbar" role="search" style={{ marginBottom: 0 }}>
          <div className="previsit-tabs" role="tablist" aria-label="Report lists">
            {[
              { key: 'complete', label: `Complete List (${filteredComplete.length})` },
              { key: 'present', label: `Present (${filteredPresent.length})` },
              { key: 'absent', label: `Absent (${filteredAbsent.length})` },
            ].map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`seg-btn ${tab === t.key ? 'seg-active' : ''}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="previsit-field">
            <span className="previsit-label">Scan day</span>
            <input
              type="date"
              value={date}
              min={visitWin.start || undefined}
              max={visitWin.end || undefined}
              onChange={(e) => { dateTouchedRef.current = true; setDate(clampDateToWindow(e.target.value, visitWin)) }}
              aria-label="Report day"
              className="input previsit-control"
            />
          </div>
          <div className="previsit-field">
            <span className="previsit-label">Centre</span>
            <select value={filterCentre} onChange={(e) => setFilterCentre(e.target.value)} className="select previsit-control" aria-label="Filter by centre">
              <option value="all">All centres</option>
              {centres.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="previsit-field previsit-field--search">
            <span className="previsit-label">Search</span>
            <span className="previsit-search">
              <Search size={14} aria-hidden="true" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search badge / name / dept..." className="input previsit-control" aria-label="Search reports" />
            </span>
          </div>
        </div>
      </div>

      {presentErr && (
        <div className="card" role="alert">
          <div className="error-message"><AlertTriangle size={14} /> Could not load present list: {presentErr}</div>
        </div>
      )}
      {absentErr && (
        <div className="card" role="alert">
          <div className="error-message"><AlertTriangle size={14} /> Could not load absent list: {absentErr}</div>
        </div>
      )}

      <div className="card">
        <div className="previsit-count" style={{ marginBottom: '0.5rem' }} aria-live="polite">
          Showing {activeRows.length} of {complete.length} sewadars
        </div>
        {activeRows.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">{emptyForTab.title}</div>
            <div className="empty-text">
              {filtering ? 'Try clearing the filters.' : emptyForTab.text}
            </div>
            {filtering && (
              <button type="button" className="btn" style={{ marginTop: '0.75rem' }} onClick={() => { setFilterCentre('all'); setSearch('') }}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div role="tabpanel" aria-label={tabLabel}>
            {renderTable(activeRows)}
          </div>
        )}
      </div>

      {/* Print-only paged output for roles without the Excel export: one
          page per centre (`.centre-page` page-breaks live in index.css), so
          "Print PDF" from the browser dialog yields a per-centre workbook. */}
      <div className="print-only">
        {groupsByCentre.map(([centre, rows]) => (
          <section key={centre} className="centre-page">
            <h3>{centre} — {tabLabel} — {shortDayLabel(date)}</h3>
            <table className="table">
              <caption className="sr-only">Report rows</caption>
              <thead>
                <tr>
                  <th>Badge</th>
                  <th>Name</th>
                  <th>Centre</th>
                  <th>Dept</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={badgeKey(r)}>
                    <td data-label="Badge">{r.badge_number}</td>
                    <td data-label="Name">{r.sewadar_name || '—'}</td>
                    <td data-label="Centre">{r.centre || '—'}</td>
                    <td data-label="Dept">{r.dept || '—'}</td>
                    <td data-label="Type">{r.is_vss ? 'VSS' : 'Regular'}</td>
                    <td data-label="Status">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>

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
