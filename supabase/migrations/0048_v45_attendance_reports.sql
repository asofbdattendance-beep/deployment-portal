-- ============================================================
-- V45: attendance reports — event-date presence + visit/anomaly/trend RPCs
-- ============================================================
--
-- WHY (the day-attribution law — read this before touching anything below):
--
--   A session's EVENT DATES are {in_date} ∪ {out_date if not null}.
--   Present(badge, D)  ⟺  the badge has a session for this schedule with
--                           D in its event dates. An IN *or* an OUT on D
--                           counts — an IN on the 5th plus an OUT on the
--                           6th is present on BOTH days.
--   Absent(badge, D)   ⟺  deployed for the schedule AND NOT present on D.
--                           NOTHING CARRIES OVER: a silent day is absent
--                           even with an OPEN session hanging.
--
--   v39 attributed presence by in_date ONLY (daily_summary
--   `a.in_date = p_date`; sewadar_summary `count(DISTINCT in_date)`), so
--   an overnight OUT bought no presence on its own day. This file
--   REDEFINES those two functions with event-date logic and adds the
--   visit/anomaly/trend/scanner-drill RPCs the Reports, Live Scanners,
--   Anomalies and Dashboard pages are built on.
--
--   Behaviour change is one-directional and exactly the requested one:
--   numbers only ever GAIN presence on OUT-days. IN-only days, silent
--   days, open_now, denominators and scope gates are untouched.
--
-- SCOPE / ROLES: every function below reuses the v39 gates verbatim —
--   attendance_scope_centres + attendance_allowed_depts, SECURITY DEFINER,
--   early RETURN on NULL schedule or empty scope. aso/super_admin see all
--   centres; everyone else sees their own scope; unknown roles see nothing.
--
-- Run AFTER v44. Non-destructive; safe to re-run (CREATE OR REPLACE,
-- no table/column/index/trigger/RLS touched).
-- ------------------------------------------------------------

BEGIN;

-- ------------------------------------------------------------
-- 1. attendance_daily_summary — REDEFINED with event-date presence.
--    Only the present_agg date predicate changes:
--      a.in_date = p_date
--      ─▶  (a.in_date = p_date OR a.out_date = p_date)
--    Everything else (scope, grain, join, ordering) is v39 verbatim.
--    open_now needs no change: OPEN rows have NULL out_date by
--    definition, so `in_date = p_date` already covers them.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_daily_summary(uuid, date);
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
  agg AS (
    SELECT sd.centre, sd.eff AS department_id,
           count(DISTINCT sd.badge_number) AS expected
      FROM scoped_dep sd
     GROUP BY sd.centre, sd.eff
  ),
  -- HOME centre on the presence side. `a.centre` is the constant
  -- venue and must never appear here: joining it against agg.centre
  -- (the home centre) never matches, so present collapsed to 0 for
  -- every row. v_admin bypasses the centre predicate entirely so an
  -- ASO still sees sewadars whose home centre could not be resolved
  -- (sewadar_centre IS NULL).
  present_agg AS (
    SELECT a.sewadar_centre AS centre, a.sewadar_dept AS department_id,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status IN ('OPEN','CLOSED')) AS present,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status = 'OPEN')             AS open_now
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v45 EVENT-DATE LAW: an IN or an OUT on p_date counts. An
       -- overnight OUT (out_date > in_date) now buys presence on its
       -- own day; a silent day still counts nothing (no carry-over).
       AND (a.in_date = p_date OR a.out_date = p_date)
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
     GROUP BY a.sewadar_centre, a.sewadar_dept
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
     AND (p.department_id = agg.department_id
          OR (p.department_id IS NULL AND agg.department_id IS NULL))
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- 2. attendance_sewadar_summary — REDEFINED with event-date
--    days_present. `count(DISTINCT in_date)` under-counted any badge
--    with an overnight OUT (IN 5th, OUT 6th read as 1 day). Now the
--    DISTINCT runs over {in_date} ∪ {out_date}, so that badge reads 2.
--    Grain stays ONE ROW PER BADGE; every other column is v39 verbatim.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_sewadar_summary(uuid);
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- ONE ROW PER BADGE. This used to GROUP BY badge_number,
  -- sewadar_dept, d.name — but sewadar_dept is a SNAPSHOT TAKEN AT
  -- SCAN TIME, so a sewadar scanned before being deployed (NULL) and
  -- again afterwards yielded TWO rows with split days_present, each
  -- understating the 5-day total. Aggregating first and resolving the
  -- department to the most recent NON-NULL scan fixes the grain.
  RETURN QUERY
  WITH per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_name)   AS sewadar_name,
           max(a.sewadar_centre) AS sewadar_centre,
           (array_remove(
              array_agg(a.sewadar_dept ORDER BY a.in_date DESC, a.in_time DESC),
              NULL))[1]           AS department_id,
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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
     GROUP BY a.badge_number
  ),
  -- v45 EVENT-DATE LAW: days_present counts DISTINCT days on which the
  -- badge has ANY event — an IN day, an OUT day, or both. Same scope
  -- predicates as per_badge so the two agree on which rows count.
  event_days AS (
    SELECT a.badge_number, a.in_date AS d
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
    UNION
    SELECT a.badge_number, a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
  ),
  days AS (
    SELECT e.badge_number, count(DISTINCT e.d)::integer AS days_present
      FROM event_days e
     GROUP BY e.badge_number
  )
  SELECT b.badge_number,
         b.sewadar_name,
         b.sewadar_centre,
         b.department_id,
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
    LEFT JOIN public.deployment_departments d ON d.id = b.department_id
   ORDER BY b.sewadar_centre, b.sewadar_name, b.badge_number;
