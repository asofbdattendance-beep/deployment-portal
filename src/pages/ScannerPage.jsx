import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import { enqueueScan, getQueuedScans, installDrainListeners, preloadDeployed } from '../lib/offlineQueue'
import { ScanLine, Clock, AlertTriangle, X } from 'lucide-react'

function todayStrIST(){ const d=new Date(); return new Date(d.toLocaleString('en-US',{timeZone:'Asia/Kolkata'})).toISOString().slice(0,10) }

export default function ScannerPage({ schedules, scheduleId }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [queued, setQueued]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  const [busy, setBusy]=useState(false)
  const [last, setLast]=useState(null)
  const [showOut, setShowOut]=useState(null)
  const [outTime, setOutTime]=useState('')

  const refresh=useCallback(async()=>{
    if(!scheduleId) return
    const sess=await supabase.from('attendance_sessions').select('*').eq('schedule_id',scheduleId).eq('in_date',todayStrIST()).order('created_at',{ascending:false}).limit(30).then(r=>r.data||[])
    setSessions(sess)
    setQueued(await getQueuedScans())
    const dep=await supabase.from('deployments').select('badge_number, department_id, deployed_department_id').eq('schedule_id',scheduleId).then(r=>r.data||[])
    preloadDeployed(scheduleId, dep.map(d=>({badge_number:d.badge_number, deptId:d.deployed_department_id||d.department_id, is_vss: d.badge_number?.startsWith('VS')})))
  },[scheduleId])

  useEffect(()=>{ refresh() },[refresh])
  useEffect(()=>{ const off=installDrainListeners(supabase, ()=>getQueuedScans().then(setQueued)); return off },[])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  const handleScan=async(badge)=>{
    const b=String(badge).trim().toUpperCase()
    if(!b) return
    if(!/^(FB(597[1-9]|59[89]\d|600\d|601[01])(GA|LA)|BH\d{4}[A-Z]{1,2}\d{4}|VS[A-Z0-9]+)$/i.test(b)){ toast.error('Invalid badge format'); setLast({badge:b, ok:false, msg:'Invalid format'}); return }
    setBusy(true)
    try{
      const open=await supabase.rpc('get_open_session',{p_badge:b, p_schedule:scheduleId}).then(r=>r.data).catch(()=>null)
      if(open){
        const inTs=new Date(`${open.in_date}T${open.in_time}`)
        const hrs=(Date.now()-inTs.getTime())/3600000
        if(hrs>12){ setShowOut({badge:b, openId:open.id, in_time:`${open.in_date} ${open.in_time}`}); setOutTime(new Date().toISOString().slice(11,16)); setBusy(false); return }
        const ts=new Date().toISOString()
        try{ const {error}=await supabase.rpc('scan_out',{p_badge:b,p_schedule:scheduleId,p_ts:ts}); if(error) throw error; toast.success(`OUT ${b}`); setLast({badge:b, ok:true, action:'OUT', time:new Date().toLocaleTimeString()}) }catch(e){
          if(!navigator.onLine || String(e.message).includes('Failed to fetch')){ await enqueueScan({badge:b,schedule_id:scheduleId,action:'OUT',ts,open_id:open.id,centre:profile?.centre}); toast.success(`OUT queued (offline) ${b}`); setLast({badge:b, ok:true, action:'OUT (queued)'}) } else throw e
        }
      } else {
        const ts=new Date().toISOString()
        try{ const {data,error}=await supabase.rpc('scan_in',{p_badge:b,p_schedule:scheduleId,p_ts:ts,p_centre:profile?.centre}); if(error) throw error; const flag=data?.undeployed? ' Flagged: not deployed':''; toast.success(`IN ${b}${flag}`); setLast({badge:b, ok:true, action:'IN'+flag, time:new Date().toLocaleTimeString()}) }catch(e){
          const msg=String(e.message||'')
          if(msg.includes('Already IN')){ toast.error('Already IN — OUT first'); setLast({badge:b,ok:false,msg:'Already IN'}) }
          else if(!navigator.onLine || msg.includes('Failed to fetch')){ await enqueueScan({badge:b,schedule_id:scheduleId,action:'IN',ts,centre:profile?.centre}); toast.success(`IN queued (offline) ${b}`); setLast({badge:b,ok:true,action:'IN (queued)'}) }
          else { toast.error(msg); setLast({badge:b,ok:false,msg}) }
        }
      }
      refresh()
    } finally{ setBusy(false); setQueued(await getQueuedScans()) }
  }

  const confirmForgot=async()=>{
    const ts=new Date(`${todayStrIST()}T${outTime}:00+05:30`).toISOString()
    try{ await supabase.rpc('scan_out',{p_badge:showOut.badge,p_schedule:scheduleId,p_ts:ts,p_open_id:showOut.openId}); toast.success('OUT closed'); setShowOut(null); handleScan(showOut.badge) }catch(e){ toast.error(e.message) }
  }

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  return (
    <div className="page" style={{maxWidth:900, margin:'0 auto'}}>
      <div className="page-header"><div><h2 className="page-title"><ScanLine size={22}/> Scanner — Faridabad</h2><div className="page-sub">{profile?.centre} · {schedule?.name||''} · {queued.filter(q=>!q.synced&&!q.failed).length?`${queued.length} queued (jammer) · `:''}{navigator.onLine?'Online':'Offline'}</div></div></div>
      <div className="card" style={{padding:'1rem', marginBottom:12}}>
        <BarcodeScanner onScan={handleScan} />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/BH/VS badge" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge); setManualBadge('') }}}/><button onClick={()=>{ handleScan(manualBadge); setManualBadge('') }} className="btn btn-primary" disabled={busy||!manualBadge.trim()}>{busy?'...':'Mark In/Out'}</button></div>
        {last && <div style={{marginTop:8, padding:'0.6rem 0.8rem', borderRadius:8, background:last.ok?'#ecfdf5':'#fef2f2', border:`1px solid ${last.ok?'#a7f3d0':'#fecaca'}`, fontSize:'0.85rem'}}>{last.badge} — {last.action||last.msg} {last.time?`· ${last.time}`:''}</div>}
        {showOut && <div style={{marginTop:10, background:'#fffbeb', border:'1px solid #fde68a', borderRadius:10, padding:'0.9rem'}}><div style={{fontWeight:700, marginBottom:6}}>Forgot OUT — open since {showOut.in_time}</div><div style={{display:'flex', gap:8}}><input type="time" value={outTime} onChange={e=>setOutTime(e.target.value)} className="input"/><button onClick={confirmForgot} className="btn btn-primary">Close OUT then IN</button><button onClick={()=>setShowOut(null)} className="btn"><X size={14}/> Cancel</button></div></div>}
        {queued.filter(q=>!q.failed).length>0 && <div style={{marginTop:8, fontSize:'0.78rem', color:'#b45309', display:'flex', alignItems:'center', gap:6}}><AlertTriangle size={12}/> {queued.length} scans queued due to jammer — will sync when online</div>}
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
    </div>
  )
}
