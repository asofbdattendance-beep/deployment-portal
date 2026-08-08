import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import { supabase } from '../lib/supabase'
import { notElderlyFilter, isVssBadge } from '../lib/logic'
import { useToast } from '../components/Toast'
import DeadlinePill from '../components/DeadlinePill'
import {
  Save, CheckCircle2, Search, ClipboardCheck, ChevronDown, Users,
  Download, Pencil, Lock,
} from 'lucide-react'
import * as XLSX from 'xlsx'

/* ─── ASO / super_admin: assign the FINAL (deployed) department ───
   Centres record a REQUESTED department; aso/super_admin confirm or
   override it here. Consent fields are visible as a read-only preview
   unless "Enable editing" is ticked — editing never happens automatically.
   The table body is memoized so toggling edit mode / editing one row does
   not re-render every other row. */

/* ─── Memoized row: re-renders only when its own data/props change ─── */
const DeployRow = memo(function DeployRow({ row, depts, deptNames, handlers }) {
  const key = `${row.centre}|${row.badge_number}`
  const reqName = deptNames.get(row.requested_dept_id)?.name || null
  const noRequest = !row.requested_dept_id
  const overridden = !!row.requested_dept_id && !!row.deployed_dept_id && row.deployed_dept_id !== row.requested_dept_id
  const rowBg = overridden ? '#fff7ed' : (row.consent_given && noRequest ? '#fffbeb' : undefined)

  return (
    <tr style={{ background: rowBg }}>
      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          {row.badge_number}
          {row.is_vss && <span className="pill pill-green" style={{ fontSize: '0.6rem' }}>VSS</span>}
        </span>
      </td>
      <td style={{ fontWeight: 500 }} data-label="Name">{row.sewadar_name}
        {row.is_initiated && <span className="pill pill-green" style={{ marginLeft: '0.35rem', fontSize: '0.6rem' }}>INIT</span>}
      </td>
      <td style={{ textAlign: 'center' }} data-label="Consent">
        <select value={row.consent_given ? 'yes' : 'no'} onChange={e => handlers.setConsent(key, e.target.value === 'yes')} className="select" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Days">
        <select value={row.available_days_count} onChange={e => handlers.setDays(key, e.target.value)} disabled={!row.consent_given} className="select" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Stay at Bhati">
        <button role="switch" aria-checked={row.stay_at_bhati} onClick={() => handlers.toggleBhati(key)} disabled={!row.consent_given} className="toggle" title="Stay at bhati">
          <span className="toggle-knob" />
        </button>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Chair Pass">
        <button role="switch" aria-checked={row.chair_pass} onClick={() => handlers.toggleChairPass(key)} disabled={!row.consent_given} className="toggle" title="Chair pass">
          <span className="toggle-knob" />
        </button>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Requested Department">
        {reqName ? <span className="pill pill-blue">{reqName}</span> : <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>}
      </td>
      <td style={{ textAlign: 'center', background: '#f8faff' }} data-label="Deployed Department">
        <select
          value={row.deployed_dept_id || ''}
          onChange={e => handlers.setDeployedDept(key, e.target.value)}
          disabled={noRequest}
          className={row.deployed_dept_id ? 'select assigned' : 'select'}
          style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', minWidth: 160, ...(overridden ? { background: '#fffbeb', borderColor: '#fcd34d', fontWeight: 700, color: '#b45309' } : row.deployed_dept_id ? { background: '#ecfdf5', borderColor: '#a7f3d0', fontWeight: 700, color: '#047857' } : {}) }}
          title={noRequest ? 'No department was requested for this sewadar' : overridden ? 'Deployed department differs from the requested one' : 'Defaults to the requested department — change only if needed'}
        >
          <option value="">{noRequest ? 'Not requested' : '— Not assigned —'}</option>
          {depts.map(d => <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ' (inactive)'}</option>)}
        </select>
        {overridden && <span className="pill pill-amber" style={{ fontSize: '0.6rem', marginLeft: '0.35rem', verticalAlign: 'middle' }}>CHANGED</span>}
      </td>
    </tr>
  )
})