END;
$$;

-- ------------------------------------------------------------
-- 3. attendance_visit_summary — whole-visit counts per
--    centre × department for the Count Lists. ever_present = badge
--    has ≥1 session in the schedule (any event day); never_present =
--    deployed but zero sessions (the visit-level absent); open_now =
--    still has an OPEN session. Department attribution mirrors
--    sewadar_summary: most recent NON-NULL scan snapshot.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_visit_summary(p_schedule uuid)
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
  dep_agg AS (
    SELECT sd.centre, sd.eff AS department_id,
           count(DISTINCT sd.badge_number) AS deployed
      FROM scoped_dep sd
     GROUP BY sd.centre, sd.eff
  ),
  per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_centre) AS sc,
           (array_remove(
              array_agg(a.sewadar_dept ORDER BY a.in_date DESC, a.in_time DESC),
              NULL))[1]          AS dept,
           bool_or(a.status = 'OPEN') AS still_open
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
     GROUP BY a.badge_number
  ),
  pres_agg AS (
    SELECT b.sc AS centre, b.dept AS department_id,
           count(*) AS ever_present,
           count(*) FILTER (WHERE b.still_open) AS open_now
      FROM per_badge b
     GROUP BY b.sc, b.dept
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
     AND (p.department_id = agg.department_id
          OR (p.department_id IS NULL AND agg.department_id IS NULL))
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- 4. attendance_trend — one row per event-date in the schedule:
--    DISTINCT badges with an IN or an OUT that day (event-date law),
--    absent = deployed total − present. Powers the dashboard's 5-day
--    strip with ONE round trip instead of fanning out daily calls.
--    `deployed` is schedule-level (deployments carry no date), so the
--    strip reads "of everyone deployed, how many touched each day".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_trend(p_schedule uuid)
RETURNS TABLE(
  day     date,
  present bigint,
  absent  bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres  text[];
  v_depts    uuid[];
  v_role     text;
  v_admin    boolean;
  v_deployed bigint;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
    UNION
    SELECT DISTINCT a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
  )
  SELECT dy.d AS day,
         (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR s.sewadar_centre = ANY (v_centres))
             AND (v_depts IS NULL OR s.sewadar_dept = ANY (v_depts)))::bigint AS present,
         GREATEST(v_deployed - (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR s.sewadar_centre = ANY (v_centres))
             AND (v_depts IS NULL OR s.sewadar_dept = ANY (v_depts))), 0)::bigint AS absent
    FROM days dy
   ORDER BY dy.d;
END;
$$;

-- ------------------------------------------------------------
-- 5. attendance_scanner_open — drill-down for the Live Scanners
--    page: the still-OPEN sessions one scanner created. aso /
--    super_admin may pass any scanner badge; every other role may
--    only pass its OWN badge (attendance_caller_badge) and gets zero
--    rows otherwise. The scanners page itself is aso/super_admin-only,
--    so the second arm is belt-and-braces for direct RPC callers.
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
  v_role text;
