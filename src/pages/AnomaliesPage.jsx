import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { anomalyCounts, UNASSIGNED_CENTRE, shortDayLabel } from '../lib/attendance'
import { todayStrIST } from '../lib/scannerUtils'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import { fileSlug } from '../lib/excel'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import PageHeader, { ViewOnlyPill } from '../components/PageHeader'
import KpiTile from '../components/KpiTile'
import DataTable from '../components/DataTable'
import AnomalyDetailPopup from '../components/AnomalyDetailPopup'
import EmptyState from '../components/EmptyState'
import ExportButton from '../components/ExportButton'
import PrintPdfButton from '../components/PrintPdfButton'
import FilterSheet, { MobileFilterBar } from '../components/mobile/FilterSheet'
import VirtualList from '../components/mobile/VirtualList'
import {
  ShieldAlert, RefreshCw, Loader2, Search, ArrowUpRight,
} from 'lucide-react'

/**
 * The five v1 anomaly rules, in one place. `label` is what the operator reads,
 * `pill` is the severity (red = the record is wrong, amber = the record is
 * probably right but the day is suspicious), and `text` is the plain-English
 * tooltip on both the pill and the filter chip.
 *
 * Object key order is also the display/sort order — and it happens to be
 * exactly severity order (both reds first) while also being alphabetical, so
 * `RULE_ORDER` needs no separate list to keep in sync.
 */
const RULE_META = {
  UNDEPLOYED_SCAN: {
    label: 'Undeployed scan',
    pill: 'pill-red',
    text: 'Badge scanned with no deployment for this schedule',
  },
  BAD_STATUS: {
    label: 'Ineligible badge',
    pill: 'pill-red',
    text: 'Badge status outside OPEN/PERMANENT (e.g. ELDERLY) at scan time',
  },
  MULTI_SESSION: {
    label: '3+ sessions/day',
    pill: 'pill-amber',
    text: 'Same badge scanned IN 3 or more times on one date',
  },
  STALE_OPEN: {
    label: 'Stale OPEN',
    pill: 'pill-amber',
    text: 'IN recorded before today (IST) with no OUT — likely missed OUT',
  },
  VSS_DEPT_MISMATCH: {
    label: 'VSS in non-VSS dept',
    pill: 'pill-amber',
    text: 'VSS badge scanned into a department not opened for VSS',
  },
}
const RULE_ORDER = Object.keys(RULE_META)

// A rule this page has never heard of must still be visible, countable and
// exportable — a new server-side rule may not vanish from the operator's view
// just because the frontend is older than the database. Plain accessors, NOT
// a fallback object with a function-valued `label`: React silently renders a
// function child as nothing, which would ship a blank chip and a blank pill.
const ruleLabel = (rule) => RULE_META[rule]?.label || String(rule || 'UNKNOWN').replace(/_/g, ' ')
const rulePill = (rule) => RULE_META[rule]?.pill || 'pill-gray'
const ruleText = (rule) => RULE_META[rule]?.text || 'Reported by the server but not in this page’s rule list'

/** Centre for display + sorting: a null home centre is never a blank cell. */
const centreOf = (r) => r?.sewadar_centre || UNASSIGNED_CENTRE

/**
 * Desktop feed columns for the shared <DataTable>. Cell content is kept
 * pixel-identical to the old hand-rolled table (severity pills, mono badge /
 * date, null-safe em-dashes); the primitive owns the wrap / sticky header /
 * data-label attributes / skeleton / empty chrome.
 */
