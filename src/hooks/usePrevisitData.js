import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { reportRealtimeStatus } from '../lib/realtime'

/**
 * usePrevisitData — the single data owner behind BOTH previsit surfaces
 * (PrevisitDashboard + PrevisitView). Fetches the v62 RPCs once per
 * schedule, owns the staleness gate (rowsScheduleId/rowsAreCurrent) and
 * the debounced realtime refresh, so the two views can never disagree
 * about what the server said.
 *
 * The server already resolved the caller's scope — this returns exactly
 * what the RPCs return, never filtering by role.
 *
 * @param {string} scheduleId
 * @returns {{ summary, rows, deployed, loading, loadError, rowsAreCurrent, lastRefreshAt, reload }}
 */
async function rpcRows(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const msg = error.message || error.code || 'Unknown error'
    throw new Error(`${name}: ${msg}`)
  }
  return Array.isArray(data) ? data : []
}

export function usePrevisitData(scheduleId) {
  const [summary, setSummary] = useState([])
  const [rows, setRows] = useState([])
  const [deployed, setDeployed] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [rowsScheduleId, setRowsScheduleId] = useState(null)
  const [lastRefreshAt, setLastRefreshAt] = useState(null)

  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const reload = useCallback(async () => {
    if (!scheduleId) { setLoading(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const [sum, list, dep] = await Promise.all([
        rpcRows('previsit_summary', { p_schedule: scheduleId }),
        rpcRows('previsit_sewadars', { p_schedule: scheduleId }),
        rpcRows('previsit_deployed', { p_schedule: scheduleId }),
      ])
      if (!mountedRef.current || seq !== seqRef.current) return
      setSummary(sum)
      setRows(list)
      setDeployed(dep)
      setRowsScheduleId(scheduleId)
      setLoadError('')
      setLastRefreshAt(Date.now())
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setLoadError(err?.message || 'Could not load previsit attendance')
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [scheduleId])

  useEffect(() => { reload() }, [reload])

  // Live refresh on peer scans AND deployment changes (the Total tab
  // reads deployments): debounced reload, teardown warns nothing
  // (reportRealtimeStatus only warns on real faults while mounted).
  useEffect(() => {
    if (!scheduleId) return
    let alive = true
    let timer = null
    const queue = () => {
      if (!alive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (alive) reload() }, 600)
    }
    const channel = supabase
      .channel(`previsit-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: `schedule_id=eq.${scheduleId}` }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, queue)
      .subscribe((status) => reportRealtimeStatus('previsit', status, alive))
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [scheduleId, reload])

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
