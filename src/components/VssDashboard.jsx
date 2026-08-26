import { useState, useEffect } from 'react'
import { supabase, fetchCentres, fetchPortalSettings, setPortalSetting } from '../lib/supabase'
import { isVssBadge } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import MasterSwitch from './MasterSwitch'
import { BarChart3, Building2, Users, Download, AlertTriangle, Lock } from 'lucide-react'

/* ─── Super admin / ASO: read-only VSS consent dashboard + master switch ─── */
export default function VssDashboard({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  // phase-2 hardening: aso is view/download-only — the master switches are
  // super_admin actions now (DB: v20; Control Panel also has per-centre overrides).
  const isSuperAdmin = profile?.role === 'super_admin'
  const toast = useToast()
  const selectedScheduleId = scheduleId
  const [data, setData] = useState(null)
  const [settings, setSettings] = useState({ vss_deployment_open: false, vss_creation_open: false })
  const [busy, setBusy] = useState(false)
  const [busyCreation, setBusyCreation] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchPortalSettings().then(setSettings).catch(() => {})
  }, [toast])

  const load = async (scheduleId) => {
    const [centres, vss, consents, deps, depts] = await Promise.all([
      fetchCentres(),
      supabase.from('vss_sewadars').select('*'),
      supabase.from('sewadar_consents').select('*').eq('schedule_id', scheduleId),
      supabase.from('deployments').select('centre, badge_number, department_id, deployed_department_id').eq('schedule_id', scheduleId),
      supabase.from('deployment_departments').select('id, name, include_vss').eq('is_active', true),
    ])
    const consentMap = {}
    ;(consents.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
    const deployMap = {}
    // show the ASO's FINAL department when set (same semantics as the centre
    // pages + the DB quota count) — a finalized override must not look stale
    ;(deps.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d.deployed_department_id || d.department_id })
    const deptNameMap = {}
    ;(depts.data || []).forEach(d => { deptNameMap[d.id] = d.name })
    // centre deployment locks (v13) — non-fatal: the strip stays empty if the
    // migration hasn't been run yet
    let locks = []
    try {
      const { data: lockData } = await supabase.from('centre_locks').select('*').eq('schedule_id', scheduleId)
      locks = lockData || []
    } catch { /* v13 not migrated yet */ }
    return {
      centres: centres || [],
      vss: (vss.data || []).filter(v => isVssBadge(v.badge_number)),
      consentMap,
      deployMap,
      deptNameMap,
      locks,
    }
  }

  useEffect(() => {
    if (!selectedScheduleId) return
    setLoading(true)
    let mounted = true
    ;(async () => {
      try {
        const d = await load(selectedScheduleId)
        if (mounted) setData(d)
      } catch { /* network error — keep previous data, just stop the spinner */ } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [selectedScheduleId])

  // realtime: refresh live while centres edit. Coalesced (400ms) so a burst of
  // changes (e.g. a centre bulk-assign) causes one reload instead of dozens.
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    let reloadTimer = null
    const scheduleReload = () => {
      if (!mounted) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => { if (mounted) load(selectedScheduleId).then(d => setData(d)).catch(() => {}) }, 400)
    }
    const channel = supabase
      .channel(`vss-dash-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .subscribe()
    return () => { mounted = false; if (reloadTimer) clearTimeout(reloadTimer); supabase.removeChannel(channel) }
  }, [selectedScheduleId])

  const toggleVss = async () => {
    if (busy) return
    setBusy(true)
    const next = !settings.vss_deployment_open
    try {
      await setPortalSetting('vss_deployment_open', next, profile?.name || null)
      setSettings(s => ({ ...s, vss_deployment_open: next }))
      toast.success(next ? 'VSS deployment is now OPEN' : 'VSS deployment is now CLOSED')
    } catch (err) {
      toast.error(err.message || 'Could not update setting')
    } finally { setBusy(false) }
  }

  // "Add VSS" master switch — centres cannot create VSS registrations until
  // this is open (deadline gate applies separately; v19)
  const toggleCreation = async () => {
    if (busyCreation) return
    setBusyCreation(true)
    const next = !settings.vss_creation_open
    try {
      await setPortalSetting('vss_creation_open', next, profile?.name || null)
      setSettings(s => ({ ...s, vss_creation_open: next }))
      toast.success(next ? 'Add VSS is now OPEN — centres can create VSS records' : 'Add VSS is now CLOSED')
    } catch (err) {
      toast.error(err.message || 'Could not update setting')
    } finally { setBusyCreation(false) }
  }

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const allCentreNames = (data?.centres || []).map(c => c.name)
  const consentedList = (data?.vss || []).filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.consent_given)

  const total = data?.vss.length || 0
  const active = (data?.vss || []).filter(v => v.is_active).length
  const inactive = total - active
  const consented = consentedList.length
  const pct = total ? Math.round(consented / total * 100) : 0
  const bhatiCount = consentedList.filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.stay_at_bhati).length
  const initiatedCount = consentedList.filter(sw => sw.is_initiated).length
  const requestedCount = consentedList.filter(sw => data?.deployMap[`${sw.centre}|${sw.badge_number}`]).length

  const centreRows = allCentreNames.map(name => {
    const sw = (data?.vss || []).filter(x => x.centre === name)
    const con = sw.filter(x => data?.consentMap[`${x.centre}|${x.badge_number}`]?.consent_given)
    return {
      name,
      parent: data?.centres.find(c => c.name === name)?.parent_centre || null,
      total: sw.length,
      consented: con.length,
    }
  }).filter(r => r.total > 0).sort((a, b) => (a.parent || '') < (b.parent || '') ? -1 : 1)

  const maleCount = (data?.vss || []).filter(v => v.gender === 'MALE').length
  const femaleCount = (data?.vss || []).filter(v => v.gender === 'FEMALE').length

  const deptName = (id) => data?.deptNameMap?.[id] || '—'

  const exportExcel = async () => {
    const XLSX = await import('xlsx') // lazy — keeps xlsx (~400 kB) out of the main bundle
    const rows = (data?.vss || []).map(sw => {
      const key = `${sw.centre}|${sw.badge_number}`
      const c = data?.consentMap[key]
      return {
        'Badge': sw.badge_number,
        'Name': sw.sewadar_name,
        'Centre': sw.centre,
        'Gender': sw.gender || '',
        'Initiated': sw.is_initiated ? 'Yes' : 'No',
        'Active': sw.is_active ? 'Yes' : 'No',
        'Remarks': sw.remarks || '',
        'Consent': c?.consent_given ? 'Yes' : 'No',
        'Days': c?.consent_given ? c.available_days_count : '',
        'Stay at Bhati': c?.stay_at_bhati ? 'Yes' : 'No',
        'Chair Pass': c?.chair_pass ? 'Yes' : 'No',
        'Deployment': deptName(data?.deployMap[key]),
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'VSS Deployment')
    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `VSS_${name}.xlsx`)
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><BarChart3 size={22} /> VSS Deployment Dashboard</h2>
          <div className="page-sub">Collective VSS overview across every centre · visit-time sewadars</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {isSuperAdmin ? (
              <>
                <MasterSwitch
                  label="VSS Deployment"
                  open={settings.vss_deployment_open}
                  onToggle={toggleVss}
                  busy={busy}
                />
                <MasterSwitch
                  label="Add VSS"
                  open={settings.vss_creation_open}
                  onToggle={toggleCreation}
                  busy={busyCreation}
                />
              </>
            ) : (
              <span className="pill" title="View-only access — changes are not permitted for ASO accounts (v20)" style={{ background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
                <Lock size={12} /> View-only
              </span>
            )}
            <button onClick={exportExcel} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> Export Excel
            </button>
          </div>
        </div>
      </div>

      {!settings.vss_deployment_open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
          <Lock size={16} /> VSS deployment is currently <strong>CLOSED</strong> — centres cannot edit any VSS consent or deployment until you open it.
        </div>
      )}

      {(data?.locks || []).length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e', marginBottom: '1rem' }}>
          <span style={{ fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />Locked deployments:</span>
          {data.locks.map(l => (
            <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: '#fff', border: '1px solid #fde68a', borderRadius: 999, padding: '0.2rem 0.7rem' }}>
              <span style={{ fontWeight: 700 }}>{l.centre}</span>
              {l.locked_by && <span style={{ color: '#b45309', fontSize: '0.72rem' }}>{l.locked_by}</span>}
            </span>
          ))}
          <span style={{ fontSize: '0.75rem', color: '#b45309' }}>Unlock from the Consent Dashboard</span>
        </div>
      )}

      {loading || !data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
        </div>
      ) : total === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No VSS sewadars yet</div>
            <div className="empty-text">Import the VSS roster (vss_sewadars_data.sql) and they will appear here.</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="stat">
              <div className="stat-label">VSS sewadars</div>
              <div className="stat-value">{total}</div>
              <div className="stat-sub">across {allCentreNames.length} centres</div>
            </div>
            <div className="stat">
              <div className="stat-label">Active</div>
              <div className="stat-value" style={{ color: '#10b981' }}>{active}</div>
              <div className="stat-sub">{inactive} inactive</div>
            </div>
            <div className="stat">
              <div className="stat-label">Consented (Yes)</div>
              <div className="stat-value" style={{ color: '#6366f1' }}>{consented}</div>
              <div className="stat-sub">of {total}</div>
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
              <div className="stat-label">Deployment</div>
              <div className="stat-value" style={{ color: '#8b5cf6' }}>{requestedCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Stay at Bhati</div>
              <div className="stat-value" style={{ color: '#0ea5e9' }}>{bhatiCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Initiated</div>
              <div className="stat-value" style={{ color: '#f59e0b' }}>{initiatedCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
            <div className="card" style={{ padding: '1.25rem' }}>
              <div className="section-header">
                <div>
                  <div className="section-title"><Building2 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Centre-wise consent</div>
                  <div className="card-sub">Consent status per CENTRE (SC_SPs indented under CENTRE)</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                {centreRows.map(r => (
                  <div key={r.name} className="stack-row">
                    <span style={{ flex: '0 0 8px' }} />
                    <span className="stack-label" style={{ flex: '0 0 34%', fontSize: '0.8rem', fontWeight: 600 }}>
                      {r.parent ? '↳ ' : ''}{r.name}
                    </span>
                    <div className="progress grow" style={{ height: 12 }}>
                      <div className={`progress-bar ${r.total && r.consented === r.total ? 'success' : r.consented ? '' : 'warn'}`} style={{ width: `${r.total ? Math.round(r.consented / r.total * 100) : 0}%` }} />
                    </div>
                    <span style={{ flex: '0 0 56px', textAlign: 'right', fontSize: '0.8rem', fontWeight: 700 }}>
                      {r.consented}/{r.total}
                    </span>
                    <span style={{ flex: '0 0 40px', textAlign: 'right', fontSize: '0.7rem', color: '#94a3b8' }}>
                      {r.total ? Math.round(r.consented / r.total * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
              <div>
                <div className="section-title"><Users size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Gender &amp; inactive summary</div>
                <div className="card-sub">Roster composition — inactive VSS sewadars cannot be deployed</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', padding: '0 1.25rem 1.25rem' }}>
              {[
                { label: 'Male', value: maleCount, color: '#6366f1' },
                { label: 'Female', value: femaleCount, color: '#ec4899' },
                { label: 'Inactive (blocked)', value: inactive, color: '#ef4444' },
              ].map(s => (
                <div key={s.label} style={{ border: '1px solid #eef2f7', borderRadius: 8, padding: '0.75rem 1rem' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>{s.label}</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
            {inactive > 0 && (
              <div style={{ padding: '0 1.25rem 1.25rem', fontSize: '0.82rem', color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <AlertTriangle size={14} /> {inactive} VSS sewadar{inactive > 1 ? 's are' : ' is'} inactive — their deployments are blocked at the database level and their rows are flagged in the VSS deploy table.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
