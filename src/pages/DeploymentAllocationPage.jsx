import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import { supabase } from '../lib/supabase'
import { notElderlyFilter, isVssBadge, DEFAULT_AVAILABLE_DAYS, isOeEscortsDept, daysForDept, getRootCentre, changedConsentRows, buildConsentSnapshot } from '../lib/logic'
import { useToast } from '../components/Toast'
import {
  Save, CheckCircle2, Search, ClipboardCheck, Users,
  Download, Pencil, Lock,
} from 'lucide-react'

/* ─── ASO / super_admin: assign the FINAL (deployed) department ───
   Centres record a REQUESTED department; aso/super_admin confirm or
   override it here. Consent fields are visible as a read-only preview
   unless "Enable editing" is ticked — editing never happens automatically.
   The table body is memoized so toggling edit mode / editing one row does
   not re-render every other row. */

// Every rendered row is forced to exactly this height so the virtual-window
// math (scrollTop / ROW_H) matches the real scrollbar — a content-height row
// would silently drift the window and blank out the bottom of long lists.
const ROW_H = 44

/* ─── Memoized row: re-renders only when its own data/props change ─── */
const DeployRow = memo(function DeployRow({ row, depts, deptNames, handlers, serial }) {
  const key = `${row.centre}|${row.badge_number}`
  const reqName = deptNames.get(row.requested_dept_id)?.name || null
  const noRequest = !row.requested_dept_id
  const overridden = !!row.requested_dept_id && !!row.deployed_dept_id && row.deployed_dept_id !== row.requested_dept_id
  // days are auto-set by the FINAL deployed department (5 by default, 3 for OE ESCORTS)
  const oeLocked = isOeEscortsDept(deptNames.get(row.deployed_dept_id)?.name || null)
  const rowBg = overridden ? '#fff7ed' : (row.consent_given && noRequest ? '#fffbeb' : undefined)

  return (
    <tr style={{ height: ROW_H, background: rowBg }}>
      <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{serial}</td>
      <td style={{ fontWeight: 600, fontSize: '0.82rem', whiteSpace: 'nowrap' }} data-label="Centre">{row.centre}</td>
      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          {row.badge_number}
          {row.is_vss && <span className="pill pill-green" style={{ fontSize: '0.6rem' }}>VSS</span>}
        </span>
      </td>
      <td style={{ fontWeight: 500 }} data-label="Name">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', maxWidth: 220, overflow: 'hidden' }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.sewadar_name}</span>
          {row.is_initiated && <span className="pill pill-green" style={{ flexShrink: 0, fontSize: '0.6rem' }}>INIT</span>}
        </span>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Consent">
        <select value={row.consent_given ? 'yes' : 'no'} onChange={e => handlers.setConsent(key, e.target.value === 'yes')} className="select" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </td>
      <td style={{ textAlign: 'center' }} data-label="Days">
        <span
          className={`pill ${oeLocked ? 'pill-amber' : 'pill-blue'}`}
          title={oeLocked ? 'OE ESCORTS is fixed at 3 days' : 'Days are set automatically to 5 for every department'}
          style={{ fontSize: '0.72rem', cursor: 'help' }}
        >
          <Lock size={10} style={{ verticalAlign: '-1px', marginRight: '0.25rem' }} />{row.available_days_count} day{row.available_days_count > 1 ? 's' : ''}
        </span>
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
      <td style={{ textAlign: 'center' }} data-label="Deployment">
        {reqName ? <span className="pill pill-blue">{reqName}</span> : <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>}
      </td>
      <td style={{ textAlign: 'center', background: '#f8faff' }} data-label="Finalized Deployment">
        <select
          value={row.deployed_dept_id || ''}
          onChange={e => handlers.setDeployedDept(key, e.target.value)}
          disabled={!row.consent_given}
          className={row.deployed_dept_id ? 'select assigned' : 'select'}
          style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', minWidth: 160, ...(overridden ? { background: '#fffbeb', borderColor: '#fcd34d', fontWeight: 700, color: '#b45309' } : row.deployed_dept_id ? { background: '#ecfdf5', borderColor: '#a7f3d0', fontWeight: 700, color: '#047857' } : {}) }}
          title={!row.consent_given ? 'Consent not given — cannot assign' : noRequest ? 'No department was requested — assign one directly' : overridden ? 'Finalized deployment differs from the deployment request' : 'Defaults to the deployment request — change only if needed'}
        >
          <option value="">{!row.consent_given ? 'Not requested' : '— Not assigned —'}</option>
          {depts.map(d => <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ' (inactive)'}</option>)}
        </select>
        {overridden && <span className="pill pill-amber" style={{ fontSize: '0.6rem', marginLeft: '0.35rem', verticalAlign: 'middle' }}>CHANGED</span>}
      </td>
    </tr>
  )
})

