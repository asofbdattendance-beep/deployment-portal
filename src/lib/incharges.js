import { isVssBadge } from './logic'

// Department incharge eligibility — one incharge per CENTRE × department.
//
// The incharge row is stored against the ROOT centre, but the sewadar may
// belong to any centre in that root's subtree (e.g. NIT - 2 under FARIDABAD).
// trg_check_incharge (v21) matches by badge within the same ROOT centre, so
// the client must too: never compare the sewadar's own centre to the root.

/** Effective department: ASO's final deployed dept, else the requested one. */
export const effectiveDept = (row) => row.final_dept || row.requested_dept

/**
 * The consent row that makes `badgeNumber` an eligible incharge for `deptId`:
 * consented and occupying that department (by effective dept).
 * @param {Record<string, object>|null|undefined} rows consent rows of the CENTRE's subtree
 * @param {string} badgeNumber
 * @param {string} deptId
 * @returns {object|undefined}
 */
export function findEligibleInchargeRow(rows, badgeNumber, deptId) {
  if (!rows || !badgeNumber) return undefined
  return Object.values(rows).find(r =>
    r.badge_number === badgeNumber && r.consent_given && effectiveDept(r) === deptId
  )
}

/**
 * Keys of incharges whose sewadar no longer consents or no longer occupies
 * the department.
 * @param {Record<string, {badge_number: string, department_id: string}>} incharges
 * @param {Record<string, object>} rows consent rows of the CENTRE's subtree
 * @returns {string[]}
 */
export function staleInchargeKeys(incharges, rows) {
  return Object.entries(incharges || {})
    .filter(([, inc]) => !findEligibleInchargeRow(rows, inc.badge_number, inc.department_id))
    .map(([key]) => key)
}

/**
 * Allocated departments that need an incharge before the CENTRE can lock:
 * those with at least one consented, non-VSS sewadar whose EFFECTIVE
 * department it is. Using the requested dept here (as before) blocked the
 * lock forever when the ASO moved a department's only sewadar elsewhere —
 * the department "needed" an incharge nobody was eligible to be.
 * @param {Array<{department_id: string}>} allocations
 * @param {Record<string, object>} rows consent rows of the CENTRE's subtree
 * @returns {Array<{department_id: string}>}
 */
export function departmentsNeedingIncharge(allocations, rows) {
  const occupied = new Set(
    Object.values(rows || {})
      .filter(r => r.consent_given && !isVssBadge(r.badge_number) && effectiveDept(r))
      .map(effectiveDept)
  )
  return (allocations || []).filter(a => occupied.has(a.department_id))
}

const rootBadgeKey = (root, badge) => `${root}|${badge}`

/**
 * Index sewadars by ROOT centre + badge, built ONCE per data load. Incharge
 * rows are stored against the root centre while the sewadar may live at a
 * sub-centre; this turns that lookup into a single Map hit instead of a scan
 * of every sewadar per incharge. The first record wins on a duplicate.
 * @param {Array<{centre: string, badge_number: string}>|null|undefined} sewadars
 * @param {(centre: string) => string} rootOf memoised centre → root resolver
 * @returns {Map<string, object>}
 */
export function indexSewadarsByRoot(sewadars, rootOf) {
  const index = new Map()
  ;(sewadars || []).forEach(s => {
    const key = rootBadgeKey(rootOf(s.centre), s.badge_number)
    if (!index.has(key)) index.set(key, s)
  })
  return index
}

/**
 * The sewadar behind an incharge row stored against `centre` (a root centre).
 * @param {Map<string, object>} index from indexSewadarsByRoot
 * @param {(centre: string) => string} rootOf
 * @param {string} centre
 * @param {string} badgeNumber
 * @returns {object|undefined}
 */
export function sewadarInRoot(index, rootOf, centre, badgeNumber) {
  return index.get(rootBadgeKey(rootOf(centre), badgeNumber))
}
