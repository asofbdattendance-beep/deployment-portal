-- ============================================================
-- V58: DEPT_INCHARGE SCOPE FIXES (T12-T14). Run AFTER v57.
--
-- T12 — CROSS-SCHEDULE LEAK IN is_my_incharge_dept_badge (§1-§2).
--   v53's 1-arg predicate answers "is this badge deployed to one of MY
--   departments" across EVERY schedule: its EXISTS has no schedule bound, so
--   a badge deployed to department X under schedule A satisfies the check
--   while the caller is reading schedule B. The new 2-arg overload
--   is_my_incharge_dept_badge(p_badge, p_schedule) scopes the EXISTS to
--   d.schedule_id = p_schedule and resolves the grant ONCE with
--   get_my_dept_ids(p_schedule). att_read's dept_incharge arm now calls the
--   2-arg form with the SESSION row's own schedule_id, so a session can never
--   be read through another schedule's grant. The 1-arg form is kept VERBATIM
--   for dp_sewadars / vss_sewadars (a sewadar row carries no schedule, so
--   per-schedule scoping is not expressible there). Same v53 grant pattern
--   (REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO authenticated) on the overload.
--   No new index: idx_deployments_badge_dept (badge_number, schedule_id, ...)
--   already serves the (badge = , schedule = ) equality probe.
--
-- T13 — ROLE-GATE THE CENTRE ARM; DEPT ARM REQUIRES NULL CENTRE (§3).
--   deploy_v2_read / sewadars_portal_read / vss_sewadars_read each carry a
--   bare `centre = ANY (get_my_subtree_centres())` arm with no role check. It
--   is harmless while every dept_incharge has NULL centre (NULL = ANY of
--   ARRAY[NULL] is NULL, and an RLS USING admits only TRUE), but a
--   dept_incharge row that wrongly CARRIES a centre (provisioning bug) would
--   read that whole centre subtree OUTSIDE its departments. The arm is now
--   gated to ('centre_user','centre_admin','scanner') — the only roles scoped
--   BY centre; aso/super_admin/vss_operator keep their all-centre first arm
--   unchanged. The dept_incharge arm additionally requires
--   public.get_portal_user_centre() IS NULL (exact helper from
--   portal_setup.sql, via v28/v40): a centre-bearing dept_incharge now reads
--   ZERO rows (fail closed) instead of the wrong rows, which surfaces the
--   provisioning bug instead of hiding it. Provisioning must null
--   portal_users.centre for dept_incharge on create/edit/invite (small client
--   diffs, returned with delivery — NOT in this file). consent_read is
--   untouched (it has no department arm to protect).
--
-- T14 — PRESENCE CENTRE PREDICATE RECONCILED WITH EXPECTATION (§4-§5).
--   v55 scopes presence by the ATTRIBUTING department but left the centre
--   gate on the scan-time snapshot: (v_admin OR a.sewadar_centre = ANY
--   (v_centres)). For a dept_incharge v_centres is EVERY centre
--   (attendance_scope_centres, v51), so that gate was a no-op for every
--   centre-bearing row and dropped ONLY the NULL-centre rows (NULL = ANY is
--   NULL, never TRUE) — which then vanished instead of bucketing through the
--   existing COALESCE(be.dc, a.sewadar_centre) to their deployment centre.
--   Every presence gate becomes
--     (v_admin OR v_depts IS NOT NULL OR <alias>.sewadar_centre = ANY (v_centres))
--   v_depts IS NOT NULL holds for exactly one caller: a dept_incharge holding
--   >=1 department (attendance_allowed_depts returns NULL for every other
--   role, and an empty grant early-returns before the query) — so every other
--   role's numbers are byte-for-byte unchanged.
--   Why the agg joins still reconcile: attendance_daily_summary and
--   attendance_visit_summary select FROM agg LEFT JOIN present_agg, so a
--   present group with no matching (centre, department) expectation is
--   dropped, never inflated; NULL-centre sessions of DEPLOYED badges carry
--   be.dc (their deployment centre, which IS in agg because v_centres is
--   every centre) through the untouched COALESCE, while NULL-centre sessions
--   of UNDEPLOYED badges form a NULL-centre group with no agg row and stay
--   dropped. attendance_day_badges absent mode subtracts visible-present
--   badges from scoped_dep (NOT EXISTS), so newly visible rows only move a
--   badge from absent to present. attendance_trend counts presence
--   INTERSECT scoped_dep with absent = deployed - present, so present can
--   never exceed deployed there. The per-badge lists (sewadar_summary,
--   day_badges present, scanner_open, scanner_ops, anomalies) have no agg
--   join to break.
--   Also in §4: attendance_badge_dept gains a centre tiebreaker
--   (ORDER BY ..., d.centre) — one badge can hold deployment rows under two
--   centre keys (same class v57 fixed for scan_in), so the lookup is now
--   deterministic; and attendance_anomalies' BAD_STATUS arm counts
--   DISTINCT a.id instead of count(*) (its dp_sewadars join fans out on
--   duplicate badge rows and inflated the "scanned N time(s)" text) with the
--   message shape unchanged. RPC bodies are otherwise VERBATIM v55.
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state
-- (v56/v57) are not redefined; no write policy; no table, column, trigger or
-- existing index changed and none added (existing indexes cover the new
-- predicates); consent_read, quota, restriction rules, locks, deadlines,
-- master switches, the v32 freeze and the scan ladder are untouched.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- DROP POLICY IF EXISTS for every policy).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- §1 (T12). The cheap predicate, restated VERBATIM from v53 so this
-- file is self-contained and re-runnable on its own.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_my_incharge_dept_badge(p_badge text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_badge IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.deployments d
     WHERE d.badge_number = p_badge
       AND COALESCE(d.deployed_department_id, d.department_id)
             = ANY (public.get_my_dept_ids(d.schedule_id))
  );
