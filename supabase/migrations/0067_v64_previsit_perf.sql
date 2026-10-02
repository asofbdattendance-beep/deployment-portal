-- ============================================================
-- V64: PREVISIT PERF + GROUPED REGISTER ROWS. Run AFTER v63.
--
-- Two changes, both read-only (no table, column, index write-path,
-- trigger, RLS policy or other function touched):
--
-- (1) PERF: v62's previsit_summary / previsit_sewadars called the
--     SECURITY DEFINER attendance_badge_dept() up to THREE times per
--     session row (SELECT + JOIN + WHERE), each firing two indexed
--     subqueries. On a schedule with ~10k sessions that is ~30k
--     function calls per page load. Both RPCs now resolve the
--     badge → department map ONCE in a badge_dept CTE (deployed
--     effective dept, else the latest non-NULL scan snapshot — the
--     v59 law) and join it. Scope gates and role gates are v62
--     verbatim, so the row SET is unchanged for previsit_summary.
--
-- (2) SHAPE: previsit_sewadars returns ONE ROW PER (in_date, badge)
--     instead of one row per session: in_time = FIRST in_time of the
--     day, out_time = LAST out_time of the day (latest closed OUT;
--     NULL when every session is still open), duration_min = SUM of
--     the day's closed-session minutes (NULL when any session is
--     still open, matching the old open-session NULL), plus two new
--     columns session_count and is_open. Name/centre come from the
--     day's LATEST session; VSS/manual/undeployed fold with bool_or.
--     This makes the Present count distinct sewadars per day and
--     cuts the payload ~2x. Column names are otherwise unchanged, so
--     only the previsit register (the sole caller) adapts.
--
-- DROP + CREATE (not CREATE OR REPLACE) for previsit_sewadars:
-- Postgres forbids changing a function's return type in place, and
-- the two new output columns change it. Grants are re-applied below.
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state,
-- every visit RPC, RLS policies, tables, columns, triggers, existing
-- data, previsit_deployed.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; DROP IF EXISTS +
-- CREATE OR REPLACE; CREATE INDEX IF NOT EXISTS; INSERT ...
-- ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

-- Backstop for the badge-level snapshot/aggregate reads below.
CREATE INDEX IF NOT EXISTS idx_dp_att_sched_badge_in
  ON public.dp_attendance_sessions (schedule_id, badge_number, in_date DESC, in_time DESC);

