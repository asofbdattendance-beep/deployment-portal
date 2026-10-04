import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { fetchAllRows } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import BarcodeScanner from '../components/scanner/BarcodeScanner'
import ScanResultPopup from '../components/scanner/ScanResultPopup'
import RecentScansTable from '../components/scanner/RecentScansTable'
import { todayStrIST } from '../lib/scannerUtils'
import { deptNameMap } from '../lib/scanDisplay'
import { useScannerSession } from '../hooks/useScannerSession'
import { useSewadarDirectory } from '../hooks/useSewadarDirectory'
import { useDeptNames } from '../hooks/useDeptNames'
import PageHeader from '../components/PageHeader'
import KpiTile from '../components/KpiTile'
import QueueRecoveryBar from '../components/mobile/QueueRecoveryBar'
import { useIsMobile } from '../hooks/useMediaQuery'
import ScanModeShell from '../components/mobile/ScanModeShell'
import MobileScanFeed from '../components/mobile/MobileScanFeed'
import { ScanLine, Clock, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react'

// Narrow session columns — this is all RecentScansTable reads. Same list as
// DeptInchargePage (V9: `created_at` is load-bearing — recent scans are ordered
// by it, not id; T5: `sewadar_centre` is load-bearing).
const SESSION_COLS = 'id,badge_number,sewadar_name,sewadar_centre,sewadar_dept,in_date,out_date,in_time,out_time,is_vss,undeployed_scan,created_at'

// InchargeScannerPage — the scanner-only page for the dept_incharge
// Attendance tab. Scan wiring mirrors DeptInchargePage's scan tab
// (useScannerSession + BarcodeScanner + manual entry + ScanResultPopup +
// RecentScansTable); there are no list tabs, no export, no centre filter.
export default function InchargeScannerPage({ schedules = [], scheduleId, sewaMode }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const selectedScheduleId = scheduleId
  const schedule = schedules.find(s => s.id === selectedScheduleId)
  // Offline-first department names (popup Dept pill + recent-scans table):
  // cached snapshot first, live rows overwrite + refresh the cache.
  const [depts, syncDepts] = useDeptNames()
  const [sessions, setSessions] = useState([])
  const [manualBadge, setManualBadge] = useState('')
  const [offline, setOffline] = useState(false)
  // Reactive connectivity — `navigator.onLine` read at render time never
  // updates, so the Online/Offline pill used to go stale until some other
  // state change re-rendered the page.
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  // A slow load for schedule A must never land after a fast one for schedule B
  // and overwrite its rows — every sibling page sequences its loads.
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  // T3: the schedule whose rows are currently rendered. On a schedule switch
  // the rows are cleared immediately (see the effect below) so stale rows
  // never survive until the new load lands.
  const [rowsScheduleId, setRowsScheduleId] = useState(selectedScheduleId)

  const load = useCallback(async () => {
    if (!selectedScheduleId) return
    const seq = ++seqRef.current
    // T3: every setter below is gated on this — a slow schedule-A load that
    // resolves after the schedule-B load must not touch rows.
    const alive = () => mountedRef.current && seq === seqRef.current
    try {
      const today = todayStrIST()
      // I4: v45 event-date law (IN *or* OUT today counts — in_date-only reads
      // miss overnight sessions and contradict the ASO's Daily tab).
      const [deptAll, sessAll] = await Promise.all([
        fetchAllRows('deployment_departments', 'id,name', (q) => q.order('name'), 'id'),
        fetchAllRows('dp_attendance_sessions', SESSION_COLS, (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id'),
      ])
      if (!alive()) return
      // syncDepts ignores empty live results so an offline/denied fetch
      // keeps the cached department names.
      syncDepts(deptAll)
      setSessions(sessAll || [])
      setOffline(false)
    } catch (e) {
      if (!alive()) return
      console.warn('[InchargeScanner] load failed:', e?.message)
      setOffline(true)
    }
  }, [selectedScheduleId, syncDepts])

  // Light session poll (L-42): refresh sessions only — never the full load.
  // Same event-date predicate as the initial load (I4); sequenced like the
  // load so a slow poll cannot overwrite a newer one.
  const refreshSessions = useCallback(async () => {
    if (!selectedScheduleId) return
    const seq = ++seqRef.current
    const alive = () => mountedRef.current && seq === seqRef.current
    try {
      const today = todayStrIST()
      const sess = await fetchAllRows('dp_attendance_sessions', SESSION_COLS, (q) => q.eq('schedule_id', selectedScheduleId).or(`in_date.eq.${today},out_date.eq.${today}`), 'id')
      if (!alive()) return
      setSessions(sess || [])
      setOffline(false)
    } catch (e) {
      if (!alive()) return
      console.warn('[Scanner] post-scan refresh failed:', e?.message)
      setOffline(true)
    }
  }, [selectedScheduleId])
  useEffect(() => { const id = setInterval(() => refreshSessions(), 15000); return () => clearInterval(id) }, [refreshSessions])

  // T3: clear stale rows the moment the schedule changes — before the new
  // load lands. Declared before the load effect so the clear runs first.
  useEffect(() => {
    if (rowsScheduleId !== selectedScheduleId) {
      // Departments are global reference data — never cleared on a schedule
      // switch (the cached names stay valid); only schedule-scoped rows reset.
      setSessions([])
      setManualBadge('')
      setRowsScheduleId(selectedScheduleId)
    }
  }, [selectedScheduleId, rowsScheduleId])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  // id -> department NAME, for the scan popup and the Recent scans table.
  const deptNameById = useMemo(() => deptNameMap(depts), [depts])

  // V9: recent scans are ordered by `created_at` desc — NOT by id.
  // fetchAllRows pages by id and ids are not time-ordered.
  const recentSessions = useMemo(() => sessions.slice().sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))), [sessions])

  const clearManual = useCallback(() => setManualBadge(''), [])

  // Mobile capture renders the immersive ScanModeShell below; desktop keeps
  // the cards. Declared here (not with the render block below) so the
  // mobile-gated directory hook can read it.
  const isMobile = useIsMobile()

  // Mobile offline-first directory (see ScannerPage) — same hook, same rule.
  // Enabled on all viewports: fallback-only, so online behaviour is
  // unchanged while desktop offline gains popup identity.
  const directoryByBadge = useSewadarDirectory({ scheduleId: selectedScheduleId, enabled: true })

  const {
    popup, outTime, setOutTime, closePopup,
    handleScan, handleCameraScan, commitScan, confirmForgot,
    busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  } = useScannerSession({
    scheduleId: selectedScheduleId,
    profile,
    deptName: null,
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
  useEffect(() => { refreshQueue() }, [refreshQueue])

  const pendingCount = queued.filter(q => !q.synced && !q.failed).length
  // Failed / orphaned / stranded rows used to be invisible AND unrecoverable
  // for a dept_incharge — they could see "N queued" with no way out. The shared
  // bar gives this role the same four recoveries the scanner role has.
  const queueBarNode = (
    <QueueRecoveryBar queued={queued} syncing={syncing} isOnline={isOnline} offline={offline} />
  )
  // Mobile capture renders the immersive ScanModeShell below; desktop keeps
  // the cards. The scan state machine above is shared by both (isMobile is
  // declared above, beside the directory hook).

  if (!schedules.length) return <div className="page"><div className="card" style={{ padding: '2rem', textAlign: 'center' }}>No schedules</div></div>

  const pillsNode = (<>
    {schedule?.name || ''}
    {sewaMode && (
      <span className={`pill ${sewaMode === 'previsit' ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: '0.7rem' }} title="Recording mode is automatic — the scan date decides whether this counts as Previsit sewa or the Bhati visit">
        {sewaMode === 'previsit' ? 'Previsit sewa' : 'Bhati visit'}
      </span>
    )}
    <span className={`pill ${isOnline ? 'pill-green' : 'pill-red'}`} style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {isOnline ? <Wifi size={10} /> : <WifiOff size={10} />}
      {isOnline ? 'Online' : 'Offline'}
    </span>
    {offline && <span style={{ fontSize: '0.7rem', color: '#b45309' }}>· refresh failed — showing last data</span>}
  </>)
  const manualSubmit = () => { handleScan(manualBadge, { manual: true }) }
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
      onConfirm={popup?.status === 'forgot' ? confirmForgot : popup?.status === 'choose' ? commitScan : closePopup}
    />
  )

  // Mobile: immersive full-screen capture. Same state machine, same slots.
  if (isMobile) {
    return (
      <div className="page" style={{ maxWidth: 900 }}>
        <ScanModeShell
          title={<><ScanLine size={22} /> Attendance</>}
          pills={pillsNode}
          camera={<BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />}
          action={<button onClick={manualSubmit} className="btn btn-primary scan-shell-go" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark</button>}
          manual={<input value={manualBadge} onChange={e => setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input scan-shell-input" aria-label="Badge number" inputMode="text" enterKeyHint="go" autoComplete="off" autoCapitalize="characters" spellCheck={false} onKeyDown={e => { if (e.key === 'Enter') { manualSubmit() } }} />}
          feedTitle={<div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> Recent scans (today) {pendingCount ? <span className="pill pill-amber">{pendingCount} queued</span> : null}</div>}
          feed={<MobileScanFeed rows={recentSessions} deptNameById={deptNameById} limit={5} emptyMessage="No scans today" />}
          queueBar={queueBarNode}
          popup={popupNode}
        />
      </div>
    )
  }

  return (
    <div className="page" style={{ maxWidth: 900, margin: '0 auto' }}>
      <PageHeader
        icon={<ScanLine size={22} />}
        title="Attendance"
        pills={pillsNode}
      />
      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <KpiTile label="Scans today" value={sessions.length} sub="last 5 shown" />
        <KpiTile label="Queued scans" value={queued.length} sub={syncing ? 'syncing…' : queued.length ? 'waiting for network' : 'nothing waiting'} tone={queued.length ? '#b45309' : undefined} />
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <div className="card" style={{ padding: '1rem' }}>
          <div className="card-title" style={{ marginBottom: '0.75rem' }}>New scan</div>
          <BarcodeScanner ref={scannerRef} onScan={handleCameraScan} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input value={manualBadge} onChange={e => setManualBadge(e.target.value)} placeholder="Enter badge manually (FB/BH/VS)" className="input" aria-label="Badge number" inputMode="text" enterKeyHint="go" autoComplete="off" autoCapitalize="characters" spellCheck={false} style={{ flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') { manualSubmit() } }} />
            <button onClick={manualSubmit} className="btn btn-primary" disabled={busy || !manualBadge.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}Mark</button>
          </div>
        </div>
        <div className="card" style={{ padding: '1rem' }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><Clock size={14} /> Recent scans (today) {pendingCount ? <span className="pill pill-amber">{pendingCount} queued</span> : null}</div>
          {queueBarNode}
          <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
            <RecentScansTable
              rows={recentSessions}
              deptNameById={deptNameById}
              limit={5}
              emptyMessage="No scans today"
            />
          </div>
        </div>
      </div>

      {popupNode}
    </div>
  )
}
