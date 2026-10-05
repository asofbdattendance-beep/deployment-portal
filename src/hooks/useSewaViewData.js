import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase, fetchAllRpc } from '../lib/supabase'
import { reportRealtimeStatus } from '../lib/realtime'
import { SEWA_MODE_VISIT } from '../lib/sewaMode'
import { buildVisitRows, buildVisitDeployed, applyVisitFlags } from '../lib/sewaView'
import { usePrevisitData } from './usePrevisitData'

/**
 * Single-shot grouped RPC read (centre × date grain — never paged, so a
 * missing RPC_PAGE_SPECS entry is correct, mirroring previsit_summary).
 */
async function rpcRows(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const msg = error.message || error.code || 'Unknown error'
    throw new Error(`${name}: ${msg}`)
  }
  return Array.isArray(data) ? data : []
}

/**
 * Visit lens: the same { summary, rows, deployed, … } contract as
 * usePrevisitData, normalized from the visit feeds so the shared SewaView
 * renders Bhati Visit with the previsit register UX and only the dates
 * differ:
 *
 *   summary  ← attendance_centre_daily (v74, centre × visit date)
 *   rows     ← attendance_day_badges p_mode=present per window date,
 *              stamped with its day (buildVisitRows)
 *   deployed ← present ∪ absent union across the window (buildVisitDeployed)
 *   flags    ← attendance_sewadar_summary overlays still_open /
 *              undeployed_scan (applyVisitFlags; repeat-scan day grain
 *              stays unavailable by design)
 *
 * A failed feed raises loadError (never a confident empty view); the view
 * holds its last good snapshot while a refresh is in flight.
 */
function useVisitViewData(scheduleId, windowDates, enabled) {
  const [summary, setSummary] = useState([])
  const [rows, setRows] = useState([])
  const [deployed, setDeployed] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const [lastRefreshAt, setLastRefreshAt] = useState(null)

  // The date list is a fresh array per render — key it stably so reload
  // identity (and the realtime effect below) survives re-renders.
  const datesKey = useMemo(() => {
    const set = new Set()
    for (const d of Array.isArray(windowDates) ? windowDates : []) {
      const s = typeof d === 'string' ? d.slice(0, 10) : ''
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) set.add(s)
    }
    return [...set].sort().join(',')
  }, [windowDates])

  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const reload = useCallback(async () => {
    if (!scheduleId || !enabled) { setLoading(false); return }
    const dates = datesKey ? datesKey.split(',') : []
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const [daily, perDate, scanned] = await Promise.all([
        rpcRows('attendance_centre_daily', { p_schedule: scheduleId }),
        Promise.all(dates.map((d) => Promise.all([
          fetchAllRpc('attendance_day_badges', { p_schedule: scheduleId, p_date: d, p_mode: 'present' }),
          fetchAllRpc('attendance_day_badges', { p_schedule: scheduleId, p_date: d, p_mode: 'absent' }),
        ]))),
        fetchAllRpc('attendance_sewadar_summary', { p_schedule: scheduleId }),
      ])
      if (!mountedRef.current || seq !== seqRef.current) return
      const stamped = buildVisitRows(perDate, dates)
      setSummary(daily)
      setRows(applyVisitFlags(stamped, scanned, dates[dates.length - 1] || ''))
      setDeployed(buildVisitDeployed(perDate))
      setRowsScheduleId(scheduleId)
      setLoadError('')
      setLastRefreshAt(Date.now())
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setLoadError(err?.message || 'Could not load Bhati visit attendance')
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId, enabled, datesKey])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (!scheduleId || !enabled) return
    let alive = true
    let timer = null
    const queue = () => {
      if (!alive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (alive) reload() }, 600)
    }
    const channel = supabase
      .channel(`sewaview-visit-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, queue)
      .subscribe((status) => reportRealtimeStatus('sewaview-visit', status, alive))
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [scheduleId, reload, enabled])

  return {
    summary,
    rows,
    deployed,
    loading,
    loadError,
    rowsScheduleId,
    rowsAreCurrent: rowsScheduleId === scheduleId,
    lastRefreshAt,
    reload,
  }
}

/**
 * useSewaViewData — one data owner for the shared SewaView register.
 * Both lenses stay mounted (rules of hooks); the inactive lens is
 * disabled and costs zero RPCs. The returned contract is identical in
 * both modes: { summary, rows, deployed, loading, loadError,
 * rowsScheduleId, rowsAreCurrent, lastRefreshAt, reload }.
 *
 * @param {string} scheduleId
 * @param {string} mode SEWA_MODE_PREVISIT | SEWA_MODE_VISIT
 * @param {string[]} windowDates visit window dates (visit mode only)
 */
export function useSewaViewData(scheduleId, mode, windowDates) {
  const isVisit = mode === SEWA_MODE_VISIT
  const previsit = usePrevisitData(scheduleId, !isVisit)
  const visit = useVisitViewData(scheduleId, windowDates, isVisit)
  return isVisit ? visit : previsit
}