const ANOMALY_COLUMNS = [
  {
    key: 'rule',
    label: 'Rule',
    render: (r) => (
      <span className={`pill ${rulePill(r.rule)}`} title={ruleText(r.rule)}>{ruleLabel(r.rule)}</span>
    ),
  },
  {
    key: 'badge_number',
    label: 'Badge',
    mono: true,
    render: (r) => <span style={{ fontSize: '0.8rem' }}>{r.badge_number}</span>,
  },
  {
    key: 'sewadar_name',
    label: 'Name',
    render: (r) => <span style={{ fontWeight: 500 }}>{r.sewadar_name || '—'}</span>,
  },
  {
    key: 'sewadar_centre',
    label: 'Centre',
    render: (r) => <span style={{ color: 'var(--text-sec)' }}>{centreOf(r)}</span>,
  },
  {
    key: 'dept_name',
    label: 'Department',
    render: (r) => <span style={{ color: 'var(--text-sec)' }}>{r.dept_name || '—'}</span>,
  },
  {
    key: 'detail',
    label: 'Detail',
    render: (r) => <span style={{ color: '#475569', fontSize: '0.82rem' }}>{r.detail || '—'}</span>,
  },
  {
    key: 'event_date',
    label: 'Date',
    mono: true,
    // BAD_STATUS reports the CURRENT badge status, so it is visit-level by
    // design and carries no event date.
    render: (r) => <span style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{r.event_date || '—'}</span>,
  },
  {
    key: 'open',
    label: '',
    // Unmissable click affordance: every row opens the badge's info trail.
    render: () => <span aria-hidden="true" title="Open the full trail" style={{ color: 'var(--primary-dark)', fontWeight: 800 }}>›</span>,
  },
]
// A rule can report the same badge on more than one date (MULTI_SESSION), so
// the key needs the date too.
const anomalyRowKey = (r, i) => `${r.rule}-${r.badge_number}-${r.event_date || 'na'}-${i}`

// The server caps the anomaly feed: each rule reports at most RULE_CAP rows and
// the whole result at most TOTAL_CAP rows (sql/v45 LIMIT 1000 — the feed shows
// the NEWEST rows first). A count sitting exactly on a cap is therefore a lower
// bound, and the UI must say so: "200+" with a "showing newest N" note, on the
// tiles, on the chips, and in the Counts export sheet. Without this a capped
// feed reads as an exact census.
const RULE_CAP = 200
const TOTAL_CAP = 1000
// Numbers stay numbers below the cap (the Counts export sheet keeps numeric
// cells); only a capped value becomes a "200+"/"1000+" string.
const cappedRuleCount = (n) => (n >= RULE_CAP ? `${RULE_CAP}+` : n)
const cappedTotal = (n) => (n >= TOTAL_CAP ? `${TOTAL_CAP}+` : n)

/**
 * Anomalies — the read-only anomaly feed over `attendance_anomalies`
 * (sql/v45_attendance_reports.sql §6).
 *
 * SCOPE IS ENFORCED SERVER-SIDE. The RPC resolves the caller's own scope
 * inside the function and returns `[]` for a role it does not cover, so this
 * page never filters by role: it renders exactly what the RPC returns. Do NOT
 * add a client-side role filter — it would only mask a DB scope bug.
 *
 * `p_date` has two distinct meanings and the difference is load-bearing: NULL is
 * the whole visit, a date is "rows touching that event-date (IN or OUT on
 * it)". So the default is deliberately the whole visit, and a real empty
 * result is a statement about the visit, not about one day.
 */
