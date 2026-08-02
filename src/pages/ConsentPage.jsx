import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchSubtreeCentres, fetchCentres, getRootCentre } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import { Save, Lock, CheckCircle2, Search, ClipboardCheck, ChevronDown, Users, BarChart3, Building2, CalendarDays, AlertTriangle } from 'lucide-react'

/* ─── Super admin / ASO: read-only consent dashboard across all centres ─── */
function ConsentDashboard() {
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
    })
  }, [])

  useEffect(() => {
    if (!selectedScheduleId) return
    setLoading(true)
    let mounted = true
    ;(async () => {
      try {
        const [centres, sewadars, consents] = await Promise.all([
          fetchCentres(),
          supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated').or('badge_status.is.null,badge_status.neq.ELDERLY'),
          supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId),
        ])
        if (!mounted) return
        const consentMap = {}
        ;(consents.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
        setData({ centres: centres || [], sewadars: sewadars.data || [], consentMap })
      } finally { if (mounted) setLoading(false) }
    })()
    return () => { mounted = false }
  }, [selectedScheduleId])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const allCentreNames = (data?.centres || []).map(c => c.name)
  const consentedList = (data?.sewadars || []).filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.consent_given)

  const total = data?.sewadars.length || 0
  const consented = consentedList.length
  const pct = total ? Math.round(consented / total * 100) : 0
  const bhatiCount = consentedList.filter(sw => data?.consentMap[`${sw.centre}|${sw.badge_number}`]?.stay_at_bhati).length
  const initiatedCount = consentedList.filter(sw => sw.is_initiated).length

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
          {schedule?.deadline && (
            <span className={`pill ${new Date(schedule.deadline) < new Date() ? 'pill-red' : 'pill-green'}`}>
              Deadline {new Date(schedule.deadline).toLocaleString()}
            </span>
          )}
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
              <div className="stat-label">Stay at Bhati</div>
              <div className="stat-value" style={{ color: '#8b5cf6' }}>{bhatiCount}</div>
              <div className="stat-sub">of {consented} consented</div>
            </div>
            <div className="stat">
              <div className="stat-label">Initiated</div>
              <div className="stat-value" style={{ color: '#6366f1' }}>{initiatedCount}</div>
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
                    const groupTotal = (parentRow ? parentRow.total : 0) + kids.reduce((s, k) => s + k.total, 0)
                    const groupCon = (parentRow ? parentRow.consented : 0) + kids.reduce((s, k) => s + k.consented, 0)
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
        </div>
      )}
    </div>
  )
}

