-- ============================================================
-- V55: PRESENCE IS SCOPED BY THE SAME DEPARTMENT IT IS
--      ATTRIBUTED TO. Run AFTER v53 (and v54).
--
-- THE BUG (why the incharge's numbers read permanently low)
--
--   v49 fixed ATTRIBUTION — a session's presence is counted toward
--   COALESCE(deployed_department_id, department_id), the badge's
--   EFFECTIVE department, falling back to the scan-time snapshot only
--   for undeployed badges. But it left the SCOPE GATE on the snapshot:
--
--       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
--
--   Expectation is scoped by the EFFECTIVE department (scoped_dep),
--   presence by the SNAPSHOT. So for the one role with a non-NULL
--   v_depts — a dept_incharge — a badge deployed into their department
--   whose last scan predates that deployment has sewadar_dept NULL or a
--   foreign id. It is counted in `expected` and can never be counted in
--   `present`. "Present today" reads low forever, with no error and no
--   empty state to explain it.
--
--   The same gate survived in six more places: attendance_sewadar_summary
--   (last defined by v45, which v49 never redefined), attendance_trend
--   (v47), and v49's own attendance_scanner_ops, attendance_anomalies,
--   attendance_day_badges and attendance_scanner_open.
--
-- THE FIX
--
--   One helper answers "which department does this badge's presence count
--   toward" — the effective deployment department, falling back to the most
--   recent NON-NULL scan snapshot. Every scope gate now uses that one
--   expression, so a row counted as EXPECTED under department X is always
--   countable as PRESENT under X. expected/present/absent reconcile by
--   construction instead of by coincidence.
--
--   BLAST RADIUS: none beyond dept_incharge. aso/super_admin and every
--   centre role have v_depts IS NULL (attendance_allowed_depts, v39), so
--   their arm of the predicate is TRUE and their numbers are byte-for-byte
--   what they were. Only a dept_incharge's rows change.
--
-- WHY A FUNCTION AND NOT A CTE
--
--   Six of the eight functions have no badge_eff CTE, and the two that do
--   build it from scoped_dep (already dept-filtered), which is a different
--   question from "what department does this badge belong to". One SECURITY
--   DEFINER predicate gives all eight the same answer, costs one indexed
--   lookup per row, and — because it runs as its owner — bypasses
--   deployments RLS, so it adds none of the nested-policy cost that v52/v53
--   spent their budget removing.
--
-- Non-destructive; safe to re-run (CREATE OR REPLACE only — no table,
-- column, index, trigger or RLS policy touched). Verification at the bottom.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The one expression every scope gate now uses.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_badge_dept(p_badge text, p_schedule uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
           -- The deployment this badge's presence counts toward: the
           -- EFFECTIVE department, exactly as v49 attributes it.
           (SELECT COALESCE(d.deployed_department_id, d.department_id)
              FROM public.deployments d
             WHERE d.badge_number = p_badge
               AND d.schedule_id = p_schedule
               AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
             ORDER BY d.deployed_department_id NULLS LAST, d.department_id
             LIMIT 1),
           -- Undeployed badge: the most recent NON-NULL scan snapshot, the
           -- same fallback v49's COALESCE(be.eff, a.sewadar_dept) applies.
           (SELECT a.sewadar_dept
              FROM public.dp_attendance_sessions a
             WHERE a.badge_number = p_badge
               AND a.schedule_id = p_schedule
               AND a.sewadar_dept IS NOT NULL
             ORDER BY a.in_date DESC, a.in_time DESC
             LIMIT 1)
         );
$$;

-- Stated rather than inherited, matching the v53 grant pattern. It answers
-- a department id about an arbitrary badge, but only ever to a caller who
-- has already passed the v39 scope gates inside these RPCs.
REVOKE ALL ON FUNCTION public.attendance_badge_dept(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_badge_dept(text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. attendance_daily_summary — the KPI tiles.
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
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  agg AS (
    SELECT sd.centre, sd.eff AS department_id,
           count(DISTINCT sd.badge_number) AS expected
      FROM scoped_dep sd
     GROUP BY sd.centre, sd.eff
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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       -- v55: scope by the ATTRIBUTING department, not the scan snapshot, so
       -- a row counted as expected under X is countable as present under X.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
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
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
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
-- 4. attendance_sewadar_summary — the Sewadars tab. This is the one v49
--    never redefined, so it still resolved department_id from the scan
--    snapshot: the Daily tab and the Sewadars tab on the SAME page
--    disagreed about which department a badge belongs to.
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT a.badge_number, a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
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
         -- v55: the attributing department.
         AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
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
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
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
BEGIN
  IF p_schedule IS NULL OR p_scanner_badge IS NULL THEN RETURN; END IF;

  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('aso','super_admin')
     AND p_scanner_badge IS DISTINCT FROM public.attendance_caller_badge() THEN
    RETURN;
  END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_admin := (v_role IN ('aso','super_admin'));

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
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     -- v55: the attributing department.
     AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
   ORDER BY a.in_date DESC, a.in_time DESC
   LIMIT 500;
END;
$$;

-- ------------------------------------------------------------
-- 7. attendance_scanner_ops — the Scanner Ops tab.
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
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
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
  (SELECT 'UNDEPLOYED_SCAN'::text,
          a.badge_number, a.sewadar_name, a.sewadar_centre, d.name,
          ('Scanned ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
           || ' with no deployment for this schedule')::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.undeployed_scan = true
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    LIMIT 200)
  UNION ALL
  -- BAD_STATUS: current badge status outside the eligible list.
  (SELECT 'BAD_STATUS'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Badge status ' || max(s.badge_status)
           || ' is not OPEN/PERMANENT — scanned '
           || count(*)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.dp_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number
    LIMIT 200)
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
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
   HAVING count(*) >= 3
    LIMIT 200)
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
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date, a.in_time
    LIMIT 200)
  UNION ALL
  -- VSS_DEPT_MISMATCH: a VSS badge scanned outside a VSS department.
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
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
   HAVING bool_or(d.name IS NULL OR d.name NOT ILIKE 'VSS%')
    LIMIT 200)
  ORDER BY 1, 2
  LIMIT 1000;
END;
$$;

-- ------------------------------------------------------------
-- 9. attendance_trend — the dashboard trend strip.
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
       -- v55: the attributing department.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT DISTINCT a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
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
             AND (v_admin OR s.sewadar_centre = ANY (v_centres))
             -- v55: the attributing department.
             AND (v_depts IS NULL OR public.attendance_badge_dept(s.badge_number, p_schedule) = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep))::bigint AS present,
         GREATEST(v_deployed - (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR s.sewadar_centre = ANY (v_centres))
             -- v55: the attributing department.
             AND (v_depts IS NULL OR public.attendance_badge_dept(s.badge_number, p_schedule) = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep)), 0)::bigint AS absent
    FROM days dy
   ORDER BY dy.d;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying, AS a dept_incharge)
