// Pure attendance domain logic — no Supabase client, so it is unit-testable.
// The v39 RPCs (sql/v39_attendance_analytics.sql) already do the scope
// resolution and the row-level aggregation server-side; everything here is
// the client-side shaping/presentation layer on top of their output.

import { daysForDept, getRootCentre } from './logic'

// A visit spans the fixed 5 days WED–SUN. There are no per-day dates in a
// schedule, so "expected days" is always 5 (or 3 for OE ESCORTS departments,
// whose consent days are pinned by `daysForDept`).
export const VISIT_DAYS = ['WED', 'THU', 'FRI', 'SAT', 'SUN']

/** Days in a full (non-OE-ESCORTS) visit — the denominator `daysForDept` gives. */
export const FULL_VISIT_DAYS = 5

/**
 * Bucket label for rows whose `sewadar_centre` is null/empty. The RPC can return
 * a sewadar with no centre; without a bucket those rows are rendered and counted
 * in the header stats but are unreachable by the centre filter, so the numbers
 * never reconcile with the view. One shared label keeps the option list, the
 * filter and the count in agreement.
 */
export const UNASSIGNED_CENTRE = 'Unassigned centre'

/* ─── Session duration ─── */

/**
 * Minutes between an IN and its OUT. Handles an overnight session by rolling
 * the OUT forward a day when its time-of-day is not after the IN. An OUT at the
 * exact same time-of-day is a zero-length session, NOT a 24-hour one.
 * Returns null when the session is still open or the times are unusable.
 *
 * L-06: the dates are optional but load-bearing. Without them a Wed 09:00 →
 * Sun 16:00 session reads as 7h (time-of-day delta only). With both dates
 * the true multi-day span is reported; equal or absent dates keep the legacy
 * time-only behaviour (including the overnight roll and the equal-times-zero
 * rule), and a malformed date degrades to it rather than failing.
 *
 * @param {string} inTime  'HH:MM' or 'HH:MM:SS'
 * @param {string} outTime 'HH:MM' or 'HH:MM:SS' — null/undefined means OPEN
 * @param {string|null} [inDate]  'YYYY-MM-DD'
 * @param {string|null} [outDate] 'YYYY-MM-DD'
 * @returns {number|null} whole minutes
 */
export function sessionMinutes(inTime, outTime, inDate = null, outDate = null) {
  if (!inTime || !outTime) return null
  const a = toMinutes(inTime)
  const b = toMinutes(outTime)
  if (a === null || b === null) return null
  const days = dateDiffDays(inDate, outDate)
  if (days !== null && days !== 0) {
    if (days < 0) return null // OUT date precedes IN date: unusable, not negative
    const span = days * 24 * 60 + (b - a)
    return span < 0 ? null : span
  }
  // Equal times are a zero-length session. Only a strictly-earlier OUT rolls
  // forward to the next day.
  if (b === a) return 0
  return b > a ? b - a : b + 24 * 60 - a
}

/**
 * Whole-day difference between two 'YYYY-MM-DD' strings, or null when
 * either side is absent or malformed. Timezone-free by construction (UTC
 * date parts only) — session times are IST wall-clock and only the day
 * count is taken from here.
 */
function dateDiffDays(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a || '')
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || '')
  if (!pa || !pb) return null
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3])
  const db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3])
  if (Number.isNaN(da) || Number.isNaN(db)) return null
  return Math.round((db - da) / 86400000)
}

/**
 * 'HH:MM'/'HH:MM:SS' → minutes since midnight. Null when unparseable.
 * @param {string} t
 * @returns {number|null}
 */
function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59) return null
  return h * 60 + min
}

/**
 * Human duration: '3h 15m', '45m', '—' when unknown.
 * @param {number|null} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—'
  const total = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/* ─── Expected vs present ─── */

/**
 * Expected days a sewadar should attend. OE ESCORTS departments are pinned to
 * 3 days by the DB (v10) and the client rule `daysForDept`; every other
 * department is the full 5-day visit.
 *
 * A sewadar with NO department (undeployed, or scanned before deployment)
 * expects NOTHING — `daysForDept` only ever returns 3 or 5, so it must not be
 * used as the denominator here: 0/5 would read as a 0% attendance record for
 * someone who was never scheduled to attend. Returns 0 so callers can render
 * "no denominator" rather than a misleading rate.
 *
 * @param {string} deptName
 * @returns {number} 0, 3 or 5
 */
