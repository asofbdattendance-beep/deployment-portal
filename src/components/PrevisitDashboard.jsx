import { useMemo, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { usePrevisitData } from '../hooks/usePrevisitData'
import { previsitKpis, previsitByDay, previsitByDept } from '../lib/previsit'
import { shortDayLabel } from '../lib/attendance'

/**
 * PrevisitDashboard — the SUMMARY half of the previsit surface, mounted on
 * the dashboard tabs (Dashboard for aso/super_admin, Dashboard for
 * dept_incharge) when the global sewa mode is "previsit".
 *
 * Sibling PrevisitView (reports tabs) owns the filterable IN/OUT table +
 * Excel; this page answers "how did each sewa day go" — KPI tiles, a
 * present-by-day strip and per-day / per-department breakdowns. Both read
 * through the shared usePrevisitData hook, so dashboard and reports can
 * never disagree about what the server said.
 */
export default function PrevisitDashboard({ schedules = [], scheduleId }) {
  const schedule = (schedules || []).find((s) => s.id === scheduleId)
  const { summary, loading, loadError, rowsScheduleId, reload } = usePrevisitData(scheduleId)

  // Hold the last good snapshot while a refresh is in flight (same as
  // PrevisitView): no false-zero tiles, no empty-state flash.
  const shownRef = useRef({ summary: [], scheduleId: null })
  if (rowsScheduleId === scheduleId) {
    shownRef.current = { summary, scheduleId }
  }
  const live = useMemo(
    () => (shownRef.current.scheduleId === scheduleId ? shownRef.current.summary : []),
    // rowsScheduleId/summary are invalidation-only deps: the ref is written
    // during render, so the linter cannot see the relationship.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsScheduleId, scheduleId, summary]
  )
  const kpis = useMemo(() => previsitKpis(live), [live])
  const byDay = useMemo(() => previsitByDay(live), [live])
  const byDept = useMemo(() => previsitByDept(live), [live])
  const deptCount = byDept.length
  const maxPresent = byDay.reduce((m, d) => Math.max(m, d.present), 0)

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
          <h2 className="page-title">Previsit Sewa Dashboard{schedule ? ` · ${schedule.name}` : ''}</h2>
          <div className="page-sub">
            One day is one sewa · scope is enforced by the database for your role
          </div>
        </div>
        <div className="cluster">
          <button onClick={reload} className="btn" disabled={loading} title="Reload">
            <RefreshCw size={14} /> {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="card" role="alert" style={{ borderColor: '#fca5a5', background: '#fef2f2', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.85rem', color: '#b91c1c' }}>{loadError}</div>
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Sewa days</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{kpis.sewas}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total present</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{kpis.present}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open sessions</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{kpis.openNow}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Departments</div>
          <div className="stat-value" style={{ fontVariantNumeric: 'tabular-nums' }}>{deptCount}</div>
        </div>
      </div>

      {loading && live.length === 0 ? (
        <div className="card" style={{ marginTop: '0.75rem' }}><div className="empty"><div className="empty-title">Loading previsit sewa…</div></div></div>
      ) : byDay.length === 0 ? (
        <div className="card" style={{ marginTop: '0.75rem' }}><div className="empty">
          <div className="empty-title">No previsit sewa recorded</div>
          <div className="empty-text">Nobody has scanned outside the visit window for this schedule yet.</div>
        </div></div>
      ) : (
        <>
          <div className="card previsit-card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">Present by sewa day</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
              {byDay.map((d) => (
                <div key={d.date} style={{ display: 'grid', gridTemplateColumns: '92px 1fr auto', gap: '0.6rem', alignItems: 'center' }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem', fontWeight: 600 }} title={d.date}>{shortDayLabel(d.date)}</span>
                  <span className="progress" title={`${d.present} present`}>
                    <span
                      className="progress-bar"
                      style={{ width: `${maxPresent > 0 ? Math.round((d.present / maxPresent) * 100) : 0}%` }}
                    />
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem', minWidth: 72, textAlign: 'right' }}>
                    {d.present} present{d.openNow > 0 ? ` · ${d.openNow} open` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card previsit-card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">By department</div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Department</th><th style={{ textAlign: 'right' }}>Sewas</th><th style={{ textAlign: 'right' }}>Present</th></tr>
                </thead>
                <tbody>
                  {byDept.map((g) => (
                    <tr key={g.id || 'none'}>
                      <td data-label="Department">{g.name}</td>
                      <td data-label="Sewas" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{g.sewas}</td>
                      <td data-label="Present" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{g.present}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
