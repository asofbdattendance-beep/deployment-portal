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

/* ─── Duration for one sewadar's visit ─── */

/**
 * Human duration of a sewadar's visit from its display row: the last
 * IN→OUT pair, formatted. 'still IN' when the last session is open, '—' when
 * there is nothing to measure.
 *
 * Lives here (not in a page) so the desktop table, the phone card
 * (AttendanceCards) and the Excel sheet can never disagree on a duration.
 * This is the consumer that makes `sessionMinutes` / `formatDuration` live
 * code rather than a tested-but-unused pair.
 *
 * @param {object} r a display row from buildSewadarRows
 * @returns {string}
 */
export function sessionDuration(r) {
  if (!r?.first_in_time) return '—'
  if (!r.last_out_time) return r.still_open ? 'still IN' : '—'
  return formatDuration(sessionMinutes(r.first_in_time, r.last_out_time, r.first_in_date, r.last_out_date))
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
  const rate = expected > 0 ? Math.min(100, Math.round((present / expected) * 100)) : 0
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
  return { expected, present, absent, open_now: openNow, rate: expected > 0 ? Math.min(100, Math.round((present / expected) * 100)) : 0 }
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
 * Normalize attendance_trend rows into the full 5-day visit strip.
 * Input columns: day (YYYY-MM-DD), present, absent.
 * The RPC only lists days with scan events, so a silent day vanishes and a
 * sparse visit renders as a short strip. This maps every row onto its
 * VISIT_DAY weekday (UTC) and emits all five WED–SUN slots in order — days
 * with no events become zero rows (present 0, absent = deployed-if-known
 * else 0, rate 0). Deployed is derived from the v47 invariant
 * present + absent == deployed (max across ALL rows, including rows whose
 * day cannot be placed). First row wins on a weekday collision.
 * Adds rate = present share of the day (0 when the day has no deployed).
 *
 * Hard rule (Bhati Visit shows visit-days data only): when `windowDates`
 * is an array, rows dated outside it are dropped before placement
 * (a previsit scan must never land under a visit weekday) and the deployed
 * estimate is drawn from in-window rows only. An EMPTY array means the
 * schedule has no visit window — the strip is five zero slots. `null` /
 * `undefined` keeps the legacy unfiltered behaviour for callers that do
 * not scope by schedule.
 *
 * @param {Array<object>} rows trend rows with a `day` field
 * @param {string[]|null} [windowDates] expanded visit window ('YYYY-MM-DD')
 */
export function buildTrendRows(rows, windowDates = null) {
  const list = Array.isArray(rows) ? rows : []
  // null/undefined = caller does not scope by schedule (legacy unfiltered).
  // ANY array (even empty) scopes: only listed dates place, an empty window
  // drops everything so a windowless schedule reads as an all-zero strip.
  const inWindow = Array.isArray(windowDates)
    ? new Set(windowDates.filter((d) => typeof d === 'string' && d))
    : null
  const byWeekday = new Map()
  let deployed = 0
  for (const r of list) {
    if (!r) continue
    // A previsit scan never seeds the visit denominator either.
    if (inWindow && !inWindow.has(r?.day)) continue
    const present = Number(r?.present) || 0
    const absent = Number(r?.absent) || 0
    deployed = Math.max(deployed, present + absent)
    const wd = weekdayOf(r?.day)
    if (wd && !byWeekday.has(wd)) byWeekday.set(wd, { present, absent })
  }
  return VISIT_DAYS.map((wd) => {
    const hit = byWeekday.get(wd)
    const present = hit ? hit.present : 0
    const absent = hit ? hit.absent : deployed
    const total = present + absent
    // L-32/L-51: a rate is a share of a day — clamp to 0..100 so a server
    // over-count past the deployed total (or corrupt negatives) cannot
    // render as 120% or -100%.
    const raw = total > 0 ? Math.round((present / total) * 100) : 0
    return {
      day: wd,
      present,
      absent,
      rate: Math.min(100, Math.max(0, raw)),
    }
  })
}

/**
 * VISIT_DAY weekday ('WED'..'SUN') for an ISO 'YYYY-MM-DD' string, parsed as
 * UTC so the weekday never shifts. Null for missing/malformed dates and for
 * MON/TUE (outside the visit strip — those rows still count toward the
 * deployed estimate, they just place nowhere).
 */
function weekdayOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '')
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (Number.isNaN(d.getTime())) return null
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null
  switch (d.getUTCDay()) {
    case 3: return 'WED'
    case 4: return 'THU'
    case 5: return 'FRI'
    case 6: return 'SAT'
    case 0: return 'SUN'
    default: return null
  }
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
 * - 'active': the scanned date is TODAY (IST) and the last scan is within
 *   activeMin (default 15).
 * - 'idle': the scanned date is today but the last scan is older.
 * - 'scanned': the scan date is valid but is NOT today (a past/future visit
 *   day) — render as a neutral "Scanned HH:MM" pill, never counted in
 *   Active-now tiles (those count 'active' only).
 * - 'offline': no scan time/date at all (or unparseable).
 * @returns {'active'|'idle'|'scanned'|'offline'}
 */
