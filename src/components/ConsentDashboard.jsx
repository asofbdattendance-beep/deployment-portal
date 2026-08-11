import { useState, useEffect, useCallback } from 'react'
import { supabase, fetchCentres, fetchPortalSettings, setPortalSetting } from '../lib/supabase'
import { getSubtreeCentres, getRootCentre } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import MasterSwitch from './MasterSwitch'
import { BarChart3, Users, Download, AlertTriangle, Building2, LayoutGrid, Lock } from 'lucide-react'
import DeadlinePill from './DeadlinePill'

/* ─── Super admin / ASO: comprehensive consent dashboard ───
   Two matrices:
   1) Parent-centre consent matrix — badges / consented / initiated /
      non-initiated / staying + Scheduled (total allocated seats)
   2) Parent-centre department matrix — allocated seats per parent
      centre (incl. child centres) by department; Scheduled = total
      allocated for the centre. Both derived from centre_allocations. */
export default function ConsentDashboard() {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [centres, setCentres] = useState([])
  const [depts, setDepts] = useState([])
  const [consentMatrix, setConsentMatrix] = useState([])
  const [allocations, setAllocations] = useState([])
  const [settings, setSettings] = useState({ sewadar_deployment_open: true })
  const [locks, setLocks] = useState([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false }).then(({ data, error }) => {
      if (error) { toast.error(error.message); return }
      setSchedules(data || [])
      setSelectedScheduleId(prev => (prev && (data || []).some(s => s.id === prev)) ? prev : (data?.[0]?.id || ''))
    }).catch(() => {})
    fetchPortalSettings().then(setSettings).catch(() => {})
    Promise.all([
      fetchCentres(),
      supabase.from('deployment_departments').select('id, name').eq('is_active', true),
    ]).then(([c, d]) => {
      setCentres(c)
      setDepts(d.data || [])
    }).catch(() => {})
  }, [toast])

  const loadMatrices = useCallback(async (scheduleId) => {
    if (!scheduleId) return
    const [consentRes, allocRes] = await Promise.all([
      supabase.rpc('get_parent_consent_matrix', { p_schedule: scheduleId }),
      supabase.from('centre_allocations').select('department_id, centre, max_count').eq('schedule_id', scheduleId),
    ])
    setConsentMatrix(consentRes.data || [])
    setAllocations(allocRes.data || [])
    // centre deployment locks (v13) — non-fatal: strip just stays empty if the
    // migration hasn't been run yet
    try {
      const { data: lockData } = await supabase.from('centre_locks').select('*').eq('schedule_id', scheduleId)
      setLocks(lockData || [])
    } catch { setLocks([]) }
  }, [])

  useEffect(() => {
    if (!selectedScheduleId) return
    setLoading(true)
    let mounted = true
    loadMatrices(selectedScheduleId).then(() => { if (mounted) setLoading(false) }).catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [selectedScheduleId, loadMatrices])

  // realtime: refresh live while centres edit
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    const channel = supabase
      .channel(`consent-dash-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        loadMatrices(selectedScheduleId).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_allocations', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        loadMatrices(selectedScheduleId).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_locks', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        loadMatrices(selectedScheduleId).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .subscribe()
    return () => { mounted = false; supabase.removeChannel(channel) }
  }, [selectedScheduleId, loadMatrices])

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

  // build parent rows (names from centres, counts from the consent RPC)
  const parents = centres.filter(c => !c.parent_centre)
  const parentRows = parents.map(p => {
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
  parentRows.forEach(r => {
    r.allocCounts = allocByParent[r.name] || {}
    r.allocTotal = Object.values(r.allocCounts).reduce((a, b) => a + b, 0)
  })

  const totals = {
    total: parentRows.reduce((s, r) => s + r.total, 0),
    consented: parentRows.reduce((s, r) => s + r.consented, 0),
    initiated: parentRows.reduce((s, r) => s + r.initiated, 0),
    nonInitiated: parentRows.reduce((s, r) => s + r.nonInitiated, 0),
    staying: parentRows.reduce((s, r) => s + r.staying, 0),
    allocTotal: parentRows.reduce((s, r) => s + r.allocTotal, 0),
  }
  totals.allocCounts = {}
  depts.forEach(d => {
    totals.allocCounts[d.id] = parentRows.reduce((s, r) => s + ((r.allocCounts || {})[d.id] || 0), 0)
  })

  const pct = totals.total ? Math.round(totals.consented / totals.total * 100) : 0

  const exportExcel = async () => {
    const XLSX = await import('xlsx') // lazy — keeps xlsx (~400 kB) out of the main bundle
    const wb = XLSX.utils.book_new()

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
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(consentRows), 'Consent Matrix')

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
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deptRows), 'Department Matrix')

    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}.xlsx`)
  }

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

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><BarChart3 size={22} /> Consent Dashboard</h2>
          <div className="page-sub">CENTRE consent &amp; allocated-seat matrices</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <MasterSwitch
              label="Sewadar Deployment"
              open={settings.sewadar_deployment_open}
              onToggle={toggleSewadars}
              busy={busy}
            />
            <select value={selectedScheduleId} onChange={e => setSelectedScheduleId(e.target.value)} className="select">
              {schedules.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.status.replace('_', ' ')})</option>
              ))}
            </select>
            <button onClick={exportExcel} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> Export Excel
            </button>
          </div>
        </div>
        {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
      </div>

      {locks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e', marginBottom: '1rem' }}>
          <span style={{ fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />Locked deployments:</span>
          {locks.map(l => (
            <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: '#fff', border: '1px solid #fde68a', borderRadius: 999, padding: '0.2rem 0.5rem 0.2rem 0.7rem' }}>
              <span style={{ fontWeight: 700 }}>{l.centre}</span>
              {l.locked_by && <span style={{ color: '#b45309', fontSize: '0.72rem' }}>{l.locked_by}</span>}
              <button onClick={() => unlockCentre(l.id)} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem', color: '#b91c1c' }}>Unlock</button>
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
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No sewadars yet</div>
            <div className="empty-text">Sewadars across centres will appear here once they are added.</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* ── collective stats ── */}
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="stat">
              <div className="stat-label">Sewadars</div>
              <div className="stat-value">{totals.total}</div>
              <div className="stat-sub">across {centres.length} centres</div>
            </div>
            <div className="stat">
              <div className="stat-label">Consented (Yes)</div>
              <div className="stat-value" style={{ color: '#10b981' }}>{totals.consented}</div>
              <div className="stat-sub">of {totals.total}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Consent rate</div>
              <div className="stat-value" style={{ fontSize: '1.1rem', paddingTop: '0.35rem' }}>
                <div className="progress" style={{ height: 10 }}>
                  <div className="progress-bar" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="stat-sub">{pct}% consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Initiated</div>
              <div className="stat-value" style={{ color: '#0ea5e9' }}>{totals.initiated}</div>
              <div className="stat-sub">of {totals.consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Stay at Bhati</div>
              <div className="stat-value" style={{ color: '#6366f1' }}>{totals.staying}</div>
              <div className="stat-sub">of {totals.consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Allocated</div>
              <div className="stat-value" style={{ color: '#8b5cf6' }}>{totals.allocTotal}</div>
              <div className="stat-sub">seats across departments</div>
            </div>
          </div>

          {/* ── 1. Parent-centre consent matrix ── */}
          <div className="card">
            <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
              <div>
                <div className="section-title"><Building2 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> CENTRE consent matrix</div>
                <div className="card-sub">Per CENTRE (incl. SC_SPs): total badges, consented, initiated / non-initiated and staying among consented — <strong>Scheduled</strong> = total allocated seats for the centre</div>
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
                <div className="card-sub">Allocated seats per CENTRE (incl. SC_SPs) by department — <strong>Scheduled</strong> = total allocated for the centre</div>
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
        </div>
      )}
    </div>
  )
}
