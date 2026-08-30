import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getRootCentre, isVssBadge } from '../lib/logic'
import { useToast } from '../components/Toast'
import { Building2, Users, Search, Download, Filter, X, Star, CheckCircle2 } from 'lucide-react'

const ROW_H = 44

export default function CentreListsPage({ schedules, scheduleId }) {
  const toast = useToast()
  const selectedScheduleId = scheduleId

  const [depts, setDepts] = useState([])
  const [centres, setCentres] = useState([])
  const [deploymentsRaw, setDeploymentsRaw] = useState([])
  const [consentsRaw, setConsentsRaw] = useState([])
  const [regularSewadars, setRegularSewadars] = useState([])
  const [vssSewadars, setVssSewadars] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)

  // filters
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterDept, setFilterDept] = useState('all')
  const [filterFinal, setFilterFinal] = useState('all') // all | finalized | not_finalized | overridden
  const [filterType, setFilterType] = useState('all') // all | regular | vss
  const [sortBy, setSortBy] = useState('centre') // centre | name | badge

  // mobile virtualization toggle
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  const tableWrapRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)

  const schedule = schedules.find(s => s.id === selectedScheduleId)

  const loadData = useCallback(async () => {
    if (!selectedScheduleId) return
    setLoading(true)
    try {
      const [deptRes, centreRes, deployRes, consentRes, sewRes, vssRes] = await Promise.all([
        supabase.from('deployment_departments').select('*').order('name'),
        supabase.from('centres').select('name, parent_centre').order('name'),
        supabase.from('deployments').select('*').eq('schedule_id', selectedScheduleId).order('centre'),
        supabase.from('sewadar_consents').select('*').eq('schedule_id', selectedScheduleId),
        supabase.from('sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, gender, badge_status'),
        supabase.from('vss_sewadars').select('badge_number, sewadar_name, department, centre, is_initiated, gender, is_active').order('sewadar_name'),
      ])

      const failed = [deptRes, centreRes, deployRes, consentRes, sewRes, vssRes].find(r => r?.error)
      if (failed) throw failed.error

      setDepts(deptRes.data || [])
      setCentres(centreRes.data || [])
      setDeploymentsRaw(deployRes.data || [])
      setConsentsRaw(consentRes.data || [])
      setRegularSewadars(sewRes.data || [])
      setVssSewadars(vssRes.data || [])
    } catch (err) {
      console.error('Failed to load centre lists:', err)
      toast.error(err?.message || 'Failed to load deployed lists')
    } finally {
      setLoading(false)
    }
  }, [selectedScheduleId, toast])

  useEffect(() => { loadData() }, [loadData])

  // realtime: refresh on deployments / consents / department changes
  useEffect(() => {
    if (!selectedScheduleId) return
    let mounted = true
    let timer = null
    const scheduleReload = () => {
      if (!mounted) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (mounted) loadData() }, 500)
    }
    const channel = supabase
      .channel(`centre-lists-${selectedScheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sewadar_consents', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployment_departments' }, scheduleReload)
      .subscribe()
    return () => { mounted = false; if (timer) clearTimeout(timer); supabase.removeChannel(channel) }
  }, [selectedScheduleId, loadData])

  // reset filters only on schedule switch
  const prevScheduleRef = useRef(selectedScheduleId)
  useEffect(() => {
    if (prevScheduleRef.current !== selectedScheduleId) {
      prevScheduleRef.current = selectedScheduleId
      setFilterCentre('all')
      setFilterDept('all')
      setFilterFinal('all')
      setFilterType('all')
      setSearch('')
      setSortBy('centre')
    }
  }, [selectedScheduleId])

  const deptMap = useMemo(() => {
    const m = new Map()
    depts.forEach(d => m.set(d.id, d))
    return m
  }, [depts])

  const centreOrder = useMemo(() => {
    const rootOf = {}
    ;(centres || []).forEach(c => { rootOf[c.name] = getRootCentre(centres, c.name) || c.name })
    return (a, b) => {
      const ra = rootOf[a] || a
      const rb = rootOf[b] || b
      if (ra !== rb) return ra.localeCompare(rb)
      const aRoot = ra === a
      const bRoot = rb === b
      if (aRoot !== bRoot) return aRoot ? -1 : 1
      return a.localeCompare(b)
    }
  }, [centres])

  const swMap = useMemo(() => {
    const m = {}
    ;(regularSewadars || []).forEach(s => { m[s.badge_number] = s })
    ;(vssSewadars || []).forEach(s => { m[s.badge_number] = { ...s, is_vss: true } })
    return m
  }, [regularSewadars, vssSewadars])

  const consentMap = useMemo(() => {
    const m = {}
    ;(consentsRaw || []).forEach(c => { m[`${c.centre}|${c.badge_number}`] = c })
    return m
  }, [consentsRaw])

  // build deployed rows from deploymentsRaw
  const deployedRows = useMemo(() => {
    return (deploymentsRaw || []).map(d => {
      const key = `${d.centre}|${d.badge_number}`
      const sw = swMap[d.badge_number] || {}
      const consent = consentMap[key] || {}
      const isVss = isVssBadge(d.badge_number) || !!sw.is_vss
      const reqId = d.department_id || ''
      const finalId = d.deployed_department_id || null
      const effectiveId = finalId || reqId
      const overridden = !!reqId && !!finalId && finalId !== reqId
      return {
        _key: key,
        centre: d.centre,
        badge_number: d.badge_number,
        sewadar_name: d.sewadar_name || sw.sewadar_name || '—',
        home_department: sw.department || d.sewadar_name ? '' : '',
        is_initiated: !!sw.is_initiated,
        gender: sw.gender || '',
        is_vss: isVss,
        consent_given: consent.consent_given ?? null,
        available_days_count: consent.available_days_count ?? null,
        stay_at_bhati: !!consent.stay_at_bhati,
        chair_pass: !!consent.chair_pass,
        requested_dept_id: reqId,
        deployed_dept_id: finalId,
        effective_dept_id: effectiveId,
        requested_name: reqId ? (deptMap.get(reqId)?.name || '') : '',
        deployed_name: finalId ? (deptMap.get(finalId)?.name || '') : '',
        effective_name: effectiveId ? (deptMap.get(effectiveId)?.name || '') : '—',
        is_finalized: !!finalId,
        is_overridden: overridden,
        // for sorting
        _root: getRootCentre(centres, d.centre) || d.centre,
      }
    })
  }, [deploymentsRaw, swMap, consentMap, deptMap, centres])

  // stats
  const stats = useMemo(() => {
    const total = deployedRows.length
    const finalized = deployedRows.filter(r => r.is_finalized).length
    const overridden = deployedRows.filter(r => r.is_overridden).length
    const vss = deployedRows.filter(r => r.is_vss).length
    const regular = total - vss
    const centresCount = new Set(deployedRows.map(r => r.centre)).size
    const initiated = deployedRows.filter(r => r.is_initiated).length
    return { total, finalized, overridden, vss, regular, centresCount, initiated, notFinalized: total - finalized }
  }, [deployedRows])

  // filter + search + sort
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return deployedRows.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterDept !== 'all' && r.effective_dept_id !== filterDept) return false
      if (filterFinal === 'finalized' && !r.is_finalized) return false
      if (filterFinal === 'not_finalized' && r.is_finalized) return false
      if (filterFinal === 'overridden' && !r.is_overridden) return false
      if (filterType === 'regular' && r.is_vss) return false
      if (filterType === 'vss' && !r.is_vss) return false
      if (q && !(`${r.sewadar_name} ${r.badge_number} ${r.centre}`).toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => {
      if (sortBy === 'badge') return a.badge_number.localeCompare(b.badge_number, undefined, { numeric: true })
      if (sortBy === 'name') return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
      // centre — grouped hierarchy
      const c = centreOrder(a.centre, b.centre)
      if (c !== 0) return c
      return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
    })
  }, [deployedRows, filterCentre, filterDept, filterFinal, filterType, search, sortBy, centreOrder])

  // quick filter counts (based on deployedRows filtered by department/centre/search but before final/type — similar to statusChips)
  const quickCounts = useMemo(() => {
    // base set after centre/dept/search — quick filters refine from there
    const q = search.trim().toLowerCase()
    const base = deployedRows.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterDept !== 'all' && r.effective_dept_id !== filterDept) return false
      if (q && !(`${r.sewadar_name} ${r.badge_number} ${r.centre}`).toLowerCase().includes(q)) return false
      return true
    })
    return {
      all: base.length,
      finalized: base.filter(r => r.is_finalized).length,
      not_finalized: base.filter(r => !r.is_finalized).length,
      overridden: base.filter(r => r.is_overridden).length,
      regular: base.filter(r => !r.is_vss).length,
      vss: base.filter(r => r.is_vss).length,
    }
  }, [deployedRows, filterCentre, filterDept, search])

  const hasActiveFilters = filterCentre !== 'all' || filterDept !== 'all' || filterFinal !== 'all' || filterType !== 'all' || !!search.trim()

  const clearAllFilters = () => {
    setFilterCentre('all')
    setFilterDept('all')
    setFilterFinal('all')
    setFilterType('all')
    setSearch('')
  }

  // virtualization
  const OVERSCAN = 14
  const vh = viewH || 600
  const totalRows = filtered.length
  const maxStart = Math.max(0, totalRows - 1)
  const startIdx = isMobile ? 0 : Math.min(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN), maxStart)
  const endIdx = isMobile ? totalRows : Math.min(totalRows, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN)
  const visibleSlice = isMobile ? filtered : filtered.slice(startIdx, endIdx)

  useEffect(() => {
    setScrollTop(0)
    if (tableWrapRef.current) tableWrapRef.current.scrollTop = 0
  }, [filterCentre, filterDept, filterFinal, filterType, search, sortBy, selectedScheduleId])

  useEffect(() => {
    if (loading || !tableWrapRef.current) return
    setViewH(tableWrapRef.current.clientHeight || 600)
  }, [loading, filtered.length])

  const centreOptions = useMemo(() => {
    const names = [...new Set(deployedRows.map(r => r.centre))].sort((a, b) => centreOrder(a, b))
    return names
  }, [deployedRows, centreOrder])

  const deptOptions = useMemo(() => {
    // only depts that actually have deployments
    const ids = new Set(deployedRows.map(r => r.effective_dept_id).filter(Boolean))
    return [...ids].map(id => deptMap.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  }, [deployedRows, deptMap])

  const exportExcel = useCallback(async () => {
    if (exportingRef.current) return
    if (!filtered.length) { toast.info('Nothing to export'); return }
    exportingRef.current = true
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const rows = filtered.map((r, idx) => ({
        'S.No.': idx + 1,
        'Centre': r.centre,
        'Badge': r.badge_number,
        'Name': r.sewadar_name,
        'Type': r.is_vss ? 'VSS' : 'Regular',
        'Gender': r.gender || '—',
        'Initiated': r.is_initiated ? 'Yes' : 'No',
        'Consent': r.consent_given == null ? '—' : (r.consent_given ? 'Yes' : 'No'),
        'Days': r.available_days_count ?? '—',
        'Stay at Bhati': r.stay_at_bhati ? 'Yes' : 'No',
        'Chair Pass': r.chair_pass ? 'Yes' : 'No',
        'Requested Deployment': r.requested_name || '—',
        'Finalized Deployment': r.deployed_name || (r.requested_name ? `${r.requested_name} (auto)` : '—'),
        'Effective Deployment': r.effective_name || '—',
        'Status': r.is_overridden ? 'Overridden' : r.is_finalized ? 'Finalized' : 'Deployed (awaiting finalize)',
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Centre Lists')

      // per-centre summary
      const byCentre = {}
      filtered.forEach(r => {
        if (!byCentre[r.centre]) byCentre[r.centre] = { total: 0, finalized: 0, vss: 0 }
        byCentre[r.centre].total++
        if (r.is_finalized) byCentre[r.centre].finalized++
        if (r.is_vss) byCentre[r.centre].vss++
      })
      const summary = Object.entries(byCentre)
        .sort((a, b) => centreOrder(a[0], b[0]))
        .map(([centre, v]) => ({
          'Centre': centre,
          'Deployed': v.total,
          'Finalized': v.finalized,
          'Pending': v.total - v.finalized,
          'VSS': v.vss,
          'Regular': v.total - v.vss,
        }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Centre Summary')

      // per-department summary
      const byDept = {}
      filtered.forEach(r => {
        const name = r.effective_name || '—'
        if (!byDept[name]) byDept[name] = { total: 0, finalized: 0 }
        byDept[name].total++
        if (r.is_finalized) byDept[name].finalized++
      })
      const deptSummary = Object.entries(byDept)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([dept, v]) => ({
          'Department': dept,
          'Deployed': v.total,
          'Finalized': v.finalized,
        }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deptSummary), 'Department Summary')

      const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
      XLSX.writeFile(wb, `${name}_centre_lists.xlsx`)
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }, [filtered, schedule, toast, centreOrder])

  if (!schedules.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          <p style={{ fontSize: '0.9rem' }}>No schedules yet. Create a schedule first.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><Building2 size={22} /> Centre Lists</h2>
          <div className="page-sub">Deployed sewadars by centres · {schedule?.name || ''} · read-only directory for ASO</div>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill pill-indigo" style={{ fontSize: '0.72rem' }}><Filter size={11} /> Deployed only</span>
            {hasActiveFilters && (
              <button onClick={clearAllFilters} className="btn btn-ghost" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}>
                <X size={12} /> Clear filters
              </button>
            )}
            <button onClick={exportExcel} disabled={exporting || loading} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem' }}>
              <Download size={13} /> {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat">
          <div className="stat-label">Deployed</div>
          <div className="stat-value">{stats.total}</div>
          <div className="stat-sub">across {stats.centresCount} centres</div>
        </div>
        <div className="stat">
          <div className="stat-label">Finalized</div>
          <div className="stat-value" style={{ color: stats.finalized ? '#10b981' : '#64748b' }}>{stats.finalized}</div>
          <div className="stat-sub">{stats.notFinalized} awaiting finalize</div>
        </div>
        <div className="stat">
          <div className="stat-label">Overridden</div>
          <div className="stat-value" style={{ color: stats.overridden ? '#b45309' : '#64748b' }}>{stats.overridden}</div>
          <div className="stat-sub">final dept ≠ requested</div>
        </div>
        <div className="stat">
          <div className="stat-label">VSS</div>
          <div className="stat-value" style={{ color: '#8b5cf6' }}>{stats.vss}</div>
          <div className="stat-sub">{stats.regular} regular</div>
        </div>
        <div className="stat">
          <div className="stat-label">Showing</div>
          <div className="stat-value" style={{ color: '#4f46e5' }}>{filtered.length}</div>
          <div className="stat-sub">after filters</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem' }}>
        {/* filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center', marginBottom: '0.9rem' }}>
          <div style={{ position: 'relative', minWidth: 220, flex: '1 1 220px' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / badge / centre..." className="input" style={{ width: '100%', paddingLeft: 30 }} />
          </div>
          <select value={filterCentre} onChange={e => setFilterCentre(e.target.value)} className="select" style={{ minWidth: 160 }}>
            <option value="all">All Centres ({centreOptions.length})</option>
            {centreOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterDept} onChange={e => setFilterDept(e.target.value)} className="select" style={{ minWidth: 190 }}>
            <option value="all">All Departments ({deptOptions.length})</option>
            {deptOptions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="select" title="Sort by">
            <option value="centre">Sort: Centre</option>
            <option value="name">Sort: Name</option>
            <option value="badge">Sort: Badge</option>
          </select>
          {hasActiveFilters && <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>}
        </div>

        {/* quick filters */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: '0.2rem' }}>Status:</span>
            {[
              { key: 'all', label: 'All', count: quickCounts.all },
              { key: 'finalized', label: 'Finalized', count: quickCounts.finalized },
              { key: 'not_finalized', label: 'Awaiting', count: quickCounts.not_finalized },
              { key: 'overridden', label: 'Overridden', count: quickCounts.overridden },
            ].map(c => {
              const active = filterFinal === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => setFilterFinal(c.key)}
                  className={`pill ${active ? 'pill-indigo' : 'pill-gray'}`}
                  style={{ cursor: 'pointer', border: '1px solid transparent', fontWeight: active ? 700 : 600, ...(active ? { boxShadow: '0 1px 4px rgba(99,102,241,0.3)' } : {}) }}
                >
                  {c.label}
                  <span style={{ opacity: 0.75, marginLeft: '0.3rem', fontWeight: 700 }}>{c.count}</span>
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: '0.2rem' }}>Type:</span>
            {[
              { key: 'all', label: 'All Types', count: quickCounts.all },
              { key: 'regular', label: 'Regular', count: quickCounts.regular },
              { key: 'vss', label: 'VSS', count: quickCounts.vss },
            ].map(c => {
              const active = filterType === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => setFilterType(c.key)}
                  className={`pill ${active ? 'pill-indigo' : 'pill-gray'}`}
                  style={{ cursor: 'pointer', border: '1px solid transparent', fontWeight: active ? 700 : 600, ...(active ? { boxShadow: '0 1px 4px rgba(99,102,241,0.3)' } : {}) }}
                >
                  {c.label === 'VSS' ? <Star size={11} style={{ marginRight: '0.15rem' }} /> : null}
                  {c.label}
                  <span style={{ opacity: 0.75, marginLeft: '0.3rem', fontWeight: 700 }}>{c.count}</span>
                </button>
              )
            })}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>{filtered.length} shown</span>
              {hasActiveFilters && (
                <button onClick={clearAllFilters} className="pill pill-gray" style={{ cursor: 'pointer', border: '1px solid #e2e8f0' }}>
                  <X size={11} /> Reset
                </button>
              )}
            </span>
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {[...Array(6)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, borderRadius: 10 }} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="card" style={{ border: 'none', boxShadow: 'none', background: '#f8fafc' }}>
            <div className="empty">
              <div className="empty-icon"><Users size={22} /></div>
              <div className="empty-title">{deployedRows.length === 0 ? 'No deployments yet' : 'No matches'}</div>
              <div className="empty-text">{deployedRows.length === 0 ? 'No sewadars have been deployed for this schedule yet.' : 'Try clearing filters or searching differently.'}</div>
              {hasActiveFilters && <button onClick={clearAllFilters} className="btn btn-primary" style={{ marginTop: '0.85rem' }}><X size={14} /> Clear filters</button>}
            </div>
          </div>
        ) : (
          <div
            ref={tableWrapRef}
            className="table-wrap table-wrap-sticky"
            onScroll={e => { setScrollTop(e.currentTarget.scrollTop); if (e.currentTarget.clientHeight) setViewH(e.currentTarget.clientHeight) }}
          >
            <table className="table table-sticky">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}>S.No.</th>
                  <th>Centre</th>
                  <th>Badge</th>
                  <th>Name</th>
                  <th style={{ textAlign: 'center' }}>Type</th>
                  <th style={{ textAlign: 'center' }}>Consent</th>
                  <th style={{ textAlign: 'center' }}>Days</th>
                  <th style={{ textAlign: 'center' }}>Stay</th>
                  <th style={{ textAlign: 'center' }}>Requested</th>
                  <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Finalized</th>
                </tr>
              </thead>
              <tbody>
                {startIdx > 0 && (
                  <tr aria-hidden="true" style={{ height: startIdx * ROW_H }}>
                    <td colSpan={10} style={{ padding: 0, border: 'none', height: startIdx * ROW_H }} />
                  </tr>
                )}
                {visibleSlice.map((r, i) => {
                  const idx = startIdx + i + 1
                  const overridden = r.is_overridden
                  const rowBg = overridden ? '#fff7ed' : undefined
                  return (
                    <tr key={r._key} style={{ height: ROW_H, background: rowBg }}>
                      <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{idx}</td>
                      <td style={{ fontWeight: 600, fontSize: '0.82rem', whiteSpace: 'nowrap' }} data-label="Centre">{r.centre}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          {r.badge_number}
                          {r.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
                        </span>
                      </td>
                      <td style={{ fontWeight: 500, maxWidth: 220 }} data-label="Name">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden' }}>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sewadar_name}</span>
                          {r.is_initiated && <span className="pill pill-green" style={{ flexShrink: 0, fontSize: '0.6rem' }}>INIT</span>}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Type">
                        <span className={`pill ${r.is_vss ? 'pill-amber' : 'pill-gray'}`} style={{ fontSize: '0.68rem' }}>
                          {r.is_vss ? <Star size={10} style={{ marginRight: '0.2rem' }} /> : null}
                          {r.is_vss ? 'VSS' : 'Regular'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Consent">
                        {r.consent_given == null ? <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span> : r.consent_given ? <span className="pill pill-green" style={{ fontSize: '0.68rem' }}><CheckCircle2 size={10} /> Yes</span> : <span className="pill pill-red" style={{ fontSize: '0.68rem' }}>No</span>}
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Days">
                        {r.available_days_count == null ? <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span> : <span className="pill pill-blue" style={{ fontSize: '0.68rem' }}>{r.available_days_count}d</span>}
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Stay">
                        <span className={`pill ${r.stay_at_bhati ? 'pill-green' : 'pill-gray'}`} style={{ fontSize: '0.68rem' }}>{r.stay_at_bhati ? 'Yes' : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Requested">
                        {r.requested_name ? <span className="pill pill-blue" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{r.requested_name}</span> : <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'center', background: '#f8faff' }} data-label="Finalized">
                        {r.deployed_name ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                            <span className="pill pill-green" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap', fontWeight: 700 }}>{r.deployed_name}</span>
                            {overridden && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>CHANGED</span>}
                          </span>
                        ) : r.requested_name ? (
                          <span className="pill pill-gray" style={{ fontSize: '0.68rem' }} title="Awaiting finalize — defaults to requested">Pending</span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {endIdx < totalRows && (
                  <tr aria-hidden="true" style={{ height: (totalRows - endIdx) * ROW_H }}>
                    <td colSpan={10} style={{ padding: 0, border: 'none', height: (totalRows - endIdx) * ROW_H }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