export function scannerStatus(lastScanTime, dateStr, nowMs = Date.now(), activeMin = 15) {
  if (!lastScanTime || !dateStr) return 'offline'
  const t = Date.parse(`${dateStr}T${lastScanTime}+05:30`)
  if (!Number.isFinite(t)) return 'offline'
  const todayIST = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  if (dateStr !== todayIST) return 'scanned'
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

/**
 * Headline counts for a department incharge's dashboard (v51).
 *
 * The server already resolved the caller's scope (their departments, across
 * every centre), so these rows are the department's own — this only folds them
 * into the tile numbers. The two inputs come from two DIFFERENT shapes and the
 * asymmetry is the whole reason this function exists:
 *
 *   dailyRaw — `attendance_daily_summary`: per centre × department, columns
 *              expected / present / absent / open_now. "Today" is a point in
 *              time, and the denominator is deployed sewadars, so this is the
 *              tile set that matches the ask ("total count present absent").
 *   visitRaw — `attendance_visit_summary`: per centre × department, columns
 *              deployed / ever_present / never_present / open_now. Present
 *              means "scanned at least once in the visit", which is NOT the
 *              same as present today — keeping the two labelled apart stops
 *              "47 present on the visit" being read as "present right now".
 *
 * Rows are summed across centres, and a NULL department is skipped rather than
 * counted into a department nobody is named for.
 *
 * @param {Array<object>} dailyRaw attendance_daily_summary rows
 * @param {Array<object>} visitRaw attendance_visit_summary rows
 * @returns {{today: object, visit: object, byDepartment: Array<object>}}
 */
export function deptInchargeKpis(dailyRaw, visitRaw) {
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0)

  const daily = (Array.isArray(dailyRaw) ? dailyRaw : []).filter((r) => r && r.department_id)
  const today = daily.reduce(
    (t, r) => ({
      deployed: t.deployed + (Number(r.expected) || 0),
      present: t.present + (Number(r.present) || 0),
      absent: t.absent + (Number(r.absent) || 0),
      openNow: t.openNow + (Number(r.open_now) || 0),
    }),
    { deployed: 0, present: 0, absent: 0, openNow: 0 }
  )
  today.rate = pct(today.present, today.deployed)
  today.band = rateBand(today.rate)

  const visit = (Array.isArray(visitRaw) ? visitRaw : []).filter((r) => r && r.department_id)
  const whole = visit.reduce(
    (t, r) => ({
      deployed: t.deployed + (Number(r.deployed) || 0),
      present: t.present + (Number(r.ever_present) || 0),
      absent: t.absent + (Number(r.never_present) || 0),
      openNow: t.openNow + (Number(r.open_now) || 0),
    }),
    { deployed: 0, present: 0, absent: 0, openNow: 0 }
  )
  whole.rate = pct(whole.present, whole.deployed)
  whole.band = rateBand(whole.rate)

  // Per-department breakdown. The two sources are keyed by department_id, so a
  // missing counterpart leaves that side at zero rather than dropping the
  // department — the tiles must always add up to the visible breakdown.
  const byId = new Map()
  const slot = (r) => {
    const id = r.department_id
    if (!byId.has(id)) {
      byId.set(id, { department_id: id, deptName: r.dept_name || '—', today: null, visit: null })
    }
    return byId.get(id)
  }
  for (const r of daily) {
    const row = slot(r)
    if ((!row.deptName || row.deptName === '—') && r.dept_name) row.deptName = r.dept_name
    if (!row.today) row.today = { deployed: 0, present: 0, absent: 0 }
    row.today.deployed += (Number(r.expected) || 0)
    row.today.present += (Number(r.present) || 0)
    row.today.absent += (Number(r.absent) || 0)
  }
  for (const r of visit) {
    const row = slot(r)
    if ((!row.deptName || row.deptName === '—') && r.dept_name) row.deptName = r.dept_name
    if (!row.visit) row.visit = { deployed: 0, present: 0, absent: 0 }
    row.visit.deployed += (Number(r.deployed) || 0)
    row.visit.present += (Number(r.ever_present) || 0)
    row.visit.absent += (Number(r.never_present) || 0)
  }
  const byDepartment = [...byId.values()]
    .map((row) => {
      const t = row.today || { deployed: 0, present: 0, absent: 0 }
      const v = row.visit || { deployed: 0, present: 0, absent: 0 }
      return {
        department_id: row.department_id,
        deptName: row.deptName,
        today: { ...t, rate: pct(t.present, t.deployed), band: rateBand(pct(t.present, t.deployed)) },
        visit: { ...v, rate: pct(v.present, v.deployed), band: rateBand(pct(v.present, v.deployed)) },
      }
    })
    .sort((a, b) => a.deptName.localeCompare(b.deptName))

  return { today, visit: whole, byDepartment }
}

