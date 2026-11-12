import { describe, it, expect } from 'vitest'
import { findEligibleInchargeRow, staleInchargeKeys, departmentsNeedingIncharge, indexSewadarsByRoot, sewadarInRoot } from './incharges'

const ROOT = 'FARIDABAD'
const SUB = 'NIT - 2'
const SEC = 'd-sec'
const LAN = 'd-lan'

const rows = {
  [`${ROOT}|R1`]: { centre: ROOT, badge_number: 'R1', sewadar_name: 'ROOT ONE', consent_given: true, requested_dept: SEC, final_dept: null },
  [`${SUB}|S1`]: { centre: SUB, badge_number: 'S1', sewadar_name: 'SUB ONE', consent_given: true, requested_dept: SEC, final_dept: null },
  [`${SUB}|S2`]: { centre: SUB, badge_number: 'S2', sewadar_name: 'SUB TWO', consent_given: true, requested_dept: SEC, final_dept: LAN },
  [`${SUB}|S3`]: { centre: SUB, badge_number: 'S3', sewadar_name: 'SUB THREE', consent_given: false, requested_dept: SEC, final_dept: null },
}

describe('findEligibleInchargeRow', () => {
  it('finds a root-centre sewadar deployed to the department', () => {
    expect(findEligibleInchargeRow(rows, 'R1', SEC)?.sewadar_name).toBe('ROOT ONE')
  })

  it('finds a sub-centre sewadar deployed to the department', () => {
    expect(findEligibleInchargeRow(rows, 'S1', SEC)?.sewadar_name).toBe('SUB ONE')
  })

  it('judges by the effective department (final over requested)', () => {
    expect(findEligibleInchargeRow(rows, 'S2', SEC)).toBeUndefined()
    expect(findEligibleInchargeRow(rows, 'S2', LAN)?.sewadar_name).toBe('SUB TWO')
  })

  it('rejects a sewadar without consent', () => {
    expect(findEligibleInchargeRow(rows, 'S3', SEC)).toBeUndefined()
  })

  it('returns undefined for unknown badge or empty input', () => {
    expect(findEligibleInchargeRow(rows, 'NOPE', SEC)).toBeUndefined()
    expect(findEligibleInchargeRow({}, 'R1', SEC)).toBeUndefined()
    expect(findEligibleInchargeRow(null, 'R1', SEC)).toBeUndefined()
    expect(findEligibleInchargeRow(rows, '', SEC)).toBeUndefined()
  })
})

describe('staleInchargeKeys', () => {
  it('keeps a sub-centre incharge stored against the root centre', () => {
    const inc = { [`${ROOT}|${SEC}`]: { centre: ROOT, department_id: SEC, badge_number: 'S1' } }
    expect(staleInchargeKeys(inc, rows)).toEqual([])
  })

  it('keeps a root-centre incharge', () => {
    const inc = { [`${ROOT}|${SEC}`]: { centre: ROOT, department_id: SEC, badge_number: 'R1' } }
    expect(staleInchargeKeys(inc, rows)).toEqual([])
  })

  it('flags an incharge who moved to another department', () => {
    const inc = { [`${ROOT}|${SEC}`]: { centre: ROOT, department_id: SEC, badge_number: 'S2' } }
    expect(staleInchargeKeys(inc, rows)).toEqual([`${ROOT}|${SEC}`])
  })

  it('flags an incharge who withdrew consent or is gone', () => {
    const inc = {
      [`${ROOT}|${SEC}`]: { centre: ROOT, department_id: SEC, badge_number: 'S3' },
      [`${ROOT}|${LAN}`]: { centre: ROOT, department_id: LAN, badge_number: 'GONE' },
    }
    expect(staleInchargeKeys(inc, rows).sort()).toEqual([`${ROOT}|${LAN}`, `${ROOT}|${SEC}`])
  })

  it('does not mutate its inputs', () => {
    const inc = Object.freeze({ [`${ROOT}|${SEC}`]: Object.freeze({ centre: ROOT, department_id: SEC, badge_number: 'S1' }) })
    expect(() => staleInchargeKeys(inc, Object.freeze({ ...rows }))).not.toThrow()
  })
})