export function expectedDays(deptName) {
  const name = typeof deptName === 'string' ? deptName.trim() : deptName
  if (!name) return 0
  return daysForDept(name)
}

/**
 * True when a row has a real denominator to compute a rate against. The UI
 * renders "—" instead of a percentage when this is false.
 * @param {{expected_days:number}} row a display row from toSewadarRow
 * @returns {boolean}
 */
export function hasExpectedDays(row) {
  return (Number(row?.expected_days) || 0) > 0
}

/**
 * Attendance rate for one sewadar over the visit, as a 0–100 integer.
 * A sewadar with 0 expected days (no department) reads 0 rather than NaN —
 * the caller should pair that with `hasExpectedDays` and render "—".
 *
 * @param {number} daysPresent
 * @param {string} deptName
 * @returns {number}
 */
export function attendanceRate(daysPresent, deptName) {
  const expected = expectedDays(deptName)
  // Reachable now that expectedDays returns 0 for an undeployed sewadar —
  // this is the division-by-zero guard, keep it.
  if (!expected) return 0
  const present = Math.max(0, Number(daysPresent) || 0)
  return Math.min(100, Math.round((present / expected) * 100))
}

/**
 * Headline band for a rate, used to pick the pill colour.
 * @param {number} rate
 * @returns {'full'|'partial'|'low'|'none'}
 */
export function rateBand(rate) {
  const r = Number(rate) || 0
  if (r <= 0) return 'none'
  if (r >= 100) return 'full'
  if (r >= 50) return 'partial'
  return 'low'
}

/* ─── Per-sewadar row shaping ─── */

/**
 * Shape one `attendance_sewadar_summary` RPC row for display, computing the
 * derived fields the table needs. Tolerates missing columns so a narrower RPC
 * signature never crashes the page.
 *
 * @param {object} r raw RPC row
 * @returns {object} display row
 */
export function toSewadarRow(r) {
  const days = Number(r?.days_present) || 0
  const deptName = r?.dept_name || ''
  const rate = attendanceRate(days, deptName)
  return {
    badge_number: r?.badge_number || '',
    sewadar_name: r?.sewadar_name || '',
    sewadar_centre: r?.sewadar_centre || '',
    dept_name: deptName,
    is_vss: !!r?.is_vss,
    days_present: days,
    total_scans: Number(r?.total_scans) || 0,
    open_sessions: Number(r?.open_sessions) || 0,
    expected_days: expectedDays(deptName),
    still_open: !!r?.still_open,
    undeployed_scan: !!r?.undeployed_scan,
    first_in_date: r?.first_in_date || null,
    first_in_time: r?.first_in_time || null,
    last_out_date: r?.last_out_date || null,
    last_out_time: r?.last_out_time || null,
    rate,
    band: rateBand(rate),
  }
}

/**
 * Order key for a 'YYYY-MM-DD' + 'HH:MM:SS' pair, for comparing two stamps.
 * The literals are out of range on purpose so a MISSING stamp can be pushed to
 * whichever end makes the real value win: MAX for "earliest first-in wins",
 * MIN for "latest last-out wins".
 * @param {string} date
 * @param {string} time
 * @param {string} missing sort key used when date/time are absent
 * @returns {string}
 */
function stampKey(date, time, missing) {
  return `${date || missing}|${time || missing}`
}

/**
 * Fold a second raw row for the SAME badge into the accumulated one. Counters
 * add up; descriptive columns take the first non-null value; the boolean flags
 * OR; the first IN is the earliest stamp and the last OUT is the latest.
 *
 * @param {object} acc accumulated raw row (mutated)
 * @param {object} r next raw row
 * @returns {object} acc
 */