-- ============================================================
--
-- 1. The helper, for a badge you hold deployed and one you do not:
--      SELECT public.attendance_badge_dept('<your badge>', '<schedule>');
--      SELECT public.attendance_badge_dept('<other badge>', '<schedule>');
--    -- Expect: your department id, then either their department or NULL.
--
-- 2. THE MEMBERSHIP FLIP — the whole point of v55. Fixture: B1 is deployed
--    to MEDICAL (the incharge's department) and its only session carries a
--    NULL snapshot dept, because it was scanned before the deployment was
--    written. B3 is deployed to TRAFFIC and snapshotted to MEDICAL. Before
--    v55 the incharge saw B3 as PRESENT and B1 as ABSENT — the exact
--    opposite of the truth. After v55 it is the other way round:
--      SELECT badge_number, dept_name FROM attendance_sewadar_summary('<schedule>');
--      SELECT badge_number FROM attendance_day_badges('<s>','<d>','present');
--      SELECT badge_number FROM attendance_day_badges('<s>','<d>','absent');
--    -- Expect: B1 present, B3 gone. Run the same three queries before
--    -- applying v55 and diff — the membership flip IS the fix.
--
--    NOTE on reconciliation: present + absent = expected holds only when
--    every in-scope badge is deployed. An UNDEPLOYED scan whose snapshot
--    falls in scope counts as present without adding to expected (pre-existing
--    v49 behaviour, unchanged here — v47 applied this law to trend only).
--    So do not read present > expected as a v55 regression.
--
-- 3. The same law at visit grain:
--      SELECT centre, dept_name, deployed, ever_present, never_present,
--             (ever_present + never_present) = deployed AS reconciles
--        FROM attendance_visit_summary('<schedule>');
--    -- Expect: reconciles = true on every row.
--
-- 4. The Sewadars tab now agrees with the Daily tab — a badge deployed to
--    X but last scanned while attributed to Y must show department X in
--    BOTH, and must appear when the operator filters by X:
--      SELECT badge_number, dept_name FROM attendance_sewadar_summary('<schedule>');
--    -- Compare against attendance_daily_summary's dept_name for the same
--    -- badge. Before v55 these disagreed.
--
-- 5. BLAST RADIUS — as aso/super_admin the numbers must be UNCHANGED from
--    v49. Snapshot the three queries above before applying v55 and diff
--    them after. v_depts IS NULL for every role except dept_incharge, so
--    their arm of the predicate is TRUE and cannot move.
--
-- 6. Trend still reconciles (v47 law, unaffected by v55):
--      WITH t AS (SELECT * FROM attendance_trend('<schedule>'))
--      SELECT bool_and((t.present + t.absent) = (SELECT count(DISTINCT badge_number)
--               FROM deployments WHERE schedule_id = '<schedule>')) FROM t;
--    -- Expect: true.
-- ============================================================
