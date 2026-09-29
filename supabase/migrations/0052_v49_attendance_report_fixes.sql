-- ============================================================
-- V49: attendance report correctness fixes (L-10/11/31/49/50/52/53/55)
-- ============================================================
--
-- WHY (each fix states its ledger ID — read before touching anything):
--
--   Presence must be attributed the way expectation is: by EFFECTIVE
--   department (COALESCE(deployed, requested)) and HOME centre
--   (deployments.centre). v45 attributed presence by scan-time snapshot
--   dept + session centre while expectation used effective + home, so a
--   sewadar deployed to X but scanned only in Y counted ever-present
--   NOWHERE (its Y-presence row found no Y-expectation to join) and
--   never-present in X. L-49/L-50. The fix joins every presence row to
--   its deployment (badge_eff CTE, one row per badge) and falls back to
--   the snapshot only for undeployed badges. The `OR (... IS NULL ...
--   IS NULL)` join arm both functions carried is removed with it: the
--   expectation side is never NULL (scoped_dep filters it), so the arm
--   could never fire.
--
--   L-10: attendance_day_badges' absent-mode present-subtraction ignored
--   the dept gate (every sibling CTE has it), so a badge visible only
--   through an out-of-scope scan still subtracted from absent.
--   L-11: the same function's absent is_vss came from a badge-prefix
--   heuristic (ILIKE 'VS%') while present used the session flag —
--   one badge, two types. Absent now uses the session flag first and
--   the VSS roster (person truth for never-scanned badges) second.
--   L-31: attendance_scanner_open had role/badge gating but no
--   centre/dept scope — a centre role saw every centre's open sessions.
--   L-52/L-53: attendance_scanner_ops (untouched since v39) matched by
--   in_date only — an OUT on N+1 never appeared on N+1, and last_scan
--   mixed dates. INs now count on their IN day, OUTs on their OUT day.
--   L-55: anomalies' global LIMIT 1000 ORDER BY rule let BAD_STATUS
--   (alphabetically first) fill every slot. Each rule now caps at 200
--   rows; the 1000 ceiling stays as a backstop.
--
-- SCOPE / ROLES: unchanged — every redefinition reuses the v39 gates
--   verbatim (attendance_scope_centres + attendance_allowed_depts,
--   SECURITY DEFINER, early RETURN on NULL schedule or empty scope).
--
-- Run AFTER v45. Non-destructive; safe to re-run (CREATE OR REPLACE
-- only — no table/column/index/trigger/RLS touched, except the
-- portal_version table read in C6 which lives in v50, not here).
-- ------------------------------------------------------------

BEGIN;

-- ------------------------------------------------------------
-- 1. attendance_daily_summary — presence attributed by effective
--    dept + home centre (L-49/L-50). Scope predicates (incl. the
--    v_depts gate this function already had) are unchanged.
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
  -- One row per badge: the deployment this badge's presence counts toward.
  -- DISTINCT ON (not max(): Postgres has no max(uuid)) with a full ORDER BY
  -- is deterministic; a badge deployed in two centres (pathological — the
  -- app writes one home centre) attributes to one of them, never both, and
  -- never fans out into double presence.
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
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
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
-- 2. attendance_visit_summary — same attribution fix (L-49/L-50):
--    ever_present joins by (home centre, effective dept), falling back
--    to the scan snapshot only for undeployed badges.
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
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
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
-- 3. attendance_day_badges, absent mode — the present-subtraction
--    honours the dept gate (L-10), and absent is_vss uses the session
--    flag with the VSS roster as fallback (L-11). Present mode is
--    untouched (it already had the gate and the flag).
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

  -- absent: deployed (effective dept) minus badges with any VISIBLE event
  -- that day. The present CTE carries the same scope predicates as every
  -- sibling (L-10): without the dept gate, a badge seen only through an
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
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
  ),
  -- Person truth for the VSS flag (L-11): the session flag where sessions
  -- exist (same source as present mode), the VSS roster where they don't.
  -- The old badge-prefix heuristic (ILIKE 'VS%') agreed with neither and
  -- mis-typed any badge whose prefix and person disagreed. Unscoped on
  -- purpose: this is a person attribute, not a visibility decision — the
  -- row's visibility is already gated by scoped_dep.
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
-- 4. attendance_scanner_open — centre/dept scope (L-31). The role +
--    own-badge gate stays exactly as it was; scope predicates make the
--    non-admin arm meaningful instead of leaking every centre.
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
    LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
   WHERE a.schedule_id = p_schedule
     AND a.status = 'OPEN'
     AND (a.in_scanner_badge = p_scanner_badge OR a.out_scanner_badge = p_scanner_badge)
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
   ORDER BY a.in_date DESC, a.in_time DESC
   LIMIT 500;
END;
$$;

