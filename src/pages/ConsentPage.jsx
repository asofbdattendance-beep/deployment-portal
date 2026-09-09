import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, fetchSubtreeCentres, fetchAllRows, fetchAsoDeptKeys, getRootCentre, eligibleBadgeStatusFilter, isAssoDepartment, fetchPortalSettings, shouldHideFromConsent } from '../lib/supabase'
import { computeEditGates, isDeptSelectable, isUndeployedCohort, computeDeptQuota, eligibilityReasons, isLowAttendance, attendanceDisplay, isVssBadge, changedConsentRows, changedConsentFields, consentRowKey, buildConsentSnapshot, EDITABLE_CONSENT_FIELDS, DEFAULT_AVAILABLE_DAYS, isOeEscortsDept, daysForDept } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import ConsentDashboard from '../components/ConsentDashboard'
import DeptDropdown from '../components/DeptDropdown'
import InchargePicker from '../components/InchargePicker'
import DeadlinePill, { DeadlineWarning } from '../components/DeadlinePill'
import { Save, Lock, Unlock, CheckCircle2, Search, ClipboardCheck, ChevronDown, Users, AlertTriangle, CheckSquare, Download } from 'lucide-react'

export default function ConsentPage({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const myCentre = profile?.centre
  const isEditableRole = profile?.role === 'centre_user' || profile?.role === 'centre_admin'
  const selectedScheduleId = scheduleId

  const [consentRows, setConsentRows] = useState({})
  const [depts, setDepts] = useState([])
  const [allocations, setAllocations] = useState([])
  const [deployments, setDeployments] = useState([])
  // ASO-dept badge keys (`centre|badge`) across BOTH populations — used to
  // exclude super_admin-deployed ASO sewadars from quota counts (v35)
  const [asoKeys, setAsoKeys] = useState(() => new Set())
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
  const [openIncharge, setOpenIncharge] = useState(null)
  const [openReasons, setOpenReasons] = useState(null)
  const [selected, setSelected] = useState({})
  const [pendingBulk, setPendingBulk] = useState(null)
  const [settings, setSettings] = useState({ sewadar_deployment_open: true })
  const [incharges, setIncharges] = useState({})
  const [locked, setLocked] = useState(false)
  // v21 Control Panel: the ASO can open deployment for this centre past the
  // switch / deadline / lock. Finalized rows stay frozen regardless.
  //   centreWideOverrideOpen — a centre-wide/global override (reopens CONSENT too)
  //   anyOverrideOpen        — any override incl. department-scoped (reopens DEPLOYMENT)
  //   openDepartments        — null = all open; else the dept ids a scoped unlock opened
  const [centreWideOverrideOpen, setCentreWideOverrideOpen] = useState(false)
  const [anyOverrideOpen, setAnyOverrideOpen] = useState(false)
  const [openDepartments, setOpenDepartments] = useState(null)
  // v21 undeployed-only override: opens deployment for the UNDEPLOYED cohort
  // (consent=No OR yes-not-deployed) to any department within quota. Already-
  // deployed sewadars (a requested department set) stay locked at the UI too.
  const [undeployedOverrideOpen, setUndeployedOverrideOpen] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [lockWarn, setLockWarn] = useState(null)
  const [lockConfirm, setLockConfirm] = useState(false)
  // required tick-box acknowledgement when locking with departments below quota
  const [lockAck, setLockAck] = useState(false)
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

  useEffect(() => { fetchPortalSettings().then(setSettings).catch(() => {}) }, [])
  // Escape closes every modal (bulk confirm, lock warnings) — the modals sit in
  // the render tree, so one listener covers them all
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setPendingBulk(null)
      setLockWarn(null)
      setLockConfirm(false)
      setLockAck(false)
      setOpenDeptDropdown(null)
      setOpenIncharge(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const loadData = useCallback(async (silent = false) => {
    if (!selectedScheduleId || !subtree.length) return
    // silent (realtime-triggered) reloads skip the skeleton + don't reset the
    // user's expanded/collapsed accordion state
    if (!silent) setLoading(true)
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
      // Supabase max-rows=1000 — paginate every table that can exceed 1000
      const [sewAll, consAll, deptAll, allocAll, deployAll, prevAll, asoAll] = await Promise.all([
        fetchAllRows('dp_sewadars', 'badge_number, sewadar_name, department, centre, is_initiated, gender', (q) => q.or(eligibleBadgeStatusFilter()).in('centre', subtree).order('sewadar_name')),
        fetchAllRows('sewadar_consents', '*', (q) => q.eq('schedule_id', selectedScheduleId).in('centre', subtree)),
        fetchAllRows('deployment_departments', '*', (q) => q.eq('is_active', true).order('name')),
        fetchAllRows('centre_allocations', '*', (q) => q.eq('schedule_id', selectedScheduleId)),
        fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', selectedScheduleId).in('centre', subtree)),
        fetchAllRows('prev_year_deployments', 'badge_number, prev_department, attendance_reported', null),
        fetchAsoDeptKeys(subtree),
      ])
      setAsoKeys(asoAll || new Set())
      const sewadars = (sewAll || []).filter(sw => !shouldHideFromConsent(sw, profile?.role))
      const existing = consAll || []
      const map = {}
      existing.forEach(c => { map[`${c.centre}|${c.badge_number}`] = c })
      // which sewadars really have a consent row persisted — the deploy
      // guarantee below needs this, and it must survive every load path
      consentExistsRef.current = new Set(existing.map(c => `${c.centre}|${c.badge_number}`))
      const deployMap = {}
      // keep the whole deployment row so the page knows which sewadars the ASO
      // has FINALIZED — those rows are locked on the centre side
      ;(deployAll || []).forEach(d => { deployMap[`${d.centre}|${d.badge_number}`] = d })
      const prevMap = {}
      ;(prevAll || []).forEach(p => { prevMap[p.badge_number] = p })
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
      sewadars.forEach(sw => {
        const key = `${sw.centre}|${sw.badge_number}`
        const ex = map[key]
        const prev = prevMap[sw.badge_number]
        storedDays[key] = ex?.available_days_count ?? DEFAULT_AVAILABLE_DAYS
        rows[key] = autoSetDays({
          centre: sw.centre,
          badge_number: sw.badge_number,
          sewadar_name: sw.sewadar_name,
          department: sw.department,
          is_initiated: !!sw.is_initiated,
          gender: sw.gender || '',
          consent_given: ex?.consent_given ?? false,
          available_days_count: storedDays[key],
          stay_at_bhati: ex?.stay_at_bhati || false,
          chair_pass: ex?.chair_pass || false,
          requested_dept: deployMap[key]?.department_id || '',
          finalized: !!deployMap[key]?.deployed_department_id,
          final_dept: deployMap[key]?.deployed_department_id || '',
          // a deployments row exists ⇒ this sewadar is DEPLOYED (v32) — frozen
          // for centre editing even before any centre lock. The flag is
          // recomputed from fresh deployments on every merge/load.
          deployed: !!deployMap[key]?.department_id,
          prev_department: prev?.prev_department || null,
          prev_attendance: prev?.attendance_reported != null ? prev.attendance_reported : null,
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
          // values for read-only data (is_active, is_initiated, prev_*, etc.)
          const dropped = []
          const deployDropped = []
          Object.keys(rows).forEach(key => {
            const edit = editsByKey[key]
            if (!edit) return
            // the ASO finalized this row mid-refresh — the edit is moot (the
            // row is locked centre-side) and persist would silently filter it
            // while the UI kept showing it as saved; drop it loudly instead
            if (rows[key].finalized) { dropped.push(key); return }
            // a peer session deployed this row mid-refresh — deployed sewadars
            // are frozen (v32): the edit can never be saved, so drop it too
            if (rows[key].deployed) { deployDropped.push(key); return }
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
          const dropAll = [...dropped, ...deployDropped]
          // Baseline-sync untouched rows: every row this session did NOT edit
          // is now at its fresh server state, so peer changes stop counting as
          // OUR pending edits (previously the whole baseline stayed stale and
          // the next save re-wrote peer edits as if they were ours — the
          // "another tab overwrote my work" bug). Edited rows keep their old
          // baseline so they stay dirty and get per-field saved next.
          const pendingKeys = new Set(Object.keys(editsByKey))
          const freshSnap = buildConsentSnapshot(rows)
          const nextBaseline = { ...savedConsentRef.current }
          Object.keys(freshSnap).forEach(k => {
            if (pendingKeys.has(k)) return
            nextBaseline[k] = freshSnap[k]
          })
          if (dropAll.length > 0) {
            // baseline the dropped rows at their fresh (finalized/deployed)
            // state so they no longer count as pending changes
            dropAll.forEach(k => { nextBaseline[k] = freshSnap[k] })
            if (dropped.length > 0) {
              toast.info(`${dropped.length} sewadar${dropped.length > 1 ? 's' : ''} finalized by the ASO — pending edits discarded`)
            }
            if (deployDropped.length > 0) {
              toast.info(`${deployDropped.length} sewadar${deployDropped.length > 1 ? 's' : ''} deployed — pending edits discarded (deployed sewadars are locked)`)
            }
          }
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
            incharges: liveRef.current.incharges,
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

      // Department incharges (one per CENTRE × department). Non-fatal fetches:
      // if the v12/v13 migrations haven't been run yet the page still loads fine.
      try {
        const { data: incData } = await supabase.from('department_incharges')
          .select('*').eq('schedule_id', selectedScheduleId).eq('centre', myRoot)
        const incMap = {}
        ;(incData || []).forEach(r => {
          incMap[`${r.centre}|${r.department_id}`] = { centre: r.centre, department_id: r.department_id, badge_number: r.badge_number, sewadar_name: r.sewadar_name }
        })
        setIncharges(incMap)
        savedInchargesRef.current = { ...incMap }
      } catch { /* table missing — incharges stay empty until migrated */ }
      try {
        const { data: lockRow } = await supabase.from('centre_locks')
          .select('*').eq('schedule_id', selectedScheduleId).eq('centre', myRoot).maybeSingle()
        setLocked(!!lockRow)
      } catch { /* table missing — lock stays off until migrated */ }
      try {
        const { data: gates } = await supabase.rpc('get_my_effective_gates', { p_schedule: selectedScheduleId })
        setCentreWideOverrideOpen(!!gates?.centre_wide_override_open)
        setAnyOverrideOpen(!!gates?.any_override_open)
        setOpenDepartments(gates?.open_departments ?? null)
        setUndeployedOverrideOpen(!!gates?.undeployed_override_open)
      } catch { /* v21 not migrated — override stays off */ }
    } catch (err) {
      console.error('Failed to load consent data:', err)
      toast.error(err?.message || 'Failed to load data — check your connection')
      // a failed refresh must not pretend in-flight edits were saved
      if (!prevDirty) dirtyRef.current = false
    } finally { setLoading(false) }
  }, [selectedScheduleId, subtree, myRoot, toast, profile?.role])

  useEffect(() => { loadData() }, [loadData])

  // live-update the master switch state (ASO open/close) + refresh when a
  // peer centre edits consents/deployments for this schedule. The channel is
  // keyed only by schedule — loadData lives in a ref so its identity changing
  // (subtree/centres settling in) never tears down and re-creates the channel.
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  // Realtime merge hygiene: peer-centre writes arrive as postgres_changes
  // events. Reloads are coalesced (one silent refresh per burst), skipped
  // briefly after OUR OWN saves (which echo back as events) and queued while
  // a save is in flight so a merge can never fight the write in progress.
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
        loadDataRef.current(true)
      }, 600)
    }
    const channel = supabase
      .channel(`consent-settings-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_locks', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_overrides', filter: `schedule_id=eq.${selectedScheduleId}` }, reload)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
      if (reloadTimerRef.current) { clearTimeout(reloadTimerRef.current); reloadTimerRef.current = null }
    }
  }, [selectedScheduleId])

  // Latest committed state, kept in refs so a flush triggered by unmount or
  // a schedule switch always saves the data it belongs to (not whatever
  // state happens to be live at that moment).
  const savedConsentRef = useRef({})
  const savedInchargesRef = useRef({})
  const liveRef = useRef({})
  const pendingSaveRef = useRef(null)
  const savingRef = useRef(false)
  // live view of whether THIS schedule can be edited at all — persist skips
  // the DB round-trip when the page is read-only (deadline passed / done /
  // locked / master switch closed), because the DB rejects those writes anyway
  const editableRef = useRef(false)
  // Latest "any override open" flag, read inside the persist closure (which is
  // memoized without this dep) so a department-scoped override can relax the
  // consent-given requirement when writing deployment rows.
  const anyOverrideOpenRef = useRef(false)
  // When an undeployed-only override is active, the DB freezes already-deployed
  // sewadars — so persist must never write their consent/deployment rows (their
  // requested_dept is set). We exclude them here to avoid a rejected save.
  const undeployedOverrideOpenRef = useRef(false)
  // Keys of sewadars that actually have a persisted consent row (loaded from
  // sewadar_consents). persist must guarantee one exists for every sewadar it
  // deploys — the DB raises "No consent recorded" for a missing row even under
  // an override (only the consent=No check relaxes there).
  const consentExistsRef = useRef(new Set())
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  // failed-save retry — a transient error re-arms one more save (max 3 tries)
  const retryTimer = useRef(null)
  const retryCountRef = useRef(0)
  liveRef.current = { scheduleId: selectedScheduleId, rows: consentRows, deployments, depts, subtree, incharges }

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

  // Persist one snapshot of rows (schedule + data captured together).
  // Only rows whose signature differs from the last saved state are written;
  // removals are batched per centre instead of one DELETE per row.
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
    const { scheduleId, rows, deployments: depRows, depts: depList, subtree: sub, incharges: incState = {} } = snap
    try {
      const changed = changedConsentRows(rows, savedConsentRef.current)
      const deptNameById = {}
      depList.forEach(d => { deptNameById[d.id] = d.name })
      // Under an undeployed-only override, already-deployed sewadars (a
      // deployment row that already has a requested department) are frozen at the
      // DB. Detect that from the persisted deployments, NOT from r.requested_dept
      // (which reflects the intended NEW state — a sewadar being newly assigned
      // must NOT be excluded).
      const undeployedOnly = undeployedOverrideOpenRef.current
      const alreadyDeployed = (r) => depRows.some(d => `${d.centre}|${d.badge_number}` === `${r.centre}|${r.badge_number}` && d.department_id != null)
      // v32: any regular sewadar with a deployments row is FROZEN — the DB rejects
      // centre writes to their deployments/consents rows. Never include them in an
      // upsert (an upsert on an existing row becomes an UPDATE → the trigger fires).
      const deployedKeys = new Set(depRows.filter(d => d.department_id != null).map(d => `${d.centre}|${d.badge_number}`))
      // Consent writes split into two buckets so parallel-session edits never
      // clobber each other (a whole-row upsert used to overwrite a peer's other
      // fields with our stale values):
      //   rows with no saved baseline  → INSERT only (chunked upsert)
      //   rows with local field diffs  → PATCH only the fields that differ,
      //     grouped by identical field-set, matched per-row via an or-filter
      const toInsert = []
      const patchByFields = new Map()
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
          : (anyOverrideOpenRef.current && r.requested_dept ? daysForDept(deptNameById[r.requested_dept]) : null),
        stay_at_bhati: r.stay_at_bhati,
        chair_pass: r.chair_pass,
      })
      Object.values(rows).forEach(r => {
        const key = `${r.centre}|${r.badge_number}`
        if (r.finalized || r.deployed || deployedKeys.has(key) || (undeployedOnly && alreadyDeployed(r))) return
        const saved = savedConsentRef.current[key]
        const fields = changedConsentFields(r, saved)
        if (!fields) return
        if (saved) {
          // force the canonical days value at save time (mirrors the insert path)
          if ('available_days_count' in fields) {
            fields.available_days_count = r.consent_given
              ? daysForDept(deptNameById[r.requested_dept])
              : (anyOverrideOpenRef.current && r.requested_dept ? daysForDept(deptNameById[r.requested_dept]) : null)
          }
          const groupKey = Object.keys(fields).sort().join(',')
          const patch = patchByFields.get(groupKey) || { fields, rows: [] }
          patch.rows.push({ centre: r.centre, badge_number: r.badge_number })
          patchByFields.set(groupKey, patch)
        } else {
          toInsert.push(consentPayload(r))
        }
      })
      const activeDeptIds = new Set(depList.map(d => d.id))
      // Under a Control Panel override the consent-given requirement relaxes
      // (v21): a sewadar whose consent is No may still be deployed. Otherwise a
      // deployment row is only written for a consented + department-assigned row.
      const overrideDeploy = anyOverrideOpenRef.current
      const toDeploy = changed
        .filter(r => !r.finalized && !r.deployed && !deployedKeys.has(`${r.centre}|${r.badge_number}`) && !(undeployedOnly && alreadyDeployed(r)) && r.requested_dept && activeDeptIds.has(r.requested_dept) && (r.consent_given || overrideDeploy))
        .map(r => ({
          schedule_id: scheduleId,
          department_id: r.requested_dept,
          centre: r.centre,
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name,
          status: 'requested',
        }))
      // toRemove scans ALL rows (not just changed) so rows whose department
      // was deactivated or whose consent was cleared elsewhere still get cleaned.
      // finalized rows (the ASO set the final department) are NEVER removed —
      // deleting them would destroy the ASO's decision. While a department-
      // scoped override is open, a consent=No row that HAS a requested dept is a
      // deliberate deployment and must be kept (the consent check is relaxed).
      // Under an undeployed-only override, already-deployed rows are frozen and
      // likewise never removed.
      const toRemove = Object.values(rows)
        .filter(r => !r.finalized && !r.deployed && !deployedKeys.has(`${r.centre}|${r.badge_number}`) && !(undeployedOnly && alreadyDeployed(r)) && ((!r.requested_dept || !activeDeptIds.has(r.requested_dept)) || (!r.consent_given && !overrideDeploy)))
        .map(consentRowKey)
        .filter(key => depRows.some(d => `${d.centre}|${d.badge_number}` === key))

      if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += 100) {
          const { error } = await supabase.from('sewadar_consents')
            .upsert(toInsert.slice(i, i + 100), { onConflict: 'schedule_id,centre,badge_number' })
          if (error) {
            const m = error.message || ''
            // deployed freeze (v32) is permanent — don't retry, just refresh
            if (m.includes('already deployed') || m.includes('consent is frozen') || m.includes('No consent recorded')) {
              toast.error(m)
              loadDataRef.current(true)
              return
            }
            toast.error(m); dirtyRef.current = true; scheduleRetry(); return
          }
        }
      }
      // per-field PATCH — only fields that actually differ from the saved state,
      // grouped by identical field-set so each group needs exactly one update.
      // Rows match via a PostgREST or-filter; values are double-quoted because
      // centre names contain spaces/hyphens (e.g. "NIT - 2").
      for (const patch of patchByFields.values()) {
        for (let i = 0; i < patch.rows.length; i += 40) {
          const chunk = patch.rows.slice(i, i + 40)
          const orFilter = chunk.map(r => `and(centre.eq."${r.centre}",badge_number.eq."${r.badge_number}")`).join(',')
          const { error } = await supabase.from('sewadar_consents')
            .update(patch.fields)
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
      // an override relaxes only the consent=No check, not a missing row. A
      // sewadar whose consent row was never persisted (consent=No, untouched)
      // cannot be deployed until its row exists. Guarantee it here: INSERT with
      // ignoreDuplicates so a row a parallel session created moments ago is
      // never overwritten.
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
        const byCentre = {}
        toRemove.forEach(key => {
          const [centre, badge_number] = key.split('|')
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
      // ── department incharges — one per CENTRE × department ──
      const rowByBadge = {}
      Object.values(rows).forEach(r => { rowByBadge[r.badge_number] = r })
      const toUpsertInc = Object.entries(incState)
        .filter(([key, inc]) => {
          const saved = savedInchargesRef.current[key]
          return !saved || saved.badge_number !== inc.badge_number || saved.sewadar_name !== inc.sewadar_name
        })
        .map(([key, inc]) => {
          const [centre, department_id] = key.split('|')
          return { schedule_id: scheduleId, centre, department_id, badge_number: inc.badge_number, sewadar_name: inc.sewadar_name }
        })
      const toDeleteInc = []
      // cleared by the user
      Object.keys(savedInchargesRef.current).forEach(key => {
        if (!incState[key]) toDeleteInc.push(key)
      })
      // stale: the incharge's sewadar no longer consents / no longer OCCUPIES
      // that department — occupancy follows the EFFECTIVE dept (final else
      // requested), matching trg_check_incharge (v17)
      Object.entries(incState).forEach(([key, inc]) => {
        const row = rowByBadge[inc.badge_number]
        const effDept = row ? (row.final_dept || row.requested_dept) : null
        if (!row || !row.consent_given || effDept !== inc.department_id) toDeleteInc.push(key)
      })
      if (toUpsertInc.length > 0) {
        const { error } = await supabase.from('department_incharges').upsert(toUpsertInc, { onConflict: 'schedule_id,centre,department_id' })
        if (error) { toast.error(error.message); dirtyRef.current = true; scheduleRetry(); return }
      }
      for (const key of [...new Set(toDeleteInc)]) {
        const [centre, department_id] = key.split('|')
        const { error } = await supabase.from('department_incharges')
          .delete().eq('schedule_id', scheduleId).eq('centre', centre).eq('department_id', department_id)
        if (error) { toast.error(error.message); dirtyRef.current = true; scheduleRetry(); return }
      }

      // only clear dirty if no new edits landed while this save was in flight
      if (editVersionRef.current === versionAtStart) {
        dirtyRef.current = false
        retryCountRef.current = 0
      }
      // The schedule may have changed while this save was in flight — don't
      // clobber the newly loaded schedule's dirty-tracking baseline.
      if (scheduleIdRef.current === scheduleId) {
        const nextInc = { ...incState }
        toDeleteInc.forEach(k => { delete nextInc[k] })
        savedInchargesRef.current = nextInc
        // keep the card pickers in sync immediately (only if no newer edits landed)
        if (editVersionRef.current === versionAtStart) setIncharges(nextInc)
        savedConsentRef.current = buildConsentSnapshot(rows)
        setSavedAt(new Date())
      }
      if (mountedRef.current && scheduleIdRef.current === scheduleId) {
        // paginated refresh — subtree can hold 1000+ deployments
        try {
          const fresh = await fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', scheduleId).in('centre', sub))
          if (fresh && mountedRef.current) setDeployments(fresh)
        } catch { /* keep previous deployments on transient error */ }
      }
    } catch (err) { toast.error(err.message); dirtyRef.current = true; scheduleRetry() } finally {
      savingRef.current = false
      setSaving(false)
      // Self-echo window: a realtime refresh triggered right after our own save
      // is skipped (reloads are debounced too) — parallel sessions' writes still
      // show up, but our own writes don't cause a wasted reload round-trip.
      lastWriteAtRef.current = Date.now()
      // If a newer snapshot was queued while this save was in flight, persist it
      // now — otherwise those edits would be dropped silently.
      if (pendingSaveRef.current) {
        const s = pendingSaveRef.current
        pendingSaveRef.current = null
        persist(s)
      } else if (reloadQueuedRef.current) {
        // A realtime refresh arrived while we were saving — run it now.
        reloadQueuedRef.current = false
        loadDataRef.current(true)
      }
    }
  }, [toast, scheduleRetry])
  persistRef.current = persist

  // flush the pending (or latest) snapshot — used by unmount + schedule switch
  const flushPending = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!loadedRef.current || !dirtyRef.current) return
    const snap = pendingSaveRef.current || liveRef.current
    pendingSaveRef.current = null
    // return the promise so callers (e.g. Lock Deployment) can await the save
    return persist(snap)
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
    pendingSaveRef.current = { scheduleId: selectedScheduleId, rows: consentRows, deployments, depts, subtree, incharges }
    saveTimer.current = setTimeout(() => {
      const snap = pendingSaveRef.current
      pendingSaveRef.current = null
      persist(snap)
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [consentRows, selectedScheduleId, deployments, depts, subtree, incharges, persist])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deadlinePassed = schedule?.deadline ? new Date(schedule.deadline) < new Date() : false
  const scheduleDone = schedule?.status === 'done'
  // v21: a Control Panel override reopens editing past the switch, deadline
  // and centre lock — never past a done schedule. CONSENT rows reopen only via
  // a centre-wide override; DEPLOYMENT reopens via any override (incl. a
  // department-scoped one, where the consent-given requirement also relaxes).
  const { consentEditable, deploymentEditable } = computeEditGates({
    isEditableRole,
    schedule,
    scheduleDone,
    deadlinePassed,
    locked,
    masterOpen: settings.sewadar_deployment_open,
    centreWideOverrideOpen,
    anyOverrideOpen,
  })
  editableRef.current = consentEditable || deploymentEditable
  anyOverrideOpenRef.current = anyOverrideOpen
  undeployedOverrideOpenRef.current = undeployedOverrideOpen

  // Derived data is memoized — the table re-renders on every search keystroke
  // / every autosave, and these are O(rows) / O(rows × depts) scans.
  const myAlloc = useMemo(() => allocations.filter(a => a.centre === myRoot), [allocations, myRoot])
  // only departments the superadmin actually gave a quota to are offered/highlighted
  const allocatedQuota = useMemo(() => myAlloc.filter(a => (a.max_count || 0) > 0), [myAlloc])
  const savedAllCounts = useMemo(() => {
    const counts = {}
    // quota consumption follows the EFFECTIVE department — the ASO's final
    // deployed dept when set, else the requested one (matches the DB)
    deployments.forEach(d => {
      // Exclude AREA SECRETARY OFFICE sewadars from quota — they don't consume centre quota
      const rowConsent = consentRows[`${d.centre}|${d.badge_number}`]
      if (asoKeys.has(`${d.centre}|${d.badge_number}`) || (rowConsent && isAssoDepartment(rowConsent.department))) return
      counts[d.deployed_department_id || d.department_id] = (counts[d.deployed_department_id || d.department_id] || 0) + 1
    })
    return counts
  }, [deployments, consentRows, asoKeys])
  const savedOwnCounts = useMemo(() => {
    const counts = {}
    deployments.filter(d => !isVssBadge(d.badge_number)).forEach(d => {
      const rowConsent = consentRows[`${d.centre}|${d.badge_number}`]
      if (asoKeys.has(`${d.centre}|${d.badge_number}`) || (rowConsent && isAssoDepartment(rowConsent.department))) return
      counts[d.deployed_department_id || d.department_id] = (counts[d.deployed_department_id || d.department_id] || 0) + 1
    })
    return counts
  }, [deployments, consentRows, asoKeys])
  const localCounts = useMemo(() => {
    const counts = {}
    Object.values(consentRows).forEach(r => {
      if (r.consent_given && r.requested_dept && !isAssoDepartment(r.department)) {
        counts[r.requested_dept] = (counts[r.requested_dept] || 0) + 1
      }
    })
    return counts
  }, [consentRows])
  const deptQuota = useMemo(() => computeDeptQuota(myAlloc, savedAllCounts, localCounts, savedOwnCounts), [myAlloc, savedAllCounts, localCounts, savedOwnCounts])

  // seats the ASO asked this CENTRE (whole subtree) to provide, summed across
  // every allocated department — shown right after the in-scope sewadar count
  const totalRequestedSeats = useMemo(() => allocatedQuota.reduce((sum, a) => sum + (a.max_count || 0), 0), [allocatedQuota])

  // male:female + initiated:non-initiated split of the sewadars currently
  // occupying each department (effective dept, same as the quota bars)
  const deptProfile = useMemo(() => {
    const profile = {}
    Object.values(consentRows).forEach(r => {
      const deptId = r.final_dept || r.requested_dept
      if (!deptId) return
      const p = profile[deptId] || (profile[deptId] = { m: 0, f: 0, other: 0, init: 0, nonInit: 0 })
      const g = (r.gender || '').toUpperCase()
      if (g.startsWith('M')) p.m++
      else if (g.startsWith('F')) p.f++
      else p.other++
      if (r.is_initiated) p.init++
      else p.nonInit++
    })
    return profile
  }, [consentRows])

  const deptNameById = useMemo(() => {
    const m = {}
    depts.forEach(d => { m[d.id] = d.name })
    return m
  }, [depts])

  // Human-readable names of the departments a department-scoped override opened
  // (used by the per-row tooltip and the "opened for your centre" banner).
  const openDeptNames = useMemo(
    () => (openDepartments || []).map(id => deptNameById[id]).filter(Boolean).join(', '),
    [openDepartments, deptNameById]
  )

  // returns a list of human-readable reasons a sewadar is not eligible for a dept
  const rowEligibilityReasons = useCallback((key, deptId) => {
    const dept = depts.find(d => d.id === deptId)
    const row = consentRows[key]
    if (!dept || !row) return ['Department not found']
    // Days are auto-set when the department changes (5 by default, 3 for OE
    // ESCORTS), so judge the days rule against the days this row WOULD have
    // after switching — otherwise a row on OE ESCORTS (3 days) could never be
    // moved to a department that requires 5.
    const prospective = { ...row, available_days_count: daysForDept(dept.name) }
    return eligibilityReasons(prospective, dept)
  }, [depts, consentRows])
  const deptNameOf = useCallback((deptId) => deptNameById[deptId] || '', [deptNameById])

  // ── department incharges — one incharge per CENTRE × department ──
  // eligible sewadars: consented AND occupying the department — judged by the
  // EFFECTIVE department (ASO's final deployed dept, else requested), the same
  // rule the DB's trg_check_incharge enforces since v17
  const inchargeOptions = useMemo(() => {
    const options = {}
    Object.values(consentRows).forEach(r => {
      const effDept = r.final_dept || r.requested_dept
      if (r.consent_given && effDept) {
        if (!options[effDept]) options[effDept] = []
        options[effDept].push(r)
      }
    })
    Object.keys(options).forEach(k => {
      options[k].sort((a, b) => (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' }))
    })
    return options
  }, [consentRows])
  const inchargeKey = useCallback((deptId) => `${myRoot}|${deptId}`, [myRoot])
  const setIncharge = (deptId, badgeNumber) => {
    dirtyRef.current = true
    editVersionRef.current++
    const key = inchargeKey(deptId)
    setIncharges(prev => {
      const next = { ...prev }
      if (!badgeNumber) {
        delete next[key]
      } else {
        const row = Object.values(consentRows).find(r => r.badge_number === badgeNumber && r.consent_given && (r.final_dept || r.requested_dept) === deptId)
        if (row) next[key] = { centre: myRoot, department_id: deptId, badge_number: badgeNumber, sewadar_name: row.sewadar_name }
      }
      return next
    })
  }

  // departments this centre is filling BELOW the assigned quota — shown as a
  // summary table with a required acknowledgement before Lock Deployment.
  // Uses deptQuota so the numbers match the quota bars exactly.
  const underQuotaDepts = useMemo(() => allocatedQuota
    .filter(a => { const q = deptQuota[a.department_id]; return q && q.effective < a.max_count })
    .map(a => ({
      id: a.department_id,
      name: deptNameById[a.department_id] || '—',
      max: a.max_count,
      allotted: deptQuota[a.department_id].effective,
    })), [allocatedQuota, deptQuota, deptNameById])

  // ── Lock deployment ──
  // Departments that MUST have an incharge before locking: every allocated
  // department that has at least one regular sewadar deployed to it.
  const missingIncharges = useMemo(() => allocatedQuota.filter(a => {
    const hasRegularAssigned = Object.values(consentRows).some(r => r.consent_given && r.requested_dept === a.department_id && !isVssBadge(r.badge_number))
    return hasRegularAssigned && !incharges[inchargeKey(a.department_id)]
  }), [allocatedQuota, consentRows, incharges, inchargeKey])
  const startLock = () => {
    if (missingIncharges.length > 0) { setLockWarn(missingIncharges); return }
    setLockAck(false)
    setLockConfirm(true)
  }
  const confirmLock = async () => {
    setLockConfirm(false)
    setLockBusy(true)
    try {
      // Save any pending edits first — the lock compulsion checks PERSISTED data.
      if (dirtyRef.current) await flushRef.current()
      if (dirtyRef.current) {
        toast.error('There are still unsaved changes — please wait and try again.')
        return
      }
      const { error } = await supabase.from('centre_locks')
        .insert({ schedule_id: selectedScheduleId, centre: myRoot, locked_by: profile?.name || null })
      if (error) throw error
      setLocked(true)
      toast.success('Deployment locked — only the ASO can reopen it')
    } catch (err) {
      toast.error(err?.message || 'Could not lock deployment')
    } finally { setLockBusy(false) }
  }

  // ASO-finalized rows are locked — the final department belongs to the ASO
  const isFinalizedRow = (row) => !!row?.finalized
  // Deployed rows (a deployments row exists) are frozen for centre users (v32)
  // even BEFORE any centre lock — once deployed, a sewadar may not be edited
  // or moved between departments.
  const isDeployedRow = (row) => !!row?.deployed
  // Under an undeployed-only override, a sewadar who ALREADY has a requested
  // department is frozen at the UI too (the DB enforces the same).
  const isRowLocked = (row) => isFinalizedRow(row) || isDeployedRow(row) || (undeployedOverrideOpen && !!row?.requested_dept)
  // Per-row editability under an undeployed-only override: the undeployed cohort
  // (consent=No OR yes-not-deployed) may be edited; everyone else stays locked.
  const rowConsentEditable = (r) => consentEditable || (undeployedOverrideOpen && !isDeployedRow(r) && isUndeployedCohort(r))
  const rowDeployEditable = (r) => deploymentEditable || (undeployedOverrideOpen && !isDeployedRow(r) && isUndeployedCohort(r))
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
  const toggleChairPass = (key) => {
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      if (isRowLocked(prev[key])) return prev
      return { ...prev, [key]: { ...prev[key], chair_pass: !prev[key].chair_pass } }
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
    if (!openDeptDropdown && !openIncharge) return
    const onDocClick = () => { setOpenDeptDropdown(null); setOpenReasons(null); setOpenIncharge(null) }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [openDeptDropdown, openIncharge])

  // Memoized filter/sort/group of the rows (recomputed on every render by
  // default; the table re-renders on each search keystroke). Hoisted above the
  // super_admin/aso early return so the hooks stay unconditional.
  const visible = useMemo(() => Object.values(consentRows).filter(r => {
    if (filterCentre !== 'all' && r.centre !== filterCentre) return false
    if (search && !`${r.sewadar_name} ${r.badge_number}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }).sort((a, b) => {
    if (sortBy === 'badge') return a.badge_number.localeCompare(b.badge_number, undefined, { numeric: true })
    return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
  }), [consentRows, filterCentre, search, sortBy])

  // group by centre
  const byCentre = useMemo(() => {
    const grouped = {}
    visible.forEach(r => {
      if (!grouped[r.centre]) grouped[r.centre] = []
      grouped[r.centre].push(r)
    })
    return grouped
  }, [visible])

  const totals = useMemo(() => {
    const rows = Object.values(consentRows)
    return {
      totalAll: rows.length,
      consentedAll: rows.filter(r => r.consent_given).length,
      requestedAll: rows.filter(r => r.consent_given && r.requested_dept).length,
    }
  }, [consentRows])
  const { totalAll, consentedAll, requestedAll } = totals

  if (profile?.role === 'super_admin' || profile?.role === 'aso') {
    return <ConsentDashboard schedules={schedules} scheduleId={selectedScheduleId} />
  }

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

  const SkeletonTable = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '0.5rem' }}>
      {[...Array(4)].map((_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 80px 1fr 100px 120px 100px 100px 80px 160px', gap: '0.75rem' }}>
          {[...Array(9)].map((_, j) => <div key={j} className="skeleton" style={{ height: 26 }} />)}
        </div>
      ))}
    </div>
  )

  // Highlight low prev-year attendance: 0,1 always; 2 only if not TRAFFIC OUTSIDE BHATI
  const attendanceClass = (r) => {
    if (r.prev_attendance == null) return 'attendance-pill muted'
    return `attendance-pill ${isLowAttendance(r.prev_attendance, r.prev_department) ? 'low' : 'ok'}`
  }
  const renderConsentCell = (r) => (
    <td style={{ textAlign: 'center' }} data-label="Consent">
      <select
        value={r.consent_given ? 'yes' : 'no'}
        onChange={e => setConsent(`${r.centre}|${r.badge_number}`, e.target.value === 'yes')}
        disabled={!rowConsentEditable(r) || r.finalized || r.deployed}
        title={r.finalized ? 'Finalized by the ASO — locked' : (r.deployed ? 'Deployed — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined))}
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
        disabled={!rowConsentEditable(r) || !r.consent_given || r.finalized || r.deployed}
        className="toggle"
        title={r.finalized ? 'Finalized by the ASO — locked' : (r.deployed ? 'Deployed — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : 'Stay at bhati'))}
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
        disabled={!rowConsentEditable(r) || !r.consent_given || r.finalized || r.deployed}
        className="toggle"
        title={r.finalized ? 'Finalized by the ASO — locked' : (r.deployed ? 'Deployed — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : 'Chair pass'))}
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
    // Deployed sewadars are frozen (v32): once a regular sewadar has a
    // deployments row, centre users can no longer change/remove it — the DB
    // rejects the writes, so show a read-only pill instead of a dropdown.
    if (r.deployed) {
      return (
        <td style={{ textAlign: 'center' }} data-label="Deployment">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', justifyContent: 'center' }}>
            <span className="pill pill-indigo" title="Deployed — locked" style={{ whiteSpace: 'nowrap' }}>
              {deptNameOf(r.requested_dept) || '—'}
            </span>
            <span className="pill pill-indigo" style={{ fontSize: '0.6rem', whiteSpace: 'nowrap' }} title="Deployed — locked">DEPLOYED</span>
          </div>
        </td>
      )
    }
    // Only departments the superadmin allocated a quota > 0 for are offered —
    // zero-quota / unallocated departments are hidden entirely.
    const isCentreAdmin = profile?.role === 'centre_admin'
    const items = allocatedQuota.map(a => {
      const deptName = deptNameById[a.department_id]
      if (!deptName) return null
      const q = deptQuota[a.department_id]
      const reasons = rowEligibilityReasons(key, a.department_id)
      const isCurrent = r.requested_dept === a.department_id
      const full = q && !isCurrent && q.rem < 1
      if (full) reasons.push(`Allocated quota reached (${q ? q.effective : 0}/${q ? q.max : a.max_count})`)
      // ASO department restriction: centre_admin cannot deploy AREA SECRETARY OFFICE sewadars
      if (isCentreAdmin && isAssoDepartment(r.department) && !isCurrent) {
        reasons.push('Reserved for Super Admin')
      }
      // v21: a department-scoped override opens only the listed departments —
      // everything else stays locked for this centre.
      if (!isDeptSelectable(a.department_id, { isCurrent, anyOverrideOpen, openDepartments })) {
        reasons.push(openDeptNames
          ? `Department override not open for your centre — the ASO opened only: ${openDeptNames}`
          : 'Department override not open for your centre')
      }
      return { deptId: a.department_id, name: deptName, q, reasons, isCurrent, full }
    }).filter(Boolean)
    return (
      <td style={{ textAlign: 'center' }} data-label="Deployment">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', justifyContent: 'center' }}>
          <DeptDropdown
            row={r}
            depts={depts}
            items={items}
            open={open}
            disabled={!rowDeployEditable(r) || (!r.consent_given && !anyOverrideOpen) || r.finalized}
            title={r.finalized ? 'Finalized by the ASO — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined)}
            onToggle={close => {
              if (close === false) { setOpenDeptDropdown(null); return }
              setOpenIncharge(null)
              setOpenDeptDropdown(open ? null : key)
            }}
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
    const allSelected = centreRows.length > 0 && centreRows.every(r => selected[`${r.centre}|${r.badge_number}`])
    const next = { ...selected }
    centreRows.forEach(r => { next[`${r.centre}|${r.badge_number}`] = !allSelected })
    setSelected(next)
  }
  const clearSelection = () => setSelected({})
  const selectedRows = visible.filter(r => selected[`${r.centre}|${r.badge_number}`])

  // unified bulk update: sets a pending action that asks for confirmation
  const requestBulk = (title, message, updater, keys = null, skipped = []) => {
    if (!selectedRows.length) return
    setPendingBulk({ title, message, updater, keys, skipped })
  }

  const applyBulk = () => {
    if (!pendingBulk) return
    // finalized rows are locked by the ASO; deployed sewadars are frozen (v32);
    // under an undeployed-only override, already-deployed sewadars are also
    // locked — never apply a bulk action to them
    const locked = selectedRows.filter(r => (r.finalized || r.deployed || (undeployedOverrideOpen && r.requested_dept)) && !(pendingBulk.keys && pendingBulk.keys.has(`${r.centre}|${r.badge_number}`)))
    dirtyRef.current = true
    editVersionRef.current++
    setConsentRows(prev => {
      const next = { ...prev }
      selectedRows.forEach(r => {
        const key = `${r.centre}|${r.badge_number}`
        if (pendingBulk.keys && !pendingBulk.keys.has(key)) return
        if (r.finalized || r.deployed || (undeployedOverrideOpen && r.requested_dept)) return
        next[key] = pendingBulk.updater(next[key])
      })
      return next
    })
    setPendingBulk(null)
    if (locked.length > 0) toast.info(`${locked.length} finalized/deployed sewadar${locked.length > 1 ? 's' : ''} skipped — locked`)
  }

  const bulkConsent = (value) => {
    requestBulk(
      'Mark consent',
      `Set consent to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => value
        ? { ...row, consent_given: true }
        : { ...row, consent_given: false, stay_at_bhati: false, chair_pass: false, available_days_count: null, requested_dept: '' },
    )
  }

  const bulkSetBhati = (value) => {
    requestBulk(
      'Stay at Bhati',
      `Set stay at bhati to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected sewadar${selectedRows.length > 1 ? 's' : ''}?`,
      row => ({ ...row, stay_at_bhati: value }),
    )
  }

  const bulkSetChairPass = (value) => {
    requestBulk(
      'Chair pass',
      `Set chair pass to ${value ? 'Yes' : 'No'} for ${selectedRows.length} selected sewadar${selectedRows.length > 1 ? 's' : ''}?`,
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
        if (r.finalized || r.deployed) {
          skipped.push({ name: r.sewadar_name, badge: r.badge_number, reasons: [r.finalized ? 'Finalized by the ASO — locked' : 'Deployed — locked'] })
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
        reasons = eligibilityReasons(prospective, dept)
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
      `Assign ${count} selected sewadar${count === 1 ? '' : 's'} to "${dept.name}"?${skipped.length ? ` ${skipped.length} skipped — see reasons below.` : ''}`,
      row => ({ ...row, requested_dept: deptId, available_days_count: daysForDept(dept.name) }),
      eligibleKeys,
      skipped,
    )
  }

  // ── Excel export (centre role) — mirrors the lazy xlsx pattern used on the
  // Deployment Allocation / dashboard pages, so the bundle stays code-split ──
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
      'Department': r.department || '—',
      'Initiated': r.is_initiated ? 'Yes' : 'No',
      'Consent': r.consent_given ? 'Yes' : 'No',
      'Stay at Bhati': r.stay_at_bhati ? 'Yes' : 'No',
      'Chair Pass': r.chair_pass ? 'Yes' : 'No',
      'Days': r.consent_given ? r.available_days_count : '—',
      'Deployment': deptNameOf(r.final_dept || r.requested_dept) || '',
      'Prev. Dept': r.prev_department || '',
      'Attendance Reported': r.prev_attendance != null ? attendanceDisplay(r.prev_attendance, r.prev_department) : '',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Consent & Deployment')
    const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    XLSX.writeFile(wb, `${name}_consent_deployment.xlsx`)
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally { setExporting(false) }
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><ClipboardCheck size={22} /> Consent &amp; Deployment</h2>
          <div className="page-sub" style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1e293b', marginTop: 0 }}>
            {myCentre}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {saving ? (
              <span className="pill pill-amber"><Save size={12} /> Saving...</span>
            ) : savedAt ? (
              <span className="pill pill-green"><CheckCircle2 size={12} /> Saved {savedAt.toLocaleTimeString()}</span>
            ) : null}
            {(consentEditable || deploymentEditable) && (
              <button onClick={saveDraft} className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
                <Save size={13} /> Save Draft
              </button>
            )}
            {locked ? (
              <span className="pill pill-red" style={{ fontSize: '0.75rem', fontWeight: 700 }} title="Only the ASO can reopen this deployment">
                <Lock size={12} style={{ verticalAlign: '-1px', marginRight: '0.25rem' }} /> Deployment Locked
              </span>
            ) : deploymentEditable && myCentre === myRoot && (
              <button onClick={startLock} disabled={lockBusy} className="btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem', color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}>
                <Lock size={13} /> {lockBusy ? 'Locking…' : 'Lock Deployment'}
              </button>
            )}
            {!locked && deploymentEditable && myCentre !== myRoot && (
              <span className="pill" style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', background: '#f1f5f9', border: '1px solid #e2e8f0' }} title="Only the CENTRE account locks the deployment — this covers your SC_SP too">
                <Lock size={11} style={{ verticalAlign: '-1px', marginRight: '0.25rem' }} /> Locked at CENTRE level
              </span>
            )}
            <button onClick={exportExcel} disabled={exporting} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>
        {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Sewadars in scope</div>
          <div className="stat-value">{totalAll}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Scheduled Count</div>
          <div className="stat-value" style={{ color: '#8b5cf6' }}>{totalRequestedSeats}</div>
          <div className="stat-sub">across {allocatedQuota.length} department{allocatedQuota.length === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Consented (Yes)</div>
          <div className="stat-value" style={{ color: consentedAll === totalAll && totalAll ? '#10b981' : '#6366f1' }}>{consentedAll}</div>
          <div className="stat-sub">of {totalAll}</div>
        </div>
        <div className="stat">
          <div className="stat-label">DEPLOYED</div>
          <div className="stat-value" style={{ color: requestedAll === consentedAll && consentedAll ? '#10b981' : '#8b5cf6' }}>{requestedAll}</div>
          <div className="stat-sub">of {consentedAll} consented</div>
        </div>
        </div>

      {allocatedQuota.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {allocatedQuota.map(a => {
            const deptName = deptNameById[a.department_id]
            const q = deptQuota[a.department_id]
            const pct = q ? Math.round(q.effective / q.max * 100) : 0
            const over = q && q.rem < 0
            const inc = incharges[inchargeKey(a.department_id)]
            const pf = deptProfile[a.department_id]
            return (
              <div key={a.department_id} className="card" style={{ padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{deptName || '—'}</span>
                  <span style={{ fontWeight: 800, fontSize: '0.9rem', color: over ? '#ef4444' : '#0f172a' }}>{q ? q.effective : 0}<span style={{ color: '#94a3b8', fontWeight: 600, fontSize: '0.78rem' }}>/{q ? q.max : a.max_count}</span></span>
                </div>
                <div className="progress">
                  <div className={`progress-bar ${over ? 'danger' : pct >= 100 ? 'success' : ''}`} style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
                </div>
                {pf && (pf.m + pf.f + pf.init + pf.nonInit) > 0 && (
                  <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.72rem', marginTop: '0.45rem', color: '#475569', flexWrap: 'wrap' }}>
                    <span title="Male : Female" style={{ whiteSpace: 'nowrap' }}>
                      <b style={{ color: '#2563eb' }}>M</b> {pf.m}
                      <span style={{ color: '#cbd5e1', margin: '0 0.2rem' }}>·</span>
                      <b style={{ color: '#db2777' }}>F</b> {pf.f}
                    </span>
                    <span title="Initiated : Non-initiated" style={{ whiteSpace: 'nowrap' }}>
                      <b style={{ color: '#7c3aed' }}>Init</b> {pf.init}
                      <span style={{ color: '#cbd5e1', margin: '0 0.2rem' }}>·</span>
                      <b>Non</b> {pf.nonInit}
                    </span>
                  </div>
                )}
                <div style={{ marginTop: '0.55rem' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8', marginBottom: '0.3rem' }}>Incharge</div>
                  <InchargePicker
                    id={`incharge-btn-${a.department_id}`}
                    value={inc?.badge_number || ''}
                    currentName={inc?.sewadar_name || ''}
                    sewadars={inchargeOptions[a.department_id] || []}
                    onChange={badge => setIncharge(a.department_id, badge)}
                    open={openIncharge === a.department_id}
                    onToggle={close => {
                      if (close === false) { setOpenIncharge(null); return }
                      setOpenDeptDropdown(null)
                      setOpenIncharge(openIncharge === a.department_id ? null : a.department_id)
                    }}
                    disabled={!deploymentEditable || !isDeptSelectable(a.department_id, { isCurrent: false, anyOverrideOpen, openDepartments })}
                    title={anyOverrideOpen && openDepartments && !openDepartments.includes(a.department_id)
                      ? `Only the opened department(s) (${openDeptNames}) incharge can be changed under this override`
                      : undefined}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div className="section-title">Consent and deployment</div>
          </div>
          <div style={{ flex: 1 }} />
          <select value={filterCentre} onChange={e => setFilterCentre(e.target.value)} className="select" aria-label="Filter by centre">
            <option value="all">All centres</option>
            {subtree.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="select" title="Sort rows" aria-label="Sort rows">
            <option value="name">Sort: Name</option>
            <option value="badge">Sort: Badge number</option>
          </select>
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / badge..." className="input" style={{ width: '100%', paddingLeft: 30 }} aria-label="Search name or badge" />
          </div>
        </div>

        {scheduleDone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} /> This schedule is done. Editing is disabled.
          </div>
        )}
        {!deploymentEditable && (deadlinePassed || locked || settings.sewadar_deployment_open === false) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
            <Lock size={16} />
            {locked
              ? <>Deployment is locked by your centre — consent, deployment and incharges are read-only. Only the ASO can reopen it.</>
              : deadlinePassed
                ? <>The deadline has passed. Editing is disabled.</>
                : <>Deployment is closed by the ASO. Editing is disabled.</>}
          </div>
        )}
        {anyOverrideOpen && !scheduleDone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#047857', marginBottom: '1rem' }}>
            <Unlock size={16} />
            {centreWideOverrideOpen
              ? <>Deployment has been <strong>specially opened for your centre</strong> by the ASO — edit freely. Sewadars already finalized by the ASO stay locked.</>
              : undeployedOverrideOpen
                ? <>Deployment has been <strong>opened for undeployed sewadars only</strong> by the ASO — you may deploy sewadars who have not yet been assigned a department (consent Yes or No), to any department within quota. Sewadars already deployed stay locked. Sewadars already finalized by the ASO stay locked.</>
                : <>Deployment has been <strong>specially opened for specific departments</strong> by the ASO{openDepartments && openDepartments.length ? ` (${openDeptNames})` : ''}. You can deploy sewadars there and update their consent; other departments stay locked. Sewadars already finalized by the ASO stay locked.</>}
          </div>
        )}
        {(consentEditable || deploymentEditable) && <DeadlineWarning deadline={schedule?.deadline} />}

        {(consentEditable || deploymentEditable) && selectedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '0.6rem 0.75rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
            <span style={{ fontWeight: 700, color: '#3730a3' }}><CheckSquare size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />{selectedRows.length} selected</span>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Consent:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} disabled={!consentEditable} defaultValue="" aria-label="Set consent" onChange={e => { if (e.target.value !== '') { bulkConsent(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Stay:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} disabled={!consentEditable} defaultValue="" aria-label="Set stay at bhati" onChange={e => { if (e.target.value !== '') { bulkSetBhati(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Chair pass:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} disabled={!consentEditable} defaultValue="" aria-label="Set chair pass" onChange={e => { if (e.target.value !== '') { bulkSetChairPass(e.target.value === 'yes'); e.target.value = '' } }}>
              <option value="" disabled>Set…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <span style={{ color: '#6366f1', fontSize: '0.75rem' }}>Dept:</span>
            <select className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} disabled={!deploymentEditable} defaultValue="" aria-label="Assign to department" onChange={e => { if (e.target.value) { bulkAssignDept(e.target.value); e.target.value = '' } }}>
              <option value="" disabled>Assign…</option>
              {allocatedQuota.filter(a => isDeptSelectable(a.department_id, { isCurrent: false, anyOverrideOpen, openDepartments })).map(a => {
                const deptName = deptNameById[a.department_id]
                if (!deptName) return null
                return <option key={a.department_id} value={a.department_id}>{deptName} ({deptQuota[a.department_id]?.effective || 0}/{deptQuota[a.department_id]?.max || a.max_count})</option>
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

        {lockWarn && (
          <div className="modal-overlay" onClick={() => setLockWarn(null)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Add incharges before locking" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Add incharges before locking</h4>
              <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '0.75rem' }}>
                Every department with deployed sewadars needs an incharge before you can lock deployment. Missing:
              </p>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '0.6rem 0.75rem', marginBottom: '0.75rem' }}>
                {lockWarn.map(a => {
                  const deptName = deptNameById[a.department_id]
                  return (
                    <div key={a.department_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', borderBottom: '1px solid #fde68a', fontSize: '0.82rem', fontWeight: 600, color: '#78350f' }}>
                      <span>{deptName || '—'}</span>
                      <span style={{ color: '#b45309', fontWeight: 500 }}>no incharge</span>
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setLockWarn(null)} className="btn btn-primary" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>OK</button>
              </div>
            </div>
          </div>
        )}

        {lockConfirm && (
          <div className="modal-overlay" onClick={() => setLockConfirm(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Lock deployment" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Lock deployment for {myCentre}?</h4>
              <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '0.75rem' }}>
                All required incharges are set. After locking, consent, deployment and incharges (including VSS) become read-only for your centre — only the ASO can reopen it.
              </p>
              {underQuotaDepts.length > 0 && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '0.7rem 0.8rem', marginBottom: '0.75rem' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#b91c1c', marginBottom: '0.45rem' }}>
                    Departments below assigned quota
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', marginBottom: '0.55rem' }}>
                    <thead>
                      <tr style={{ color: '#991b1b', textAlign: 'left' }}>
                        <th style={{ padding: '0.2rem 0.4rem', borderBottom: '1px solid #fecaca', fontWeight: 700 }}>Department</th>
                        <th style={{ padding: '0.2rem 0.4rem', borderBottom: '1px solid #fecaca', fontWeight: 700, textAlign: 'center' }}>Quota Assigned</th>
                        <th style={{ padding: '0.2rem 0.4rem', borderBottom: '1px solid #fecaca', fontWeight: 700, textAlign: 'center' }}>Sewadars Allotted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {underQuotaDepts.map(d => (
                        <tr key={d.id}>
                          <td style={{ padding: '0.25rem 0.4rem', borderBottom: '1px solid #fee2e2', fontWeight: 600, color: '#7f1d1d' }}>{d.name}</td>
                          <td style={{ padding: '0.25rem 0.4rem', borderBottom: '1px solid #fee2e2', textAlign: 'center', color: '#7f1d1d' }}>{d.max}</td>
                          <td style={{ padding: '0.25rem 0.4rem', borderBottom: '1px solid #fee2e2', textAlign: 'center', fontWeight: 700, color: '#dc2626' }}>{d.allotted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 600, color: '#7f1d1d', cursor: 'pointer' }}>
                    <input type="checkbox" checked={lockAck} onChange={e => setLockAck(e.target.checked)} style={{ marginTop: 2 }} />
                    I have checked the list above and confirm that this deployment is correct.
                  </label>
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setLockConfirm(false)} className="btn" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>Cancel</button>
                <button
                  onClick={confirmLock}
                  disabled={lockBusy || (underQuotaDepts.length > 0 && !lockAck)}
                  title={underQuotaDepts.length > 0 && !lockAck ? 'Tick the confirmation box above to enable locking' : undefined}
                  className="btn btn-primary"
                  style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem', background: '#dc2626', borderColor: '#dc2626' }}
                >
                  <Lock size={13} style={{ verticalAlign: '-2px', marginRight: '0.3rem' }} /> {lockBusy ? 'Locking…' : 'Lock Deployment'}
                </button>
              </div>
            </div>
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
                                <input type="checkbox" checked={rows.length > 0 && rows.every(r => selected[`${r.centre}|${r.badge_number}`])} ref={el => { if (el) el.indeterminate = rows.some(r => selected[`${r.centre}|${r.badge_number}`]) && !rows.every(r => selected[`${r.centre}|${r.badge_number}`]) }} onChange={() => selectAllCentre(rows)} disabled={!(consentEditable || deploymentEditable) || (undeployedOverrideOpen && rows.some(r => r.requested_dept))} style={{ cursor: (consentEditable || deploymentEditable) ? 'pointer' : 'not-allowed' }} title="Select all in this centre" aria-label={`Select all in ${centre}`} />
                              </th>
                              <th>Badge</th>
                              <th>Name</th>
                              <th>Dept</th>
                              <th style={{ textAlign: 'center' }}>Initiated</th>
                              <th style={{ textAlign: 'center' }}>Consent</th>
                              <th style={{ textAlign: 'center' }}>Stay at Bhati</th>
                              <th style={{ textAlign: 'center' }}>Chair Pass</th>
                              <th style={{ textAlign: 'center' }}>Days</th>
                              <th style={{ textAlign: 'center' }}>Deployment</th>
                              <th style={{ textAlign: 'center', borderLeft: '2px solid #e2e8f0' }}>Prev. Dept</th>
                              <th style={{ textAlign: 'center' }}>Attendance Reported</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r, i) => (
                              <tr key={`${r.centre}|${r.badge_number}`} style={{ background: selected[`${r.centre}|${r.badge_number}`] ? '#f5f3ff' : undefined }}>
                                <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                                <td style={{ textAlign: 'center' }} data-label="Select">
                                  <input type="checkbox" checked={!!selected[`${r.centre}|${r.badge_number}`]} onChange={() => toggleSelect(`${r.centre}|${r.badge_number}`)} disabled={!(consentEditable || deploymentEditable) || isRowLocked(r)} style={{ cursor: (consentEditable || deploymentEditable) && !isRowLocked(r) ? 'pointer' : 'not-allowed' }} title={r.finalized ? 'Finalized by the ASO — locked' : (undeployedOverrideOpen && r.requested_dept ? 'Already deployed — locked under this override' : undefined)} />
                                </td>
                                <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                    {isLowAttendance(r.prev_attendance, r.prev_department) && (
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
                                      <span className={attendanceClass(r)}>{attendanceDisplay(r.prev_attendance, r.prev_department)}</span>
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
