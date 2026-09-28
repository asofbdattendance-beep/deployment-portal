import { describe, it, expect } from 'vitest'
import { deptNameMap, scanDisplay } from './scanDisplay'

// The module under test does not exist yet — this suite is the RED phase.

/* ─── helpers ─── */

// Every field the popup renders must be `string | null`, never undefined.
function expectStringOrNull(value) {
  expect(value === null || typeof value === 'string').toBe(true)
}

const DEPTS = [
  { id: 'd1', name: 'PAHELWAN' },
  { id: 'd2', name: 'KARYA KARTA' },
]

/* ─── deptNameMap ─── */
describe('deptNameMap', () => {
  it('returns an empty Map for an empty array', () => {
    const m = deptNameMap([])
    expect(m).toBeInstanceOf(Map)
    expect(m.size).toBe(0)
  })

  it('maps id -> name', () => {
    const m = deptNameMap([{ id: 'a', name: 'Alpha' }])
    expect(m.get('a')).toBe('Alpha')
    expect(m.size).toBe(1)
  })

  it('maps every row of a multi-department list', () => {
    const m = deptNameMap(DEPTS)
    expect(m.get('d1')).toBe('PAHELWAN')
    expect(m.get('d2')).toBe('KARYA KARTA')
    expect(m.size).toBe(2)
  })

  it('skips rows with a missing or blank id', () => {
    const m = deptNameMap([
      { id: '', name: 'NoId' },
      { id: '   ', name: 'BlankId' },
      { name: 'AbsentId' },
      { id: 'ok', name: 'Kept' },
    ])
    expect(m.size).toBe(1)
    expect(m.get('ok')).toBe('Kept')
  })

  it('skips rows with a missing or blank name', () => {
    const m = deptNameMap([
      { id: 'x', name: '' },
      { id: 'y', name: '   ' },
      { id: 'z' },
      { id: 'ok', name: 'Kept' },
    ])
    expect(m.size).toBe(1)
    expect(m.get('ok')).toBe('Kept')
  })

  it('skips null / non-object entries instead of throwing', () => {
    const m = deptNameMap([null, undefined, 'garbage', { id: 'ok', name: 'Kept' }])
    expect(m.size).toBe(1)
    expect(m.get('ok')).toBe('Kept')
  })

  it('trims the id and the name it stores', () => {
    const m = deptNameMap([{ id: '  d1  ', name: '  PAHELWAN  ' }])
    expect(m.get('d1')).toBe('PAHELWAN')
  })

  it('tolerates a null argument', () => {
    expect(deptNameMap(null)).toBeInstanceOf(Map)
    expect(deptNameMap(null).size).toBe(0)
  })

  it('tolerates an undefined argument (default parameter)', () => {
    expect(deptNameMap()).toBeInstanceOf(Map)
    expect(deptNameMap().size).toBe(0)
  })
})

/* ─── scanDisplay — name ─── */
describe('scanDisplay — name', () => {
  it('reads sewadar_name', () => {
    expect(scanDisplay({ sewadar_name: 'Smt. Asha Verma' }).name).toBe('Smt. Asha Verma')
  })

  it('falls back to name when sewadar_name is absent', () => {
    expect(scanDisplay({ name: 'Kumar' }).name).toBe('Kumar')
  })

  it('prefers sewadar_name over name when both are present', () => {
    expect(scanDisplay({ sewadar_name: 'Primary', name: 'Secondary' }).name).toBe('Primary')
  })

  it('yields null (NOT an empty string) for a blank name', () => {
    expect(scanDisplay({ sewadar_name: '' }).name).toBeNull()
  })

  it('yields null for a null or undefined name', () => {
    expect(scanDisplay({ sewadar_name: null }).name).toBeNull()
    expect(scanDisplay({ name: undefined }).name).toBeNull()
    expect(scanDisplay({}).name).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(scanDisplay({ sewadar_name: '  Asha Verma  ' }).name).toBe('Asha Verma')
  })

  it('yields null for a whitespace-only name', () => {
    expect(scanDisplay({ sewadar_name: '   ' }).name).toBeNull()
  })
})