export default function AnomaliesPage({ schedules = [], scheduleId, onNavigate }) {
  const toast = useToast()
  const schedule = schedules.find((s) => s.id === scheduleId)

  // '' = whole visit (p_date: null). See the p_date note above.
  const [date, setDate] = useState('')
  // Bhati Visit shows visit-days data only: pin the picker inside the
  // window ('' = whole-visit sweep and windowless schedules pass through).
  const visitWin = useMemo(() => scheduleWindow(schedule), [schedule])
  useEffect(() => { setDate((d) => clampDateToWindow(d, visitWin)) }, [visitWin])
  const [raw, setRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [rule, setRule] = useState('all')
  // A11: an RPC failure must render a visible error panel, not a silent [].
  const [loadError, setLoadError] = useState(null)
  // Which schedule the rows in state actually belong to. Rows from the previous
  // schedule must never be shown (or exported) under the new one.
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const mountedRef = useRef(true)
  // A monotonically increasing request sequence — a slow load for the whole
  // visit must not overwrite a fast load for one date (or vice versa).
  const seqRef = useRef(0)

  // ─── Load ───
  const load = useCallback(async () => {
    // Clear the spinner on the no-schedule path too. Leaving `loading` true
    // here latched the page on its spinner with no timeout and no error.
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      // supabase-js RESOLVES with `{ error }` on a failed RPC — it does not
      // reject — so without an explicit throw a missing function (PGRST202),
      // an RLS denial or a dropped connection all render as a clean, wrong
      // "no anomalies" visit.
      const { data, error } = await supabase.rpc('attendance_anomalies', {
        p_schedule: scheduleId,
        p_date: date || null,
      })
      if (!mountedRef.current || seq !== seqRef.current) return
      if (error) {
        const msg = error.message || error.code || 'Unknown error'
        throw new Error(`attendance_anomalies: ${msg}`)
      }
      setRaw(Array.isArray(data) ? data : [])
      setRowsScheduleId(scheduleId)
      setLoadError(null)
    } catch (e) {
      if (!mountedRef.current || seq !== seqRef.current) return
      // Friendly on screen, complete in the console — the raw backend text
      // (function names, PGRST202, the server's own wording) never reaches a
      // centre user, but stays one devtools away for whoever has to debug it.
      console.error('[Anomalies] load failed:', e)
      setLoadError(e?.message || 'Unknown error')
      setRaw([])
      setRowsScheduleId(scheduleId)
      toast.error('Could not load anomalies')
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, date, toast])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // Realtime: an anomaly created mid-visit (a new stale OPEN, a 3rd session)
  // should show up without a manual refresh. Shared hook: a burst of scans
  // coalesces into ONE reload via the trailing debounce. Channel, bindings
  // and debounce are unchanged (L-34: deployments changes move the expected
  // denominators, so sessions alone would leave the feed stale).
  useRealtimeRefresh({
    scheduleId,
    channelName: `anomalies-${scheduleId}`,
    subscriptions: [
      { table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` },
      { table: 'deployments', filter: `schedule_id=eq.${scheduleId}` },
    ],
    onReload: load,
    label: 'anomalies',
    debounceMs: 400,
  })

  // ─── Derived rows ───
  // Until the in-flight load for THIS schedule lands, there are no rows —
  // feeding the builders the previous schedule's would render them under the
  // new schedule's name.
  const rowsAreCurrent = rowsScheduleId === scheduleId
  const base = useMemo(() => (rowsAreCurrent ? raw : []), [raw, rowsAreCurrent])

  const counts = useMemo(() => anomalyCounts(base), [base])

  // Any rule sitting on the server cap (or the whole result on the total cap)
  // means the feed is truncated: counts below are lower bounds over the newest
  // N rows, not a census of the visit.
  const isCapped = useMemo(
    () => base.length >= TOTAL_CAP || Object.values(counts).some((n) => n >= RULE_CAP),
    [base, counts]
  )
  const capNote = isCapped ? `Showing newest ${base.length} — counts hit the server cap` : null

  // Known rules first (severity order), then anything the server sent that this
  // page does not know, alphabetically — never drop a rule silently.
  const rules = useMemo(() => {
    const seen = Object.keys(counts)
    return [
      ...RULE_ORDER.filter((r) => seen.includes(r)),
      ...seen.filter((r) => !RULE_META[r]).sort(),
    ]
  }, [counts])

  // A rule chip can disappear between schedules (an unknown rule simply is not
  // reported any more). Drop the stale selection so the table is never empty
  // behind a chip that is still rendered as active.
  useEffect(() => {
    setRule((cur) => (cur === 'all' || rules.includes(cur) ? cur : 'all'))
  }, [rules])

  const filtering = rule !== 'all' || search.trim() !== ''

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return base
      .filter((r) => rule === 'all' || r?.rule === rule)
      .filter((r) => !q
        || String(r?.badge_number || '').toLowerCase().includes(q)
        || String(r?.sewadar_name || '').toLowerCase().includes(q)
        || String(r?.sewadar_centre || '').toLowerCase().includes(q))
      // rule → centre → badge. `sort` on the filtered copy, never on `base`.
      .sort((a, b) => {
        const ai = RULE_ORDER.indexOf(a?.rule)
        const bi = RULE_ORDER.indexOf(b?.rule)
        const ao = ai === -1 ? RULE_ORDER.length : ai
        const bo = bi === -1 ? RULE_ORDER.length : bi
        if (ao !== bo) return ao - bo
        const c = centreOf(a).localeCompare(centreOf(b))
        if (c !== 0) return c
        return String(a?.badge_number || '').localeCompare(String(b?.badge_number || ''))
      })
  }, [base, rule, search])

  const [filtersOpen, setFiltersOpen] = useState(false)
  // Drill-in: clicking any anomaly row (every rule) opens its info trail.
  // Reset on schedule change — a row from the previous schedule would fetch
  // the new schedule's trail under the old row's identity.
  const [selected, setSelected] = useState(null)
  useEffect(() => { setSelected(null) }, [scheduleId])
  const clearFilters = () => { setRule('all'); setSearch(''); setDate('') }
  const filterChips = useMemo(() => {
    const chips = []
    if (rule !== 'all') chips.push({ key: 'rule', label: ruleLabel(rule) })
    if (search.trim()) chips.push({ key: 'search', label: `"${search.trim()}"` })
    if (date) chips.push({ key: 'date', label: shortDayLabel(date) })
    return chips
  }, [rule, search, date])
  const clearFilterChip = (key) => {
    if (key === 'rule') setRule('all')
    else if (key === 'search') setSearch('')
    else if (key === 'date') setDate('')
  }
  const filterResultText = `${visible.length} of ${base.length}`

  // ─── Excel ───
  const exportFilename = `${fileSlug(schedule?.name)}_${date || 'visit'}_anomalies.xlsx`
  // Sheet rows are built WITHOUT saving so desktop (direct download) and
  // mobile (share sheet) share one builder — the two paths can never drift.
  const buildExportSheets = () => ([
          {
            name: 'Anomalies',
            rows: visible.map((r) => ({
              Rule: ruleLabel(r.rule),
              Badge: r.badge_number,
              Name: r.sewadar_name || '—',
              Centre: centreOf(r),
              Department: r.dept_name || '—',
              Detail: r.detail || '—',
              Date: r.event_date || '—',
            })),
          },
          {
            // Counts are over the WHOLE result set, not the filtered view, so
            // the sheet answers "what fired today" rather than "what am I
            // looking at". A count on the server cap is a lower bound over the
            // newest rows — rendered "200+" with the cap note below, never a
            // bare number that reads as exact.
            name: 'Counts',
            rows: [
              ...Object.entries(counts).map(([r, n]) => ({ Rule: ruleLabel(r), Count: cappedRuleCount(n) })),
              ...(isCapped ? [{ Rule: `Note: ${capNote}`, Count: '' }] : []),
            ],
          },
        ]
  )

  const isMobile = useIsMobile()
  // Shared export driver (desktop anchor download / mobile share sheet).
  // Toasts stay in the page: the hook returns the written count and the page
  // Export through the shared <ExportButton>. The old hand-rolled exportExcel
  // pre-checked `visible.length` on BOTH desktop and mobile, so that guard
  // runs here on the capture phase (same shape as ReportsPage): a guarded
  // press never reaches the button and the workbook is never built. The
  // desktop result toasts stay in the page — identical strings.
  const guardExportPress = (e) => {
    if (!visible.length) {
      toast.warning('No anomalies to export')
      e.stopPropagation()
      e.preventDefault()
    }
  }
  const onExported = (written) => {
    if (!written) toast.warning('No anomalies to export')
    else toast.success('Anomalies exported')
  }
  const onExportError = (e) => { toast.error(e?.message || 'Export failed') }

  // ─── Guards (early returns, so no hooks run after them) ───
  if (!schedules.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }

  if (loading && !base.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <DataTable columns={ANOMALY_COLUMNS} rows={[]} loading skeletonRows={6} label="Attendance anomalies" />
      </div>
    )
  }

  // A failed read is NOT a clean visit. Missing function (PGRST202), an
  // RLS/permission denial or a dropped connection all land here and say so,
  // instead of rendering "No anomalies".
  if (loadError) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '1.5rem', maxWidth: 720, margin: '0 auto' }} role="alert">
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <ShieldAlert size={18} style={{ color: 'var(--err)' }} />
            <h3 className="empty-title" style={{ margin: 0 }}>Could not load anomalies</h3>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', margin: 0 }}>
            The anomaly rules could not be read from the server.
          </p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-sec)', margin: '0.75rem 0 0' }}>
            The attendance reports functions may not be installed on this database, or your role may
            not be permitted to read them. No anomalies are shown, because none could be loaded.
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

  const go = (target, payload) => onNavigate?.(target, payload)

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <PageHeader
        icon={<ShieldAlert size={22} />}
        title="Anomalies"
        sub="Read-only — no resolve actions in v1"
        pills={
          <ViewOnlyPill title="Anomalies are computed by the database — there is nothing to change here. Fix the scan or the deployment record itself." />
        }
        actions={
          <>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <span onClickCapture={guardExportPress}>
              <ExportButton
                filename={exportFilename}
                buildSheets={buildExportSheets}
                disabled={!rowsAreCurrent}
                onExported={onExported}
                onExportError={onExportError}
              />
            </span>
            <PrintPdfButton className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }} />
            {/* The dashboard deep-links here for a rule; the jump used to be
                one-way because this page discarded the onNavigate prop. */}
            <button onClick={() => go('dashboard')} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              <ArrowUpRight size={12} /> Back to dashboard
            </button>
            {filtering && (
              <span className="pill pill-indigo" title="The table and the Excel export show this filtered set">
                Showing {visible.length} of {base.length}
              </span>
            )}
          </>
        }
        aside={
          <>
            <div>
              <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Anomaly date</div>
              <input
                type="date"
                value={date}
                min={visitWin.start || undefined}
                max={visitWin.end || undefined}
                onChange={(e) => setDate(clampDateToWindow(e.target.value, visitWin))}
                className="input"
                style={{ minHeight: 44 }}
                aria-label="Anomaly date"
              />
            </div>
            {/* "All dates (visit)" is a real option, not a label: it is the only
                way to reach p_date = null once a date has been picked, and it is
                the active state whenever no date is set. */}
            <button onClick={() => setDate('')} className={`seg-btn ${date ? '' : 'seg-active'}`} style={{ minHeight: 44 }} aria-pressed={!date}>
              All dates (visit)
            </button>
            <button onClick={() => setDate(clampDateToWindow(todayStrIST(), visitWin))} className={`seg-btn ${date === todayStrIST() ? 'seg-active' : ''}`} style={{ minHeight: 44 }}>
              Today
            </button>
          </>
        }
      />

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <KpiTile
          label="Anomalies"
          value={cappedTotal(base.length)}
          sub={`${date ? `on ${shortDayLabel(date)}` : 'across the whole visit'}${isCapped ? ' · showing newest' : ''}`}
          tone={base.length ? '#b45309' : undefined}
        />
        <KpiTile
          label="Rules fired"
          value={Object.keys(counts).length}
          sub={`of ${RULE_ORDER.length} known rules`}
        />
        <KpiTile
          label="Red"
          value={(counts.UNDEPLOYED_SCAN || 0) + (counts.BAD_STATUS || 0)}
          sub="record is wrong"
          tone={(counts.UNDEPLOYED_SCAN || 0) + (counts.BAD_STATUS || 0) ? 'var(--err)' : undefined}
        />
        <KpiTile
          label="Amber"
          value={(counts.MULTI_SESSION || 0) + (counts.STALE_OPEN || 0) + (counts.VSS_DEPT_MISMATCH || 0)}
          sub="day looks suspicious"
          tone={(counts.MULTI_SESSION || 0) + (counts.STALE_OPEN || 0) + (counts.VSS_DEPT_MISMATCH || 0) ? '#b45309' : undefined}
        />
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        {isMobile && (
          <MobileFilterBar
            onOpen={() => setFiltersOpen(true)}
            chips={filterChips}
            onClearChip={clearFilterChip}
            onClearAll={clearFilters}
            resultText={filterResultText}
            activeCount={filterChips.length}
          />
        )}
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div className={isMobile ? 'anomaly-rules-scroll' : undefined} style={{ display: 'flex', gap: '0.4rem', flexWrap: isMobile ? 'nowrap' : 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => setRule('all')}
              className={`seg-btn ${rule === 'all' ? 'seg-active' : ''}`}
              title={isCapped ? `Every rule that fired (${capNote})` : 'Every rule that fired'}
            >
              All ({cappedTotal(base.length)})
            </button>
            {rules.map((r) => (
              <button
                key={r}
                onClick={() => setRule(r)}
                className={`seg-btn ${rule === r ? 'seg-active' : ''}`}
                title={counts[r] >= RULE_CAP ? `${ruleText(r)} (${capNote})` : ruleText(r)}
              >
                {ruleLabel(r)} ({cappedRuleCount(counts[r])})
              </button>
            ))}
            {isCapped && (
              <span style={{ fontSize: '0.74rem', color: '#b45309', fontWeight: 600 }}>
                {capNote}
              </span>
            )}
            {rules.length === 0 && (
                <span style={{ fontSize: '0.78rem', color: 'var(--text-sec)' }}>
                No rule fired{date ? ` on ${shortDayLabel(date)}` : ' for this visit'} — only “All” is available.
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {!isMobile && (
            <div style={{ position: 'relative', minWidth: 200 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search badge / name / centre..."
                className="input"
                style={{ width: '100%', paddingLeft: 30 }}
                aria-label="Search anomalies"
              />
            </div>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title={filtering ? 'No anomalies for this filter' : 'No anomalies'}
            hint={filtering
              ? 'Try clearing the filters.'
              : `No anomaly rule fired${date ? ` on ${shortDayLabel(date)}` : ' for this visit'}.`}
          />
        ) : isMobile ? (
          <VirtualList
            items={visible}
            estimateSize={96}
            ariaLabel="Attendance anomalies"
            empty={null}
            renderRow={(r) => (
              <div
                className="att-card"
                role="button"
                tabIndex={0}
                aria-label={`Open details for anomaly ${r.badge_number}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelected(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelected(r)
                  }
                }}
              >
                <div className="att-card-top">
                  <span className={`pill ${rulePill(r.rule)}`} title={ruleText(r.rule)}>{ruleLabel(r.rule)}</span>
                  <span className="att-card-badge">{r.badge_number}</span>
                </div>
                <div className="att-card-name">{r.sewadar_name || '—'}</div>
                <div className="att-card-meta">
                  <span>{centreOf(r)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{r.dept_name || '—'}</span>
                </div>
                <div className="att-card-foot">
                  <span className="att-card-times">{r.detail || '—'}</span>
                  <span className="att-card-times">{r.event_date || '—'}</span>
                  <span aria-hidden="true" title="Open the full trail" style={{ color: 'var(--primary-dark)', fontWeight: 800 }}>›</span>
                </div>
              </div>
            )}
          />
        ) : (
          <DataTable
            columns={ANOMALY_COLUMNS}
            rows={visible}
            rowKey={anomalyRowKey}
            label="Attendance anomalies"
            onRowClick={(r) => setSelected(r)}
          />
        )}
      </div>

      <div className="page-sub" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <ShieldAlert size={13} />
        An anomaly is cleared by fixing the underlying scan or deployment record — this page never
        writes, and there is no “resolve” action to click.
      </div>
      <div className="page-sub" style={{ marginTop: '0.25rem' }}>
        Tip: click any row (or tap a card) to open that badge’s full scan trail with deployment + consent.
      </div>

      <FilterSheet
        open={isMobile && filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Anomaly filters"
        resultText={filterResultText}
        onClearAll={clearFilters}
        hasActive={filterChips.length > 0}
      >
        <div className="previsit-field">
          <span className="previsit-label">Search</span>
          <span className="previsit-search">
            <Search size={14} aria-hidden="true" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search badge / name / centre..." className="input previsit-control" aria-label="Search anomalies" />
          </span>
        </div>
        <div className="previsit-field">
          <span className="previsit-label">Anomaly date</span>
          <input
            type="date"
            value={date}
            min={visitWin.start || undefined}
            max={visitWin.end || undefined}
            onChange={(e) => setDate(clampDateToWindow(e.target.value, visitWin))}
            className="input previsit-control"
            aria-label="Anomaly date"
          />
        </div>
      </FilterSheet>

      {/* The mobile share sheet lives inside <ExportButton>. */}
      {selected && (
        <AnomalyDetailPopup
          row={selected}
          scheduleId={scheduleId}
          related={visible.filter((r) => r !== selected && r.badge_number === selected.badge_number)}
          ruleMeta={RULE_META}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