/* ─── Short day labels ("2 Oct") — the single display format for dates
   across the attendance module (chips, strips, registers, matrices,
   empty states, toasts). Parsed as UTC so the day never shifts; RPC
   params, export filenames and sheet contents stay ISO. ─── */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Split an ISO 'YYYY-MM-DD' date into a short month + day pair for the
 * day-column headers ("Oct" over "2"). Falls back to the raw string as
 * the number line when unparseable.
 * @param {string} date ISO date
 * @returns {{mon: string, num: string}}
 */
export function splitDayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').slice(0, 10))
  if (!m) return { mon: '', num: String(date || '') }
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (Number.isNaN(d.getTime())) return { mon: '', num: String(date || '') }
  return { mon: MONTH_SHORT[d.getUTCMonth()], num: String(d.getUTCDate()) }
}

/**
 * One-line short date for running text ("2 Oct"). Unparseable input
 * passes through unchanged, so empty stays empty.
 * @param {string} date ISO date
 * @returns {string}
 */
export function shortDayLabel(date) {
  const { mon, num } = splitDayLabel(date)
  return mon ? `${num} ${mon}` : num
}

/* ─── Attendance matrix (per-sewadar × per-day presence grid) ─── */

/**
 * Ordered column dates for the attendance matrix: EXACTLY the schedule's
 * visit window (use expandDateRange from sewaMode.js — the DB window is the
 * single source of truth since v60). Trend rows NEVER contribute columns:
 * a previsit scan (or any out-of-window day) must not grow a Bhati Visit
 * column — those dates belong to the Previsit modules. An empty/unusable
 * window yields no columns (the page renders a no-window notice instead).
 *
 * @param {string[]} windowDates expanded visit window ('YYYY-MM-DD')
 * @returns {string[]} ordered unique 'YYYY-MM-DD' strings
 */
export function visitColumns(windowDates) {
  const set = new Set()
  for (const d of Array.isArray(windowDates) ? windowDates : []) {
    if (typeof d === 'string' && d && /^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d)
  }
  return [...set].sort()
}