describe('departmentsNeedingIncharge', () => {
  const alloc = (id) => ({ department_id: id, max_count: 10 })

  it('needs an incharge where a consented non-VSS sewadar effectively sits', () => {
    const r = { a: { badge_number: 'B1', consent_given: true, requested_dept: SEC, final_dept: '' } }
    expect(departmentsNeedingIncharge([alloc(SEC), alloc(LAN)], r).map(a => a.department_id)).toEqual([SEC])
  })

  it('follows the ASO final department, not the requested one', () => {
    // requested SECURITY, ASO moved to LANGAR: SECURITY has nobody eligible,
    // so it must not block the lock; LANGAR now needs the incharge
    const r = { a: { badge_number: 'B1', consent_given: true, requested_dept: SEC, final_dept: LAN } }
    expect(departmentsNeedingIncharge([alloc(SEC), alloc(LAN)], r).map(a => a.department_id)).toEqual([LAN])
  })

  it('ignores VSS badges and non-consented rows', () => {
    const r = {
      v: { badge_number: 'VS1234', consent_given: true, requested_dept: SEC, final_dept: '' },
      n: { badge_number: 'B2', consent_given: false, requested_dept: SEC, final_dept: '' },
    }
    expect(departmentsNeedingIncharge([alloc(SEC)], r)).toEqual([])
  })

  it('every department it returns has at least one eligible incharge', () => {
    const r = {
      a: { badge_number: 'B1', consent_given: true, requested_dept: SEC, final_dept: LAN },
      b: { badge_number: 'B2', consent_given: true, requested_dept: LAN, final_dept: '' },
    }
    departmentsNeedingIncharge([alloc(SEC), alloc(LAN)], r).forEach(a => {
      expect(Object.values(r).some(row => findEligibleInchargeRow(r, row.badge_number, a.department_id))).toBe(true)
    })
  })
})

describe('indexSewadarsByRoot / sewadarInRoot', () => {
  const rootOf = (c) => (c === SUB ? ROOT : c)
  const sewadars = [
    { centre: ROOT, badge_number: 'R1', is_initiated: true, gender: 'M' },
    { centre: SUB, badge_number: 'S1', is_initiated: true, gender: 'F' },
    { centre: 'OTHER', badge_number: 'S1', is_initiated: false, gender: 'M' },
  ]
  const index = indexSewadarsByRoot(sewadars, rootOf)

  it('finds a sub-centre sewadar for an incharge stored against the root', () => {
    expect(sewadarInRoot(index, rootOf, ROOT, 'S1')).toBe(sewadars[1])
  })

  it('finds a root-centre sewadar', () => {
    expect(sewadarInRoot(index, rootOf, ROOT, 'R1')).toBe(sewadars[0])
  })

  it('never crosses into another root centre', () => {
    expect(sewadarInRoot(index, rootOf, 'OTHER', 'R1')).toBeUndefined()
    expect(sewadarInRoot(index, rootOf, 'OTHER', 'S1')).toBe(sewadars[2])
  })

  it('tolerates empty input', () => {
    expect(sewadarInRoot(indexSewadarsByRoot(null, rootOf), rootOf, ROOT, 'R1')).toBeUndefined()
  })

  it('handles portal-scale data quickly (60k sewadars, 2k incharge lookups)', () => {
    const many = Array.from({ length: 60000 }, (_, i) => ({ centre: i % 2 ? SUB : ROOT, badge_number: `B${i}` }))
    const t0 = performance.now()
    const idx = indexSewadarsByRoot(many, rootOf)
    for (let i = 0; i < 2000; i++) sewadarInRoot(idx, rootOf, ROOT, `B${i * 7}`)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(sewadarInRoot(idx, rootOf, ROOT, 'B59999')).toBe(many[59999])
  })
})
