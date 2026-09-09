import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { getQueuedScans, installDrainListeners, preloadDeployed } from '../lib/offlineQueue'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { useScanHandler } from '../hooks/useScanHandler'
import { friendly, todayStrIST, withTimeout } from '../lib/scannerUtils'

export default function ScannerPage({ schedules, scheduleId }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [queued, setQueued]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  const [popup, setPopup]=useState(null)
  const [outTime, setOutTime]=useState('')
  const [syncing, setSyncing]=useState(false)
  const dismissTimerRef = useRef(null)

  const refresh=useCallback(async()=>{
    if(!scheduleId) return
    const sess = await supabase.from('dp_attendance_sessions').select('*')
      .eq('schedule_id',scheduleId).eq('in_date',todayStrIST())
      .order('created_at',{ascending:false}).limit(30)
      .then(r=>r.data||[])
    setSessions(sess)
    setQueued(await getQueuedScans())
  },[scheduleId])

  const refreshDeployments=useCallback(async()=>{
    if(!scheduleId) return
    const dep = await fetchAllRows('deployments', 'badge_number, department_id, deployed_department_id',
      (q) => q.eq('schedule_id',scheduleId))
    preloadDeployed(scheduleId, (dep||[]).map(d=>({
      badge_number:d.badge_number,
      deptId:d.deployed_department_id||d.department_id,
      is_vss: d.badge_number?.startsWith('VS'),
    })))
  },[scheduleId])

  useEffect(()=>{ refresh(); refreshDeployments() },[refresh, refreshDeployments])
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

  const { handleScan: rawHandleScan, getBusy, resetBusy } = useScanHandler({
    scheduleId,
    profile,
    deptName: null,
    showPopup,
    toast,
    onQueued: () => getQueuedScans().then(setQueued),
    onAfterScan: async () => { refresh(); refreshDeployments() },
  })

  // keep resetBusy referenced to avoid unused-var lint (hook exposes it for safety timeout)
  void resetBusy

  const handleScan = async (badge) => {
    if(dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    const result = await rawHandleScan(badge)
    if (result?.outTimeDefault) setOutTime(result.outTimeDefault)
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
      setTimeout(()=> handleScan(popup.badge), 200)
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
      </div></div></div>
      <div className="card" style={{padding:'1rem', marginBottom:12}}>
        <BarcodeScanner onScan={handleScan} />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/BH/VS badge" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge); setManualBadge('') }}}/><button onClick={()=>{ handleScan(manualBadge); setManualBadge('') }} className="btn btn-primary" disabled={getBusy()||!manualBadge.trim()}>{getBusy() ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark In/Out</button></div>
      </div>
      <div className="card" style={{padding:'1rem'}}>
        <div style={{fontWeight:700, display:'flex', alignItems:'center', gap:6}}><Clock size={14}/> Recent scans (today, any dept incl. VSS)</div>
        <div style={{maxHeight:380, overflow:'auto', marginTop:8}}>
          <table className="table"><thead><tr><th>Badge</th><th>Name</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
          <tbody>
            {sessions.map(s=> <tr key={s.id}><td style={{fontFamily:'monospace'}}>{s.badge_number} {s.is_vss?<span className="pill pill-amber" style={{fontSize:'0.6rem'}}>VSS</span>:null} {s.undeployed_scan?<span className="pill pill-red" style={{fontSize:'0.6rem'}}>Flagged</span>:null}</td><td>{s.sewadar_name}</td><td>{s.in_time}</td><td>{s.out_time||'—'}</td><td><span className={`pill ${s.status==='OPEN'?'pill-green':'pill-gray'}`}>{s.status}</span></td></tr>)}
            {sessions.length===0 && <tr><td colSpan={5} style={{textAlign:'center', color:'#94a3b8', padding:'1rem'}}>No scans yet</td></tr>}
          </tbody></table>
        </div>
      </div>

      <ScanResultPopup
        open={!!popup}
        status={popup?.status}
        badge={popup?.badge}
        name={popup?.name}
        centre={popup?.centre}
        time={popup?.time}
        message={popup?.message}
        flag={popup?.flag}
        openSince={popup?.openSince}
        outTime={outTime}
        onOutTimeChange={setOutTime}
        onClose={closePopup}
        onConfirm={popup?.status==='forgot' ? confirmForgot : closePopup}
      />
    </div>
  )
}