/**
 * Build the per-sewadar × per-day presence grid behind AttendanceMatrix from
 * the per-date `attendance_day_badges` lists.
 *
 * Identity is the UNION of badges across ALL present + absent lists (rows with
 * a falsy `badge_number` are skipped), so a deployed-never-scanned sewadar —
 * absent on every date, present on none — still yields a row instead of going
 * missing (the scanned-only `attendance_sewadar_summary` could never list
 * them). Display fields (`sewadar_name`, `centre`, `dept_name`, `is_vss`)
 * prefer the ABSENT-arm row when the badge appears in any absent list — the
 * absent list is deployment truth — and fall back to the present-arm row for
 * badges seen only there. Presence is keyed by BADGE ONLY: `byDate[date]` is
 * true iff the badge is in that date's present list, and centres are never
 * compared (the present snapshot and the deployment truth can disagree on
 * centre for the same badge). Rows are ordered centre → name → badge, the same
 * hierarchy grouping the other portal tables use.
 *
 * @param {object} dayBadges per-date lists: `{ [date]: { present: Array, absent: Array } }`,
 *   each row shaped `{ badge_number, sewadar_name, sewadar_centre, dept_name, is_vss }`
 * @param {string[]} columns ordered 'YYYY-MM-DD' strings (see visitColumns)
 * @returns {{columns: string[], rows: Array<object>}} rows shaped
 *   {badge_number, sewadar_name, centre, dept_name, is_vss, byDate, presentCount}
 */
export function buildAttendanceMatrixFromDayBadges(dayBadges, columns) {
  const cols = Array.isArray(columns) ? [...columns] : []
  const source = dayBadges && typeof dayBadges === 'object' ? dayBadges : {}
  const presentByDate = {}
  const absentDisplay = new Map()
  const presentDisplay = new Map()
  const badges = new Set()
  const takeRow = (map, row) => {
    const badge = row?.badge_number
    if (!badge || map.has(badge)) return
    map.set(badge, row)
  }
  for (const date of Object.keys(source)) {
    const entry = source[date]
    // Tolerate a bare array (treated as the present list) alongside the
    // documented { present, absent } shape.
    const presentList = Array.isArray(entry?.present) ? entry.present : (Array.isArray(entry) ? entry : [])
    const absentList = Array.isArray(entry?.absent) ? entry.absent : []
    const presentSet = new Set()
    for (const row of presentList) {
      if (!row || !row.badge_number) continue
      badges.add(row.badge_number)
      presentSet.add(row.badge_number)
      takeRow(presentDisplay, row)
    }
    presentByDate[date] = presentSet
    for (const row of absentList) {
      if (!row || !row.badge_number) continue
      badges.add(row.badge_number)
      takeRow(absentDisplay, row)
    }
  }
  const rows = [...badges]
    .map((badge) => {
      // Every badge in `badges` was stored in at least one of the two maps
      // above (add + takeRow happen together), so no third fallback exists.
      const display = absentDisplay.get(badge) || presentDisplay.get(badge)
      const byDate = {}
      let presentCount = 0
      for (const date of cols) {
        const present = !!presentByDate[date]?.has(badge)
        byDate[date] = present
        if (present) presentCount += 1
      }
      return {
        badge_number: badge,
        sewadar_name: display.sewadar_name || '',
        centre: display.sewadar_centre || '',
        dept_name: display.dept_name || '',
        is_vss: !!display.is_vss,
        byDate,
        presentCount,
      }
    })
    // compareSewadarRows reads `sewadar_centre`; the matrix row carries the
    // same value as `centre`, so adapt the shape instead of duplicating the
    // comparator.
    .sort((a, b) => compareSewadarRows(
      { sewadar_centre: a.centre, sewadar_name: a.sewadar_name, badge_number: a.badge_number },
      { sewadar_centre: b.centre, sewadar_name: b.sewadar_name, badge_number: b.badge_number },
    ))
  return { columns: cols, rows }
}
