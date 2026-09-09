import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchSubtreeCentres, fetchAllRows, getRootCentre, fetchPortalSettings, fetchCentres, fetchVssOverrides } from '../lib/supabase'
import { computeDeptQuota, vssEligibilityReasons, isVssBadge, canEditDeployment, changedConsentRows, changedConsentFields, consentRowKey, consentRowSignature, buildConsentSnapshot, EDITABLE_CONSENT_FIELDS, DEFAULT_AVAILABLE_DAYS, isOeEscortsDept, daysForDept, isAssoDepartment, resolveVssOverride, effectiveVssCreation, effectiveVssDeployment } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import DeptDropdown from '../components/DeptDropdown'
import Tip from '../components/Tip'
import VssDashboard from '../components/VssDashboard'
import AddVssForm from '../components/AddVssForm'
import VssRoster from '../components/VssRoster'
import {
  Save, Lock, Unlock, CheckCircle2, Search, ClipboardCheck, ChevronDown, Users, AlertTriangle,
  CheckSquare, Star, UserPlus, Download,
} from 'lucide-react'

/* ─── VSS: dedicated tab. Inner tabs: Deployment (+ Add VSS, placeholder). ─── */
export default function VssPage({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  const isAso = profile?.role === 'aso' || profile?.role === 'super_admin'
  const [tab, setTab] = useState('deploy')
  // Add-VSS creation gate (v19 + v21): the ASO's master switch + deadline
  // window, UNLESS a Control Panel tri-state override forces it for this
  // centre. Re-checked every time the Add VSS tab opens.
  const [creationOpen, setCreationOpen] = useState(false)
  const [creationOverride, setCreationOverride] = useState(null)
  const schedule = schedules.find(s => s.id === scheduleId)
  // NULL deadline never blocks (deadline optional); done schedules close the window
  const windowOpen = !!schedule && schedule.status !== 'done' && (!schedule.deadline || new Date(schedule.deadline) > new Date())
  useEffect(() => {
    if (tab !== 'add') return
    const admin = isAso
    if (admin) {
      setCreationOpen(true)
      setCreationOverride(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const settings = await fetchPortalSettings()
        const globalOpen = !!settings.vss_creation_open
        let rawOverride = null
        if (profile?.centre) {
          // Primary: security-definer RPC returns raw tri-state directly (bypasses RLS)
          try {
            const { data, error } = await supabase.rpc('centre_vss_creation_override', { p_centre: profile.centre })
            if (!error && (data === true || data === false)) rawOverride = data
            else if (!error && data == null) rawOverride = null
          } catch (_e) { void _e }
          // Fallback for DBs without the RPC (pre-v21) or if RPC not yet deployed:
          // fetch via table + resolveVssOverride (may be blocked by RLS for centre_user)
          if (rawOverride == null) {
            try {
              const overrides = await fetchVssOverrides()
              const centres = await fetchCentres()
              const root = getRootCentre(centres, profile.centre) || profile.centre
              const v = resolveVssOverride(overrides, { rootCentre: root, key: 'creation_open' })
              if (v != null) rawOverride = v
            } catch (_e) { void _e }
          }
        }
        // Effective creation gate: override ?? (global && window) — mirrors DB guard
        let effective = effectiveVssCreation({ overrideValue: rawOverride, globalOpen, windowOpen })
        // Cross-check with get_my_effective_gates for schedule-specific window recomputation
        if (profile?.centre && scheduleId) {
          try {
            const { data: gates } = await supabase.rpc('get_my_effective_gates', { p_schedule: scheduleId })
            if (gates?.vss_creation_open != null) effective = !!gates.vss_creation_open
          } catch (_e) { void _e /* v21 not migrated — keep computed effective */ }
        }
        if (!cancelled) {
          setCreationOverride(rawOverride)
          setCreationOpen(effective || admin)
        }
      } catch (_e) {
        void _e
        if (!cancelled) {
          setCreationOverride(null)
          setCreationOpen(admin)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, windowOpen, scheduleId, isAso, profile?.centre])

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
      {tab === 'add'
        ? <AddVssForm creationOpen={creationOpen} windowOpen={windowOpen} creationOverride={creationOverride} />
        : tab === 'roster' ? <VssRoster /> : isAso ? <VssDashboard schedules={schedules} scheduleId={scheduleId} /> : <VssDeployTable schedules={schedules} scheduleId={scheduleId} />}
    </div>
  )
}

/* ─── VSS consent & deployment table (centre_user / centre_admin) ─── */
function VssDeployTable({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const myCentre = profile?.centre
  const isEditableRole = profile?.role === 'centre_user' || profile?.role === 'centre_admin'
  const selectedScheduleId = scheduleId

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
  const flushRef = useRef(null)
  const persistRef = useRef(null)
  const editVersionRef = useRef(0)
  const scheduleIdRef = useRef(null)
  const [subtree, setSubtree] = useState([])
  const [subtreeError, setSubtreeError] = useState(false)
  const [subtreeRetry, setSubtreeRetry] = useState(0)
  const [centres, setCentres] = useState([])
  const [filterCentre, setFilterCentre] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [expanded, setExpanded] = useState({})
  const [openDeptDropdown, setOpenDeptDropdown] = useState(null)
  const [openReasons, setOpenReasons] = useState(null)
  const [selected, setSelected] = useState({})
  const [pendingBulk, setPendingBulk] = useState(null)
  const [locked, setLocked] = useState(false)
  // v21 Control Panel: deployment specially opened for this centre
  const [overrideOpen, setOverrideOpen] = useState(false)
  // v21 undeployed-only override: opens deployment for VSS sewadars who have not
  // yet been assigned a department; already-deployed VSS stay locked.
  const [undeployedOverrideOpen, setUndeployedOverrideOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const myRoot = getRootCentre(centres, myCentre)

  useEffect(() => {
    if (!myCentre) return
    setSubtreeError(false)
    fetchSubtreeCentres(myCentre).then(({ centres, subtree }) => {
      setCentres(centres)
      setSubtree(subtree)
    }).catch(() => setSubtreeError(true))
  }, [myCentre, subtreeRetry])

  // v31 HARD VSS CLOSE: global is the master.
  // Before v31 a per-centre `true` (`centre_vss_overrides.deployment_open=true`)
  // could reopen VSS even after the super_admin globally closed
  // `portal_settings.vss_deployment_open`. User wants "disable everything in
  // VSS until its open" — hard gate: `effective = global && (override ?? true)`.
  // This loader computes the HARD effective locally (raw global + raw override)
  // so the UI is hard-closed even before the DB migration v31 is applied.
  // Generic `centre_overrides` (any_override_open) must NOT reopen VSS.
  const loadGates = useCallback(async () => {
    if (!selectedScheduleId || !myRoot) return
    try {
      // 1) Try the authoritative RPC first (now hard in v31)
      const { data: gates } = await supabase.rpc('get_my_effective_gates', { p_schedule: selectedScheduleId })
      // Keep generic flag at false — regular overrides never reopen VSS
      setOverrideOpen(false)
      setUndeployedOverrideOpen(!!gates?.undeployed_override_open)
      if (gates && typeof gates.vss_deployment_open === 'boolean') {
        // RPC already hard in v31, but cross-check locally for safety:
        // if RPC is stale / not yet migrated or realtime hasn't propagated,
        // the local hard gate is authoritative. Generic centre_overrides must
        // NOT reopen VSS (hard gate: global && (override ?? true)).
        try {
          const rawSettings = await fetchPortalSettings()
          const overrides = await fetchVssOverrides()
          const rawOverride = resolveVssOverride(overrides, { rootCentre: myRoot, key: 'deployment_open' })
          const localEffective = effectiveVssDeployment({ overrideValue: rawOverride, globalOpen: !!rawSettings.vss_deployment_open })
          setSettings(s => ({ ...s, vss_deployment_open: localEffective }))
        } catch {
          setSettings(s => ({ ...s, vss_deployment_open: !!gates.vss_deployment_open }))
        }
        return
      }
    } catch { /* RPC missing — fall back to local hard compute */ }
    // 2) Fallback hard compute: global && (override ?? true)
    try {
      const rawSettings = await fetchPortalSettings()
      const globalOpen = !!rawSettings.vss_deployment_open
      let rawOverride = null
      try {
        const overrides = await fetchVssOverrides()
        rawOverride = resolveVssOverride(overrides, { rootCentre: myRoot, key: 'deployment_open' })
      } catch { /* RLS or missing — keep null */ }
      const hardEffective = effectiveVssDeployment({ overrideValue: rawOverride, globalOpen })
      setSettings(s => ({ ...s, vss_deployment_open: hardEffective }))
    } catch {
      // Last resort: raw global only
      try {
        const raw = await fetchPortalSettings()
        setSettings(s => ({ ...s, vss_deployment_open: !!raw.vss_deployment_open }))
      } catch { /* keep previous */ }
    }
  }, [selectedScheduleId, myRoot])

  useEffect(() => {
    fetchPortalSettings()
      .then(setSettings)
      .then(loadGates)
      .catch(() => {})
  }, [loadGates])

  const loadData = useCallback(async () => {
    if (!selectedScheduleId || !subtree.length) return
    setLoading(true)
    // the lock is per schedule — never carry a previous schedule's lock state
    // over while the new schedule's lock is being fetched
    setLocked(false)
    // Capture in-flight edits before the fetch. They belong to the schedule that
    // was last loaded (scheduleIdRef.current). A refresh of the SAME schedule
    // overlays them on the fresh rows so a reload never discards unsaved work; a
    // schedule switch saves the previous schedule's leftovers before the reset.
    const prevLoadedSchedule = scheduleIdRef.current
    const prevRows = liveRef.current.rows
    const prevDirty = dirtyRef.current
    try {
      // Supabase max-rows=1000 — paginate every table that can exceed it
      const [vssAll, consAll, deptAll, allocAll, deployAll] = await Promise.all([
        fetchAllRows('vss_sewadars', 'badge_number, sewadar_name, gender, is_initiated, is_active, remarks, centre', (q) => q.in('centre', subtree).order('sewadar_name')),
        fetchAllRows('sewadar_consents', '*', (q) => q.eq('schedule_id', selectedScheduleId).in('centre', subtree)),
        fetchAllRows('deployment_departments', '*', (q) => q.eq('is_active', true).order('name')),
        fetchAllRows('centre_allocations', '*', (q) => q.eq('schedule_id', selectedScheduleId)),
        fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', selectedScheduleId).in('centre', subtree)),
      ])

      const vss = vssAll || []
      const existing = consAll || []
      const map = {}
      existing.forEach(c => { map[`${c.centre}|${c.badge_number}`] = c })
      // which VSS sewadars really have a consent row persisted — the deploy
      // guarantee below needs this, and it must survive every load path
      consentExistsRef.current = new Set(existing.map(c => `${c.centre}|${c.badge_number}`))
      const deployMap = {}
      // keep the whole deployment row so the page knows which sewadars the ASO
      // has FINALIZED — those rows are locked on the centre side
      ;(deployAll || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d })
      const rows = {}
      const deptNameById = {}
      ;(deptAll || []).forEach(d => { deptNameById[d.id] = d.name })
      // days as stored in the DB — the save baseline must use these so legacy
      // values that differ from the auto-set rule get corrected on first save
      const storedDays = {}
      const autoSetDays = (r) => {
        // Available days are NOT user-editable: every department defaults to 5,
        // except OE ESCORTS which is fixed at 3. Enforce on load — this also
        // fixes rows whose stored value predates the rule.
        r.available_days_count = daysForDept(deptNameById[r.requested_dept])
        return r
      }
      vss.forEach(sw => {
        const key = `${sw.centre}|${sw.badge_number}`
        const ex = map[key]
        storedDays[key] = ex?.available_days_count ?? DEFAULT_AVAILABLE_DAYS
        rows[key] = autoSetDays({
          centre: sw.centre,
          badge_number: sw.badge_number,
          sewadar_name: sw.sewadar_name,
          gender: sw.gender || '',
          is_initiated: !!sw.is_initiated,
          is_active: sw.is_active !== false,
          remarks: sw.remarks || '',
          consent_given: ex?.consent_given ?? false,
          available_days_count: storedDays[key],
          stay_at_bhati: ex?.stay_at_bhati || false,
          chair_pass: false,
          requested_dept: deployMap[key]?.department_id || '',
          finalized: !!deployMap[key]?.deployed_department_id,
          final_dept: deployMap[key]?.deployed_department_id || '',
        })
      })

      // Same-schedule refresh: keep unsaved edits on top of the fresh rows
      // instead of wiping them along with the baseline reset below.
      if (prevLoadedSchedule === selectedScheduleId && prevDirty) {
        const editsByKey = {}
        changedConsentRows(prevRows, savedConsentRef.current).forEach(r => {
          editsByKey[`${r.centre}|${r.badge_number}`] = r
        })
        if (Object.keys(editsByKey).length > 0) {
          // overlay ONLY user-editable fields — fresh rows keep server-side
          // values for read-only data (is_active, is_initiated, gender, etc.)
          const dropped = []
          Object.keys(rows).forEach(key => {
            const edit = editsByKey[key]
            if (!edit) return
            // the ASO finalized this row mid-refresh — the edit is moot (the
            // row is locked centre-side) and persist would silently filter it
            // while the UI kept showing it as saved; drop it loudly instead
            if (rows[key].finalized) { dropped.push(key); return }
            EDITABLE_CONSENT_FIELDS.forEach(f => { if (f in edit) rows[key][f] = edit[f] })
            // even after the overlay, days stay auto-set (5 / 3 for OE ESCORTS)
            rows[key] = autoSetDays(rows[key])
          })
          setConsentRows(rows)
          setDepts(deptAll || [])
          setAllocations(allocAll || [])
          setDeployments(deployAll || [])
          loadedRef.current = true
          scheduleIdRef.current = selectedScheduleId
          const ex = {}
          subtree.forEach(c => { ex[c] = true })
          setExpanded(ex)
          if (dropped.length > 0) {
            // baseline the dropped rows at their fresh (finalized) state so
            // they no longer count as pending changes
            const nextBaseline = { ...savedConsentRef.current }
            dropped.forEach(k => { nextBaseline[k] = consentRowSignature(rows[k]) })
            savedConsentRef.current = nextBaseline
            dirtyRef.current = changedConsentRows(rows, savedConsentRef.current).length > 0
            toast.info(`${dropped.length} sewadar${dropped.length > 1 ? 's' : ''} finalized by the ASO — pending edits discarded`)
          }
          // Baseline-sync untouched rows: every row this session did NOT edit
          // is now at its fresh server state, so peer changes stop counting as
          // OUR pending edits (previously the whole baseline stayed stale and
          // the next save re-wrote peer edits as if they were ours).
          const pendingKeys = new Set(Object.keys(editsByKey))
          const freshSnap = buildConsentSnapshot(rows)
          const nextBaseline = { ...savedConsentRef.current }
          Object.keys(freshSnap).forEach(k => {
            if (pendingKeys.has(k)) return
            nextBaseline[k] = freshSnap[k]
          })
          savedConsentRef.current = nextBaseline
          dirtyRef.current = changedConsentRows(rows, savedConsentRef.current).length > 0
          // the remaining (non-dropped) edits stay pending — dirtyRef /
          // savedConsentRef / editVersionRef keep their pre-refresh state so
          // the debounce persists them next.
          return
        }
      }

      // Schedule switch: a save triggered by the switch flush may still be in
      // flight (or queued). Let it settle while scheduleIdRef still points at
      // the previous schedule, then re-save whatever is still unsaved to it —
      // the reset below must not invalidate that queued save.
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
          await persistRef.current({
            scheduleId: prevLoadedSchedule,
            rows: prevRows,
            deployments: liveRef.current.deployments,
            depts: liveRef.current.depts,
            subtree: liveRef.current.subtree,
          })
        }
      }

      setConsentRows(rows)
      setDepts(deptAll || [])
      setAllocations(allocAll || [])
      setDeployments(deployAll || [])
      // Baseline the snapshot on the DB-stored days: rows whose days were
      // auto-corrected on load (legacy values ≠ the 5/3 rule) are flagged as
      // changed so the first save fixes them, keeping UI + DB in sync.
      const baseline = {}
      Object.keys(rows).forEach(k => {
        baseline[k] = storedDays[k] !== rows[k].available_days_count
          ? { ...rows[k], available_days_count: storedDays[k] }
          : rows[k]
      })
      savedConsentRef.current = buildConsentSnapshot(baseline)
      dirtyRef.current = Object.keys(rows).some(k => rows[k].available_days_count !== storedDays[k])
      editVersionRef.current = 0
      loadedRef.current = true
      scheduleIdRef.current = selectedScheduleId
      const ex = {}
      subtree.forEach(c => { ex[c] = true })
      setExpanded(ex)

      // Centre deployment lock (v13) — non-fatal: if the migration hasn't run,
      // the page still loads fine with the lock off.
      try {
        const { data: lockRow } = await supabase.from('centre_locks')
          .select('*').eq('schedule_id', selectedScheduleId).eq('centre', myRoot).maybeSingle()
        setLocked(!!lockRow)
      } catch { /* table missing — lock stays off until migrated */ }
      await loadGates()
    } catch (err) {
      console.error('Failed to load VSS consent data:', err)
      toast.error(err?.message || 'Failed to load data — check your connection')
      // a failed refresh must not pretend in-flight edits were saved
      if (!prevDirty) dirtyRef.current = false
    } finally { setLoading(false) }
  }, [selectedScheduleId, subtree, myRoot, toast, loadGates])

  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData

  useEffect(() => { loadData() }, [loadData])

  // Escape closes the bulk-confirm modal
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setPendingBulk(null)
      setOpenDeptDropdown(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Realtime merge hygiene: peer VSS-user writes arrive as postgres_changes
  // events. Reloads are coalesced (one silent refresh per burst), skipped
  // briefly after OUR OWN saves (which echo back as events) and queued while
  // a save is in flight so a merge never fights the write in progress.
  const reloadTimerRef = useRef(null)
  const reloadQueuedRef = useRef(false)
  const lastWriteAtRef = useRef(0)
  useEffect(() => {
    if (!selectedScheduleId) return
    const reload = () => {
      if (Date.now() - lastWriteAtRef.current < 1500) return
      if (savingRef.current) { reloadQueuedRef.current = true; return }
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current)
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null
        loadData()
      }, 600)
    }
    const channel = supabase
      .channel(`vss-deploy-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).then(loadGates).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_vss_overrides' }, () => { loadGates() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_overrides', filter: `schedule_id=eq.${selectedScheduleId}` }, () => { loadGates() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_locks', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
      if (reloadTimerRef.current) { clearTimeout(reloadTimerRef.current); reloadTimerRef.current = null }
    }
  }, [selectedScheduleId, loadData, loadGates])

  const savedConsentRef = useRef({})
  const liveRef = useRef({})
  const pendingSaveRef = useRef(null)
  const savingRef = useRef(false)
  // live view of whether THIS schedule can be edited at all — persist skips
  // the DB round-trip when the page is read-only (deadline passed / done /
  // locked / master switch closed), because the DB rejects those writes anyway
  const editableRef = useRef(false)
  // Latest "any override open" flag, read inside the persist closure (which is
  // memoized without this dep) so an override can relax the consent-given
  // requirement when writing VSS deployment rows.
  const overrideOpenRef = useRef(false)
  // When an undeployed-only override is active, the DB freezes already-deployed
  // VSS sewadars — so persist must never write their consent/deployment rows.
  const undeployedOverrideOpenRef = useRef(false)
  // Keys of VSS sewadars that actually have a persisted consent row. The DB
  // requires the consent ROW to exist before ANY deployment (an override only
  // relaxes the consent=No check) — persist guarantees one before deploying.
  const consentExistsRef = useRef(new Set())
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  // failed-save retry — a transient error re-arms one more save (max 3 tries)
  const retryTimer = useRef(null)
  const retryCountRef = useRef(0)
  liveRef.current = { scheduleId: selectedScheduleId, rows: consentRows, deployments, depts, subtree }

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
        persistRef.current(snap)
      }
    }, 3000)
  }, [])

  const persist = useCallback(async (snap) => {
    if (!snap?.scheduleId) return
    if (scheduleIdRef.current !== snap.scheduleId) return
    // Read-only page (deadline passed / schedule done / centre locked / master
    // switch closed): the DB rejects these writes, so skip the round-trip —
    // otherwise a legacy-days normalization on load would spam error toasts.
    // Clear the dirty flag: nothing on this page is saveable.
    if (!editableRef.current) {
      dirtyRef.current = false
      retryCountRef.current = 0
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
      savingRef.current = false
      return
    }
    if (savingRef.current) { pendingSaveRef.current = snap; return }
    savingRef.current = true
    setSaving(true)
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    const versionAtStart = editVersionRef.current
    const { scheduleId, rows, deployments: depRows, depts: depList, subtree: sub } = snap
    try {
      const changed = changedConsentRows(rows, savedConsentRef.current)
      const deptNameById = {}
      depList.forEach(d => { deptNameById[d.id] = d.name })
      const undeployedOnly = undeployedOverrideOpenRef.current
      // Already-deployed VSS (a deployment row that already has a requested
      // department) are frozen at the DB. Detect that from the persisted
      // deployments, NOT from r.requested_dept (which is the intended NEW state —
      // a VSS being newly assigned must NOT be excluded).
      const alreadyDeployed = (r) => depRows.some(d => `${d.centre}|${d.badge_number}` === `${r.centre}|${r.badge_number}` && d.department_id != null)
      const toInsert = []
      const patchByFields = new Map() // fieldsKey -> { fields, keys: [] }
      // one source of truth for the consent-row payload — shared by the
      // new-row inserts and the deploy-existence guarantee below
      const consentPayload = (r) => ({
        schedule_id: scheduleId,
        centre: r.centre,
        badge_number: r.badge_number,
        sewadar_name: r.sewadar_name,
        consent_given: r.consent_given,
        available_days_count: r.consent_given
          ? daysForDept(deptNameById[r.requested_dept])
          : (overrideOpenRef.current && r.requested_dept ? daysForDept(deptNameById[r.requested_dept]) : null),
        stay_at_bhati: r.stay_at_bhati,
        chair_pass: r.chair_pass,
      })
      changed.forEach(r => {
        // ASO-finalized rows are locked on the centre side — never write them,
        // even from a pre-lock snapshot (debounce / unmount / switch flush).
        // Under an undeployed-only override, already-deployed VSS are frozen too.
        if (r.finalized || (undeployedOnly && alreadyDeployed(r))) return
        const key = consentRowKey(r)
        const candidate = consentPayload(r)
        const saved = savedConsentRef.current[key]
        if (!saved) { toInsert.push(candidate); return }
        const fields = changedConsentFields(candidate, saved)
        if (!fields) return
        const fkey = Object.keys(fields).sort().join(',')
        if (!patchByFields.has(fkey)) patchByFields.set(fkey, { fields, keys: [] })
        patchByFields.get(fkey).keys.push(key)
      })
      const activeDeptIds = new Set(depList.map(d => d.id))
      // Under a Control Panel override the consent-given requirement relaxes
      // (v21): a sewadar whose consent is No may still be deployed.
      const overrideDeploy = overrideOpenRef.current
      const toDeploy = changed
        .filter(r => !r.finalized && !(undeployedOnly && alreadyDeployed(r)) && r.requested_dept && r.is_active && activeDeptIds.has(r.requested_dept) && (r.consent_given || overrideDeploy))
        .map(r => ({
          schedule_id: scheduleId,
          department_id: r.requested_dept,
          centre: r.centre,
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name,
          status: 'requested',
        }))
      // finalized rows (the ASO set the final department) are NEVER removed —
      // deleting them would destroy the ASO's decision. While an override is open,
      // a consent=No row that HAS a requested dept is a deliberate deployment and
      // must be kept (the consent check is relaxed). Under an undeployed-only
      // override, already-deployed VSS are frozen and never removed.
      const toRemove = Object.values(rows)
        .filter(r => !r.finalized && !(undeployedOnly && alreadyDeployed(r)) && ((!r.requested_dept || !r.is_active || !activeDeptIds.has(r.requested_dept)) || (!r.consent_given && !overrideDeploy)))
        .map(consentRowKey)
        .filter(key => depRows.some(d => `${d.centre}|${d.badge_number}` === key))

      if (toInsert.length > 0) {
        // chunked: a big centre's first save can exceed PostgREST's row limit
        for (let i = 0; i < toInsert.length; i += 100) {
          const { error } = await supabase.from('sewadar_consents').upsert(toInsert.slice(i, i + 100), { onConflict: 'schedule_id,centre,badge_number' })
          if (error) {
            const m = error.message || ''
            if (m.includes('already deployed') || m.includes('consent is frozen') || m.includes('No consent recorded')) {
              toast.error(m)
              loadDataRef.current(true)
              return
            }
            toast.error(m); dirtyRef.current = true; scheduleRetry(); return
          }
        }
      }
      // partial per-field UPDATEs — one PATCH per identical field-set, matched
      // row-by-row via or=(and(...)) so only this centre's rows are touched
      for (const { fields, keys } of patchByFields.values()) {
        for (let i = 0; i < keys.length; i += 40) {
          const orFilter = keys.slice(i, i + 40).map(k => {
            const [centre, badge_number] = k.split('|')
            return `and(centre.eq."${centre}",badge_number.eq."${badge_number}")`
          }).join(',')
          const { error } = await supabase.from('sewadar_consents')
            .update(fields)
            .eq('schedule_id', scheduleId)
            .or(orFilter)
          if (error) {
            const m = error.message || ''
            if (m.includes('already deployed') || m.includes('consent is frozen') || m.includes('No consent recorded')) {
              toast.error(m)
              loadDataRef.current(true)
              return
            }
            toast.error(m); dirtyRef.current = true; scheduleRetry(); return
          }
        }
      }
      // The DB unconditionally requires a consent ROW before any deployment —
      // an override relaxes only the consent=No check. A VSS sewadar whose
      // consent row was never persisted cannot be deployed until its row
      // exists. Guarantee it here: INSERT with ignoreDuplicates so a row a
      // parallel session created moments ago is never overwritten.
      const ensureConsentRows = [...new Set(toDeploy.map(d => `${d.centre}|${d.badge_number}`))]
        .filter(key => !consentExistsRef.current.has(key))
        .map(key => rows[key])
        .filter(Boolean)
        .map(consentPayload)
      if (ensureConsentRows.length > 0) {
        for (let i = 0; i < ensureConsentRows.length; i += 100) {
          const { error } = await supabase.from('sewadar_consents')
            .upsert(ensureConsentRows.slice(i, i + 100), { onConflict: 'schedule_id,centre,badge_number', ignoreDuplicates: true })
          if (error) {
            const m = error.message || ''
            if (m.includes('already deployed') || m.includes('consent is frozen') || m.includes('No consent recorded')) {
              toast.error(m)
              loadDataRef.current(true)
              return
            }
            toast.error(m); dirtyRef.current = true; scheduleRetry(); return
          }
        }
        // rows are now guaranteed to exist — skip re-ensuring on the next save
        ensureConsentRows.forEach(p => consentExistsRef.current.add(`${p.centre}|${p.badge_number}`))
      }
      if (toDeploy.length > 0) {
        const { error } = await supabase.from('deployments').upsert(toDeploy, { onConflict: 'schedule_id,centre,badge_number' })
        if (error) {
          const m = error.message || ''
          if (m.includes('already deployed') || m.includes('consent is frozen') || m.includes('No consent recorded') || m.includes('Consent not given') || m.includes('Deadline has passed') || m.includes('Deployment is locked')) {
            toast.error(m)
            loadDataRef.current(true)
            return
          }
          toast.error(m); dirtyRef.current = true; scheduleRetry(); return
        }
      }
      if (toRemove.length > 0) {
        const depMap = {}
        depRows.forEach(d => { depMap[`${d.centre}|${d.badge_number}`] = d })
        const byCentre = {}
        toRemove.forEach(key => {
          const [centre, badge_number] = key.split('|')
          // Department-match the delete: only remove a row whose persisted
          // department still matches what THIS session saw. A peer session may
          // have just reassigned the (VSS) sewadar — this stale delete must not
          // destroy that newer assignment.
          const persisted = depMap[key]
          if (!persisted) return
          const row = rows[key]
          if (row && row.requested_dept && persisted.department_id !== row.requested_dept) return
          ;(byCentre[centre] = byCentre[centre] || []).push(badge_number)
        })
        for (const [centre, badges] of Object.entries(byCentre)) {
          const { error } = await supabase.from('deployments')
            .delete()
            .eq('schedule_id', scheduleId)
            .eq('centre', centre)
            .in('badge_number', badges)
          if (error) { toast.error(error.message); dirtyRef.current = true; scheduleRetry(); return }
        }
      }
      if (editVersionRef.current === versionAtStart) {
        dirtyRef.current = false
        retryCountRef.current = 0
      }
      // The schedule may have changed while this save was in flight — don't
      // clobber the newly loaded schedule's dirty-tracking baseline.
      if (scheduleIdRef.current === scheduleId) {
        savedConsentRef.current = buildConsentSnapshot(rows)
        setSavedAt(new Date())
      }
      if (mountedRef.current && scheduleIdRef.current === scheduleId) {
        try {
          const fresh = await fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', scheduleId).in('centre', sub))
          if (fresh && mountedRef.current) setDeployments(fresh)
        } catch { /* keep previous deployments on transient error */ }
      }
    } catch (err) { toast.error(err.message); dirtyRef.current = true; scheduleRetry() } finally {
      savingRef.current = false
      setSaving(false)
      // mark the echo window: our own writes come back as postgres_changes and
      // must not trigger a merge loop right after this save
      lastWriteAtRef.current = Date.now()
      // If a newer snapshot was queued while this save was in flight, persist it
      // now — otherwise those edits would be dropped silently.
      if (pendingSaveRef.current) {
        const s = pendingSaveRef.current
        pendingSaveRef.current = null
        persist(s)
      } else if (reloadQueuedRef.current) {
        // a realtime event arrived mid-save — run the deferred merge now
        reloadQueuedRef.current = false
        loadDataRef.current()
      }
    }
  }, [toast, scheduleRetry])
  persistRef.current = persist

  const flushPending = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!loadedRef.current || !dirtyRef.current) return
    const snap = pendingSaveRef.current || liveRef.current
    pendingSaveRef.current = null
    persist(snap)
  }, [persist])
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

  useEffect(() => {
    // During a schedule switch the loaded schedule still differs from the
    // selected one — don't re-arm a debounce whose snapshot would pair the NEW
    // schedule id with the OLD rows (that used to write A's rows to B).
    if (!loadedRef.current || !dirtyRef.current) return
    if (scheduleIdRef.current !== selectedScheduleId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSaveRef.current = { scheduleId: selectedScheduleId, rows: consentRows, deployments, depts, subtree }
    saveTimer.current = setTimeout(() => {
      const snap = pendingSaveRef.current
      pendingSaveRef.current = null
      persist(snap)
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [consentRows, selectedScheduleId, deployments, depts, subtree, persist])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deadlinePassed = schedule?.deadline ? new Date(schedule.deadline) < new Date() : false
  const scheduleDone = schedule?.status === 'done'
  // VSS FIX: masterOpen is the EFFECTIVE VSS switch (global
  // portal_settings.vss_deployment_open with the per-centre tri-state
  // centre_vss_overrides applied via vss_deploy_open_for_centre). It already
  // encodes whether a VSS-specific override force-opens deployment for this
  // centre. Generic centre_overrides (any_override_open) must NOT reopen VSS:
  // a stale wildcard that keeps REGULAR deployment open would otherwise make
  // VSS editable via canEditDeployment's overrideOpen bypass even though the
  // ASO left VSS globally closed. So VSS is gated solely on the VSS-specific
  // effective switch; deadline/locked still block normally (the DB's VSS
  // tri-state does NOT bypass deadline/lock — only a generic override does
  // at the DB, but we intentionally do not surface that for VSS so globally
  // closed truly blocks unless a VSS-specific override set the effective true).
  // overrideOpen is kept at false for VSS (see loadGates) — we pass it
  // through to canEditDeployment so the variable stays used and the intent is
  // explicit in one place.
  const masterOpen = settings.vss_deployment_open === true
  const canEdit = canEditDeployment({
    editableRole: isEditableRole,
    schedule,
    deadlinePassed,
    done: scheduleDone,
    masterOpen,
    locked,
    overrideOpen, // VSS: always false — ignores generic centre_overrides; only VSS tri-state via masterOpen matters
    vssOpen: masterOpen, // VSS: the DB trigger block_after_deadline (v30) bypasses lock+deadline when vss_deploy_open_for_centre() is true — frontend must match
  })
  editableRef.current = canEdit
  // For VSS, the consent-given relaxation must also not be driven by a
  // generic regular override — keep it false so persist does not deploy
  // consent=No VSS rows just because regular deployment was specially opened.
  // The DB still relaxes consent via generic v_open, but the UI now stays
  // stricter for VSS (persist will not create those rows).
  overrideOpenRef.current = overrideOpen
  undeployedOverrideOpenRef.current = undeployedOverrideOpen

  const myAlloc = allocations.filter(a => a.centre === myRoot)
  // only departments the superadmin actually gave a quota to are offered/highlighted
  const allocatedQuota = myAlloc.filter(a => (a.max_count || 0) > 0)
  // VSS can only be deployed to departments the ASO opened for VSS (include_vss)
  // AND gave a quota — quota bars / dropdowns show only those.
  const vssAllocatedQuota = allocatedQuota.filter(a => depts.find(d => d.id === a.department_id)?.include_vss)
  const savedAllCounts = {}
  deployments.forEach(d => { savedAllCounts[d.deployed_department_id || d.department_id] = (savedAllCounts[d.deployed_department_id || d.department_id] || 0) + 1 })
  const savedOwnCounts = {}
  deployments.filter(d => isVssBadge(d.badge_number)).forEach(d => { savedOwnCounts[d.deployed_department_id || d.department_id] = (savedOwnCounts[d.deployed_department_id || d.department_id] || 0) + 1 })
  const localOwnCounts = {}
  Object.values(consentRows).forEach(r => { if (r.consent_given && r.requested_dept) localOwnCounts[r.requested_dept] = (localOwnCounts[r.requested_dept] || 0) + 1 })
  const deptQuota = computeDeptQuota(myAlloc, savedAllCounts, localOwnCounts, savedOwnCounts)

  const vssSewadarMap = {}
  Object.values(consentRows).forEach(r => { vssSewadarMap[`${r.centre}|${r.badge_number}`] = r })

  const rowEligibilityReasons = (key, deptId) => {
    const dept = depts.find(d => d.id === deptId)
    const row = consentRows[key]
    if (!dept || !row) return ['Department not found']
    // Days are auto-set when the department changes (5 by default, 3 for OE
    // ESCORTS), so judge the days rule against the days this row WOULD have
    // after switching — otherwise a row on OE ESCORTS (3 days) could never be
    // moved to a department that requires 5.
    const prospective = { ...row, available_days_count: daysForDept(dept.name) }
    return vssEligibilityReasons(prospective, vssSewadarMap[key], dept)
  }
  const deptNameOf = (deptId) => depts.find(d => d.id === deptId)?.name || ''

  // ASO-finalized rows are locked — the final department belongs to the ASO
  const isFinalizedRow = (row) => !!row?.finalized
  // Under an undeployed-only override, a VSS sewadar who ALREADY has a requested
  // department is frozen at the UI too (the DB enforces the same).
  const isRowLocked = (row) => isFinalizedRow(row) || (undeployedOverrideOpen && !!row?.requested_dept)
  const setConsent = (key, value) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      if (isRowLocked(prev[key])) return prev
      return {
        ...prev,
        [key]: value
          ? { ...prev[key], consent_given: true }
          : { ...prev[key], consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: null, requested_dept: '' },
      }
    })
  }
  const toggleBhati = (key) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      if (isRowLocked(prev[key])) return prev
      return { ...prev, [key]: { ...prev[key], stay_at_bhati: !prev[key].stay_at_bhati } }
    })
  }
  const setRequestedDept = (key, deptId) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      if (isRowLocked(prev[key])) return prev
      const next = { ...prev[key], requested_dept: deptId }
      // days are auto-set by the chosen department: 5 by default, 3 for OE ESCORTS
      next.available_days_count = daysForDept(deptNameOf(deptId))
      return { ...prev, [key]: next }
    })
  }

  useEffect(() => {
    if (!openDeptDropdown) return
    const onDocClick = () => { setOpenDeptDropdown(null); setOpenReasons(null) }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [openDeptDropdown])

  if (subtreeError) {
    return (
      <div className="page">
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">Could not load your centres</div>
            <div className="empty-text">Check your connection and try again.</div>
            <button onClick={() => setSubtreeRetry(n => n + 1)} className="btn btn-primary" style={{ marginTop: '0.75rem' }}>
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!schedules.length) {
    return (
      <div className="page">
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          <p style={{ fontSize: '0.9rem' }}>No schedules available yet. Contact your ASO.</p>
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
        disabled={!canEdit || !r.is_active || isRowLocked(r)}
        title={r.finalized ? 'Finalized by the ASO — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined)}
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
        disabled={!canEdit || !r.consent_given || !r.is_active || isRowLocked(r)}
        className="toggle"
        title={r.finalized ? 'Finalized by the ASO — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : 'Stay at bhati')}
      >
        <span className="toggle-knob" />
      </button>
    </td>
  )
  const renderDaysCell = (r) => {
    const oeLocked = isOeEscortsDept(deptNameOf(r.requested_dept))
    const days = r.available_days_count
    return (
      <td style={{ textAlign: 'center' }} data-label="Days">
        <span
          className={`pill ${oeLocked ? 'pill-amber' : 'pill-blue'}`}
          title={oeLocked ? 'OE ESCORTS is fixed at 3 days' : 'Days are set automatically to 5 for every department'}
          style={{ fontSize: '0.72rem', cursor: 'help' }}
        >
          <Lock size={10} style={{ verticalAlign: '-1px', marginRight: '0.25rem' }} />{days} day{days > 1 ? 's' : ''}
        </span>
      </td>
    )
  }
  const renderDeptCell = (r) => {
    const key = `${r.centre}|${r.badge_number}`
    const open = openDeptDropdown === key
    // ASO-finalized rows are locked — show the FINAL department the ASO chose
    // (which may differ from what the centre requested), never a dropdown.
    if (r.finalized) {
      return (
        <td style={{ textAlign: 'center' }} data-label="Deployment">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', justifyContent: 'center' }}>
            <span className="pill pill-indigo" title="Final department set by the ASO" style={{ whiteSpace: 'nowrap' }}>
              {deptNameOf(r.final_dept) || deptNameOf(r.requested_dept) || '—'}
            </span>
            <span className="pill pill-indigo" style={{ fontSize: '0.6rem', whiteSpace: 'nowrap' }} title="Finalized by the ASO — locked">FINAL</span>
          </div>
        </td>
      )
    }
    // Only departments the ASO allocated a quota > 0 for AND opened for VSS
    // (include_vss) are offered — everything else is hidden entirely.
    const isCentreAdmin = profile?.role === 'centre_admin'
    const items = vssAllocatedQuota.map(a => {
      const dept = depts.find(d => d.id === a.department_id)
      if (!dept) return null
      const q = deptQuota[a.department_id]
      const reasons = rowEligibilityReasons(key, a.department_id)
      const isCurrent = r.requested_dept === a.department_id
      const full = q && !isCurrent && q.rem < 1
      if (full) reasons.push(`Allocated quota reached (${q ? q.effective : 0}/${q ? q.max : a.max_count})`)
      // ASO department restriction: centre_admin cannot deploy AREA SECRETARY OFFICE sewadars
      if (isCentreAdmin && isAssoDepartment(r.department) && !isCurrent) {
        reasons.push('Reserved for Super Admin')
      }
      return { deptId: a.department_id, name: dept.name, q, reasons, isCurrent, full }
    }).filter(Boolean)
    const rowDisabled = !r.is_active
    return (
      <td style={{ textAlign: 'center' }} data-label="Deployment">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', justifyContent: 'center' }}>
          <DeptDropdown
            row={r}
            depts={depts}
            items={items}
            open={open}
            disabled={!canEdit || !r.consent_given || rowDisabled || isRowLocked(r)}
            title={r.finalized ? 'Finalized by the ASO — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined)}
            onToggle={close => close === false ? setOpenDeptDropdown(null) : setOpenDeptDropdown(open ? null : key)}
            onSelect={deptId => { setRequestedDept(key, deptId); setOpenDeptDropdown(null) }}
            openReasons={openReasons}
            setOpenReasons={setOpenReasons}
          />
          {r.finalized && <span className="pill pill-indigo" style={{ fontSize: '0.6rem', whiteSpace: 'nowrap' }} title="Finalized by the ASO — locked">FINAL</span>}
        </div>
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
    // finalized rows are locked by the ASO; under an undeployed-only override,
    // already-deployed VSS stay locked — never apply a bulk action to them
    const locked = selectedRows.filter(r => (r.finalized || (undeployedOverrideOpen && r.requested_dept)) && !(pendingBulk.keys && pendingBulk.keys.has(`${r.centre}|${r.badge_number}`)))
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      const next = { ...prev }
      selectedRows.forEach(r => {
        const key = `${r.centre}|${r.badge_number}`
        if (pendingBulk.keys && !pendingBulk.keys.has(key)) return
        if (r.finalized || (undeployedOverrideOpen && r.requested_dept)) return
        next[key] = pendingBulk.updater(next[key])
      })
      return next
    })
    setPendingBulk(null)
    if (locked.length > 0) toast.info(`${locked.length} deployed VSS sewadar${locked.length > 1 ? 's' : ''} skipped — locked under this override`)
  }

  const bulkConsent = (value) => {
    requestBulk(
      'Mark consent',
      `Set consent to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => value
        ? { ...row, consent_given: true }
        : { ...row, consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: null, requested_dept: '' },
    )
  }
  const bulkSetBhati = (value) => {
    requestBulk(
      'Stay at Bhati',
      `Set stay at bhati to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected VSS sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => ({ ...row, stay_at_bhati: value }),
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
      if (r.finalized) {
        skipped.push({ name: r.sewadar_name, badge: r.badge_number, reasons: ['Finalized by the ASO — locked'] })
        return
      }
      if (undeployedOverrideOpen && r.requested_dept) {
        skipped.push({ name: r.sewadar_name, badge: r.badge_number, reasons: ['Already deployed — locked under this override'] })
        return
      }
      const already = r.requested_dept === deptId
      let reasons
      if (!already && remaining < 1) {
        reasons = [`Quota full (${q ? q.effective : 0}/${q ? q.max : '?'} already assigned)`]
      } else {
        // days are auto-set by the target department (5 / 3 for OE ESCORTS)
        const prospective = { ...r, available_days_count: daysForDept(dept.name) }
        reasons = vssEligibilityReasons(prospective, r, dept)
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
      row => ({ ...row, requested_dept: deptId, available_days_count: daysForDept(dept.name) }),
      eligibleKeys,
      skipped,
    )
  }

  // ── Excel export (centre role) — same lazy xlsx pattern as the other pages ──
  const exportExcel = async () => {
    if (exporting) return
    if (!visible.length) {
      toast.info('Nothing to export yet')
      return
    }
    setExporting(true)
    try {
      const XLSX = await import('xlsx') // lazy — keeps xlsx (~400 kB) out of the main bundle
      const wb = XLSX.utils.book_new()
    const sheet = visible.map(r => ({
      'CENTRE': r.centre,
      'Badge Number': r.badge_number,
      'Name': r.sewadar_name,
      'Gender': r.gender || '',
      'Initiated': r.is_initiated ? 'Yes' : 'No',
      'Active': r.is_active ? 'Yes' : 'No',
      'Consent': r.consent_given ? 'Yes' : 'No',
      'Stay at Bhati': r.stay_at_bhati ? 'Yes' : 'No',
      'Days': r.consent_given ? r.available_days_count : '—',
      'Deployment': deptNameOf(r.final_dept || r.requested_dept) || '',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'VSS Consent & Deployment')
    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}_vss_consent_deployment.xlsx`)
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally { setExporting(false) }
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><Star size={22} /> VSS Consent &amp; Deployment</h2>
          <div className="page-sub" style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1e293b', marginTop: 0 }}>
            {myCentre}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {saving ? (
              <span className="pill pill-amber"><Save size={12} /> Saving...</span>
            ) : savedAt ? (
              <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span>
            ) : null}
            {canEdit && (
              <button onClick={saveDraft} className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
                <Save size={13} /> Save Draft
              </button>
            )}
            <button onClick={exportExcel} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
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
          <div className="stat-label">Deployment</div>
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

      {vssAllocatedQuota.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {vssAllocatedQuota.map(a => {
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
            <div className="section-title">VSS consent and deployment</div>
          </div>
          <div style={{ flex: 1 }} />
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

        {scheduleDone ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} /> This schedule is done. Editing is disabled.
          </div>
        ) : overrideOpen ? ( // VSS FIX: overrideOpen is intentionally always false for VSS (see loadGates) — generic centre_overrides must NOT show a "specially opened" banner for VSS. VSS respects ONLY the VSS-specific effective switch (masterOpen). A stale generic wildcard that keeps regular deployment open would otherwise show this green banner on the VSS page even though VSS is globally closed. This branch is kept structurally so the closed/locked/deadline banners below correctly reflect VSS state; it will never render for VSS.
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#047857', marginBottom: '1rem' }}>
            <Unlock size={16} />
            {undeployedOverrideOpen
              ? <>VSS deployment has been <strong>opened for undeployed VSS only</strong> by the ASO — you may deploy VSS sewadars who have not yet been assigned a department (consent Yes or No). VSS already deployed stay locked. VSS finalized by the ASO stay locked.</>
              : <>VSS deployment has been <strong>specially opened for your centre</strong> by the ASO — edit as permitted by the ASO. Sewadars already finalized by the ASO stay locked.</>}
          </div>
        ) : (
          <>
            {!masterOpen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
                <Lock size={16} /> VSS deployment is closed by the ASO. Editing is disabled.
              </div>
            )}
            {locked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
                <Lock size={16} /> Deployment is locked by your centre — VSS consent and deployment are read-only. Only the ASO can reopen it.
              </div>
            )}
            {deadlinePassed && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
                <Lock size={16} /> The deadline has passed. Editing is disabled.
              </div>
            )}
          </>
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
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Stay:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value !== '') { bulkSetBhati(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Dept:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} defaultValue="" onChange={e => { if (e.target.value) { bulkAssignDept(e.target.value); e.target.value = '' } }}>
              <option value="" disabled>Assign…</option>
              {vssAllocatedQuota.map(a => {
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
            <div className="modal" role="dialog" aria-modal="true" aria-label={pendingBulk.title} onClick={e => e.stopPropagation()} style={{ maxWidth: 520, maxHeight: '80vh', overflowY: 'auto' }}>
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
                  <div className="acc-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setExpanded(e => ({ ...e, [centre]: !open }))} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(prev => ({ ...prev, [centre]: !prev[centre] !== false })) } }}>
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
                      <div className="table-wrap table-wrap-sticky" style={{ border: 'none', borderRadius: 0 }}>
                        <table className="table table-sticky">
                          <thead>
                            <tr>
                              <th style={{ width: 40, textAlign: 'center' }}>S.No.</th>
                              <th style={{ width: 30, textAlign: 'center' }}>
                                <input type="checkbox" checked={activeRows.length > 0 && activeRows.every(r => selected[`${r.centre}|${r.badge_number}`])} onChange={() => selectAllCentre(rows)} disabled={!canEdit} style={{ cursor: canEdit ? 'pointer' : 'not-allowed' }} title="Select all active VSS in this centre" />
                              </th>
                              <th>Badge</th>
                              <th>Name</th>
                              <th style={{ textAlign: 'center' }}>Gender</th>
                              <th style={{ textAlign: 'center' }}>Initiated</th>
                              <th style={{ textAlign: 'center' }}>Consent</th>
                              <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                              <th style={{ textAlign: 'center' }}>Days</th>
                              <th style={{ textAlign: 'center' }}>Deployment</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r, i) => {
                              const key = `${r.centre}|${r.badge_number}`
                              const inactive = !r.is_active
                              return (
                                <tr key={key} style={{
                                  background: inactive ? '#fef2f2' : selected[key] ? '#f5f3ff' : undefined,
                                  opacity: inactive ? 0.9 : 1,
                                }}>
                                  <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                                  <td style={{ textAlign: 'center' }} data-label="Select">
                                    <input type="checkbox" checked={!!selected[key]} onChange={() => toggleSelect(key)} disabled={!canEdit || !r.is_active || (undeployedOverrideOpen && r.requested_dept)} style={{ cursor: canEdit && r.is_active && !(undeployedOverrideOpen && r.requested_dept) ? 'pointer' : 'not-allowed' }} title={inactive ? 'Inactive VSS sewadar — cannot be selected' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined)} />
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
