import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { scannerStatus, timeAgo, UNASSIGNED_CENTRE, shortDayLabel } from '../lib/attendance'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import { todayStrIST } from '../lib/scannerUtils'
import { exportWorkbook, exportWorkbookBlob, fileSlug } from '../lib/excel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useExport } from '../hooks/useExport'
import ExportSheet from '../components/mobile/ExportSheet'
import PrintPdfButton from '../components/PrintPdfButton'
import FilterSheet, { MobileFilterBar } from '../components/mobile/FilterSheet'
import Skeleton from '../components/mobile/Skeleton'
import VirtualList from '../components/mobile/VirtualList'
import {
  Radio, Users, ScanLine, Clock, Download, Search, RefreshCw, Loader2,
  AlertTriangle, Lock, ChevronRight, ChevronDown, ArrowLeft,
} from 'lucide-react'
import { reportRealtimeStatus } from '../lib/realtime'

// Live-scanner verdict → pill colour. One place, used by the table and the
// export so the sheet can never disagree with the screen. 'scanned' is a valid
// scan on a NON-today date — a neutral grey pill with the last-scan clock,
// never the amber Idle: amber means "went quiet today", which is the wrong
// claim for a past/future visit day.
const STATUS_PILL = { active: 'pill-green', idle: 'pill-amber', scanned: 'pill-gray', offline: 'pill-gray' }
const STATUS_LABEL = { active: 'Active', idle: 'Idle', offline: 'Offline' }
const STATUS_RANK = { active: 0, idle: 1, scanned: 2, offline: 3 }
const statusPill = (s) => STATUS_PILL[s] || STATUS_PILL.offline
const statusLabel = (s, lastScanTime) => (s === 'scanned' ? `Scanned ${clock(lastScanTime)}` : (STATUS_LABEL[s] || STATUS_LABEL.offline))

/**
 * Unwrap a supabase-js PostgREST result.
 *
 * supabase-js RESOLVES with `{ error }` on a failed RPC — it does not reject —
 * so a `.catch(() => [])` chain silently turns "function does not exist"
 * (PGRST202), an RLS denial or a dropped connection into an empty array, and a
 * broken database would look exactly like "every scanner went offline". This
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

/** 'HH:MM:SS' → 'HH:MM', '—' for anything missing or unparseable. */
const clock = (t) => (typeof t === 'string' && t.length >= 5 ? t.slice(0, 5) : '—')

/** `2026-09-23T09:52:00+05:30` → ms. NaN when either half is missing. */
const istMs = (dateStr, timeStr) => {
  if (!dateStr || !timeStr) return NaN
  const t = Date.parse(`${dateStr}T${timeStr}+05:30`)
  return Number.isFinite(t) ? t : NaN
}

const scannerName = (r) => r?.scanner_name || r?.scanner_badge || 'Unnamed scanner'

/**
 * Live Scanners — read-only live view of who is scanning right now.
 *
 * Reads two RPCs and nothing else; no table is queried directly.
 * `attendance_scanner_ops` gives the per-scanner rollup for a scan day, and
 * `attendance_scanner_open` lists the sessions a single scanner still has OPEN.
 * Both resolve the caller's own scope inside the function, so — exactly like
 * AttendancePage — this page never filters by role: it renders what the
 * database returns. aso / super_admin see every scanner, centre roles their
 * subtree, and every other role receives zero rows (fail-closed). Do NOT add a
 * client-side role gate; it would only mask a DB scope bug.
 */