function mergeSewadarRaw(acc, r) {
  acc.days_present = (Number(acc.days_present) || 0) + (Number(r.days_present) || 0)
  acc.total_scans = (Number(acc.total_scans) || 0) + (Number(r.total_scans) || 0)
  acc.open_sessions = (Number(acc.open_sessions) || 0) + (Number(r.open_sessions) || 0)
  for (const k of ['sewadar_name', 'sewadar_centre', 'dept_name']) {
    if (!acc[k] && r[k]) acc[k] = r[k]
  }
  acc.is_vss = acc.is_vss || !!r.is_vss
  acc.still_open = acc.still_open || !!r.still_open
  // OR: a badge that scanned at the gate before being deployed DID scan
  // undeployed, even if a later row no longer flags it.
  acc.undeployed_scan = acc.undeployed_scan || !!r.undeployed_scan
  if (stampKey(r.first_in_date, r.first_in_time, '9999-12-31') < stampKey(acc.first_in_date, acc.first_in_time, '9999-12-31')) {
    acc.first_in_date = r.first_in_date
    acc.first_in_time = r.first_in_time
  }
  if (stampKey(r.last_out_date, r.last_out_time, '0000-00-00') > stampKey(acc.last_out_date, acc.last_out_time, '0000-00-00')) {
    acc.last_out_date = r.last_out_date
    acc.last_out_time = r.last_out_time
  }
  return acc
}

/**
 * Build the display rows, dropping any row with no badge, RE-AGGREGATING by
 * badge, then sorting by centre → name so the table order is stable and
 * grouped.
 *
 * The aggregation is defensive on purpose. `attendance_sewadar_summary` is
 * being changed to return exactly one row per badge, but a badge scanned before
 * deployment (`sewadar_dept` NULL) and again afterwards can currently arrive as
 * TWO rows — which would render the sewadar twice, split `days_present` across
 * two half-rows and double-count every header stat. Merging here makes the page
 * correct either way.
 *
 * Note: `days_present` is summed, which is exact when the two rows cover
 * disjoint scan days. If the RPC ever returns OVERLAPPING days across duplicate
 * rows the sum would over-count — the one-row-per-badge SQL fix removes that
 * class of duplicate entirely.
 *
 * @param {Array<object>} rows raw RPC rows
 * @returns {Array<object>}
 */
export function buildSewadarRows(rows) {
  if (!Array.isArray(rows)) return []
  const byBadge = new Map()
  for (const r of rows) {
    if (!r || !r.badge_number) continue
    const acc = byBadge.get(r.badge_number)
    if (acc) mergeSewadarRaw(acc, r)
    else byBadge.set(r.badge_number, { ...r })
  }
  return [...byBadge.values()].map(toSewadarRow).sort(compareSewadarRows)
}

/**
 * Centre → name → badge ordering, matching the hierarchy grouping used by the
 * other portal tables.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareSewadarRows(a, b) {
  const c = String(a.sewadar_centre || '').localeCompare(String(b.sewadar_centre || ''))
  if (c !== 0) return c
  const n = String(a.sewadar_name || '').localeCompare(String(b.sewadar_name || ''))
  if (n !== 0) return n
  return String(a.badge_number || '').localeCompare(String(b.badge_number || ''))
}

/* ─── Headline stats ─── */

/**
 * Roll the per-sewadar rows up into the header stat cards.
 *
 * `centres` counts the FILTER-REACHABLE buckets (it goes through centreOptions),
 * so the header always reconciles with the centre dropdown. A sewadar with no
 * centre is counted in `sewadars`/`presentToday` and reachable through the
 * UNASSIGNED_CENTRE bucket — it is never silently dropped.
 *
 * @param {Array<object>} rows display rows from buildSewadarRows
 * @returns {{sewadars:number,centres:number,presentToday:number,openNow:number,flagged:number,full:number,full5:number}}
 */
export function attendanceStats(rows) {
  const list = Array.isArray(rows) ? rows : []
  let openNow = 0
  let flagged = 0
  let full = 0
  let full5 = 0
  for (const r of list) {
    if (r.open_sessions > 0) openNow += 1
    if (r.undeployed_scan) flagged += 1
    if (r.band === 'full') {
      full += 1
      // An OE ESCORTS sewadar at 3/3 is also band 'full' but is NOT a
      // full-5-day attender, so track the 5-day subset separately.
      if (r.expected_days === FULL_VISIT_DAYS) full5 += 1
    }
  }
  return {
    sewadars: list.length,
    centres: centreOptions(list).length,
    presentToday: list.filter((r) => r.days_present > 0).length,
    openNow,
    flagged,
    full,
    full5,
  }
}

