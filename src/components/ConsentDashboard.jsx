import { useState, useEffect } from 'react'
import { supabase, fetchCentres, notElderlyFilter } from '../lib/supabase'
import { attendanceDisplay, isLowAttendance } from '../lib/logic'
import { BarChart3, Building2, CalendarDays, Users, Download, AlertTriangle } from 'lucide-react'
import * as XLSX from 'xlsx'
import DeadlinePill from './DeadlinePill'

/* ─── Super admin / ASO: read-only consent dashboard across all centres ─── */
export default function ConsentDashboard() {
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false }).then(({ data }) => {
      if (data) {
        setSchedules(data)
        setSelectedScheduleId(prev => (prev && data.some(s => s.id === prev)) ? prev : (data[0]?.id || ''))
      }
    }).catch(() => {})
  }, [])

  const load = async (scheduleId) => {
    const [centres, sewadars, consents, deps, prev, depts] = await Promise.all([
      fetchCentres(),
      supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated').or(notElderlyFilter()),
      supabase.from('sewadar_consents').select('*').eq('schedule_id', scheduleId),
      supabase.from('deployments').select('centre, badge_number, department_id').eq('schedule_id', scheduleId),
      supabase.from('prev_year_deployments').select('badge_number, prev_department, attendance_reported'),
      supabase.from('deployment_departments').select('id, name').eq('is_active', true),
    ])
    const consentMap = {}
    ;(consents.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
    const deployMap = {}
    ;(deps.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d.department_id })
    const prevMap = {}
    ;(prev.data || []).forEach(p => { prevMap[p.badge_number] = p })
    const deptNameMap = {}
    ;(depts.data || []).forEach(d => { deptNameMap[d.id] = d.name })
    return {
      centres: centres || [],
      sewadars: sewadars.data || [],
      consentMap,
      deployMap,
      prevMap,
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

  // realtime: refresh live while centres edit
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    const channel = supabase
      .channel(`consent-dash-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        load(selectedScheduleId).then(d => setData(d)).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted) return
        load(selectedScheduleId).then(d => setData(d)).catch(() => {})
      })
      .subscribe()
    return () => { mounted = false; supabase.removeChannel(channel) }
  }, [selectedScheduleId])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const allCentreNames = (data?.centres || []).map(c => c.name)
  const consentedList = (data?.sewadars || []).filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.consent_given)

  const total = data?.sewadars.length || 0
  const consented = consentedList.length
  const pct = total ? Math.round(consented / total * 100) : 0
  const bhatiCount = consentedList.filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.stay_at_bhati).length
  const initiatedCount = consentedList.filter(sw => sw.is_initiated).length
  const requestedCount = consentedList.filter(sw => data?.deployMap[`${sw.centre}|${sw.badge_number}`]).length

  // day-wise distribution (1-5)
  const dayDist = [1, 2, 3, 4, 5].map(n => ({
    days: n,
    count: consentedList.filter(sw => (data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.available_days_count ?? 0) === n).length,
  }))

  // centre-wise breakdown (grouped by parent)
  const centreRows = allCentreNames.map(name => {
    const sw = (data?.sewadars || []).filter(x => x.centre === name)
    const con = sw.filter(x => data?.consentMap[`${x.centre}|${x.badge_number}`]?.consent_given)
    return {
      name,
      parent: data?.centres.find(c => c.name === name)?.parent_centre || null,
      total: sw.length,
      consented: con.length,
    }
  }).filter(r => r.total > 0).sort((a, b) => (a.parent || '') < (b.parent || '') ? -1 : 1)

  const parents = [...new Set(centreRows.filter(r => r.parent).map(r => r.parent))]
  const parentOrder = [...allCentreNames.filter(n => !data?.centres.find(c => c.name === n)?.parent_centre), ...parents].filter((v, i, a) => a.indexOf(v) === i)

  const maxDay = Math.max(...dayDist.map(d => d.count), 1)

  const deptName = (id) => data?.deptNameMap?.[id] || '—'

  const exportExcel = () => {
    const rows = (data?.sewadars || []).map(sw => {
      const key = `${sw.centre}|${sw.badge_number}`
      const c = data?.consentMap[key]
      const prev = data?.prevMap[sw.badge_number]
      return {
        'Badge': sw.badge_number,
        'Name': sw.sewadar_name,
        'Centre': sw.centre,
        'Dept': sw.department || '',
        'Initiated': sw.is_initiated ? 'Yes' : 'No',
        'Consent': c?.consent_given ? 'Yes' : 'No',
        'Days': c?.consent_given ? c.available_days_count : '',
        'Stay at Bhati': c?.stay_at_bhati ? 'Yes' : 'No',
        'Chair Pass': c?.chair_pass ? 'Yes' : 'No',
        'Requested Dept': deptName(data?.deployMap[key]),
        'Prev. Dept': prev?.prev_department || 'Were not deployed in last session',
        'Attendance Reported': attendanceDisplay(prev?.attendance_reported, prev?.prev_department) || '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Consent & Deployment')
    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}.xlsx`)
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><BarChart3 size={22} /> Consent Dashboard</h2>
          <div className="page-sub">Collective overview across every centre</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
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

      {loading || !data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
        </div>
      ) : total === 0 ? (
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
              <div className="stat-value">{total}</div>
              <div className="stat-sub">across {allCentreNames.length} centres</div>
            </div>
            <div className="stat">
              <div className="stat-label">Consented (Yes)</div>
              <div className="stat-value" style={{ color: '#10b981' }}>{consented}</div>
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
              <div className="stat-value" style={{ color: '#6366f1' }}>{bhatiCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Initiated</div>
              <div className="stat-value" style={{ color: '#0ea5e9' }}>{initiatedCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
            {/* ── day-wise consent distribution ── */}
            <div className="card" style={{ padding: '1.25rem' }}>
              <div className="section-header">
                <div>
                  <div className="section-title"><CalendarDays size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Day-wise consent</div>
                  <div className="card-sub">How many days each consented sewadar is available</div>
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

            {/* ── centre-wise consent breakdown ── */}
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

          {/* ── grouped parent-child table ── */}
          <div className="card">
            <div className="table-wrap" style={{ border: 'none', borderRadius: '10px 10px 0 0' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Parent centre</th>
                    <th>Centre</th>
                    <th>Sewadars</th>
                    <th>Consented</th>
                    <th>Consent %</th>
                  </tr>
                </thead>
                <tbody>
                  {parentOrder.map(parent => {
                    const kids = centreRows.filter(r => r.parent === parent)
                    const parentRow = centreRows.find(r => r.name === parent)
                    return [
                      parentRow && (
                        <tr key={parent}>
                          <td colSpan={2} style={{ fontWeight: 700 }}>{parent} {kids.length > 0 && <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>+ {kids.length} child{kids.length > 1 ? 'ren' : ''}</span>}</td>
                          <td data-label="Sewadars">{parentRow.total}</td>
                          <td data-label="Consented">{parentRow.consented}</td>
                          <td data-label="Consent %">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div className="progress" style={{ width: 60, height: 8 }}><div className="progress-bar" style={{ width: `${parentRow.total ? Math.round(parentRow.consented / parentRow.total * 100) : 0}%` }} /></div>
                              <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{parentRow.total ? Math.round(parentRow.consented / parentRow.total * 100) : 0}%</span>
                            </div>
                          </td>
                        </tr>
                      ),
                      kids.map(k => (
                        <tr key={k.name} style={{ background: '#fafbfd' }}>
                          <td style={{ color: '#cbd5e1' }}>·</td>
                          <td data-label="Centre" style={{ paddingLeft: '1.5rem', fontWeight: 600 }}>↳ {k.name}</td>
                          <td data-label="Sewadars">{k.total}</td>
                          <td data-label="Consented">{k.consented}</td>
                          <td data-label="Consent %">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div className="progress" style={{ width: 60, height: 8 }}><div className="progress-bar" style={{ width: `${k.total ? Math.round(k.consented / k.total * 100) : 0}%` }} /></div>
                              <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{k.total ? Math.round(k.consented / k.total * 100) : 0}%</span>
                            </div>
                          </td>
                        </tr>
                      )),
                    ]
                  })}
                </tbody>
              </table>
            </div>
            {centreRows.length > 0 && (
              <div style={{ padding: '0.85rem 1.25rem', fontSize: '0.82rem', color: '#64748b', borderTop: '1px solid #f1f5f9' }}>
                Overall: <strong>{centreRows.reduce((s, r) => s + r.consented, 0)}</strong> of <strong>{centreRows.reduce((s, r) => s + r.total, 0)}</strong> sewadars consented across {allCentreNames.length} centres
              </div>
            )}
          </div>

          {/* ── prev-year comparison table ── */}
          <div className="card">
            <div className="section-header" style={{ padding: '1.25rem 1.25rem 0' }}>
              <div>
                <div className="section-title"><AlertTriangle size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> Prev-year comparison</div>
                <div className="card-sub">Current requested dept vs last visit's dept &amp; attendance</div>
              </div>
            </div>
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0, padding: '0 1.25rem 1.25rem' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Badge</th>
                    <th>Name</th>
                    <th>Centre</th>
                    <th>Current Requested</th>
                    <th>Prev. Dept</th>
                    <th>Attendance Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {consentedList.map(sw => {
                    const key = `${sw.centre}|${sw.badge_number}`
                    const prev = data?.prevMap[sw.badge_number]
                    const low = isLowAttendance(prev?.attendance_reported, prev?.prev_department)
                    return (
                      <tr key={key}>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">{sw.badge_number}</td>
                        <td style={{ fontWeight: 500 }} data-label="Name">{sw.sewadar_name}</td>
                        <td data-label="Centre" style={{ color: '#64748b', fontSize: '0.8rem' }}>{sw.centre}</td>
                        <td data-label="Current Requested">{deptName(data?.deployMap[key])}</td>
                        <td data-label="Prev. Dept">{prev?.prev_department || 'Were not deployed in last session'}</td>
                        <td data-label="Attendance Reported" style={{ textAlign: 'center' }}>
                          {prev ? (
                            <span className={`attendance-pill ${low ? 'low' : 'ok'}`}>
                              {attendanceDisplay(prev.attendance_reported, prev.prev_department)}
                            </span>
                          ) : <span style={{ color: '#cbd5e1' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