export default function DeploymentAllocationPage() {
  const toast = useToast()

  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [depts, setDepts] = useState([])
  const [rows, setRows] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [expanded, setExpanded] = useState({})

  const loadedRef = useRef(false)
  const dirtyRef = useRef(false)
  const saveTimer = useRef(null)
  const saveAllRef = useRef(null)
  const editVersionRef = useRef(0)
  const scheduleIdRef = useRef(null)
  const savedDeployedRef = useRef({})
  const existingConsentRef = useRef({})
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode

  const loadSchedules = useCallback(async () => {
    const { data } = await supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false })
    if (data) {
      setSchedules(data)
      setSelectedScheduleId(prev => (prev && data.some(s => s.id === prev)) ? prev : (data[0]?.id || ''))
    }
  }, [])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  const loadData = useCallback(async () => {
    if (!selectedScheduleId) return
    setLoading(true)
    try {
      const [sewRes, vssRes, consRes, deptRes, deployRes] = await Promise.all([
        supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, badge_status').or(notElderlyFilter()).order('sewadar_name'),
        supabase.from('vss_sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, is_active, badge_status').order('sewadar_name'),
        supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('deployment_departments').select('*').order('name'),
        supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId),
      ])

      const sewadars = [...(sewRes.data || []), ...(vssRes.data || [])]
      const consentMap = {}
      ;(consRes.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
      const deployMap = {}
      ;(deployRes.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d })

      const map = {}
      sewadars.forEach(sw => {
        const key = `${sw.centre}|${sw.badge_number}`
        const ex = consentMap[key]
        const dep = deployMap[key]
        map[key] = {
          centre: sw.centre,
          badge_number: sw.badge_number,
          sewadar_name: sw.sewadar_name,
          department: sw.department,
          is_initiated: !!sw.is_initiated,
          is_vss: isVssBadge(sw.badge_number),
          consent_given: ex?.consent_given ?? false,
          available_days_count: ex?.available_days_count ?? 3,
          stay_at_bhati: ex?.stay_at_bhati || false,
          chair_pass: ex?.chair_pass || false,
          requested_dept_id: dep?.department_id || '',
          deployment_id: dep?.id || null,
          // deployed defaults to the requested department, so the ASO only
          // touches the records that genuinely need to change
          deployed_dept_id: dep?.deployed_department_id || dep?.department_id || null,
        }
        savedDeployedRef.current[key] = dep?.deployed_department_id || dep?.department_id || null
        existingConsentRef.current[key] = ex ? true : false
      })
      setRows(map)
      setDepts(deptRes.data || [])
      dirtyRef.current = false
      editVersionRef.current = 0
      loadedRef.current = true
      scheduleIdRef.current = selectedScheduleId
      setFilterCentre('all')
      setFilterStatus('all')
      setSearch('')
      setEditMode(false)
    } finally { setLoading(false) }
  }, [selectedScheduleId])

  useEffect(() => { loadData() }, [loadData])

  // realtime: refresh if a centre request changes while we're viewing
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    const channel = supabase
      .channel(`deploy-alloc-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, () => {
        if (!mounted || dirtyRef.current) return
        loadData()
      })
      .subscribe()
    return () => { mounted = false; supabase.removeChannel(channel) }
  }, [selectedScheduleId, loadData])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deptMap = useMemo(() => {
    const m = new Map()
    depts.forEach(d => m.set(d.id, d))
    return m
  }, [depts])
  const deptNames = useMemo(() => {
    const m = new Map()
    depts.forEach(d => m.set(d.id, { name: d.name, is_active: d.is_active }))
    return m
  }, [depts])

  // ── edits are only recorded when editMode is ticked on ──
  const markDirty = useCallback(() => {
    dirtyRef.current = true
    editVersionRef.current++
  }, [])
  // All handlers are stable (read editMode via ref) => memoized rows don't
  // re-render on unrelated parent state like saving/expandedHeader.
  const handlers = useMemo(() => ({
    setConsent: (key, value) => {
      if (!editModeRef.current) return
      markDirty()
      setRows(prev => ({ ...prev, [key]: value
        ? { ...prev[key], consent_given: true }
        : { ...prev[key], consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: 3, deployed_dept_id: null },
      }))
    },
    setDays: (key, value) => {
      if (!editModeRef.current) return
      markDirty()
      const days = parseInt(value) || 1
      setRows(prev => ({ ...prev, [key]: { ...prev[key], consent_given: true, available_days_count: Math.min(Math.max(days, 1), 5) } }))
    },
    toggleBhati: (key) => {
      if (!editModeRef.current) return
      markDirty()
      setRows(prev => ({ ...prev, [key]: { ...prev[key], stay_at_bhati: !prev[key].stay_at_bhati } }))
    },
    toggleChairPass: (key) => {
      if (!editModeRef.current) return
      markDirty()
      setRows(prev => ({ ...prev, [key]: { ...prev[key], chair_pass: !prev[key].chair_pass } }))
    },
    setDeployedDept: (key, deptId) => {
      if (!editModeRef.current) return
      markDirty()
      setRows(prev => ({ ...prev, [key]: { ...prev[key], deployed_dept_id: deptId || null } }))
    },
  }), [markDirty])

  const saveAll = useCallback(async () => {
    if (!selectedScheduleId) return
    if (scheduleIdRef.current !== selectedScheduleId) return
    setSaving(true)
    const versionAtStart = editVersionRef.current
    try {
      const entries = Object.values(rows)

      // consent upserts — persist only rows that have a consent record already
      // or that the finalizer just consented (avoid creating rows for everyone)
      const toUpsert = entries
        .filter(r => r.consent_given || existingConsentRef.current[r.centre + '|' + r.badge_number])
        .map(r => ({
          schedule_id: selectedScheduleId,
          centre: r.centre,
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name,
          consent_given: r.consent_given,
          available_days_count: r.consent_given ? r.available_days_count : null,
          stay_at_bhati: r.stay_at_bhati,
          chair_pass: r.chair_pass,
        }))

      if (toUpsert.length > 0) {
        const { error } = await supabase.from('sewadar_consents').upsert(toUpsert, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) { toast.error(error.message); dirtyRef.current = true; return }
      }

      // deployed (final) department updates
      const toUpdate = entries.filter(r => r.deployment_id && savedDeployedRef.current[r.centre + '|' + r.badge_number] !== r.deployed_dept_id)
      const ops = []
      for (const r of toUpdate) {
        ops.push(supabase.from('deployments').update({ deployed_department_id: r.deployed_dept_id }).eq('id', r.deployment_id))
      }
      const results = await Promise.all(ops)
      for (const res of results) if (res.error) { toast.error(res.error.message); dirtyRef.current = true; return }
      toUpdate.forEach(r => { savedDeployedRef.current[r.centre + '|' + r.badge_number] = r.deployed_dept_id })

      if (editVersionRef.current === versionAtStart) dirtyRef.current = false
      setSavedAt(new Date())
    } catch (err) { toast.error(err.message); dirtyRef.current = true } finally { setSaving(false) }
  }, [selectedScheduleId, rows, toast])

  saveAllRef.current = saveAll

  // drop pending autosave when schedule changes
  useEffect(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [selectedScheduleId])

  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveAllRef.current() }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [rows])

  // ── derived stats & visible rows (memoized) ──
  const all = useMemo(() => Object.values(rows), [rows])
  const requestedAll = useMemo(() => all.filter(r => r.requested_dept_id).length, [all])
  const deployedAll = useMemo(() => all.filter(r => r.deployed_dept_id).length, [all])
  const overriddenAll = useMemo(() => all.filter(r => r.requested_dept_id && r.deployed_dept_id && r.deployed_dept_id !== r.requested_dept_id).length, [all])
  const awaitingAll = useMemo(() => all.filter(r => r.consent_given && !r.requested_dept_id).length, [all])
  const statusChips = useMemo(() => [
    { key: 'all', label: 'All', count: all.length },
    { key: 'requested', label: 'Requested', count: requestedAll },
    { key: 'deployed', label: 'Deployed', count: deployedAll },
    { key: 'overridden', label: 'Overridden', count: overriddenAll },
    { key: 'awaiting', label: 'Awaiting', count: awaitingAll },
  ], [all, requestedAll, deployedAll, overriddenAll, awaitingAll])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterStatus === 'requested' && !r.requested_dept_id) return false
      if (filterStatus === 'deployed' && !r.deployed_dept_id) return false
      if (filterStatus === 'overridden' && !(r.requested_dept_id && r.deployed_dept_id && r.deployed_dept_id !== r.requested_dept_id)) return false
      if (filterStatus === 'awaiting' && !(r.consent_given && !r.requested_dept_id)) return false
      if (q && !`${r.sewadar_name} ${r.badge_number}`.toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' }))
  }, [all, filterCentre, filterStatus, search])

  const byCentre = useMemo(() => {
    const m = {}
    visible.forEach(r => {
      if (!m[r.centre]) m[r.centre] = []
      m[r.centre].push(r)
    })
    return m
  }, [visible])
  const centreNames = useMemo(() => Object.keys(byCentre).sort((a, b) => a.localeCompare(b)), [byCentre])

  // reuse for Excel + quota: only rows that have a deployment record can be overwritten
  const deptNameOf = useCallback((id) => deptMap.get(id)?.name || null, [deptMap])

  // ── Excel export ──
  const exportExcel = useCallback(() => {
    const wb = XLSX.utils.book_new()
    const main = visible.map(r => {
      const autoAssigned = r.deployed_dept_id && r.deployed_dept_id === r.requested_dept_id
      const overridden = r.deployed_dept_id && r.deployed_dept_id !== r.requested_dept_id
      return {
        'Centre': r.centre,
        'Badge Number': r.badge_number,
        'Type': r.is_vss ? 'VSS' : 'Regular',
        'Name': r.sewadar_name,
        'Department': r.department || '—',
        'Initiated': r.is_initiated ? 'Yes' : 'No',
        'Consent': r.consent_given ? 'Yes' : 'No',
        'Days': r.consent_given ? r.available_days_count : '—',
        'Stay at Bhati': r.stay_at_bhati ? 'Yes' : 'No',
        'Chair Pass': r.chair_pass ? 'Yes' : 'No',
        'Requested Department': deptNameOf(r.requested_dept_id) || (r.requested_dept_id ? '—' : ''),
        'Deployed Department': deptNameOf(r.deployed_dept_id) || deptNameOf(r.requested_dept_id) || '',
        'Assignment Status': autoAssigned ? 'Auto (requested)' : overridden ? 'Overridden' : (r.consent_given ? 'Not assigned' : 'No consent'),
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(main), 'Assignments')

    // per-department tally: what was requested vs what was deployed
    const tally = {}
    visible.forEach(r => {
      if (!tally[r.centre]) tally[r.centre] = {}
      const reqName = deptNameOf(r.requested_dept_id)
      if (reqName) {
        if (!tally[r.centre][reqName]) tally[r.centre][reqName] = { requested: 0, deployed: 0 }
        tally[r.centre][reqName].requested++
      }
      const depName = deptNameOf(r.deployed_dept_id)
      if (depName) {
        if (!tally[r.centre][depName]) tally[r.centre][depName] = { requested: 0, deployed: 0 }
        tally[r.centre][depName].deployed++
      }
    })
    const summary = []
    Object.entries(tally).forEach(([centre, deps]) => {
      Object.entries(deps).forEach(([name, counts]) => {
        summary.push({
          'Parent Centre': centre,
          'Department': name,
          'Requested': counts.requested,
          'Deployed (assigned)': counts.deployed,
          'Unassigned': Math.max(counts.requested - counts.deployed, 0),
        })
      })
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Department Summary')

    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}_deployment_allocation.xlsx`)
  }, [visible, deptNameOf, schedule])

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><ClipboardCheck size={22} /> Deployment Allocation</h2>
          <div className="page-sub">Set the final deployed department · ASO / Super Admin · defaults to each sewadar's request</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {saving ? <span className="pill pill-amber"><Save size={12} /> Saving...</span> : savedAt ? <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span> : null}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', padding: '0.3rem 0.6rem', borderRadius: 8, background: editMode ? '#eef2ff' : '#f1f5f9', border: `1px solid ${editMode ? '#c7d2fe' : '#e2e8f0'}` }}>
            <input type="checkbox" checked={editMode} onChange={e => setEditMode(e.target.checked)} style={{ accentColor: '#6366f1' }} />
            {editMode ? <Pencil size={13} style={{ color: '#4f46e5' }} /> : <Lock size={13} style={{ color: '#94a3b8' }} />}
            Enable editing
          </label>
          <button onClick={exportExcel} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
            <Download size={13} /> Export Excel
          </button>
          <select value={selectedScheduleId} onChange={e => setSelectedScheduleId(e.target.value)} className="select">
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.status.replace('_', ' ')})</option>
            ))}
          </select>
          {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
        </div>
      </div>

      {!editMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e', marginBottom: '1rem' }}>
          <Lock size={14} /> Editing is disabled. Consents are read-only — nothing changes automatically. The <b>deployed department already defaults to the requested one</b>, so you only need to edit the records that genuinely need a different final department. Tick <b>Enable editing</b> to override any of them.
        </div>
      )}

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Sewadars</div>
          <div className="stat-value">{all.length}</div>
          <div className="stat-sub">across {new Set(all.map(r => r.centre)).size} centres</div>
        </div>
        <div className="stat">
          <div className="stat-label">Requested dept</div>
          <div className="stat-value" style={{ color: '#4f46e5' }}>{requestedAll}</div>
          <div className="stat-sub">auto-assigned by request</div>
        </div>
        <div className="stat">
          <div className="stat-label">Overridden</div>
          <div className="stat-value" style={{ color: overriddenAll ? '#b45309' : '#64748b' }}>{overriddenAll}</div>
          <div className="stat-sub">final dept differs from request</div>
        </div>
        <div className="stat">
          <div className="stat-label">Awaiting request</div>
          <div className="stat-value" style={{ color: awaitingAll ? '#dc2626' : '#64748b' }}>{awaitingAll}</div>
          <div className="stat-sub">consented, no dept requested</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div className="section-title">Sewadar-wise allocation</div>
            <div className="card-sub">Consent · days · stay at bhati · chair pass · requested department · assigned department</div>
          </div>
          <div style={{ flex: 1 }} />
          <select value={filterCentre} onChange={e => setFilterCentre(e.target.value)} className="select">
            <option value="all">All centres</option>
            {centreNames.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / badge..." className="input" style={{ width: '100%', paddingLeft: 30 }} />
          </div>
        </div>

        {/* instant filter chips */}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0', paddingBottom: '0.9rem' }}>
          {statusChips.map(c => {
            const active = filterStatus === c.key
            return (
              <button
                key={c.key}
                onClick={() => setFilterStatus(c.key)}
                className={`pill ${active ? 'pill-indigo' : 'pill-gray'}`}
                style={{ cursor: 'pointer', border: '1px solid transparent', fontWeight: active ? 700 : 600, ...(active ? { boxShadow: '0 1px 4px rgba(99,102,241,0.3)' } : {}) }}
              >
                {c.label}
                <span style={{ opacity: 0.75, marginLeft: '0.3rem', fontWeight: 700 }}>{c.count}</span>
              </button>
            )
          })}
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="empty-icon"><Users size={22} /></div>
              <div className="empty-title">No sewadars found</div>
              <div className="empty-text">{search || filterCentre !== 'all' || filterStatus !== 'all' ? 'Try clearing the filters.' : 'No sewadars exist for this schedule yet.'}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {centreNames.map(centre => {
              const cr = byCentre[centre]
              const open = expanded[centre] !== false
              const assigned = cr.filter(r => r.deployed_dept_id).length
              return (
                <div key={centre} className="acc-item">
                  <div className="acc-head" onClick={() => setExpanded(e => ({ ...e, [centre]: !open }))}>
                    <ChevronDown size={15} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: '#94a3b8' }} />
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{centre}</span>
                    <span className="pill pill-blue" style={{ fontSize: '0.7rem' }}>{assigned}/{cr.length} assigned</span>
                    <div style={{ flex: 1 }} />
                    <div className="progress" style={{ width: 90 }}>
                      <div className="progress-bar" style={{ width: `${Math.round(assigned / cr.length * 100)}%` }} />
                    </div>
                  </div>
                  {open && (
                    <div className="acc-body" style={{ padding: 0 }}>
                      {/* fieldset lets editMode disable every control in one
                          attribute — rows never have to re-render on toggle */}
                      <fieldset disabled={!editMode} style={{ border: 'none', padding: 0, margin: 0 }}>
                        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                          <table className="table">
                          <thead>
                            <tr>
                              <th>Badge</th>
                              <th>Name</th>
                              <th style={{ textAlign: 'center' }}>Consent</th>
                              <th style={{ textAlign: 'center' }}>Days</th>
                              <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                              <th style={{ textAlign: 'center' }}>Chair Pass</th>
                              <th style={{ textAlign: 'center' }}>Requested Department</th>
                              <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Deployed Department</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cr.map(r => (
                              <DeployRow
                                key={`${r.centre}|${r.badge_number}`}
                                row={r}
                                depts={depts}
                                deptNames={deptNames}
                                handlers={handlers}
                              />
                            ))}
                          </tbody>
                        </table>
                        </div>
                      </fieldset>
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