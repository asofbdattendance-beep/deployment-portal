import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { anomalyCounts, UNASSIGNED_CENTRE, shortDayLabel } from '../lib/attendance'
import { todayStrIST } from '../lib/scannerUtils'
import { scheduleWindow, clampDateToWindow } from '../lib/sewaMode'
import { exportWorkbook, fileSlug } from '../lib/excel'
import {
  ShieldAlert, Download, Lock, RefreshCw, Loader2, Search, ArrowUpRight,
} from 'lucide-react'
import { reportRealtimeStatus } from '../lib/realtime'

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
  const [exporting, setExporting] = useState(false)
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
  // should show up without a manual refresh. Debounced so a burst of scans
  // triggers ONE reload, not dozens.
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
      .channel(`anomalies-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-34: deployments changes (ASO finalizes, rows become deployed)
      // move the expected denominators behind these numbers — sessions
      // alone leave them stale until a manual refresh.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, reload)
      // L-40: realtime membership is not guaranteed — a dead channel
      // used to fail silently. Name the state so it lands in devtools.
      .subscribe((status) => {
        reportRealtimeStatus('anomalies', status, alive)
      })
    return () => { alive = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

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

  // ─── Excel ───
  const exportExcel = useCallback(async () => {
    if (!visible.length) {
      toast.warning('No anomalies to export')
      return
    }
    setExporting(true)
    try {
      const written = await exportWorkbook(
        `${fileSlug(schedule?.name)}_${date || 'visit'}_anomalies.xlsx`,
        [
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
      if (!written) {
        toast.warning('No anomalies to export')
        return
      }
      toast.success('Anomalies exported')
    } catch (e) {
      toast.error(e?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }, [visible, counts, isCapped, capNote, schedule, date, toast])

  // ─── Guards (early returns, so no hooks run after them) ───
  if (!schedules.length) {
    return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>
  }

  if (loading && !base.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card"><div className="empty"><div className="spin" style={{ width: 24, height: 24, border: '2px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin .6s linear infinite' }} /><div className="empty-text">Loading anomalies…</div></div></div>
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
            <ShieldAlert size={18} style={{ color: '#b91c1c' }} />
            <h3 className="empty-title" style={{ margin: 0 }}>Could not load anomalies</h3>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', margin: 0 }}>
            The anomaly rules could not be read from the server.
          </p>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.75rem 0 0' }}>
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
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><ShieldAlert size={22} /> Anomalies</h2>
          <div className="page-sub">Read-only — no resolve actions in v1 · scope is enforced by the database for your role</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill" title="Anomalies are computed by the database — there is nothing to change here. Fix the scan or the deployment record itself." style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
              <Lock size={12} /> View-only
            </span>
            <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
              {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
            </button>
            <button onClick={exportExcel} disabled={exporting || !rowsAreCurrent} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export Excel
            </button>
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
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div className="stat-label" style={{ marginBottom: '0.2rem' }}>Anomaly date</div>
            <input
              type="date"
              value={date}
              min={visitWin.start || undefined}
              max={visitWin.end || undefined}
              onChange={(e) => setDate(clampDateToWindow(e.target.value, visitWin))}
              className="input"
              style={{ height: 36 }}
              aria-label="Anomaly date"
            />
          </div>
          {/* "All dates (visit)" is a real option, not a label: it is the only
              way to reach p_date = null once a date has been picked, and it is
              the active state whenever no date is set. */}
          <button onClick={() => setDate('')} className={`seg-btn ${date ? '' : 'seg-active'}`} style={{ height: 36 }} aria-pressed={!date}>
            All dates (visit)
          </button>
          <button onClick={() => setDate(clampDateToWindow(todayStrIST(), visitWin))} className={`seg-btn ${date === todayStrIST() ? 'seg-active' : ''}`} style={{ height: 36 }}>
            Today
          </button>
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Anomalies</div>
          <div className="stat-value" style={{ color: base.length ? '#b45309' : undefined }}>{cappedTotal(base.length)}</div>
          <div className="stat-sub">{date ? `on ${shortDayLabel(date)}` : 'across the whole visit'}{isCapped ? ' · showing newest' : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Rules fired</div>
          <div className="stat-value">{Object.keys(counts).length}</div>
          <div className="stat-sub">of {RULE_ORDER.length} known rules</div>
        </div>
        <div className="stat">
          <div className="stat-label">Red</div>
          <div className="stat-value" style={{ color: (counts.UNDEPLOYED_SCAN || 0) + (counts.BAD_STATUS || 0) ? '#b91c1c' : undefined }}>
            {(counts.UNDEPLOYED_SCAN || 0) + (counts.BAD_STATUS || 0)}
          </div>
          <div className="stat-sub">record is wrong</div>
        </div>
        <div className="stat">
          <div className="stat-label">Amber</div>
          <div className="stat-value" style={{ color: '#b45309' }}>
            {(counts.MULTI_SESSION || 0) + (counts.STALE_OPEN || 0) + (counts.VSS_DEPT_MISMATCH || 0)}
          </div>
          <div className="stat-sub">day looks suspicious</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
              <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                No rule fired{date ? ` on ${shortDayLabel(date)}` : ' for this visit'} — only “All” is available.
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search badge / name / centre..."
              className="input"
              style={{ width: '100%', paddingLeft: 30 }}
              aria-label="Search anomalies"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><ShieldAlert size={22} /></div>
            <div className="empty-title">{filtering ? 'No anomalies for this filter' : 'No anomalies'}</div>
            <div className="empty-text">
              {filtering
                ? 'Try clearing the filters.'
                : `No anomaly rule fired${date ? ` on ${shortDayLabel(date)}` : ' for this visit'}.`}
            </div>
          </div>
        ) : (
          <div className="table-wrap table-wrap-sticky">
            <table className="table table-sticky">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Badge</th>
                  <th>Name</th>
                  <th>Centre</th>
                  <th>Department</th>
                  <th>Detail</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  // A rule can report the same badge on more than one date
                  // (MULTI_SESSION), so the key needs the date too.
                  <tr key={`${r.rule}-${r.badge_number}-${r.event_date || 'na'}-${i}`}>
                    <td data-label="Rule">
                      <span className={`pill ${rulePill(r.rule)}`} title={ruleText(r.rule)}>{ruleLabel(r.rule)}</span>
                    </td>
                    <td data-label="Badge" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{r.badge_number}</td>
                    <td data-label="Name" style={{ fontWeight: 500 }}>{r.sewadar_name || '—'}</td>
                    <td data-label="Centre" style={{ color: '#64748b' }}>{centreOf(r)}</td>
                    <td data-label="Department" style={{ color: '#64748b' }}>{r.dept_name || '—'}</td>
                    <td data-label="Detail" style={{ color: '#475569', fontSize: '0.82rem' }}>{r.detail || '—'}</td>
                    {/* BAD_STATUS reports the CURRENT badge status, so it is
                        visit-level by design and carries no event date. */}
                    <td data-label="Date" style={{ fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{r.event_date || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="page-sub" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <ShieldAlert size={13} />
        An anomaly is cleared by fixing the underlying scan or deployment record — this page never
        writes, and there is no “resolve” action to click.
      </div>
    </div>
  )
}
