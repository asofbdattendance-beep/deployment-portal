import { describe, it, expect } from 'vitest'
import { buildPrevReference, isNotReported } from './prevSession'

const legacy = [
  { badge_number: 'FB1', prev_department: 'LANGAR', attendance_reported: 4 },
  { badge_number: 'FB2', prev_department: 'SECURITY', attendance_reported: 1 },
]

describe('buildPrevReference', () => {
  it('uses the previous session rows when the RPC found a previous schedule', () => {
    const rpc = {
      prev_schedule_id: 's-oct',
      prev_schedule_name: 'October 2026 Visit',
      rows: [
        { centre: 'C1', badge_number: 'FB1', prev_department: 'MEDICAL', attendance_reported: 5 },
        { centre: 'C1', badge_number: 'FB3', prev_department: 'LUGGAGE', attendance_reported: 0 },
      ],
    }

    const ref = buildPrevReference(rpc, legacy)

    expect(ref.source).toBe('session')
    expect(ref.prevScheduleName).toBe('October 2026 Visit')
    expect(ref.map.FB1).toEqual({ prev_department: 'MEDICAL', attendance_reported: 5 })
    expect(ref.map.FB3).toEqual({ prev_department: 'LUGGAGE', attendance_reported: 0 })
  })

  it('does not mix legacy import rows into a previous-session result', () => {
    const rpc = { prev_schedule_id: 's-oct', prev_schedule_name: 'Oct', rows: [] }

    const ref = buildPrevReference(rpc, legacy)

    expect(ref.map.FB2).toBeUndefined()
  })

  it('falls back to the legacy import when there is no previous schedule', () => {
    const rpc = { prev_schedule_id: null, prev_schedule_name: null, rows: [] }

    const ref = buildPrevReference(rpc, legacy)

    expect(ref.source).toBe('legacy')
    expect(ref.prevScheduleName).toBeNull()
    expect(ref.map.FB2).toEqual({ prev_department: 'SECURITY', attendance_reported: 1 })
  })

  it('falls back to the legacy import when the RPC result is missing (migration not applied)', () => {
    const ref = buildPrevReference(null, legacy)

    expect(ref.source).toBe('legacy')
    expect(ref.map.FB1.attendance_reported).toBe(4)
  })

  it('keeps the higher attendance when a badge appears twice', () => {
    const rpc = {
      prev_schedule_id: 's', prev_schedule_name: 'S',
      rows: [
        { centre: 'A', badge_number: 'FB9', prev_department: 'LANGAR', attendance_reported: 1 },
        { centre: 'B', badge_number: 'FB9', prev_department: 'CANTEEN', attendance_reported: 3 },
      ],
    }

    expect(buildPrevReference(rpc, []).map.FB9).toEqual({ prev_department: 'CANTEEN', attendance_reported: 3 })
  })

  it('preserves a null attendance (previous schedule had no visit window)', () => {
    const rpc = { prev_schedule_id: 's', prev_schedule_name: 'S', rows: [{ centre: 'A', badge_number: 'FB5', prev_department: 'LANGAR', attendance_reported: null }] }

    expect(buildPrevReference(rpc, []).map.FB5.attendance_reported).toBeNull()
  })

  it('tolerates null / malformed inputs', () => {
    expect(buildPrevReference(undefined, undefined)).toEqual({ source: 'legacy', prevScheduleName: null, map: {} })
    expect(buildPrevReference({ prev_schedule_id: 's', rows: null }, null).map).toEqual({})
  })
})

describe('isNotReported', () => {
  it('is true when deployed last session but zero visit days scanned', () => {
    expect(isNotReported(0, 'LANGAR')).toBe(true)
  })

  it('is false when the badge was not deployed last session', () => {
    expect(isNotReported(0, null)).toBe(false)
    expect(isNotReported(null, null)).toBe(false)
  })

  it('is false for any reported attendance or unknown attendance', () => {
    expect(isNotReported(1, 'LANGAR')).toBe(false)
    expect(isNotReported(null, 'LANGAR')).toBe(false)
  })
})
