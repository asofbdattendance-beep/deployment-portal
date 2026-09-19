import { describe, it, expect } from 'vitest'
import {
  effectiveDeptId,
  isVssRow,
  isFinalizedRow,
  deploymentCounts,
  consentCounts,
  verifyDeploymentCounts,
  scheduleBreakdown,
  verifyScheduleBreakdown,
} from './counts.js'

// Synthetic fixture only — no real sewadar data.
// Shape mirrors the production defect: a large single-centre tie group
// (GURGAON-like) straddling a page boundary, plus VSS + finalized rows.
function fixture() {
  const depts = { OE: 'dept-oe', SEC: 'dept-sec', LAN: 'dept-lan' }
  const rows = []
  const push = (centre, badge, dept, extra = {}) =>
    rows.push({ centre, badge_number: badge, department_id: dept, deployed_department_id: null, ...extra })
  // GURGAON-like block: 12 rows, 3 VSS, 2 finalized
  ;['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'].forEach((b, i) =>
    push('GURGAON', `FB${i}`, i % 2 ? depts.OE : depts.LAN))
  push('GURGAON', 'VSFB1', depts.OE)
  push('GURGAON', 'VSFB2', depts.SEC)
  push('GURGAON', 'FBX1', depts.SEC, { deployed_department_id: depts.SEC })
  // other centres
  push('ANKHEER', 'FBA1', depts.OE, { deployed_department_id: depts.OE })
  push('ANKHEER', 'FBA2', depts.LAN)
  push('NIT - 2', 'FBN1', depts.SEC)
  const vss = new Set(['VSFB1', 'VSFB2', 'VSFB3'])
  return { rows, depts, vss }
}

describe('effectiveDeptId / isVssRow / isFinalizedRow', () => {
  it('effective dept prefers the ASO final, else the request', () => {
    expect(effectiveDeptId({ department_id: 'a', deployed_department_id: 'b' })).toBe('b')
    expect(effectiveDeptId({ department_id: 'a', deployed_department_id: null })).toBe('a')
    expect(effectiveDeptId({})).toBeNull()
    expect(effectiveDeptId(null)).toBeNull()
  })

  it('VSS classifier mirrors the DB triggers (set membership OR prefix)', () => {
    const vss = new Set(['VSFB1'])
    expect(isVssRow({ badge_number: 'VSFB1' }, vss)).toBe(true)
    expect(isVssRow({ badge_number: 'VSFB9' }, vss)).toBe(true) // prefix fallback
    expect(isVssRow({ badge_number: 'vsfb9' }, vss)).toBe(true) // case-insensitive
    expect(isVssRow({ badge_number: 'FB1' }, vss)).toBe(false)
    expect(isVssRow({ badge_number: 'FB1' }, null)).toBe(false)
    expect(isVssRow({}, vss)).toBe(false)
  })

  it('finalized only when the ASO actually set a final department', () => {
    expect(isFinalizedRow({ deployed_department_id: 'x' })).toBe(true)
    expect(isFinalizedRow({ department_id: 'x', deployed_department_id: null })).toBe(false)
    expect(isFinalizedRow({})).toBe(false)
  })
})