BEGIN
  IF p_schedule IS NULL OR p_scanner_badge IS NULL THEN RETURN; END IF;

  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('aso','super_admin')
     AND p_scanner_badge IS DISTINCT FROM public.attendance_caller_badge() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.badge_number,
         a.sewadar_name,
         a.sewadar_centre,
         d.name AS dept_name,
         a.in_date,
         a.in_time
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND a.status = 'OPEN'
     AND (a.in_scanner_badge = p_scanner_badge OR a.out_scanner_badge = p_scanner_badge)
   ORDER BY a.in_date DESC, a.in_time DESC
   LIMIT 500;
END;
$$;

-- ------------------------------------------------------------
-- 6. attendance_anomalies — the five v1 rules. p_date NULL = whole
--    visit; p_date set = only rows touching that event-date (IN or
--    OUT on it). BAD_STATUS is about the CURRENT badge status, so its
--    rows carry event_date NULL unless p_date pins them to that day.
--
--    Rules:
--    UNDEPLOYED_SCAN — session written with undeployed_scan = true
--      (badge had NO deployments row at scan time).
--    BAD_STATUS — scanned badge whose dp_sewadars.badge_status is set
--      AND outside the eligible list (OPEN, PERMANENT). NULL stays
--      eligible (mirrors eligibleBadgeStatusFilter).
--    MULTI_SESSION — ≥3 sessions (≥3 INs) for one badge on one
--      in_date. Deliberately IN-based: each session IS one IN, so
--      "3 sessions" and "3 INs" are the same count.
--    STALE_OPEN — OPEN with in_date before TODAY (IST). A same-day
--      OPEN session is normal work in progress, not an anomaly.
--    VSS_DEPT_MISMATCH — a VSS badge (is_vss) whose scan-time dept
--      snapshot exists AND is not opened for VSS
--      (COALESCE(include_vss, false) = false). There is NO vss_only
--      marker in the schema, so the reverse leg (regular badge in a
--      VSS-only dept) is UNDEFINED and deliberately not implemented.
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));
  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;

  RETURN QUERY
  -- UNDEPLOYED_SCAN: scanned with no deployment row at scan time.
  SELECT 'UNDEPLOYED_SCAN'::text,
         a.badge_number, a.sewadar_name, a.sewadar_centre, d.name,
         ('Scanned ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
          || ' with no deployment for this schedule')::text,
         a.in_date
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND a.undeployed_scan = true
     AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
  UNION ALL
  -- BAD_STATUS: current badge status outside the eligible list.
  SELECT 'BAD_STATUS'::text,
         a.badge_number,
         max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
         ('Badge status ' || max(s.badge_status)
          || ' is not OPEN/PERMANENT — scanned '
          || count(*)::text || ' time(s) this visit')::text,
         CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
    FROM public.dp_attendance_sessions a
    JOIN public.dp_sewadars s ON s.badge_number = a.badge_number
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND s.badge_status IS NOT NULL
     AND s.badge_status NOT IN ('OPEN','PERMANENT')
     AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
   GROUP BY a.badge_number
  UNION ALL
  -- MULTI_SESSION: ≥3 INs for one badge on one in_date.
  SELECT 'MULTI_SESSION'::text,
         a.badge_number,
         max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
         (count(*)::text || ' sessions on ' || a.in_date::text)::text,
         a.in_date
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND (p_date IS NULL OR a.in_date = p_date)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
   GROUP BY a.badge_number, a.in_date
  HAVING count(*) >= 3
  UNION ALL
  -- STALE_OPEN: OPEN with in_date before today (IST).
  SELECT 'STALE_OPEN'::text,
         a.badge_number, a.sewadar_name, a.sewadar_centre, d.name,
         ('OPEN since ' || a.in_date::text || ' '
          || substring(a.in_time::text, 1, 5) || ' — likely a missed OUT')::text,
         a.in_date
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND a.status = 'OPEN'
     AND a.in_date < v_today
     AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
  UNION ALL
  -- VSS_DEPT_MISMATCH: VSS badge scanned into a dept not opened for VSS.
  SELECT 'VSS_DEPT_MISMATCH'::text,
         a.badge_number, a.sewadar_name, a.sewadar_centre, d.name,
         ('VSS badge scanned in "' || d.name
          || '", which is not opened for VSS')::text,
         a.in_date
    FROM public.dp_attendance_sessions a
    JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND a.is_vss = true
     AND COALESCE(d.include_vss, false) = false
     AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
   ORDER BY 1, 4 NULLS LAST, 2, 7 NULLS LAST
   LIMIT 1000;
END;
$$;

