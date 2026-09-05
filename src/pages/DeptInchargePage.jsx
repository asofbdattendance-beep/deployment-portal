import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { isVssBadge, BADGE_REGEX } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { enqueueScan, getQueuedScans, installDrainListeners, preloadDeployed } from '../lib/offlineQueue'
import { ScanLine, Users, UserX, Search, Clock, AlertTriangle, Download } from 'lucide-react'

function todayStrIST() {
  const d = new Date()
  const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  return ist.toISOString().slice(0,10)
}

function friendly(msg) {
  const m = String(msg || '')
  if (m.includes('Invalid badge')) return 'Invalid badge format'
  if (m.includes('Badge not found')) return 'Badge not found in sewadars/VSS'
  if (m.includes('No open session')) return 'No open session to close'
  if (m.includes('Not authorized')) return 'Not authorized to scan'
  if (m.includes('Already IN')) return 'Already checked IN — please OUT first'
  return m || 'Scan failed — try again'
}

export default function DeptInchargePage({ schedules, scheduleId }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const selectedScheduleId = scheduleId
  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const [tab, setTab] = useState('scan') // scan | list | absentees
  const [myDeptIds, setMyDeptIds] = useState([])
  const [activeDept, setActiveDept] = useState('')
  const [depts, setDepts] = useState([])
  const [, setCentres] = useState([])
  const [deployments, setDeployments] = useState([])
  const [sewadars, setSewadars] = useState([])
  const [vss, setVss] = useState([])
  const [, setConsents] = useState([])
  const [sessions, setSessions] = useState([])
  const [queued, setQueued] = useState([])
  const [loading, setLoading] = useState(true)
  const [manualBadge, setManualBadge] = useState('')
  const [scanBusy, setScanBusy] = useState(false)
  const [popup, setPopup] = useState(null) // { status, badge, name, centre, deptName, time, message, flag, openSince, outTime }
  const [outTime, setOutTime] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (!selectedScheduleId) return
    setLoading(true)
    try {
      const deptIds = await supabase.rpc('get_my_dept_ids', { p_schedule: selectedScheduleId }).then(r=>r.data||[]).catch(()=>[])
      setMyDeptIds(deptIds)
      if (deptIds.length && !activeDept) setActiveDept(deptIds[0])
      // Supabase max-rows=1000 — paginate every table that can exceed it (attendance_sessions intentionally stays capped at 200)
      const [deptAll, centreAll, depAll, vssAll, sewAll, consAll, sessRes] = await Promise.all([
        fetchAllRows('deployment_departments', '*', (q) => q.order('name')),
        fetchAllRows('dp_centres', 'name, parent_centre', (q) => q.order('name')),
        fetchAllRows('deployments', '*', (q) => q.eq('schedule_id', selectedScheduleId)),
        fetchAllRows('vss_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender, is_active', null),
        fetchAllRows('dp_sewadars', 'badge_number, sewadar_name, centre, is_initiated, gender', null),
        fetchAllRows('sewadar_consents', '*', (q) => q.eq('schedule_id', selectedScheduleId)),
        supabase.from('dp_attendance_sessions').select('*').eq('schedule_id', selectedScheduleId).eq('in_date', todayStrIST()).order('created_at', { ascending:false }).limit(200),
      ])
      setDepts(deptAll||[])
      setCentres(centreAll||[])
      setDeployments(depAll||[])
      setVss(vssAll||[])
      setSewadars(sewAll||[])
      setConsents(consAll||[])
      setSessions(sessRes.data||[])
      const deployed = (depAll||[]).map(d=>({ badge_number:d.badge_number, deptId: d.deployed_department_id||d.department_id, is_vss: d.badge_number?.startsWith('VS') }))
      preloadDeployed(selectedScheduleId, deployed)
      const q = await getQueuedScans()
      setQueued(q||[])
    } catch(e){ toast.error(e.message) } finally{ setLoading(false) }
  }, [selectedScheduleId, activeDept, toast])

  useEffect(()=>{ load() },[load])
  useEffect(()=>{ const off=installDrainListeners(supabase, ()=>getQueuedScans().then(setQueued)); return off },[])

  const deptMap = useMemo(()=>{ const m=new Map(); depts.forEach(d=>m.set(d.id,d)); return m },[depts])
  const swMap = useMemo(()=>{ const m={}; [...sewadars,...vss].forEach(s=>{m[s.badge_number]=s}); return m },[sewadars,vss])
  const effectiveDept = (d)=> d.deployed_department_id || d.department_id

  const myDept = activeDept || myDeptIds[0] || ''
  const myDeptName = deptMap.get(myDept)?.name || '—'

  const myDeployed = useMemo(()=> deployments.filter(d=> effectiveDept(d)===myDept),[deployments,myDept])
  const myDeployedEnriched = useMemo(()=> myDeployed.map(d=>{
    const sw=swMap[d.badge_number]||{}
    return { ...d, sewadar_name: d.sewadar_name||sw.sewadar_name||'—', centre: d.centre, is_vss: isVssBadge(d.badge_number), is_initiated: !!sw.is_initiated, gender: sw.gender||'' }
  }),[myDeployed,swMap])

  const presentBadges = useMemo(()=> new Set(sessions.filter(s=>s.in_date===todayStrIST()).map(s=>s.badge_number)),[sessions])
  const absentees = useMemo(()=> myDeployedEnriched.filter(d=> !presentBadges.has(d.badge_number)),[myDeployedEnriched,presentBadges])

  const filteredList = useMemo(()=>{
    const q=search.trim().toLowerCase()
    const arr = tab==='absentees' ? absentees : myDeployedEnriched
    return arr.filter(r=> !q || `${r.sewadar_name} ${r.badge_number} ${r.centre}`.toLowerCase().includes(q))
      .sort((a,b)=> a.sewadar_name.localeCompare(b.sewadar_name))
  },[myDeployedEnriched,absentees,tab,search])

  const getSewadarMeta = useCallback((badge) => {
    const sw = swMap[badge] || {}
    const dep = deployments.find(d=> d.badge_number===badge)
    return {
      name: dep?.sewadar_name || sw.sewadar_name || '',
      centre: dep?.centre || sw.centre || '',
      deptName: myDeptName,
    }
  }, [swMap, deployments, myDeptName])

  const closePopup = useCallback(()=> setPopup(null), [])
  const showPopup = useCallback((data) => {
    setPopup(data)
    // auto-dismiss success/queued after 2.5s, keep error/forgot
    if (['in','out','flagged','queued','offline'].includes(data.status)) {
      setTimeout(()=> setPopup(null), 2500)
    }
  }, [])

  const handleScan = async (badge) => {
    if (scanBusy) return
    const b=String(badge).trim().toUpperCase()
    if(!b) return
    if(!BADGE_REGEX.test(b)){
      const meta = getSewadarMeta(b)
      showPopup({ status:'error', badge:b, name: meta.name, centre: meta.centre, deptName: myDeptName, message:'Invalid badge format — check FB/BH/VS', time: new Date().toLocaleTimeString() })
      return
    }
    setScanBusy(true)
    let ts
    try{
      const open = await supabase.rpc('get_open_session', { p_badge:b, p_schedule:selectedScheduleId }).then(r=>r.data).catch(()=>null)
      if(open){
        const inTs=new Date(`${open.in_date}T${open.in_time}+05:30`).getTime()
        const hrs=(Date.now()-inTs)/3600000
        if(hrs>12){
          const meta = getSewadarMeta(b)
          setPopup({ status:'forgot', badge:b, name: meta.name || open.sewadar_name, centre: meta.centre || open.centre, deptName: myDeptName, openSince:`${open.in_date} ${open.in_time}`, openId: open.id, in_date: open.in_date })
          setOutTime(new Date().toISOString().slice(11,16))
          return
        }
        ts=new Date().toISOString()
        try{
          const { error } = await supabase.rpc('scan_out', { p_badge:b, p_schedule:selectedScheduleId, p_ts: ts, p_open_id: open.id })
          if(error) throw error
          const meta = getSewadarMeta(b)
          showPopup({ status:'out', badge:b, name: meta.name || open.sewadar_name, centre: meta.centre || open.centre, deptName: myDeptName, time: new Date().toLocaleTimeString(), message:`OUT marked` })
          toast.success(`OUT marked for ${b}`)
        }catch(e){
          const msg=String(e.message||'')
          if(!navigator.onLine || msg.includes('Failed to fetch')){
            await enqueueScan({ badge:b, schedule_id:selectedScheduleId, action:'OUT', ts, open_id: open.id, centre: profile?.centre })
            const meta = getSewadarMeta(b)
            showPopup({ status:'queued', badge:b, name: meta.name, centre: meta.centre, deptName: myDeptName, time: new Date().toLocaleTimeString(), message:'Queued offline — will sync when online' })
            toast.success(`OUT queued (offline) for ${b}`)
          } else {
            const meta = getSewadarMeta(b)
            showPopup({ status:'error', badge:b, name: meta.name, centre: meta.centre, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      } else {
        ts=new Date().toISOString()
        try{
          const { error, data } = await supabase.rpc('scan_in', { p_badge:b, p_schedule:selectedScheduleId, p_ts: ts, p_centre: profile?.centre })
          if(error) throw error
          const undeployed = data?.undeployed
          const meta = getSewadarMeta(b)
          if(undeployed){
            showPopup({ status:'flagged', badge:b, name: meta.name, centre: meta.centre, deptName: myDeptName, time: new Date().toLocaleTimeString(), flag:'Not deployed to your dept — flagged', message:`IN marked but not deployed to ${myDeptName}` })
            toast.warning(`Marked IN but not deployed to ${myDeptName} — flagged`)
          } else {
            showPopup({ status:'in', badge:b, name: meta.name, centre: meta.centre, deptName: myDeptName, time: new Date().toLocaleTimeString(), message:'IN marked' })
            toast.success(`IN marked for ${b}`)
          }
        }catch(e){
          const msg=String(e.message||'')
          if(msg.includes('Already IN')){
            const fresh = await supabase.rpc('get_open_session',{p_badge:b,p_schedule:selectedScheduleId}).then(r=>r.data).catch(()=>null)
            if(fresh){
              const meta = getSewadarMeta(b)
              setPopup({ status:'forgot', badge:b, name: meta.name || fresh.sewadar_name, centre: meta.centre || fresh.centre, deptName: myDeptName, openSince:`${fresh.in_date} ${fresh.in_time}`, openId: fresh.id, in_date: fresh.in_date })
              setOutTime(new Date().toISOString().slice(11,16))
              return
            }
            const meta = getSewadarMeta(b)
            showPopup({ status:'error', badge:b, name: meta.name, centre: meta.centre, message:'Already checked IN — please OUT first', time: new Date().toLocaleTimeString() })
            toast.error('Already IN — OUT first')
          } else if(!navigator.onLine || msg.includes('Failed to fetch')){
            await enqueueScan({ badge:b, schedule_id:selectedScheduleId, action:'IN', ts, centre: profile?.centre, dept: myDept })
            const meta = getSewadarMeta(b)
            showPopup({ status:'queued', badge:b, name: meta.name, centre: meta.centre, deptName: myDeptName, time: new Date().toLocaleTimeString(), message:'Queued offline — will sync when online' })
            toast.success(`IN queued (offline) for ${b}`)
          } else {
            const meta = getSewadarMeta(b)
            showPopup({ status:'error', badge:b, name: meta.name, centre: meta.centre, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      }
      const sess=await supabase.from('dp_attendance_sessions').select('*').eq('schedule_id',selectedScheduleId).eq('in_date',todayStrIST()).order('created_at',{ascending:false}).limit(200).then(r=>r.data||[])
      setSessions(sess)
    } finally{ setScanBusy(false); setQueued(await getQueuedScans()) }
  }

  const confirmForgotOut = async () => {
    if(!popup || popup.status!=='forgot') return
    if(!outTime.match(/^\d{2}:\d{2}$/)){ toast.error('Pick a valid OUT time'); return }
    const ts=new Date(`${popup.in_date}T${outTime}:00+05:30`).toISOString()
    const badgeToIn = popup.badge
    try{
      await supabase.rpc('scan_out', { p_badge: badgeToIn, p_schedule:selectedScheduleId, p_ts: ts, p_open_id: popup.openId })
      toast.success('OUT closed, now you can IN')
      setPopup(null)
      setOutTime('')
      // directly IN (don't re-show forgot)
      setTimeout(()=> handleScan(badgeToIn), 200)
    }catch(e){ toast.error(friendly(e.message)) }
  }

  const exportList = async () => {
    const XLSX=await import('xlsx'); const wb=XLSX.utils.book_new()
    const rows=filteredList.map((r,i)=>({ 'S.No.':i+1, Centre:r.centre, Badge:r.badge_number, Name:r.sewadar_name, Type: r.is_vss?'VSS':'Regular', Gender:r.gender||'—', Initiated: r.is_initiated?'Yes':'No', Dept: myDeptName }))
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows), tab==='absentees'?'Absentees':'My Dept')
    XLSX.writeFile(wb, `${schedule?.name||'schedule'}_${tab}.xlsx`)
  }

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>
  if(!myDeptIds.length && !loading) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}><AlertTriangle size={22} style={{margin:'0 auto 8px', color:'#b45309'}}/><div style={{fontWeight:700}}>Not a Dept Incharge for this schedule</div><div style={{color:'#64748b', fontSize:'0.85rem'}}>Ask ASO to select you as incharge for a department.</div></div></div>

  return (
    <div className="page" style={{maxWidth:1400}}>
      <div className="page-header" style={{alignItems:'center', gap:'1rem'}}>
        <div style={{flex:'1 1 auto'}}>
          <h2 className="page-title"><ScanLine size={22}/> Dept Incharge — {myDeptName}</h2>
          <div className="page-sub">{profile?.centre} · {schedule?.name||''} {queued.filter(q=>!q.synced&&!q.failed).length?`· ${queued.length} queued (jammer)` : ''} · {navigator.onLine?'Online':'Offline'}</div>
          {myDeptIds.length>1 && <select value={myDept} onChange={e=>setActiveDept(e.target.value)} className="select" style={{marginTop:6}}>{myDeptIds.map(id=> <option key={id} value={id}>{deptMap.get(id)?.name||id}</option>)}</select>}
        </div>
        <button onClick={exportList} className="btn btn-primary" style={{height:36}}><Download size={14}/> Export</button>
      </div>

      <div style={{display:'flex', gap:6, marginBottom:12}}>
        <button className={`seg-btn ${tab==='scan'?'seg-active':''}`} onClick={()=>setTab('scan')}><ScanLine size={14}/> Scanning</button>
        <button className={`seg-btn ${tab==='list'?'seg-active':''}`} onClick={()=>setTab('list')}><Users size={14}/> My Dept ({myDeployedEnriched.length})</button>
        <button className={`seg-btn ${tab==='absentees'?'seg-active':''}`} onClick={()=>setTab('absentees')}><UserX size={14}/> Absentees ({absentees.length})</button>
      </div>

      {tab==='scan' && (
        <div style={{display:'grid', gap:12}}>
          <div className="card" style={{padding:'1rem'}}>
            <BarcodeScanner onScan={handleScan} debug />
            <div style={{display:'flex', gap:8, marginTop:10}}>
              <input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input" style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ handleScan(manualBadge); setManualBadge('') } }} />
              <button onClick={()=>{ handleScan(manualBadge); setManualBadge('') }} className="btn btn-primary" disabled={scanBusy || !manualBadge.trim()}>{scanBusy?'...':'Mark'}</button>
            </div>
          </div>
          <div className="card" style={{padding:'1rem'}}>
            <div className="section-title" style={{display:'flex', alignItems:'center', gap:6}}><Clock size={14}/> Recent scans (today) {queued.length? <span className="pill pill-amber">{queued.length} queued</span>:null}</div>
            <div style={{maxHeight:260, overflow:'auto', marginTop:8}}>
              <table className="table">
                <thead><tr><th>Badge</th><th>Name</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
                <tbody>
                  {sessions.slice(0,20).map(s=> <tr key={s.id}><td style={{fontFamily:'monospace'}}>{s.badge_number} {s.is_vss?<span className="pill pill-amber" style={{fontSize:'0.6rem'}}>VSS</span>:null} {s.undeployed_scan?<span className="pill pill-red" style={{fontSize:'0.6rem'}}>Flagged</span>:null}</td><td>{s.sewadar_name}</td><td>{s.in_time}</td><td>{s.out_time||'—'}</td><td><span className={`pill ${s.status==='OPEN'?'pill-green':'pill-gray'}`}>{s.status}</span></td></tr>)}
                  {sessions.length===0 && <tr><td colSpan={5} style={{textAlign:'center', color:'#94a3b8', padding:'1rem'}}>No scans today</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {(tab==='list' || tab==='absentees') && (
        <div className="card" style={{padding:'1.25rem'}}>
          <div style={{display:'flex', gap:8, alignItems:'center', marginBottom:10}}>
            <div style={{position:'relative', flex:'1 1 200px'}}><Search size={14} style={{position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8'}}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name/badge/centre..." className="input" style={{width:'100%', paddingLeft:30}}/></div>
            <span style={{fontSize:'0.8rem', color:'#64748b'}}>{filteredList.length} {tab==='absentees'?'absent':'total'}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Centre</th><th>Badge</th><th>Name</th><th>Type</th><th>Gender</th><th>Initiated</th><th>Dept</th></tr></thead>
              <tbody>
                {filteredList.map((r,i)=> <tr key={r.badge_number}><td style={{color:'#94a3b8', fontWeight:600}}>{i+1}</td><td>{r.centre}</td><td style={{fontFamily:'monospace'}}>{r.badge_number} {r.is_vss?<span className="pill pill-amber" style={{fontSize:'0.6rem'}}>VSS</span>:null}</td><td>{r.sewadar_name}</td><td><span className={`pill ${r.is_vss?'pill-amber':'pill-gray'}`} style={{fontSize:'0.68rem'}}>{r.is_vss?'VSS':'Regular'}</span></td><td>{r.gender||'—'}</td><td>{r.is_initiated?'Yes':'No'}</td><td><span className="pill pill-blue">{myDeptName}</span></td></tr>)}
                {filteredList.length===0 && <tr><td colSpan={8} style={{textAlign:'center', color:'#94a3b8', padding:'1rem'}}>{tab==='absentees'?'No absentees — all scanned!' : 'No sewadars in this dept'}</td></tr>}
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
        onConfirm={popup?.status==='forgot' ? confirmForgotOut : closePopup}
      />
    </div>
  )
}
