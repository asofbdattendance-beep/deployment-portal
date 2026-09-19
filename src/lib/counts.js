// ── Canonical counting (single source of truth) ──────────────
// Every "deployed / finalized / consented / roster" number shown on ANY
// page must be derived from these helpers so pages cannot disagree with
// each other. All functions are pure (no I/O) and dependency-free so they
// are unit-testable in isolation.
//
// Canonical definitions (must match the DB enforcement):
//   deployed_total    — rows in `deployments` for the schedule, grouped by
//                       the EFFECTIVE department
//                       (COALESCE(deployed_department_id, department_id))
//   deployed_regular  — deployed rows whose badge is NOT VSS
//   deployed_vss      — deployed rows whose badge IS VSS
//   finalized         — deployed_department_id IS NOT NULL (ASO's final;
//                       never defaulted from the request here)
//   consented_yes     — sewadar_consents.consent_given = true
// A row is VSS when its badge is in the vss_sewadars set OR carries the
// VSS prefix — mirroring the DB triggers (`ILIKE 'VS%' OR EXISTS …` in
// freeze_deployed_rows / block_after_deadline).

/** Effective department id: the ASO's final when set, else the request. */
export function effectiveDeptId(row) {
  if (!row) return null
  return row.deployed_department_id || row.department_id || null
}

/** True when the row belongs to the VSS population. */
export function isVssRow(row, vssBadgeSet) {
  const badge = row?.badge_number
  if (!badge) return false
  if (vssBadgeSet && vssBadgeSet.has(badge)) return true
  return /^VS/i.test(String(badge))
}

/** True when the row carries an actual ASO final decision (never defaulted). */
export function isFinalizedRow(row) {
  return !!(row && row.deployed_department_id)
}

function emptyBucket() {
  return { total: 0, regular: 0, vss: 0, finalized: 0 }
}

/**
 * Canonical deployment counts.
 * @param {Array} rows - `deployments` rows (any scope)
 * @param {object} opts - { vssBadgeSet:Set, rootOf:(centre)=>root }
 */
export function deploymentCounts(rows, opts = {}) {
  const { vssBadgeSet = null, rootOf = null } = opts
  const out = { ...emptyBucket(), byCentre: {}, byDept: {}, byCentreDept: {} }
  for (const r of (rows || [])) {
    const vss = isVssRow(r, vssBadgeSet)
    const fin = isFinalizedRow(r)
    const deptId = effectiveDeptId(r)
    const root = rootOf ? (rootOf(r.centre) || r.centre) : r.centre
    out.total += 1
    if (vss) out.vss += 1
    else out.regular += 1
    if (fin) out.finalized += 1
    if (root != null) {
      const b = out.byCentre[root] || (out.byCentre[root] = emptyBucket())
      b.total += 1
      if (vss) b.vss += 1
      else b.regular += 1
      if (fin) b.finalized += 1
    }
    if (deptId != null) {
      const b = out.byDept[deptId] || (out.byDept[deptId] = emptyBucket())
      b.total += 1
      if (vss) b.vss += 1
      else b.regular += 1
      if (fin) b.finalized += 1
    }
    if (root != null && deptId != null) {
      const ck = `${root}|||${deptId}`
      const b = out.byCentreDept[ck] || (out.byCentreDept[ck] = { root, deptId, ...emptyBucket() })
      b.total += 1
      if (vss) b.vss += 1
      else b.regular += 1
      if (fin) b.finalized += 1
    }
  }
  out.requestedOnly = out.total - out.finalized
  return out
}

/** Canonical consent counts. `requested` = consented AND assigned a department. */
export function consentCounts(rows) {
  const out = { total: 0, yes: 0, no: 0, requested: 0 }
  for (const r of (rows || [])) {
    out.total += 1
    if (r && r.consent_given) {
      out.yes += 1
      if (r.requested_dept) out.requested += 1
    } else {
      out.no += 1
    }
  }
  return out
}

/**
 * Verify the reconciliation invariants. Returns an array of violation
 * strings (empty = consistent). Pages log these loudly; tests assert on them.
 */
