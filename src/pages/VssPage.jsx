import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchSubtreeCentres, getRootCentre, fetchPortalSettings } from '../lib/supabase'
import { computeDeptQuota, vssEligibilityReasons, isVssBadge, canEditDeployment } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import DeptDropdown from '../components/DeptDropdown'
import DeadlinePill, { useDeadlineCountdown, fmtRemaining } from '../components/DeadlinePill'
import Tip from '../components/Tip'
import VssDashboard from '../components/VssDashboard'
import AddVssForm from '../components/AddVssForm'
import VssRoster from '../components/VssRoster'
import {
  Save, Lock, CheckCircle2, Search, ClipboardCheck, ChevronDown, Users, AlertTriangle,
  CheckSquare, Star, UserPlus,
} from 'lucide-react'

/* ─── VSS: dedicated tab. Inner tabs: Deployment (+ Add VSS, placeholder). ─── */
export default function VssPage() {
  const { profile } = usePortalAuth()
  const isAso = profile?.role === 'aso' || profile?.role === 'super_admin'
  const [tab, setTab] = useState('deploy')

  return (
    <div>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '0.9rem 1.25rem 0', display: 'flex', gap: '0.4rem' }}>
        <button className={`seg-btn ${tab === 'deploy' ? 'seg-active' : ''}`} onClick={() => setTab('deploy')}>
          <ClipboardCheck size={14} /> Deployment
        </button>
        <button className={`seg-btn ${tab === 'add' ? 'seg-active' : ''}`} onClick={() => setTab('add')}>
          <UserPlus size={14} /> Add VSS
        </button>
        {isAso && (
          <button className={`seg-btn ${tab === 'roster' ? 'seg-active' : ''}`} onClick={() => setTab('roster')}>
            <Users size={14} /> Roster
          </button>
        )}
      </div>
      {tab === 'add' ? <AddVssForm /> : tab === 'roster' ? <VssRoster /> : isAso ? <VssDashboard /> : <VssDeployTable />}
    </div>
  )
}

