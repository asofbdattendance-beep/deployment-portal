import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { preloadDeployed, clearFailedQueue, clearOrphanedQueue } from '../lib/offlineQueue'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { useScannerSession } from '../hooks/useScannerSession'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import RecentScansTable from '../components/scanner/RecentScansTable'

export default function ScannerPage({ schedules, scheduleId }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  // `deployment_departments` id -> name source for the popup's Dept pill and
  // the Dept column of the recent-scans table.
  const [depts, setDepts]=useState([])
  const [offline, setOffline]=useState(false)
  // popup/outTime/queued/syncing + the scan entry points live in the shared
  // session hook (Phase B task 5) — this page owns loads, lists, and render.

  // The badge that the server stamps onto every IN as `in_scanner_badge`
  // (populated from portal_users.badge_number for auth.uid()).
  const myBadge = profile?.badge_number || null

  const refresh=useCallback(async()=>{
    if(!scheduleId) return
    try {
      // "My last 10 scans" — scope to the sessions THIS user checked in.
      // Filtered on `in_scanner_badge`, not `in_scanner_name`: the badge is
      // the stable identity, the display name is neither unique nor immutable.
      // Skipped when the profile carries no badge (an `.eq(col, null)` would
      // match nothing and hide every scan) — the table then says so.
      // L-41: v45 event-date law (IN *or* OUT today counts), matching the
      // Incharge page and the Daily tab — in_date-only reads miss overnight
      // sessions (IN yesterday, OUT today).
      const today = todayStrIST()
      let q = supabase.from('dp_attendance_sessions').select('*')
        .eq('schedule_id',scheduleId).or(`in_date.eq.${today},out_date.eq.${today}`)
      if(myBadge) q = q.eq('in_scanner_badge',myBadge)
      // supabase-js RESOLVES with { data, error } — it never rejects — so a
      // `.then(r => r.data || [])` here turned a denied/failed read into a
      // calm "No scans by you yet today", and the amber offline pin below
      // could only ever fire on a thrown network error.
      const { data: sess, error: sessError } = await q
        .order('created_at',{ascending:false}).limit(10)
      if (sessError) throw new Error(`Recent scans: ${sessError.message || sessError.code || 'failed'}`)
      setSessions(Array.isArray(sess) ? sess : [])
      setOffline(false)
    } catch(e){ console.warn('[Scanner] session refresh failed — keeping last data:', e?.message); setOffline(true) }
  },[scheduleId,myBadge])

  const refreshDeployments=useCallback(async()=>{
    if(!scheduleId) return
    try {
      const dep = await fetchAllRows('deployments', 'badge_number, department_id, deployed_department_id',
        (q) => q.eq('schedule_id',scheduleId), 'id')
      await preloadDeployed(scheduleId, (dep||[]).map(d=>({
        badge_number:d.badge_number,
        deptId:d.deployed_department_id||d.department_id,
        is_vss: d.badge_number?.startsWith('VS'),
      })))
    } catch(e){ console.warn('[Scanner] deployment preload failed:', e?.message) }
  },[scheduleId])

  // Departments are a global reference list (not per-schedule), but this is
  // loaded per schedule like every other load here so a schedule change re-reads
  // it — the map is reference data a scan resolves against, so a stale map would
  // show a raw-uuid-free em dash instead of a department name.
  const refreshDepts=useCallback(async()=>{
    if(!scheduleId) return
    try {
      setDepts(await fetchAllRows('deployment_departments', 'id, name') || [])
    } catch(e){ console.warn('[Scanner] department load failed:', e?.message) }
  },[scheduleId])

  const deptNameById = useMemo(() => deptNameMap(depts), [depts])

  const clearManual = useCallback(() => setManualBadge(''), [])

  const {
    popup, outTime, setOutTime, closePopup,
    handleScan, handleCameraScan, confirmScan, confirmForgot,
    isConfirm, confirmLabel, busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  } = useScannerSession({
    scheduleId,
    profile,
    deptName: null,
    deptNameById,
    toast,
    onAfterScan: async () => { try { await refresh(); await refreshDeployments() } catch(e){ console.warn('[Scanner] post-scan refresh failed:', e?.message); setOffline(true) } },
    forgotSuccessToast: 'OUT closed',
    clearManual,
  })

  // keep resetBusy referenced to avoid unused-var lint (hook exposes it for safety timeout)
  void resetBusy

  // Initial queue read (mount only — the drain subscription keeps it fresh
  // after that). A separate effect because refresh() is defined above the
  // hook call and cannot list refreshQueue in its deps.
  useEffect(()=>{ refreshQueue() },[refreshQueue])

  useEffect(()=>{ refresh(); refreshDeployments(); refreshDepts() },[refresh, refreshDeployments, refreshDepts])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  return (
    <div className="page" style={{maxWidth:900, margin:'0 auto'}}>
      <div className="page-header"><div><h2 className="page-title"><ScanLine size={22}/> Scanner</h2><div className="page-sub" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
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
      </div></div></div>
      <div className="card" style={{padding:'1rem', marginBottom:12}}>
        <BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/BH/VS badge" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge, { manual: true }) }}}/><button onClick={()=>{ handleScan(manualBadge, { manual: true }) }} className="btn btn-primary" disabled={busy||!manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark In/Out</button></div>
      </div>
      <div className="card" style={{padding:'1rem'}}>
        <div style={{fontWeight:700, display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
          <Clock size={14}/> My last 10 scans (today, any dept incl. VSS)
          <span style={{fontWeight:400, fontSize:'0.75rem', color:'#64748b'}}>by you{myBadge?` · ${myBadge}`:''}</span>
          {/* E1: failed queue rows are otherwise invisible AND unremovable from this page */}
          {queued.some(q=>q.failed) && <button onClick={async ()=>{ await clearFailedQueue(); await clearOrphanedQueue(); refreshQueue() }} style={{marginLeft:'auto', fontSize:'0.7rem', color:'#b45309', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear failed scans</button>}
        </div>
        {!myBadge && <div style={{fontSize:'0.75rem', color:'#b45309', marginTop:4}}>Your profile has no badge number, so these cannot be filtered to your own scans — showing today&apos;s sessions.</div>}
        <div style={{maxHeight:380, overflow:'auto', marginTop:8}}>
          <RecentScansTable
            rows={sessions}
            deptNameById={deptNameById}
            limit={10}
            emptyMessage={myBadge ? 'No scans by you yet today' : 'No scans yet'}
          />
        </div>
      </div>

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
