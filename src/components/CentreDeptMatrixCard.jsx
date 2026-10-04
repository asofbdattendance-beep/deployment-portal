import { useMemo, useState } from 'react'
import { BarChart3, ChevronDown, ChevronRight, Users } from 'lucide-react'
import { buildCentreTree, buildVisitRows, rateBand } from '../lib/attendance'

// Rate band → pill colour. One place, copied verbatim from AttendancePage so
// the two dashboards read the same number the same way.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none

// Heat legend for the matrix cells. Subdued washes only — the numbers stay
// the source of truth (tests pin the present/deployed text).
const HEAT_LEGEND = [
  { band: 'full', label: 'All scanned', dot: '#10b981' },
  { band: 'partial', label: 'Half or more', dot: '#3b82f6' },
  { band: 'low', label: 'Some scanned', dot: '#f59e0b' },
  { band: 'none', label: 'None scanned', dot: '#fca5a5' },
]
const BAND_FILL = { full: '#10b981', partial: '#3b82f6', low: '#f59e0b', none: '#e2e8f0' }
const HEAT_BG = { full: '#f0fdf4', partial: '#eff6ff', low: '#fffbeb', none: '#fef2f2' }

/**
 * Attendance rate as a whole percent, clamped to 0..100 (an over-count day
 * reads 100%, never 120%), or `null` when there was no denominator.
 *
 * @param {number|string} part present count
 * @param {number|string} whole deployed / expected count
 * @returns {number|null}
 */
