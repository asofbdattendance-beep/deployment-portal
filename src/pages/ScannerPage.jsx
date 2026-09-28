import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { getQueuedScans, installDrainListeners, preloadDeployed, clearFailedQueue } from '../lib/offlineQueue'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { useScanHandler } from '../hooks/useScanHandler'
import { friendly, todayStrIST, withTimeout, isDecisionPopup } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import RecentScansTable from '../components/scanner/RecentScansTable'

export default function ScannerPage({ schedules, scheduleId }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [queued, setQueued]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  const [popup, setPopup]=useState(null)
  const [outTime, setOutTime]=useState('')
  // `deployment_departments` id -> name source for the popup's Dept pill and
  // the Dept column of the recent-scans table.
  const [depts, setDepts]=useState([])
  const [syncing, setSyncing]=useState(false)
  const [offline, setOffline]=useState(false)
  const dismissTimerRef = useRef(null)

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
      let q = supabase.from('dp_attendance_sessions').select('*')
        .eq('schedule_id',scheduleId).eq('in_date',todayStrIST())
      if(myBadge) q = q.eq('in_scanner_badge',myBadge)
      const sess = await q
        .order('created_at',{ascending:false}).limit(10)
        .then(r=>r.data||[])
      setSessions(sess)
      setQueued(await getQueuedScans())
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

  useEffect(()=>{ refresh(); refreshDeployments(); refreshDepts() },[refresh, refreshDeployments, refreshDepts])
  const onDrainProgress=useCallback(()=>{
    // Called per queued item — refresh queue count after each sync
    getQueuedScans().then(q=>{ setQueued(q); if(!q.some(x=>!x.synced&&!x.failed)) setSyncing(false) })
  },[])

  useEffect(()=>{
    const off=installDrainListeners(supabase, onDrainProgress)
    return ()=> { off(); if(dismissTimerRef.current) clearTimeout(dismissTimerRef.current) }
  },[onDrainProgress])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  const closePopup=()=> setPopup(null)
  const showPopup=(data)=>{
    if(dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    setPopup(data)
    if (data.status === 'in' || data.status === 'out' || data.status === 'flagged') {
      dismissTimerRef.current=setTimeout(()=> setPopup(null), 2500)
    }
  }

  const { handleScan: rawHandleScan, busy, resetBusy } = useScanHandler({
    scheduleId,
    profile,
    deptName: null,
    deptNameById,
    showPopup,
    toast,
    onQueued: () => getQueuedScans().then(setQueued).catch(e=>console.warn('[Scanner] queue refresh failed:', e?.message)),
    onAfterScan: async () => { try { await refresh(); await refreshDeployments() } catch(e){ console.warn('[Scanner] post-scan refresh failed:', e?.message); setOffline(true) } },
  })

  // keep resetBusy referenced to avoid unused-var lint (hook exposes it for safety timeout)
  void resetBusy

  const handleScan = async (badge, scanOpts) => {
    if(dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    const result = await rawHandleScan(badge, scanOpts)
    if (result?.outTimeDefault) setOutTime(result.outTimeDefault)
    // Clear the manual input only on a successful scan — keep it on failure
    // so the user can retry without retyping. A `confirm_required` return is
    // neither: the operator still has a popup to answer.
    if (result?.ok || result?.outTimeDefault) setManualBadge('')
  }

  // The camera fires on its own — a second badge scanned behind an open
  // decision popup must not silently replace the question the operator is
  // answering (their Confirm click is aimed at the dialog they see). While a
  // confirm/forgot popup is open, camera scans are dropped with a hint;
  // answering it resumes the camera. Manual entry is deliberately NOT gated —
  // it is a deliberate act, and it stays available as the escape hatch.
  // Safe for the camera lifecycle: BarcodeScanner reads onScan through a ref,
  // so a fresh closure per render never restarts the stream.
  const handleCameraScan = (code) => {
    if (isDecisionPopup(popup?.status)) {
      toast.warning('Answer the pending prompt first — camera paused')
      return
    }
    handleScan(code)
  }

  // v44 — Confirm on a toggle gate. `confirmFor` scopes the approval to the
  // direction the question was asked about, and `openId` pins an OUT to the
  // exact session the prompt named, so a state change in between re-asks
  // instead of writing the wrong entry.
  const isConfirm = popup?.status === 'confirm_out' || popup?.status === 'confirm_in'
  const confirmLabel = popup?.status === 'confirm_out' ? 'Yes, mark OUT'
    : popup?.status === 'confirm_in' ? 'Yes, mark IN' : undefined
  const confirmScan = async () => {
    const p = popup
    if (!p) return
    await handleScan(p.badge, {
      confirmed: true,
      confirmFor: p.status === 'confirm_out' ? 'OUT' : 'IN',
      openId: p.openId || null,
      display: { name: p.name, centre: p.centre, deptName: p.deptName },
    })
  }

  const confirmForgot=async()=>{
    if(!popup || popup.status!=='forgot') return
    if(!outTime.match(/^\d{2}:\d{2}$/)){ toast.error('Pick a valid OUT time'); return }
    const ts=new Date(`${popup.in_date}T${outTime}:00+05:30`).toISOString()
    try{
      const { error: forgotError } = await withTimeout(
        supabase.rpc('scan_out', { p_badge: popup.badge, p_schedule: scheduleId, p_ts: ts, p_open_id: popup.openId }),
        8000, 'Close OUT'
      )
      if (forgotError) throw forgotError
      toast.success('OUT closed')
      setPopup(null)
      setOutTime('')
      // `confirmFor: 'IN'` — the operator already decided this OUT, and the next
      // entry is the fresh IN. Scoped to 'IN' so the approval cannot also
      // authorise closing a session that appeared in the 200ms window.
      setTimeout(()=> handleScan(popup.badge, { confirmed: true, confirmFor: 'IN' }), 200)
    }catch(e){ toast.error(friendly(e.message)) }
  }

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
        <BarcodeScanner onScan={handleCameraScan} />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/BH/VS badge" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge, { manual: true }) }}}/><button onClick={()=>{ handleScan(manualBadge, { manual: true }) }} className="btn btn-primary" disabled={busy||!manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark In/Out</button></div>
      </div>
      <div className="card" style={{padding:'1rem'}}>
        <div style={{fontWeight:700, display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
          <Clock size={14}/> My last 10 scans (today, any dept incl. VSS)
          <span style={{fontWeight:400, fontSize:'0.75rem', color:'#64748b'}}>by you{myBadge?` · ${myBadge}`:''}</span>
          {/* E1: failed queue rows are otherwise invisible AND unremovable from this page */}
          {queued.some(q=>q.failed) && <button onClick={async ()=>{ await clearFailedQueue(); getQueuedScans().then(setQueued).catch(e=>console.warn('[Scanner] queue refresh failed:', e?.message)) }} style={{marginLeft:'auto', fontSize:'0.7rem', color:'#b45309', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear failed scans</button>}
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