/* ─── Daily summary shaping ─── */

/**
 * Shape one `attendance_daily_summary` row and compute its present rate.
 * @param {object} r
 * @returns {object}
 */
export function toDailyRow(r) {
  const expected = Number(r?.expected) || 0
  const present = Number(r?.present) || 0
  const absent = Number(r?.absent) || 0
  const rate = expected > 0 ? Math.round((present / expected) * 100) : 0
  return {
    centre: r?.centre || '',
    dept_name: r?.dept_name || '',
    expected,
    present,
    absent,
    open_now: Number(r?.open_now) || 0,
    rate,
    band: rateBand(rate),
  }
}

/**
 * Build + sort the daily summary rows (centre → department).
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function buildDailyRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => r && r.centre)
    .map(toDailyRow)
    .sort((a, b) => a.centre.localeCompare(b.centre) || a.dept_name.localeCompare(b.dept_name))
}

/**
 * Totals across every daily row: the "expected vs present" footer.
 * @param {Array<object>} rows output of buildDailyRows
 * @returns {{expected:number,present:number,absent:number,open_now:number,rate:number}}
 */
export function dailyTotals(rows) {
  const list = Array.isArray(rows) ? rows : []
  let expected = 0
  let present = 0
  let absent = 0
  let openNow = 0
  for (const r of list) {
    expected += r.expected
    present += r.present
    absent += r.absent
    openNow += r.open_now
  }
  return { expected, present, absent, open_now: openNow, rate: expected > 0 ? Math.round((present / expected) * 100) : 0 }
}

/* ─── Scanner ops shaping ─── */

/**
 * Shape one `attendance_scanner_ops` row.
 * @param {object} r
 * @returns {object}
 */
export function toScannerRow(r) {
  return {
    scanner_badge: r?.scanner_badge || '',
    scanner_name: r?.scanner_name || '',
    scanner_centre: r?.scanner_centre || '',
    scans_in: Number(r?.scans_in) || 0,
    scans_out: Number(r?.scans_out) || 0,
    open_now: Number(r?.open_now) || 0,
    manual_scans: Number(r?.manual_scans) || 0,
    first_in_time: r?.first_in_time || null,
    last_scan_time: r?.last_scan_time || null,
  }
}

/**
 * Build the scanner-ops rows, busiest first. Rows with no scanner badge are
 * dropped — they cannot be attributed to a device.
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function buildScannerRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => r && r.scanner_badge)
    .map(toScannerRow)
    .sort((a, b) => b.scans_in - a.scans_in || String(a.scanner_badge).localeCompare(String(b.scanner_badge)))
}

/* ─── Filtering ─── */

/**
 * Case-insensitive match across badge / name / centre / department.
 * @param {Array<object>} rows
 * @param {string} term
 * @returns {Array<object>}
 */
export function searchRows(rows, term) {
  const list = Array.isArray(rows) ? rows : []
  const q = String(term || '').trim().toLowerCase()
  if (!q) return list
  return list.filter((r) =>
    [r.badge_number, r.sewadar_name, r.sewadar_centre, r.dept_name]
      .some((f) => String(f || '').toLowerCase().includes(q))
  )
}

/**
 * Restrict to one centre. 'all' (or empty) keeps everything. The
 * UNASSIGNED_CENTRE label matches rows with a null/empty centre.
 * @param {Array<object>} rows
 * @param {string} centre
 * @returns {Array<object>}
 */
export function filterByCentre(rows, centre, rootOf) {
  const list = Array.isArray(rows) ? rows : []
  if (!centre || centre === 'all') return list
  if (centre === UNASSIGNED_CENTRE) return list.filter((r) => !r?.sewadar_centre)
  // A parent-centre filter matches its whole subtree: picking DELHI keeps
  // DELHI-1's rows. rootOf is optional so existing two-arg callers behave
  // exactly as before.
  return list.filter(
    (r) => r?.sewadar_centre === centre
      || (typeof rootOf === 'function' && rootOf(r?.sewadar_centre) === centre)
  )
}

/**
 * Restrict to one department. 'all' (or empty) keeps everything.
 * @param {Array<object>} rows
 * @param {string} dept
 * @returns {Array<object>}
 */
