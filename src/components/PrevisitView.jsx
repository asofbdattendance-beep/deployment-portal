import { useState, useMemo, useEffect, useRef } from 'react'
import { useToast } from '../components/Toast'
import { RefreshCw, Download, Search } from 'lucide-react'
import { fileSlug, exportWorkbook, exportWorkbookBlob } from '../lib/excel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useExport } from '../hooks/useExport'
import ExportSheet from './mobile/ExportSheet'
import PrintPdfButton from '../components/PrintPdfButton'
import { shortDayLabel, centreOptions, buildLogRows, SCAN_LOG_SESSION_COLS, sessionMinutes, formatDuration } from '../lib/attendance'
import { fetchAllRows } from '../lib/supabase'
import AnomalyDetailPopup from './AnomalyDetailPopup'
import { usePrevisitData } from '../hooks/usePrevisitData'
import {
  previsitDates,
  filterPrevisitRows,
  filterPrevisitTotal,
  previsitPresentMap,
  previsitAttention,
  splitPrevisitDay,
  buildPrevisitMatrixRows,
  formatPrevisitDuration,
  previsitExportRows,
  previsitTotalExportRows,
  previsitAttentionExportRows,
} from '../lib/previsit'

/**
 * PrevisitView — the REPORTS half of the previsit surface, mounted on the
 * reports tabs (Attendance, Reports, Anomalies) when the global sewa mode
 * is "previsit". Each tab lands on its own sub-tab via `initialTab`, so
 * the three pages are distinct views, not three identical renders:
 *
 *   Total     — the deployed strength in scope, with a tick for who is
 *               present on the selected day (or a day count for All days);
 *   Present   — the register: ONE row per sewadar per day (first IN,
 *               last OUT, summed minutes, session count);
 *   Attention — what needs a follow-up: sessions left open, scans with
 *               no deployment row, badges scanned more than once a day.
 *
 * Deliberately NO Absent tab (product decision). Sibling
 * PrevisitDashboard (dashboard tabs) owns the KPI/strip/breakdown
 * summary. Both read through the shared usePrevisitData hook, so reports
 * and dashboard can never disagree about what the server said.
 *
 * Read-only by design: scanning lives on the scanner pages and writes
 * the same session row in both modes (the scan date classifies it).
 */
const TAB_TOTAL = 'total'
const TAB_PRESENT = 'present'
const TAB_ATTENTION = 'attention'
const TAB_LOGS = 'logs'
const TABS = [TAB_TOTAL, TAB_PRESENT, TAB_ATTENTION, TAB_LOGS]
const DAY_ALL = 'all'

// Labels for the trail popup when it opens from a previsit row (previsit
// rows carry no `rule` field — the section/register they came from is the
// closest thing to one, and the popup falls back to these verbatim).
const PREVISIT_RULE_META = {
  'Open session': { label: 'Open session', pill: 'pill-amber', text: 'Scanned IN with no OUT yet' },
  'Undeployed scan': { label: 'Undeployed scan', pill: 'pill-red', text: 'Badge scanned with no deployment for this schedule' },
  'Scanned more than once': { label: 'Scanned more than once', pill: 'pill-amber', text: 'Same badge scanned IN more than once on one date' },
  'Present register': { label: 'Present register', pill: 'pill-gray', text: 'First IN, last OUT and summed minutes for the day' },
  'Deployed roster': { label: 'Deployed roster', pill: 'pill-gray', text: 'Deployed strength with per-day presence ticks' },
  'Scan log': { label: 'Scan log', pill: 'pill-gray', text: 'One line per session: IN/IN-by with OUT/OUT-by' },
}

// Shared affordance for every clickable trail row: whole-row click +
// keyboard + a visible chevron, so a row never LOOKS static. Absent
// onSelect = plain static row (callers that never pass it are untouched).
function clickableRowProps(row, onSelect) {
  if (typeof onSelect !== 'function' || !row?.badge_number) return {}
  return {
    role: 'button',
    tabIndex: 0,
    style: { cursor: 'pointer' },
    'aria-label': `Open details for ${row.badge_number}`,
    onClick: () => onSelect(row),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(row)
      }
    },
  }
}