$$;

REVOKE ALL ON FUNCTION public.is_my_incharge_dept_badge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_my_incharge_dept_badge(text) TO authenticated;

-- ------------------------------------------------------------
-- §2 (T12). Per-schedule overload: the EXISTS is bound to p_schedule and
-- the grant resolves ONCE against that schedule (not per-row against
-- d.schedule_id), which is both the correctness fix and one fewer
-- SECURITY DEFINER call per candidate row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_my_incharge_dept_badge(p_badge text, p_schedule uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_badge IS NOT NULL AND p_schedule IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.deployments d
     WHERE d.badge_number = p_badge
       AND d.schedule_id = p_schedule
       AND COALESCE(d.deployed_department_id, d.department_id)
             = ANY (public.get_my_dept_ids(p_schedule))
  );
$$;

-- Stated rather than inherited, matching the v53 grant pattern: a per-row
-- predicate, not a data-returning API, callable by signed-in users only.
REVOKE ALL ON FUNCTION public.is_my_incharge_dept_badge(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_my_incharge_dept_badge(text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- §3 (T12+T13). att_read — v53 body with the dept_incharge arm on the
-- 2-arg predicate keyed by the SESSION row's own schedule_id. The first
-- three arms are byte-identical to v53 (the centre-visibility arm stays
-- role-gated inside attendance_sewadar_centre_visible, v40).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS att_read ON public.dp_attendance_sessions;
CREATE POLICY att_read ON public.dp_attendance_sessions
  FOR SELECT TO authenticated USING (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  OR (
       -- T12: per-schedule grant — a session is never read through another
       -- schedule's department grant (the 1-arg form cannot see schedule).
       public.get_portal_user_role() = 'dept_incharge'
   AND public.is_my_incharge_dept_badge(badge_number, schedule_id)
     )
  );

-- ------------------------------------------------------------
-- §4 (T13). The three list policies: centre arm role-gated, dept arm
-- NULL-centre-gated. First arms (aso/super_admin/vss_operator) unchanged.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deploy_v2_read ON public.deployments;
CREATE POLICY deploy_v2_read ON public.deployments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR (
         public.get_portal_user_role() IN ('centre_user', 'centre_admin', 'scanner')
         AND centre = ANY (public.get_my_subtree_centres())
       )
    OR (
         public.get_portal_user_role() = 'dept_incharge'
         -- NULL-centre requirement: provisioning nulls centre for this role,
         -- so a centre-bearing row fails closed (zero rows, loud) instead of
         -- reading that subtree's departments (wrong rows, silent).
         AND public.get_portal_user_centre() IS NULL
     AND COALESCE(deployed_department_id, department_id)
           = ANY (public.get_my_dept_ids(schedule_id))
    )
  );

DROP POLICY IF EXISTS sewadars_portal_read ON public.dp_sewadars;
CREATE POLICY sewadars_portal_read ON public.dp_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR (
         public.get_portal_user_role() IN ('centre_user', 'centre_admin', 'scanner')
         AND centre = ANY (public.get_my_subtree_centres())
       )
    OR (
         public.get_portal_user_role() = 'dept_incharge'
         AND public.get_portal_user_centre() IS NULL
     AND public.is_my_incharge_dept_badge(dp_sewadars.badge_number)
    )
  );

DROP POLICY IF EXISTS vss_sewadars_read ON public.vss_sewadars;
CREATE POLICY vss_sewadars_read ON public.vss_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR (
         public.get_portal_user_role() IN ('centre_user', 'centre_admin', 'scanner')
         AND centre = ANY (public.get_my_subtree_centres())
       )
    OR (
         public.get_portal_user_role() = 'dept_incharge'
         AND public.get_portal_user_centre() IS NULL
     AND public.is_my_incharge_dept_badge(vss_sewadars.badge_number)
    )
  );