export default function ConsentPage() {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const myCentre = profile?.centre
  const isEditableRole = profile?.role === 'centre_user' || profile?.role === 'centre_admin'

  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [consentRows, setConsentRows] = useState({})
  const [depts, setDepts] = useState([])
  const [allocations, setAllocations] = useState([])
  const [deployments, setDeployments] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const loadedRef = useRef(false)
  const dirtyRef = useRef(false)
  const saveTimer = useRef(null)
  const [subtree, setSubtree] = useState([])
  const [centres, setCentres] = useState([])
  const [filterCentre, setFilterCentre] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [expanded, setExpanded] = useState({})
  const [openDeptDropdown, setOpenDeptDropdown] = useState(null)
  const [openReasons, setOpenReasons] = useState(null)
  const [deptMenuPos, setDeptMenuPos] = useState(null)

  const myRoot = getRootCentre(centres, myCentre)

  useEffect(() => {
    if (!myCentre) return
    fetchSubtreeCentres(myCentre).then(({ centres, subtree }) => {
      setCentres(centres)
      setSubtree(subtree)
    }).catch(() => {})
  }, [myCentre])

  const loadSchedules = useCallback(async () => {
    const { data } = await supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false })
    if (data) {
      setSchedules(data)
      setSelectedScheduleId(prev => (prev && data.some(s => s.id === prev)) ? prev : (data[0]?.id || ''))
    }
  }, [])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  const loadData = useCallback(async () => {
    if (!selectedScheduleId || !subtree.length) return
    setLoading(true)
    try {
      const [sewRes, consRes, depRes, allocRes, deployRes, prevRes] = await Promise.all([
        supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated').or('badge_status.is.null,badge_status.neq.ELDERLY').in('centre', subtree).order('sewadar_name'),
        supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId).in('centre', subtree),
        supabase.from('deployment_departments').select('*').eq('is_active', true).order('name'),
        supabase.from('centre_allocations').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId).in('centre', subtree),
        supabase.from('prev_year_deployments').select('badge_number, prev_department, attendance_reported'),
      ])

      const sewadars = sewRes.data || []
      const existing = consRes.data || []
      const map = {}
      existing.forEach(c => { map[`${c.centre}|${c.badge_number}`] = c })
      const deployMap = {}
      ;(deployRes.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d.department_id })
      const prevMap = {}
      ;(prevRes.data || []).forEach(p => { prevMap[p.badge_number] = p })
      const rows = {}
      sewadars.forEach(sw => {
        const key = `${sw.centre}|${sw.badge_number}`
        const ex = map[key]
        const prev = prevMap[sw.badge_number]
        rows[key] = {
          centre: sw.centre,
          badge_number: sw.badge_number,
          sewadar_name: sw.sewadar_name,
          department: sw.department,
          is_initiated: !!sw.is_initiated,
          consent_given: ex?.consent_given ?? false,
          available_days_count: ex?.available_days_count ?? 3,
          stay_at_bhati: ex?.stay_at_bhati || false,
          chair_pass: ex?.chair_pass || false,
          requested_dept: deployMap[key] || '',
          prev_department: prev?.prev_department || null,
          prev_attendance: prev?.attendance_reported != null ? prev.attendance_reported : null,
        }
      })
      setConsentRows(rows)
      setDepts(depRes.data || [])
      setAllocations(allocRes.data || [])
      setDeployments(deployRes.data || [])
      dirtyRef.current = false
      loadedRef.current = true
      const ex = {}
      subtree.forEach(c => { ex[c] = true })
      setExpanded(ex)
    } finally { setLoading(false) }
  }, [selectedScheduleId, subtree])

  useEffect(() => { loadData() }, [loadData])

  const saveAll = useCallback(async () => {
    if (!selectedScheduleId) return
    setSaving(true)
    try {
      const toUpsert = Object.values(consentRows).map(r => ({
        schedule_id: selectedScheduleId,
        centre: r.centre,
        badge_number: r.badge_number,
        sewadar_name: r.sewadar_name,
        consent_given: r.consent_given,
        available_days_count: r.consent_given ? r.available_days_count : null,
        stay_at_bhati: r.stay_at_bhati,
        chair_pass: r.chair_pass,
      }))
      const toDeploy = Object.values(consentRows)
        .filter(r => r.consent_given && r.requested_dept)
        .map(r => ({
          schedule_id: selectedScheduleId,
          department_id: r.requested_dept,
          centre: r.centre,
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name,
          status: 'requested',
        }))
      const toRemove = Object.values(consentRows)
        .filter(r => !r.consent_given || !r.requested_dept)
        .map(r => `${r.centre}|${r.badge_number}`)
        .filter(key => deployments.some(d => `${d.centre}|${d.badge_number}` === key))

      if (toUpsert.length > 0) {
        const { error } = await supabase.from('sewadar_consents').upsert(toUpsert, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) { toast.error(error.message); return }
      }
      if (toDeploy.length > 0) {
        const { error } = await supabase.from('deployments').upsert(toDeploy, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) { toast.error(error.message); return }
      }
      for (const key of toRemove) {
        const [centre, badge_number] = key.split('|')
        const { error } = await supabase.from('deployments').delete().eq('schedule_id', selectedScheduleId).eq('centre', centre).eq('badge_number', badge_number)
        if (error) { toast.error(error.message); return }
      }
      setSavedAt(new Date())
    } catch (err) { toast.error(err.message) } finally { setSaving(false) }
  }, [selectedScheduleId, consentRows, deployments, toast])

  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      dirtyRef.current = false
      await saveAll()
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [consentRows, saveAll])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deadlinePassed = schedule?.deadline ? new Date(schedule.deadline) < new Date() : false
  const scheduleDone = schedule?.status === 'done'
  const canEdit = isEditableRole && !!schedule && schedule.status === 'open' && !deadlinePassed && !scheduleDone

  const myAlloc = allocations.filter(a => a.centre === myRoot)
  const savedCounts = {}
  deployments.forEach(d => { savedCounts[d.department_id] = (savedCounts[d.department_id] || 0) + 1 })
  const localCounts = {}
  Object.values(consentRows).forEach(r => { if (r.consent_given && r.requested_dept) localCounts[r.requested_dept] = (localCounts[r.requested_dept] || 0) + 1 })
  const deptQuota = {}
  myAlloc.forEach(a => {
    const used = savedCounts[a.department_id] || 0
    const local = localCounts[a.department_id] || 0
    deptQuota[a.department_id] = { max: a.max_count, used, local, rem: Math.max(a.max_count - used - (local - used), 0) }
  })

  // returns a list of human-readable reasons a sewadar is not eligible for a dept
  const eligibilityReasons = (key, deptId) => {
    const r = consentRows[key]
    const dept = depts.find(d => d.id === deptId)
    if (!r || !dept) return ['Department not found']
    if (!r.consent_given) return ['Consent not given']
    const reasons = []
    if ((r.available_days_count ?? 0) < (dept.min_days ?? 1)) {
      reasons.push(`Needs minimum ${dept.min_days} consent day${dept.min_days > 1 ? 's' : ''} (has ${r.available_days_count ?? 0})`)
    }
    if (dept.requires_stay_at_bhati && !r.stay_at_bhati) {
      reasons.push('Requires stay at bhati')
    }
    if (dept.requires_initiated && !r.is_initiated) {
      reasons.push('Requires initiated sewadar')
    }
    return reasons
  }

  const setConsent = (key, value) => {
    dirtyRef.current = true
    setConsentRows(prev => ({
      ...prev,
      [key]: value
        ? { ...prev[key], consent_given: true }
        : { ...prev[key], consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: 3, requested_dept: '' },
    }))
  }
  const setDays = (key, value) => {
    dirtyRef.current = true
    const days = parseInt(value) || 1
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], available_days_count: Math.min(Math.max(days, 1), 5) } }))
  }
  const toggleBhati = (key) => {
    dirtyRef.current = true
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], stay_at_bhati: !prev[key].stay_at_bhati } }))
  }
  const toggleChairPass = (key) => {
    dirtyRef.current = true
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], chair_pass: !prev[key].chair_pass } }))
  }
  const setRequestedDept = (key, deptId) => {
    dirtyRef.current = true
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], requested_dept: deptId } }))
  }

  useEffect(() => {
    if (!openDeptDropdown) return
    const onDocClick = () => { setOpenDeptDropdown(null); setOpenReasons(null) }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [openDeptDropdown])

  if (profile?.role === 'super_admin' || profile?.role === 'aso') {
    return <ConsentDashboard />
  }

  if (!schedules.length) {
    return (
      <div className="page">
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          <p style={{ fontSize: '0.9rem' }}>No schedules available yet. Contact your super admin.</p>
        </div>
      </div>
    )
  }

  const visible = Object.values(consentRows).filter(r => {
    if (filterCentre !== 'all' && r.centre !== filterCentre) return false
    if (search && !`${r.sewadar_name} ${r.badge_number}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }).sort((a, b) => {
    if (sortBy === 'badge') return a.badge_number.localeCompare(b.badge_number, undefined, { numeric: true })
    return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
  })

  // group by centre
  const byCentre = {}
  visible.forEach(r => {
    if (!byCentre[r.centre]) byCentre[r.centre] = []
    byCentre[r.centre].push(r)
  })

  const totalAll = Object.values(consentRows).length
  const consentedAll = Object.values(consentRows).filter(r => r.consent_given).length
  const requestedAll = Object.values(consentRows).filter(r => r.consent_given && r.requested_dept).length

  const SkeletonTable = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '0.5rem' }}>
      {[...Array(4)].map((_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 120px 100px 100px 80px 160px', gap: '0.75rem' }}>
          {[...Array(8)].map((_, j) => <div key={j} className="skeleton" style={{ height: 26 }} />)}
        </div>
      ))}
    </div>
  )

  // Highlight low prev-year attendance: 0,1 always; 2 only if not TRAFFIC OUTSIDE BHATI
  const isLowAttendance = (r) => {
    if (r.prev_attendance == null) return false
    const isTrafficOutside = r.prev_department === 'TRAFFIC OUTSIDE BHATI'
    return r.prev_attendance <= 1 || (r.prev_attendance === 2 && !isTrafficOutside)
  }
  const attendanceStyle = (r) => {
    if (r.prev_attendance == null) return { color: '#cbd5e1' }
    if (isLowAttendance(r)) {
      return {
        color: '#b91c1c',
        background: '#fef2f2',
        borderRadius: 6,
        padding: '0.1rem 0.4rem',
        display: 'inline-block',
      }
    }
    return { color: '#047857', background: '#ecfdf5', borderRadius: 6, padding: '0.1rem 0.4rem', display: 'inline-block' }
  }
  const renderConsentCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Consent">
      <select
        value={r.consent_given ? 'yes' : 'no'}
        onChange={e => setConsent(`${r.centre}|${r.badge_number}`, e.target.value === 'yes')}
        disabled={!canEdit}
        className="select"
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
      >
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </select>
    </td>
  )
  const renderBhatiCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Stay at Bhati">
      <button
        role="switch"
        aria-checked={r.stay_at_bhati}
        onClick={() => toggleBhati(`${r.centre}|${r.badge_number}`)}
        disabled={!canEdit || !r.consent_given}
        className="toggle"
        title="Stay at bhati"
      >
        <span className="toggle-knob" />
      </button>
    </td>
  )
  const renderChairPassCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Chair Pass">
      <button
        role="switch"
        aria-checked={r.chair_pass}
        onClick={() => toggleChairPass(`${r.centre}|${r.badge_number}`)}
        disabled={!canEdit || !r.consent_given}
        className="toggle"
        title="Chair pass"
      >
        <span className="toggle-knob" />
      </button>
    </td>
  )
  const renderDaysCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Days">
      <select
        value={r.available_days_count}
        onChange={e => setDays(`${r.centre}|${r.badge_number}`, e.target.value)}
        disabled={!canEdit || !r.consent_given}
        className="select"
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
      >
        {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </td>
  )
  const renderDeptCell = (r) => {
    const key = `${r.centre}|${r.badge_number}`
    const open = openDeptDropdown === key
    const current = depts.find(d => d.id === r.requested_dept)
    const items = myAlloc.map(a => {
      const dept = depts.find(d => d.id === a.department_id)
      if (!dept) return null
      const q = deptQuota[a.department_id]
      const reasons = eligibilityReasons(key, a.department_id)
      const isCurrent = r.requested_dept === a.department_id
      const full = q && !isCurrent && q.rem < 1
      if (full) reasons.push(`Allocated quota reached (${q ? q.local : 0}/${q ? q.max : a.max_count})`)
      return { deptId: a.department_id, name: dept.name, q, reasons, isCurrent, full }
    }).filter(Boolean)
    const openMenu = () => {
      const btn = document.getElementById(`dept-btn-${key}`)
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const menuH = 320
      const spaceBelow = window.innerHeight - r.bottom
      const above = spaceBelow < menuH
      setDeptMenuPos({
        top: above ? Math.max(r.top - menuH, 8) : r.bottom + 4,
        left: Math.min(Math.max(r.left, 8), window.innerWidth - 350),
        width: Math.max(r.width, 280),
        above,
      })
      setOpenDeptDropdown(key)
    }
    return (
      <td style={{ textAlign: 'center' }} data-label="Requested Deployment Department">
        <div style={{ position: 'relative', display: 'inline-block', minWidth: 150 }}>
          <button
            type="button"
            id={`dept-btn-${key}`}
            onClick={e => { e.stopPropagation(); if (open) setOpenDeptDropdown(null); else openMenu() }}
            disabled={!canEdit || !r.consent_given}
            className="select"
            style={{ width: '100%', textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.8rem', background: '#fff', cursor: !canEdit || !r.consent_given ? 'not-allowed' : 'pointer' }}
          >
            {current ? current.name : '—'}
            <span style={{ float: 'right', color: '#94a3b8', fontSize: '0.7rem' }}>{open ? '▲' : '▼'}</span>
          </button>
          {open && deptMenuPos && (
            <div
              className="dept-menu"
              onClick={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                zIndex: 100,
                top: deptMenuPos.top,
                left: deptMenuPos.left,
                width: deptMenuPos.width,
                maxWidth: 340,
                maxHeight: 320,
                overflowY: 'auto',
                background: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                boxShadow: '0 10px 40px rgba(15,23,42,0.15)',
              }}
            >
              {items.map(it => {
                const disabled = it.reasons.length > 0 && !it.isCurrent
                const reasonKey = `${key}|${it.deptId}`
                const showReasons = openReasons === reasonKey
                return (
                  <div key={it.deptId}>
                    <div
                      className="dept-item"
                      onClick={e => {
                        e.stopPropagation()
                        if (disabled) {
                          setOpenReasons(showReasons ? null : reasonKey)
                          return
                        }
                        setRequestedDept(key, it.deptId)
                        setOpenDeptDropdown(null)
                      }}
                      onMouseEnter={() => { if (disabled) setOpenReasons(reasonKey) }}
                      onMouseLeave={() => { if (disabled) setOpenReasons(null) }}
                      style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.82rem',
                        cursor: disabled ? 'pointer' : 'pointer',
                        color: it.isCurrent ? '#4f46e5' : disabled ? '#94a3b8' : '#0f172a',
                        fontWeight: it.isCurrent ? 700 : 500,
                        background: it.isCurrent ? '#eef2ff' : 'transparent',
                        borderBottom: '1px solid #f1f5f9',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                        {disabled && <span style={{ color: '#f59e0b', fontSize: '0.7rem', flexShrink: 0 }}>✕</span>}
                        {it.isCurrent && <span style={{ color: '#4f46e5', fontSize: '0.7rem', flexShrink: 0 }}>✓</span>}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 }}>
                        {it.q ? `${it.q.local}/${it.q.max}` : '0/0'}
                      </span>
                    </div>
                    {showReasons && (
                      <div className="dept-reason" style={{ background: '#fffbeb', borderTop: '1px solid #fde68a', borderBottom: '1px solid #fde68a', padding: '0.45rem 0.75rem 0.55rem 1.25rem', fontSize: '0.75rem', color: '#92400e' }}>
                        <div style={{ fontWeight: 700, marginBottom: '0.15rem', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#b45309' }}>Not eligible</div>
                        {it.reasons.map((reason, i) => <div key={i} style={{ padding: '0.05rem 0' }}>• {reason}</div>)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </td>
    )
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><ClipboardCheck size={22} /> Consent &amp; Deployment</h2>
          <div className="page-sub">{myCentre} · manages {subtree.length} centre{subtree.length > 1 ? 's' : ''} (own + children)</div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {saving ? (
            <span className="pill pill-amber"><Save size={12} /> Saving...</span>
          ) : savedAt ? (
            <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span>
          ) : null}
          {schedule?.deadline && (
            <span className={`pill ${deadlinePassed ? 'pill-red' : 'pill-green'}`}>
              Deadline {new Date(schedule.deadline).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Sewadars in scope</div>
          <div className="stat-value">{totalAll}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Consented (Yes)</div>
          <div className="stat-value" style={{ color: consentedAll === totalAll && totalAll ? '#10b981' : '#6366f1' }}>{consentedAll}</div>
          <div className="stat-sub">of {totalAll}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Requested dept</div>
          <div className="stat-value" style={{ color: requestedAll === consentedAll && consentedAll ? '#10b981' : '#8b5cf6' }}>{requestedAll}</div>
          <div className="stat-sub">of {consentedAll} consented</div>
        </div>
        <div className="stat">
          <div className="stat-label">Consent completion</div>
          <div className="stat-value" style={{ fontSize: '1.1rem', paddingTop: '0.35rem' }}>
            <div className="progress" style={{ height: 10 }}>
              <div className="progress-bar" style={{ width: `${totalAll ? Math.round(consentedAll / totalAll * 100) : 0}%` }} />
            </div>
          </div>
          <div className="stat-sub">{totalAll ? Math.round(consentedAll / totalAll * 100) : 0}% consented</div>
        </div>
      </div>

      {myAlloc.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {myAlloc.map(a => {
            const dept = depts.find(d => d.id === a.department_id)
            const q = deptQuota[a.department_id]
            const pct = q ? Math.round(q.local / q.max * 100) : 0
            const over = q && q.rem < 0
            return (
              <div key={a.department_id} className="card" style={{ padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{dept?.name || '—'}</span>
                  <span style={{ fontWeight: 800, fontSize: '0.9rem', color: over ? '#ef4444' : '#0f172a' }}>{q ? q.local : 0}<span style={{ color: '#94a3b8', fontWeight: 600, fontSize: '0.78rem' }}>/{q ? q.max : a.max_count}</span></span>
                </div>
                <div className="progress">
                  <div className={`progress-bar ${over ? 'danger' : pct >= 100 ? 'success' : ''}`} style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div className="section-title">Consent &amp; requested department</div>
            <div className="card-sub">Consent · days (1–5) · stay at bhati · chair pass · requested deployment department · prev. visit data</div>
          </div>
          <div style={{ flex: 1 }} />
          <select value={selectedScheduleId} onChange={e => setSelectedScheduleId(e.target.value)} className="select">
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.status.replace('_', ' ')})</option>
            ))}
          </select>
          <select value={filterCentre} onChange={e => setFilterCentre(e.target.value)} className="select">
            <option value="all">All centres</option>
            {subtree.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="select" title="Sort rows">
            <option value="name">Sort: Name</option>
            <option value="badge">Sort: Badge number</option>
          </select>
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / badge..." className="input" style={{ width: '100%', paddingLeft: 30 }} />
          </div>
        </div>

        {(scheduleDone || deadlinePassed) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} /> {scheduleDone ? 'This schedule is done.' : 'The deadline has passed.'} Editing is disabled.
          </div>
        )}

        {loading ? (
          <SkeletonTable />
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No sewadars found</div>
            <div className="empty-text">{search ? 'Try a different name or badge, or clear the filters.' : 'No sewadars exist for the centres in your scope.'}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {Object.entries(byCentre).map(([centre, rows]) => {
              const open = expanded[centre] !== false
              const done = rows.filter(r => r.consent_given).length
              const pct = rows.length ? Math.round(done / rows.length * 100) : 0
              return (
                <div key={centre} className="acc-item">
                  <div className="acc-head" onClick={() => setExpanded(e => ({ ...e, [centre]: !open }))}>
                    <ChevronDown size={15} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: '#94a3b8' }} />
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{centre}</span>
                    <span className={`pill ${pct === 100 ? 'pill-blue' : 'pill-amber'}`} style={{ fontSize: '0.7rem' }}>
                      {done}/{rows.length} consented
                    </span>
                    <div style={{ flex: 1 }} />
                    <div className="progress" style={{ width: 90 }}>
                      <div className={`progress-bar ${pct === 100 ? '' : 'warn'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  {open && (
                    <div className="acc-body" style={{ padding: 0 }}>
                      <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Badge</th>
                              <th>Name</th>
                              <th>Dept</th>
                              <th style={{ textAlign: 'center' }}>Initiated</th>
                              <th style={{ textAlign: 'center' }}>Consent</th>
                              <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                              <th style={{ textAlign: 'center' }}>Chair Pass</th>
                              <th style={{ textAlign: 'center' }}>Days</th>
                              <th style={{ textAlign: 'center' }}>Requested Deployment Department</th>
                              <th style={{ textAlign: 'center', borderLeft: '2px solid #e2e8f0' }}>Prev. Dept</th>
                              <th style={{ textAlign: 'center' }}>Attendance Reported</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(r => (
                              <tr key={`${r.centre}|${r.badge_number}`}>
                                <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                    {isLowAttendance(r) && (
                                      <AlertTriangle size={14} style={{ color: '#dc2626', flexShrink: 0 }} title="Low attendance in last session" />
                                    )}
                                    <span>{r.badge_number}</span>
                                  </span>
                                </td>
                                <td style={{ fontWeight: 500 }} data-label="Name">{r.sewadar_name}</td>
                                <td style={{ color: '#64748b' }} data-label="Dept">{r.department || '—'}</td>
                                <td style={{ textAlign: 'center' }} data-label="Initiated">
                                  <span className={`pill ${r.is_initiated ? 'pill-green' : 'pill-amber'}`}>{r.is_initiated ? 'Yes' : 'No'}</span>
                                </td>
                                {renderConsentCell(r)}
                                {renderBhatiCell(r)}
                                {renderChairPassCell(r)}
                                {renderDaysCell(r)}
                                {renderDeptCell(r)}
                                {!r.prev_department ? (
                                  <td colSpan={2} data-label="Prev. Session" style={{ textAlign: 'center', borderLeft: '2px solid #e2e8f0', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 400, whiteSpace: 'normal' }}>
                                    Were not deployed in last session
                                  </td>
                                ) : (
                                  <>
                                    <td data-label="Prev. Dept" style={{ textAlign: 'center', borderLeft: '2px solid #e2e8f0', color: '#334155', fontSize: '0.8rem', fontWeight: 500 }}>
                                      {r.prev_department}
                                    </td>
                                    <td data-label="Attendance Reported" style={{ textAlign: 'center', fontSize: '0.8rem', fontWeight: 700 }}>
                                      <span style={{ ...attendanceStyle(r) }}>{`${Math.min(r.prev_attendance, r.prev_department === 'TRAFFIC OUTSIDE BHATI' ? 3 : 5)} / ${r.prev_department === 'TRAFFIC OUTSIDE BHATI' ? 3 : 5}`}</span>
                                    </td>
                                  </>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
