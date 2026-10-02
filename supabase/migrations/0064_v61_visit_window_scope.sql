-- ============================================================
-- V61: VISIT REPORTS COUNT THE VISIT WINDOW ONLY. Run AFTER v60.
--
-- Baseline: every function body below is copied from
-- sql/v59_attendance_aso_truth.sql VERBATIM except the listed diffs:
--
--   (a) DECLARE gains `v_window date[]` + `v_windowed boolean` (8 sites).
--   (b) Prologue computes them right after v_admin (8 sites):
--         v_window := public.schedule_visit_dates(p_schedule);
--         v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);
--   (c) Date-keyed entry points early-return on a previsit p_date:
--       daily, day_badges, scanner_ops (3 sites):
--         IF v_windowed AND NOT (p_date = ANY (v_window)) THEN RETURN; END IF;
--   (d) Whole-visit sweeps gain a window predicate on the row's event
--       date(s) — visit_summary, sewadar_summary (per_badge + both
--       event_days arms), scanner_open (in_date), anomalies (6 arms),
--       trend (days CTE, both arms). Subqueries already keyed on a
--       window-filtered day need no change.
--   (e) anomalies' outer ORDER BY moves outside a subselect. A CASE over a
--       UNION result is not a legal UNION ORDER BY — v59's form raised
--       `invalid UNION ORDER BY` on EVERY call (verified on PG 15: the
--       v59 definition fails identically, so the bug is inherited, not
--       introduced here). Same newest-500-per-arm inputs, same 2000-row
--       cap, same severity-then-date order — now executable.
--
-- Semantics:
--   - Schedules WITH a window: a previsit scan (any date outside the
--     window) no longer inflates days_present, ever_present, trend, or
--     any workbook. The Previsit view (v62) owns those dates.
--   - Schedules with NO window: NOT v_windowed short-circuits every
--     added predicate and skips every early return, so history recorded
--     before windows existed reads exactly as before.
--
-- Grants: untouched — CREATE OR REPLACE preserves every existing grant,
-- and no signature changes (no DROP needed).
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state,
-- attendance_scope_centres, attendance_allowed_depts,
-- attendance_badge_dept, is_my_incharge_dept_badge, RLS policies,
-- tables, columns, triggers, indexes, existing data.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- INSERT ... ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 2. attendance_daily_summary — the KPI tiles.
-- v61 diff: (a)(b) + early return (c) on a previsit p_date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_daily_summary(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  centre        text,
  department_id uuid,
  dept_name     text,
  expected      bigint,
  present       bigint,
  absent        bigint,
  open_now      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  -- v61 (c): a previsit date is not a visit day — the visit KPI view is
  -- empty for it (the Previsit view owns those dates).
  IF v_windowed AND NOT (p_date = ANY (v_window)) THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  agg AS (
    -- v59 (f): one badge, one centre. scoped_dep can hold the same badge
    -- under two centre keys (pathological, but real — see v57 §3); counting
    -- DISTINCT badges per (centre, dept) straight from scoped_dep counts it
    -- in expected TWICE while presence (via badge_eff) counts it once, so
    -- present + absent could never reconcile on either row. Aggregate
    -- badge_eff instead: expected and present now share the same grain.
    -- count(*) (not DISTINCT): badge_eff is already one row per badge.
    SELECT be.dc AS centre, be.eff AS department_id,
           count(*) AS expected
      FROM badge_eff be
     GROUP BY be.dc, be.eff
  ),
  present_agg AS (
    SELECT COALESCE(be.dc, a.sewadar_centre) AS centre,
           COALESCE(be.eff, a.sewadar_dept) AS department_id,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status IN ('OPEN','CLOSED')) AS present,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status = 'OPEN')             AS open_now
      FROM public.dp_attendance_sessions a
      LEFT JOIN badge_eff be ON be.badge_number = a.badge_number
     WHERE a.schedule_id = p_schedule
       AND (a.in_date = p_date OR a.out_date = p_date)
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: scope by the ATTRIBUTING department, not the scan snapshot, so
       -- a row counted as expected under X is countable as present under X.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
       -- v59 (a): presence counts DEPLOYED badges only. scoped_dep is the
       -- expectation set, so an undeployed scan can no longer inflate
       -- present past expected: present <= expected per cell, and absent
       -- reconciles without the GREATEST floor doing work. This closes the
       -- v58 KNOWN EXCEPTION for attendance_daily_summary. open_now keeps
       -- the same event-day window (v59 (b) — date-scoped, product decision).
       AND EXISTS (SELECT 1 FROM scoped_dep sd WHERE sd.badge_number = a.badge_number)
     GROUP BY 1, 2
  )
  SELECT agg.centre,
         agg.department_id,
         d.name,
         agg.expected,
         COALESCE(p.present, 0)  AS present,
         GREATEST(agg.expected - COALESCE(p.present, 0), 0)::bigint AS absent,
         COALESCE(p.open_now, 0) AS open_now
    FROM agg
    LEFT JOIN present_agg p
      ON p.centre = agg.centre
     AND p.department_id = agg.department_id
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- 3. attendance_visit_summary — the whole-visit tiles.
-- v61 diff: (a)(b) + window predicate (d) on per_badge's event dates.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_visit_summary(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  centre          text,
  department_id   uuid,
  dept_name       text,
  deployed        bigint,
  ever_present    bigint,
  never_present   bigint,
  open_now        bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  dep_agg AS (
    -- v59 (f): same one-badge-one-centre grain as pres_agg (see daily agg).
    SELECT be.dc AS centre, be.eff AS department_id,
           count(*) AS deployed
      FROM badge_eff be
     GROUP BY be.dc, be.eff
  ),
  per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_centre) AS sc,
           (array_remove(
              array_agg(a.sewadar_dept ORDER BY a.in_date DESC, a.in_time DESC),
              NULL))[1]          AS dept,
           -- v59 (b): date-scoped Open now — the event-day window keeps
           -- open_now comparable with the Daily tab, so a session opened
           -- day 1 and never closed counts in Open now only on day 1.
           -- p_date NULL disables the window (whole-visit sweep: every OPEN
           -- session counts); the Anomalies STALE_OPEN arm with p_date NULL
           -- is the safety net that still lists such sessions.
           bool_or(a.status = 'OPEN'
                   AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)) AS still_open
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v61 (d): visit-wide presence counts visit days only — a previsit
       -- scan no longer marks a badge ever-present.
       AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department, matching pres_agg's COALESCE below.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
     GROUP BY a.badge_number
  ),
  pres_agg AS (
    SELECT COALESCE(be.dc, b.sc) AS centre,
           COALESCE(be.eff, b.dept) AS department_id,
           count(*) AS ever_present,
           count(*) FILTER (WHERE b.still_open) AS open_now
      FROM per_badge b
      LEFT JOIN badge_eff be ON be.badge_number = b.badge_number
     GROUP BY 1, 2
  )
  SELECT agg.centre,
         agg.department_id,
         d.name,
         agg.deployed,
         COALESCE(p.ever_present, 0)::bigint AS ever_present,
         GREATEST(agg.deployed - COALESCE(p.ever_present, 0), 0)::bigint AS never_present,
         COALESCE(p.open_now, 0)::bigint     AS open_now
    FROM dep_agg agg
    LEFT JOIN pres_agg p
      ON p.centre = agg.centre
     AND p.department_id = agg.department_id
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- 4. attendance_sewadar_summary — the Sewadars tab.
-- v61 diff: (a)(b) + window predicate (d) on per_badge and BOTH
-- event_days arms, so days_present counts visit days only.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_sewadar_summary(p_schedule uuid)
RETURNS TABLE(
  badge_number    text,
  sewadar_name    text,
  sewadar_centre  text,
  department_id   uuid,
  dept_name       text,
  is_vss          boolean,
  days_present    integer,
  total_scans     bigint,
  open_sessions   bigint,
  first_in_date   date,
  first_in_time   time,
  last_out_date   date,
  last_out_time   time,
  still_open      boolean,
  undeployed_scan boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  -- ONE ROW PER BADGE. department_id is no longer the scan snapshot: it is
  -- resolved per badge in the outer SELECT through the same helper the
  -- scope gate uses, so the Sewadars tab and the Daily tab agree.
  RETURN QUERY
  WITH per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_name)   AS sewadar_name,
           max(a.sewadar_centre) AS sewadar_centre,
           bool_or(a.is_vss)     AS is_vss,
           count(*)::bigint      AS total_scans,
           count(*) FILTER (WHERE a.status = 'OPEN')::bigint AS open_sessions,
           min(a.in_date)        AS first_in_date,
           (array_agg(a.in_time ORDER BY a.in_date, a.in_time))[1] AS first_in_time,
           max(a.out_date)       AS last_out_date,
           (array_agg(a.out_time ORDER BY a.out_date DESC NULLS LAST, a.out_time DESC NULLS LAST))[1] AS last_out_time,
           bool_or(a.status = 'OPEN')  AS still_open,
           bool_or(a.undeployed_scan)  AS undeployed_scan
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v61 (d): visit rows only — previsit scans contribute nothing here.
       AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department, not the snapshot.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
     GROUP BY a.badge_number
  ),
  -- v45 EVENT-DATE LAW: days_present counts DISTINCT days on which the
  -- badge has ANY event — an IN day, an OUT day, or both. Same scope
  -- predicates as per_badge so the two agree on which rows count.
  event_days AS (
    SELECT a.badge_number, a.in_date AS d
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v61 (d): visit days only.
       AND (NOT v_windowed OR a.in_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT a.badge_number, a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       -- v61 (d): visit days only.
       AND (NOT v_windowed OR a.out_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
  ),
  days AS (
    SELECT e.badge_number, count(DISTINCT e.d)::integer AS days_present
      FROM event_days e
     GROUP BY e.badge_number
  )
  SELECT b.badge_number,
         b.sewadar_name,
         b.sewadar_centre,
         public.attendance_badge_dept(b.badge_number, p_schedule) AS department_id,
         d.name                       AS dept_name,
         b.is_vss,
         COALESCE(dy.days_present, 0) AS days_present,
         b.total_scans,
         b.open_sessions,
         b.first_in_date,
         b.first_in_time,
         b.last_out_date,
         b.last_out_time,
         b.still_open,
         b.undeployed_scan
    FROM per_badge b
    LEFT JOIN days dy ON dy.badge_number = b.badge_number
    LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(b.badge_number, p_schedule)
   ORDER BY b.sewadar_centre, b.sewadar_name, b.badge_number;
END;
$$;

-- ------------------------------------------------------------
-- 5. attendance_day_badges — the Present/Absent workbooks.
-- v61 diff: (a)(b) + early return (c) on a previsit p_date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_day_badges(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  p_mode     text DEFAULT 'absent'
)
RETURNS TABLE(
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  department_id  uuid,
  dept_name      text,
  is_vss         boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL OR p_date IS NULL THEN RETURN; END IF;
  IF p_mode NOT IN ('present','absent') THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  -- v61 (c): visit workbooks cover visit days only.
  IF v_windowed AND NOT (p_date = ANY (v_window)) THEN RETURN; END IF;

  IF p_mode = 'present' THEN
    RETURN QUERY
    WITH scoped_dep AS (
      -- v59 (e): the expectation set, same scope predicates as absent mode
      -- below. Present lists DEPLOYED badges only, so
      -- present + absent == deployed exactly.
      SELECT d.badge_number
        FROM public.deployments d
       WHERE d.schedule_id = p_schedule
         AND d.centre = ANY (v_centres)
         AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
         AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
    ),
    day_sess AS (
      SELECT a.badge_number, a.sewadar_name, a.sewadar_centre,
             a.sewadar_dept, a.is_vss, a.in_date, a.in_time
        FROM public.dp_attendance_sessions a
       WHERE a.schedule_id = p_schedule
         AND (a.in_date = p_date OR a.out_date = p_date)
         AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
         -- v55: the attributing department.
         AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
         -- v59 (e): deployed badges only (see scoped_dep above).
         AND EXISTS (SELECT 1 FROM scoped_dep sd WHERE sd.badge_number = a.badge_number)
    ),
    per_badge AS (
      SELECT s.badge_number,
             max(s.sewadar_name)   AS nm,
             max(s.sewadar_centre) AS sc,
             public.attendance_badge_dept(s.badge_number, p_schedule) AS dept,
             bool_or(s.is_vss)     AS vss
        FROM day_sess s
       GROUP BY s.badge_number
    )
    SELECT b.badge_number, b.nm, b.sc, b.dept, d.name, b.vss
      FROM per_badge b
      LEFT JOIN public.deployment_departments d ON d.id = b.dept
     ORDER BY b.sc NULLS LAST, b.nm NULLS LAST, b.badge_number;
    RETURN;
  END IF;

  -- absent: deployed (effective dept) minus badges with any VISIBLE event
  -- that day. The present CTE carries the same scope predicates as every
  -- sibling: without the dept gate, a badge seen only through an
  -- out-of-scope scan still subtracted from absent.
  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.sewadar_name, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  present AS (
    SELECT DISTINCT a.badge_number
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND (a.in_date = p_date OR a.out_date = p_date)
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
  ),
  -- Person truth for the VSS flag: the session flag where sessions exist
  -- (same source as present mode), the VSS roster where they don't.
  sess_vss AS (
    SELECT a.badge_number, bool_or(a.is_vss) AS vss
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
     GROUP BY a.badge_number
  )
  SELECT sd.badge_number, sd.sewadar_name, sd.centre, sd.eff, d.name,
         COALESCE(sv.vss,
                  EXISTS (SELECT 1 FROM public.vss_sewadars v
                           WHERE v.badge_number = sd.badge_number),
                  false) AS is_vss
    FROM scoped_dep sd
    LEFT JOIN public.deployment_departments d ON d.id = sd.eff
    LEFT JOIN sess_vss sv ON sv.badge_number = sd.badge_number
   WHERE NOT EXISTS (SELECT 1 FROM present p WHERE p.badge_number = sd.badge_number)
   ORDER BY sd.centre, sd.sewadar_name NULLS LAST, sd.badge_number;
END;
$$;

-- ------------------------------------------------------------
-- 6. attendance_scanner_open — the Live Scanners drill-down.
-- v61 diff: (a)(b) + window predicate (d) on the session's in_date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_scanner_open(
  p_schedule      uuid,
  p_scanner_badge text
)
RETURNS TABLE(
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  dept_name      text,
  in_date        date,
  in_time        time
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL OR p_scanner_badge IS NULL THEN RETURN; END IF;

  v_role := public.get_portal_user_role();
  -- v59 (h): NULL-safe gate. The old bare `v_role NOT IN (...)` admitted a
  -- caller with NO portal role: NULL NOT IN (...) is NULL, never TRUE, so
  -- the AND never fired. A missing role is now denied outright, fail-closed
  -- like the v39/v40 scope posture (vss_operator stays denied).
  IF v_role IS NULL OR (v_role NOT IN ('aso','super_admin')
     AND p_scanner_badge IS DISTINCT FROM public.attendance_caller_badge()) THEN
    RETURN;
  END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  RETURN QUERY
  SELECT a.badge_number,
         a.sewadar_name,
         a.sewadar_centre,
         d.name AS dept_name,
         a.in_date,
         a.in_time
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
   WHERE a.schedule_id = p_schedule
     AND a.status = 'OPEN'
     AND (a.in_scanner_badge = p_scanner_badge OR a.out_scanner_badge = p_scanner_badge)
     -- v61 (d): an OPEN session that started on a previsit day belongs to
     -- the Previsit view, not Live Scanners.
     AND (NOT v_windowed OR a.in_date = ANY (v_window))
     AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
     -- v55: the attributing department.
     AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
   ORDER BY a.in_date DESC, a.in_time DESC
   LIMIT 500;
END;
$$;

-- ------------------------------------------------------------
-- 7. attendance_scanner_ops — the Scanner Ops tab.
-- v61 diff: (a)(b) + early return (c) on a previsit p_date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_scanner_ops(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  scanner_badge   text,
  scanner_name    text,
  scanner_centre  text,
  scans_in        bigint,
  scans_out       bigint,
  open_now        bigint,
  manual_scans    bigint,
  first_in_time   time,
  last_scan_time  time
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  -- v61 (c): Scanner Ops is a visit-day view; a previsit date reads empty.
  IF v_windowed AND NOT (p_date = ANY (v_window)) THEN RETURN; END IF;

  RETURN QUERY
  SELECT COALESCE(a.in_scanner_badge, a.out_scanner_badge) AS scanner_badge,
         COALESCE(max(a.in_scanner_name), max(a.out_scanner_name)) AS scanner_name,
         -- The operator's OWN centre, not the venue. `a.centre` is the
         -- single constant bhati and would be identical on every row,
         -- which tells an ops review nothing.
         COALESCE(max(a.in_scanner_centre), max(a.out_scanner_centre)) AS scanner_centre,
         count(*) FILTER (WHERE a.in_date = p_date)                               AS scans_in,
         count(*) FILTER (WHERE a.out_date = p_date AND a.status = 'CLOSED')      AS scans_out,
         count(*) FILTER (WHERE a.status = 'OPEN')::bigint                        AS open_now,
         count(*) FILTER (WHERE a.is_manual)::bigint                              AS manual_scans,
         min(a.in_time) FILTER (WHERE a.in_date = p_date)                         AS first_in_time,
         max(CASE WHEN a.out_date = p_date THEN a.out_time
                  WHEN a.in_date = p_date THEN a.in_time END)                     AS last_scan_time
    FROM public.dp_attendance_sessions a
   WHERE a.schedule_id = p_schedule
     AND (a.in_date = p_date OR a.out_date = p_date)
     -- Scoped on the SEWADAR's home centre: a centre user sees ops
     -- for scans of their own subtree's people, and open scanning
     -- still works because a foreign-centre scan is attributed to the
     -- sewadar, not to the operator.
     AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
     -- v55: the attributing department.
     AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
   GROUP BY COALESCE(a.in_scanner_badge, a.out_scanner_badge)
   ORDER BY count(*) DESC, 2
   -- Safety ceiling only, not a report limit. This was 200, which
   -- silently dropped the LEAST active scanners — precisely the rows
   -- an ops review is looking for, since the sort is by scan count
   -- descending.
   LIMIT 1000;
END;
$$;

-- ------------------------------------------------------------
-- 8. attendance_anomalies — all five rule arms.
-- v61 diff: (a)(b) + window predicate (d) per arm: IN/OUT arms use the
-- row's event dates, IN-only arms (MULTI_SESSION, STALE_OPEN) use in_date.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_anomalies(
  p_schedule uuid,
  p_date     date DEFAULT NULL
)
RETURNS TABLE(
  rule           text,
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  dept_name      text,
  detail         text,
  event_date     date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_today   date;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));
  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  RETURN QUERY
  -- v61 (e): the six arms feed the subselect below; the severity ordering
  -- applies OUTSIDE it (see tail). A CASE over a UNION result is not a
  -- legal UNION ORDER BY — v59's form raised on every call, so v61 could
  -- not ship it verbatim. Same newest-500-per-arm inputs, same 2000-row
  -- cap, same severity-then-date order.
  SELECT q.rule, q.badge_number, q.sewadar_name, q.sewadar_centre,
         q.dept_name, q.detail, q.event_date
    FROM (
  -- UNDEPLOYED_SCAN: scanned with no deployment row at scan time.
  -- (First arm carries the AS aliases: UNION takes the first branch's
  -- column names, and the outer SELECT reads them as q.rule etc.)
  (SELECT 'UNDEPLOYED_SCAN'::text AS rule,
          a.badge_number, a.sewadar_name, a.sewadar_centre, d.name AS dept_name,
          ('Scanned ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
           || ' with no deployment for this schedule')::text AS detail,
          a.in_date AS event_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.undeployed_scan = true
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC, a.in_time DESC
    LIMIT 500)
  UNION ALL
  -- BAD_STATUS: current badge status outside the eligible list.
  -- v59 (i): the dp_sewadars arm below is unchanged; the second arm against
  -- public.vss_sewadars (same shape) covers VSS badges, which live in the
  -- VSS roster rather than dp_sewadars (columns verified:
  -- sql/v4_vss.sql:18-37).
  (SELECT 'BAD_STATUS'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Badge status ' || max(s.badge_status)
           || ' is not OPEN/PERMANENT — scanned '
           || count(DISTINCT a.id)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.dp_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY max(a.in_date) DESC
    LIMIT 500)
  UNION ALL
  -- v59 (i): VSS-roster arm, same shape as above.
  (SELECT 'BAD_STATUS'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Badge status ' || max(s.badge_status)
           || ' is not OPEN/PERMANENT — scanned '
           || count(DISTINCT a.id)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.vss_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number
    ORDER BY max(a.in_date) DESC
    LIMIT 500)
  UNION ALL
  -- MULTI_SESSION: ≥3 INs for one badge on one in_date.
  (SELECT 'MULTI_SESSION'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          (count(*)::text || ' sessions on ' || a.in_date::text)::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND (p_date IS NULL OR a.in_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
   HAVING count(*) >= 3
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  UNION ALL
  -- STALE_OPEN: an OPEN session whose IN is before today (IST).
  (SELECT 'STALE_OPEN'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Open since ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
           || ' — no OUT recorded')::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.status = 'OPEN'
      AND a.in_date < v_today
      -- v59 (d): the standard date predicate — a dated Anomalies view shows
      -- only that day's stale opens; p_date NULL keeps the whole-visit sweep.
      AND (p_date IS NULL OR a.in_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date, a.in_time
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  UNION ALL
  -- VSS_DEPT_MISMATCH: a VSS badge scanned outside a VSS department.
  -- v59 (c): the name-prefix HAVING (d.name ILIKE 'VSS%') is replaced with
  -- the v45 predicate on the EFFECTIVE department
  -- (sql/v45_attendance_reports.sql:590): a department is VSS-open iff
  -- deployment_departments.include_vss — verified present at
  -- sql/v4_vss.sql:55 (boolean NOT NULL DEFAULT false). With the LEFT JOIN
  -- kept, a NULL department (undeployed badge with no snapshot) reads as
  -- NOT VSS-open and is flagged — fail closed.
  (SELECT 'VSS_DEPT_MISMATCH'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('VSS badge scanned in ' || coalesce(max(d.name), 'no department')
           || ' — not a VSS department')::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.is_vss = true
      AND COALESCE(d.include_vss, false) = false
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  -- v59 (g): severity-then-date. The old ORDER BY rule listed BAD_STATUS
  -- first (alphabetical), so one rule's flood filled the old global cap
  -- before v49's per-arm caps; ordering by severity surfaces hung sessions
  -- and undeployed scans first. Exact per-rule counts would need a second
  -- result set, which a single TABLE function cannot return without a
  -- signature change — so the signature is untouched (pure CREATE OR
  -- REPLACE): each arm contributes its NEWEST 500 rows (ORDER BY inside
  -- the arm); the outer query keeps 2000. A simultaneous flood in 4+ arms
  -- can still evict the lowest-severity rule — narrow with p_date in
  -- that case.
  ) q
  ORDER BY CASE q.rule
             WHEN 'STALE_OPEN' THEN 0
             WHEN 'UNDEPLOYED_SCAN' THEN 1
             WHEN 'VSS_DEPT_MISMATCH' THEN 2
             WHEN 'MULTI_SESSION' THEN 3
             WHEN 'BAD_STATUS' THEN 4
             ELSE 5 END,
           q.event_date DESC NULLS LAST
  LIMIT 2000;
END;
$$;

-- ------------------------------------------------------------
-- 9. attendance_trend — the visit strip (deployed badges only, v47).
-- v61 diff: (a)(b) + window predicate (d) on the days CTE (both arms).
-- The present/absent subqueries are keyed on the CTE's day, so a
-- window-filtered CTE constrains them with no further change.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_trend(p_schedule uuid)
RETURNS TABLE(
  day     date,
  present bigint,
  absent  bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_deployed bigint;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  SELECT count(DISTINCT d.badge_number)::bigint INTO v_deployed
    FROM public.deployments d
   WHERE d.schedule_id = p_schedule
     AND d.centre = ANY (v_centres)
     AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
     AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts));

  RETURN QUERY
  WITH days AS (
    SELECT DISTINCT a.in_date AS d
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v61 (d): the strip spans visit days only — a previsit scan no
       -- longer adds a column to the visit strip.
       AND (NOT v_windowed OR a.in_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT DISTINCT a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       -- v61 (d): visit days only.
       AND (NOT v_windowed OR a.out_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
  ),
  -- the expectation set — badges holding a deployment in scope.
  -- Presence below counts WITHIN this set, so undeployed scans can no
  -- longer inflate the numerator past the deployed denominator.
  scoped_dep AS (
    SELECT DISTINCT d.badge_number
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  )
  SELECT dy.d AS day,
         (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR v_depts IS NOT NULL OR s.sewadar_centre = ANY (v_centres))
             -- v55: the attributing department.
             AND (v_depts IS NULL OR public.attendance_badge_dept(s.badge_number, p_schedule) = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep))::bigint AS present,
         GREATEST(v_deployed - (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR v_depts IS NOT NULL OR s.sewadar_centre = ANY (v_centres))
             -- v55: the attributing department.
             AND (v_depts IS NULL OR public.attendance_badge_dept(s.badge_number, p_schedule) = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep))::bigint, 0)::bigint AS absent
    FROM days dy
   ORDER BY dy.d;
END;
$$;

-- ------------------------------------------------------------
-- §10 (v61). Version registry (convention from v50: one row per
-- migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v61')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- Pre-conditions: a schedule with a window (v60 §2 backfill or the
-- Schedule Maker dates), deployments for it, and sessions on BOTH a
-- visit date and a previsit date. '<sched>' below is that schedule.
--
-- 1. A previsit scan no longer inflates the visit (the core v61 claim):
--   SELECT days_present FROM public.attendance_sewadar_summary('<sched>')
--    WHERE badge_number = '<badge-with-a-6-Oct-scan>';
--   -- Expect: counts visit-day events only (a 6 Oct scan adds 0).
--   SELECT count(*) FROM public.attendance_trend('<sched>')
--    WHERE day NOT BETWEEN '<start>' AND '<end>';
--   -- Expect: 0 — the strip spans the window only.
-- 2. A previsit date reads empty on the visit side:
--   SELECT count(*) FROM public.attendance_daily_summary('<sched>', '<previsit-date>');
--   SELECT count(*) FROM public.attendance_day_badges('<sched>', '<previsit-date>', 'present');
--   SELECT count(*) FROM public.attendance_day_badges('<sched>', '<previsit-date>', 'absent');
--   SELECT count(*) FROM public.attendance_scanner_ops('<sched>', '<previsit-date>');
--   -- Expect: 0, 0, <deployed-count — absent still lists everyone>, 0.
--   -- (absent on a previsit date lists the deployed set: nobody has a
--   -- visit-day event that day. That is correct — absence from the visit
--   -- on a non-visit day is vacuous, and the Previsit view owns the date.)
-- 3. A visit date is unchanged (spot-check against pre-v61 numbers):
--   SELECT centre, department_id, expected, present, absent
--     FROM public.attendance_daily_summary('<sched>', '<visit-date>');
--   -- Expect: identical to the v59 numbers for the same date.
-- 4. Windowless schedules keep legacy behaviour (no silent blanking):
--   SELECT count(*) FROM public.attendance_sewadar_summary('<windowless-sched>');
--   -- Expect: same rows as before v61 (NOT v_windowed ⇒ no predicate).
-- 5. Registry:
--   SELECT version FROM public.portal_version WHERE version = 'v61';
--   -- Expect: one row.
