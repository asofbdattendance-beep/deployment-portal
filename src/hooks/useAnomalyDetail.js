import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const SESSION_COLS = [
  'id', 'badge_number', 'sewadar_name', 'sewadar_centre', 'sewadar_dept',
  'is_vss', 'status', 'centre',
  'in_date', 'in_time', 'in_scanner_badge', 'in_scanner_name', 'in_scanner_centre',
  'is_manual', 'undeployed_scan',
  'out_date', 'out_time', 'out_scanner_badge', 'out_scanner_name', 'out_scanner_centre',
].join(',')

const DEPLOYMENT_COLS = 'id,badge_number,sewadar_name,centre,department_id,deployed_department_id,status'

const CONSENT_COLS = 'id,badge_number,sewadar_name,centre,consent_given,available_days_count,stay_at_bhati,chair_pass'

/**
 * useAnomalyDetail — the "info trail" behind an anomaly row.
 *
 * Composed client-side from the three tables aso/super_admin may already
 * read (the Anomalies page is aso/super_admin-only, so RLS admits all of
 * them) — no new SQL:
 *   - every session for this badge × schedule, chronological (the trail:
 *     each IN/OUT with who scanned which side, venue, manual/undeployed);
 *   - the deployment row: requested department_id + final
 *     deployed_department_id (related info);
 *   - the consent row: consent/days/stay/chair (related info).
 *
 * Each source fails soft independently: a missing consent (or a consent
 * read the role cannot see) yields `consent: null`, never a blank popup.
 * Sessions are the payload — when they fail, `error` is set and the
 * popup says so instead of rendering a healthy-looking empty trail.
 */
export function useAnomalyDetail(scheduleId, badgeNumber) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const badge = (badgeNumber || '').trim()
    if (!scheduleId || !badge) {
      seqRef.current += 1
      setDetail(null)
      setLoading(false)
      setError(null)
      return undefined
    }
    setLoading(true)
    setError(null)
    const seq = ++seqRef.current
    let cancelled = false
    ;(async () => {
      try {
        const [sessRes, depRes, conRes] = await Promise.all([
          supabase
            .from('dp_attendance_sessions')
            .select(SESSION_COLS)
            .eq('schedule_id', scheduleId)
            .eq('badge_number', badge)
            .order('in_date', { ascending: true })
            .order('in_time', { ascending: true }),
          supabase
            .from('deployments')
            .select(DEPLOYMENT_COLS)
            .eq('schedule_id', scheduleId)
            .eq('badge_number', badge)
            .limit(1),
          supabase
            .from('sewadar_consents')
            .select(CONSENT_COLS)
            .eq('schedule_id', scheduleId)
            .eq('badge_number', badge)
            .limit(1),
        ])
        if (cancelled || seq !== seqRef.current) return
        if (sessRes.error) throw sessRes.error
        const sessions = Array.isArray(sessRes.data) ? sessRes.data : []
        setDetail({
          badge_number: badge,
          sessions,
          deployment: Array.isArray(depRes.data) && depRes.data.length > 0 ? depRes.data[0] : null,
          deploymentError: depRes.error || null,
          consent: Array.isArray(conRes.data) && conRes.data.length > 0 ? conRes.data[0] : null,
          consentError: conRes.error || null,
        })
      } catch (e) {
        if (cancelled || seq !== seqRef.current) return
        setDetail(null)
        setError(e)
      } finally {
        if (!cancelled && seq === seqRef.current) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [scheduleId, badgeNumber])

  return { detail, loading, error }
}