-- ------------------------------------------------------------
-- 1. previsit_summary — same signature, same row set, no per-row
--    function calls. Undeployed badges now attribute by the badge's
--    latest snapshot (v59 law) instead of the session's own snapshot;
--    deployed badges are byte-identical to v62.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.previsit_summary(p_schedule uuid)
RETURNS TABLE(
  event_date    date,
  centre        text,
  department_id uuid,
  dept_name     text,
  present       bigint,
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

  -- Previsit is dept_incharge / aso / super_admin only (v62, unchanged).
  IF NOT v_admin AND v_depts IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped_dep AS (
    -- The expectation set, same scope predicates as the visit side.
    SELECT d.badge_number, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    -- One badge, one centre (v59 (f) grain).
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  badge_snap AS (
    -- Latest non-NULL scan snapshot per badge (the v59 fallback),
    -- computed ONCE, not once per session row.
    SELECT DISTINCT ON (a.badge_number)
           a.badge_number, a.sewadar_dept AS snap
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.sewadar_dept IS NOT NULL
     ORDER BY a.badge_number, a.in_date DESC, a.in_time DESC
  ),
  badge_dept AS (
    -- One row per badge known anywhere: effective dept wins, snapshot
    -- covers undeployed badges. Badges in neither keep NULL (the
    -- LEFT JOIN below) and are handled exactly as v62 handled them.
    SELECT COALESCE(be.badge_number, bs.badge_number) AS badge_number,
           COALESCE(be.eff, bs.snap) AS dept
      FROM badge_eff be
      FULL JOIN badge_snap bs ON bs.badge_number = be.badge_number
  ),
  pre AS (
    SELECT a.in_date AS d,
           COALESCE(be.dc, a.sewadar_centre) AS centre,
           bd.dept AS department_id,
           a.badge_number,
           bool_or(a.status = 'OPEN') AS is_open
      FROM public.dp_attendance_sessions a
      LEFT JOIN badge_eff be ON be.badge_number = a.badge_number
      LEFT JOIN badge_dept bd ON bd.badge_number = a.badge_number
     WHERE a.schedule_id = p_schedule
       -- THE split: outside the window (NULL window ⇒ every date).
       AND NOT public.is_visit_date(p_schedule, a.in_date)
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR bd.dept = ANY (v_depts))
     GROUP BY a.in_date, 2, 3, a.badge_number
  )
  SELECT p.d, p.centre, p.department_id, dd.name,
         count(DISTINCT p.badge_number)::bigint AS present,
         count(DISTINCT p.badge_number) FILTER (WHERE p.is_open)::bigint AS open_now
    FROM pre p
    LEFT JOIN public.deployment_departments dd ON dd.id = p.department_id
   GROUP BY p.d, p.centre, p.department_id, dd.name
   ORDER BY p.d DESC, p.centre, dd.name;
END;
$$;

REVOKE ALL ON FUNCTION public.previsit_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.previsit_summary(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. previsit_sewadars — one row per (in_date, badge). See header.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.previsit_sewadars(uuid, date);

CREATE FUNCTION public.previsit_sewadars(
  p_schedule uuid,
  p_date     date DEFAULT NULL
)
RETURNS TABLE(
  event_date    date,
  badge_number  text,
  sewadar_name  text,
  sewadar_centre text,
  department_id uuid,
  dept_name     text,
  is_vss        boolean,
  in_time       time,
  out_time      time,
  duration_min  integer,
  is_manual     boolean,
  undeployed    boolean,
  session_count integer,
  is_open       boolean
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

  -- Same previsit-only role gate as previsit_summary above (v62).
  IF NOT v_admin AND v_depts IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.eff
  ),
  badge_snap AS (
    SELECT DISTINCT ON (a.badge_number)
           a.badge_number, a.sewadar_dept AS snap
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.sewadar_dept IS NOT NULL
     ORDER BY a.badge_number, a.in_date DESC, a.in_time DESC
  ),
  badge_dept AS (
    SELECT COALESCE(be.badge_number, bs.badge_number) AS badge_number,
           COALESCE(be.eff, bs.snap) AS dept
      FROM badge_eff be
      FULL JOIN badge_snap bs ON bs.badge_number = be.badge_number
  ),
  sess AS (
    SELECT a.in_date AS d,
           a.badge_number AS badge,
           -- Name/centre from the day's LATEST session.
           (array_agg(a.sewadar_name ORDER BY a.in_time DESC NULLS LAST))[1] AS nm,
           (array_agg(a.sewadar_centre ORDER BY a.in_time DESC NULLS LAST))[1] AS ctr,
           bool_or(a.is_vss) AS vss,
           min(a.in_time) AS first_in,
           -- Latest CLOSED out time; NULL when everything is still open.
           (array_agg(a.out_time ORDER BY (a.out_date IS NULL), a.out_date DESC NULLS LAST, a.out_time DESC NULLS LAST))[1] AS last_out,
           COALESCE(sum(CASE WHEN a.out_date IS NOT NULL AND a.out_time IS NOT NULL
                        THEN (EXTRACT(EPOCH FROM ((a.out_date + a.out_time) - (a.in_date + a.in_time))) / 60)::integer
                        ELSE 0 END), 0)::integer AS total_min,
           bool_or(a.is_manual) AS man,
           bool_or(a.undeployed_scan) AS und,
           count(*)::integer AS n,
           bool_or(a.status = 'OPEN') AS opn
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND (p_date IS NULL OR a.in_date = p_date)
       -- THE split: outside the window (NULL window ⇒ every date).
       AND NOT public.is_visit_date(p_schedule, a.in_date)
       AND (v_admin
            OR v_depts IS NOT NULL
            OR a.sewadar_centre = ANY (v_centres))
     GROUP BY a.in_date, a.badge_number
  )
  SELECT s.d,
         s.badge,
         s.nm,
         s.ctr,
         bd.dept AS department_id,
         dd.name AS dept_name,
         s.vss,
         s.first_in,
         s.last_out,
         CASE WHEN s.opn THEN NULL ELSE s.total_min END AS duration_min,
         s.man,
         s.und,
         s.n,
         s.opn
    FROM sess s
    LEFT JOIN badge_dept bd ON bd.badge_number = s.badge
    LEFT JOIN public.deployment_departments dd
      ON dd.id = bd.dept
   WHERE (v_depts IS NULL OR bd.dept = ANY (v_depts))
   ORDER BY s.d DESC, s.first_in DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.previsit_sewadars(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.previsit_sewadars(uuid, date) TO authenticated;

-- ------------------------------------------------------------
-- §3. Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v64')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- Pre-conditions: a windowed schedule with previsit sessions ('<sched>').
--
-- 1. Summary row set matches v62 (same scope, same present/open_now):
--   SELECT event_date, centre, dept_name, present, open_now
--     FROM public.previsit_summary('<sched>') ORDER BY 1 DESC;
-- 2. Register rows are one per badge per day, first-IN / last-OUT:
--   SELECT event_date, badge_number, in_time, out_time, duration_min,
--          session_count, is_open
--     FROM public.previsit_sewadars('<sched>')
--    ORDER BY event_date DESC, badge_number;
--   -- Expect: no (event_date, badge_number) twice; open rows carry
--   -- duration_min NULL with is_open true; session_count >= 1.
-- 3. Scope unchanged: same queries as dept_incharge return that
--    department's rows; as centre_user / vss_operator return zero rows.
-- 4. Grants + registry:
--   SELECT grantee FROM information_schema.role_table_grants
--    WHERE routine_name = 'previsit_sewadars'; -- authenticated only
--   SELECT version FROM public.portal_version WHERE version = 'v64';
--   -- Expect: one row.