describe('deploymentCounts', () => {
  it('splits regular/VSS/finalized and rolls up by centre and department', () => {
    const { rows, vss } = fixture()
    const c = deploymentCounts(rows, { vssBadgeSet: vss, rootOf: (x) => x })
    expect(c.total).toBe(rows.length)
    expect(c.vss).toBe(2)
    expect(c.regular).toBe(rows.length - 2)
    expect(c.finalized).toBe(2)
    expect(c.requestedOnly).toBe(rows.length - 2)
    expect(c.byCentre['GURGAON'].total).toBe(12)
    expect(c.byCentre['GURGAON'].vss).toBe(2)
    expect(c.byCentre['ANKHEER'].finalized).toBe(1)
    expect(Object.values(c.byDept).reduce((s, b) => s + b.total, 0)).toBe(rows.length)
  })

  it('verifyDeploymentCounts passes a consistent build', () => {
    const { rows, vss } = fixture()
    const c = deploymentCounts(rows, { vssBadgeSet: vss, rootOf: (x) => x })
    expect(verifyDeploymentCounts(c, 't')).toEqual([])
  })

  it('verifyDeploymentCounts flags regular+vss, byCentre and byDept breaks', () => {
    expect(verifyDeploymentCounts({ total: 10, regular: 6, vss: 3, finalized: 0, byCentre: {}, byDept: {} }, 't'))
      .toEqual([
        't: total 10 !== regular 6 + vss 3',
        't: Σ byCentre 0 !== total 10',
        't: Σ byDept 0 !== total 10',
      ])
    expect(verifyDeploymentCounts(
      { total: 5, regular: 5, vss: 0, finalized: 0, byCentre: { A: { total: 4 } }, byDept: { d: { total: 5 } } }, 't'))
      .toEqual(['t: Σ byCentre 4 !== total 5'])
    expect(verifyDeploymentCounts(
      { total: 5, regular: 5, vss: 0, finalized: 0, byCentre: { A: { total: 5 } }, byDept: { d: { total: 4 } } }, 't'))
      .toEqual(['t: Σ byDept 4 !== total 5'])
    expect(verifyDeploymentCounts(
      { total: 5, regular: 5, vss: 0, finalized: 9, byCentre: { A: { total: 5 } }, byDept: { d: { total: 5 } } }, 't'))
      .toEqual(['t: finalized 9 > total 5'])
  })

  it('flags rows that cannot roll up (missing centre/dept) instead of dropping them silently', () => {
    const c = deploymentCounts([{ badge_number: 'X1' }], {})
    expect(c.total).toBe(1)
    // centre/department_id are NOT NULL in production, so this path only
    // triggers on corrupt input — and it must be loud, never silent
    expect(verifyDeploymentCounts(c, 't')).toEqual([
      't: Σ byCentre 0 !== total 1',
      't: Σ byDept 0 !== total 1',
    ])
  })
})

describe('consentCounts', () => {
  it('counts total/yes/no/requested with one definition', () => {
    const c = consentCounts([
      { consent_given: true, requested_dept: 'd' },
      { consent_given: true, requested_dept: '' },
      { consent_given: false },
      {},
    ])
    expect(c).toEqual({ total: 4, yes: 2, no: 2, requested: 1 })
  })

  it('handles empty input', () => {
    expect(consentCounts([])).toEqual({ total: 0, yes: 0, no: 0, requested: 0 })
    expect(consentCounts(null)).toEqual({ total: 0, yes: 0, no: 0, requested: 0 })
  })
})