/* ─── scanDisplay — centre (v40: `centre` is the VENUE, never the label) ─── */
describe('scanDisplay — centre', () => {
  it('reads sewadar_centre', () => {
    expect(scanDisplay({ sewadar_centre: 'DELHI-7' }).centre).toBe('DELHI-7')
  })

  it('NEVER reads the venue in `centre` — returns the home centre', () => {
    // Since v40 `dp_attendance_sessions.centre` holds one physical scan venue.
    const row = { centre: 'Bhati - Delhi MC', sewadar_centre: 'DELHI-7' }
    expect(scanDisplay(row).centre).toBe('DELHI-7')
  })

  it('returns null when only the venue `centre` is set', () => {
    expect(scanDisplay({ centre: 'Bhati - Delhi MC' }).centre).toBeNull()
  })

  it('returns null when neither centre column is set', () => {
    expect(scanDisplay({ sewadar_name: 'Asha' }).centre).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(scanDisplay({ sewadar_centre: '  DELHI-7  ' }).centre).toBe('DELHI-7')
  })

  it('yields null for a whitespace-only home centre', () => {
    expect(scanDisplay({ sewadar_centre: '   ' }).centre).toBeNull()
  })

  it('yields null for a null home centre', () => {
    expect(scanDisplay({ sewadar_centre: null, centre: 'Bhati - Delhi MC' }).centre).toBeNull()
  })
})

/* ─── scanDisplay — deptName ─── */
describe('scanDisplay — deptName', () => {
  it('prefers dept_name (the string a v43 RPC returns)', () => {
    const row = { dept_name: 'PAHELWAN', sewadar_dept: 'd1' }
    expect(scanDisplay(row, deptNameMap(DEPTS)).deptName).toBe('PAHELWAN')
  })

  it('prefers dept_name even when it disagrees with the map lookup', () => {
    const row = { dept_name: 'RPC NAME', sewadar_dept: 'd1' }
    expect(scanDisplay(row, deptNameMap(DEPTS)).deptName).toBe('RPC NAME')
  })

  it('resolves sewadar_dept through the map when dept_name is absent', () => {
    expect(scanDisplay({ sewadar_dept: 'd1' }, deptNameMap(DEPTS)).deptName).toBe('PAHELWAN')
  })

  it('returns null when sewadar_dept is missing from the map — never the raw uuid', () => {
    const uuid = '3f9a1c2e-0000-4000-8000-abcdefabcdef'
    expect(scanDisplay({ sewadar_dept: uuid }, deptNameMap(DEPTS)).deptName).toBeNull()
  })

  it('returns null when there is no department at all', () => {
    expect(scanDisplay({ sewadar_name: 'Asha' }, deptNameMap(DEPTS)).deptName).toBeNull()
  })

  it('returns null for a null sewadar_dept', () => {
    expect(scanDisplay({ sewadar_dept: null }, deptNameMap(DEPTS)).deptName).toBeNull()
  })

  it('yields null for a blank dept_name and does not fall through to the map', () => {
    // A blank RPC string is still a value — it must not be replaced by a lookup.
    expect(scanDisplay({ dept_name: '   ', sewadar_dept: 'd1' }, deptNameMap(DEPTS)).deptName).toBeNull()
  })

  it('trims the resolved name', () => {
    expect(scanDisplay({ dept_name: '  PAHELWAN  ' }).deptName).toBe('PAHELWAN')
  })

  it('yields null for a whitespace-only dept_name', () => {
    expect(scanDisplay({ dept_name: '   ' }).deptName).toBeNull()
  })

  it('tolerates an undefined or null deptNameById (no throw)', () => {
    expect(() => scanDisplay({ sewadar_dept: 'd1' })).not.toThrow()
    expect(scanDisplay({ sewadar_dept: 'd1' }).deptName).toBeNull()
    expect(scanDisplay({ sewadar_dept: 'd1' }, null).deptName).toBeNull()
  })
})

