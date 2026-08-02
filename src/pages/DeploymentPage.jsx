import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Users, BarChart3, CheckCircle2, Clock } from 'lucide-react'

/* ─── ASO / super_admin: read-only overview of requested deployments ─── */
export default function DeploymentPage() {
  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')
  const [rows, setRows] = useState([])
  const [allocations, setAllocations] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false }).then(({ data }) => {
      if (data) {
        setSchedules(data)
        setSelectedScheduleId(prev => (prev && data.some(s => s.id === prev)) ? prev : (data[0]?.id || ''))
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedScheduleId) return
    setLoading(true)
    let mounted = true
    Promise.all([
      supabase.from('deployments').select('*, deployment_departments(name)').eq('schedule_id', selectedScheduleId).order('centre'),
      supabase.from('centre_allocations').select('*, deployment_departments(name)').eq('schedule_id', selectedScheduleId),
    ]).then(([dRes, aRes]) => {
      if (!mounted) return
      setRows(dRes.data || [])
      setAllocations(aRes.data || [])
      setLoading(false)
    })
    return () => { mounted = false }
  }, [selectedScheduleId])

  const schedule = schedules.find(s => s.id === selectedScheduleId)
  const deadlinePassed = schedule?.deadline ? new Date(schedule.deadline) < new Date() : false

  // per-centre: requested departments + totals
  const byCentre = {}
  rows.forEach(r => {
    if (!byCentre[r.centre]) byCentre[r.centre] = { departments: {} }
    const name = r.deployment_departments?.name || '—'
    byCentre[r.centre].departments[name] = (byCentre[r.centre].departments[name] || 0) + 1
  })

  // per-centre requested vs allocated quota
  const allocByCentre = {}
  allocations.forEach(a => {
    if (!allocByCentre[a.centre]) allocByCentre[a.centre] = []
    allocByCentre[a.centre].push(a)
  })

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><Users size={22} /> Requested Deployments — All Centres</h2>
          <div className="page-sub">Read-only overview of requested departments across every centre</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <select value={selectedScheduleId} onChange={e => setSelectedScheduleId(e.target.value)} className="select">
            {schedules.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.status.replace('_', ' ')})</option>
            ))}
          </select>
          {schedule?.deadline && (
            <span className={`pill ${deadlinePassed || schedule.status === 'done' ? 'pill-red' : 'pill-green'}`}>
              <Clock size={11} /> Deadline {new Date(schedule.deadline).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
        </div>
      ) : Object.keys(byCentre).length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No requested deployments yet</div>
            <div className="empty-text">Centres will appear here once they request departments for this schedule.</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {Object.entries(byCentre).map(([centre, data]) => {
            const allocs = allocByCentre[centre] || []
            const requestedTotal = Object.values(data.departments).reduce((s, n) => s + n, 0)
            const allocTotal = allocs.reduce((s, a) => s + a.max_count, 0)
            return (
              <div key={centre} className="card" style={{ padding: '0.75rem 0.9rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{centre}</span>
                  <span className="pill pill-blue"><BarChart3 size={11} /> {requestedTotal} requested</span>
                  {allocTotal > 0 && (
                    <span className="pill pill-gray">Allocated {allocTotal}</span>
                  )}
                  {schedule?.deadline && (
                    <span className={`pill ${deadlinePassed || schedule.status === 'done' ? 'pill-red' : 'pill-green'}`}>
                      <CheckCircle2 size={11} /> {deadlinePassed || schedule.status === 'done' ? 'Closed' : 'Open'}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                  {Object.entries(data.departments).map(([dept, count]) => (
                    <span key={dept} className="pill pill-blue">{dept}: {count}</span>
                  ))}
                  {Object.keys(data.departments).length === 0 && (
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>No department requests</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
