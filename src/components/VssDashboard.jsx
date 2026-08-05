import { useState, useEffect, useCallback } from 'react'
import { supabase, fetchCentres, fetchPortalSettings, setPortalSetting } from '../lib/supabase'
import { isVssBadge } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import MasterSwitch from './MasterSwitch'
import DeadlinePill from './DeadlinePill'
import { BarChart3, Building2, CalendarDays, Users, Download, AlertTriangle, Lock } from 'lucide-react'
import * as XLSX from 'xlsx'

/* ─── Super admin / ASO: read-only VSS consent dashboard + master switch ─── */
export default function VssDashboard() {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [data, setData] = useState(null)
  const [settings, setSettings] = useState({ vss_deployment_open: false })
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false }).then(({ data }) => {
      if (data) {
        setSchedules(data)
        setSelectedScheduleId(prev => (prev && data.some(s => s.id === prev)) ? prev : (data[0]?.id || ''))
      }
    }).catch(() => {})
    fetchPortalSettings().then(setSettings).catch(() => {})
  }, [])

  const load = async (scheduleId) => {
    const [centres, vss, consents, deps, depts] = await Promise.all([
      fetchCentres(),
      supabase.from('vss_sewadars').select('*'),
      supabase.from('sewadar_consents').select('*').eq('schedule_id', scheduleId),
      supabase.from('deployments').select('centre, badge_number, department_id').eq('schedule_id', scheduleId),
      supabase.from('deployment_departments').select('id, name, include_vss').eq('is_active', true),
    ])
    const consentMap = {}
    ;(consents.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
    const deployMap = {}
    ;(deps.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d.department_id })
    const deptNameMap = {}
    ;(depts.data || []).forEach(d => { deptNameMap[d.id] = d.name })
    return {
      centres: centres || [],
      vss: (vss.data || []).filter(v => isVssBadge(v.badge_number)),
      consentMap,
      deployMap,
      deptNameMap,
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
      } finally { if (mounted) setLoading(false) }
    })()
    return () => { mounted = false }
  }, [selectedScheduleId])

  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    const channel = supabase
      .channel(`vss-dash-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        load(selectedScheduleId).then(d => setData(d)).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        load(selectedScheduleId).then(d => setData(d)).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .subscribe()
    return () => { mounted = false; supabase.removeChannel(channel) }
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

  const dayDist = [1, 2, 3, 4, 5].map(n => ({
    days: n,
    count: consentedList.filter(sw => (data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.available_days_count ?? 0) === n).length,
  }))

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

  const maxDay = Math.max(...dayDist.map(d => d.count), 1)
  const maleCount = (data?.vss || []).filter(v => v.gender === 'MALE').length
  const femaleCount = (data?.vss || []).filter(v => v.gender === 'FEMALE').length

  const deptName = (id) => data?.deptNameMap?.[id] || '—'

  const exportExcel = () => {
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
        'Requested Dept': deptName(data?.deployMap[key]),
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
      <div className="page-header">
        <div>
          <h2 className="page-title"><BarChart3 size={22} /> VSS Deployment Dashboard</h2>
          <div className="page-sub">Collective VSS overview across every centre · visit-time sewadars</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <MasterSwitch
            label="VSS Deployment"
            open={settings.vss_deployment_open}
            onToggle={toggleVss}
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
          {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
        </div>
      </div>

      {!settings.vss_deployment_open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
          <Lock size={16} /> VSS deployment is currently <strong>CLOSED</strong> — centres cannot edit any VSS consent or deployment until you open it.
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
              <div className="stat-label">Requested dept</div>
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
                  <div className="section-title"><CalendarDays size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Day-wise consent</div>
                  <div className="card-sub">How many days each consented VSS sewadar is available</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                {dayDist.map(({ days, count }) => (
                  <div key={days} className="stack-row">
                    <span className="stack-label" style={{ flex: '0 0 68px', fontSize: '0.78rem', color: '#64748b', fontWeight: 600 }}>{days} day{days > 1 ? 's' : ''}</span>
                    <div className="progress grow" style={{ height: 12 }}>
                      <div className="progress-bar" style={{ width: `${Math.round(count / maxDay * 100)}%` }} />
                    </div>
                    <span style={{ flex: '0 0 30px', textAlign: 'right', fontSize: '0.82rem', fontWeight: 800 }}>{count}</span>
                    <span style={{ flex: '0 0 40px', fontSize: '0.7rem', color: '#94a3b8', textAlign: 'right' }}>{consented ? Math.round(count / consented * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" style={{ padding: '1.25rem' }}>
              <div className="section-header">
                <div>
                  <div className="section-title"><Building2 size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Centre-wise consent</div>
                  <div className="card-sub">Consent status per centre (children indented under parent)</div>
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