/* ─── scanDisplay — defensive shape ─── */
describe('scanDisplay — null / undefined payload', () => {
  it('returns an all-null display triple for null and does not throw', () => {
    expect(() => scanDisplay(null)).not.toThrow()
    expect(scanDisplay(null)).toEqual({
      name: null, centre: null, deptName: null, isVss: false, undeployed: false,
    })
  })

  it('returns an all-null display triple for undefined', () => {
    expect(scanDisplay(undefined)).toEqual({
      name: null, centre: null, deptName: null, isVss: false, undeployed: false,
    })
  })

  it('works with no deptNameById argument at all', () => {
    expect(scanDisplay({ sewadar_name: 'Asha' })).toEqual({
      name: 'Asha', centre: null, deptName: null, isVss: false, undeployed: false,
    })
  })

  it('tolerates a non-object payload without throwing', () => {
    expect(() => scanDisplay('nonsense')).not.toThrow()
    expect(scanDisplay('nonsense').name).toBeNull()
  })
})

/* ─── scanDisplay — return shape ─── */
describe('scanDisplay — return shape', () => {
  it('has exactly the five documented keys, no more and no fewer', () => {
    expect(Object.keys(scanDisplay({ sewadar_name: 'Asha' })).sort()).toEqual([
      'centre', 'deptName', 'isVss', 'name', 'undeployed',
    ])
  })

  it('types every field as string | null (booleans for the two flags)', () => {
    const out = scanDisplay(
      { sewadar_name: 'Asha', sewadar_centre: 'DELHI-7', dept_name: 'PAHELWAN', is_vss: true },
      deptNameMap(DEPTS),
    )
    expectStringOrNull(out.name)
    expectStringOrNull(out.centre)
    expectStringOrNull(out.deptName)
    expect(typeof out.isVss).toBe('boolean')
    expect(typeof out.undeployed).toBe('boolean')
  })

  it('never returns undefined for any of the three text fields', () => {
    const out = scanDisplay({ sewadar_dept: 'd1' })
    for (const key of ['name', 'centre', 'deptName']) {
      expect(out[key]).not.toBeUndefined()
    }
  })
})

/* ─── scanDisplay — VSS / Flagged pills ─── */
describe('scanDisplay — isVss / undeployed flags', () => {
  it('derives isVss from payload.is_vss', () => {
    expect(scanDisplay({ is_vss: true }).isVss).toBe(true)
    expect(scanDisplay({ is_vss: false }).isVss).toBe(false)
  })

  it('defaults isVss to false when the RPC omits the flag', () => {
    expect(scanDisplay({ sewadar_name: 'Asha' }).isVss).toBe(false)
    expect(scanDisplay(null).isVss).toBe(false)
  })

  it('derives undeployed from payload.undeployed_scan', () => {
    expect(scanDisplay({ undeployed_scan: true }).undeployed).toBe(true)
    expect(scanDisplay({ undeployed_scan: false }).undeployed).toBe(false)
  })

  it('defaults undeployed to false when the RPC omits the flag', () => {
    expect(scanDisplay({ sewadar_name: 'Asha' }).undeployed).toBe(false)
    expect(scanDisplay(null).undeployed).toBe(false)
  })

  it('exposes both flags alongside the text triple on a real session row', () => {
    const row = {
      sewadar_name: 'Smt. Asha Verma',
      centre: 'Bhati - Delhi MC',
      sewadar_centre: 'DELHI-7',
      sewadar_dept: 'd2',
      is_vss: true,
      undeployed_scan: false,
    }
    expect(scanDisplay(row, deptNameMap(DEPTS))).toEqual({
      name: 'Smt. Asha Verma',
      centre: 'DELHI-7',
      deptName: 'KARYA KARTA',
      isVss: true,
      undeployed: false,
    })
  })
})