describe('scheduleBreakdown', () => {
  // mirrors the proven live case: DLF OLD ENCLOSURE plan 70, deployed 72
  const rootOf = (c) => (c === 'SOHNA' ? 'DLF CITY GURGAON' : c)
  const allocations = [
    { department_id: 'dept-oe', centre: 'DLF CITY GURGAON', max_count: 70 },
    { department_id: 'dept-lan', centre: 'DLF CITY GURGAON', max_count: 20 },
  ]
  const depCounts = {
    total: 92,
    byCentreDept: {
      'DLF CITY GURGAON|||dept-oe': { root: 'DLF CITY GURGAON', deptId: 'dept-oe', total: 72 },
      'DLF CITY GURGAON|||dept-lan': { root: 'DLF CITY GURGAON', deptId: 'dept-lan', total: 20 },
    },
    byCentre: {}, byDept: {},
  }

  it('derives additional and shortfall from scheduled vs deployed', () => {
    const bd = scheduleBreakdown({ allocations, depCounts, rootOf })
    const oe = bd.rows.find(r => r.deptId === 'dept-oe')
    expect(oe).toMatchObject({ root: 'DLF CITY GURGAON', scheduled: 70, deployed: 72, additional: 2, shortfall: 0 })
    const lan = bd.rows.find(r => r.deptId === 'dept-lan')
    expect(lan).toMatchObject({ scheduled: 20, deployed: 20, additional: 0, shortfall: 0 })
    expect(bd.totals).toMatchObject({ scheduled: 90, deployed: 92, additional: 2, shortfall: 0 })
    expect(verifyScheduleBreakdown(bd, depCounts, 't')).toEqual([])
  })

  it('reports shortfall when under schedule', () => {
    const bd = scheduleBreakdown({
      allocations: [{ department_id: 'd', centre: 'C', max_count: 10 }],
      depCounts: { total: 7, byCentreDept: { 'C|||d': { root: 'C', deptId: 'd', total: 7 } }, byCentre: {}, byDept: {} },
      rootOf: (x) => x,
    })
    expect(bd.rows[0]).toMatchObject({ scheduled: 10, deployed: 7, additional: 0, shortfall: 3 })
    expect(verifyScheduleBreakdown(bd, { total: 7 }, 't')).toEqual([])
  })

  it('flags a breakdown whose deployed total diverges from canonical', () => {
    const bd = scheduleBreakdown({ allocations, depCounts, rootOf })
    expect(verifyScheduleBreakdown(bd, { total: 999 }, 't'))
      .toEqual(['t: breakdown deployed 92 !== canonical 999'])
  })

  it('flags arithmetically inconsistent rows', () => {
    const bd = { rows: [{ root: 'C', deptId: 'd', scheduled: 10, deployed: 12, additional: 0, shortfall: 0 }], totals: { scheduled: 10, deployed: 12, additional: 2, shortfall: 0 } }
    expect(verifyScheduleBreakdown(bd, { total: 12 }, 't'))
      .toEqual(['t: C/d additional 0 !== max(0, 12-10)'])
  })

  it('Difference identity: additional − shortfall === deployed − scheduled', () => {
    // the Overview renders ONE signed Difference row; these cases pin that
    // Difference always equals gross additional minus gross shortfall
    const cases = [
      { s: 70, d: 72 }, // +2 over (DLF OLD ENCLOSURE shape)
      { s: 25, d: 7 },  // −18 under (DLF SEWA shape)
      { s: 20, d: 20 }, // balanced → blank
      { s: 0, d: 1 },   // plan-zero extra
    ]
    for (const { s, d } of cases) {
      const add = Math.max(0, d - s)
      const short = Math.max(0, s - d)
      expect(add - short).toBe(d - s)
    }
    // and the breakdown totals obey it end to end
    const bd = scheduleBreakdown({
      allocations: [{ department_id: 'oe', centre: 'DLF', max_count: 70 }],
      depCounts: { total: 72, byCentreDept: { 'DLF|||oe': { root: 'DLF', deptId: 'oe', total: 72 } }, byCentre: {}, byDept: {} },
      rootOf: (x) => x,
    })
    expect(bd.totals.additional - bd.totals.shortfall).toBe(bd.totals.deployed - bd.totals.scheduled)
  })

  it('never nets across departments: over in one + under in another shows both', () => {
    // DLF CITY GURGAON shape: OE 70->72 (+2), TRAFFIC INSIDE 25->24,
    // SEWA 25->7. Netted centre additional would be 0 and hide the extras.
    const bd = scheduleBreakdown({
      allocations: [
        { department_id: 'oe', centre: 'DLF', max_count: 70 },
        { department_id: 'ti', centre: 'DLF', max_count: 25 },
        { department_id: 'sewa', centre: 'DLF', max_count: 25 },
      ],
      depCounts: {
        total: 103,
        byCentreDept: {
          'DLF|||oe': { root: 'DLF', deptId: 'oe', total: 72 },
          'DLF|||ti': { root: 'DLF', deptId: 'ti', total: 24 },
          'DLF|||sewa': { root: 'DLF', deptId: 'sewa', total: 7 },
        },
        byCentre: {}, byDept: {},
      },
      rootOf: (x) => x,
    })
    expect(bd.totals).toMatchObject({ scheduled: 120, deployed: 103, additional: 2, shortfall: 19 })
    expect(bd.rows.find(r => r.deptId === 'oe')).toMatchObject({ additional: 2, shortfall: 0 })
    expect(verifyScheduleBreakdown(bd, { total: 103 }, 't')).toEqual([])
  })
})
