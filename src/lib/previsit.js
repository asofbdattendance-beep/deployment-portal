/**
 * Previsit sewa presentation shapers — pure functions over the v62/v64 RPCs
 * (previsit_summary / previsit_sewadars). Since v64, previsit_sewadars
 * returns ONE ROW PER (event_date, badge): in_time = first IN of the day,
 * out_time = last OUT of the day (NULL while any session is still open),
 * duration_min = summed minutes (NULL while any session is still open),
 * plus session_count and is_open. No fetch, no side effects.
 * The server already resolved the caller's scope, so these rows are the
 * caller's own — this only folds, filters and formats them.
 */
import { splitDayLabel } from './attendance'

/**
 * Distinct previsit dates, newest first. One date = one previsit sewa.
 * @param {Array<object>} summaryRows previsit_summary rows
 * @returns {string[]} 'YYYY-MM-DD', descending
 */
export function previsitDates(summaryRows) {
  const set = new Set()
  for (const r of Array.isArray(summaryRows) ? summaryRows : []) {
    const d = typeof r?.event_date === 'string' ? r.event_date.slice(0, 10) : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d)
  }
  return [...set].sort().reverse()
}

/**
 * Split an ISO 'YYYY-MM-DD' date into a short month + day pair for the
 * matrix headers ("2 Oct"). Shared implementation — see splitDayLabel
 * in attendance.js; this alias keeps the previsit import path stable.
 * @param {string} date ISO date
 * @returns {{mon: string, num: string}}
 */
export function splitPrevisitDay(date) {
  return splitDayLabel(date)
}

/**
 * Badge × day matrix rows for the Total tab: one row per deployed badge
 * with a true/false per sewa day plus the day count. Row order follows
 * the deployed list (already centre → name).
 * @param {Array<object>} deployed visible previsit_deployed rows
 * @param {Map<string, Set<string>>} presentMap badge → days
 * @param {string[]} allDates every sewa day, newest first
 * @returns {Array<object>}
 */
export function buildPrevisitMatrixRows(deployed, presentMap, allDates) {
  const days = Array.isArray(allDates) ? allDates : []
  const map = presentMap instanceof Map ? presentMap : new Map()
  return (Array.isArray(deployed) ? deployed : []).filter(Boolean).map((r) => {
    const has = map.get(r.badge_number) || new Set()
    const byDate = {}
    for (const d of days) byDate[d] = has.has(d)
    return {
      badge_number: r.badge_number,
      sewadar_name: r.sewadar_name || '',
      sewadar_centre: r.sewadar_centre || '',
      dept_name: r.dept_name || 'No department',
      is_vss: !!r.is_vss,
      byDate,
      presentCount: days.filter((d) => has.has(d)).length,
    }
  })
}

/**
 * Headline tiles for the Previsit view.
 * @param {Array<object>} summaryRows previsit_summary rows
 * @returns {{sewas: number, present: number, openNow: number}}
 */
export function previsitKpis(summaryRows) {
  const list = Array.isArray(summaryRows) ? summaryRows : []
  let openNow = 0
  for (const r of list) {
    if (!r) continue
    openNow += Number(r.open_now) || 0
  }
  return {
    sewas: previsitDates(list).length,
    present: list.reduce((t, r) => t + (Number(r?.present) || 0), 0),
    openNow,
  }
}

/**
 * Department filter options present in the rows (id + name, A–Z).
 * Rows with no department resolve to the NO_DEPARTMENT_ID bucket so an
 * undeployed previsit badge is still selectable, never dropped — and the
 * bucket carries a real sentinel value (never ''), so it cannot be
 * confused with the "All departments" option.
 * @param {Array<object>} rows previsit_summary or previsit_sewadars rows
 * @returns {Array<{id: string, name: string}>}
 */
export const NO_DEPARTMENT_ID = '__none__'

