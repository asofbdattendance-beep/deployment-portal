/**
 * Scan popup display resolver — the ONE place that turns a scanned payload
 * into the three text fields (plus two pills) the scan popup renders.
 *
 * The bug this module exists to prevent: since migration v40
 * (`sql/v40_attendance_venue_scope.sql`), `dp_attendance_sessions.centre` holds
 * a single physical scan VENUE (a constant, "Bhati - Delhi MC"), NOT the
 * sewadar's centre. The sewadar's HOME centre lives in `sewadar_centre`.
 * Any code that labels a sewadar with `row.centre` shows every sewadar in the
 * venue. `scanDisplay` therefore reads `sewadar_centre` and NEVER `centre`.
 */

// ─── helpers ────────────────────────────────────────────────────────────────
/**
 * Normalizes a value to a trimmed non-empty string, or null.
 * Non-strings (null, undefined, numbers, objects) become null, so every text
 * field this module returns is `string | null` and never `undefined` or `''`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function clean(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Picks the primary field when it is a string at all, else the fallback.
 * A primary that is present-but-blank resolves to null and does NOT fall
 * through — a blank RPC value is a data signal, not a missing one.
 *
 * @param {unknown} primary
 * @param {unknown} fallback
 * @returns {string | null}
 */
function pickString(primary, fallback) {
  if (typeof primary === 'string') return clean(primary)
  return clean(fallback)
}

/**
 * Resolves a department id against the name map. A miss (or a map that is
 * absent) yields null — the raw uuid is never surfaced to the UI.
 *
 * @param {unknown} deptId
 * @param {Map<string,string>|null|undefined} deptNameById
 * @returns {string | null}
 */
function deptFromMap(deptId, deptNameById) {
  const id = clean(deptId)
  if (id === null) return null
  if (typeof deptNameById?.get !== 'function') return null
  return clean(deptNameById.get(id))
}

// ─── deptNameMap ────────────────────────────────────────────────────────────
/**
 * Builds a Map<department_id, department_name> from `deployment_departments`
 * rows. Rows with a missing/blank id or name are skipped, as are null /
 * non-object entries.
 *
 * @param {Array<{id?: string, name?: string}>} [depts] — null/undefined tolerated
 * @returns {Map<string, string>} — empty Map when there is nothing usable
 */
export function deptNameMap(depts = []) {
  const map = new Map()
  // A `= []` default only covers `undefined`; an explicit `null` would blow up
  // the for..of, so guard the iterable-ness here too.
  if (!depts || typeof depts[Symbol.iterator] !== 'function') return map
  for (const row of depts) {
    if (!row || typeof row !== 'object') continue
    const id = clean(row.id)
    const name = clean(row.name)
    if (id === null || name === null) continue
    map.set(id, name)
  }
  return map
}

// ─── scanDisplay ────────────────────────────────────────────────────────────
/**
 * Resolves the display fields for one scanned sewadar.
 *
 * @param {object|null|undefined} payload — either an RPC return (the jsonb from
 *   `scan_in` / `scan_out`) or a `dp_attendance_sessions` row (e.g. from
 *   `get_open_session`). null/undefined is tolerated.
 * @param {Map<string,string>|null|undefined} [deptNameById] — Map from
 *   `deptNameMap()`, used to resolve the `sewadar_dept` id snapshot.
 * @returns {{
 *   name: string|null,      // payload.sewadar_name, else payload.name
 *   centre: string|null,    // payload.sewadar_centre ONLY — never the venue
 *   deptName: string|null,  // payload.dept_name, else the map lookup
 *   isVss: boolean,         // payload.is_vss — drives the VSS pill
 *   undeployed: boolean,    // payload.undeployed_scan — drives the Flagged pill
 * }} — exactly these five keys; the three text fields are never `undefined`.
 */
export function scanDisplay(payload, deptNameById) {
  const p = payload && typeof payload === 'object' ? payload : {}

  // `dept_name` is the string a v43 RPC returns; only fall back to the
  // `sewadar_dept` id snapshot when the RPC did not send a name at all.
  const deptName = typeof p.dept_name === 'string'
    ? clean(p.dept_name)
    : deptFromMap(p.sewadar_dept, deptNameById)

  return {
    name: pickString(p.sewadar_name, p.name),
    centre: clean(p.sewadar_centre), // deliberately NOT p.centre — that is the venue
    deptName,
    isVss: Boolean(p.is_vss),
    undeployed: Boolean(p.undeployed_scan),
  }
}