export default function DeploymentAllocationPage({ schedules, scheduleId }) {
  const toast = useToast()
  const selectedScheduleId = scheduleId

  const [depts, setDepts] = useState([])
  const [centres, setCentres] = useState([])
  const [allocations, setAllocations] = useState([])
  const [rows, setRows] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const [editMode, setEditMode] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  // mobile CSS (≤640px) turns the table into block cards with no internal
  // scrollbar — virtualization must be off there or rows beyond the first
  // slice would never render
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  const loadedRef = useRef(false)
  const dirtyRef = useRef(false)
  const saveTimer = useRef(null)
  const saveAllRef = useRef(null)
  const flushRef = useRef(null)
  const editVersionRef = useRef(0)
  const scheduleIdRef = useRef(null)
  const liveRef = useRef({})
  const pendingSaveRef = useRef(null)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  liveRef.current = { scheduleId: selectedScheduleId, rows }
  const savedDeployedRef = useRef({})
  const existingConsentRef = useRef({})
  const savedConsentRef = useRef({})
  const reloadTimer = useRef(null)
  const lastSaveAtRef = useRef(0)
  // failed-save retry — a transient error re-arms one more save (max 3 tries)
  const retryTimer = useRef(null)
  const retryCountRef = useRef(0)
  const tableWrapRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  // handlers is memoized on stable deps, so read the dept-name lookup via a
  // ref to avoid a stale closure (and a use-before-init reference)
  const deptNameRef = useRef(() => null)

  const loadData = useCallback(async () => {
    if (!selectedScheduleId) return
    setLoading(true)
    // Capture in-flight edits before the fetch (they belong to the schedule that
    // was last loaded — scheduleIdRef.current).
    const prevLoadedSchedule = scheduleIdRef.current
    const prevRows = liveRef.current.rows
    const prevDirty = dirtyRef.current
    try {
      const [sewRes, vssRes, consRes, deptRes, deployRes, centreRes, allocRes] = await Promise.all([
        supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, badge_status').or(notElderlyFilter()).order('sewadar_name'),
        supabase.from('vss_sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, is_active, badge_status').order('sewadar_name'),
        supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('deployment_departments').select('*').order('name'),
        supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('centres').select('name, parent_centre').order('name'),
        supabase.from('centre_allocations').select('department_id, centre, max_count').eq('schedule_id', selectedScheduleId),
      ])

      // Abort if any query failed — empty rows here would reset the save
      // baseline and could let a later save clobber real consent data.
      const failed = [sewRes, vssRes, consRes, deptRes, deployRes, centreRes, allocRes].find(r => r?.error)
      if (failed) throw failed.error

      const sewadars = [...(sewRes.data || []), ...(vssRes.data || [])]
      const consentMap = {}
      ;(consRes.data || []).forEach(c => { consentMap[`${c.centre}|${c.badge_number}`] = c })
      const deployMap = {}
      ;(deployRes.data || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d })

      // Schedule switch: a save triggered by the switch flush may still be in
      // flight (or queued). Let it settle while scheduleIdRef still points at
      // the previous schedule, then re-save whatever is still unsaved to it —
      // the reset below must not invalidate that queued save. Runs BEFORE the
      // map loop below rebuilds savedDeployedRef / existingConsentRef, which
      // saveAll still needs from the previous schedule.
      if (prevLoadedSchedule && prevLoadedSchedule !== selectedScheduleId && prevDirty) {
        let guard = 0
        while (savingRef.current && guard < 100) {
          await new Promise(r => setTimeout(r, 50))
          guard++
        }
        if (savingRef.current) {
          // A save hung past the 5s drain — fail loudly instead of silently
          // resetting away the previous schedule's unsaved edits.
          toast.error('Saving is still in progress — some edits may not have been saved before switching schedules.')
        } else if (dirtyRef.current) {
          await saveAllRef.current({ scheduleId: prevLoadedSchedule, rows: prevRows })
        }
      }

      const deptNameById = {}
      ;(deptRes.data || []).forEach(d => { deptNameById[d.id] = d.name })
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
          // days are auto-set by the FINAL deployed department: 5 by default, 3 for OE ESCORTS
          available_days_count: daysForDept(deptNameById[dep?.deployed_department_id || dep?.department_id]),
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
      // Baseline the consent snapshot on the freshly-loaded rows so a save
      // only writes rows whose editable fields actually changed (the page used
      // to upsert every consented row on every save — thousands of writes).
      savedConsentRef.current = buildConsentSnapshot(map)
      setRows(map)
      setDepts(deptRes.data || [])
      setCentres(centreRes.data || [])
      setAllocations(allocRes.data || [])
      dirtyRef.current = false
      editVersionRef.current = 0
      loadedRef.current = true
      scheduleIdRef.current = selectedScheduleId
      // Reset the UI filters only on an actual schedule switch — a realtime
      // refresh of the SAME schedule must not wipe the ASO's filter/search/
      // edit-mode state mid-work.
      if (prevLoadedSchedule !== selectedScheduleId) {
        setFilterCentre('all')
        setFilterStatus('all')
        setSearch('')
        setEditMode(false)
      }
    } catch (err) {
      // A failed refresh must not look like a successful load — keep the
      // previous rows and any unsaved edits, and tell the user why.
      console.error('Failed to load allocation data:', err)
      toast.error(err?.message || 'Failed to load data — check your connection')
      if (!prevDirty) dirtyRef.current = false
    } finally { setLoading(false) }
  }, [selectedScheduleId, toast])

  useEffect(() => { loadData() }, [loadData])

  // realtime: refresh if a centre request changes while we're viewing.
  // Coalesced (500ms) so a burst of changes (e.g. a centre bulk-assign) causes
  // one reload instead of dozens; also suppressed right after our own save
  // (the batched deployment updates each fire a realtime event).
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    const scheduleReload = () => {
      if (!mounted || dirtyRef.current || savingRef.current) return
      if (Date.now() - lastSaveAtRef.current < 1200) return
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
      reloadTimer.current = setTimeout(() => { if (mounted) loadData() }, 500)
    }
    const channel = supabase
      .channel(`deploy-alloc-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .subscribe()
    return () => {
      mounted = false
      supabase.removeChannel(channel)
      if (reloadTimer.current) { clearTimeout(reloadTimer.current); reloadTimer.current = null }
    }
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

  // Centre-hierarchy order for the flat table: CENTREs (roots) A–Z, then each
  // CENTRE's SC_SPs A–Z, then the next CENTRE — so rows read grouped the same
  // way the old per-centre accordion did, with the centre column in between.
  const centreOrder = useMemo(() => {
    const rootOf = {}
    ;(centres || []).forEach(c => { rootOf[c.name] = getRootCentre(centres, c.name) || c.name })
    return (a, b) => {
      const ra = rootOf[a] || a
      const rb = rootOf[b] || b
      if (ra !== rb) return ra.localeCompare(rb)
      const aRoot = ra === a
      const bRoot = rb === b
      if (aRoot !== bRoot) return aRoot ? -1 : 1
      return a.localeCompare(b)
    }
  }, [centres])

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
        : { ...prev[key], consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: DEFAULT_AVAILABLE_DAYS, deployed_dept_id: null },
      }))
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
      setRows(prev => {
        const next = { ...prev[key], deployed_dept_id: deptId || null }
        // days follow the FINAL department (5 by default, 3 for OE ESCORTS);
        // when the final dept is cleared, fall back to the requested one
        next.available_days_count = daysForDept(deptId ? deptNameRef.current(deptId) : deptNameRef.current(prev[key]?.requested_dept_id))
        return { ...prev, [key]: next }
      })
    },
  }), [markDirty])

  // Schedule a retry of the latest snapshot after a failed save (network blips,
  // RLS hiccups). Stops after 3 attempts so a persistent error doesn't loop.
  const scheduleRetry = useCallback(() => {
    if (retryCountRef.current >= 3) return
    retryCountRef.current++
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      if (!mountedRef.current) return
      const snap = liveRef.current
      if (snap?.scheduleId && dirtyRef.current && scheduleIdRef.current === snap.scheduleId) {
        saveAllRef.current(snap)
      }
    }, 3000)
  }, [])

  const saveAll = useCallback(async (snap) => {
    const s = snap || liveRef.current
    if (!s?.scheduleId) return
    if (scheduleIdRef.current !== s.scheduleId) return
    if (savingRef.current) { pendingSaveRef.current = s; return }
    savingRef.current = true
    setSaving(true)
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    const versionAtStart = editVersionRef.current
    try {
      const entries = Object.values(s.rows)

      // consent upserts — DIFF-ONLY: only rows whose editable signature changed
      // since the last save are written (the page used to upsert every
      // consented row on every save — thousands of writes per keystroke).
      // Rows the finalizer just consented are included via the existing-row
      // check; everyone else stays untouched.
      const toUpsert = changedConsentRows(s.rows, savedConsentRef.current)
        .filter(r => r.consent_given || existingConsentRef.current[r.centre + '|' + r.badge_number])
        .map(r => ({
          schedule_id: s.scheduleId,
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
        if (error) { toast.error(error.message); dirtyRef.current = true; scheduleRetry(); return }
        // rows the finalizer just consented now EXIST in the DB — a same-session
        // toggle back to "no" must still be persisted (the existing-row check)
        toUpsert.forEach(u => { existingConsentRef.current[`${u.centre}|${u.badge_number}`] = true })
      }

      // ── deployment rows: three cases ──
      //   1) awaiting sewadars (consented, no deployment row yet) that the ASO
      //      just assigned a final dept to → INSERT the deployment row
      //   2) existing rows whose final dept changed → batched UPDATE
      //   3) consent flipped to "no" (or a legacy no-consent row with a leftover
      //      deployment) → DELETE the row, matching centre-page semantics
      const CHUNK = 250
      const toInsert = entries.filter(r => r.consent_given && !r.deployment_id && r.deployed_dept_id)
      const toDelete = entries.filter(r => !r.consent_given && r.deployment_id)
      const deleteKeys = new Set(toDelete.map(r => `${r.centre}|${r.badge_number}`))
      const toUpdate = entries.filter(r =>
        r.deployment_id
        && !deleteKeys.has(`${r.centre}|${r.badge_number}`)
        && savedDeployedRef.current[r.centre + '|' + r.badge_number] !== r.deployed_dept_id
      )

      if (toInsert.length > 0) {
        // upsert (not insert) so a retry after an ambiguous network failure is
        // idempotent — the row may already exist from the first attempt
        const { data: inserted, error } = await supabase.from('deployments')
          .upsert(toInsert.map(r => ({
            schedule_id: s.scheduleId,
            department_id: r.deployed_dept_id,
            deployed_department_id: r.deployed_dept_id,
            centre: r.centre,
            badge_number: r.badge_number,
            sewadar_name: r.sewadar_name,
            status: 'requested',
          })), { onConflict: 'schedule_id,centre,badge_number' })
          .select('id, centre, badge_number, department_id, deployed_department_id')
        if (error) { toast.error(error.message); dirtyRef.current = true; scheduleRetry(); return }
        // keep local rows + baseline in sync so a follow-up edit in the same
        // session updates (not re-inserts) the freshly-created row
        ;(inserted || []).forEach(rec => {
          const key = `${rec.centre}|${rec.badge_number}`
          savedDeployedRef.current[key] = rec.deployed_department_id || rec.department_id || null
          setRows(prev => prev[key]
            ? { ...prev, [key]: { ...prev[key], deployment_id: rec.id, requested_dept_id: rec.department_id } }
            : prev)
        })
      }

      const idsByDept = {}
      toUpdate.forEach(r => {
        const key = r.deployed_dept_id || '__null__'
        ;(idsByDept[key] = idsByDept[key] || []).push(r.deployment_id)
      })
      const ops = []
      Object.entries(idsByDept).forEach(([dept, ids]) => {
        const value = { deployed_department_id: dept === '__null__' ? null : dept }
        for (let i = 0; i < ids.length; i += CHUNK) {
          ops.push(supabase.from('deployments').update(value).in('id', ids.slice(i, i + CHUNK)))
        }
      })
      const results = await Promise.all(ops)
      for (const res of results) if (res.error) { toast.error(res.error.message); dirtyRef.current = true; scheduleRetry(); return }

      if (toDelete.length > 0) {
        const delOps = []
        for (let i = 0; i < toDelete.length; i += CHUNK) {
          delOps.push(supabase.from('deployments').delete().in('id', toDelete.slice(i, i + CHUNK).map(r => r.deployment_id)))
        }
        const delResults = await Promise.all(delOps)
        for (const res of delResults) if (res.error) { toast.error(res.error.message); dirtyRef.current = true; scheduleRetry(); return }
        toDelete.forEach(r => {
          const key = `${r.centre}|${r.badge_number}`
          savedDeployedRef.current[key] = null
          setRows(prev => prev[key]
            ? { ...prev, [key]: { ...prev[key], deployment_id: null, requested_dept_id: '', deployed_dept_id: null, available_days_count: DEFAULT_AVAILABLE_DAYS } }
            : prev)
        })
      }

      if (editVersionRef.current === versionAtStart) {
        dirtyRef.current = false
        retryCountRef.current = 0
      }
      // The schedule may have changed while this save was in flight — don't
      // clobber the newly loaded schedule's deployed-department baseline.
      if (scheduleIdRef.current === s.scheduleId) {
        toUpdate.forEach(r => { savedDeployedRef.current[r.centre + '|' + r.badge_number] = r.deployed_dept_id })
        savedConsentRef.current = buildConsentSnapshot(s.rows)
        lastSaveAtRef.current = Date.now()
        setSavedAt(new Date())
      }
    } catch (err) { toast.error(err.message); dirtyRef.current = true; scheduleRetry() } finally {
      savingRef.current = false
      setSaving(false)
      // If a newer snapshot was queued while this save was in flight, save it
      // now — otherwise those edits would be dropped silently.
      if (pendingSaveRef.current) {
        const next = pendingSaveRef.current
        pendingSaveRef.current = null
        saveAll(next)
      }
    }
  }, [toast, scheduleRetry])

  saveAllRef.current = saveAll

  const flushPending = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!loadedRef.current || !dirtyRef.current) return
    const snap = pendingSaveRef.current || liveRef.current
    pendingSaveRef.current = null
    saveAll(snap)
  }, [saveAll])
  flushRef.current = flushPending

  // explicit “Save Draft” — flush whatever is pending right now instead of
  // waiting for the 800ms debounce
  const saveDraft = () => {
    if (!loadedRef.current) return
    if (dirtyRef.current) {
      flushRef.current && flushRef.current()
    } else {
      toast.info('No pending changes — everything is already saved')
    }
  }

  // Schedule switch: save the OLD schedule's pending edits before its rows
  // are replaced by the new schedule's load (previously they were dropped).
  useEffect(() => {
    return () => { flushRef.current && flushRef.current() }
  }, [selectedScheduleId])

  // Unmount (tab switch / logout): flush instead of dropping unsaved edits.
  useEffect(() => () => { flushRef.current && flushRef.current() }, [])
  // Unmount: never fire a queued retry after the component is gone.
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current) }, [])

  // Warn before closing/reloading the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (dirtyRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // drop pending autosave when schedule changes
  useEffect(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [selectedScheduleId])

  useEffect(() => {
    // During a schedule switch the loaded schedule still differs from the
    // selected one — don't re-arm a debounce whose snapshot would pair the NEW
    // schedule id with the OLD rows (that used to write A's rows to B).
    if (!loadedRef.current || !dirtyRef.current) return
    if (scheduleIdRef.current !== selectedScheduleId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSaveRef.current = { scheduleId: selectedScheduleId, rows }
    saveTimer.current = setTimeout(() => {
      const snap = pendingSaveRef.current
      pendingSaveRef.current = null
      saveAll(snap)
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [rows, selectedScheduleId, saveAll])

  // ── derived stats & visible rows (memoized) ──
  const all = useMemo(() => Object.values(rows), [rows])
  const requestedAll = useMemo(() => all.filter(r => r.requested_dept_id).length, [all])
  const deployedAll = useMemo(() => all.filter(r => r.deployed_dept_id).length, [all])
  const overriddenAll = useMemo(() => all.filter(r => r.requested_dept_id && r.deployed_dept_id && r.deployed_dept_id !== r.requested_dept_id).length, [all])
  const awaitingAll = useMemo(() => all.filter(r => r.consent_given && !r.requested_dept_id).length, [all])
  const statusChips = useMemo(() => [
    { key: 'all', label: 'All', count: all.length },
    { key: 'requested', label: 'Deployment', count: requestedAll },
    { key: 'deployed', label: 'Finalized', count: deployedAll },
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
    }).sort((a, b) => {
      // group by CENTRE (root) first, SC_SPs under their CENTRE, name within centre
      const c = centreOrder(a.centre, b.centre)
      if (c !== 0) return c
      return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
    })
  }, [all, filterCentre, filterStatus, search, centreOrder])

  const byCentre = useMemo(() => {
    const m = {}
    visible.forEach(r => {
      if (!m[r.centre]) m[r.centre] = []
      m[r.centre].push(r)
    })
    return m
  }, [visible])
  const centreNames = useMemo(() => Object.keys(byCentre).sort((a, b) => a.localeCompare(b)), [byCentre])

  // ── virtual scrolling: the flat table can hold 2000+ rows; rendering all of
  // them as DOM nodes is what made the page freeze. Render only the slice in
  // view (plus a small overscan), with spacer rows keeping the scrollbar sane.
  const OVERSCAN = 12
  const vh = viewH || 600
  const totalRows = visible.length
  // clamp startIdx so a deep scrollTop into a shorter filtered list (or a
  // rounding edge at the very bottom) can never produce an empty slice
  const maxStart = Math.max(0, totalRows - 1)
  const startIdx = isMobile ? 0 : Math.min(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN), maxStart)
  const endIdx = isMobile ? totalRows : Math.min(totalRows, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN)
  const visibleSlice = isMobile ? visible : visible.slice(startIdx, endIdx)

  // jump back to the top whenever the filtered set changes (a stale scrollTop
  // into a shorter list would otherwise land on spacer-only rows). Reset the
  // DOM scrollbar too — state alone relies on browser scroll-anchoring.
  useEffect(() => {
    setScrollTop(0)
    if (tableWrapRef.current) tableWrapRef.current.scrollTop = 0
  }, [filterCentre, filterStatus, search, selectedScheduleId])

  // measure the scroll viewport once the table mounts / data loads so the
  // initial virtual window matches what's actually visible (before any scroll)
  useEffect(() => {
    if (loading || !tableWrapRef.current) return
    setViewH(tableWrapRef.current.clientHeight || 600)
  }, [loading, visible.length])

  // reuse for Excel + quota: only rows that have a deployment record can be overwritten
  const deptNameOf = useCallback((id) => deptMap.get(id)?.name || null, [deptMap])
  deptNameRef.current = deptNameOf

  // Quota visibility for the ASO: per department, assigned vs max within the
  // current filter scope (one CENTRE or all centres). Quota is enforced by the
  // DB (v17) — this strip makes an over-quota assignment visible BEFORE saving.
  const quotaStrip = useMemo(() => {
    const rootOfFilter = filterCentre === 'all' ? null : getRootCentre(centres, filterCentre)
    const used = {}
    all.forEach(r => {
      if (rootOfFilter !== null && getRootCentre(centres, r.centre) !== rootOfFilter) return
      const d = r.deployed_dept_id || r.requested_dept_id
      if (d) used[d] = (used[d] || 0) + 1
    })
    const max = {}
    ;(allocations || []).forEach(a => {
      if (rootOfFilter !== null && a.centre !== rootOfFilter) return
      max[a.department_id] = (max[a.department_id] || 0) + a.max_count
    })
    return Object.entries(max)
      .filter(([, m]) => m > 0)
      .map(([deptId, m]) => ({ deptId, name: deptMap.get(deptId)?.name || deptId, used: used[deptId] || 0, max: m }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, allocations, filterCentre, centres, deptMap])

  // ── Excel export ──
  const exportExcel = useCallback(async () => {
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      const XLSX = await import('xlsx') // lazy — keeps xlsx (~400 kB) out of the main bundle
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
        'Deployment': deptNameOf(r.requested_dept_id) || (r.requested_dept_id ? '—' : ''),
        'Finalized Deployment': deptNameOf(r.deployed_dept_id) || deptNameOf(r.requested_dept_id) || '',
        'Assignment Status': autoAssigned ? 'Auto (deployment)' : overridden ? 'Overridden' : (r.consent_given ? 'Not assigned' : 'No consent'),
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
          'CENTRE': centre,
          'Department': name,
          'Requested': counts.requested,
          'Deployed (assigned)': counts.deployed,
          'Unassigned': Math.max(counts.requested - counts.deployed, 0),
        })
      })
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Department Summary')

    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}_finalize_deployment.xlsx`)
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }, [visible, deptNameOf, schedule, toast])

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><ClipboardCheck size={22} /> Finalize Deployment</h2>
          <div className="page-sub">Set the Finalized Deployment · ASO / Super Admin · defaults to each sewadar's request</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {saving ? <span className="pill pill-amber"><Save size={12} /> Saving...</span> : savedAt ? <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span> : null}
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', padding: '0.3rem 0.6rem', borderRadius: 8, background: editMode ? '#eef2ff' : '#f1f5f9', border: `1px solid ${editMode ? '#c7d2fe' : '#e2e8f0'}` }}>
              <input type="checkbox" checked={editMode} onChange={e => setEditMode(e.target.checked)} style={{ accentColor: '#6366f1' }} />
              {editMode ? <Pencil size={13} style={{ color: '#4f46e5' }} /> : <Lock size={13} style={{ color: '#94a3b8' }} />}
              Enable editing
            </label>
            <button onClick={saveDraft} className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Save size={13} /> Save Draft
            </button>
            <button onClick={exportExcel} disabled={exporting} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>
      </div>


      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Sewadars</div>
          <div className="stat-value">{all.length}</div>
          <div className="stat-sub">across {new Set(all.map(r => r.centre)).size} centres</div>
        </div>
        <div className="stat">
          <div className="stat-label">Deployment</div>
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

      {quotaStrip.length > 0 && (
        <div className="card" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 800, fontSize: '0.8rem', color: '#475569', marginRight: '0.35rem' }}>
              {filterCentre === 'all' ? 'All centres' : filterCentre} — quota
            </span>
            {quotaStrip.map(s => {
              const over = s.used > s.max
              const full = !over && s.used >= s.max
              return (
                <span
                  key={s.deptId}
                  className={`pill ${over ? 'pill-red' : full ? 'pill-amber' : 'pill-gray'}`}
                  style={{ fontSize: '0.72rem' }}
                  title={over ? `Over allocated quota — the server rejects new assignments (${s.used} of ${s.max})` : `${s.used} of ${s.max} assigned`}
                >
                  {s.name} <b>{s.used}</b>/{s.max}{over ? ' ⚠' : ''}
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div className="section-title">Sewadar-wise allocation</div>
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
          /* fieldset lets editMode disable every control in one attribute —
             rows never have to re-render on toggle */
          <fieldset disabled={!editMode} style={{ border: 'none', padding: 0, margin: 0 }}>
            <div
              ref={tableWrapRef}
              className="table-wrap table-wrap-sticky"
              onScroll={e => { setScrollTop(e.currentTarget.scrollTop); if (e.currentTarget.clientHeight) setViewH(e.currentTarget.clientHeight) }}
            >
              <table className="table table-sticky">
                <thead>
                  <tr>
                    <th style={{ width: 40, textAlign: 'center' }}>S.No.</th>
                    <th>Centre</th>
                    <th>Badge</th>
                    <th>Name</th>
                    <th style={{ textAlign: 'center' }}>Consent</th>
                    <th style={{ textAlign: 'center' }}>Days</th>
                    <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                    <th style={{ textAlign: 'center' }}>Chair Pass</th>
                    <th style={{ textAlign: 'center' }}>Deployment</th>
                    <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Finalized Deployment</th>
                  </tr>
                </thead>
                <tbody>
                  {startIdx > 0 && (
                    <tr aria-hidden="true" style={{ height: startIdx * ROW_H }}>
                      <td colSpan={10} style={{ padding: 0, border: 'none', height: startIdx * ROW_H }} />
                    </tr>
                  )}
                  {visibleSlice.map((r, i) => (
                    <DeployRow
                      key={`${r.centre}|${r.badge_number}`}
                      row={r}
                      serial={startIdx + i + 1}
                      depts={depts}
                      deptNames={deptNames}
                      handlers={handlers}
                    />
                  ))}
                  {endIdx < totalRows && (
                    <tr aria-hidden="true" style={{ height: (totalRows - endIdx) * ROW_H }}>
                      <td colSpan={10} style={{ padding: 0, border: 'none', height: (totalRows - endIdx) * ROW_H }} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </fieldset>
        )}
      </div>
    </div>
  )
}