export function previsitDeptOptions(rows) {
  const byId = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue
    const id = r.department_id || NO_DEPARTMENT_ID
    if (!byId.has(id)) byId.set(id, id === NO_DEPARTMENT_ID ? 'No department' : (r.dept_name || '—'))
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Filter previsit sewadar rows by date, department and free text.
 * The text matches badge, name or home centre (case-insensitive).
 * @param {Array<object>} rows previsit_sewadars rows
 * @param {object} filters { date?: string, departmentId?: string, query?: string }
 * @returns {Array<object>}
 */
export function filterPrevisitRows(rows, filters = {}) {
  const list = Array.isArray(rows) ? rows : []
  const date = typeof filters.date === 'string' ? filters.date : ''
  const dept = typeof filters.departmentId === 'string' ? filters.departmentId : ''
  const q = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : ''
  return list.filter((r) => {
    if (!r) return false
    if (date && String(r.event_date || '').slice(0, 10) !== date) return false
    // '' means "all departments". A picked department hides department-less
    // (undeployed) rows; NO_DEPARTMENT_ID selects exactly those rows.
    if (dept === NO_DEPARTMENT_ID) return !r.department_id
    if (dept !== '' && (r.department_id || '') !== dept) return false
    if (!q) return true
    return [r.badge_number, r.sewadar_name, r.sewadar_centre]
      .some((v) => String(v || '').toLowerCase().includes(q))
  })
}

/**
 * Minutes → "3h 05m" / "45m" / "—" (open session or missing).
 * @param {*} min
 * @returns {string}
 */
export function formatPrevisitDuration(min) {
  // NB: Number(null) === 0, so nullish/blank must be rejected BEFORE the
  // coercion — an open session (duration NULL) would otherwise read "0m".
  if (min === null || min === undefined || min === '') return '—'
  const n = Number(min)
  if (!Number.isFinite(n) || n < 0) return '—'
  const h = Math.floor(n / 60)
  const m = Math.round(n % 60)
  if (h <= 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/**
 * Per-sewa-day breakdown for the dashboard: one row per date (newest
 * first) with present/open counts plus the departments that showed up.
 * @param {Array<object>} summaryRows previsit_summary rows
 * @returns {Array<{date: string, present: number, openNow: number, departments: Array<{id: string, name: string}>}>}
 */
export function previsitByDay(summaryRows) {
  const byDate = new Map()
  for (const r of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!r) continue
    const d = typeof r.event_date === 'string' ? r.event_date.slice(0, 10) : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!byDate.has(d)) byDate.set(d, { date: d, present: 0, openNow: 0, departments: new Map() })
    const slot = byDate.get(d)
    slot.present += Number(r.present) || 0
    slot.openNow += Number(r.open_now) || 0
    const id = r.department_id || NO_DEPARTMENT_ID
    if (!slot.departments.has(id)) {
      slot.departments.set(id, id === NO_DEPARTMENT_ID ? 'No department' : (r.dept_name || '—'))
    }
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((s) => ({
      date: s.date,
      present: s.present,
      openNow: s.openNow,
      departments: [...s.departments.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

/**
 * Per-department breakdown for the dashboard: sewas attended + total
 * present, departments A–Z, department-less bucket last.
 * @param {Array<object>} summaryRows previsit_summary rows
 * @returns {Array<{id: string, name: string, sewas: number, present: number}>}
 */
export function previsitByDept(summaryRows) {
  const byId = new Map()
  for (const r of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!r) continue
    const id = r.department_id || NO_DEPARTMENT_ID
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: id === NO_DEPARTMENT_ID ? 'No department' : (r.dept_name || '—'),
        dates: new Set(),
        present: 0,
      })
    }
    const slot = byId.get(id)
    const d = typeof r.event_date === 'string' ? r.event_date.slice(0, 10) : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) slot.dates.add(d)
    slot.present += Number(r.present) || 0
  }
  return [...byId.values()]
    .map((s) => ({ id: s.id, name: s.name, sewas: s.dates.size, present: s.present }))
    .sort((a, b) => {
      if (a.id === NO_DEPARTMENT_ID) return 1
      if (b.id === NO_DEPARTMENT_ID) return -1
      return a.name.localeCompare(b.name)
    })
}

/**
 * Badges scanned on one sewa day — the Present set behind the Total tab's
 * tick column. A badge with several sessions that day appears once.
 * @param {Array<object>} rows previsit_sewadars rows
 * @param {string} date 'YYYY-MM-DD' ('' = no day selected → empty set)
 * @returns {Set<string>}
 */
export function previsitPresentSet(rows, date) {
  const set = new Set()
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return set
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.badge_number) continue
    if (String(r.event_date || '').slice(0, 10) !== date) continue
    set.add(r.badge_number)
  }
  return set
}

/**
 * Badge → the set of sewa days it scanned on. Backs the Total tab when
 * "All sewa days" is selected (a per-day tick is meaningless there, so
 * the tab shows each deployed badge's day count instead).
 * @param {Array<object>} rows previsit_sewadars rows
 * @returns {Map<string, Set<string>>}
 */
export function previsitPresentMap(rows) {
  const map = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.badge_number) continue
    const d = String(r.event_date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!map.has(r.badge_number)) map.set(r.badge_number, new Set())
    map.get(r.badge_number).add(d)
  }
  return map
}

/**
 * The Attention lists behind the register's third tab: sessions left
 * open, scans with no deployment row, and badges with more than one
 * session on a day. Each list is newest-day first, badge A–Z within a day.
 * @param {Array<object>} rows previsit_sewadars rows (already filtered)
 * @returns {{open: Array<object>, undeployed: Array<object>, multi: Array<object>}}
 */