function attentionUnion(att) {
  const seen = new Set()
  const out = []
  for (const r of [...(att?.open || []), ...(att?.undeployed || []), ...(att?.multi || [])]) {
    if (!r) continue
    const k = `${String(r.event_date || '').slice(0, 10)}|${r.badge_number}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

// Logs export: same columns as the Attendance Logs sheet, so a filtered
// export can never be mistaken for a full one (sheet name carries the tab;
// the shared driver stamps the filename).
function previsitLogExportRows(rows) {
  return (rows || []).map((r, i) => {
    const mins = sessionMinutes(r.in_time, r.out_time, r.in_date, r.out_date)
    return {
      'S.No.': i + 1,
      Badge: r.badge_number, Name: r.sewadar_name || '—',
      Centre: r.sewadar_centre || '—', Department: r.dept_name || '—',
      Date: r.in_date || '—',
      'IN': (r.in_time || '').slice(0, 5) || '—', 'IN By': r.in_by || '—',
      'OUT': (r.out_time || '').slice(0, 5) || (r.status === 'OPEN' ? 'open' : '—'),
      'OUT By': r.out_time ? (r.out_by || '—') : '—',
      Duration: mins == null ? (r.status === 'OPEN' ? 'still IN' : '—') : formatDuration(mins),
      Status: r.status || '—', Manual: r.is_manual ? 'yes' : 'no',
      Undeployed: r.undeployed_scan ? 'yes' : 'no',
    }
  })
}

function AttentionSection({ title, rows, showDate, detail, onSelect }) {
  if (rows.length === 0) return null
  return (
    <div className="card" style={{ marginTop: '0.75rem' }}>
      <div className="card-title">{title} ({rows.length})</div>
      <div className="table-wrap table-wrap-rows">
        <table className="table rows-on-phone">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {showDate && <th scope="col">Date</th>}
              <th scope="col">Badge</th>
              <th scope="col">Name</th>
              <th scope="col">Centre</th>
              <th scope="col">Detail</th>
              {onSelect && <th scope="col"><span className="sr-only">Details</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${String(r.event_date || '').slice(0, 10)}-${r.badge_number}`} {...clickableRowProps(r, onSelect)}>
                {showDate && <td data-label="Date" title={String(r.event_date || '').slice(0, 10)} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{shortDayLabel(r.event_date)}</td>}
                <td data-label="Badge" style={{ fontFamily: 'monospace' }}>{r.badge_number}</td>
                <td data-label="Name">{r.sewadar_name || ''}</td>
                <td data-label="Centre">{r.sewadar_centre || ''}</td>
                <td data-label="Detail">{detail(r)}</td>
                {onSelect && <td data-label="Details" aria-hidden="true" style={{ color: '#94a3b8' }}>›</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function PrevisitView({ schedules = [], scheduleId, initialTab }) {
  const toast = useToast()
  const schedule = (schedules || []).find((s) => s.id === scheduleId)
  const { summary, rows, deployed, loading, loadError, rowsScheduleId, reload } = usePrevisitData(scheduleId)

  const [tab, setTab] = useState(TABS.includes(initialTab) ? initialTab : TAB_PRESENT)
  useEffect(() => {
    if (TABS.includes(initialTab)) setTab(initialTab)
  }, [initialTab])
  const [dateSel, setDateSel] = useState('')
  const [centreSel, setCentreSel] = useState('all')
  const [query, setQuery] = useState('')
  const [exporting, setExporting] = useState(false)
  // Drill-in: clicking any row (every tab) opens its scan-trail popup.
  // Reset on schedule change — a row from the previous schedule would fetch
  // the new schedule's trail under the old row's identity.
  const [selected, setSelected] = useState(null)
  useEffect(() => { setSelected(null) }, [scheduleId])
  const openTrail = (row, rule) => {
    if (!row?.badge_number) return
    setSelected(rule ? { ...row, rule } : { ...row })
  }
  // Logs tab: the whole-schedule scan record, fetched lazily (it is a
  // separate complete-or-throw table read, not part of the previsit feeds).
  const [logRaw, setLogRaw] = useState([])
  const [logLoading, setLogLoading] = useState(false)
  const [logErr, setLogErr] = useState(null)
  const [logLoadedFor, setLogLoadedFor] = useState(null)
  // Bumped by every manual retry/reload: when the last fetch FAILED,
  // logLoadedFor is still null, so resetting it alone would be a state
  // no-op and the effect below would never refire (dead Retry button).
  const [logAttempt, setLogAttempt] = useState(0)
  const retryLog = () => setLogAttempt((a) => a + 1)
  useEffect(() => {
    if (tab !== TAB_LOGS || !scheduleId || logLoadedFor === scheduleId) return undefined
    let cancelled = false
    setLogLoading(true)
    setLogErr(null)
    fetchAllRows('dp_attendance_sessions', SCAN_LOG_SESSION_COLS, (q) => q.eq('schedule_id', scheduleId), 'id')
      .then((rows) => {
        if (cancelled) return
        setLogRaw(rows)
        setLogLoadedFor(scheduleId)
        setLogLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLogErr(e)
        setLogLoading(false)
      })
    return () => { cancelled = true }
  }, [tab, scheduleId, logLoadedFor, logAttempt])
  useEffect(() => {
    setLogRaw([])
    setLogErr(null)
    setLogLoadedFor(null)
  }, [scheduleId])

  // Hold the last good snapshot while a refresh is in flight: tiles and
  // tables keep showing real numbers (the Reload button spins instead)
  // instead of flashing confident 0s. A schedule switch clears the
  // snapshot, so stale rows can never linger under a new schedule.
  const shownRef = useRef({ summary: [], rows: [], deployed: [], scheduleId: null })
  if (rowsScheduleId === scheduleId) {
    shownRef.current = { summary, rows, deployed, scheduleId }
  }
  const shown = shownRef.current.scheduleId === scheduleId
    ? shownRef.current
    : { summary: [], rows: [], deployed: [] }
  const liveSummary = shown.summary
  const liveRows = shown.rows
  const liveDeployed = shown.deployed
  const hasShown = liveRows.length > 0 || liveDeployed.length > 0 || liveSummary.length > 0
  const dates = useMemo(() => previsitDates(liveSummary), [liveSummary])
  const centreOpts = useMemo(
    () => centreOptions([...liveRows, ...liveDeployed]),
    [liveRows, liveDeployed]
  )
  // Newest sewa day by default; DAY_ALL is an explicit choice (the old
  // select could never hold "All" — picking '' fell back to dates[0]).
  const effDate = dateSel === DAY_ALL ? '' : (dates.includes(dateSel) ? dateSel : (dates[0] || ''))
  const isAll = dateSel === DAY_ALL
  const presentMap = useMemo(() => previsitPresentMap(liveRows), [liveRows])

  // Tab counts respect the centre filter (+ the day for Present /
  // Attention); the text search narrows only the displayed table.
  const centreDeployed = useMemo(
    () => filterPrevisitTotal(liveDeployed, { centre: centreSel }),
    [liveDeployed, centreSel]
  )
  const dayRows = useMemo(
    () => filterPrevisitRows(liveRows, { date: effDate, centre: centreSel }),
    [liveRows, effDate, centreSel]
  )
  const presentBadges = useMemo(() => new Set(dayRows.map((r) => r.badge_number)), [dayRows])
  const deployedBadges = useMemo(() => new Set(centreDeployed.map((r) => r.badge_number)), [centreDeployed])
  const deployedPresent = useMemo(
    () => [...presentBadges].filter((b) => deployedBadges.has(b)).length,
    [presentBadges, deployedBadges]
  )
  const openBadges = useMemo(
    () => new Set(dayRows.filter((r) => r.is_open).map((r) => r.badge_number)).size,
    [dayRows]
  )
  const attForCount = useMemo(() => previsitAttention(dayRows), [dayRows])
  const attentionCount = useMemo(() => attentionUnion(attForCount).length, [attForCount])

  const totalCount = centreDeployed.length
  const presentCount = presentBadges.size
  const notPresent = Math.max(0, totalCount - deployedPresent)

  const totalVisible = useMemo(
    () => filterPrevisitTotal(liveDeployed, { centre: centreSel, query }),
    [liveDeployed, centreSel, query]
  )
  const presentVisible = useMemo(
    () => filterPrevisitRows(liveRows, { date: effDate, centre: centreSel, query }),
    [liveRows, effDate, centreSel, query]
  )
  const attVisible = useMemo(
    () => previsitAttention(filterPrevisitRows(liveRows, { date: effDate, centre: centreSel, query })),
    [liveRows, effDate, centreSel, query]
  )
  // Badge × day matrix behind the Total tab: every sewa day as a column.
  const matrixRows = useMemo(
    () => buildPrevisitMatrixRows(totalVisible, presentMap, dates),
    [totalVisible, presentMap, dates]
  )
  const attentionVisible = useMemo(() => attentionUnion(attVisible), [attVisible])
  // Logs tab: department names resolve through the previsit feeds (session
  // rows carry only the department id) — same doctrine as Attendance Logs.
  const badgeDeptNames = useMemo(() => {
    const m = new Map()
    for (const r of [...liveRows, ...liveDeployed]) {
      if (r?.badge_number && r.dept_name && !m.has(r.badge_number)) m.set(r.badge_number, r.dept_name)
    }
    return m
  }, [liveRows, liveDeployed])
  const logRows = useMemo(() => buildLogRows(logRaw, badgeDeptNames), [logRaw, badgeDeptNames])
  const logVisible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logRows.filter((r) =>
      (centreSel === 'all' || r.sewadar_centre === centreSel) &&
      (!q || [r.badge_number, r.sewadar_name, r.sewadar_centre, r.dept_name, r.in_by, r.out_by]
        .some((f) => String(f || '').toLowerCase().includes(q)))
    )
  }, [logRows, centreSel, query])
  const visible = tab === TAB_TOTAL ? totalVisible : tab === TAB_ATTENTION ? attentionVisible : tab === TAB_LOGS ? logVisible : presentVisible
  const totalOfTab = tab === TAB_TOTAL ? liveDeployed.length : tab === TAB_ATTENTION ? attentionUnion(previsitAttention(liveRows)).length : tab === TAB_LOGS ? logRows.length : liveRows.length
  const sheetName = tab === TAB_TOTAL ? 'Total' : tab === TAB_ATTENTION ? 'Attention' : tab === TAB_LOGS ? 'Logs' : 'Present'
  // Same-badge rows behind the popup's "related" section, whatever tab it
  // opened from.
  const relatedForSelected = selected
    ? [...presentVisible, ...attentionVisible, ...logVisible].filter((r) => r !== selected && r.badge_number === selected.badge_number)
    : []

  // ONE builder for both delivery paths — desktop downloads the workbook,
  // phones share it (the only reliable "save" on iOS Safari). They can never
  // drift because they are the same rows in the same call.
  const exportFilename = `${fileSlug(schedule?.name || 'schedule')}_previsit_${
    tab === TAB_TOTAL ? 'total' : tab === TAB_ATTENTION ? 'attention' : tab === TAB_LOGS ? 'logs' : (effDate || 'all-days')
  }.xlsx`
  const buildExportSheets = () => ([{
    name: sheetName,
    rows: tab === TAB_TOTAL
      ? previsitTotalExportRows(totalVisible, presentMap, dates)
      : tab === TAB_ATTENTION
        ? previsitAttentionExportRows(attVisible)
        : tab === TAB_LOGS
          ? previsitLogExportRows(logVisible)
          : previsitExportRows(presentVisible),
  }])

  const isMobile = useIsMobile()
  const mobileExport = useExport()
  const [exportSheetOpen, setExportSheetOpen] = useState(false)

  const exportExcel = async () => {
    if (exporting || visible.length === 0) return
    // Mobile: build on this tap, deliver on the Share tap inside the sheet
    // (a share call after an awaited build loses the user gesture).
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
      const n = await exportWorkbook(exportFilename, buildExportSheets())
      if (!n) toast.error('Nothing to export')
      else toast.success('Previsit workbook exported')
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (!scheduleId) {
    return (
      <div className="page"><div className="card"><div className="empty">
        <div className="empty-title">No schedule selected</div>
        <div className="empty-text">Pick a schedule to view its previsit sewa.</div>
      </div></div></div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Previsit Sewa Register{schedule ? ` · ${schedule.name}` : ''}</h2>
          <div className="page-sub">
            Deployed {totalCount} · Present {presentCount}{effDate ? ` on ${effDate}` : dates.length > 0 ? ` across ${dates.length} days` : ''}
          </div>
        </div>
        <div className="cluster">
          <button onClick={() => { setLogLoadedFor(null); retryLog(); reload() }} className="btn" disabled={loading} title="Reload">
            <RefreshCw size={14} /> {loading ? 'Loading…' : 'Reload'}
          </button>
          <button onClick={exportExcel} disabled={exporting || mobileExport.building || visible.length === 0} className="btn btn-primary" title="Export the visible rows">
            <Download size={14} /> {exporting || mobileExport.building ? 'Exporting…' : 'Export Excel'}
          </button>
          <PrintPdfButton className="btn" />
        </div>
      </div>

      {loadError && (
        <div className="card" role="alert" style={{ borderColor: '#fca5a5', background: '#fef2f2', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.85rem', color: '#b91c1c' }}>{loadError}</div>
        </div>
      )}

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

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Deployed</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{totalCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Present{effDate ? '' : ' (all days)'}</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{presentCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Not present</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{notPresent}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open sessions</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{openBadges}</div>
        </div>
      </div>

      <div className="card previsit-card" style={{ marginTop: '0.75rem' }}>
        <div className="previsit-toolbar" role="search">
          <div className="previsit-tabs" role="tablist" aria-label="Previsit list">
            <button
              type="button"
              role="tab"
              aria-selected={tab === TAB_TOTAL}
              onClick={() => setTab(TAB_TOTAL)}
              className={`seg-btn ${tab === TAB_TOTAL ? 'seg-active' : ''}`}
            >
              Total ({totalCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === TAB_PRESENT}
              onClick={() => setTab(TAB_PRESENT)}
              className={`seg-btn ${tab === TAB_PRESENT ? 'seg-active' : ''}`}
            >
              Present ({presentCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === TAB_ATTENTION}
              onClick={() => setTab(TAB_ATTENTION)}
              className={`seg-btn ${tab === TAB_ATTENTION ? 'seg-active' : ''}`}
            >
              Attention ({attentionCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === TAB_LOGS}
              onClick={() => setTab(TAB_LOGS)}
              className={`seg-btn ${tab === TAB_LOGS ? 'seg-active' : ''}`}
              title="Whole-schedule scan record: one line per session with IN/IN-by and OUT/OUT-by"
            >
              Logs ({logLoadedFor === scheduleId ? logRows.length : '…'})
            </button>
          </div>
          <div className="previsit-field" style={{ flex: '1 1 100%' }}>
            <span className="previsit-label" id="previsit-day-label">Sewa day</span>
            <div className="day-chip-row" role="group" aria-labelledby="previsit-day-label">
              <button
                type="button"
                onClick={() => setDateSel(DAY_ALL)}
                className={`seg-btn day-chip ${isAll ? 'seg-active' : ''}`}
                aria-pressed={isAll}
              >
                All{dates.length > 0 ? ` (${dates.length})` : ''}
              </button>
              {dates.map((d) => (
                <button
                  type="button"
                  key={d}
                  onClick={() => setDateSel(d)}
                  className={`seg-btn day-chip ${!isAll && effDate === d ? 'seg-active' : ''}`}
                  aria-pressed={!isAll && effDate === d}
                  title={d}
                >
                  {shortDayLabel(d)}
                </button>
              ))}
            </div>
          </div>
          <label className="previsit-field">
            <span className="previsit-label">Centre</span>
            <select value={centreSel} onChange={(e) => setCentreSel(e.target.value)} className="select previsit-control" aria-label="Centre filter">
              <option value="all">All centres</option>
              {centreOpts.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="previsit-field previsit-field--search">
            <span className="previsit-label">Search</span>
            <span className="previsit-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Badge, name or centre…"
                aria-label="Search previsit rows"
                className="input previsit-control"
              />
            </span>
          </label>
          <span className="previsit-count" aria-live="polite">
            {visible.length} of {totalOfTab} record{totalOfTab === 1 ? '' : 's'}
          </span>
        </div>
        <div className="page-sub" style={{ padding: '0 1.25rem' }}>
          Tip: click any row for the full scan trail.
        </div>

        {loading && !hasShown ? (
          <div className="empty"><div className="empty-title">Loading previsit sewa…</div></div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="empty-title">
              {tab === TAB_TOTAL ? 'Nobody deployed in scope' : tab === TAB_ATTENTION ? 'Nothing needs attention' : tab === TAB_LOGS ? (logErr ? 'Scan log could not be loaded' : 'No scans logged') : 'No previsit sewa recorded'}
            </div>
            <div className="empty-text">
              {tab === TAB_TOTAL
                ? 'No deployed sewadars found for this schedule and centre.'
                : tab === TAB_ATTENTION
                  ? 'No open sessions, undeployed scans or repeat scans match the current filters.'
                  : tab === TAB_LOGS
                    ? (logErr
                      ? 'The scan record could not be read from the server. The other tabs are unaffected.'
                      : 'No scans have been recorded for this schedule yet.')
                    : (liveRows.length === 0
                      ? 'Nobody has scanned outside the visit window for this schedule yet.'
                      : 'Nothing matches the current filters.')}
            </div>
            {(centreSel !== 'all' || query) && (
              <button type="button" className="btn" style={{ marginTop: '0.75rem' }} onClick={() => { setCentreSel('all'); setQuery('') }}>
                Clear filters
              </button>
            )}
            {tab === TAB_LOGS && logErr && (
              <button type="button" className="btn" style={{ marginTop: '0.75rem' }} onClick={retryLog}>
                Retry log
              </button>
            )}
          </div>
        ) : tab === TAB_TOTAL ? (
          <div role="tabpanel" aria-label="Deployed strength" aria-busy={loading}>
            <div className="att-matrix">
              <div className="att-legend" aria-hidden="true">
                <span className="att-legend-item">
                  <span className="att-swatch att-present" />
                  Present
                </span>
                <span className="att-legend-item">
                  <span className="att-swatch att-absent" />
                  Absent
                </span>
              </div>
              {/* Phones render the SAME row/column grid as the laptop: a scroll
                  box with a pinned Badge column and a pinned header. The stacked
                  card version ran ~132px per sewadar, so a 200-sewadar list cost
                  ~26 screens of scrolling for data that is one 6-column row. */}
              <div className="att-scroll" tabIndex={0} role="region" aria-label="Scrollable presence grid">
                <table className="att-table">
                  <caption>Deployed strength by sewa day</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="att-col-badge">Badge</th>
                      <th scope="col">Name</th>
                      <th scope="col">Centre</th>
                      <th scope="col">Dept</th>
                      {dates.map((d) => {
                        const { mon, num } = splitPrevisitDay(d)
                        const selected = effDate !== '' && d === effDate
                        return (
                          <th
                            key={d}
                            scope="col"
                            title={d}
                            className={`att-day${selected ? ' att-today' : ''}`}
                          >
                            <span className="att-day-wd">{mon}</span>
                            <span className="att-day-num">{num}</span>
                          </th>
                        )
                      })}
                      <th scope="col" className="att-days" title="Days present across the listed sewa days">Days</th>
                      <th scope="col"><span className="sr-only">Details</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map((r) => (
                      <tr key={r.badge_number} {...clickableRowProps(r, (row) => openTrail(row, 'Deployed roster'))}>
                        <td className="att-col-badge att-badge">{r.badge_number}</td>
                        <td className="att-name" title={r.sewadar_name}>{r.sewadar_name}</td>
                        <td>{r.sewadar_centre}</td>
                        <td>{r.dept_name}</td>
                        {dates.map((d) => {
                          const present = !!r.byDate[d]
                          return (
                            <td
                              key={d}
                              title={present ? `Present on ${d}` : `Absent on ${d}`}
                              className={`att-cell ${present ? 'att-present' : 'att-absent'}`}
                            >
                              <span aria-hidden="true" className="att-mark">{present ? '✓' : '−'}</span>
                              <span className="sr-only">{present ? 'Present' : 'Absent'}</span>
                            </td>
                          )
                        })}
                        <td className="att-days">
                          <span className={`attendance-pill ${r.presentCount >= dates.length && dates.length > 0 ? 'ok' : r.presentCount === 0 ? 'muted' : 'att-mid'}`}>{r.presentCount}/{dates.length}</span>
                        </td>
                        <td data-label="Details" aria-hidden="true" style={{ color: '#94a3b8' }}>›</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : tab === TAB_ATTENTION ? (
          <div role="tabpanel" aria-label="Needs attention" aria-busy={loading}>
            <AttentionSection
              title="Open sessions"
              rows={attVisible.open}
              showDate={isAll}
              onSelect={(r) => openTrail(r, 'Open session')}
              detail={(r) => (
                <span className="cluster">
                  <span>Open since {r.in_time ? String(r.in_time).slice(0, 5) : '—'}</span>
                  {r.undeployed && <span className="pill pill-amber">Undeployed</span>}
                  {(Number(r.session_count) || 0) > 1 && <span className="pill pill-amber">×{r.session_count}</span>}
                </span>
              )}
            />
            <AttentionSection
              title="Undeployed scans"
              rows={attVisible.undeployed}
              showDate={isAll}
              onSelect={(r) => openTrail(r, 'Undeployed scan')}
              detail={(r) => (
                <span className="cluster">
                  <span>No deployment row</span>
                  {r.is_open && <span className="pill pill-red">Open</span>}
                  {(Number(r.session_count) || 0) > 1 && <span className="pill pill-amber">×{r.session_count}</span>}
                </span>
              )}
            />
            <AttentionSection
              title="Scanned more than once"
              rows={attVisible.multi}
              showDate={isAll}
              onSelect={(r) => openTrail(r, 'Scanned more than once')}
              detail={(r) => (
                <span className="cluster">
                  <span>{r.session_count} sessions · total {formatPrevisitDuration(r.duration_min)}</span>
                  {r.is_open && <span className="pill pill-red">Open</span>}
                  {r.undeployed && <span className="pill pill-amber">Undeployed</span>}
                </span>
              )}
            />
          </div>
        ) : tab === TAB_LOGS ? (
          <div role="tabpanel" aria-label="Scan log" aria-busy={logLoading}>
            {logErr && (
              <div
                role="alert"
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
                  padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: '#b91c1c', marginBottom: '0.75rem',
                }}
              >
                <span><strong>Scan log</strong> could not be loaded — the other tabs are unaffected.</span>
                <button type="button" onClick={retryLog} disabled={logLoading} className="btn btn-ghost">
                  Retry
                </button>
              </div>
            )}
            {logLoading && logRows.length === 0 ? (
              <div className="empty"><div className="empty-title">Loading scan log…</div></div>
            ) : (
              <div className="table-wrap table-wrap-rows">
                <table className="table rows-on-phone">
                  <caption className="sr-only">Scan log — one line per session</caption>
                  <thead>
                    <tr>
                      <th scope="col">Badge</th>
                      <th scope="col">Name</th>
                      <th scope="col">Centre</th>
                      <th scope="col">Department</th>
                      <th scope="col">IN</th>
                      <th scope="col">OUT</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Duration</th>
                      <th scope="col">Flags</th>
                      <th scope="col"><span className="sr-only">Details</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {logVisible.map((r) => {
                      const mins = sessionMinutes(r.in_time, r.out_time, r.in_date, r.out_date)
                      return (
                        <tr key={r.id} {...clickableRowProps(r, (row) => openTrail(row, 'Scan log'))}>
                          <td data-label="Badge" style={{ fontFamily: 'monospace' }}>{r.badge_number}</td>
                          <td data-label="Name">{r.sewadar_name || ''}{' '}{r.is_vss && <span className="pill pill-indigo">VSS</span>}</td>
                          <td data-label="Centre">{r.sewadar_centre || ''}</td>
                          <td data-label="Department">{r.dept_name || '—'}</td>
                          <td data-label="IN" style={{ whiteSpace: 'nowrap' }}>
                            <strong>{(r.in_time || '').slice(0, 5) || '—'}</strong>{' '}
                            <span style={{ color: '#64748b', fontSize: '0.78rem' }}>by {r.in_by || '—'}</span>
                          </td>
                          <td data-label="OUT" style={{ whiteSpace: 'nowrap' }}>
                            <strong>{(r.out_time || '').slice(0, 5) || (r.status === 'OPEN' ? 'open' : '—')}</strong>{' '}
                            <span style={{ color: '#64748b', fontSize: '0.78rem' }}>by {r.out_time ? (r.out_by || '—') : '—'}</span>
                          </td>
                          <td data-label="Duration" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {mins == null
                              ? (r.status === 'OPEN' ? <span className="pill pill-amber">still IN</span> : '—')
                              : formatDuration(mins)}
                          </td>
                          <td data-label="Flags">
                            <span className="cluster">
                              {r.status === 'OPEN' && <span className="pill pill-amber">Open</span>}
                              {r.is_manual && <span className="pill pill-gray">Manual</span>}
                              {r.undeployed_scan && <span className="pill pill-red">Undeployed</span>}
                              {r.status !== 'OPEN' && !r.is_manual && !r.undeployed_scan && <span className="pill pill-gray">—</span>}
                            </span>
                          </td>
                          <td data-label="Details" aria-hidden="true" style={{ color: '#94a3b8' }}>›</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div role="tabpanel" aria-label="Present register" aria-busy={loading}>
            <div className="table-wrap table-wrap-sticky table-wrap-rows">
              <table className="table table-sticky previsit-table rows-on-phone">
                <caption className="sr-only">Present register</caption>
                <thead>
                  <tr>
                    {isAll && <th scope="col">Date</th>}
                    <th scope="col">Badge</th>
                    <th scope="col">Name</th>
                    <th scope="col">Centre</th>
                    <th scope="col">Department</th>
                    <th scope="col" style={{ textAlign: 'right' }}>First in</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Last out</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Duration</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Sessions</th>
                    <th scope="col">Flags</th>
                    <th scope="col"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody>
                  {presentVisible.map((r) => (
                    <tr key={`${String(r.event_date || '').slice(0, 10)}-${r.badge_number}`} {...clickableRowProps(r, (row) => openTrail(row, 'Present register'))}>
                      {isAll && <td data-label="Date" title={String(r.event_date || '').slice(0, 10)} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{shortDayLabel(r.event_date)}</td>}
                      <td data-label="Badge" style={{ fontFamily: 'monospace' }}>{r.badge_number}</td>
                      <td data-label="Name">{r.sewadar_name || ''}</td>
                      <td data-label="Centre">{r.sewadar_centre || ''}</td>
                      <td data-label="Department">{r.dept_name || '—'}</td>
                      <td data-label="First in" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.in_time ? String(r.in_time).slice(0, 5) : ''}</td>
                      <td data-label="Last out" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.out_time ? String(r.out_time).slice(0, 5) : ''}</td>
                      <td data-label="Duration" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPrevisitDuration(r.duration_min)}</td>
                      <td data-label="Sessions" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {(Number(r.session_count) || 0) > 1
                          ? <span className="pill pill-amber" title={`${r.session_count} sessions that day`}>×{r.session_count}</span>
                          : '1'}
                      </td>
                      <td data-label="Flags">
                        <span className="cluster">
                          {r.is_vss && <span className="pill pill-indigo">VSS</span>}
                          {r.is_manual && <span className="pill pill-gray">Manual</span>}
                          {r.undeployed && <span className="pill pill-amber">Undeployed</span>}
                          {r.is_open && <span className="pill pill-red">Open</span>}
                        </span>
                      </td>
                      <td data-label="Details" aria-hidden="true" style={{ color: '#94a3b8' }}>›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {selected && (
        <AnomalyDetailPopup
          row={selected}
          scheduleId={scheduleId}
          related={relatedForSelected}
          ruleMeta={PREVISIT_RULE_META}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
