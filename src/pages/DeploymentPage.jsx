import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Users, Download, Loader2 } from 'lucide-react'
import { useToast } from '../components/Toast'
import DeadlinePill from '../components/DeadlinePill'
import DeploymentMatrixReport from '../components/DeploymentMatrixReport'

/* ─── ASO / super_admin Overview tab ───
   Page shell: title, schedule selector, deadline countdown, Excel export
   button and the print-only report header. The centre-wise matrix report
   itself lives in the DeploymentMatrixReport section component (data
   loading, realtime refresh, rollups, rendering and the export all inside
   it). */

export default function DeploymentPage() {
  const toast = useToast()
  const reportRef = useRef()
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [reportLoading, setReportLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false }).then(({ data, error }) => {
      if (error) { toast.error(error.message); return }
      setSchedules(data || [])
      setSelectedScheduleId(prev => (prev && (data || []).some(s => s.id === prev)) ? prev : (data?.[0]?.id || ''))
    }).catch(() => {})
  }, [toast])

  const schedule = schedules.find(s => s.id === selectedScheduleId)

  const handleExport = async () => {
    if (exporting || reportLoading || !reportRef.current) return
    setExporting(true)
    try {
      await reportRef.current.exportExcel()
    } catch (e) {
      toast.error(e?.message || 'Failed to generate the Excel report')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><Users size={22} /> Deployment Report — Centre Wise</h2>
          <div className="page-sub">Scheduled (allocated quota) vs Deployed (finalized) per department, per CENTRE (incl. SC_SPs)</div>
        </div>
        <div className="print-hide" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <select value={selectedScheduleId} onChange={e => setSelectedScheduleId(e.target.value)} className="select">
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.status.replace('_', ' ')})</option>
            ))}
          </select>
          {schedule?.deadline && <DeadlinePill deadline={schedule.deadline} />}
          <button
            onClick={handleExport}
            disabled={reportLoading || exporting}
            className="btn btn-primary"
            style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}
          >
            {exporting ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Download size={13} />} Export to Excel
          </button>
        </div>
      </div>

      <div className="print-only" style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem' }}>
        DETAILED ANALYSIS OF SEWADAR DEPLOYMENT CENTRE WISE — {schedule?.name || ''}
      </div>

      <DeploymentMatrixReport
        ref={reportRef}
        scheduleId={selectedScheduleId}
        scheduleName={schedule?.name}
        onLoadingChange={setReportLoading}
      />
    </div>
  )
}