export function previsitAttention(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean)
  const byNewest = (fn) => list
    .filter(fn)
    .sort((a, b) =>
      String(b.event_date || '').localeCompare(String(a.event_date || '')) ||
      String(a.badge_number || '').localeCompare(String(b.badge_number || '')))
  return {
    open: byNewest((r) => !!r.is_open),
    undeployed: byNewest((r) => !!r.undeployed),
    multi: byNewest((r) => (Number(r.session_count) || 0) > 1),
  }
}

/**
 * Filter the deployed Total list by department + free text. The text
 * matches name, badge or home centre (case-insensitive).
 * @param {Array<object>} deployed previsit_deployed rows
 * @param {object} filters { departmentId?: string, query?: string }
 * @returns {Array<object>}
 */
export function filterPrevisitTotal(deployed, filters = {}) {
  const list = Array.isArray(deployed) ? deployed : []
  const dept = typeof filters.departmentId === 'string' ? filters.departmentId : ''
  const q = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : ''
  return list.filter((r) => {
    if (!r) return false
    if (dept === NO_DEPARTMENT_ID) return !r.department_id
    if (dept !== '' && (r.department_id || '') !== dept) return false
    if (!q) return true
    return [r.badge_number, r.sewadar_name, r.sewadar_centre]
      .some((v) => String(v || '').toLowerCase().includes(q))
  })
}

/**
 * Flat Total-tab rows for the Excel workbook: one `Present <ISO day>`
 * column per sewa day, so the sheet mirrors the badge × day matrix.
 * @param {Array<object>} deployed visible previsit_deployed rows
 * @param {Map<string, Set<string>>} presentMap badge → days
 * @param {string[]} allDates every sewa day, newest first
 * @returns {Array<object>}
 */
export function previsitTotalExportRows(deployed, presentMap, allDates) {
  const days = Array.isArray(allDates) ? allDates : []
  const map = presentMap instanceof Map ? presentMap : new Map()
  return (Array.isArray(deployed) ? deployed : []).filter(Boolean).map((r) => {
    const out = {
      Badge: r.badge_number || '',
      Name: r.sewadar_name || '',
      Centre: r.sewadar_centre || '',
      Department: r.dept_name || 'No department',
      VSS: r.is_vss ? 'Yes' : '',
    }
    for (const d of days) {
      out[`Present ${d}`] = map.get(r.badge_number)?.has(d) ? 'Yes' : ''
    }
    return out
  })
}

/**
 * One grouped register row for the Excel workbook. In = first IN of the
 * day, Out = last OUT of the day, Duration = summed minutes (— while any
 * session is still open), Sessions = the day's scan count.
 * @param {object} r previsit_sewadars row
 * @returns {object}
 */
export function previsitExportRow(r) {
  if (!r) return {}
  return {
    Date: String(r.event_date || '').slice(0, 10),
    Badge: r.badge_number || '',
    Name: r.sewadar_name || '',
    Centre: r.sewadar_centre || '',
    Department: r.dept_name || '—',
    'First in': r.in_time ? String(r.in_time).slice(0, 5) : '',
    'Last out': r.out_time ? String(r.out_time).slice(0, 5) : '',
    Duration: formatPrevisitDuration(r.duration_min),
    Sessions: Number(r.session_count) || 1,
    VSS: r.is_vss ? 'Yes' : '',
    Manual: r.is_manual ? 'Yes' : '',
    Undeployed: r.undeployed ? 'Yes' : '',
    Open: r.is_open ? 'Yes' : '',
  }
}

/**
 * Flat rows for the Excel workbook (shared export driver).
 * @param {Array<object>} rows previsit_sewadars rows
 * @returns {Array<object>}
 */
export function previsitExportRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map(previsitExportRow)
}

/**
 * Flat Attention-tab rows: the union of the three flag lists, each row
 * carrying a Flag column naming every list it appears in.
 * @param {{open: Array<object>, undeployed: Array<object>, multi: Array<object>}} att
 * @returns {Array<object>}
 */
export function previsitAttentionExportRows(att) {
  const seen = new Map()
  const tag = (list, label) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (!r) continue
      const k = `${String(r.event_date || '').slice(0, 10)}|${r.badge_number}`
      if (!seen.has(k)) seen.set(k, { row: r, flags: [] })
      if (!seen.get(k).flags.includes(label)) seen.get(k).flags.push(label)
    }
  }
  tag(att?.open, 'Open')
  tag(att?.undeployed, 'Undeployed')
  tag(att?.multi, 'Multiple sessions')
  return [...seen.values()].map(({ row, flags }) => ({ ...previsitExportRow(row), Flag: flags.join(', ') }))
}