export function verifyDeploymentCounts(c, label = 'counts') {
  const problems = []
  if (!c || typeof c !== 'object') return [`${label}: missing counts object`]
  if (c.total !== c.regular + c.vss) {
    problems.push(`${label}: total ${c.total} !== regular ${c.regular} + vss ${c.vss}`)
  }
  const sumCentre = Object.values(c.byCentre || {}).reduce((s, b) => s + (b.total || 0), 0)
  if (sumCentre !== c.total) {
    problems.push(`${label}: Σ byCentre ${sumCentre} !== total ${c.total}`)
  }
  const sumDept = Object.values(c.byDept || {}).reduce((s, b) => s + (b.total || 0), 0)
  if (sumDept !== c.total) {
    problems.push(`${label}: Σ byDept ${sumDept} !== total ${c.total}`)
  }
  if ((c.finalized || 0) > c.total) {
    problems.push(`${label}: finalized ${c.finalized} > total ${c.total}`)
  }
  return problems
}

/** Log invariant violations loudly in dev; silent in production. */
export function reportCountProblems(problems) {
  if (problems && problems.length && typeof console !== 'undefined' && console.error) {
    console.error('[counts] invariant violation:', problems.join(' | '))
  }
  return problems
}

// ── Schedule vs actual (Additional / Shortfall) ──────────────
// Scheduled = centre_allocations.max_count (the plan, restored by v38b).
// Deployed  = effective-department deployments. Additional / Shortfall are
// derived — never stored, never migrated:
//   additional = max(0, deployed − scheduled)
//   shortfall  = max(0, scheduled − deployed)

/**
 * @param {object} args - { allocations:[{department_id, centre, max_count}],
 *   depCounts (deploymentCounts() output), rootOf:(centre)=>root }
 * @returns { rows:[{root, deptId, scheduled, deployed, additional,
 *   shortfall}], totals:{scheduled, deployed, additional, shortfall} }
 */
export function scheduleBreakdown({ allocations, depCounts, rootOf }) {
  const byKey = {}
  const key = (root, deptId) => `${root}|||${deptId}`
  for (const a of (allocations || [])) {
    if (!a || a.department_id == null) continue
    const root = rootOf ? (rootOf(a.centre) || a.centre) : a.centre
    const k = key(root, a.department_id)
    const b = byKey[k] || (byKey[k] = { root, deptId: a.department_id, scheduled: 0, deployed: 0 })
    b.scheduled += (a.max_count || 0)
  }
  for (const [, b] of Object.entries((depCounts && depCounts.byCentreDept) || {})) {
    const k = key(b.root, b.deptId)
    const t = byKey[k] || (byKey[k] = { root: b.root, deptId: b.deptId, scheduled: 0, deployed: 0 })
    t.deployed = b.total || 0
  }
  const rows = Object.values(byKey).map(b => ({
    ...b,
    additional: Math.max(0, b.deployed - b.scheduled),
    shortfall: Math.max(0, b.scheduled - b.deployed),
  }))
  const totals = rows.reduce((s, b) => ({
    scheduled: s.scheduled + b.scheduled,
    deployed: s.deployed + b.deployed,
    additional: s.additional + b.additional,
    shortfall: s.shortfall + b.shortfall,
  }), { scheduled: 0, deployed: 0, additional: 0, shortfall: 0 })
  return { rows, totals }
}

/** Verify a scheduleBreakdown: rows reconcile with the canonical totals. */
export function verifyScheduleBreakdown(bd, depCounts, label = 'schedule') {
  const problems = []
  if (!bd || !Array.isArray(bd.rows) || !bd.totals) return [`${label}: missing breakdown`]
  for (const r of bd.rows) {
    if (r.additional !== Math.max(0, r.deployed - r.scheduled)) {
      problems.push(`${label}: ${r.root}/${r.deptId} additional ${r.additional} !== max(0, ${r.deployed}-${r.scheduled})`)
    }
    if (r.shortfall !== Math.max(0, r.scheduled - r.deployed)) {
      problems.push(`${label}: ${r.root}/${r.deptId} shortfall ${r.shortfall} !== max(0, ${r.scheduled}-${r.deployed})`)
    }
  }
  if (depCounts && bd.totals.deployed !== depCounts.total) {
    problems.push(`${label}: breakdown deployed ${bd.totals.deployed} !== canonical ${depCounts.total}`)
  }
  return problems
}
