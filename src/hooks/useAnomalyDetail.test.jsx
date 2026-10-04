// @vitest-environment jsdom
// useAnomalyDetail — the info-trail composer behind the anomaly popup.
//
// Pinned: (1) all three sources are fetched for the badge × schedule and
// composed into one payload; (2) a missing consent degrades to
// `consent: null`, never a blank popup; (3) a sessions failure surfaces
// as `error` (a broken trail must never render as a clean one).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAnomalyDetail } from './useAnomalyDetail'

const tables = vi.hoisted(() => ({ data: {}, error: {} }))

function chainable(table) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    then: (resolve) => Promise.resolve(resolve({
      data: tables.data[table] ?? null,
      error: tables.error[table] ?? null,
    })),
  }
  return q
}

vi.mock('../lib/supabase', () => ({
  supabase: { from: (table) => chainable(table) },
}))

const SESSION = {
  id: 's1', badge_number: 'FB5971GA0001', sewadar_name: 'Ram Sewak',
  sewadar_centre: 'CENTRE A', sewadar_dept: 'dept-1', is_vss: false,
  status: 'CLOSED', centre: 'Bhati - Delhi MC',
  in_date: '2026-09-30', in_time: '09:12:00',
  in_scanner_badge: 'SC01', in_scanner_name: 'Scanner One', in_scanner_centre: 'CENTRE A',
  is_manual: false, undeployed_scan: false,
  out_date: '2026-09-30', out_time: '18:30:00',
  out_scanner_badge: 'SC02', out_scanner_name: 'Scanner Two', out_scanner_centre: 'CENTRE A',
}
const DEPLOYMENT = { id: 'd1', badge_number: 'FB5971GA0001', department_id: 'dept-1', deployed_department_id: 'dept-2', status: 'requested' }
const CONSENT = { id: 'c1', badge_number: 'FB5971GA0001', consent_given: true, available_days_count: 5, stay_at_bhati: true, chair_pass: false }

beforeEach(() => {
  tables.data = {
    dp_attendance_sessions: [SESSION],
    deployments: [DEPLOYMENT],
    sewadar_consents: [CONSENT],
  }
  tables.error = {}
})

describe('useAnomalyDetail', () => {
  it('composes sessions, deployment and consent for the badge', async () => {
    const { result } = renderHook(() => useAnomalyDetail('sched-1', 'FB5971GA0001'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.detail.badge_number).toBe('FB5971GA0001')
    expect(result.current.detail.sessions).toHaveLength(1)
    expect(result.current.detail.sessions[0].in_scanner_name).toBe('Scanner One')
    expect(result.current.detail.deployment.deployed_department_id).toBe('dept-2')
    expect(result.current.detail.consent.available_days_count).toBe(5)
  })

  it('degrades a missing consent to null instead of blanking the trail', async () => {
    tables.data.sewadar_consents = []
    const { result } = renderHook(() => useAnomalyDetail('sched-1', 'FB5971GA0001'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.detail.sessions).toHaveLength(1)
    expect(result.current.detail.consent).toBeNull()
  })

  it('surfaces a sessions failure as error with no detail', async () => {
    tables.data.dp_attendance_sessions = null
    tables.error.dp_attendance_sessions = { message: 'denied' }
    const { result } = renderHook(() => useAnomalyDetail('sched-1', 'FB5971GA0001'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.detail).toBeNull()
    expect(result.current.error).toBeTruthy()
  })

  it('queries nothing without schedule and badge', async () => {
    const { result } = renderHook(() => useAnomalyDetail(null, ''))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.detail).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
