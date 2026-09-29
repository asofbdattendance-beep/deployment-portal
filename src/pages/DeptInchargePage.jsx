import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { isVssBadge } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import RecentScansTable from '../components/scanner/RecentScansTable'
import { preloadDeployed, clearFailedQueue, clearOrphanedQueue } from '../lib/offlineQueue'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import { useScannerSession } from '../hooks/useScannerSession'
import { ScanLine, Users, UserX, UserCheck, Search, Clock, AlertTriangle, Download, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'

export default function DeptInchargePage({ schedules, scheduleId }) {
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
  const [manualBadge, setManualBadge] = useState('')
  const [search, setSearch] = useState('')
  const [offline, setOffline] = useState(false)
  // popup/outTime/queued/syncing + the scan entry points live in the shared
  // session hook (Phase B task 5) — this page owns loads, lists, tabs, and render.

  const load = useCallback(async () => {
    if (!selectedScheduleId) return
    setLoading(true)
    try {
      const deptIds = await supabase.rpc('get_my_dept_ids', { p_schedule: selectedScheduleId }).then(r=>r.data||[]).catch(()=>[])
      setMyDeptIds(deptIds)
      // Supabase max-rows=1000 — paginate every table that can exceed it.
      // I4: sessions follow the v45 event-date law (IN *or* OUT today counts —
      // in_date-only reads miss overnight sessions and contradict the ASO's
      // Daily tab) and are paginated, not capped: a 200-row cap silently
      // listed everyone past it as Absent on busy days.
      const today = todayStrIST()
      const [deptAll, depAll, vssAll, sewAll, sessAll] = await Promise.all([
        fetchAllRows('deployment_departments', '*', (q) => q.order('name'), 'id'),
        fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', selectedScheduleId), 'id'),
        fetchAllRows('vss_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender, is_active', null, 'badge_number'),
        fetchAllRows('dp_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender', null, ['centre', 'badge_number']),
        fetchAllRows('dp_attendance_sessions', '*', (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id'),
      ])
      setDepts(deptAll||[])
      setDeployments(depAll||[])
      setVss(vssAll||[])
      setSewadars(sewAll||[])
      setSessions(sessAll||[])
      const deployed = (depAll||[]).map(d=>({ badge_number:d.badge_number, deptId: d.deployed_department_id||d.department_id, is_vss: d.badge_number?.startsWith('VS') }))
      await preloadDeployed(selectedScheduleId, deployed)
      await refreshQueue()
      // L-43: the amber "showing last data" pin (line ~289) used to be
      // unreachable from a failed load — success clears it, failure sets it.
      setOffline(false)
    } catch(e){ toast.error(e.message); setOffline(true) } finally{ setLoading(false) }
  }, [selectedScheduleId, toast, refreshQueue])

  // Separate effect for initial dept selection — defaults to ALL of the
  // incharge's departments ('' = every id from get_my_dept_ids), so the three
  // list tabs cover the incharge's whole remit by default.
  useEffect(() => {
    if (myDeptIds.length && activeDept && !myDeptIds.includes(activeDept)) {
      setActiveDept('')
    }
  }, [myDeptIds, activeDept])

  useEffect(()=>{ load() },[load])

  // Light session poll (L-42): the scan tab used to refresh only on
  // mount/after-scan, going stale all day. Polls sessions only — never the
  // full load (which would flash the page spinner every 15s). Same
  // event-date predicate as the initial load (I4); a capped in_date-only
  // refresh would regress the list right after a scan.
  const refreshSessions = useCallback(async () => {
    try {
      const today = todayStrIST()
      const sess = await fetchAllRows('dp_attendance_sessions', '*', (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id')
      setSessions(sess||[])
    } catch(e){ console.warn('[Scanner] post-scan refresh failed:', e?.message); setOffline(true) }
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
  const presentBadges = useMemo(()=> new Set(sessions.filter(isTodayEvent).map(s=>s.badge_number)),[sessions])
  // Latest session per badge today — used for the export's In/Out columns.
  // (fetchAllRows returns id-ascending order, so the newest wins by overwrite.)
  const sessionByBadge = useMemo(()=> {
    const m = new Map()
    sessions.filter(isTodayEvent).forEach(s=>{ m.set(s.badge_number, s) })
    return m
  },[sessions])
  // Present = at least one session today; Absent = none. Both scoped to the
  // incharge's own departments (myDeployedEnriched), never the raw session list.
  const present = useMemo(()=> myDeployedEnriched.filter(d=> presentBadges.has(d.badge_number)),[myDeployedEnriched,presentBadges])
  const absentees = useMemo(()=> myDeployedEnriched.filter(d=> !presentBadges.has(d.badge_number)),[myDeployedEnriched,presentBadges])

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

  const {
    popup, outTime, setOutTime, closePopup,
    handleScan, handleCameraScan, confirmScan, confirmForgot,
    isConfirm, confirmLabel, busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  } = useScannerSession({
    scheduleId: selectedScheduleId,
    profile,
    deptName: activeDept ? deptLabel : null,
    deptNameById,
    toast,
    onAfterScan: refreshSessions,
    forgotSuccessToast: 'OUT closed, now you can IN',
    clearManual,
  })
  void resetBusy

  // Sheet name / filename slug per non-scanning tab. `sheet` labels the export,
  // `slug` names the file — both track the tab so an export is self-describing.
  const EXPORT_TABS = { list: { sheet:'Complete List', slug:'complete-list' }, present: { sheet:'Present', slug:'present' }, absent: { sheet:'Absent', slug:'absent' } }

  const exportList = async () => {
    const meta = EXPORT_TABS[tab] || EXPORT_TABS.list
    const XLSX=await import('xlsx'); const wb=XLSX.utils.book_new()
    // Status + In/Out make the three tabs distinguishable in the sheet itself,
    // not just by which file it arrived in.
    const rows=filteredList.map((r,i)=>({
      'S.No.':i+1, Centre:r.centre, Badge:r.badge_number, Name:r.sewadar_name,
      Type: r.is_vss?'VSS':'Regular', Gender:r.gender||'—', Initiated: r.is_initiated?'Yes':'No',
      Dept: r.deptName,
      Status: presentBadges.has(r.badge_number)?'Present':'Absent',
      'In Time': sessionByBadge.get(r.badge_number)?.in_time || '—',
      'Out Time': sessionByBadge.get(r.badge_number)?.out_time || '—',
    }))
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),meta.sheet)
    XLSX.writeFile(wb, `${schedule?.name||'schedule'}_${meta.slug}.xlsx`)
  }

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>
  if(!myDeptIds.length && !loading) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}><AlertTriangle size={22} style={{margin:'0 auto 8px', color:'#b45309'}}/><div style={{fontWeight:700}}>Not a Dept Incharge for this schedule</div><div style={{color:'#64748b', fontSize:'0.85rem'}}>Ask ASO to select you as incharge for a department.</div></div></div>

  return (
    <div className="page" style={{maxWidth:1400}}>
      <div className="page-header" style={{alignItems:'center', gap:'1rem'}}>
        <div style={{flex:'1 1 auto'}}>
          <h2 className="page-title"><ScanLine size={22}/> Dept Incharge{activeDept ? ` — ${deptLabel}` : ''}</h2>
          <div className="page-sub" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            {profile?.centre} · {schedule?.name||''}
            {queued.filter(q=>!q.synced&&!q.failed).length > 0 && (
              <span className="pill pill-amber" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
                {syncing ? <RefreshCw size={10} className="spin"/> : <WifiOff size={10}/>}
                {queued.filter(q=>!q.synced&&!q.failed).length} queued
              </span>
            )}
            <span className={`pill ${navigator.onLine?'pill-green':'pill-red'}`} style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
              {navigator.onLine ? <Wifi size={10}/> : <WifiOff size={10}/>}
              {navigator.onLine ? 'Online' : 'Offline'}
            </span>
            {offline && <span style={{fontSize:'0.7rem', color:'#b45309'}}>· refresh failed — showing last data</span>}
            {queued.some(q=>q.failed) && <button onClick={async ()=>{ await clearFailedQueue(); await clearOrphanedQueue(); refreshQueue() }} style={{fontSize:'0.7rem', color:'#b45309', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear failed scans</button>}
          </div>
          {myDeptIds.length>1 && <select value={activeDept} onChange={e=>{ setActiveDept(e.target.value); setCentreFilter('') }} className="select" style={{marginTop:6}} aria-label="Filter by department">
            <option value="">All my departments ({myDeptIds.length})</option>
            {myDeptIds.map(id=> <option key={id} value={id}>{deptMap.get(id)?.name||id}</option>)}
          </select>}
        </div>
        <button onClick={exportList} className="btn btn-primary" style={{height:36}}><Download size={14}/> Export</button>
      </div>

      <div style={{display:'flex', gap:6, marginBottom:12, flexWrap:'wrap'}}>
        <button className={`seg-btn ${tab==='scan'?'seg-active':''}`} onClick={()=>setTab('scan')}><ScanLine size={14}/> Scanning</button>
        <button className={`seg-btn ${tab==='list'?'seg-active':''}`} onClick={()=>setTab('list')}><Users size={14}/> Complete list ({myDeployedEnriched.length})</button>
        <button className={`seg-btn ${tab==='present'?'seg-active':''}`} onClick={()=>setTab('present')}><UserCheck size={14}/> Present ({present.length})</button>
        <button className={`seg-btn ${tab==='absent'?'seg-active':''}`} onClick={()=>setTab('absent')}><UserX size={14}/> Absent ({absentees.length})</button>
      </div>

      {tab==='scan' && (
        <div style={{display:'grid', gap:12}}>
          <div className="card" style={{padding:'1rem'}}>
            <BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />
            <div style={{display:'flex', gap:8, marginTop:10}}>
              <input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge, { manual: true }) } }} />
              <button onClick={()=>{ handleScan(manualBadge, { manual: true }) }} className="btn btn-primary" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark</button>
            </div>
          </div>
          <div className="card" style={{padding:'1rem'}}>
            <div className="section-title" style={{display:'flex', alignItems:'center', gap:6}}><Clock size={14}/> Recent scans (today) {queued.length? <span className="pill pill-amber">{queued.length} queued</span>:null}</div>
            <div style={{maxHeight:260, overflow:'auto', marginTop:8}}>
              <RecentScansTable
                rows={sessions}
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
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Centre</th><th>Badge</th><th>Name</th><th>Type</th><th>Gender</th><th>Initiated</th><th>Dept</th><th>Today</th></tr></thead>
              <tbody>
                {filteredList.map((r,i)=> <tr key={r.badge_number}><td style={{color:'#94a3b8', fontWeight:600}}>{i+1}</td><td>{r.centre}</td><td style={{fontFamily:'monospace'}}>{r.badge_number} {r.is_vss?<span className="pill pill-amber" style={{fontSize:'0.6rem'}}>VSS</span>:null}</td><td>{r.sewadar_name}</td><td><span className={`pill ${r.is_vss?'pill-amber':'pill-gray'}`} style={{fontSize:'0.68rem'}}>{r.is_vss?'VSS':'Regular'}</span></td><td>{r.gender||'—'}</td><td>{r.is_initiated?'Yes':'No'}</td><td><span className="pill pill-blue">{r.deptName}</span></td><td>{presentBadges.has(r.badge_number)?<span className="pill pill-green" style={{fontSize:'0.68rem'}}>Present</span>:<span className="pill pill-gray" style={{fontSize:'0.68rem'}}>Absent</span>}</td></tr>)}
                {filteredList.length===0 && <tr><td colSpan={9} style={{textAlign:'center', color:'#94a3b8', padding:'1rem'}}>{tab==='absent'?'No absentees — everyone has a scan today':tab==='present'?'No one scanned yet today':centreFilter?'No sewadars in this centre':'No sewadars in this dept'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ScanResultPopup
        open={!!popup}
        status={popup?.status}
        badge={popup?.badge}
        name={popup?.name}
        centre={popup?.centre}
        deptName={popup?.deptName}
        time={popup?.time}
        message={popup?.message}
        flag={popup?.flag}
        openSince={popup?.openSince}
        outTime={outTime}
        onOutTimeChange={setOutTime}
        onClose={closePopup}
        confirmLabel={confirmLabel}
        onConfirm={popup?.status==='forgot' ? confirmForgot : isConfirm ? confirmScan : closePopup}
      />
    </div>
  )
}
