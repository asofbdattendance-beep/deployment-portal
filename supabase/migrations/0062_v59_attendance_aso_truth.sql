-- ============================================================
-- V59: ASO-FACING ATTENDANCE RPC TRUTH FIXES. Run AFTER v58.
--
-- Baseline: every function body below is copied from
-- sql/v58_dept_incharge_scope_fixes.sql VERBATIM except the listed diffs.
-- §§1-5 (predicates, att_read, the three list policies,
-- attendance_badge_dept) are byte-identical to v58, grants included.
--
-- (a) daily present bounded by deployed [v58:307-321]: present_agg gains
--   `AND EXISTS (... scoped_dep ...)` — an undeployed scan can no longer
--   inflate present past expected, so present <= expected per cell and
--   absent reconciles without the GREATEST floor doing work. The v55
--   attributing-department gate is kept. Closes the v58 KNOWN EXCEPTION
--   for attendance_daily_summary.
-- (b) open_now is DATE-SCOPED, product decision [v58:307-321,391-404,
--   748-750]: daily/scanner_ops keep the (in_date = p_date OR out_date =
--   p_date) window on open_now (it falls out of the WHERE clause; stated in
--   a comment, no predicate change). attendance_visit_summary gains an
--   optional `p_date date DEFAULT <today IST>` used ONLY for
--   still_open/open_now — deployed/ever_present/never_present stay
--   visit-wide. CONSEQUENCE: a session opened day 1 and never closed counts
--   in Open now only on day 1 (and in the visit view only with p_date NULL,
--   which disables the window); the Anomalies STALE_OPEN whole-visit sweep
--   (p_date NULL) is the safety net that still lists it. Signature change
--   => DROP FUNCTION IF EXISTS + CREATE (CREATE OR REPLACE cannot add a
--   parameter); one-arg callers unaffected (DEFAULT).
-- (c) VSS_DEPT_MISMATCH on the effective department [v58:884-901]: the
--   name-prefix HAVING (d.name ILIKE 'VSS%') is replaced with the v45
--   predicate `AND COALESCE(d.include_vss, false) = false`
--   (sql/v45_attendance_reports.sql:590). Column verified present at
--   sql/v4_vss.sql:55 (boolean NOT NULL DEFAULT false). NULL department
--   reads as NOT VSS-open (fail closed).
-- (d) STALE_OPEN gains the standard date predicate [v58:866-882]:
--   `AND (p_date IS NULL OR a.in_date = p_date)`.
-- (e) day_badges present restricted to deployed badges [v58:575-601]:
--   a scoped_dep CTE (same scope predicates as absent mode) + EXISTS, so
--   present + absent == deployed exactly.
-- (f) multi-centre badge dedupe [v58:301-306,385-390]: agg/dep_agg built
--   FROM badge_eff (one row per badge; ORDER BY badge,centre,eff already
--   deterministic) instead of raw scoped_dep, so expected and present
--   share the same one-centre-per-badge grain; count(*), not DISTINCT,
--   since badge_eff is unique per badge.
-- (g) anomalies ordering + caps [v58:902-903 + each `LIMIT 200`]: ORDER BY
--   severity (STALE_OPEN, UNDEPLOYED_SCAN, VSS_DEPT_MISMATCH, MULTI_SESSION,
--   BAD_STATUS) then event_date DESC, instead of rule name (which listed
--   BAD_STATUS first alphabetically). Per-arm 200→500 and total 1000→2000,
--   with ORDER BY in_date DESC inside each arm so truncation keeps the
--   newest rows. Exact per-rule counts would need a second result set —
--   impossible in one TABLE function without a signature change — so the
--   signature is untouched (pure CREATE OR REPLACE) and the cap behaviour
--   is documented at the ORDER BY instead.
-- (h) scanner_open gate NULL-safe [v58:671-675]:
--   `IF v_role IS NULL OR (v_role NOT IN (...) AND ...)` — the bare NOT IN
--   admitted callers with NO portal role (NULL NOT IN is NULL, never TRUE).
-- (i) BAD_STATUS covers VSS badges [v58:829-847]: UNION arm against
--   public.vss_sewadars, same shape (badge_number/sewadar_name/centre/
--   badge_status all present — sql/v4_vss.sql:18-37).
-- (j) version registry: INSERT ('v51')..('v59') ON CONFLICT DO NOTHING
--   (v51–v58 never registered; convention from sql/v50_portal_version.sql).
--
-- Grants: v58 posture copied exactly — REVOKE/GRANT only on the three
-- helper predicates; no new grants on any redefined RPC.
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state,
-- attendance_sewadar_summary, attendance_scanner_ops, attendance_trend
-- (byte-identical to v58); no write policy; no table, column, trigger,
-- index or existing-data change.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- DROP ... IF EXISTS; INSERT ... ON CONFLICT DO NOTHING).
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
--    v59 (b): new optional p_date, used ONLY for the still_open/open_now
--    computation (date-scoped Open now, product decision). deployed,
--    ever_present and never_present stay visit-wide. A signature change
--    cannot be CREATE OR REPLACE (Postgres would keep the old 1-arg form
--    as a second overload), so the v58 form is DROPped first — IF EXISTS,
--    no data touched, re-runs safe. One-arg callers are unaffected
--    (p_date has a DEFAULT).
--    v59 (f): dep_agg built FROM badge_eff (one-badge-one-centre grain,
--    see the daily agg).
-- ------------------------------------------------------------
-- Signature change: DROP the v58 1-arg form first (see above).
DROP FUNCTION IF EXISTS public.attendance_visit_summary(uuid);
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
  -- REPLACE) and the cap behaviour is stated here instead: each arm
  -- contributes its NEWEST 500 rows (ORDER BY inside the arm); the outer
  -- query keeps 2000. A simultaneous flood in 4+ arms can still evict the
  -- lowest-severity rule — narrow with p_date in that case.
  ORDER BY CASE rule
             WHEN 'STALE_OPEN' THEN 0
             WHEN 'UNDEPLOYED_SCAN' THEN 1
             WHEN 'VSS_DEPT_MISMATCH' THEN 2
             WHEN 'MULTI_SESSION' THEN 3
             WHEN 'BAD_STATUS' THEN 4
             ELSE 5 END,
           event_date DESC NULLS LAST
  LIMIT 2000;
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