export default function LiveScannersPage({ schedules, scheduleId, onNavigate }) {
  const toast = useToast()
  const schedule = schedules?.find((s) => s.id === scheduleId)

  const [date, setDate] = useState(() => clampDateToWindow(todayStrIST(), scheduleWindow(schedule)))
  // Bhati Visit shows visit-days data only: pin the picker inside the
  // window (windowless schedules pass through untouched).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])
  const [raw, setRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState('')
  // A failed FIRST load has nothing to fall back on → full error panel. A failed
  // REFRESH keeps the rows we already have and sets `stale`; see the catch.
  const [loadError, setLoadError] = useState(null)
  const [stale, setStale] = useState(false)
  // Which schedule the rows in state actually belong to, so the previous
  // schedule's table is never rendered (or exported) under the new one.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  // Ticks once a minute: the Active/Idle verdict and the freshness label are
  // functions of the CLOCK, not of the data.
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(null)
  const [openState, setOpenState] = useState({})
  // I5: mirrors `expanded` for the load() closure below — an expanded panel
  // must re-fetch when the list reloads, or closed sessions stay listed after
  // the scanner row itself updates to Open 0.
  const expandedRef = useRef(null)
  useEffect(() => { expandedRef.current = expanded }, [expanded])

  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load for date A must
  // not overwrite a fast load for date B.
  const seqRef = useRef(0)
  // Per-badge sequence for the drill-down, so two scanners opened in quick
  // succession cannot overwrite each other.
  const openSeqRef = useRef({})
  // Whether a successful load has ever landed. A refresh failure with rows
  // already on screen is a staleness problem; without rows it is a hard error.
  const hasDataRef = useRef(false)
  // Once the operator picks a scan day by hand, window-focus must stop moving it.
  const dateTouchedRef = useRef(false)

  // `todayStrIST()` was evaluated once at mount, so a page left open across IST
  // midnight would show yesterday until a manual refresh. Re-sync on mount and
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

  // ─── Drill-down: one scanner's still-OPEN sessions ───
  // (declared before load: load re-fetches the expanded panel after every
  // successful refresh — I5 — so it reads this through its deps.)
  const fetchOpen = useCallback(async (badge) => {
    if (!scheduleId) return
    const seq = (openSeqRef.current[badge] || 0) + 1
    openSeqRef.current[badge] = seq
    setOpenState((s) => ({ ...s, [badge]: { loading: true, rows: s[badge]?.rows || [], error: null } }))
    try {
      const rows = await rpcRows('attendance_scanner_open', {
        p_schedule: scheduleId,
        p_scanner_badge: badge,
      })
      if (!mountedRef.current || seq !== openSeqRef.current[badge]) return
      setOpenState((s) => ({ ...s, [badge]: { loading: false, rows, error: null } }))
    } catch (e) {
      if (!mountedRef.current || seq !== openSeqRef.current[badge]) return
      console.error('[LiveScanners] open-sessions load failed:', e)
      // Friendly, and local to this panel: the scanner list above is still good.
      setOpenState((s) => ({ ...s, [badge]: { loading: false, rows: [], error: 'Could not load open sessions' } }))
    }
  }, [scheduleId])

  // ─── Load ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      // Never send an empty p_date — Postgres rejects '' with "invalid input
      // syntax for type date" and the result would look like a day on which
      // nobody scanned. The RPC is skipped entirely and an inline message is
      // rendered instead.
      if (!date) {
        setRaw([])
        setRowsScheduleId(scheduleId)
        setLoadError(null)
        setStale(false)
        setLoadedAt(null)
        return
      }
      const rows = await rpcRows('attendance_scanner_ops', { p_schedule: scheduleId, p_date: date })
      if (!mountedRef.current || seq !== seqRef.current) return
      setRaw(rows)
      setRowsScheduleId(scheduleId)
      setLoadError(null)
      setStale(false)
      setLoadedAt(Date.now())
      hasDataRef.current = true
      // I5: the list just refreshed — an expanded drill-down panel holds the
      // previous generation's rows. Re-fetch it (fetchOpen preserves existing
      // rows while loading, so there is no flicker to empty).
      if (expandedRef.current) fetchOpen(expandedRef.current)
    } catch (e) {
      if (!mountedRef.current || seq !== seqRef.current) return
      // The panel shown to the operator is friendly on purpose; the detail is
      // logged so it stays recoverable without exposing SQL/RLS internals.
      console.error('[LiveScanners] load failed:', e)
      if (hasDataRef.current) {
        // Rows already on screen are still true as of `loadedAt`. Dropping them
        // on a dropped connection would read as "every scanner went offline",
        // which is a materially different — and wrong — claim.
        setStale(true)
      } else {
        setLoadError(e?.message || 'Unknown error')
        setRaw([])
      }
      setRowsScheduleId(scheduleId)
      toast.error('Could not load scanner activity')
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date, toast, fetchOpen])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // Freshness tick: re-derives the Active/Idle verdicts and the "Updated Ns ago"
  // label without spending an RPC. A scanner that has gone quiet decays from
  // Active to Idle on the screen even though no new scan arrived.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // A schedule change invalidates everything: the rows on screen, the rows we
  // could fall back on, and any open drill-down (its sessions belong to the
  // previous schedule and to a different set of badges).
  useEffect(() => {
    hasDataRef.current = false
    setExpanded(null)
    setOpenState({})
    openSeqRef.current = {}
    setRowsScheduleId((cur) => (cur === scheduleId ? cur : null))
  }, [scheduleId])

  // Realtime: a scan landing mid-visit should show up without a manual refresh.
  // Debounced so a burst of scans triggers ONE reload, not dozens. This page is
  // read-only, so there is no write to echo and no self-suppression to do.
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
      .channel(`live-scanners-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-34: deployments changes (ASO finalizes, rows become deployed)
      // move the expected denominators behind these numbers — sessions
      // alone leave them stale until a manual refresh.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-40: realtime membership is not guaranteed — a dead channel
      // used to fail silently. Name the state so it lands in devtools.
      .subscribe((status) => {
        reportRealtimeStatus('live-scanners', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

  // LAZY: the second RPC is not called for a row until that row is actually
  // opened, so the page costs one round trip rather than one per scanner. A
  // row that has already been fetched keeps its result on collapse/re-expand.
  const toggleExpand = useCallback((badge) => {
    if (expanded === badge) {
      setExpanded(null)
      return
    }
    setExpanded(badge)
    if (openState[badge]) return
    fetchOpen(badge)
  }, [expanded, openState, fetchOpen])

  // ─── Derived rows ───
  // Until the in-flight load for THIS schedule lands there are no rows; feeding
  // the builder the previous schedule's list would render them under the new
  // schedule's name.
  const rowsAreCurrent = rowsScheduleId === scheduleId
  const all = useMemo(() => {
    if (!rowsAreCurrent) return []
    return raw.map((r) => ({
      ...r,
      status: scannerStatus(r.last_scan_time, date, now),
      // "Scans" is everything the operator did, so the sort and the tie-break
      // count IN, OUT and manual entries — not just the INs.
      total: (r.scans_in || 0) + (r.scans_out || 0) + (r.manual_scans || 0),
      lastScanMs: istMs(date, r.last_scan_time),
    }))
  }, [raw, rowsAreCurrent, date, now])

  // Active first — the whole point of the page — then busiest, then badge so the
  // order is stable across ticks.
  const sorted = useMemo(() => [...all].sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status])
    || (b.total - a.total)
    || String(a.scanner_badge || '').localeCompare(String(b.scanner_badge || ''))
  ), [all])

  const term = search.trim().toLowerCase()
  const visible = useMemo(() => (term
    ? sorted.filter((r) => `${scannerName(r)} ${r.scanner_badge || ''} ${r.scanner_centre || ''}`.toLowerCase().includes(term))
    : sorted
  ), [sorted, term])

  const stats = useMemo(() => ({
    // Active-now counts status==='active' ONLY: a 'scanned' row (valid scan on
    // a non-today date) is not scanning now and must never inflate this tile.
    active: all.filter((r) => r.status === 'active').length,
    scanners: all.length,
    scansIn: all.reduce((n, r) => n + (r.scans_in || 0), 0),
    open: all.reduce((n, r) => n + (r.open_now || 0), 0),
  }), [all])

  // Newest last-scan on screen — the date-aware Active-now sub for non-today
  // days ("last scan 3h ago"). NaN when nothing scanned: timeAgo renders '—',
  // which is the honest answer, not 0.
  const latestScanMs = useMemo(() => {
    let m = NaN
    for (const r of all) {
      if (Number.isFinite(r.lastScanMs)) m = Number.isFinite(m) ? Math.max(m, r.lastScanMs) : r.lastScanMs
    }
    return m
  }, [all])
  const isToday = date === todayStrIST()

  // ─── Export — one sheet, honouring the active search, built through the
  // shared excel.js driver (L-24/L-25) like every other reports surface. ───
  const exportFilename = `${fileSlug(schedule?.name)}_${date || 'no-date'}_scanners.xlsx`
  const buildExportSheets = () => ([
    {
      name: `Scanners ${date || 'no date'}`,
      rows: visible.map((r) => ({
        Scanner: scannerName(r),
        Badge: r.scanner_badge,
        Centre: r.scanner_centre || UNASSIGNED_CENTRE,
        Status: statusLabel(r.status, r.last_scan_time),
        'Scans In': r.scans_in || 0,
        'Scans Out': r.scans_out || 0,
        'Manual Scans': r.manual_scans || 0,
        'Open Now': r.open_now || 0,
        'First Scan': clock(r.first_in_time),
        'Last Scan': clock(r.last_scan_time),
      })),
    },
  ])

  // Phones deliver through the share sheet — a direct .xlsx download is
  // unreliable on iOS Safari, and this page had NO mobile export path at all.
  const isMobile = useIsMobile()
  const mobileExport = useExport()
  const [exportSheetOpen, setExportSheetOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const exportExcel = async () => {
    if (isMobile) {
      setExportSheetOpen(true)
      await mobileExport.prepare(async () => {
        const { blob, written } = await exportWorkbookBlob(exportFilename, buildExportSheets())
        if (!written) return null
        return { blob, filename: exportFilename }
      })
      return
    }
    setExporting(true)
    try {
      const written = await exportWorkbook(exportFilename, buildExportSheets())
      if (written === 0) toast.warning('Nothing to export')
      else toast.success('Scanner activity exported')
    } catch (e) {
      toast.error(e?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (!schedules?.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }
  if (loading && !all.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '1.25rem' }}><Skeleton variant="table" rows={6} /><div className="empty-text" style={{ marginTop: '0.75rem' }}>Loading scanner activity…</div></div>
      </div>
    )
  }

  // A first-load RPC failure is NOT "every scanner went offline". Missing v39
  // function (PGRST202), an RLS denial or a dropped connection all land here and
  // say so. The panel is deliberately FRIENDLY — the raw backend text is
  // console.error'd instead, so SQL/RLS internals never reach the screen.
  if (loadError) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '1.5rem', maxWidth: 720, margin: '0 auto' }} role="alert">
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <AlertTriangle size={18} style={{ color: '#b91c1c' }} />
            <h3 className="empty-title" style={{ margin: 0 }}>Could not load scanner activity</h3>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', margin: 0 }}>
            The scanner activity could not be read from the server.
          </p>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.75rem 0 0' }}>
            The attendance analytics functions may not be installed on this database, or your role
            may not be permitted to read them. No scanners are shown, because none could be loaded —
            this is not a report that scanning is idle.
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

  const freshness = loadedAt ? `Updated ${timeAgo(loadedAt, now)}` : null

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><Radio size={22} /> Live Scanners</h2>
          <div className="page-sub">Who is scanning right now, and who still has a session open</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" title="Read-only — scans are recorded on the Scanner and Dept Incharge pages" style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={exportExcel} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export Excel
            </button>
            <PrintPdfButton className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }} />
            {onNavigate && (
              <button onClick={() => onNavigate?.()} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                <ArrowLeft size={13} /> Back to Scanner
              </button>
            )}
            {term && (
              <span className="pill pill-indigo" title="The table and the Excel sheet show this filtered set">
                Showing {visible.length} of {all.length}
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
                Pick a scan day — the date is empty, so scanner activity cannot load.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Active now</div>
          <div className="stat-value" style={{ color: stats.active ? '#16a34a' : undefined }}>{stats.active}</div>
          <div className="stat-sub">{isToday ? 'scanned in the last 15 min' : `last scan ${timeAgo(latestScanMs, now)}`}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Scanners today</div>
          <div className="stat-value">{stats.scanners}</div>
          <div className="stat-sub">on {shortDayLabel(date) || 'no scan day'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Scans in</div>
          <div className="stat-value">{stats.scansIn}</div>
          <div className="stat-sub">entry scans recorded</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open sessions</div>
          <div className="stat-value" style={{ color: stats.open ? '#b45309' : undefined }}>{stats.open}</div>
          <div className="stat-sub">IN with no OUT yet</div>
        </div>
      </div>

      {/* Staleness, not blankness: a failed refresh keeps the rows above, which
          are still true as of `freshness`. An amber note says so; a greyed-out
          table with no explanation would read as "nobody is scanning". */}
      {stale && (
        <div
          role="status"
          className="card"
          style={{ padding: '0.5rem 0.75rem', marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', background: '#fffbeb', borderColor: '#fcd34d' }}
        >
          <AlertTriangle size={15} style={{ color: '#b45309', flexShrink: 0 }} />
          <span style={{ fontSize: '0.8rem', color: '#92400e' }}>
            Could not refresh — showing the last loaded data (stale){freshness ? `, ${freshness.toLowerCase()}` : ''}.
            Verdicts below are the last known ones, not live.
          </span>
        </div>
      )}

      <div className="card" style={{ marginTop: '0.75rem', padding: '0.85rem 1rem' }}>
        {isMobile && (
          <MobileFilterBar
            onOpen={() => setFiltersOpen(true)}
            chips={search.trim() ? [{ key: 'q', label: `"${search.trim()}"` }] : []}
            onClearChip={() => setSearch('')}
            onClearAll={() => setSearch('')}
            resultText={`${visible.length} of ${all.length}`}
            activeCount={search.trim() ? 1 : 0}
          />
        )}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {isMobile ? <div style={{ flex: 1 }} /> : <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }} />
            <input
              className="input"
              style={{ paddingLeft: 28, minHeight: 44 }}
              placeholder="Search badge, name or centre…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search scanners"
            />
          </div>}
          {freshness && (
            <span className="page-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', margin: 0 }}>
              <Clock size={13} /> {freshness}
            </span>
          )}
        </div>

        {!date ? (
          <div className="empty">
            <div className="empty-icon"><Radio size={22} /></div>
            <div className="empty-title">No scan day selected</div>
            <div className="empty-text">Pick a scan day above to load scanner activity.</div>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Radio size={22} /></div>
            <div className="empty-title">No scanner activity</div>
            <div className="empty-text">
              {term ? 'Try clearing the search.' : `No scans were recorded on ${shortDayLabel(date)}.`}
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Scanner</th>
                  <th>Centre</th>
                  <th style={{ textAlign: 'center' }}>In</th>
                  <th style={{ textAlign: 'center' }}>Out</th>
                  <th style={{ textAlign: 'center' }}>Manual</th>
                  <th style={{ textAlign: 'center' }}>Open</th>
                  <th>First</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isOpen = expanded === r.scanner_badge
                  const panelId = `open-sessions-${r.scanner_badge}`
                  const panel = openState[r.scanner_badge]
                  return (
                    // Keyed Fragment, not a bare <>: a scanner row and its
                    // optional drill-down are two siblings in one <tbody>, and
                    // the key has to sit on the fragment that IS the map return.
                    <Fragment key={r.scanner_badge}>
                      <tr style={{ background: isOpen ? '#f8faff' : undefined }}>
                        <td data-label="Status">
                          {/* The only interactive control on the row. A bare
                              onClick on <tr> would be mouse-only and invisible
                              to a keyboard, so the whole status cell is a real
                              button instead — its name still contains the
                              visible scanner name, so it reads correctly out
                              loud (WCAG 2.5.3). */}
                          <button
                            type="button"
                            onClick={() => toggleExpand(r.scanner_badge)}
                            aria-expanded={isOpen}
                            aria-controls={panelId}
                            aria-label={`Open sessions for ${scannerName(r)} (${r.scanner_badge || 'no badge'})`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                          >
                            {isOpen ? <ChevronDown size={14} style={{ color: '#94a3b8' }} /> : <ChevronRight size={14} style={{ color: '#94a3b8' }} />}
                            <span className={`pill ${statusPill(r.status)}`}>{statusLabel(r.status, r.last_scan_time)}</span>
                          </button>
                        </td>
                        <td data-label="Scanner">
                          <div style={{ fontWeight: 600 }}>{scannerName(r)}</div>
                          <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>{r.scanner_badge || '—'}</div>
                        </td>
                        <td data-label="Centre">{r.scanner_centre || UNASSIGNED_CENTRE}</td>
                        <td data-label="Scans In" style={{ textAlign: 'center', fontWeight: 700 }}>{r.scans_in || 0}</td>
                        <td data-label="Scans Out" style={{ textAlign: 'center' }}>{r.scans_out || 0}</td>
                        <td data-label="Manual" style={{ textAlign: 'center' }}>{r.manual_scans || 0}</td>
                        <td data-label="Open Now" style={{ textAlign: 'center', color: r.open_now ? '#b45309' : undefined, fontWeight: r.open_now ? 700 : undefined }}>{r.open_now || 0}</td>
                        <td data-label="First Scan">{clock(r.first_in_time)}</td>
                        <td data-label="Last Scan">
                          <div>{clock(r.last_scan_time)}</div>
                          <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{timeAgo(r.lastScanMs, now)}</div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr id={panelId}>
                          <td colSpan={9} style={{ background: '#f8faff', padding: '0.65rem 0.75rem' }} data-label="Open sessions">
                            {!panel ? (
                              <div className="empty-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Loader2 size={13} className="spin" /> Loading open sessions…
                              </div>
                            ) : panel.error ? (
                              <div role="alert" style={{ fontSize: '0.8rem', color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <AlertTriangle size={14} /> {panel.error}
                                <button onClick={() => fetchOpen(r.scanner_badge)} className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem' }}>
                                  <RefreshCw size={12} /> Retry
                                </button>
                              </div>
                            ) : panel.rows.length === 0 ? (
                              <div className="empty-text">
                                {scannerName(r)} has no open sessions — every IN has a matching OUT.
                              </div>
                            ) : (
                              <div className="table-wrap">
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Badge</th>
                                      <th>Sewadar</th>
                                      <th>Home centre</th>
                                      <th>Department</th>
                                      <th>In</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {panel.rows.map((s) => (
                                      <tr key={`${s.badge_number}-${s.in_date}-${s.in_time}`}>
                                        <td data-label="Badge" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{s.badge_number || '—'}</td>
                                        <td data-label="Sewadar" style={{ fontWeight: 500 }}>{s.sewadar_name || '—'}</td>
                                        <td data-label="Home centre">{s.sewadar_centre || UNASSIGNED_CENTRE}</td>
                                        <td data-label="Department">{s.dept_name || '—'}</td>
                                        <td data-label="In">
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                            <ScanLine size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
                                            {clock(s.in_time)}
                                          </div>
                                          {s.in_date && s.in_date !== date && (
                                            <div style={{ fontSize: '0.72rem', color: '#b45309' }} title={s.in_date}>{shortDayLabel(s.in_date)}</div>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="page-sub" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <Users size={13} />
        Active = a scan in the last 15 minutes · scope is enforced by the database for your role
      </div>

      <FilterSheet
        open={isMobile && filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Search scanners"
        resultText={`${visible.length} of ${all.length}`}
        onClearAll={() => setSearch('')}
        hasActive={!!search.trim()}
      >
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }} />
          <input
            className="input"
            style={{ paddingLeft: 28, width: '100%', minHeight: 44 }}
            placeholder="Search badge, name or centre…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search scanners"
          />
        </div>
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
        onRetry={exportExcel}
      />
    </div>
  )
}
