import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import QueueRecoveryBar from '../components/mobile/QueueRecoveryBar'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'
import { useScannerSession } from '../hooks/useScannerSession'
import { useIsMobile } from '../hooks/useMediaQuery'
import ScanModeShell from '../components/mobile/ScanModeShell'
import MobileScanFeed from '../components/mobile/MobileScanFeed'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import { useSewadarDirectory } from '../hooks/useSewadarDirectory'
import { useDeptNames, refreshDeptNames } from '../hooks/useDeptNames'
import RecentScansTable from '../components/scanner/RecentScansTable'
import SewadarPicker from '../components/scanner/SewadarPicker'
import PageHeader from '../components/PageHeader'
import KpiTile from '../components/KpiTile'


export default function ScannerPage({ schedules, scheduleId, sewaMode }){
  const { profile } = usePortalAuth()
  const toast=useToast()
  const schedule = schedules.find(s=>s.id===scheduleId)
  const [sessions, setSessions]=useState([])
  const [manualBadge, setManualBadge]=useState('')
  // `deployment_departments` id -> name source for the popup's Dept pill and
  // the Dept column of the recent-scans table. Offline-first: the hook seeds
  // state from the IndexedDB snapshot, so an offline reload still resolves
  // dept names; live rows overwrite and refresh the cache.
  const [depts, syncDepts] = useDeptNames()
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
  // Mobile capture renders the immersive ScanModeShell below; desktop keeps
  // the cards. The scan state machine above is shared by both.
  const isMobile = useIsMobile()

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
      // Either-badge nested or(): an OUT scan by this operator counts even when
      // the IN was done by a different scanner (and vice versa). PostgREST allows
      // one top-level or() — use nested and() groups for the four combinations.
      const badgeOr = myBadge
        ? `(and(in_date.eq.${today},in_scanner_badge.eq.${myBadge}),and(in_date.eq.${today},out_scanner_badge.eq.${myBadge}),and(out_date.eq.${today},in_scanner_badge.eq.${myBadge}),and(out_date.eq.${today},out_scanner_badge.eq.${myBadge}))`
        : `in_date.eq.${today},out_date.eq.${today}`
      // Narrow column list — this is all RecentScansTable + the header read.
      // `select('*')` would also drag in any future fat column on every poll.
      let q = supabase.from('dp_attendance_sessions')
        .select('id,badge_number,sewadar_name,sewadar_dept,in_date,out_date,in_time,out_time,is_vss,undeployed_scan,updated_at')
        .eq('schedule_id',scheduleId).or(badgeOr)
      // supabase-js RESOLVES with { data, error } — it never rejects — so a
      // `.then(r => r.data || [])` here turned a denied/failed read into a
      // calm "No scans by you yet today", and the amber offline pin below
      // could only ever fire on a thrown network error.
      const { data: sess, error: sessError } = await q
        .order('updated_at',{ascending:false}).order('created_at',{ascending:false}).limit(10)
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
    // stableKey 'id': fetchAllRows' contract — keyless paging skips both
    // dedupe and the count-mismatch guard (audit R8). syncDepts only stores
    // non-empty live rows, so an offline/denied fetch keeps cached names.
    await refreshDeptNames(syncDepts)
  },[scheduleId, syncDepts])

  const deptNameById = useMemo(() => deptNameMap(depts), [depts])

  // Mobile offline-first directory: cached identity (name/centre/dept) so
  // the popup names the sewadar with no network and resolves instantly.
  // Enabled on all viewports — dirFor is fallback-only (live data first),
  // so online behaviour is unchanged while desktop offline gains identity.
  const directoryByBadge = useSewadarDirectory({ scheduleId, enabled: true })

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
    directoryByBadge,
    toast,
    onAfterScan: refresh,
    forgotSuccessToast: 'OUT closed',
    clearManual,
  })

  // keep resetBusy referenced to avoid unused-var lint (hook exposes it for safety timeout)
  void resetBusy

  void refreshQueue

  // Initial queue read (mount only — the drain subscription keeps it fresh
  // after that). QueueRecoveryBar owns the stranded poll (it owns those rows).
  useEffect(()=>{ refreshQueue() },[refreshQueue])

  useEffect(()=>{ refresh(); refreshDepts() },[refresh, refreshDepts])
  useEffect(()=>{ const id=setInterval(()=>refresh(),15000); return()=>clearInterval(id) },[refresh])

  if(!schedules.length) return <div className="page"><div className="card" style={{padding:'2rem', textAlign:'center'}}>No schedules</div></div>

  // Shared slots — identical nodes feed the desktop cards and the mobile
  // shell, so both layouts can never disagree about state.
  const pillsNode = (<>
    {sewaMode && (
      <span className={`pill ${sewaMode === 'previsit' ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: '0.7rem' }} title="Recording mode is automatic — the scan date decides whether this counts as Previsit sewa or the Bhati visit">
        {sewaMode === 'previsit' ? 'Previsit sewa' : 'Bhati visit'}
      </span>
    )}
    <span className={`pill ${isOnline ? 'pill-green' : 'pill-red'} queue-pill`}>
      {isOnline ? <Wifi size={10} aria-hidden="true" /> : <WifiOff size={10} aria-hidden="true" />}
      {isOnline ? 'Online' : 'Offline'}
    </span>
    {offline && <span className="queue-stale">· refresh failed — showing last data</span>}
  </>)
  const queueBarNode = (<>
    <QueueRecoveryBar queued={queued} syncing={syncing} isOnline={isOnline} offline={offline} />
    {!myBadge && <div style={{fontSize:'0.75rem', color:'#b45309', marginTop:4}}>Your profile has no badge number, so these cannot be filtered to your own scans — showing today&apos;s sessions.</div>}
  </>)
  const popupNode = (
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
  const manualSubmit = () => { handleScan(manualBadge, { manual: true }) }
  // ASO "mark for anyone": aso/super_admin may start the normal scan flow
  // for any badge without a physical scan. A pick is operator-entered, so
  // it carries the manual flag exactly like a hand-typed badge.
  const canPick = profile?.role === 'aso' || profile?.role === 'super_admin'
  const pickSubmit = (badge) => { handleScan(badge, { manual: true }) }

  // Mobile: immersive full-screen capture. Same state machine, same slots.
  if (isMobile) {
    return (
      <div className="page" style={{ maxWidth: 900, margin: '0 auto' }}>
        <ScanModeShell
          title={<><ScanLine size={22} /> Scanner</>}
          pills={<>{profile?.centre} · {schedule?.name || ''} {pillsNode}</>}
          camera={<BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />}
          action={<button onClick={manualSubmit} className="btn btn-primary scan-shell-go" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark In/Out</button>}
          manual={<>
            <input value={manualBadge} onChange={e => setManualBadge(e.target.value)} placeholder="Manual FB/VS badge" className="input scan-shell-input" aria-label="Badge number" inputMode="text" enterKeyHint="go" autoComplete="off" autoCapitalize="characters" spellCheck={false} onKeyDown={e => { if (e.key === 'Enter') { manualSubmit() } }} />
            {canPick && <SewadarPicker scheduleId={scheduleId} onPick={pickSubmit} />}
          </>}
          queueBar={queueBarNode}
          feedTitle={<div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> My last 10 scans (today)</div>}
          feed={<MobileScanFeed rows={sessions} deptNameById={deptNameById} limit={10} emptyMessage={myBadge ? 'No scans by you yet today' : 'No scans yet'} />}
          popup={popupNode}
        />
      </div>
    )
  }

  return (
    <div className="page" style={{maxWidth:900, margin:'0 auto'}}>
      <PageHeader
        icon={<ScanLine size={22} />}
        title="Scanner"
        sub={`${profile?.centre || ''} · ${schedule?.name || ''}`}
        pills={pillsNode}
      />
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <KpiTile label="Scans today" value={sessions.length} sub="your last 10 shown" />
        <KpiTile label="Queued scans" value={queued.length} sub={syncing ? 'syncing…' : queued.length ? 'waiting for network' : 'nothing waiting'} tone={queued.length ? '#b45309' : undefined} />
      </div>
      <div className="card" style={{padding:'1rem', marginBottom:12}}>
        <div className="card-title" style={{ marginBottom: '0.75rem' }}>New scan</div>
        <BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />
        <div style={{display:'flex', gap:8, marginTop:10}}><input value={manualBadge} onChange={e=>setManualBadge(e.target.value)} placeholder="Manual FB/VS badge" className="input" aria-label="Badge number" inputMode="text" enterKeyHint="go" autoComplete="off" autoCapitalize="characters" spellCheck={false} style={{flex:1}} onKeyDown={e=>{ if(e.key==='Enter'){ manualSubmit() }}}/><button onClick={manualSubmit} className="btn btn-primary" disabled={busy||!manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark In/Out</button></div>
      </div>
      {canPick && <div style={{marginBottom:12}}><SewadarPicker scheduleId={scheduleId} onPick={pickSubmit} /></div>}
      <div className="card" style={{padding:'1rem'}}>
        <div className="card-title" style={{display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
          <Clock size={14}/> My last 10 scans (today, any dept incl. VSS)
          <span style={{fontWeight:400, fontSize:'0.75rem', color:'var(--text-sec)'}}>by you{myBadge?` · ${myBadge}`:''}</span>
          {/* V16: failed/orphaned rows get their own counted clear actions —
              previously only a single uncounted "Clear failed scans" link. */}
        </div>
        {queueBarNode}
        <div style={{maxHeight:380, overflow:'auto', marginTop:8}}>
          <RecentScansTable
            rows={sessions}
            deptNameById={deptNameById}
            limit={10}
            emptyMessage={myBadge ? 'No scans by you yet today' : 'No scans yet'}
          />
        </div>
      </div>

      {popupNode}
    </div>
  )
}