-- ------------------------------------------------------------
-- §5 (T14). attendance_badge_dept — v55 body plus the centre tiebreaker.
-- Stated grants carried over verbatim from v55.
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
             -- v58: centre tiebreaker. One badge can hold deployment rows
             -- under more than one centre key (v57 §3 documents the same for
             -- scan_in), so (final, requested) alone could attribute the same
             -- badge differently per lookup. d.centre makes it deterministic.
             ORDER BY d.deployed_department_id NULLS LAST, d.department_id, d.centre
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

REVOKE ALL ON FUNCTION public.attendance_badge_dept(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_badge_dept(text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- §6 (T14). The eight RPCs below are v55 §§2-9 VERBATIM except:
--   (a) every presence centre gate gains `v_depts IS NOT NULL OR` (18
--       sites: 16 on alias `a`, 2 on alias `s` in attendance_trend), so a
--       dept_incharge gates presence by department attribution instead of
--       dropping NULL/unlisted sewadar_centre rows; and
--   (b) attendance_anomalies' BAD_STATUS arm counts DISTINCT a.id.
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
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT a.badge_number, a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
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
         AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
     AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
           || count(DISTINCT a.id)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.dp_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
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
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    UNION
    SELECT DISTINCT a.out_date
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.out_date IS NOT NULL
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
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep)), 0)::bigint AS absent
    FROM days dy
   ORDER BY dy.d;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor)
-- ============================================================
-- T12 — no cross-schedule read. As a dept_incharge holding department X
-- under schedule A (and NOT under schedule B), for a badge deployed to X
-- in A only:
--   SELECT public.is_my_incharge_dept_badge('<badge>', '<sched A>'); -- expect true
--   SELECT public.is_my_incharge_dept_badge('<badge>', '<sched B>'); -- expect false
--   SELECT count(*) FROM public.dp_attendance_sessions
--    WHERE schedule_id = '<sched B>'; -- expect 0: no session is readable
--   through another schedule's grant.
--
-- T13 — centre-bearing dept_incharge fails closed. On a TEST dept_incharge
-- login only, set portal_users.centre to a real centre, then as that login:
--   SELECT count(*) FROM public.deployments;  -- expect 0
--   SELECT count(*) FROM public.dp_sewadars;  -- expect 0
--   SELECT count(*) FROM public.vss_sewadars; -- expect 0
-- (Restore centre to NULL afterwards.) With centre NULL, the same login sees
-- ONLY its departments:
--   SELECT count(*) FROM public.deployments d
--    WHERE NOT (COALESCE(d.deployed_department_id, d.department_id)
--                 = ANY (public.get_my_dept_ids(d.schedule_id))); -- expect 0
-- As a centre_user with a centre, the subtree read still works (role-gated
-- arm preserved):
--   SELECT count(*) FROM public.deployments; -- expect their subtree rows
--
-- T14 — reconciliation, run BOTH as a dept_incharge AND as aso (both green):
--   -- daily: every row reconciles ...
--   SELECT bool_and((present + absent) = expected) AS reconciles
--     FROM public.attendance_daily_summary('<schedule>', '<date>');
--   -- ... and present stays within expected ...
--   SELECT bool_and(present <= expected) AS bounded
--     FROM public.attendance_daily_summary('<schedule>', '<date>');
--   -- visit: ever + never = deployed on every row ...
--   SELECT bool_and((ever_present + never_present) = deployed) AS reconciles
--     FROM public.attendance_visit_summary('<schedule>');
--   -- trend (v47 law): present + absent = deployed badges each day:
--   WITH t AS (SELECT * FROM public.attendance_trend('<schedule>'))
--   SELECT bool_and((t.present + t.absent) = (SELECT count(DISTINCT badge_number)
--            FROM public.deployments WHERE schedule_id = '<schedule>')) AS reconciles FROM t;
-- KNOWN EXCEPTION (pre-existing v49/v55 behaviour, not a v58 regression): an
-- UNDEPLOYED scan whose snapshot falls in scope counts as present without
-- adding to expected, so on days with such scans present may exceed expected
-- in attendance_daily_summary / attendance_visit_summary. Do not read that
-- as a v58 regression; attendance_trend (scoped_dep intersection) is the
-- strict law and must stay exact.
-- BLAST RADIUS: as aso/super_admin the four queries above must be
-- byte-identical before/after v58 (v_depts IS NULL there, so the new OR arm
-- is FALSE and each predicate is unchanged).
-- ============================================================