-- ------------------------------------------------------------
-- 5. attendance_scanner_ops — event-date day set + IN/OUT-day
--    attribution (L-52/L-53). Untouched since v39, which matched by
--    in_date only: an OUT on N+1 never appeared on N+1, and
--    last_scan_time mixed dates. INs count on their IN day, OUTs on
--    their OUT day; a session spanning midnight counts once per day
--    it touches, on the correct side each time. open_now counts OPEN
--    sessions in the day set (an OPEN from yesterday is not today's
--    ops — same silent-day law as v45). first_in_time is NULL on an
--    all-OUT day (the client renders '—').
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
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
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
-- 6. attendance_anomalies — per-rule caps (L-55). The global LIMIT
--    1000 ORDER BY rule let BAD_STATUS (alphabetically first) fill
--    every slot and silently drop the other four rules. Each rule
--    now caps at 200 rows; the 1000 ceiling stays as a backstop.
--    Rule bodies, scope gates and ordering are v45 verbatim.
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
     LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
    WHERE a.schedule_id = p_schedule
      AND a.undeployed_scan = true
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
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
     LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
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
     LEFT JOIN public.deployment_departments d ON d.id = a.sewadar_dept
    WHERE a.schedule_id = p_schedule
      AND (p_date IS NULL OR a.in_date = p_date)
      AND (v_admin OR a.sewadar_centre = ANY (v_centres))
      AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
   HAVING count(*) >= 3
    LIMIT 200)
  UNION ALL
  -- STALE_OPEN: OPEN with in_date before today (IST).
  (SELECT 'STALE_OPEN'::text,
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
    LIMIT 200)
  UNION ALL
  -- VSS_DEPT_MISMATCH: VSS badge scanned into a dept not opened for VSS.
  (SELECT 'VSS_DEPT_MISMATCH'::text,
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
    LIMIT 200)
  ORDER BY 1, 4 NULLS LAST, 2, 7 NULLS LAST
  LIMIT 1000;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying, as any role)
-- ============================================================
--
-- 1. Objects: the six functions above report the v49 body. Spot-check
--    one (the others share the gates verbatim with v45):
--
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname IN ('attendance_daily_summary',
--   'attendance_visit_summary','attendance_day_badges','attendance_scanner_open',
--   'attendance_scanner_ops','attendance_anomalies');
--    -- Expect: 6 rows.
--
-- 2. L-49/L-50 (aso): a badge deployed to X but scanned only in Y counts
--    ever-present in X, never in Y; deployment-centre attribution holds.
--
-- SELECT centre, dept_name, deployed, ever_present, never_present
--   FROM attendance_visit_summary('<schedule>')
--  WHERE centre = 'DELHI' AND dept_name IN ('MEDICAL','TRAFFIC');
--    -- Expect: MEDICAL ever_present INCLUDES the Y-scanned badge;
--    -- TRAFFIC ever_present 0, never_present counts the badge-less dept.
--
-- 3. L-10 (dept-scoped role): absent no longer subtracts badges seen
--    only through out-of-scope scans.
--
-- SET ROLE <dept_incharge>; -- or log in as one
-- SELECT centre, dept_name, expected, present, absent
--   FROM attendance_day_badges('<schedule>','<date>','absent');
--    -- Expect: a badge deployed in-scope with events only out-of-scope
--    -- IS listed absent.
--
-- 4. L-11: absent is_vss matches the session flag; never-scanned roster
--    badges read from the roster, never from the prefix.
--
-- SELECT badge_number, is_vss FROM attendance_day_badges('<s>','<d>','absent')
--  WHERE badge_number IN ('<rostered-unscanned>','<unrostered-unscanned>');
--    -- Expect: true, false.
--
-- 5. L-52/L-53 (aso): the OUT-day carries the OUT.
--
-- SELECT scanner_badge, scans_in, scans_out, first_in_time, last_scan_time
--   FROM attendance_scanner_ops('<schedule>','<out-day>');
--    -- Expect: scans_in 0, scans_out 1, first_in_time NULL,
--    -- last_scan_time = the OUT time. The IN-day row is unchanged.
--
-- 6. L-31: a centre role calling attendance_scanner_open with its own
--    badge sees its subtree only; aso sees all centres.
--
-- 7. L-55: every rule survives a 1000-row BAD_STATUS flood (200 cap
--    each, 1000 ceiling intact).
--
-- SELECT rule, count(*) FROM attendance_anomalies('<schedule>')
--  GROUP BY 1 ORDER BY 1;
--    -- Expect: all five rules present even when one rule alone
--    -- exceeds the old global cap.
--
-- 8. Scope regression (the important one — log in as each role):
--    aso / super_admin → full counts; centre roles → own subtree only;
--    scanner / vss_operator / anon → zero rows everywhere.
--
-- 9. v45 laws still hold: overnight OUT buys presence on its own day
--    (daily_summary both days), days_present counts event dates, one
--    row per badge in sewadar_summary, listed == deployed in #7 of v45.
