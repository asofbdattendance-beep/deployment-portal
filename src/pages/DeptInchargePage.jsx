import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { isVssBadge } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import RecentScansTable from '../components/scanner/RecentScansTable'
import MobileScanFeed from '../components/mobile/MobileScanFeed'
import ScanModeShell from '../components/mobile/ScanModeShell'
import { useIsMobile } from '../hooks/useMediaQuery'
import QueueRecoveryBar from '../components/mobile/QueueRecoveryBar'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import { exportWorkbook, fileSlug } from '../lib/excel'
import { useScannerSession } from '../hooks/useScannerSession'
import { useSewadarDirectory } from '../hooks/useSewadarDirectory'
import { ScanLine, Users, UserX, UserCheck, Search, Clock, AlertTriangle, Download, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'

// Canonical queue predicates, mirrored from offlineQueue + ScannerPage: a
// failed row carries `failed: true` (v1) or `status: 'failed'` (newer); a
// null-owner live row is stranded/orphaned (never drained, cleared
// separately). The live "N queued" count excludes both — same filtered
// definition as ScannerPage.

// DeptInchargePage — the SCANNING + lists page for a dept_incharge.
//
// SCOPE (v51): a dept_incharge is scoped by DEPARTMENT, across EVERY centre.
// `get_my_dept_ids` now returns the departments granted to this login's badge
// (new `department_incharge_assignments` UNION the legacy centre×dept
// selections) with NO centre filter, and the `dp_attendance_sessions` read is
// permitted by v51's widened `att_read`. The centre select below is therefore a
// pure client-side FILTER over rows already in scope — it never widens or
// narrows the boundary. Do NOT reintroduce a centre predicate here.
export default function DeptInchargePage({ schedules = [], scheduleId }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const selectedScheduleId = scheduleId
  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const [tab, setTab] = useState('scan') // scan | list | present | absent
  const [centreFilter, setCentreFilter] = useState('') // '' = all centres
  const [myDeptIds, setMyDeptIds] = useState([])
  const [activeDept, setActiveDept] = useState('')
  const [depts, setDepts] = useState([])
  const [deployments, setDeployments] = useState([])
  const [sewadars, setSewadars] = useState([])
  const [vss, setVss] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [manualBadge, setManualBadge] = useState('')
  const [search, setSearch] = useState('')
  const [offline, setOffline] = useState(false)
  // Reactive connectivity — `navigator.onLine` read at render time never
  // updates, so the Online/Offline pill used to go stale until some other
  // state change re-rendered the page.
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(()=>{
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  },[])
  // A slow load for schedule A must never land after a fast one for schedule B
  // and overwrite its rows — every sibling page sequences its loads.
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  // T4: set on the first successful load OR poll — the stale-data pin means
  // "showing last data", so a poll that fails before anything ever loaded
  // must not raise it (there is no last data yet).
  const loadedOnceRef = useRef(false)
  // T3: the schedule whose rows are currently rendered. On a schedule switch
  // the rows are cleared immediately (see the effect below) so stale rows
  // never survive until the new load lands.
  const [rowsScheduleId, setRowsScheduleId] = useState(selectedScheduleId)
  // popup/outTime/queued/syncing + the scan entry points live in the shared
  // session hook (Phase B task 5) — this page owns loads, lists, tabs, and render.

  const load = useCallback(async () => {
    if (!selectedScheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    // T3: every setter below is gated on this — a slow schedule-A load that
    // resolves after the schedule-B load must not touch rows, toasts or pins.
    const alive = () => mountedRef.current && seq === seqRef.current
    setLoading(true)
    setLoadError(null)
    try {
      // supabase-js RESOLVES with { data, error } — it never rejects — so a
      // `.catch(() => [])` here is dead code, and a PGRST202, an RLS denial or
      // a dropped connection all collapse into `[]`. The page then reads that
      // as "this login has no department" and tells a correctly-provisioned
      // incharge to ask the ASO to re-provision them. Unwrap the error.
      const { data: deptIds, error: deptError } = await supabase.rpc('get_my_dept_ids', { p_schedule: selectedScheduleId })
      if (deptError) throw new Error(`get_my_dept_ids: ${deptError.message || deptError.code || 'failed'}`)
      if (!alive()) return
      setMyDeptIds(Array.isArray(deptIds) ? deptIds : [])
      // Supabase max-rows=1000 — paginate every table that can exceed it.
      // I4: sessions follow the v45 event-date law (IN *or* OUT today counts —
      // in_date-only reads miss overnight sessions and contradict the ASO's
      // Daily tab) and are paginated, not capped: a 200-row cap silently
      // listed everyone past it as Absent on busy days.
      const today = todayStrIST()
      // v53 perf, phase 1: the three tables every tab needs. `deployments` is
      // the list itself, so it is what the other two are keyed off.
      const [deptAll, depAll, sessAll] = await Promise.all([
        fetchAllRows('deployment_departments', '*', (q) => q.order('name'), 'id'),
        fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', selectedScheduleId), 'id'),
        // Narrow session columns — presentBadges needs badge/in/out dates,
        // sessionByBadge needs in/out times, RecentScansTable needs the
        // name/dept/VSS/flagged pills. `select('*')` would also drag in any
        // future fat column on every load. V9: `created_at` is load-bearing —
        // recent scans are ordered by it (not id) and sessionByBadge keeps the
        // newest row per badge by it. T5: `sewadar_centre` is load-bearing —
        // presence is keyed on centre|badge, never badge alone.
        fetchAllRows('dp_attendance_sessions', 'id,badge_number,sewadar_name,sewadar_centre,sewadar_dept,in_date,out_date,in_time,out_time,is_vss,undeployed_scan,created_at', (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id'),
      ])
      if (!alive()) return
      // v53 perf, phase 2: fetch sewadar profiles for the DEPLOYED badges only.
      // They are used solely to enrich the deployment rows (name / gender /
      // initiated via `swMap`), but they were fetched unfiltered — so the server
      // had to RLS-evaluate the department predicate across every sewadar in the
      // portal, twice per table (`count: 'exact'` then the page), and shipped
      // thousands of rows this page never renders. Chunked because an `in.()`
      // list of every badge would blow the request-URL limit.
      const badges = [...new Set((depAll || []).map(d => d.badge_number).filter(Boolean))]
      const byBadge = (table, cols, key) => {
        if (!badges.length) return Promise.resolve([])
        const CHUNK = 100
        const parts = []
        for (let i = 0; i < badges.length; i += CHUNK) parts.push(badges.slice(i, i + CHUNK))
        return Promise.all(parts.map(chunk => fetchAllRows(table, cols, (q) => q.in('badge_number', chunk), key)))
          .then(lists => lists.flat())
      }
      const [vssAll, sewAll] = await Promise.all([
        byBadge('vss_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender, is_active', 'badge_number'),
        byBadge('dp_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender', ['centre', 'badge_number']),
      ])
      if (!alive()) return
      setDepts(deptAll||[])
      setDeployments(depAll||[])
      setVss(vssAll||[])
      setSewadars(sewAll||[])
      setSessions(sessAll||[])
      // L-43: the amber "showing last data" pin (line ~289) used to be
      // unreachable from a failed load — success clears it, failure sets it.
      setOffline(false)
      loadedOnceRef.current = true
    } catch(e){
      if (!alive()) return
      console.error('[DeptIncharge] load failed:', e)
      setLoadError(e?.message || 'Could not load')
      toast.error(e?.message || 'Could not load')
      setOffline(true)
    } finally { if (mountedRef.current && seq === seqRef.current) setLoading(false) }
  }, [selectedScheduleId, toast])

  // Separate effect for initial dept selection — defaults to ALL of the
  // incharge's departments ('' = every id from get_my_dept_ids), so the three
  // list tabs cover the incharge's whole remit by default.
  useEffect(() => {
    if (myDeptIds.length && activeDept && !myDeptIds.includes(activeDept)) {
      setActiveDept('')
    }
  }, [myDeptIds, activeDept])

  // T3: clear stale rows the moment the schedule changes — before the new
  // load lands — and reset the client filters that point at the old rows.
  // Declared before the load effect so the clear runs first on a switch.
  useEffect(() => {
    if (rowsScheduleId !== selectedScheduleId) {
      setDeployments([])
      setSewadars([])
      setVss([])
      setSessions([])
      setCentreFilter('')
      setActiveDept('')
      setRowsScheduleId(selectedScheduleId)
    }
  }, [selectedScheduleId, rowsScheduleId])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // Light session poll (L-42): the scan tab used to refresh only on
  // mount/after-scan, going stale all day. Polls sessions only — never the
  // full load (which would flash the page spinner every 15s). Same
  // event-date predicate as the initial load (I4); a capped in_date-only
  // refresh would regress the list right after a scan.
  // T4: sequenced like the load — a slow poll that resolves after a newer
  // one must not overwrite its sessions — and a success clears the stale pin.
  const refreshSessions = useCallback(async () => {
    const seq = ++seqRef.current
    const alive = () => mountedRef.current && seq === seqRef.current
    try {
      const today = todayStrIST()
      const sess = await fetchAllRows('dp_attendance_sessions', 'id,badge_number,sewadar_name,sewadar_centre,sewadar_dept,in_date,out_date,in_time,out_time,is_vss,undeployed_scan,created_at', (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id')
      if (!alive()) return
      setSessions(sess||[])
      setOffline(false)
      loadedOnceRef.current = true
    } catch(e){
      if (!alive()) return
      console.warn('[Scanner] post-scan refresh failed:', e?.message)
      // Cold-load suppression: before the first successful load/poll there is
      // no "last data" to show, so a failing poll must not raise the pin.
      if (loadedOnceRef.current) setOffline(true)
    }
  }, [selectedScheduleId])
  useEffect(()=>{ const id=setInterval(()=>refreshSessions(),15000); return()=>clearInterval(id) },[refreshSessions])

  const deptMap = useMemo(()=>{ const m=new Map(); depts.forEach(d=>m.set(d.id,d)); return m },[depts])
  // id -> department NAME, for the scan popup and the Recent scans table.
  // `deptMap` above stays id -> full object for the page's own dropdown/labels.
  const deptNameById = useMemo(() => deptNameMap(depts), [depts])
  // Centre-scoped: a badge is looked up with its own centre so two centres
  // sharing a badge number never display each other's sewadar identity.
  const swMap = useMemo(()=>{ const m={}; [...sewadars,...vss].forEach(s=>{m[`${s.centre}|${s.badge_number}`]=s}); return m },[sewadars,vss])
  const effectiveDept = (d)=> d.deployed_department_id || d.department_id

  const myDeptIdsSet = useMemo(()=> new Set(myDeptIds),[myDeptIds])
  // '' = all incharge departments; otherwise the single selected department.
  const deptLabel = activeDept ? (deptMap.get(activeDept)?.name || activeDept) : `All my departments (${myDeptIds.length})`
  const isMyDept = useCallback((d)=>{
    const eff = effectiveDept(d)
    return Boolean(eff) && myDeptIdsSet.has(eff) && (!activeDept || eff === activeDept)
  },[myDeptIdsSet,activeDept])

  const myDeployed = useMemo(()=> deployments.filter(isMyDept),[deployments,isMyDept])
  const myDeployedEnriched = useMemo(()=> myDeployed.map(d=>{
    const sw=swMap[`${d.centre}|${d.badge_number}`]||{}
    const eff=effectiveDept(d)
    return { ...d, sewadar_name: d.sewadar_name||sw.sewadar_name||'—', centre: d.centre, deptName: deptMap.get(eff)?.name||'—', is_vss: isVssBadge(d.badge_number), is_initiated: !!sw.is_initiated, gender: sw.gender||'' }
  }),[myDeployed,swMap,deptMap])

  // v45 event-date law: an IN *or* an OUT today counts as present today.
  const isTodayEvent = (s) => { const t = todayStrIST(); return s.in_date === t || s.out_date === t }
  // T5: centre-qualified session identity — two centres can legitimately share
  // one badge number, so presence/session/export must never be keyed on badge
  // alone. The fallback key when the centre is null is the bare badge: legacy
  // rows written before the `sewadar_centre` column existed carry no centre,
  // and dropping them would list genuinely-present sewadars as Absent. Centred
  // sessions are stored ONLY under the qualified key (never also bare), so a
  // bare lookup can only match a centre-less session — presence never leaks
  // across centres. Lookups try the qualified key first, then the bare badge.
  const sessKey = (centre, badge) => (centre ? `${centre}|${badge}` : `${badge}`)
  const presentBadges = useMemo(()=> {
    const set = new Set()
    for (const s of sessions) {
      if (!isTodayEvent(s)) continue
      set.add(sessKey(s.sewadar_centre, s.badge_number))
    }
    return set
  },[sessions])
  // V9: recent scans are ordered by `created_at` desc — NOT by id.
  // fetchAllRows pages by id and ids are not time-ordered, so id order could
  // show a stale session first and (below) keep it for the export's In/Out.
  const recentSessions = useMemo(() => sessions.slice().sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))), [sessions])
  // Latest session per badge today — newest `created_at` wins — used for the
  // export's In/Out columns. Keyed on centre|badge (T5); first-wins over the
  // created_at-desc list keeps the newest row per key (V9).
  const sessionByBadge = useMemo(()=> {
    const m = new Map()
    for (const s of recentSessions) {
      if (!isTodayEvent(s)) continue
      const k = sessKey(s.sewadar_centre, s.badge_number)
      if (!m.has(k)) m.set(k, s)
    }
    return m
  },[recentSessions])
  // T5 lookups: qualified key first, bare badge for centre-less legacy rows.
  const isPresent = useCallback((centre, badge) => presentBadges.has(sessKey(centre, badge)) || presentBadges.has(badge), [presentBadges])
  const sessionFor = useCallback((centre, badge) => sessionByBadge.get(sessKey(centre, badge)) || sessionByBadge.get(badge), [sessionByBadge])
  // Present = at least one session today; Absent = none. Both scoped to the
  // incharge's own departments (myDeployedEnriched), never the raw session list.
  const present = useMemo(()=> myDeployedEnriched.filter(d=> isPresent(d.centre, d.badge_number)),[myDeployedEnriched,isPresent])
  const absentees = useMemo(()=> myDeployedEnriched.filter(d=> !isPresent(d.centre, d.badge_number)),[myDeployedEnriched,isPresent])

  // Centre options come from the rows already in scope — a pure client-side
  // filter over fetched data, so it never widens or fights the RLS gate.
  const centreOptions = useMemo(()=> [...new Set(myDeployedEnriched.map(r=>r.centre).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b))),[myDeployedEnriched])

  const TAB_LABEL = { list:'total', present:'present', absent:'absent' }
  const filteredList = useMemo(()=>{
    const q=search.trim().toLowerCase()
    const arr = tab==='absent' ? absentees : tab==='present' ? present : myDeployedEnriched
    return arr
      .filter(r=> !centreFilter || r.centre===centreFilter)
      .filter(r=> !q || `${r.sewadar_name} ${r.badge_number} ${r.centre}`.toLowerCase().includes(q))
      .sort((a,b)=> a.sewadar_name.localeCompare(b.sewadar_name))
  },[myDeployedEnriched,absentees,present,tab,search,centreFilter])

  const clearManual = useCallback(() => setManualBadge(''), [])

  // Mobile gating lives beside the directory hook (not the render block
  // below) so the hook can read it — same pattern as InchargeScannerPage.
  const isMobile = useIsMobile()

  // Mobile offline-first directory (see ScannerPage) — same hook, same rule.
  const directoryByBadge = useSewadarDirectory({ scheduleId: selectedScheduleId, enabled: isMobile })

  const {
    popup, outTime, setOutTime, closePopup,
    handleScan, handleCameraScan, commitScan, confirmForgot,
    busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  } = useScannerSession({
    scheduleId: selectedScheduleId,
    profile,
    deptName: activeDept ? deptLabel : null,
    deptNameById,
    directoryByBadge,
    toast,
    onAfterScan: refreshSessions,
    forgotSuccessToast: 'OUT closed, now you can IN',
    clearManual,
  })
  void resetBusy

  // Initial queue read (mount only — the drain subscription keeps it fresh
  // after that). A separate effect because load() is defined above the hook
  // call and cannot list refreshQueue in its deps.
  useEffect(()=>{ refreshQueue() },[refreshQueue])

  // ONE queue surface for every scanner role (ScannerPage, InchargeScannerPage
  // and this page): same counts, same failed/orphaned/stranded recoveries,
  // same confirm before dropping unsynced live rows.
  const pendingCount = queued.filter((q) => !q.synced && !q.failed).length
  // isMobile is declared above, beside the directory hook.
  const queueBarNode = (
    <QueueRecoveryBar queued={queued} syncing={syncing} isOnline={isOnline} offline={offline} />
  )
  // One popup node, two layouts: the phone shell renders it as a bottom sheet,
  // the desktop grid renders it centred. Same state, same handlers.
  const scanPopupNode = (
    <ScanResultPopup
      open={!!popup}
      status={popup?.status}
      action={popup?.action}
      badge={popup?.badge}
      name={popup?.name}
      centre={popup?.centre}
      deptName={popup?.deptName}
      time={popup?.time}
      eventDate={popup?.eventDate}
      eventTime={popup?.eventTime}
      message={popup?.message}
      flag={popup?.flag}
      openSince={popup?.openSince}
      outTime={outTime}
      onOutTimeChange={setOutTime}
      onClose={closePopup}
      onConfirm={popup?.status==='forgot' ? confirmForgot : popup?.status==='choose' ? commitScan : closePopup}
    />
  )

  // Sheet name / filename slug per non-scanning tab. `sheet` labels the export,
  // `slug` names the file — both track the tab so an export is self-describing.
  const EXPORT_TABS = { list: { sheet:'Complete List', slug:'complete-list' }, present: { sheet:'Present', slug:'present' }, absent: { sheet:'Absent', slug:'absent' } }

  const exportList = async () => {
    const meta = EXPORT_TABS[tab] || EXPORT_TABS.list
    // Status + In/Out make the three tabs distinguishable in the sheet itself,
    // not just by which file it arrived in.
    const rows=filteredList.map((r,i)=>({
      'S.No.':i+1, Centre:r.centre, Badge:r.badge_number, Name:r.sewadar_name,
      Type: r.is_vss?'VSS':'Regular', Gender:r.gender||'—', Initiated: r.is_initiated?'Yes':'No',
      Dept: r.deptName,
      Status: isPresent(r.centre, r.badge_number)?'Present':'Absent',
      'In Time': sessionFor(r.centre, r.badge_number)?.in_time || '—',
      'Out Time': sessionFor(r.centre, r.badge_number)?.out_time || '—',
    }))
    // The shared driver, like every other export in the app: it slugs the
    // filename, keeps the sheet name inside Excel's 31-char limit, and returns
    // 0 when there is nothing to write. T6: the driver writes whatever name it
    // is given, so the `.xlsx` extension belongs on the caller-built filename.
    const written = await exportWorkbook(`${fileSlug(`${schedule?.name||'schedule'}_${meta.slug}`)}.xlsx`, [
      { name: meta.sheet, rows },
    ])
    if (written === 0) toast.warning('Nothing to export')
    else toast.success('Exported')
  }

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  // A failed load is NOT an empty department. Without this guard the card below
  // was reached on a PGRST202 / RLS denial / dropped connection and told a
  // correctly-provisioned incharge to ask the ASO to re-provision them — the
  // exact opposite of the truth. The error itself is surfaced inline, above,
  // so the last-good lists and the L-43 "showing last data" pin still work.
  if(!myDeptIds.length && !loading && !loadError) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}><AlertTriangle size={22} style={{margin:'0 auto 8px', color:'#b45309'}}/><div style={{fontWeight:700}}>No department assigned</div><div style={{color:'#64748b', fontSize:'0.85rem'}}>Your login is not a Dept Incharge for any department in this schedule. Ask ASO to assign your department from the Users page.</div></div></div>

  return (
    <div className="page" style={{maxWidth:1400}}>
      <div className="page-header" style={{alignItems:'center', gap:'1rem'}}>
        <div style={{flex:'1 1 auto'}}>
          <h2 className="page-title"><ScanLine size={22}/> Dept Incharge{activeDept ? ` — ${deptLabel}` : ''}</h2>
          <div className="page-sub" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            {deptLabel} · {schedule?.name||''}
            {pendingCount > 0 && (
              <span className="pill pill-amber" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
                {syncing ? <RefreshCw size={10} className="spin"/> : <WifiOff size={10}/>}
                {pendingCount} queued
              </span>
            )}
            <span className={`pill ${isOnline?'pill-green':'pill-red'}`} style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
              {isOnline ? <Wifi size={10}/> : <WifiOff size={10}/>}
              {isOnline ? 'Online' : 'Offline'}
            </span>
            {offline && <span style={{fontSize:'0.7rem', color:'#b45309'}}>· refresh failed — showing last data</span>}
            {queueBarNode}
          </div>
          {myDeptIds.length>1 && <select value={activeDept} onChange={e=>{ setActiveDept(e.target.value); setCentreFilter('') }} className="select" style={{marginTop:6}} aria-label="Filter by department">
            <option value="">All my departments ({myDeptIds.length})</option>
            {myDeptIds.map(id=> <option key={id} value={id}>{deptMap.get(id)?.name||id}</option>)}
          </select>}
        </div>
        {/* No Export on the Scanning tab: `exportList` reads `filteredList`, so
            the button used to sit there silently shipping the COMPLETE LIST
            workbook while the operator believed they were exporting the scans
            they were looking at. */}
        {tab !== 'scan' && <button onClick={exportList} className="btn btn-primary" style={{height:36}}><Download size={14}/> Export</button>}
      </div>

      <div style={{display:'flex', gap:6, marginBottom:12, flexWrap:'wrap'}}>
        <button className={`seg-btn ${tab==='scan'?'seg-active':''}`} onClick={()=>setTab('scan')}><ScanLine size={14}/> Scanning</button>
        <button className={`seg-btn ${tab==='list'?'seg-active':''}`} onClick={()=>setTab('list')}><Users size={14}/> Complete list ({myDeployedEnriched.length})</button>
        <button className={`seg-btn ${tab==='present'?'seg-active':''}`} onClick={()=>setTab('present')}><UserCheck size={14}/> Present ({present.length})</button>
        <button className={`seg-btn ${tab==='absent'?'seg-active':''}`} onClick={()=>setTab('absent')}><UserX size={14}/> Absent ({absentees.length})</button>
      </div>

      {tab==='scan' && isMobile && (
        <div className="page" style={{maxWidth:900, margin:'0 auto', padding:0}}>
          <ScanModeShell
            title={<><ScanLine size={22}/> Dept Incharge</>}
            pills={<>{deptLabel} · {schedule?.name||''}</>}
            camera={<BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />}
            action={<button onClick={()=>{ handleScan(manualBadge, { manual: true }) }} className="btn btn-primary scan-shell-go" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark</button>}
            manual={<input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input scan-shell-input" aria-label="Badge number" inputMode="text" enterKeyHint="go" autoComplete="off" autoCapitalize="characters" spellCheck={false} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge, { manual: true }) } }} />}
            feedTitle={<div style={{fontWeight:700, display:'flex', alignItems:'center', gap:6}}><Clock size={14}/> My last 10 scans (today)</div>}
            feed={<MobileScanFeed rows={recentSessions} deptNameById={deptNameById} limit={10} emptyMessage="No scans today" />}
            queueBar={queueBarNode}
            popup={scanPopupNode}
          />
        </div>
      )}

      {tab==='scan' && !isMobile && (
        <div style={{display:'grid', gap:12}}>
          <div className="card" style={{padding:'1rem'}}>
            <BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />
            <div style={{display:'flex', gap:8, marginTop:10}}>
              <input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge, { manual: true }) } }} />
              <button onClick={()=>{ handleScan(manualBadge, { manual: true }) }} className="btn btn-primary" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark</button>
            </div>
          </div>
          <div className="card" style={{padding:'1rem'}}>
            <div className="section-title" style={{display:'flex', alignItems:'center', gap:6}}><Clock size={14}/> Recent scans (today) {pendingCount ? <span className="pill pill-amber">{pendingCount} queued</span>:null}</div>
            <div style={{maxHeight:260, overflow:'auto', marginTop:8}}>
              <RecentScansTable
                rows={recentSessions}
                deptNameById={deptNameById}
                limit={20}
                emptyMessage="No scans today"
              />
            </div>
          </div>
        </div>
      )}

      {(tab==='list' || tab==='present' || tab==='absent') && (
        <div className="card" style={{padding:'1.25rem'}}>
          <div style={{display:'flex', gap:8, alignItems:'center', marginBottom:10, flexWrap:'wrap'}}>
            <div style={{position:'relative', flex:'1 1 200px'}}><Search size={14} style={{position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8'}}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name/badge/centre..." className="input" style={{width:'100%', paddingLeft:30}}/></div>
            <select value={centreFilter} onChange={e=>setCentreFilter(e.target.value)} className="select" style={{flex:'0 0 auto', minWidth:150}} aria-label="Filter by centre">
              <option value="">All centres ({centreOptions.length})</option>
              {centreOptions.map(c=> <option key={c} value={c}>{c}</option>)}
            </select>
            <span style={{fontSize:'0.8rem', color:'#64748b'}}>{filteredList.length} {TAB_LABEL[tab]||'total'}</span>
          </div>
          {centreFilter && <div style={{fontSize:'0.75rem', color:'#b45309', marginBottom:8}}>Centre: <strong>{centreFilter}</strong> · {(tab==='absent'?absentees:tab==='present'?present:myDeployedEnriched).filter(r=>r.centre===centreFilter).length} {TAB_LABEL[tab]||'total'} before search</div>}
          {/* A load failure is a load failure, not a missing assignment. Kept
              inline (not a full-page return) so the last-good lists and the
              L-43 "showing last data" pin still render — the operator can see
              what is stale instead of losing the page. */}
          {loadError && !loading && (
            <div role="alert" style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', background:'#fef2f2', border:'1px solid #fecaca', color:'#b91c1c', borderRadius:8, padding:'0.5rem 0.7rem', marginBottom:8, fontSize:'0.78rem'}}>
              <AlertTriangle size={14}/>
              <span>
                Could not reload your departments: <strong>{loadError}</strong>. This is a load
                failure, not a missing assignment — nothing has been provisioned incorrectly.
              </span>
            </div>
          )}

          {/* Defense in depth (v52). A dept_incharge whose grant RESOLVES but
              whose `deployments` read returns nothing is the signature of an
              un-migrated read policy, NOT of an empty department: `get_my_dept_ids`
              is SECURITY DEFINER and would report the grant fine, while the RLS
              `centre = ANY(get_my_subtree_centres())` arm silently denies every
              row because a dept_incharge has no centre. Say so, instead of
              rendering a calm "No sewadars in this dept". */}
          {myDeptIds.length > 0 && deployments.length === 0 && !loading && !loadError && (
            <div role="status" style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', background:'#fffbeb', border:'1px solid #fde68a', color:'#92400e', borderRadius:8, padding:'0.5rem 0.7rem', marginBottom:8, fontSize:'0.78rem'}}>
              <AlertTriangle size={14}/>
              <span>
                You are assigned to <strong>{myDeptIds.length}</strong> department{myDeptIds.length===1?'':'s'} for this schedule, but
                <strong> no deployments are visible</strong>. Either this department genuinely has nobody deployed to it yet, or the
                database read policy for Dept Incharge has not been updated — ask the ASO office to run
                <code style={{marginLeft:4}}> sql/v52_dept_incharge_read_access.sql</code>.
              </span>
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Centre</th><th>Badge</th><th>Name</th><th>Type</th><th>Gender</th><th>Initiated</th><th>Dept</th><th>Today</th></tr></thead>
              <tbody>
                {filteredList.map((r,i)=> <tr key={`${r.centre}|${r.badge_number}`}><td data-label="#" style={{color:'#94a3b8', fontWeight:600}}>{i+1}</td><td data-label="Centre">{r.centre}</td><td data-label="Badge" style={{fontFamily:'monospace'}}>{r.badge_number} {r.is_vss?<span className="pill pill-amber" style={{fontSize:'0.6rem'}}>VSS</span>:null}</td><td data-label="Name">{r.sewadar_name}</td><td data-label="Type"><span className={`pill ${r.is_vss?'pill-amber':'pill-gray'}`} style={{fontSize:'0.68rem'}}>{r.is_vss?'VSS':'Regular'}</span></td><td data-label="Gender">{r.gender||'—'}</td><td data-label="Initiated">{r.is_initiated?'Yes':'No'}</td><td data-label="Dept"><span className="pill pill-blue">{r.deptName}</span></td><td data-label="Today">{isPresent(r.centre, r.badge_number)?<span className="pill pill-green" style={{fontSize:'0.68rem'}}>Present</span>:<span className="pill pill-gray" style={{fontSize:'0.68rem'}}>Absent</span>}</td></tr>)}
                {filteredList.length===0 && <tr><td colSpan={9} style={{textAlign:'center', color:'#94a3b8', padding:'1rem'}}>{tab==='absent'?'No absentees — everyone has a scan today':tab==='present'?'No one scanned yet today':centreFilter?'No sewadars in this centre':'No sewadars in this dept'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!isMobile && scanPopupNode}
    </div>
  )
}
