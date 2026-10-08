/**
 * Sewa view shapers — mode-aware presentation over the two sewa lenses.
 *
 * Previsit and Bhati Visit read different RPCs (previsit_summary /
 * previsit_deployed vs attendance_centre_daily) but the dashboard renders
 * one grid: CentreDayHeatmap takes { columns, rows, totals }. This module
 * builds that shape for either mode with no fetch and no side effects.
 * The server already resolved the caller's scope, so these rows are the
 * caller's own — this only folds them.
 */
import { SEWA_MODE_PREVISIT, SEWA_MODE_VISIT } from './sewaMode'
import { UNASSIGNED_CENTRE } from './attendance'
import { previsitCentreMatrix, previsitDates } from './previsit'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function cleanDate(value) {
  const d = typeof value === 'string' ? value.slice(0, 10) : ''
  return ISO_DATE.test(d) ? d : ''
}

function cleanCentre(value) {
  return typeof value === 'string' && value.trim() ? value : UNASSIGNED_CENTRE
}

/**
 * Centre × sewa-day matrix for either lens. Previsit delegates to the
 * previsit builder (roster denominators); visit folds the grouped
 * attendance_centre_daily rows (one row per centre × visit date, deployed
 * constant per centre). Visit columns are EXACTLY the window dates — a
 * quiet day still renders its column — so previsit scans can never grow
 * a Bhati Visit column.
 *
 * @param {object} args
 * @param {string} args.mode SEWA_MODE_PREVISIT | SEWA_MODE_VISIT
 * @param {Array<object>} [args.summaryRows] previsit_summary rows
 * @param {Array<object>} [args.deployedRows] previsit_deployed rows
 * @param {Array<object>} [args.visitRows] attendance_centre_daily rows
 * @param {Array<object>} [args.visitSummaryRows] summary-grain rows
 *   (visit only) — folded per centre into distinct sewadars so the grid's
 *   end totals read the same unit as the centre × department strip. Either
 *   raw `attendance_visit_summary` (visit-wide) or the day feed re-shaped
 *   to that grain (today's scope) — the fold is identical either way.
 *   Omitted → the end cells fall back to the badge-day sums, exactly as before.
 * @param {string[]} [args.windowDates] visit window dates (ascending)
 * @returns {{columns: string[], rows: Array, totals: object}}
 */
export function sewaCentreMatrix({ mode, summaryRows, deployedRows, visitRows, windowDates, visitSummaryRows } = {}) {
  if (mode === SEWA_MODE_PREVISIT) {
    return previsitCentreMatrix(summaryRows, deployedRows)
  }
  const columns = [...new Set(
    (Array.isArray(windowDates) ? windowDates : []).map(cleanDate).filter(Boolean),
  )].sort()
  const rows = Array.isArray(visitRows) ? visitRows : []

  const present = new Map() // `${centre}\0${date}` → count
  const deployed = new Map() // centre → denominator
  for (const r of rows) {
    if (!r) continue
    const d = cleanDate(r.event_date)
    if (!d || !columns.includes(d)) continue
    const c = cleanCentre(r.centre)
    const key = `${c}\0${d}`
    present.set(key, (present.get(key) || 0) + (Number(r.present) || 0))
    const dep = Number(r.deployed) || 0
    if (dep > (deployed.get(c) || 0)) deployed.set(c, dep)
  }

  // Distinct visit-wide sewadars per centre. The summary holds one row per
  // centre × department with DISTINCT-ON-badge counts upstream, so a
  // straight sum per centre is distinct badges — the same fold the
  // department strip performs, which is what makes the two agree.
  const summaryList = Array.isArray(visitSummaryRows) ? visitSummaryRows : null
  const ever = new Map() // centre → { present, deployed }
  if (summaryList) {
    for (const r of summaryList) {
      if (!r) continue
      const c = cleanCentre(r.centre)
      let e = ever.get(c)
      if (!e) {
        e = { present: 0, deployed: 0 }
        ever.set(c, e)
      }
      e.present += Number(r.ever_present) || 0
      e.deployed += Number(r.deployed) || 0
    }
  }
  const hasEver = summaryList !== null && summaryList.length > 0

  const matrixRows = [...deployed.keys()]
    .map((centre) => {
      const byDate = {}
      let presentTotal = 0
      for (const d of columns) {
        const p = present.get(`${centre}\0${d}`) || 0
        byDate[d] = p
        presentTotal += p
      }
      const dep = deployed.get(centre) || 0
      const e = ever.get(centre)
      return {
        centre, deployed: dep, byDate, presentTotal, possible: dep * columns.length,
        everPresent: e ? e.present : null, everDeployed: e ? e.deployed : null,
      }
    })
    .sort((a, b) => {
      const au = a.centre === UNASSIGNED_CENTRE
      const bu = b.centre === UNASSIGNED_CENTRE
      if (au !== bu) return au ? 1 : -1
      return a.centre.localeCompare(b.centre)
    })

  const byDate = {}
  let presentCount = 0
  for (const d of columns) {
    const p = matrixRows.reduce((s, r) => s + r.byDate[d], 0)
    byDate[d] = p
    presentCount += p
  }
  const deployedCount = matrixRows.reduce((s, r) => s + r.deployed, 0)

  return {
    columns,
    rows: matrixRows,
    totals: {
      byDate,
      present: presentCount,
      deployed: deployedCount,
      possible: deployedCount * columns.length,
      everPresent: hasEver ? matrixRows.reduce((s, r) => s + (r.everPresent || 0), 0) : null,
      everDeployed: hasEver ? matrixRows.reduce((s, r) => s + (r.everDeployed || 0), 0) : null,
    },
  }
}