/* ─── VSS consent & deployment table (centre_user / centre_admin) ─── */
function VssDeployTable() {
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
  const [settings, setSettings] = useState({ vss_deployment_open: false })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const loadedRef = useRef(false)
  const dirtyRef = useRef(false)
  const saveTimer = useRef(null)
  const saveAllRef = useRef(null)
  const editVersionRef = useRef(0)
  const scheduleIdRef = useRef(null)
  const [subtree, setSubtree] = useState([])
  const [centres, setCentres] = useState([])
  const [filterCentre, setFilterCentre] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [expanded, setExpanded] = useState({})
  const [openDeptDropdown, setOpenDeptDropdown] = useState(null)
  const [openReasons, setOpenReasons] = useState(null)
  const [selected, setSelected] = useState({})
  const [pendingBulk, setPendingBulk] = useState(null)

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
  useEffect(() => { fetchPortalSettings().then(setSettings).catch(() => {}) }, [])

  const loadData = useCallback(async () => {
    if (!selectedScheduleId || !subtree.length) return
    setLoading(true)
    try {
      const [vssRes, consRes, depRes, allocRes, deployRes] = await Promise.all([
        supabase.from('vss_sewadars').select('badge_number, sewadar_name, gender, is_initiated, is_active, remarks, centre').in('centre', subtree).order('sewadar_name'),
        supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId).in('centre', subtree),
        supabase.from('deployment_departments').select('*').eq('is_active', true).order('name'),
        supabase.from('centre_allocations').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId).in('centre', subtree),
      ])

      const vss = vssRes.data || []
      const existing = consRes.data || []
      const map = {}
      existing.forEach(c => { map[`${c.centre}|${c.badge_number}`] = c })
      const deployMap = {}
      ;(deployRes.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d.department_id })
      const rows = {}
      vss.forEach(sw => {
        const key = `${sw.centre}|${sw.badge_number}`
        const ex = map[key]
        rows[key] = {
          centre: sw.centre,
          badge_number: sw.badge_number,
          sewadar_name: sw.sewadar_name,
          gender: sw.gender || '',
          is_initiated: !!sw.is_initiated,
          is_active: sw.is_active !== false,
          remarks: sw.remarks || '',
          consent_given: ex?.consent_given ?? false,
          available_days_count: ex?.available_days_count ?? 3,
          stay_at_bhati: ex?.stay_at_bhati || false,
          chair_pass: ex?.chair_pass || false,
          requested_dept: deployMap[key] || '',
        }
      })
      setConsentRows(rows)
      setDepts(depRes.data || [])
      setAllocations(allocRes.data || [])
      setDeployments(deployRes.data || [])
      dirtyRef.current = false
      editVersionRef.current = 0
      loadedRef.current = true
      scheduleIdRef.current = selectedScheduleId
      const ex = {}
      subtree.forEach(c => { ex[c] = true })
      setExpanded(ex)
    } finally { setLoading(false) }
  }, [selectedScheduleId, subtree])

  useEffect(() => { loadData() }, [loadData])

  // realtime: reflect master switch + centre edits live
  useEffect(() => {
    if (!selectedScheduleId) return
    const channel = supabase
      .channel(`vss-deploy-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedScheduleId])

  const saveAll = useCallback(async () => {
    if (!selectedScheduleId) return
    if (scheduleIdRef.current !== selectedScheduleId) return
    setSaving(true)
    const versionAtStart = editVersionRef.current
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
      const activeDeptIds = new Set(depts.map(d => d.id))
      const toDeploy = Object.values(consentRows)
        .filter(r => r.consent_given && r.requested_dept && r.is_active && activeDeptIds.has(r.requested_dept))
        .map(r => ({
          schedule_id: selectedScheduleId,
          department_id: r.requested_dept,
          centre: r.centre,
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name,
          status: 'requested',
        }))
      const toRemove = Object.values(consentRows)
        .filter(r => !r.consent_given || !r.requested_dept || !r.is_active || !activeDeptIds.has(r.requested_dept))
        .map(r => `${r.centre}|${r.badge_number}`)
        .filter(key => deployments.some(d => `${d.centre}|${d.badge_number}` === key))

      if (toUpsert.length > 0) {
        const { error } = await supabase.from('sewadar_consents').upsert(toUpsert, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) { toast.error(error.message); dirtyRef.current = true; return }
      }
      if (toDeploy.length > 0) {
        const { error } = await supabase.from('deployments').upsert(toDeploy, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) { toast.error(error.message); dirtyRef.current = true; return }
      }
      for (const key of toRemove) {
        const [centre, badge_number] = key.split('|')
        const { error } = await supabase.from('deployments').delete().eq('schedule_id', selectedScheduleId).eq('centre', centre).eq('badge_number', badge_number)
        if (error) { toast.error(error.message); dirtyRef.current = true; return }
      }
      if (editVersionRef.current === versionAtStart) {
        dirtyRef.current = false
      }
      setSavedAt(new Date())
      const { data: fresh } = await supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId).in('centre', subtree)
      if (fresh) setDeployments(fresh)
    } catch (err) { toast.error(err.message); dirtyRef.current = true } finally { setSaving(false) }
  }, [selectedScheduleId, consentRows, deployments, depts, subtree, toast])

  saveAllRef.current = saveAll

  // drop any pending auto-save when the schedule changes (rows belong to the old one)
  useEffect(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [selectedScheduleId])

  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      await saveAllRef.current()
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [consentRows])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deadlinePassed = schedule?.deadline ? new Date(schedule.deadline) < new Date() : false
  const scheduleDone = schedule?.status === 'done'
  const masterOpen = settings.vss_deployment_open === true
  const canEdit = canEditDeployment({
    editableRole: isEditableRole,
    schedule,
    deadlinePassed,
    done: scheduleDone,
    masterOpen,
  })
  const deadlineNow = useDeadlineCountdown(schedule?.deadline)
  const deadlineRemaining = fmtRemaining(schedule?.deadline, deadlineNow)
  const deadlineWarn = deadlineRemaining && !deadlineRemaining.passed && deadlineRemaining.days < 1

  const myAlloc = allocations.filter(a => a.centre === myRoot)
  const savedAllCounts = {}
  deployments.forEach(d => { savedAllCounts[d.department_id] = (savedAllCounts[d.department_id] || 0) + 1 })
  const savedOwnCounts = {}
  deployments.filter(d => isVssBadge(d.badge_number)).forEach(d => { savedOwnCounts[d.department_id] = (savedOwnCounts[d.department_id] || 0) + 1 })
  const localOwnCounts = {}
  Object.values(consentRows).forEach(r => { if (r.consent_given && r.requested_dept) localOwnCounts[r.requested_dept] = (localOwnCounts[r.requested_dept] || 0) + 1 })
  const deptQuota = computeDeptQuota(myAlloc, savedAllCounts, localOwnCounts, savedOwnCounts)

  const vssSewadarMap = {}
  Object.values(consentRows).forEach(r => { vssSewadarMap[`${r.centre}|${r.badge_number}`] = r })

  const rowEligibilityReasons = (key, deptId) => {
    const dept = depts.find(d => d.id === deptId)
    return vssEligibilityReasons(consentRows[key], vssSewadarMap[key], dept)
  }

  const setConsent = (key, value) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => ({
      ...prev,
      [key]: value
        ? { ...prev[key], consent_given: true }
        : { ...prev[key], consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: 3, requested_dept: '' },
    }))
  }
  const setDays = (key, value) => {
    dirtyRef.current = true
    editVersionRef.current++
    const days = parseInt(value) || 1
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], available_days_count: Math.min(Math.max(days, 1), 5) } }))
  }
  const toggleBhati = (key) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], stay_at_bhati: !prev[key].stay_at_bhati } }))
  }
  const toggleChairPass = (key) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], chair_pass: !prev[key].chair_pass } }))
  }
  const setRequestedDept = (key, deptId) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => ({ ...prev, [key]: { ...prev[key], requested_dept: deptId } }))
  }

  useEffect(() => {
    if (!openDeptDropdown) return
    const onDocClick = () => { setOpenDeptDropdown(null); setOpenReasons(null) }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [openDeptDropdown])

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

  const byCentre = {}
  visible.forEach(r => {
    if (!byCentre[r.centre]) byCentre[r.centre] = []
    byCentre[r.centre].push(r)
  })

  const totalAll = Object.values(consentRows).length
  const consentedAll = Object.values(consentRows).filter(r => r.consent_given).length
  const requestedAll = Object.values(consentRows).filter(r => r.consent_given && r.requested_dept).length
  const inactiveAll = Object.values(consentRows).filter(r => !r.is_active).length

  const renderConsentCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Consent">
      <select
        value={r.consent_given ? 'yes' : 'no'}
        onChange={e => setConsent(`${r.centre}|${r.badge_number}`, e.target.value === 'yes')}
        disabled={!canEdit || !r.is_active}
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
        disabled={!canEdit || !r.consent_given || !r.is_active}
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
        disabled={!canEdit || !r.consent_given || !r.is_active}
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
        disabled={!canEdit || !r.consent_given || !r.is_active}
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
    // VSS dropdown lists only departments opened for VSS (include_vss)
    const items = myAlloc.map(a => {
      const dept = depts.find(d => d.id === a.department_id)
      if (!dept || !dept.include_vss) return null
      const q = deptQuota[a.department_id]
      const reasons = rowEligibilityReasons(key, a.department_id)
      const isCurrent = r.requested_dept === a.department_id
      const full = q && !isCurrent && q.rem < 1
      if (full) reasons.push(`Allocated quota reached (${q ? q.effective : 0}/${q ? q.max : a.max_count})`)
      return { deptId: a.department_id, name: dept.name, q, reasons, isCurrent, full }
    }).filter(Boolean)
    // VSS-enabled departments that aren't allocated to this centre appear greyed
    depts.forEach(d => {
      if (!d.include_vss) return
      if (items.some(it => it.deptId === d.id)) return
      items.push({
        deptId: d.id,
        name: d.name,
        q: null,
        reasons: ['Not allocated to your centre'],
        isCurrent: false,
        full: false,
      })
    })
    const rowDisabled = !r.is_active
    return (
      <td style={{ textAlign: 'center' }} data-label="Requested Deployment Department">
        <DeptDropdown
          row={r}
          depts={depts}
          items={items}
          open={open}
          disabled={!canEdit || !r.consent_given || rowDisabled}
          onToggle={close => close === false ? setOpenDeptDropdown(null) : setOpenDeptDropdown(open ? null : key)}
          onSelect={deptId => { setRequestedDept(key, deptId); setOpenDeptDropdown(null) }}
          openReasons={openReasons}
          setOpenReasons={setOpenReasons}
        />
      </td>
    )
  }

  const toggleSelect = (key) => {
    setSelected(prev => ({ ...prev, [key]: !prev[key] }))
  }
  const selectAllCentre = (centreRows) => {
    const activeRows = centreRows.filter(r => r.is_active)
    const allSelected = activeRows.length > 0 && activeRows.every(r => selected[`${r.centre}|${r.badge_number}`])
    const next = { ...selected }
    activeRows.forEach(r => { next[`${r.centre}|${r.badge_number}`] = !allSelected })
    setSelected(next)
  }
  const clearSelection = () => setSelected({})
  const selectedRows = visible.filter(r => selected[`${r.centre}|${r.badge_number}`])

  const requestBulk = (title, message, updater, keys = null, skipped = []) => {
    if (!selectedRows.length) return
    const inactiveSelected = selectedRows.filter(r => !r.is_active)
    if (inactiveSelected.length > 0) {
      const names = inactiveSelected.map(r => r.sewadar_name).slice(0, 4).join(', ') + (inactiveSelected.length > 4 ? '…' : '')
      toast.error(`Cannot modify ${inactiveSelected.length} inactive VSS sewadar${inactiveSelected.length > 1 ? 's' : ''} — ${names}`)
      return
    }
    setPendingBulk({ title, message, updater, keys, skipped })
  }

  const applyBulk = () => {
    if (!pendingBulk) return
    const inactiveSelected = selectedRows.filter(r => !r.is_active)
    if (inactiveSelected.length > 0) {
      const names = inactiveSelected.map(r => r.sewadar_name).slice(0, 4).join(', ') + (inactiveSelected.length > 4 ? '…' : '')
      toast.error(`Cannot modify ${inactiveSelected.length} inactive VSS sewadar${inactiveSelected.length > 1 ? 's' : ''} — ${names}`)
      setPendingBulk(null)
      return
    }
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      const next = { ...prev }
      selectedRows.forEach(r => {
        const key = `${r.centre}|${r.badge_number}`
        if (pendingBulk.keys && !pendingBulk.keys.has(key)) return
        next[key] = pendingBulk.updater(next[key])
      })
      return next
    })
    setPendingBulk(null)
  }

  const bulkConsent = (value) => {
    requestBulk(
      'Mark consent',
      `Set consent to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => value
        ? { ...row, consent_given: true }
        : { ...row, consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: 3, requested_dept: '' },
    )
  }
  const bulkDays = (days) => {
    requestBulk(
      'Set days',
      `Set available days to ${days} and mark consent Yes for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => ({ ...row, consent_given: true, available_days_count: days }),
    )
  }
  const bulkSetBhati = (value) => {
    requestBulk(
      'Stay at Bhati',
      `Set stay at bhati to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => ({ ...row, stay_at_bhati: value }),
    )
  }
  const bulkSetChairPass = (value) => {
    requestBulk(
      'Chair pass',
      `Set chair pass to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => ({ ...row, chair_pass: value }),
    )
  }
  const bulkAssignDept = (deptId) => {
    const dept = depts.find(d => d.id === deptId)
    if (!dept) return
    const eligibleKeys = new Set()
    const skipped = []
    const q = deptQuota[deptId]
    let remaining = q ? q.rem : Infinity
    selectedRows.forEach(r => {
      const key = `${r.centre}|${r.badge_number}`
      const already = r.requested_dept === deptId
      let reasons = []
      if (!already && remaining < 1) {
        reasons = [`Quota full (${q ? q.effective : 0}/${q ? q.max : '?'} already assigned)`]
      } else {
        reasons = vssEligibilityReasons(r, r, dept)
        if (reasons.length === 0) {
          eligibleKeys.add(key)
          if (!already) remaining--
          return
        }
      }
      skipped.push({ name: r.sewadar_name, badge: r.badge_number, reasons })
    })
    const count = eligibleKeys.size
    requestBulk(
      'Assign to department',
      `Assign ${count} selected VSS sewadar${count === 1 ? '' : 's'} to "${dept.name}"?${skipped.length ? ` ${skipped.length} skipped — see reasons below.` : ''}`,
      row => ({ ...row, requested_dept: deptId }),
      eligibleKeys,
      skipped,
    )
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><Star size={22} /> VSS Consent &amp; Deployment</h2>
          <div className="page-sub">{myCentre} · manages {subtree.length} centre{subtree.length > 1 ? 's' : ''} (own + children) · VSS sewadars only</div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {saving ? (
            <span className="pill pill-amber"><Save size={12} /> Saving...</span>
          ) : savedAt ? (
            <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span>
          ) : null}
          {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">VSS sewadars in scope</div>
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

      {inactiveAll > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#b91c1c', marginBottom: '1rem' }}>
          <AlertTriangle size={15} /> {inactiveAll} inactive VSS sewadar{inactiveAll > 1 ? 's' : ''} — deployment blocked. Hover the red icon for the reason.
        </div>
      )}

      {myAlloc.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {myAlloc.map(a => {
            const dept = depts.find(d => d.id === a.department_id)
            const q = deptQuota[a.department_id]
            const pct = q ? Math.round(q.effective / q.max * 100) : 0
            const over = q && q.rem < 0
            return (
              <div key={a.department_id} className="card" style={{ padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{dept?.name || '—'}</span>
                  <span style={{ fontWeight: 800, fontSize: '0.9rem', color: over ? '#ef4444' : '#0f172a' }}>{q ? q.effective : 0}<span style={{ color: '#94a3b8', fontWeight: 600, fontSize: '0.78rem' }}>/{q ? q.max : a.max_count}</span></span>
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
            <div className="section-title">VSS consent &amp; requested department</div>
            <div className="card-sub">Consent · days (1–5) · stay at bhati · chair pass · requested deployment department (VSS-enabled only)</div>
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

        {!masterOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} /> VSS deployment is closed by the ASO. Editing is disabled.
          </div>
        )}
        {(scheduleDone || deadlinePassed) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} /> {scheduleDone ? 'This schedule is done.' : 'The deadline has passed.'} Editing is disabled.
          </div>
        )}
        {canEdit && deadlineWarn && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#92400e', marginBottom: '1rem' }}>
            <AlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0 }} />
            <span>Deadline is soon — <strong>{deadlineRemaining.text}</strong>. Plan to finish consent &amp; deployment before it closes.</span>
          </div>
        )}

        {canEdit && selectedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '0.6rem 0.75rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
            <span style={{ fontWeight: 700, color: '#3730a3' }}><CheckSquare size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />{selectedRows.length} selected</span>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Consent:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value !== '') { bulkConsent(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Days:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value !== '') { bulkDays(parseInt(e.target.value, 10)); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Stay:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value !== '') { bulkSetBhati(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Chair pass:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value !== '') { bulkSetChairPass(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Dept:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value) { bulkAssignDept(e.target.value); e.target.value = '' } }}>
              <option value="" disabled>Assign…</option>
              {myAlloc.filter(a => depts.find(d => d.id === a.department_id)?.include_vss).map(a => {
                const dept = depts.find(d => d.id === a.department_id)
                return <option key={a.department_id} value={a.department_id}>{dept.name} ({deptQuota[a.department_id]?.effective || 0}/{deptQuota[a.department_id]?.max || a.max_count})</option>
              })}
            </select>
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} onClick={clearSelection}>
              Unselect all
            </button>
          </div>
        )}

        {pendingBulk && (
          <div className="modal-overlay" onClick={() => setPendingBulk(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, maxHeight: '80vh', overflowY: 'auto' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>{pendingBulk.title}</h4>
              <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '0.75rem' }}>{pendingBulk.message}</p>
              {pendingBulk.skipped && pendingBulk.skipped.length > 0 && (
                <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: '0.6rem 0.75rem', marginBottom: '0.75rem' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#b45309', marginBottom: '0.3rem' }}>Skipped ({pendingBulk.skipped.length}) — not eligible</div>
                  {pendingBulk.skipped.map((s, i) => (
                    <div key={i} style={{ padding: '0.25rem 0', borderBottom: i < pendingBulk.skipped.length - 1 ? '1px solid #fde68a' : 'none' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#78350f' }}>
                        {s.name} <span style={{ fontFamily: 'monospace', color: '#92400e', fontWeight: 500 }}>({s.badge})</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#92400e' }}>
                        {s.reasons.map((r, j) => <div key={j} style={{ paddingLeft: '0.5rem' }}>• {r}</div>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setPendingBulk(null)} className="btn" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>Cancel</button>
                <button onClick={applyBulk} className="btn btn-primary" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>Confirm</button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '0.5rem' }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 26 }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No VSS sewadars found</div>
            <div className="empty-text">{search ? 'Try a different name or badge, or clear the filters.' : 'No VSS sewadars exist for the centres in your scope.'}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {Object.entries(byCentre).map(([centre, rows]) => {
              const open = expanded[centre] !== false
              const activeRows = rows.filter(r => r.is_active)
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
                              <th style={{ width: 30, textAlign: 'center' }}>
                                <input type="checkbox" checked={activeRows.length > 0 && activeRows.every(r => selected[`${r.centre}|${r.badge_number}`])} onChange={() => selectAllCentre(rows)} disabled={!canEdit} style={{ cursor: canEdit ? 'pointer' : 'not-allowed' }} title="Select all active VSS in this centre" />
                              </th>
                              <th>Badge</th>
                              <th>Name</th>
                              <th style={{ textAlign: 'center' }}>Gender</th>
                              <th style={{ textAlign: 'center' }}>Initiated</th>
                              <th style={{ textAlign: 'center' }}>Consent</th>
                              <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                              <th style={{ textAlign: 'center' }}>Chair Pass</th>
                              <th style={{ textAlign: 'center' }}>Days</th>
                              <th style={{ textAlign: 'center' }}>Requested Deployment Department</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(r => {
                              const key = `${r.centre}|${r.badge_number}`
                              const inactive = !r.is_active
                              return (
                                <tr key={key} style={{
                                  background: inactive ? '#fef2f2' : selected[key] ? '#f5f3ff' : undefined,
                                  opacity: inactive ? 0.9 : 1,
                                }}>
                                  <td style={{ textAlign: 'center' }} data-label="Select">
                                    <input type="checkbox" checked={!!selected[key]} onChange={() => toggleSelect(key)} disabled={!canEdit || !r.is_active} style={{ cursor: canEdit && r.is_active ? 'pointer' : 'not-allowed' }} title={inactive ? 'Inactive VSS sewadar — cannot be selected' : undefined} />
                                  </td>
                                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                      {inactive && (
                                        <Tip label={`Cant deploy sewadar — ${r.remarks || 'inactive VSS sewadar'}`} tone="danger">
                                          <AlertTriangle size={14} style={{ color: '#dc2626', flexShrink: 0 }} />
                                        </Tip>
                                      )}
                                      <span>{r.badge_number}</span>
                                    </span>
                                    {inactive && (
                                      <Tip label={`Cant deploy sewadar — ${r.remarks || 'inactive VSS sewadar'}`} tone="danger">
                                        <span className="pill pill-red" style={{ fontSize: '0.62rem', marginLeft: '0.35rem', cursor: 'help' }}>INACTIVE</span>
                                      </Tip>
                                    )}
                                  </td>
                                  <td style={{ fontWeight: 500 }} data-label="Name">{r.sewadar_name}</td>
                                  <td style={{ textAlign: 'center', color: '#64748b', fontSize: '0.8rem' }} data-label="Gender">{r.gender || '—'}</td>
                                  <td style={{ textAlign: 'center' }} data-label="Initiated">
                                    <span className={`pill ${r.is_initiated ? 'pill-green' : 'pill-amber'}`}>{r.is_initiated ? 'Yes' : 'No'}</span>
                                  </td>
                                  {renderConsentCell(r)}
                                  {renderBhatiCell(r)}
                                  {renderChairPassCell(r)}
                                  {renderDaysCell(r)}
                                  {renderDeptCell(r)}
                                </tr>
                              )
                            })}
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
