import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import Skeleton from './mobile/Skeleton'
import CentreDayHeatmap from './CentreDayHeatmap'
import CentreDeptMatrixCard from './CentreDeptMatrixCard'
import { usePrevisitData } from '../hooks/usePrevisitData'
import { usePortalAuth } from '../context/PortalAuthContext'
import { supabase, fetchCentres } from '../lib/supabase'
import { previsitKpis, previsitByDay, previsitByDept, previsitCentreMatrix } from '../lib/previsit'
import { shortDayLabel } from '../lib/attendance'

/**
 * Single-shot RPC returning rows, throwing on error — the same local helper
 * DashboardPage uses (aggregate RPCs like attendance_visit_summary are not
 * per-badge feeds, so they must NOT go through the paged fetchAllRpc).
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
  const { summary, deployed, loading, loadError, rowsScheduleId, lastRefreshAt, reload } = usePrevisitData(scheduleId)
  const { profile } = usePortalAuth()
  // The centre × department matrix is the aso/super_admin overview — the
  // same card the Bhati-visit dashboard mounts, fed by the same
  // attendance_visit_summary RPC. dept_incharge keeps the previsit-only
  // surface: the matrix is the one piece it does not get.
  const isAso = profile?.role === 'aso' || profile?.role === 'super_admin'
  const [matrix, setMatrix] = useState({ rows: [], centres: [], error: null, scheduleId: null })
  const matrixMountedRef = useRef(true)
  useEffect(() => {
    matrixMountedRef.current = true
    return () => { matrixMountedRef.current = false }
  }, [])
  const fetchMatrix = useCallback(async () => {
    if (!isAso || !scheduleId) return
    try {
      const [rows, centres] = await Promise.all([
        rpcRows('attendance_visit_summary', { p_schedule: scheduleId }),
        // Reference data for the parent-centre rollup; degrades to a flat grid.
        fetchCentres().catch(() => []),
      ])
      if (matrixMountedRef.current) setMatrix({ rows, centres, error: null, scheduleId })
    } catch (e) {
      if (matrixMountedRef.current) setMatrix({ rows: [], centres: [], error: e?.message || 'could not be loaded', scheduleId })
    }
  }, [isAso, scheduleId])
  // Mount + every successful previsit reload. lastRefreshAt is the hook's
  // own refresh marker — bumped by the Reload button AND by the debounced
  // realtime listener — so the matrix can never disagree with the KPIs,
  // the day strip and the heatmap it shares the dashboard with.
  useEffect(() => { fetchMatrix() }, [fetchMatrix, lastRefreshAt])
  // A stale fetch must never show under a freshly picked schedule.
  const matrixRows = matrix.scheduleId === scheduleId ? matrix.rows : []
  const matrixError = matrix.scheduleId === scheduleId ? matrix.error : null

  // Hold the last good snapshot while a refresh is in flight (same as
  // PrevisitView): no false-zero tiles, no empty-state flash.
  const shownRef = useRef({ summary: [], deployed: [], scheduleId: null })
  if (rowsScheduleId === scheduleId) {
    shownRef.current = { summary, deployed, scheduleId }
  }
  const live = useMemo(
    () => (shownRef.current.scheduleId === scheduleId ? shownRef.current.summary : []),
    // rowsScheduleId/summary are invalidation-only deps: the ref is written
    // during render, so the linter cannot see the relationship.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsScheduleId, scheduleId, summary]
  )
  // The deployed roster is the DENOMINATOR of the centre heatmap, so it gets
  // the same last-good treatment: a mid-refresh gap would redraw every cell
  // as a smaller x/y for no reason.
  const liveDeployed = useMemo(
    () => (shownRef.current.scheduleId === scheduleId ? shownRef.current.deployed : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsScheduleId, scheduleId, deployed]
  )
  const kpis = useMemo(() => previsitKpis(live), [live])
  const byDay = useMemo(() => previsitByDay(live), [live])
  const byDept = useMemo(() => previsitByDept(live), [live])
  const centreMatrix = useMemo(() => previsitCentreMatrix(live, liveDeployed), [live, liveDeployed])
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
            One day is one sewa
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

      {loading && live.length === 0 && (
        <div className="stat-row">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="kpi" />)}
        </div>
      )}

      <div className="stat-row" style={loading && live.length === 0 ? { display: 'none' } : undefined}>
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
        <div className="card" style={{ marginTop: '0.75rem' }} role="status" aria-label="Loading previsit sewa">
          <Skeleton variant="text" lines={2} />
          <div className="empty-text" style={{ marginTop: '0.6rem' }}>Loading previsit sewa…</div>
        </div>
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
                <div key={d.date} className="pd-day">
                  <span className="pd-day-label" title={d.date}>{shortDayLabel(d.date)}</span>
                  <span className="progress" title={`${d.present} present`}>
                    <span
                      className="progress-bar"
                      style={{ width: `${maxPresent > 0 ? Math.round((d.present / maxPresent) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="pd-day-count">
                    {d.present} present{d.openNow > 0 ? ` · ${d.openNow} open` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card previsit-card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">Attendance by centre</div>
            <div className="card-sub">
              Present / deployed for every centre, one column per sewa day
            </div>
            <CentreDayHeatmap
              columns={centreMatrix.columns}
              rows={centreMatrix.rows}
              totals={centreMatrix.totals}
            />
          </div>
        </>
      )}

      {isAso && (
        <CentreDeptMatrixCard
          rows={matrixRows}
          centres={matrix.centres}
          error={matrixError}
          onRetry={fetchMatrix}
          style={{ marginTop: '0.75rem' }}
        />
      )}
    </div>
  )
}