/**
 * Day columns for the register view. Visit columns are EXACTLY the window
 * dates (newest first, matching the previsitDates contract) — the summary
 * is never consulted, so a stray row outside the window can never grow a
 * Bhati Visit column. Previsit delegates to the summary event dates.
 *
 * @param {string} mode SEWA_MODE_PREVISIT | SEWA_MODE_VISIT
 * @param {Array<object>} summaryRows previsit_summary rows (previsit only)
 * @param {string[]} windowDates visit window dates, any order
 * @returns {string[]} 'YYYY-MM-DD', newest first
 */
export function sewaViewDates(mode, summaryRows, windowDates) {
  if (mode === SEWA_MODE_VISIT) {
    return [...new Set(
      (Array.isArray(windowDates) ? windowDates : []).map(cleanDate).filter(Boolean),
    )].sort().reverse()
  }
  return previsitDates(summaryRows)
}

/**
 * Present-register rows for a visit: one row per present badge per window
 * date, stamped with its day. attendance_day_badges carries no times, so
 * the register columns (First in / Last out / Duration) render empty and
 * session_count stays 1 — the repeat-scan day grain does not exist on the
 * visit side and is never invented.
 *
 * @param {Array<Array>} pairs [presentRows, absentRows] per window date
 * @param {string[]} dates window dates aligned with pairs
 * @returns {Array<object>} newest day first, badge A–Z within a day
 */
export function buildVisitRows(pairs, dates) {
  const list = Array.isArray(pairs) ? pairs : []
  const days = Array.isArray(dates) ? dates : []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const present = Array.isArray(list[i]) && Array.isArray(list[i][0]) ? list[i][0] : []
    const day = cleanDate(days[i])
    if (!day) continue
    for (const r of present) {
      if (!r?.badge_number) continue
      out.push({
        event_date: day,
        badge_number: r.badge_number,
        sewadar_name: r.sewadar_name || '',
        sewadar_centre: r.sewadar_centre || '',
        department_id: r.department_id || null,
        dept_name: r.dept_name || '',
        is_vss: !!r.is_vss,
        in_time: null,
        out_time: null,
        duration_min: null,
        session_count: 1,
        is_open: false,
        undeployed: false,
        is_manual: false,
      })
    }
  }
  out.sort((a, b) =>
    String(b.event_date).localeCompare(String(a.event_date)) ||
    String(a.badge_number).localeCompare(String(b.badge_number)))
  return out
}

/**
 * Deployed roster for a visit: the union of present + absent badges across
 * every window date (absent = scoped deployed minus present, so the union
 * is the whole deployed strength — including badges that never scanned,
 * which the schedule-grain sewadar summary cannot enumerate).
 *
 * @param {Array<Array>} pairs [presentRows, absentRows] per window date
 * @returns {Array<object>} centre A–Z (unassigned last), name, badge
 */
export function buildVisitDeployed(pairs) {
  const seen = new Map()
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    for (const group of [pair?.[0], pair?.[1]]) {
      for (const r of Array.isArray(group) ? group : []) {
        if (!r?.badge_number || seen.has(r.badge_number)) continue
        seen.set(r.badge_number, {
          badge_number: r.badge_number,
          sewadar_name: r.sewadar_name || '',
          sewadar_centre: r.sewadar_centre || '',
          department_id: r.department_id || null,
          dept_name: r.dept_name || '',
          is_vss: !!r.is_vss,
        })
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    const ac = cleanCentre(a.sewadar_centre)
    const bc = cleanCentre(b.sewadar_centre)
    const au = ac === UNASSIGNED_CENTRE
    const bu = bc === UNASSIGNED_CENTRE
    if (au !== bu) return au ? 1 : -1
    return ac.localeCompare(bc) ||
      String(a.sewadar_name).localeCompare(String(b.sewadar_name)) ||
      String(a.badge_number).localeCompare(String(b.badge_number))
  })
}

/**
 * Overlay schedule-grain attention flags onto visit rows. still_open marks
 * the badge's first-scan-day row (the summary carries no open-session day
 * grain; the trail popup shows the real sessions). undeployed_scan badges
 * are excluded from day_badges entirely, so they arrive as synthetic rows
 * stamped with their first scan day (fallback: the newest window date).
 * session_count is NEVER raised — multi-day attribution would be a guess.
 *
 * @param {Array<object>} rows buildVisitRows output
 * @param {Array<object>} summaryRows attendance_sewadar_summary rows
 * @param {string} fallbackDate newest window date
 * @returns {Array<object>}
 */
export function applyVisitFlags(rows, summaryRows, fallbackDate) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }))
  const byBadge = new Map()
  for (const r of list) {
    if (!r?.badge_number) continue
    if (!byBadge.has(r.badge_number)) byBadge.set(r.badge_number, [])
    byBadge.get(r.badge_number).push(r)
  }
  for (const s of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!s?.badge_number) continue
    const firstDay = cleanDate(s.first_in_date) || cleanDate(fallbackDate)
    if (s.still_open && byBadge.has(s.badge_number)) {
      const dated = byBadge.get(s.badge_number)
      const target = dated.find((r) => r.event_date === firstDay) || dated[dated.length - 1]
      if (target) target.is_open = true
    }
    if (s.undeployed_scan && !byBadge.has(s.badge_number) && firstDay) {
      list.push({
        event_date: firstDay,
        badge_number: s.badge_number,
        sewadar_name: s.sewadar_name || '',
        sewadar_centre: s.sewadar_centre || '',
        department_id: null,
        dept_name: s.dept_name || '',
        is_vss: !!s.is_vss,
        in_time: typeof s.first_in_time === 'string' ? s.first_in_time : null,
        out_time: null,
        duration_min: null,
        session_count: 1,
        is_open: !!s.still_open,
        undeployed: true,
        is_manual: false,
      })
    }
  }
  return list
}
