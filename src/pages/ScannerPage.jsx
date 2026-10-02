import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import { clearFailedQueue, clearLiveQueue, clearOrphanedQueue, listStrandedQueue, removeQueued } from '../lib/offlineQueue'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { useScannerSession } from '../hooks/useScannerSession'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import RecentScansTable from '../components/scanner/RecentScansTable'

// V16: canonical "terminally failed" / orphan predicates, mirrored from
// offlineQueue (which owns the definitions but does not export them —
// isFailedRow there is module-private). A failed row carries `failed: true`
// (v1) or `status: 'failed'` (newer); an orphaned row is a NON-failed row with
// a null owner that no drain will ever consume (see clearOrphanedQueue).
const isFailedQueueRow = (r) => !!r && (r.status === 'failed' || r.failed === true)
const isOrphanedQueueRow = (r) => !isFailedQueueRow(r) && (r.owner ?? null) === null && !r.synced

export default function ScannerPage({ schedules, scheduleId, sewaMode }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  // `deployment_departments` id -> name source for the popup's Dept pill and
  // the Dept column of the recent-scans table.
  const [depts, setDepts]=useState([])
  const [offline, setOffline]=useState(false)
  // Reactive connectivity — `navigator.onLine` read at render time never
  // updates, so the Online/Offline pill used to go stale until some other
  // state change re-rendered the page.
  const [isOnline, setIsOnline]=useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(()=>{
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  },[])
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
      // Narrow column list — this is all RecentScansTable + the header read.
      // `select('*')` would also drag in any future fat column on every poll.
      let q = supabase.from('dp_attendance_sessions')
        .select('id,badge_number,sewadar_name,sewadar_dept,in_date,out_date,in_time,out_time,is_vss,undeployed_scan')
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
    handleScan, handleCameraScan, commitScan, confirmForgot,
    busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  } = useScannerSession({
    scheduleId,
    profile,
    deptName: null,
    deptNameById,
    toast,
    onAfterScan: refresh,
    forgotSuccessToast: 'OUT closed',
    clearManual,
  })

  // keep resetBusy referenced to avoid unused-var lint (hook exposes it for safety timeout)
  void resetBusy

  // V16: queue counts surfaced in the header + recent-scans card. Pending rows
  // drive the queued pill/spinner; failed and orphaned rows are otherwise
  // invisible AND unremovable from this page, so each gets its own pill with a
  // wired clear action. The live count excludes failed AND orphaned/stranded
  // rows (same filtered definition as DeptInchargePage) — they are shown
  // separately instead of inflating the sync pill.
  const pendingCount = queued.filter(q => !q.synced && !isFailedQueueRow(q) && !isOrphanedQueueRow(q)).length
  const failedCount = queued.filter(isFailedQueueRow).length
  const orphanedCount = queued.filter(isOrphanedQueueRow).length
  const clearFailed = useCallback(async () => { await clearFailedQueue(); refreshQueue() }, [refreshQueue])
  const clearOrphaned = useCallback(async () => { await clearOrphanedQueue(); refreshQueue() }, [refreshQueue])
  // Cap policy: confirmed bulk-delete of the current owner's live rows only
  // (failed rows keep their own clear; other users' rows are never touched).
  const clearLive = useCallback(async () => {
    if (!window.confirm(`Delete ${pendingCount} live queued scan(s)? They have NOT synced — only do this for duplicate or test rows.`)) return
    await clearLiveQueue(); refreshQueue()
  }, [refreshQueue, pendingCount])

  // T10 stranded scans: live null-owner rows are invisible to getQueuedScans
  // while logged in and are never drained — surface them here with per-row
  // manual Clear. Never auto-drained or auto-deleted (cross-user safety).
  const [stranded, setStranded] = useState([])
  const refreshStranded = useCallback(async () => {
    try { setStranded(await listStrandedQueue() || []) }
    catch (e) { console.warn('[Scanner] stranded refresh failed:', e?.message) }
  }, [])
  const clearOneStranded = useCallback(async (id) => { await removeQueued(id); refreshStranded() }, [refreshStranded])

  // Initial queue read (mount only — the drain subscription keeps it fresh
  // after that) plus a 30s stranded re-check (same cadence as
  // DeptInchargePage). A separate effect because refresh() is defined above the
  // hook call and cannot list refreshQueue in its deps.
  useEffect(()=>{ refreshQueue(); refreshStranded() },[refreshQueue, refreshStranded])
  useEffect(()=>{ const id=setInterval(()=>refreshStranded(),30000); return()=>clearInterval(id) },[refreshStranded])

  useEffect(()=>{ refresh(); refreshDepts() },[refresh, refreshDepts])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  return (
    <div className="page" style={{maxWidth:900, margin:'0 auto'}}>
      <div className="page-header"><div><h2 className="page-title"><ScanLine size={22}/> Scanner</h2><div className="page-sub" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
        {profile?.centre} · {schedule?.name||''}
        {sewaMode && (
          <span className={`pill ${sewaMode === 'previsit' ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: '0.7rem' }} title="Recording mode is automatic — the scan date decides whether this counts as Previsit sewa or the Bhati visit">
            {sewaMode === 'previsit' ? 'Previsit sewa' : 'Bhati visit'}
          </span>
        )}
        {pendingCount > 0 && (
          <span className="pill pill-amber" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
            {syncing ? <RefreshCw size={10} className="spin"/> : <WifiOff size={10}/>}
            {pendingCount} queued
          </span>
        )}
        {failedCount > 0 && (
          <span className="pill pill-red" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
            {failedCount} failed
          </span>
        )}
        {orphanedCount > 0 && (
          <span className="pill pill-gray" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
            {orphanedCount} orphaned
          </span>
        )}
        {stranded.length > 0 && (
          <span className="pill pill-red" style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
            {stranded.length} stranded
          </span>
        )}
        <span className={`pill ${isOnline?'pill-green':'pill-red'}`} style={{fontSize:'0.7rem',display:'inline-flex',alignItems:'center',gap:4}}>
          {isOnline ? <Wifi size={10}/> : <WifiOff size={10}/>}
          {isOnline ? 'Online' : 'Offline'}
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
          {/* V16: failed/orphaned rows get their own counted clear actions —
              previously only a single uncounted "Clear failed scans" link. */}
          {failedCount > 0 && <button onClick={clearFailed} style={{marginLeft:'auto', fontSize:'0.7rem', color:'#b91c1c', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear failed ({failedCount})</button>}
          {pendingCount > 0 && <button onClick={clearLive} style={{marginLeft: failedCount > 0 ? 0 : 'auto', fontSize:'0.7rem', color:'#b45309', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear live queued ({pendingCount})</button>}
          {orphanedCount > 0 && <button onClick={clearOrphaned} style={{marginLeft: (failedCount > 0 || pendingCount > 0) ? 0 : 'auto', fontSize:'0.7rem', color:'#64748b', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear orphaned ({orphanedCount})</button>}
        </div>
        {/* T10: stranded scans — queued while logged out / session-blip, never
            auto-synced. Each row is cleared manually; nothing here deletes. */}
        {stranded.length > 0 && (
          <div style={{marginTop:8, padding:'8px 10px', border:'1px solid #fecaca', borderRadius:8, background:'#fef2f2'}}>
            <div style={{fontSize:'0.75rem', fontWeight:700, color:'#b91c1c'}}>Stranded scans ({stranded.length}) — queued with no owner, never auto-sync</div>
            {stranded.map(r => (
              <div key={r.id} style={{display:'flex', alignItems:'center', gap:6, fontSize:'0.75rem', color:'#7f1d1d', marginTop:4}}>
                <span>{r.badge || '?'} · {r.action || 'IN'}</span>
                <button onClick={() => clearOneStranded(r.id)} style={{marginLeft:'auto', fontSize:'0.7rem', color:'#b91c1c', background:'none', border:'none', padding:0, cursor:'pointer', textDecoration:'underline'}}>Clear</button>
              </div>
            ))}
          </div>
        )}
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
        action={popup?.action}
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
        onConfirm={popup?.status==='forgot' ? confirmForgot : popup?.status==='choose' ? commitScan : closePopup}
      />
    </div>
  )
}