export function filterByDept(rows, dept) {
  const list = Array.isArray(rows) ? rows : []
  if (!dept || dept === 'all') return list
  return list.filter((r) => r.dept_name === dept)
}

/**
 * Distinct, sorted centre buckets present in the rows — the centre filter's
 * options, scoped to what the caller may actually see. Rows with no centre are
 * surfaced under the UNASSIGNED_CENTRE label so they are reachable by the
 * filter rather than counted in the stats but invisible in the view.
 * @param {Array<object>} rows
 * @returns {string[]}
 */
export function centreOptions(rows) {
  const set = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    set.add(r?.sewadar_centre || UNASSIGNED_CENTRE)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/**
 * Distinct, sorted department names present in the rows.
 * @param {Array<object>} rows
 * @returns {string[]}
 */
export function deptOptions(rows) {
  const set = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.dept_name) set.add(r.dept_name)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/* ─── Centre tree (Reports matrix: parents collapse children) ─── */

/**
 * The tree root a centre rolls up to. Unknown centres and the unassigned
 * bucket are their own roots — promoting a phantom parent would invent a
 * group the operator can never expand into real children.
 * @param {Array<{name:string,parent_centre:string}>} centresList rows from dp_centres
 * @param {string} name
 * @returns {string}
 */
export function rootCentreOf(centresList, name) {
  const n = name || UNASSIGNED_CENTRE
  if (n === UNASSIGNED_CENTRE) return n
  const known = Array.isArray(centresList) ? centresList.some((c) => c?.name === n) : false
  if (!known) return n
  // getRootCentre returns a truthy name for any truthy input (unknown names
  // fall back to the input itself), so no fallback is needed here.
  return getRootCentre(centresList, n)
}

const zeroCounts = () => ({ deployed: 0, present: 0, absent: 0, openNow: 0 })

function addCounts(acc, r) {
  acc.deployed += Number(r?.deployed) || 0
  acc.present += Number(r?.present) || 0
  acc.absent += Number(r?.absent) || 0
  acc.openNow += Number(r?.openNow) || 0
  return acc
}

/**
 * Roll uniform matrix rows ({centre, deptName, deployed, present, absent,
 * openNow}) into parent-centre groups for the transposed matrix (departments
 * across the top, centres down the side).
 *
 * - One group per tree root. A root is a known top-level parent, or a
 *   standalone centre (unknown name / unassigned bucket) standing alone.
 * - `group.aggregate` sums the whole subtree (parent's own rows + every
 *   descendant) — this is the collapsed number.
 * - `group.own` holds the parent's OWN rows (null when it has none);
 *   `group.children` holds one entry per descendant centre WITH DATA,
 *   sorted by label. `childCount` counts exactly those expandable rows,
 *   so the (+N) badge always matches what opening reveals.
 * - Every entry carries `byDept` (Map dept → counts) so the matrix can
 *   render per-department cells without regrouping.
 *
 * @param {Array<object>} rows
 * @param {Array<{name:string,parent_centre:string}>} centresList
 * @returns {Array<object>} groups sorted by label
 */
export function buildCentreTree(rows, centresList) {
  const list = Array.isArray(rows) ? rows : []
  const centres = Array.isArray(centresList) ? centresList : []
  const knownParents = new Set(
    centres.filter((c) => c?.name && !c?.parent_centre).map((c) => c.name)
  )
  const perCentre = new Map()
  for (const r of list) {
    const c = r?.centre || UNASSIGNED_CENTRE
    let e = perCentre.get(c)
    if (!e) {
      e = { label: c, byDept: new Map(), total: zeroCounts() }
      perCentre.set(c, e)
    }
    const d = r?.deptName || '—'
    let cell = e.byDept.get(d)
    if (!cell) {
      cell = zeroCounts()
      e.byDept.set(d, cell)
    }
    addCounts(cell, r)
    addCounts(e.total, r)
  }
  const groups = new Map()
  for (const e of perCentre.values()) {
    const root = rootCentreOf(centresList, e.label)
    let g = groups.get(root)
    if (!g) {
      g = { key: root, label: root, isParent: false, childCount: 0, own: null, children: [], byDept: new Map(), total: zeroCounts() }
      groups.set(root, g)
    }
    if (e.label === root) {
      g.own = e
    } else {
      g.children.push(e)
    }
  }
  const out = [...groups.values()]
  for (const g of out) {
    const members = [...(g.own ? [g.own] : []), ...g.children]
    for (const m of members) {
      for (const [d, c] of m.byDept) {
        let a = g.byDept.get(d)
        if (!a) {
          a = zeroCounts()
          g.byDept.set(d, a)
        }
        a.deployed += c.deployed
        a.present += c.present
        a.absent += c.absent
        a.openNow += c.openNow
      }
      addCounts(g.total, m.total)
    }
    g.children.sort((a, b) => a.label.localeCompare(b.label))
    g.childCount = g.children.length
    // A chevron is only offered when opening reveals something new: a known
    // top-level parent with at least one child carrying data. Anything else
    // (standalone centre, childless parent) renders as a plain row.
    g.isParent = g.children.length > 0 && knownParents.has(g.label)
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

/* ─── v45 report shaping (Reports / Dashboard / Anomalies pages) ─── */

/**
 * Normalize attendance_visit_summary rows and add schedule-wide totals.
 * Input columns: centre, department_id, dept_name, deployed, ever_present,
 * never_present, open_now. Rows with a NULL centre are bucketed under
 * UNASSIGNED_CENTRE so they reconcile with the centre filter.
 */
export function buildVisitRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    centre: r?.centre || UNASSIGNED_CENTRE,
    department_id: r?.department_id ?? null,
    deptName: r?.dept_name || '—',
    deployed: Number(r?.deployed) || 0,
    everPresent: Number(r?.ever_present) || 0,
    neverPresent: Number(r?.never_present) || 0,
    openNow: Number(r?.open_now) || 0,
  }))
  const totals = list.reduce(
    (t, r) => ({
      deployed: t.deployed + r.deployed,
      everPresent: t.everPresent + r.everPresent,
      neverPresent: t.neverPresent + r.neverPresent,
      openNow: t.openNow + r.openNow,
    }),
    { deployed: 0, everPresent: 0, neverPresent: 0, openNow: 0 }
  )
  return { rows: list, totals }
}

