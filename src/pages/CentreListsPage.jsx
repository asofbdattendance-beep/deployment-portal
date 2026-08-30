import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getRootCentre, isVssBadge } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import { Building2, Users, Search, Download, Filter, X, Star, CheckCircle2, ShieldCheck, Lock, Unlock, Crown } from 'lucide-react'

const ROW_H = 44

export default function CentreListsPage({ schedules, scheduleId }) {
  const toast = useToast()
  const { profile } = usePortalAuth()
  const isASO = profile?.role === 'aso' || profile?.role === 'super_admin'
  const selectedScheduleId = scheduleId

  const [depts, setDepts] = useState([])
  const [centres, setCentres] = useState([])
  const [deploymentsRaw, setDeploymentsRaw] = useState([])
  const [consentsRaw, setConsentsRaw] = useState([])
  const [regularSewadars, setRegularSewadars] = useState([])
  const [vssSewadars, setVssSewadars] = useState([])
  const [inchargesRaw, setInchargesRaw] = useState([])
  const [locksRaw, setLocksRaw] = useState([])
  const [selectionsRaw, setSelectionsRaw] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const [selCentre, setSelCentre] = useState('')
  const [selDept, setSelDept] = useState('')
  const [sel1, setSel1] = useState('')
  const [sel2, setSel2] = useState('')
  const [savingSel, setSavingSel] = useState(false)

  // tabs: sewadars | vss | incharges
  const [activeTab, setActiveTab] = useState('sewadars')

  // shared filters
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [filterDept, setFilterDept] = useState('all')
  const [filterFinal, setFilterFinal] = useState('all') // all | finalized | not_finalized | overridden
  const [filterLock, setFilterLock] = useState('all') // for incharges tab: all | locked | unlocked
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
  const inchargesWrapRef = useRef(null)
  const [inchargeScrollTop, setInchargeScrollTop] = useState(0)
  const [inchargeViewH, setInchargeViewH] = useState(600)

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

      // incharges + locks + selections — non-fatal
      try {
        const [incRes, lockRes, selRes] = await Promise.all([
          supabase.from('department_incharges').select('*').eq('schedule_id', selectedScheduleId),
          supabase.from('centre_locks').select('*').eq('schedule_id', selectedScheduleId),
          supabase.from('department_incharge_selections').select('*').eq('schedule_id', selectedScheduleId),
        ])
        if (!incRes.error) setInchargesRaw(incRes.data || [])
        else setInchargesRaw([])
        if (!lockRes.error) setLocksRaw(lockRes.data || [])
        else setLocksRaw([])
        if (!selRes.error) setSelectionsRaw(selRes.data || [])
        else setSelectionsRaw([])
      } catch {
        setInchargesRaw([])
        setLocksRaw([])
        setSelectionsRaw([])
      }
    } catch (err) {
      console.error('Failed to load centre lists:', err)
      toast.error(err?.message || 'Failed to load deployed lists')
    } finally {
      setLoading(false)
    }
  }, [selectedScheduleId, toast])

  useEffect(() => { loadData() }, [loadData])

  // realtime: refresh on deployments / consents / department_incharges / locks / selections
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'department_incharges', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_locks', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'department_incharge_selections', filter: `schedule_id=eq.${selectedScheduleId}` }, scheduleReload)
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
      setFilterLock('all')
      setSearch('')
      setSortBy('centre')
    }
  }, [selectedScheduleId])

  // reset scroll when tab changes
  useEffect(() => {
    setScrollTop(0)
    setInchargeScrollTop(0)
    if (tableWrapRef.current) tableWrapRef.current.scrollTop = 0
    if (inchargesWrapRef.current) inchargesWrapRef.current.scrollTop = 0
  }, [activeTab])

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

  const locksSet = useMemo(() => new Set((locksRaw || []).map(l => l.centre)), [locksRaw])
  const lockByCentre = useMemo(() => {
    const m = {}
    ;(locksRaw || []).forEach(l => { m[l.centre] = l })
    return m
  }, [locksRaw])

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
        _root: getRootCentre(centres, d.centre) || d.centre,
      }
    })
  }, [deploymentsRaw, swMap, consentMap, deptMap, centres])

  // split by type
  const sewadarRows = useMemo(() => deployedRows.filter(r => !r.is_vss), [deployedRows])
  const vssRows = useMemo(() => deployedRows.filter(r => r.is_vss), [deployedRows])

  // incharges enriched
  const inchargesRows = useMemo(() => {
    return (inchargesRaw || []).map(inc => {
      const deptName = deptMap.get(inc.department_id)?.name || '—'
      const sw = swMap[inc.badge_number] || {}
      const isLocked = locksSet.has(inc.centre)
      const lock = lockByCentre[inc.centre] || null
      return {
        _key: `${inc.centre}|${inc.department_id}`,
        centre: inc.centre,
        department_id: inc.department_id,
        dept_name: deptName,
        badge_number: inc.badge_number,
        sewadar_name: inc.sewadar_name || sw.sewadar_name || '—',
        is_initiated: !!sw.is_initiated,
        gender: sw.gender || '',
        is_vss: isVssBadge(inc.badge_number) || !!sw.is_vss,
        is_locked: isLocked,
        locked_at: lock?.locked_at || null,
        locked_by: lock?.locked_by || null,
        _root: getRootCentre(centres, inc.centre) || inc.centre,
      }
    })
  }, [inchargesRaw, deptMap, swMap, locksSet, lockByCentre, centres])

  // stats
  const sewadarStats = useMemo(() => {
    const total = sewadarRows.length
    const finalized = sewadarRows.filter(r => r.is_finalized).length
    const overridden = sewadarRows.filter(r => r.is_overridden).length
    const centresCount = new Set(sewadarRows.map(r => r.centre)).size
    return { total, finalized, overridden, centresCount, notFinalized: total - finalized }
  }, [sewadarRows])
  const vssStats = useMemo(() => {
    const total = vssRows.length
    const finalized = vssRows.filter(r => r.is_finalized).length
    const overridden = vssRows.filter(r => r.is_overridden).length
    const centresCount = new Set(vssRows.map(r => r.centre)).size
    return { total, finalized, overridden, centresCount, notFinalized: total - finalized }
  }, [vssRows])
  const inchargesStats = useMemo(() => {
    const total = inchargesRows.length
    const locked = inchargesRows.filter(r => r.is_locked).length
    const centresWithIncharge = new Set(inchargesRows.map(r => r.centre)).size
    const lockedCentres = new Set(inchargesRows.filter(r => r.is_locked).map(r => r.centre)).size
    const totalLocks = locksRaw.length
    return { total, locked, unlocked: total - locked, centresWithIncharge, lockedCentres, totalLocks }
  }, [inchargesRows, locksRaw])

  // active base rows for Sewadars/VSS tabs (before status filter)
  const activeBaseRows = useMemo(() => (activeTab === 'sewadars' ? sewadarRows : activeTab === 'vss' ? vssRows : []), [activeTab, sewadarRows, vssRows])

  // filter + search + sort for Sewadars/VSS
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return activeBaseRows.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterDept !== 'all' && r.effective_dept_id !== filterDept) return false
      if (filterFinal === 'finalized' && !r.is_finalized) return false
      if (filterFinal === 'not_finalized' && r.is_finalized) return false
      if (filterFinal === 'overridden' && !r.is_overridden) return false
      if (q && !(`${r.sewadar_name} ${r.badge_number} ${r.centre}`).toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => {
      if (sortBy === 'badge') return a.badge_number.localeCompare(b.badge_number, undefined, { numeric: true })
      if (sortBy === 'name') return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
      const c = centreOrder(a.centre, b.centre)
      if (c !== 0) return c
      return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
    })
  }, [activeBaseRows, filterCentre, filterDept, filterFinal, search, sortBy, centreOrder])

  // filtered incharges
  const filteredIncharges = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inchargesRows.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterDept !== 'all' && r.department_id !== filterDept) return false
      if (filterLock === 'locked' && !r.is_locked) return false
      if (filterLock === 'unlocked' && r.is_locked) return false
      if (q && !(`${r.sewadar_name} ${r.badge_number} ${r.centre} ${r.dept_name}`).toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => {
      if (sortBy === 'badge') return a.badge_number.localeCompare(b.badge_number, undefined, { numeric: true })
      if (sortBy === 'name') return (a.sewadar_name || '').localeCompare(b.sewadar_name || '', undefined, { sensitivity: 'base' })
      const c = centreOrder(a.centre, b.centre)
      if (c !== 0) return c
      return (a.dept_name || '').localeCompare(b.dept_name || '', undefined, { sensitivity: 'base' })
    })
  }, [inchargesRows, filterCentre, filterDept, filterLock, search, sortBy, centreOrder])

  // quick filter counts (for Sewadars/VSS tabs)
  const quickCounts = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = activeBaseRows.filter(r => {
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
    }
  }, [activeBaseRows, filterCentre, filterDept, search])

  const inchargeQuickCounts = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = inchargesRows.filter(r => {
      if (filterCentre !== 'all' && r.centre !== filterCentre) return false
      if (filterDept !== 'all' && r.department_id !== filterDept) return false
      if (q && !(`${r.sewadar_name} ${r.badge_number} ${r.centre} ${r.dept_name}`).toLowerCase().includes(q)) return false
      return true
    })
    return {
      all: base.length,
      locked: base.filter(r => r.is_locked).length,
      unlocked: base.filter(r => !r.is_locked).length,
    }
  }, [inchargesRows, filterCentre, filterDept, search])

  const hasActiveFiltersSewadar = filterCentre !== 'all' || filterDept !== 'all' || filterFinal !== 'all' || !!search.trim()
  const hasActiveFiltersIncharge = filterCentre !== 'all' || filterDept !== 'all' || filterLock !== 'all' || !!search.trim()
  const hasActiveFilters = activeTab === 'incharges' ? hasActiveFiltersIncharge : hasActiveFiltersSewadar

  const clearAllFilters = () => {
    setFilterCentre('all')
    setFilterDept('all')
    setFilterFinal('all')
    setFilterLock('all')
    setSearch('')
  }

  // virtualization for Sewadars/VSS
  const OVERSCAN = 14
  const vh = viewH || 600
  const totalRows = filtered.length
  const maxStart = Math.max(0, totalRows - 1)
  const startIdx = isMobile ? 0 : Math.min(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN), maxStart)
  const endIdx = isMobile ? totalRows : Math.min(totalRows, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN)
  const visibleSlice = isMobile ? filtered : filtered.slice(startIdx, endIdx)

  // virtualization for incharges
  const totalInchargeRows = filteredIncharges.length
  const maxStartInc = Math.max(0, totalInchargeRows - 1)
  const startIdxInc = isMobile ? 0 : Math.min(Math.max(0, Math.floor(inchargeScrollTop / ROW_H) - OVERSCAN), maxStartInc)
  const endIdxInc = isMobile ? totalInchargeRows : Math.min(totalInchargeRows, Math.ceil((inchargeViewH + inchargeScrollTop) / ROW_H) + OVERSCAN)
  const visibleInchargeSlice = isMobile ? filteredIncharges : filteredIncharges.slice(startIdxInc, endIdxInc)

  useEffect(() => {
    setScrollTop(0)
    if (tableWrapRef.current) tableWrapRef.current.scrollTop = 0
  }, [filterCentre, filterDept, filterFinal, search, sortBy, selectedScheduleId, activeTab])

  useEffect(() => {
    setInchargeScrollTop(0)
    if (inchargesWrapRef.current) inchargesWrapRef.current.scrollTop = 0
  }, [filterCentre, filterDept, filterLock, search, sortBy, selectedScheduleId, activeTab])

  useEffect(() => {
    if (loading || !tableWrapRef.current) return
    setViewH(tableWrapRef.current.clientHeight || 600)
  }, [loading, filtered.length, activeTab])

  useEffect(() => {
    if (loading || !inchargesWrapRef.current) return
    setInchargeViewH(inchargesWrapRef.current.clientHeight || 600)
  }, [loading, filteredIncharges.length, activeTab])

  const centreOptions = useMemo(() => {
    const source = activeTab === 'incharges' ? inchargesRows : activeBaseRows
    const names = [...new Set(source.map(r => r.centre))].sort((a, b) => centreOrder(a, b))
    return names
  }, [activeTab, inchargesRows, activeBaseRows, centreOrder])

  const deptOptions = useMemo(() => {
    if (activeTab === 'incharges') {
      const ids = new Set(inchargesRows.map(r => r.department_id).filter(Boolean))
      return [...ids].map(id => deptMap.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
    }
    const ids = new Set(activeBaseRows.map(r => r.effective_dept_id).filter(Boolean))
    return [...ids].map(id => deptMap.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  }, [activeTab, inchargesRows, activeBaseRows, deptMap])

  const exportExcel = useCallback(async () => {
    if (exportingRef.current) return
    const isIncharge = activeTab === 'incharges'
    const exportRows = isIncharge ? filteredIncharges : filtered
    if (!exportRows.length) { toast.info('Nothing to export'); return }
    exportingRef.current = true
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      if (isIncharge) {
        const rows = exportRows.map((r, idx) => ({
          'S.No.': idx + 1,
          'Centre': r.centre,
          'Department': r.dept_name || '—',
          'Incharge Badge': r.badge_number,
          'Incharge Name': r.sewadar_name,
          'Initiated': r.is_initiated ? 'Yes' : 'No',
          'Gender': r.gender || '—',
          'Lock Status': r.is_locked ? 'Locked' : 'Not Locked',
          'Locked By': r.locked_by || '—',
          'Locked At': r.locked_at ? new Date(r.locked_at).toLocaleString() : '—',
        }))
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Centre Incharges')
        // per-centre summary
        const byCentre = {}
        exportRows.forEach(r => {
          if (!byCentre[r.centre]) byCentre[r.centre] = { total: 0, locked: 0 }
          byCentre[r.centre].total++
          if (r.is_locked) byCentre[r.centre].locked++
        })
        const summary = Object.entries(byCentre)
          .sort((a, b) => centreOrder(a[0], b[0]))
          .map(([centre, v]) => ({
            'Centre': centre,
            'Incharges': v.total,
            'Locked': v.locked,
            'Unlocked': v.total - v.locked,
          }))
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Centre Summary')
      } else {
        const rows = exportRows.map((r, idx) => ({
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
          'Deployed Department': r.effective_name || '—',
          'Status': r.is_overridden ? 'Overridden' : r.is_finalized ? 'Finalized' : 'Deployed',
        }))
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), activeTab === 'vss' ? 'VSS Lists' : 'Sewadar Lists')
        const byCentre = {}
        exportRows.forEach(r => {
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
          }))
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Centre Summary')
        const byDept = {}
        exportRows.forEach(r => {
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
      }
      const name = (schedule?.name || 'schedule').replace(/[^a-z0-9]+/gi, '_')
      const suffix = activeTab === 'incharges' ? 'centre_incharges' : activeTab === 'vss' ? 'vss_lists' : 'centre_lists'
      XLSX.writeFile(wb, `${name}_${suffix}.xlsx`)
    } catch (err) {
      toast.error(err?.message || 'Export failed')
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }, [filtered, filteredIncharges, activeTab, schedule, toast, centreOrder])

  if (!schedules.length) {
    return (
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          <p style={{ fontSize: '0.9rem' }}>No schedules yet. Create a schedule first.</p>
        </div>
      </div>
    )
  }

  const tabStats = activeTab === 'sewadars' ? sewadarStats : activeTab === 'vss' ? vssStats : inchargesStats
  const isSewadarLike = activeTab === 'sewadars' || activeTab === 'vss'

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

      {/* tabs */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button className={`seg-btn ${activeTab === 'sewadars' ? 'seg-active' : ''}`} onClick={() => setActiveTab('sewadars')}>
          <Users size={14} /> Sewadars
          <span className="pill pill-gray" style={{ marginLeft: '0.3rem', fontSize: '0.68rem', background: activeTab === 'sewadars' ? 'rgba(255,255,255,0.22)' : undefined, color: activeTab === 'sewadars' ? '#fff' : undefined }}>{sewadarStats.total}</span>
        </button>
        <button className={`seg-btn ${activeTab === 'vss' ? 'seg-active' : ''}`} onClick={() => setActiveTab('vss')}>
          <Star size={14} /> VSS
          <span className="pill pill-gray" style={{ marginLeft: '0.3rem', fontSize: '0.68rem', background: activeTab === 'vss' ? 'rgba(255,255,255,0.22)' : undefined, color: activeTab === 'vss' ? '#fff' : undefined }}>{vssStats.total}</span>
        </button>
        <button className={`seg-btn ${activeTab === 'incharges' ? 'seg-active' : ''}`} onClick={() => setActiveTab('incharges')}>
          <ShieldCheck size={14} /> Centre Incharges
          <span className="pill pill-gray" style={{ marginLeft: '0.3rem', fontSize: '0.68rem', background: activeTab === 'incharges' ? 'rgba(255,255,255,0.22)' : undefined, color: activeTab === 'incharges' ? '#fff' : undefined }}>{inchargesStats.total}</span>
        </button>
      </div>

      {/* stats strip — tab-specific */}
      {isSewadarLike ? (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div className="stat">
            <div className="stat-label">{activeTab === 'vss' ? 'VSS Deployed' : 'Deployed'}</div>
            <div className="stat-value">{tabStats.total}</div>
            <div className="stat-sub">across {tabStats.centresCount} centres</div>
          </div>
          <div className="stat">
            <div className="stat-label">Finalized</div>
            <div className="stat-value" style={{ color: tabStats.finalized ? '#10b981' : '#64748b' }}>{tabStats.finalized}</div>
            <div className="stat-sub">{tabStats.notFinalized} awaiting finalize</div>
          </div>
          <div className="stat">
            <div className="stat-label">Overridden</div>
            <div className="stat-value" style={{ color: tabStats.overridden ? '#b45309' : '#64748b' }}>{tabStats.overridden}</div>
            <div className="stat-sub">final dept ≠ requested</div>
          </div>
          <div className="stat">
            <div className="stat-label">Showing</div>
            <div className="stat-value" style={{ color: '#4f46e5' }}>{filtered.length}</div>
            <div className="stat-sub">after filters</div>
          </div>
        </div>
      ) : (
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div className="stat">
            <div className="stat-label">Incharges</div>
            <div className="stat-value">{inchargesStats.total}</div>
            <div className="stat-sub">across {inchargesStats.centresWithIncharge} centres</div>
          </div>
          <div className="stat">
            <div className="stat-label">Locked</div>
            <div className="stat-value" style={{ color: inchargesStats.locked ? '#10b981' : '#64748b' }}>{inchargesStats.locked}</div>
            <div className="stat-sub">{inchargesStats.totalLocks} centres locked · {inchargesStats.lockedCentres} with incharges</div>
          </div>
          <div className="stat">
            <div className="stat-label">Unlocked</div>
            <div className="stat-value" style={{ color: inchargesStats.unlocked ? '#f59e0b' : '#64748b' }}>{inchargesStats.unlocked}</div>
            <div className="stat-sub">awaiting lock or without lock</div>
          </div>
          <div className="stat">
            <div className="stat-label">Showing</div>
            <div className="stat-value" style={{ color: '#4f46e5' }}>{filteredIncharges.length}</div>
            <div className="stat-sub">after filters</div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem' }}>
        {/* filters — shared */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center', marginBottom: '0.9rem' }}>
          <div style={{ position: 'relative', minWidth: 220, flex: '1 1 220px' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={activeTab === 'incharges' ? 'Search incharge / badge / centre / dept...' : 'Search name / badge / centre...'}
              className="input"
              style={{ width: '100%', paddingLeft: 30 }}
            />
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
          {hasActiveFilters && <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>{activeTab === 'incharges' ? filteredIncharges.length : filtered.length} result{(activeTab === 'incharges' ? filteredIncharges.length : filtered.length) !== 1 ? 's' : ''}</span>}
        </div>

        {/* quick filters — tab-specific */}
        {isSewadarLike ? (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
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
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>{filtered.length} shown</span>
              {hasActiveFilters && (
                <button onClick={clearAllFilters} className="pill pill-gray" style={{ cursor: 'pointer', border: '1px solid #e2e8f0' }}>
                  <X size={11} /> Reset
                </button>
              )}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: '0.2rem' }}>Lock:</span>
            {[
              { key: 'all', label: 'All', count: inchargeQuickCounts.all },
              { key: 'locked', label: 'Locked', count: inchargeQuickCounts.locked },
              { key: 'unlocked', label: 'Unlocked', count: inchargeQuickCounts.unlocked },
            ].map(c => {
              const active = filterLock === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => setFilterLock(c.key)}
                  className={`pill ${active ? 'pill-indigo' : 'pill-gray'}`}
                  style={{ cursor: 'pointer', border: '1px solid transparent', fontWeight: active ? 700 : 600, ...(active ? { boxShadow: '0 1px 4px rgba(99,102,241,0.3)' } : {}) }}
                >
                  {c.key === 'locked' ? <Lock size={11} style={{ marginRight: '0.15rem' }} /> : c.key === 'unlocked' ? <Unlock size={11} style={{ marginRight: '0.15rem' }} /> : null}
                  {c.label}
                  <span style={{ opacity: 0.75, marginLeft: '0.3rem', fontWeight: 700 }}>{c.count}</span>
                </button>
              )
            })}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>{filteredIncharges.length} shown</span>
              {hasActiveFilters && (
                <button onClick={clearAllFilters} className="pill pill-gray" style={{ cursor: 'pointer', border: '1px solid #e2e8f0' }}>
                  <X size={11} /> Reset
                </button>
              )}
            </span>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {[...Array(6)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, borderRadius: 10 }} />)}
          </div>
        ) : isSewadarLike ? (
          filtered.length === 0 ? (
            <div className="card" style={{ border: 'none', boxShadow: 'none', background: '#f8fafc' }}>
              <div className="empty">
                <div className="empty-icon"><Users size={22} /></div>
                <div className="empty-title">{activeBaseRows.length === 0 ? (activeTab === 'vss' ? 'No VSS deployments yet' : 'No deployments yet') : 'No matches'}</div>
                <div className="empty-text">{activeBaseRows.length === 0 ? 'No sewadars have been deployed for this schedule yet.' : 'Try clearing filters or searching differently.'}</div>
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
                    <th style={{ textAlign: 'center', background: '#eef2ff', color: '#4f46e5', fontWeight: 800 }}>Deployed Department</th>
                  </tr>
                </thead>
                <tbody>
                  {startIdx > 0 && (
                    <tr aria-hidden="true" style={{ height: startIdx * ROW_H }}>
                      <td colSpan={9} style={{ padding: 0, border: 'none', height: startIdx * ROW_H }} />
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
                        <td style={{ textAlign: 'center', background: '#f8faff' }} data-label="Deployed Department">
                          {r.effective_name && r.effective_name !== '—' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                              <span
                                className={`pill ${overridden ? 'pill-amber' : r.is_finalized ? 'pill-green' : 'pill-blue'}`}
                                style={{ fontSize: '0.72rem', whiteSpace: 'nowrap', fontWeight: 700 }}
                                title={overridden ? `Finalized as ${r.deployed_name} (requested was ${r.requested_name})` : r.is_finalized ? 'Finalized deployment' : 'Requested deployment (defaults to this until finalized)'}
                              >
                                {r.effective_name}
                              </span>
                              {overridden && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }} title={`Changed from ${r.requested_name}`}>CHANGED</span>}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {endIdx < totalRows && (
                    <tr aria-hidden="true" style={{ height: (totalRows - endIdx) * ROW_H }}>
                      <td colSpan={9} style={{ padding: 0, border: 'none', height: (totalRows - endIdx) * ROW_H }} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )
        ) : filteredIncharges.length === 0 ? (
          <div className="card" style={{ border: 'none', boxShadow: 'none', background: '#f8fafc' }}>
            <div className="empty">
              <div className="empty-icon"><ShieldCheck size={22} /></div>
              <div className="empty-title">{inchargesRows.length === 0 ? 'No incharges yet' : 'No matches'}</div>
              <div className="empty-text">{inchargesRows.length === 0 ? 'Centres have not locked deployments or set incharges for this schedule yet. Each CENTRE sets one incharge per allocated department before locking.' : 'Try clearing filters or searching differently.'}</div>
              {hasActiveFilters && <button onClick={clearAllFilters} className="btn btn-primary" style={{ marginTop: '0.85rem' }}><X size={14} /> Clear filters</button>}
            </div>
          </div>
        ) : (
          <div
            ref={inchargesWrapRef}
            className="table-wrap table-wrap-sticky"
            onScroll={e => { setInchargeScrollTop(e.currentTarget.scrollTop); if (e.currentTarget.clientHeight) setInchargeViewH(e.currentTarget.clientHeight) }}
          >
            <table className="table table-sticky">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}>S.No.</th>
                  <th>Centre</th>
                  <th>Department</th>
                  <th>Badge</th>
                  <th>Incharge Name</th>
                  <th style={{ textAlign: 'center' }}>Initiated</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th style={{ textAlign: 'center' }}>Locked By / At</th>
                </tr>
              </thead>
              <tbody>
                {startIdxInc > 0 && (
                  <tr aria-hidden="true" style={{ height: startIdxInc * ROW_H }}>
                    <td colSpan={8} style={{ padding: 0, border: 'none', height: startIdxInc * ROW_H }} />
                  </tr>
                )}
                {visibleInchargeSlice.map((r, i) => {
                  const idx = startIdxInc + i + 1
                  return (
                    <tr key={r._key} style={{ height: ROW_H, background: r.is_locked ? '#ecfdf5' : undefined }}>
                      <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{idx}</td>
                      <td style={{ fontWeight: 600, fontSize: '0.82rem', whiteSpace: 'nowrap' }} data-label="Centre">{r.centre}</td>
                      <td style={{ fontWeight: 600, fontSize: '0.82rem' }} data-label="Department"><span className="pill pill-indigo" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{r.dept_name}</span></td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          {r.badge_number}
                          {r.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
                        </span>
                      </td>
                      <td style={{ fontWeight: 500, maxWidth: 220 }} data-label="Incharge Name">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden' }}>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sewadar_name}</span>
                          {r.is_initiated && <span className="pill pill-green" style={{ flexShrink: 0, fontSize: '0.6rem' }}>INIT</span>}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Initiated">
                        <span className={`pill ${r.is_initiated ? 'pill-green' : 'pill-gray'}`} style={{ fontSize: '0.68rem' }}>{r.is_initiated ? 'Yes' : 'No'}</span>
                      </td>
                      <td style={{ textAlign: 'center' }} data-label="Status">
                        {r.is_locked ? <span className="pill pill-green" style={{ fontSize: '0.68rem' }}><Lock size={10} /> Locked</span> : <span className="pill pill-amber" style={{ fontSize: '0.68rem' }}><Unlock size={10} /> Unlocked</span>}
                      </td>
                      <td style={{ textAlign: 'center', fontSize: '0.75rem', color: '#64748b' }} data-label="Locked By / At">
                        {r.is_locked ? (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.2 }}>
                            <span style={{ fontWeight: 600, color: '#334155', fontSize: '0.78rem' }}>{r.locked_by || '—'}</span>
                            <span style={{ fontSize: '0.68rem' }}>{r.locked_at ? new Date(r.locked_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                          </span>
                        ) : <span style={{ color: '#94a3b8' }}>—</span>}
                      </td>
                    </tr>
                  )
                })}
                {endIdxInc < totalInchargeRows && (
                  <tr aria-hidden="true" style={{ height: (totalInchargeRows - endIdxInc) * ROW_H }}>
                    <td colSpan={8} style={{ padding: 0, border: 'none', height: (totalInchargeRows - endIdxInc) * ROW_H }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ASO — select 2 dept incharges per Centre×Dept */}
      {isASO && activeTab === 'incharges' && (
        <div className="card" style={{ padding: '1rem', marginTop: '1rem' }}>
          <div style={{ fontWeight: 800, fontSize: '0.92rem', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}><Crown size={16} style={{ color: '#8b5cf6' }} /> Select 2 Dept Incharges (ASO) — from pool, fallback any deployed sewadar</div>
          <div style={{ fontSize:'0.78rem', color:'#64748b', marginBottom:10 }}>Pick a CENTRE & department, then choose Rank 1 & 2. Pool members (already centre’s incharge) show as <span className="pill pill-green" style={{fontSize:'0.65rem'}}>Pool</span>; others as <span className="pill pill-amber" style={{fontSize:'0.65rem'}}>Fallback</span>.</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, alignItems:'center' }}>
            <select value={selCentre} onChange={e=>{ setSelCentre(e.target.value); setSelDept(''); setSel1(''); setSel2('') }} className="select" style={{ minWidth:160 }}>
              <option value="">Select Centre</option>
              {[...new Set(inchargesRows.map(r=>r.centre).concat([...new Set(deploymentsRaw.map(d=> getRootCentre(centres,d.centre)||d.centre))]))].filter(Boolean).sort((a,b)=>centreOrder(a,b)).map(c=> <option key={c} value={c}>{c} {locksRaw.some(l=>l.centre===c)?'🔒':''}</option>)}
            </select>
            <select value={selDept} onChange={e=>{ setSelDept(e.target.value); setSel1(''); setSel2('') }} className="select" style={{ minWidth:190 }} disabled={!selCentre}>
              <option value="">Select Department</option>
              {[...new Set(deploymentsRaw.filter(d=> (getRootCentre(centres,d.centre)||d.centre)===selCentre).map(d=> d.deployed_department_id||d.department_id).filter(Boolean))]
                .map(id=>deptMap.get(id)).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name)).map(d=> <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {(() => {
              const eligible = deploymentsRaw.filter(d=> (getRootCentre(centres,d.centre)||d.centre)===selCentre && (d.deployed_department_id||d.department_id)===selDept).map(d=>d.badge_number)
              const uniq = [...new Set(eligible)]
              const opts = uniq.map(badge=>{
                const inc = inchargesRaw.find(i=>i.centre===selCentre && i.department_id===selDept && i.badge_number===badge)
                const sw = [...regularSewadars, ...vssSewadars].find(s=>s.badge_number===badge)
                const name = sw?.sewadar_name || deploymentsRaw.find(d=>d.badge_number===badge)?.sewadar_name || badge
                return { badge, name, isPool: !!inc, is_vss: badge.startsWith('VS') }
              }).sort((a,b)=> a.name.localeCompare(b.name))
              const current = selectionsRaw.filter(s=>s.centre===selCentre && s.department_id===selDept).sort((a,b)=>a.rank-b.rank)
              const cur1 = current.find(s=>s.rank===1)?.badge_number || ''
              const cur2 = current.find(s=>s.rank===2)?.badge_number || ''
              if (!selDept) return null
              return (
                <>
                  <select value={sel1 || cur1} onChange={e=>setSel1(e.target.value)} className="select" style={{ minWidth:180 }}>
                    <option value="">Rank 1 — Select</option>
                    {opts.map(o=> <option key={o.badge} value={o.badge}>{o.name} ({o.badge}) {o.isPool?'[Pool]':'[Fallback]'} {o.is_vss?' VSS':''}</option>)}
                  </select>
                  <select value={sel2 || cur2} onChange={e=>setSel2(e.target.value)} className="select" style={{ minWidth:180 }}>
                    <option value="">Rank 2 — Select</option>
                    {opts.map(o=> <option key={o.badge} value={o.badge}>{o.name} ({o.badge}) {o.isPool?'[Pool]':'[Fallback]'} {o.is_vss?' VSS':''}</option>)}
                  </select>
                  <button
                    disabled={savingSel || (!sel1 && !cur1 && !sel2 && !cur2) || (sel1 && sel2 && sel1===sel2)}
                    onClick={async()=>{
                      if(sel1 && sel2 && sel1===sel2){ toast.error('Rank 1 and 2 cannot be same badge'); return }
                      setSavingSel(true)
                      try{
                        const toSave = []
                        if (sel1 || cur1) {
                          const badge = sel1 || cur1
                          const sw = [...regularSewadars, ...vssSewadars].find(s=>s.badge_number===badge)
                          toSave.push({ schedule_id: selectedScheduleId, centre: selCentre, department_id: selDept, badge_number: badge, sewadar_name: sw?.sewadar_name || badge, rank: 1 })
                        }
                        if (sel2 || cur2) {
                          const badge = sel2 || cur2
                          const sw = [...regularSewadars, ...vssSewadars].find(s=>s.badge_number===badge)
                          toSave.push({ schedule_id: selectedScheduleId, centre: selCentre, department_id: selDept, badge_number: badge, sewadar_name: sw?.sewadar_name || badge, rank: 2 })
                        }
                        for(const row of toSave){
                          const { error } = await supabase.from('department_incharge_selections').upsert(row, { onConflict: 'schedule_id,centre,department_id,rank' })
                          if(error) throw error
                        }
                        // remove rank that was cleared
                        if (!sel1 && cur1 && !toSave.some(r=>r.rank===1)) await supabase.from('department_incharge_selections').delete().eq('schedule_id',selectedScheduleId).eq('centre',selCentre).eq('department_id',selDept).eq('rank',1)
                        if (!sel2 && cur2 && !toSave.some(r=>r.rank===2)) await supabase.from('department_incharge_selections').delete().eq('schedule_id',selectedScheduleId).eq('centre',selCentre).eq('department_id',selDept).eq('rank',2)
                        toast.success('Incharge selection saved'); setSel1(''); setSel2('')
                        const { data } = await supabase.from('department_incharge_selections').select('*').eq('schedule_id',selectedScheduleId)
                        setSelectionsRaw(data||[])
                      }catch(e){ toast.error(e.message) } finally{ setSavingSel(false) }
                    }}
                    className="btn btn-primary"
                  >
                    {savingSel?'Saving…':'Save 2 Incharges'}
                  </button>
                  {current.length>0 && <span style={{fontSize:'0.75rem', color:'#64748b'}}>Current: {current.map(c=> `${c.rank}:${c.badge_number} ${c.is_from_pool?'Pool':'Fallback'}`).join(' · ')}</span>}
                </>
              )
            })()}
          </div>
          {selectionsRaw.length>0 && (
            <div style={{marginTop:10, fontSize:'0.78rem'}}>
              <div style={{fontWeight:700, marginBottom:4}}>All selections for this schedule:</div>
              <div style={{display:'flex', flexWrap:'wrap', gap:6}}>
                {selectionsRaw.slice(0,30).map(s=> <span key={s.id||`${s.centre}-${s.department_id}-${s.rank}`} className={`pill ${s.is_from_pool===false?'pill-amber':'pill-indigo'}`} style={{fontSize:'0.68rem'}}>{s.centre} · {deptMap.get(s.department_id)?.name||s.department_id} · Rank {s.rank}: {s.badge_number} {s.is_from_pool===false?'(Fallback)':'(Pool)'}</span>)}
                {selectionsRaw.length>30 && <span style={{fontSize:'0.72rem', color:'#94a3b8'}}>+{selectionsRaw.length-30} more</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
