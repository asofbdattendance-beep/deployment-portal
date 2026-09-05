import { useState, useEffect, useCallback } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { BADGE_REGEX } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { enqueueScan, getQueuedScans, installDrainListeners, preloadDeployed } from '../lib/offlineQueue'
import { ScanLine, Clock, AlertTriangle } from 'lucide-react'

function todayStrIST(){ const d=new Date(); return new Date(d.toLocaleString('en-US',{timeZone:'Asia/Kolkata'})).toISOString().slice(0,10) }
function friendly(m){ const s=String(m||''); if(s.includes('Invalid badge')) return 'Invalid badge format'; if(s.includes('Badge not found')) return 'Badge not found in sewadars/VSS'; if(s.includes('No open session')) return 'No open session to close'; if(s.includes('Not authorized')) return 'Not authorized to scan'; if(s.includes('Already IN')) return 'Already checked IN — please OUT first'; return s||'Scan failed — try again' }

export default function ScannerPage({ schedules, scheduleId }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [queued, setQueued]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  const [busy, setBusy]=useState(false)
  const [popup, setPopup]=useState(null)
  const [outTime, setOutTime]=useState('')

  const refresh=useCallback(async()=>{
    if(!scheduleId) return
    const sess=await supabase.from('dp_attendance_sessions').select('*').eq('schedule_id',scheduleId).eq('in_date',todayStrIST()).order('created_at',{ascending:false}).limit(30).then(r=>r.data||[])
    setSessions(sess)
    setQueued(await getQueuedScans())
    const dep=await fetchAllRows('deployments', 'badge_number, department_id, deployed_department_id', (q) => q.eq('schedule_id',scheduleId))
    preloadDeployed(scheduleId, (dep||[]).map(d=>({badge_number:d.badge_number, deptId:d.deployed_department_id||d.department_id, is_vss: d.badge_number?.startsWith('VS')})))
  },[scheduleId])

  useEffect(()=>{ refresh() },[refresh])
  useEffect(()=>{ const off=installDrainListeners(supabase, ()=>getQueuedScans().then(setQueued)); return off },[])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  const closePopup=()=> setPopup(null)
  const showPopup=(data)=>{
    setPopup(data)
    if(['in','out','flagged','queued','offline'].includes(data.status)) setTimeout(()=> setPopup(null), 2500)
  }

  const handleScan=async(badge)=>{
    if(busy) return
    const b=String(badge).trim().toUpperCase()
    if(!b) return
    if(!BADGE_REGEX.test(b)){
      showPopup({ status:'error', badge:b, message:'Invalid badge format — check FB/BH/VS', time: new Date().toLocaleTimeString() })
      return
    }
    setBusy(true)
    let ts
    try{
      const open=await supabase.rpc('get_open_session',{p_badge:b, p_schedule:scheduleId}).then(r=>r.data).catch(()=>null)
      if(open){
        const inTs=new Date(`${open.in_date}T${open.in_time}+05:30`).getTime()
        const hrs=(Date.now()-inTs)/3600000
        if(hrs>12){
          setPopup({ status:'forgot', badge:b, name: open.sewadar_name, centre: open.centre, openSince:`${open.in_date} ${open.in_time}`, openId: open.id, in_date: open.in_date })
          setOutTime(new Date().toISOString().slice(11,16))
          return
        }
        ts=new Date().toISOString()
        try{ const {error}=await supabase.rpc('scan_out',{p_badge:b,p_schedule:scheduleId,p_ts:ts,p_open_id:open.id}); if(error) throw error; showPopup({ status:'out', badge:b, name: open.sewadar_name, centre: open.centre, time: new Date().toLocaleTimeString(), message:'OUT marked' }); toast.success(`OUT ${b}`) }catch(e){
          const msg=String(e.message||'')
          if(!navigator.onLine || msg.includes('Failed to fetch')){ await enqueueScan({badge:b,schedule_id:scheduleId,action:'OUT',ts,open_id:open.id,centre:profile?.centre}); showPopup({ status:'queued', badge:b, time: new Date().toLocaleTimeString(), message:'Queued offline — will sync when online' }); toast.success(`OUT queued (offline) ${b}`) } else { showPopup({ status:'error', badge:b, message: friendly(msg), time: new Date().toLocaleTimeString() }); toast.error(friendly(msg)) }
        }
      } else {
        ts=new Date().toISOString()
        try{ const {data,error}=await supabase.rpc('scan_in',{p_badge:b,p_schedule:scheduleId,p_ts:ts,p_centre:profile?.centre}); if(error) throw error; const flag=data?.undeployed? ' Flagged: not deployed':''; showPopup({ status: data?.undeployed ? 'flagged' : 'in', badge:b, time: new Date().toLocaleTimeString(), flag: data?.undeployed ? 'Not deployed — flagged' : null, message:`IN marked${flag}` }); toast[data?.undeployed?'warning':'success'](`IN ${b}${flag}`) }catch(e){
          const msg=String(e.message||'')
          if(msg.includes('Already IN')){
            const fresh=await supabase.rpc('get_open_session',{p_badge:b,p_schedule:scheduleId}).then(r=>r.data).catch(()=>null)
            if(fresh){ setPopup({ status:'forgot', badge:b, name: fresh.sewadar_name, centre: fresh.centre, openSince:`${fresh.in_date} ${fresh.in_time}`, openId: fresh.id, in_date: fresh.in_date }); setOutTime(new Date().toISOString().slice(11,16)); return }
            showPopup({ status:'error', badge:b, message:'Already checked IN — please OUT first', time: new Date().toLocaleTimeString() }); toast.error('Already IN — OUT first')
          } else if(!navigator.onLine || msg.includes('Failed to fetch')){ await enqueueScan({badge:b,schedule_id:scheduleId,action:'IN',ts,centre:profile?.centre}); showPopup({ status:'queued', badge:b, time: new Date().toLocaleTimeString(), message:'Queued offline — will sync when online' }); toast.success(`IN queued (offline) ${b}`) } else { showPopup({ status:'error', badge:b, message: friendly(msg), time: new Date().toLocaleTimeString() }); toast.error(friendly(msg)) }
        }
      }
      refresh()
    } finally{ setBusy(false); setQueued(await getQueuedScans()) }
  }

  const confirmForgot=async()=>{
    if(!popup || popup.status!=='forgot') return
    if(!outTime.match(/^\d{2}:\d{2}$/)){ toast.error('Pick a valid OUT time'); return }
    const ts=new Date(`${popup.in_date}T${outTime}:00+05:30`).toISOString()
    const badgeToIn = popup.badge
    try{ await supabase.rpc('scan_out',{p_badge:badgeToIn,p_schedule:scheduleId,p_ts:ts,p_open_id:popup.openId}); toast.success('OUT closed'); setPopup(null); setOutTime(''); setTimeout(()=> handleScan(badgeToIn), 200) }catch(e){ toast.error(friendly(e.message)) }
  }

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  return (
    <div className="page" style={{maxWidth:900, margin:'0 auto'}}>
      <div className="page-header"><div><h2 className="page-title"><ScanLine size={22}/> Scanner — Faridabad</h2><div className="page-sub">{profile?.centre} · {schedule?.name||''} · {queued.filter(q=>!q.synced&&!q.failed).length?`${queued.length} queued (jammer) · `:''}{navigator.onLine?'Online':'Offline'}</div></div></div>
      <div className="card" style={{padding:'1rem', marginBottom:12}}>
        <BarcodeScanner onScan={handleScan} debug />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/BH/VS badge" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge); setManualBadge('') }}}/><button onClick={()=>{ handleScan(manualBadge); setManualBadge('') }} className="btn btn-primary" disabled={busy||!manualBadge.trim()}>{busy?'...':'Mark In/Out'}</button></div>
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