-- ------------------------------------------------------------
-- 7. attendance_day_badges — badge-level lists for ONE event-date.
--    p_mode = 'present': DISTINCT badges with an IN or an OUT on
--    p_date (event-date law), dept = most recent NON-NULL snapshot
--    THAT DAY. p_mode = 'absent': deployed badges (effective dept)
--    with NO event on p_date. Anything else returns zero rows.
--    Feeds the Present / Absent workbooks — one round trip per file.
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
BEGIN
  IF p_schedule IS NULL OR p_date IS NULL THEN RETURN; END IF;
  IF p_mode NOT IN ('present','absent') THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  IF p_mode = 'present' THEN
    RETURN QUERY
    WITH day_sess AS (
      SELECT a.badge_number, a.sewadar_name, a.sewadar_centre,
             a.sewadar_dept, a.is_vss, a.in_date, a.in_time
        FROM public.dp_attendance_sessions a
       WHERE a.schedule_id = p_schedule
         AND (a.in_date = p_date OR a.out_date = p_date)
         AND (v_admin OR a.sewadar_centre = ANY (v_centres))
         AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
    ),
    per_badge AS (
      SELECT s.badge_number,
             max(s.sewadar_name)   AS nm,
             max(s.sewadar_centre) AS sc,
             (array_remove(
                array_agg(s.sewadar_dept ORDER BY s.in_date DESC, s.in_time DESC),
                NULL))[1]          AS dept,
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

  -- absent: deployed (effective dept) minus badges with any event that day.
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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
  )
  SELECT sd.badge_number, sd.sewadar_name, sd.centre, sd.eff, d.name,
         (sd.badge_number ILIKE 'VS%') AS is_vss
    FROM scoped_dep sd
    LEFT JOIN public.deployment_departments d ON d.id = sd.eff
   WHERE NOT EXISTS (SELECT 1 FROM present p WHERE p.badge_number = sd.badge_number)
   ORDER BY sd.centre, sd.sewadar_name NULLS LAST, sd.badge_number;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying, as any role)
-- ============================================================
--
-- 1. The four new objects exist alongside the two redefined ones:
--
-- SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('attendance_visit_summary','attendance_trend',
--                      'attendance_scanner_open','attendance_anomalies');
--    -- Expect: 4 rows.
--
-- 2. THE overnight law (the whole point of v45). With a fixture
--    session IN 5th 22:00 / OUT 6th 06:00 for a deployed badge:
--
-- SELECT centre, dept_name, expected, present, absent
--   FROM attendance_daily_summary('<schedule>', '2026-08-05');
--    -- Expect: the badge present on the 5th.
-- SELECT centre, dept_name, expected, present, absent
--   FROM attendance_daily_summary('<schedule>', '2026-08-06');
--    -- Expect: the SAME badge present on the 6th (OUT event).
--    -- Before v45 the 6th read present = 0 for this badge.
--
-- 3. days_present counts event dates:
--
-- SELECT badge_number, days_present
--   FROM attendance_sewadar_summary('<schedule>')
--  WHERE badge_number = '<overnight badge>';
--    -- Expect: 2, not 1.
--
-- 4. Grain + sanity:
--
-- SELECT count(*), count(DISTINCT badge_number)
--   FROM attendance_sewadar_summary('<schedule>');
--    -- Expect: rows == badges (one row per badge).
-- SELECT day, present, absent FROM attendance_trend('<schedule>');
--    -- Expect: one row per event-date, present + absent == deployed
--    -- total on every row.
--
-- 5. Scope (the important one — log in as each role):
--
--    aso / super_admin → full counts; centre_user → own subtree only;
--    scanner / vss_operator / anon → zero rows everywhere, including
--    attendance_anomalies and attendance_scanner_open for OTHER
--    scanners' badges.
--
-- 6. Anomaly rules fire:
--
-- SELECT rule, count(*) FROM attendance_anomalies('<schedule>')
--  GROUP BY 1 ORDER BY 1;
--    -- Expect: only the five rule names above, each with sane counts.
--    -- A rule that fires on every row is a broken rule, not a dirty visit.
--
-- 7. Day lists reconcile with the daily counts:
--
-- SELECT (SELECT count(*) FROM attendance_day_badges('<s>','<d>','present'))
--      + (SELECT count(*) FROM attendance_day_badges('<s>','<d>','absent'))
--      AS listed,
--        (SELECT sum(expected) FROM attendance_daily_summary('<s>','<d>'))
--      AS deployed;
--    -- Expect: listed == deployed (every deployed badge is either
--    -- present or absent that day — the event-date law leaves no gap).
