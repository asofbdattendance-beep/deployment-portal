import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, fetchCentres, fetchAllRows, fetchPortalSettings, setPortalSetting } from '../lib/supabase'
import { getSubtreeCentres, getRootCentre } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import MasterSwitch from './MasterSwitch'
import { BarChart3, Users, AlertTriangle, Building2, LayoutGrid, Lock, History } from 'lucide-react'
import PageHeader, { ViewOnlyPill } from './PageHeader'
import KpiTile from './KpiTile'
import EmptyState from './EmptyState'
import ExportButton from './ExportButton'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'

/* ─── Super admin / ASO: comprehensive consent dashboard ───
   Two matrices:
   1) Parent-centre consent matrix — badges / consented / initiated /
      non-initiated / staying + Scheduled (total allocated seats)
   2) Parent-centre department matrix — allocated seats per parent
      centre (incl. child centres) by department; Scheduled = total
      allocated for the centre. Both derived from centre_allocations. */
export default function ConsentDashboard({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  // phase-2 hardening: aso is view/download-only — switch toggles and
  // centre-lock unlocks are super_admin actions now (DB: v20).
  const isSuperAdmin = profile?.role === 'super_admin'
  const toast = useToast()
  const selectedScheduleId = scheduleId
  const [centres, setCentres] = useState([])
  const [depts, setDepts] = useState([])
  const [consentMatrix, setConsentMatrix] = useState([])
  const [allocations, setAllocations] = useState([])
  const [settings, setSettings] = useState({ sewadar_deployment_open: true })
  const [locks, setLocks] = useState([])
  const [activity, setActivity] = useState([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchPortalSettings().then(setSettings).catch(() => {})
    Promise.all([
      fetchCentres(),
      fetchAllRows('deployment_departments', 'id, name', (q) => q.eq('is_active', true), 'id'),
    ]).then(([c, d]) => {
      setCentres(c)
      setDepts(d || [])
    }).catch(() => {})
  }, [toast])

  const loadMatrices = useCallback(async (scheduleId) => {
    if (!scheduleId) return
    const [consentRes, allocAll] = await Promise.all([
      supabase.rpc('get_parent_consent_matrix', { p_schedule: scheduleId }),
      fetchAllRows('centre_allocations', 'department_id, centre, max_count', (q) => q.eq('schedule_id', scheduleId), ['department_id', 'centre']),
    ])
    setConsentMatrix(consentRes.data || [])
    setAllocations(allocAll || [])
    // centre deployment locks (v13) — non-fatal: strip just stays empty if the
    // migration hasn't been run yet (paginated, though locks are < 50 rows)
    try {
      const lockAll = await fetchAllRows('centre_locks', '*', (q) => q.eq('schedule_id', scheduleId), 'id')
      setLocks(lockAll || [])
    } catch { setLocks([]) }
    // recent major actions (v17 sewadar_audit_log) — non-fatal: card stays
    // hidden until the migration is run and events start flowing
    try {
      const { data: actData } = await supabase
        .from('sewadar_audit_log').select('*').eq('schedule_id', scheduleId)
        .order('created_at', { ascending: false }).limit(25)
      setActivity(actData || [])
    } catch { setActivity([]) }
  }, [])

  useEffect(() => {
    if (!selectedScheduleId) return
    setLoading(true)
    let mounted = true
    loadMatrices(selectedScheduleId).then(() => { if (mounted) setLoading(false) }).catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [selectedScheduleId, loadMatrices])

  // realtime: refresh live while centres edit. Burst-coalesced (400ms) so a
  // bulk-assign causes one reload instead of dozens; the settings refetch
  // rides along so one extra cheap RPC per burst replaces the split path.
  useRealtimeRefresh({
    scheduleId: selectedScheduleId,
    channelName: `consent-dash-${selectedScheduleId}`,
    subscriptions: [
      { table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` },
      { table: 'centre_allocations', filter: `schedule_id=eq.${selectedScheduleId}` },
      { table: 'centre_locks', filter: `schedule_id=eq.${selectedScheduleId}` },
      { table: 'sewadar_audit_log', filter: `schedule_id=eq.${selectedScheduleId}` },
      { table: 'portal_settings' },
    ],
    onReload: () => {
      loadMatrices(selectedScheduleId).catch(() => {})
      fetchPortalSettings().then(setSettings).catch(() => {})
    },
    label: 'consent-dashboard',
  })

  const unlockCentre = async (id) => {
    const row = locks.find(l => l.id === id)
    if (!window.confirm(`Reopen ${row?.centre || 'this centre'}'s deployment? The centre will be able to edit consent, deployment and incharges again.`)) return
    const { error } = await supabase.from('centre_locks').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setLocks(prev => prev.filter(l => l.id !== id))
    toast.success('Deployment reopened — the centre can edit again')
  }

  const toggleSewadars = async () => {
    if (busy) return
    setBusy(true)
    const next = !settings.sewadar_deployment_open
    try {
      await setPortalSetting('sewadar_deployment_open', next, profile?.name || null)
      setSettings(s => ({ ...s, sewadar_deployment_open: next }))
      toast.success(next ? 'Sewadar deployment is now OPEN' : 'Sewadar deployment is now CLOSED')
    } catch (err) {
      toast.error(err.message || 'Could not update setting')
    } finally { setBusy(false) }
  }

  const schedule = schedules.find(s => s.id === selectedScheduleId)

  // build parent rows (names from centres, counts from the consent RPC).
  // Memoized so the export builder below keeps a stable identity.
  const parents = centres.filter(c => !c.parent_centre)
  const parentRows = useMemo(() => {
    const rows = parents.map(p => {
      const cm = consentMatrix.find(r => r.parent_centre === p.name) || {}
      return {
        name: p.name,
        childCount: getSubtreeCentres(centres, p.name).length - 1,
        total: Number(cm.total_badges || 0),
        consented: Number(cm.consented || 0),
        initiated: Number(cm.initiated || 0),
        nonInitiated: Number(cm.non_initiated || 0),
        staying: Number(cm.staying || 0),
        allocCounts: {},
      }
    }).sort((a, b) => a.name.localeCompare(b.name))

    // roll allocations up to the parent centre (allocations are stored per parent;
    // clubbing child-centre allocations if any)
    const allocByParent = {}
    ;(allocations || []).forEach(a => {
      const root = getRootCentre(centres, a.centre) || a.centre
      if (!allocByParent[root]) allocByParent[root] = {}
      allocByParent[root][a.department_id] = (allocByParent[root][a.department_id] || 0) + (a.max_count || 0)
    })
    rows.forEach(r => {
      r.allocCounts = allocByParent[r.name] || {}
      r.allocTotal = Object.values(r.allocCounts).reduce((a, b) => a + b, 0)
    })
    return rows
  }, [centres, consentMatrix, allocations, parents])

  const totals = useMemo(() => {
    const t = {
      total: parentRows.reduce((s, r) => s + r.total, 0),
      consented: parentRows.reduce((s, r) => s + r.consented, 0),
      initiated: parentRows.reduce((s, r) => s + r.initiated, 0),
      nonInitiated: parentRows.reduce((s, r) => s + r.nonInitiated, 0),
      staying: parentRows.reduce((s, r) => s + r.staying, 0),
      allocTotal: parentRows.reduce((s, r) => s + r.allocTotal, 0),
    }
    t.allocCounts = {}
    depts.forEach(d => {
      t.allocCounts[d.id] = parentRows.reduce((s, r) => s + ((r.allocCounts || {})[d.id] || 0), 0)
    })
    return t
  }, [parentRows, depts])

  const pct = totals.total ? Math.round(totals.consented / totals.total * 100) : 0

  // Excel sheets (shared ExportButton owns the lazy-xlsx driver + mobile path).
  const buildSheets = useCallback(() => {
    const consentRows = parentRows.map(r => ({
      'CENTRE': r.childCount > 0 ? `${r.name} (+${r.childCount})` : r.name,
      'Total Badges': r.total,
      'Consented Yes': r.consented,
      'Initiated (consented)': r.initiated,
      'Non-Initiated (consented)': r.nonInitiated,
      'Staying (consented)': r.staying,
      'Scheduled (allocated)': r.allocTotal,
    }))
    consentRows.push({
      'CENTRE': 'TOTAL',
      'Total Badges': totals.total,
      'Consented Yes': totals.consented,
      'Initiated (consented)': totals.initiated,
      'Non-Initiated (consented)': totals.nonInitiated,
      'Staying (consented)': totals.staying,
      'Scheduled (allocated)': totals.allocTotal,
    })

    const deptRows = parentRows.map(r => {
      const row = { 'CENTRE': r.childCount > 0 ? `${r.name} (+${r.childCount})` : r.name, 'Scheduled (allocated)': r.allocTotal }
      depts.forEach(d => { row[d.name] = (r.allocCounts || {})[d.id] || 0 })
      return row
    })
    deptRows.push({
      'CENTRE': 'TOTAL',
      'Scheduled (allocated)': totals.allocTotal,
      ...Object.fromEntries(depts.map(d => [d.name, totals.allocCounts[d.id] || 0])),
    })
    return [
      { name: 'Consent Matrix', rows: consentRows },
      { name: 'Department Matrix', rows: deptRows },
    ]
  }, [parentRows, totals, depts])

  const exportFilename = `${(schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')}.xlsx`

  const cell = (key, v) => (
    <td key={key} style={{ textAlign: 'center', fontWeight: v > 0 ? 800 : 400, color: v > 0 ? '#047857' : '#94a3b8' }}>{v}</td>
  )

  // department cell shows the ALLOCATED quota for that centre × department
  const allocCell = (key, alloc) => (
    <td key={key} style={{ textAlign: 'center', fontWeight: alloc > 0 ? 800 : 400, color: alloc > 0 ? '#4f46e5' : '#cbd5e1' }}>
      {alloc > 0 ? alloc : '—'}
    </td>
  )

  const parentCell = (r) => (
    <td style={{ fontWeight: 700, position: 'sticky', left: 0, background: '#fff', whiteSpace: 'nowrap' }}>
      {r.name}
      {r.childCount > 0 && <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 600, marginLeft: '0.35rem' }}>(+{r.childCount})</span>}
    </td>
  )

  // ── recent-activity formatting (v17 sewadar_audit_log) ──
  const actionMeta = (a) => {
    switch (a.action) {
      case 'finalize': return { label: 'Finalized', cls: 'pill-indigo' }
      case 'change_final': return { label: 'Changed final dept', cls: 'pill-amber' }
      case 'unfinalize': return { label: 'Un-finalized', cls: 'pill-gray' }
      case 'deploy_add': return { label: 'Assigned', cls: 'pill-green' }
      case 'deploy_remove': return { label: 'Removed deployment', cls: 'pill-red' }
      case 'deploy_edit': return { label: 'Edited deployment', cls: 'pill-blue' }
      case 'consent_add': return { label: 'Consent added', cls: 'pill-green' }
      case 'consent_edit': return { label: 'Consent changed', cls: 'pill-blue' }
      case 'consent_remove': return { label: 'Consent removed', cls: 'pill-red' }
      case 'lock': return { label: 'Locked deployment', cls: 'pill-amber' }
      case 'unlock': return { label: 'Unlocked deployment', cls: 'pill-green' }
      default: return { label: a.action, cls: 'pill-gray' }
    }
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <PageHeader
        icon={<BarChart3 size={22} />}
        title="Consent Dashboard"
        sub="CENTRE consent & allocated-seat matrices"
        pills={isSuperAdmin ? (
          <MasterSwitch
            label="Sewadar Deployment"
            open={settings.sewadar_deployment_open}
            onToggle={toggleSewadars}
            busy={busy}
          />
        ) : (
          <ViewOnlyPill title="View-only access — changes are not permitted for ASO accounts (v20)" />
        )}
        actions={(
          <ExportButton
            filename={exportFilename}
            buildSheets={buildSheets}
            onExportError={(err) => toast.error(err?.message || 'Export failed')}
          />
        )}
      />

      {locks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e', marginBottom: '1rem' }}>
          <span style={{ fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />Locked deployments:</span>
          {locks.map(l => (
            <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: '#fff', border: '1px solid #fde68a', borderRadius: 999, padding: '0.2rem 0.5rem 0.2rem 0.7rem' }}>
              <span style={{ fontWeight: 700 }}>{l.centre}</span>
              {l.locked_by && <span style={{ color: '#b45309', fontSize: '0.72rem' }}>{l.locked_by}</span>}
              {isSuperAdmin && (
                <button onClick={() => unlockCentre(l.id)} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem', color: '#b91c1c' }}>Unlock</button>
              )}
            </span>
          ))}
        </div>
      )}

      {settings.sewadar_deployment_open === false && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
          <AlertTriangle size={16} /> Sewadar deployment is currently <strong>CLOSED</strong> — centres cannot edit any consent or deployment until you open it.
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
        </div>
      ) : totals.total === 0 ? (
        <div className="card">
          <EmptyState
            title="No sewadars yet"
            hint="Sewadars across centres will appear here once they are added."
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* ── collective stats ── */}
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <KpiTile label="Sewadars" value={totals.total} sub={`across ${centres.length} centres`} />
            <KpiTile label="Consented (Yes)" value={totals.consented} sub={`of ${totals.total}`} tone="#10b981" />
            <KpiTile
              label="Consent rate"
              value={(
                <div className="progress" style={{ height: 10 }}>
                  <div className="progress-bar" style={{ width: `${pct}%` }} />
                </div>
              )}
              sub={`${pct}% consented`}
            />
            <KpiTile label="Initiated" value={totals.initiated} sub={`of ${totals.consented} consented`} tone="#0ea5e9" />
            <KpiTile label="Stay at Bhati" value={totals.staying} sub={`of ${totals.consented} consented`} tone="#6366f1" />
            <KpiTile label="Allocated" value={totals.allocTotal} sub="seats across departments" tone="#8b5cf6" />
          </div>

          {/* ── 1. Parent-centre consent matrix ── */}
          <div className="card">
            <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
              <div>
                <div className="section-title"><Building2 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> CENTRE consent matrix</div>
              </div>
            </div>
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0, padding: '0 1.25rem 1.25rem' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44, textAlign: 'center' }}>S.No.</th>
                    <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 2 }}>CENTRE</th>
                    <th style={{ textAlign: 'center' }}>Total Badges</th>
                    <th style={{ textAlign: 'center' }}>Consented Yes</th>
                    <th style={{ textAlign: 'center' }}>Initiated</th>
                    <th style={{ textAlign: 'center' }}>Non-Initiated</th>
                    <th style={{ textAlign: 'center' }}>Staying</th>
                    <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {parentRows.map((r, i) => (
                    <tr key={r.name}>
                      <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                      {parentCell(r)}
                      <td data-label="Total" style={{ textAlign: 'center', fontWeight: 600 }}>{r.total}</td>
                      <td data-label="Consented" style={{ textAlign: 'center', fontWeight: 700 }}>{r.consented}</td>
                      {cell('initiated', r.initiated)}
                      {cell('nonInitiated', r.nonInitiated)}
                      {cell('staying', r.staying)}
                      <td data-label="Scheduled" style={{ textAlign: 'center', fontWeight: 800, color: '#4f46e5', background: '#eef2ff' }}>{r.allocTotal}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                    <td style={{ background: '#f8fafc' }} />
                    <td style={{ fontWeight: 800, position: 'sticky', left: 0, background: '#f8fafc' }}>TOTAL</td>
                    <td style={{ textAlign: 'center', fontWeight: 800 }}>{totals.total}</td>
                    <td style={{ textAlign: 'center', fontWeight: 800 }}>{totals.consented}</td>
                    {cell('initiated', totals.initiated)}
                    {cell('nonInitiated', totals.nonInitiated)}
                    {cell('staying', totals.staying)}
                    <td style={{ textAlign: 'center', fontWeight: 800, color: '#4f46e5', background: '#eef2ff' }}>{totals.allocTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 2. Parent-centre department matrix ── */}
          <div className="card">
            <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
              <div>
                <div className="section-title"><LayoutGrid size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> CENTRE department matrix</div>
              </div>
            </div>
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0, padding: '0 1.25rem 1.25rem' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44, textAlign: 'center' }}>S.No.</th>
                    <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 2 }}>CENTRE</th>
                    {depts.map(d => <th key={d.id} style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.72rem' }}>{d.name}</th>)}
                    <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {parentRows.map((r, i) => (
                    <tr key={r.name}>
                      <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                      {parentCell(r)}
                      {depts.map(d => allocCell(d.id, (r.allocCounts || {})[d.id] || 0))}
                      <td data-label="Scheduled" style={{ textAlign: 'center', fontWeight: 800, color: '#4f46e5', background: '#eef2ff' }}>{r.allocTotal}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                    <td style={{ background: '#f8fafc' }} />
                    <td style={{ fontWeight: 800, position: 'sticky', left: 0, background: '#f8fafc' }}>TOTAL</td>
                    {depts.map(d => allocCell(d.id, totals.allocCounts[d.id] || 0))}
                    <td style={{ textAlign: 'center', fontWeight: 800, color: '#4f46e5', background: '#eef2ff' }}>{totals.allocTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ padding: '0.85rem 1.25rem', fontSize: '0.82rem', color: '#64748b', borderTop: '1px solid #f1f5f9' }}>
              <strong>{totals.consented}</strong> of <strong>{totals.total}</strong> sewadars consented across {centres.length} centres ({parents.length} CENTREs)
            </div>
          </div>

          {/* ── 3. Recent major actions (audit log) ── */}
          {activity.length > 0 && (
            <div className="card">
              <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
                <div>
                  <div className="section-title"><History size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Recent activity</div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b', fontWeight: 500, marginTop: '0.2rem' }}>Major changes only — finalization, admin fixes, lock / unlock</div>
                </div>
              </div>
              <div className="table-wrap" style={{ border: 'none', borderRadius: 0, padding: '0 1.25rem 1.25rem' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>When</th>
                      <th>Who</th>
                      <th style={{ width: 150 }}>Action</th>
                      <th>Sewadar</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map(a => {
                      const meta = actionMeta(a)
                      const changeText = a.action.startsWith('consent')
                        ? `${a.old_consent === null ? '—' : (a.old_consent ? 'Yes' : 'No')} → ${a.new_consent === null ? '—' : (a.new_consent ? 'Yes' : 'No')} consent`
                        : (a.old_dept_name || a.new_dept_name)
                          ? [a.old_dept_name, a.new_dept_name].filter(Boolean).join(' → ') || '—'
                          : (a.action === 'lock' || a.action === 'unlock') && a.centre
                            ? a.centre
                            : '—'
                      return (
                        <tr key={a.id}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.75rem', color: '#64748b', fontFamily: 'monospace' }}>
                            {new Date(a.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>
                            {a.acted_by ? <strong>{a.acted_by}</strong> : <span style={{ color: '#94a3b8' }}>—</span>}
                            {a.acted_by_role && <span className="pill pill-gray" style={{ fontSize: '0.6rem', marginLeft: '0.35rem' }}>{a.acted_by_role.replace('_', ' ')}</span>}
                          </td>
                          <td><span className={`pill ${meta.cls}`} style={{ fontSize: '0.68rem', whiteSpace: 'nowrap' }}>{meta.label}</span></td>
                          <td style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                            {a.sewadar_name
                              ? <><span style={{ fontFamily: 'monospace', fontSize: '0.76rem', color: '#64748b' }}>{a.badge_number}</span> · {a.sewadar_name}</>
                              : <span style={{ fontFamily: 'monospace', fontSize: '0.76rem', color: '#64748b' }}>{a.badge_number || a.centre}</span>}
                          </td>
                          <td style={{ fontSize: '0.8rem', color: '#475569' }}>{changeText}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