/**
 * Normalize attendance_trend rows for the dashboard strip.
 * Input columns: day (YYYY-MM-DD), present, absent.
 * Adds rate = present share of the day (0 when the day has no deployed).
 */
export function buildTrendRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const present = Number(r?.present) || 0
    const absent = Number(r?.absent) || 0
    const total = present + absent
    // L-32/L-51: a rate is a share of a day — clamp to 0..100 so a server
    // over-count past the deployed total (or corrupt negatives) cannot
    // render as 120% or -100%.
    const raw = total > 0 ? Math.round((present / total) * 100) : 0
    return {
      day: r?.day || '',
      present,
      absent,
      rate: Math.min(100, Math.max(0, raw)),
    }
  })
}

/**
 * Count anomaly rows per rule. Unknown rule names pass through untouched —
 * a new server-side rule must never silently vanish from the counts.
 */
export function anomalyCounts(rows) {
  const counts = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    const rule = r?.rule || 'UNKNOWN'
    counts[rule] = (counts[rule] || 0) + 1
  }
  return counts
}

/**
 * Live-scanner verdict off a scanner_ops row's last_scan_time.
 * last_scan_time is a bare IST wall-clock for the queried date, so the page
 * passes that same date back in: combine as +05:30, compare to now.
 * - 'active': last scan within activeMin (default 15).
 * - 'idle': scanned that date but the last scan is older.
 * - 'offline': no scan time at all (or unparseable).
 */
export function scannerStatus(lastScanTime, dateStr, nowMs = Date.now(), activeMin = 15) {
  if (!lastScanTime || !dateStr) return 'offline'
  const t = Date.parse(`${dateStr}T${lastScanTime}+05:30`)
  if (!Number.isFinite(t)) return 'offline'
  return nowMs - t <= activeMin * 60000 ? 'active' : 'idle'
}

/**
 * "Updated Ns ago" / "last scan Xm ago" labels. Floors at 0s (a future
 * timestamp from clock skew must never read as a negative age).
 */
export function timeAgo(tsMs, nowMs = Date.now()) {
  if (!Number.isFinite(tsMs)) return '—'
  const s = Math.max(0, Math.round((nowMs - tsMs) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