function pct(part, whole) {
  const p = Number(part) || 0
  const w = Number(whole) || 0
  if (w <= 0) return null
  return Math.min(100, Math.max(0, Math.round((p / w) * 100)))
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
 * CentreDeptMatrixCard — the centre × department attendance matrix as a
 * dashboard card. Restored from the baf8f34 Reports matrix (commit on
 * feat/aso-superadmin-reports), minus the Reports filter machinery: this card
 * is PRESENTATIONAL — the mount site owns fetching, so the dashboard's RPC
 * contract (exactly the five attendance_* RPCs, no hidden table reads) stays
 * testable. `rows` are raw `attendance_visit_summary` rows; `centres` is the
 * dp_centres list used to roll SC_SP children up under their parent centre.
 *
 * Grid: departments across the top, centres down the side, parent centres
 * collapsed to their subtree aggregate with an expand toggle, plus a TOTAL
 * row and a per-department summary strip above the grid.
 */
export default function CentreDeptMatrixCard({ rows = [], centres = [], error = null, onRetry = null, style = undefined }) {
  const [expanded, setExpanded] = useState(() => new Set())

  /**
   * One uniform row shape so the grid and the totals never branch on the
   * source RPC's naming. `deployed` is the denominator the rate is taken
   * over; `present` counts sewadars scanned on ≥1 visit day.
   */
  const matrixRows = useMemo(() => {
    const { rows: built } = buildVisitRows(rows)
    return built.map((r) => ({
      centre: r.centre,
      deptName: r.deptName,
      deployed: r.deployed,
      present: r.everPresent,
      absent: r.neverPresent,
      openNow: r.openNow,
    }))
  }, [rows])

  // Departments across the top, in a stable sorted order.
  const deptCols = useMemo(
    () => [...new Set(matrixRows.map((r) => r.deptName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [matrixRows],
  )
  // Parent-centre groups with collapsed aggregates.
  const tree = useMemo(() => buildCentreTree(matrixRows, centres), [matrixRows, centres])
  // Per-department column totals.
  const deptTotals = useMemo(() => {
    const map = new Map()
    for (const r of matrixRows) {
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
  }, [matrixRows])
  const totals = useMemo(
    () => matrixRows.reduce(
      (t, r) => ({
        deployed: t.deployed + r.deployed,
        present: t.present + r.present,
        absent: t.absent + r.absent,
        openNow: t.openNow + r.openNow,
      }),
      { deployed: 0, present: 0, absent: 0, openNow: 0 },
    ),
    [matrixRows],
  )
  const totalRate = pct(totals.present, totals.deployed)

  const toggleExpand = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const heatFor = (present, deployed) => {
    if (!deployed) return { band: 'none', style: {} }
    const band = rateBand(Math.round((present / deployed) * 100))
    return { band, style: { background: HEAT_BG[band] } }
  }

  const deptCell = (byDept, d) => {
    const c = byDept?.get(d)
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
        <td key={`${keyPrefix}-o`} data-label="Open now" style={{ textAlign: 'center', color: t.openNow ? '#b45309' : undefined }}>{t.openNow}</td>
      </>
    )
  }

  // An expanded parent with no rows of its own still needs its toggle row
  // (else it can never be collapsed), but a 0/0 there would be a phantom
  // "healthy zero" — muted em-dashes say "nothing of its own" instead.
  const emptyTailCells = (keyPrefix) => (
    <>
      <td key={`${keyPrefix}-t`} data-label="Total" style={{ textAlign: 'center', borderLeft: '2px solid #cbd5e1', background: '#f8fafc', color: '#cbd5e1' }}>—</td>
      <td key={`${keyPrefix}-a`} data-label="Absent" style={{ textAlign: 'center', color: '#cbd5e1' }}>—</td>
      <td key={`${keyPrefix}-o`} data-label="Open now" style={{ textAlign: 'center', color: '#cbd5e1' }}>—</td>
    </>
  )

  // A dashboard card has no centre filter to push into, so the centre name is
  // a plain label — only the expand toggle is interactive. role="rowheader"
  // keeps the centre as the row's identity for screen readers WITHOUT a
  // <th>: the mobile stacked-card CSS keys its label pseudo-element on
  // td::before, and a <th> would lose it.
  const centreLabelCell = (label, { childCount = 0, isOpen = false, onToggle = null, indent = false } = {}) => (
    <td data-label="Centre" role="rowheader" style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1, paddingLeft: indent ? '1.75rem' : undefined }}>
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
        <span style={{ fontWeight: indent ? 400 : 600 }}>{label}</span>
        {childCount > 0 ? (
          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 600 }}>(+{childCount})</span>
        ) : null}
      </span>
    </td>
  )

  return (
    <div className="card" style={{ padding: '1.1rem', ...style }}>
      <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <div className="section-title">
            <BarChart3 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} />
            Centre × department matrix
          </div>
          <div className="page-sub" style={{ margin: 0 }}>Visit-wide: scanned on at least one day, per centre and department</div>
        </div>
      </div>

      {/* A failed feed must never read as a healthy zero ("no deployed
          sewadars" on an RPC error is the lie the dashboard suite guards
          against) — the error gets its own state. */}
      {error ? (
        // role="alert": the failure surfaces asynchronously, long after the
        // page shell painted — screen readers must be told.
        <div className="empty" role="alert">
          <div className="empty-icon"><Users size={22} /></div>
          <div className="empty-title">The centre × department matrix could not be loaded</div>
          <div className="empty-text">{String(error)}</div>
          {onRetry ? (
            <button type="button" className="btn" style={{ marginTop: '0.75rem' }} onClick={onRetry}>Retry</button>
          ) : null}
        </div>
      ) : (
        <>
      {/* Department summary ABOVE the grid (divs, never a <table>: the test
          suite queries tables document-wide). One card per department. */}
      <div data-testid="dept-strip" style={{ padding: '0.9rem 0 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b' }}>Departments</span>
          <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
            {deptCols.length} department{deptCols.length === 1 ? '' : 's'} · {totals.present} of {totals.deployed} scanned
          </span>
          <span className={`pill ${bandPill(rateBand(totalRate ?? 0))}`} style={{ marginLeft: 'auto' }}>{rateLabel(totalRate)} overall</span>
        </div>
        {deptCols.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
            {deptCols.map((d) => {
              const c = deptTotals.get(d) || { deployed: 0, present: 0, absent: 0, openNow: 0 }
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
        )}
        {deptCols.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.6rem', fontSize: '0.7rem', color: '#64748b' }}>
            {HEAT_LEGEND.map((l) => (
              <span key={l.band} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: l.dot, flexShrink: 0 }} />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {tree.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><Users size={22} /></div>
          <div className="empty-title">Nothing to show</div>
          <div className="empty-text">No deployed sewadars for this schedule yet.</div>
        </div>
      ) : (
        <div className="table-wrap" style={{ marginTop: '0.75rem' }} data-testid="matrix-table">
          <table className="table rows-on-phone">
            <caption className="sr-only">Centre × department attendance matrix</caption>
            <thead>
              <tr>
                <th scope="col" style={{ position: 'sticky', left: 0, top: 0, background: '#fff', zIndex: 3 }}>Centre</th>
                {deptCols.map((d) => <th key={d} scope="col" title={d} style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', maxWidth: 130, whiteSpace: 'normal' }}>{d}</th>)}
                <th scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', borderLeft: '2px solid #cbd5e1', background: '#eef2ff', color: '#4f46e5' }}>Total</th>
                <th scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', background: '#eef2ff', color: '#4f46e5' }}>Absent</th>
                <th scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', background: '#eef2ff', color: '#4f46e5' }}>Open now</th>
              </tr>
            </thead>
            <tbody>
              {tree.map((g) => {
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
                const groupRows = []
                groupRows.push(
                  <tr key={`${g.key}::own`} style={{ borderTop: '2px solid #e2e8f0' }}>
                    {centreLabelCell(g.label, { isOpen: true, onToggle: () => toggleExpand(g.key) })}
                    {deptCols.map((d) => (g.own ? deptCell(g.own.byDept, d) : (
                      <td key={d} data-label={d} style={{ textAlign: 'center', color: '#cbd5e1' }}>—</td>
                    )))}
                      {g.own ? tailCells(g.own.total, `${g.key}::own`) : emptyTailCells(`${g.key}::own`)}
                  </tr>,
                )
                for (const c of g.children) {
                  groupRows.push(
                    <tr key={`${g.key}::${c.label}`}>
                      {centreLabelCell(c.label, { indent: true })}
                      {deptCols.map((d) => deptCell(c.byDept, d))}
                      {tailCells(c.total, `${g.key}::${c.label}`)}
                    </tr>,
                  )
                }
                return groupRows
              })}
              <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                <td style={{ fontWeight: 800 }}>TOTAL</td>
                {deptCols.map((d) => {
                  const c = deptTotals.get(d) || { deployed: 0, present: 0, absent: 0, openNow: 0 }
                  return (
                    <td key={d} data-label={d} style={{ textAlign: 'center', fontWeight: 800, whiteSpace: 'nowrap' }}>
                      <span>{c.present}</span>
                      <span style={{ color: '#94a3b8' }}>/{c.deployed}</span>
                    </td>
                  )
                })}
                <td data-label="Total" style={{ textAlign: 'center', fontWeight: 800, whiteSpace: 'nowrap', borderLeft: '2px solid #cbd5e1' }}>
                  <span>{totals.present}</span>
                  <span style={{ color: '#94a3b8' }}>/{totals.deployed}</span>{' '}
                  <span className={`pill ${bandPill(rateBand(totalRate ?? 0))}`}>{rateLabel(totalRate)}</span>
                </td>
                <td data-label="Absent" style={{ textAlign: 'center', fontWeight: 800 }}>{totals.absent}</td>
                <td data-label="Open now" style={{ textAlign: 'center', fontWeight: 800, color: totals.openNow ? '#b45309' : undefined }}>{totals.openNow}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
        </>
      )}
    </div>
  )
}