-- ------------------------------------------------------------
-- §10 (v59 j). Version registry: v51–v58 never registered (the registry
-- itself was created in v50, whose convention — INSERT ... ON CONFLICT
-- DO NOTHING, one row per migration — is followed here). Backfills
-- v51..v58 and registers v59.
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES
  ('v51'),
  ('v52'),
  ('v53'),
  ('v54'),
  ('v55'),
  ('v56'),
  ('v57'),
  ('v58'),
  ('v59')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- 1. Daily reconciles on EVERY row (the v58 KNOWN EXCEPTION is closed
--    by diff (a) — undeployed scans no longer inflate present):
--   SELECT bool_and((present + absent) = expected) AS reconciles,
--          bool_and(present <= expected)             AS bounded
--     FROM public.attendance_daily_summary('<schedule>', '<date>');
--   -- Expect: true, true — i.e. no rate > 100 is possible:
--   SELECT bool_and(present::float / NULLIF(expected, 0) <= 1.0) AS no_rate_over_100
--     FROM public.attendance_daily_summary('<schedule>', '<date>');
--   -- Expect: true.
-- 2. Present + absent == deployed in the workbooks (diff (e)):
--   WITH p AS (SELECT badge_number FROM public.attendance_day_badges('<sched>','<date>','present')),
--        q AS (SELECT badge_number FROM public.attendance_day_badges('<sched>','<date>','absent')),
--        d AS (SELECT DISTINCT badge_number FROM public.deployments WHERE schedule_id = '<sched>')
--   SELECT (SELECT count(*) FROM p) + (SELECT count(*) FROM q)
--          = (SELECT count(*) FROM d) AS reconciles;
--   -- Expect: true.
-- 3. open_now is date-scoped (product decision, diff (b)): open a session
--    on day 1, leave it OPEN, then —
--   SELECT open_now FROM public.attendance_daily_summary('<sched>', '<day1>');
--   -- Expect: counts the session.
--   SELECT open_now FROM public.attendance_daily_summary('<sched>', '<day2>');
--   -- Expect: does NOT count it.
--   SELECT open_now FROM public.attendance_visit_summary('<sched>', NULL);
--   -- Expect: whole-visit sweep still counts it (NULL disables the window).
--   SELECT deployed FROM public.attendance_visit_summary('<sched>');
--   -- Expect: one-arg call still works (p_date defaults to today IST).
-- 4. STALE_OPEN respects p_date (diff (d)):
--   SELECT count(*) FROM public.attendance_anomalies('<sched>', '<date>') WHERE rule = 'STALE_OPEN';
--   -- Expect: only rows with event_date = '<date>'.
--   SELECT count(*) FROM public.attendance_anomalies('<sched>') WHERE rule = 'STALE_OPEN';
--   -- Expect: the whole-visit sweep (every stale open).
-- 5. Severity-then-date ordering + caps (diff (g)):
--   SELECT rule, count(*) FROM public.attendance_anomalies('<sched>') GROUP BY 1 ORDER BY 1;
--   -- Expect: STALE_OPEN rows sort before UNDEPLOYED_SCAN before
--   -- VSS_DEPT_MISMATCH before MULTI_SESSION before BAD_STATUS; no rule
--   -- exceeds 500 rows; total <= 2000.
-- 6. VSS_DEPT_MISMATCH on include_vss, not the name prefix (diff (c)):
--   -- a VSS badge scanned in a department with include_vss = true appears
--   -- NOWHERE; in one with include_vss = false it IS listed.
-- 7. BAD_STATUS covers the VSS roster (diff (i)):
--   SELECT * FROM public.attendance_anomalies('<sched>')
--    WHERE rule = 'BAD_STATUS' AND badge_number ILIKE 'VS%';
--   -- Expect: VSS badges with non-OPEN/PERMANENT status listed.
-- 8. Registry (diff (j)):
--   SELECT public.portal_app_version(); -- Expect: 'v59'.
-- 9. Blast radius (aso/super_admin): attendance_sewadar_summary,
--    attendance_scanner_ops and attendance_trend are byte-identical to
--    v58 — rerun the v58 T14 queries; unchanged.
-- ============================================================
