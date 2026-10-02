-- ============================================================
-- V62: PREVISIT SEWA READ RPCS. Run AFTER v61 (needs is_visit_date
-- from v60; complements the v61 visit-side restriction).
--
-- Rule (product decision, locked in planning): a session dated OUTSIDE
-- the schedule's visit window is a Previsit sewa; a sewa never falls on
-- a visit date, so the date IS the class. These RPCs read that class —
-- they write nothing, move nothing, and touch no visit RPC.
--
--   previsit_summary(schedule) — one row per previsit date × centre ×
--     department: present (distinct badges), open_now.
--   previsit_sewadars(schedule, date?) — one row per previsit session:
--     badge/name/home-centre/department/IN/OUT/duration/VSS/manual.
--
-- Scope: the v39/v51 helpers verbatim (scope-then-dept early returns),
-- so a dept_incharge sees their departments across every centre, aso /
-- super_admin see all, and every other role (centre roles included —
-- previsit is dept-incharge/as o/super_admin only by product decision)
-- gets zero rows, fail closed.
--
-- Attribution: sessions are attributed by IN date (the day the sewadar
-- came). Known edge, documented: a session opened on a visit day and
-- closed on a previsit day shows on NEITHER side (visit counts the IN
-- day via the v45 event law; previsit lists by IN date). Overnight
-- sessions across the window boundary are vanishingly rare and the
-- Anomalies sweep still lists the hanging OPEN.
--
-- Department of an undeployed badge: attendance_badge_dept's own
-- snapshot fallback (v59 §5) — an undeployed previsit badge still shows
-- to aso/super_admin (dept possibly NULL); a dept_incharge sees it only
-- when the badge is deployed to one of their departments (the
-- is_my_incharge_dept_badge arm inside their scope), by product decision.
--
-- Grants: new functions — REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO
-- authenticated, matching the v53/v55/v60 predicate pattern.
--
-- Indexes: none new. Both RPCs filter (schedule_id, in_date) — covered
-- by idx_dp_attendance_sessions (v39) and idx_dp_att_in_date (v28);
-- the dept gate reuses idx_deployments_effective_dept (v53) through
-- attendance_badge_dept.
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state,
-- every visit RPC, RLS policies, tables, columns, triggers, indexes,
-- existing data.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- INSERT ... ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. previsit_summary — one row per previsit date × centre × dept.
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

  -- Previsit is dept_incharge / aso / super_admin only (product decision):
  -- centre roles resolve a subtree in v_centres but must still see zero
  -- rows here, so they fail closed on the role gate, not the centre arm.
  -- (attendance_allowed_depts is NULL for every role but dept_incharge,
  -- and [] for a grant-less incharge — already returned above.)
  IF NOT v_admin AND v_depts IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped_dep AS (
    -- The expectation set, same scope predicates as the visit side:
    -- presence below is attributed within it.
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
  pre AS (
    SELECT a.in_date AS d,
           COALESCE(be.dc, a.sewadar_centre) AS centre,
           COALESCE(be.eff, a.sewadar_dept) AS department_id,
           a.badge_number,
           bool_or(a.status = 'OPEN') AS is_open
      FROM public.dp_attendance_sessions a
      LEFT JOIN badge_eff be ON be.badge_number = a.badge_number
     WHERE a.schedule_id = p_schedule
       -- THE split: outside the window (NULL window ⇒ every date).
       AND NOT public.is_visit_date(p_schedule, a.in_date)
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL
            OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
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
-- 2. previsit_sewadars — one row per previsit session (p_date NULL =
-- every previsit date; otherwise exactly that date, still previsit-only).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.previsit_sewadars(
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
  undeployed    boolean
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

  -- Same previsit-only role gate as previsit_summary above.
  IF NOT v_admin AND v_depts IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.in_date,
         a.badge_number,
         a.sewadar_name,
         a.sewadar_centre,
         public.attendance_badge_dept(a.badge_number, p_schedule) AS department_id,
         dd.name AS dept_name,
         a.is_vss,
         a.in_time,
         a.out_time,
         CASE WHEN a.out_date IS NOT NULL AND a.out_time IS NOT NULL
              THEN (EXTRACT(EPOCH FROM ((a.out_date + a.out_time) - (a.in_date + a.in_time))) / 60)::integer
              ELSE NULL END AS duration_min,
         a.is_manual,
         a.undeployed_scan AS undeployed
    FROM public.dp_attendance_sessions a
    LEFT JOIN public.deployment_departments dd
      ON dd.id = public.attendance_badge_dept(a.badge_number, p_schedule)
   WHERE a.schedule_id = p_schedule
     AND (p_date IS NULL OR a.in_date = p_date)
     -- THE split: outside the window (NULL window ⇒ every date).
     AND NOT public.is_visit_date(p_schedule, a.in_date)
     AND (v_admin
          OR v_depts IS NOT NULL
          OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL
          OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
   ORDER BY a.in_date DESC, a.in_time DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.previsit_sewadars(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.previsit_sewadars(uuid, date) TO authenticated;

-- ------------------------------------------------------------
-- §3. Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v62')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- Pre-conditions: a windowed schedule with sessions on BOTH a visit
-- date and a previsit date ('<sched>').
--
-- 1. The previsit side owns the previsit date:
--   SELECT event_date, centre, dept_name, present, open_now
--     FROM public.previsit_summary('<sched>');
--   -- Expect: rows for previsit dates only, never a window date.
--   SELECT badge_number, in_time, out_time, duration_min
--     FROM public.previsit_sewadars('<sched>', '<previsit-date>');
--   -- Expect: the previsit sessions with IN/OUT + duration minutes.
-- 2. The two sides partition the table (no row on both, no row on
--    neither — for sessions whose IN is not on the boundary):
--   WITH v AS (SELECT badge_number, in_date FROM public.dp_attendance_sessions
--               WHERE schedule_id = '<sched>'),
--        ps AS (SELECT DISTINCT badge_number, event_date FROM public.previsit_sewadars('<sched>')),
--        vs AS (SELECT badge_number FROM public.attendance_sewadar_summary('<sched>'))
--   SELECT (SELECT count(*) FROM v
--            WHERE (badge_number, in_date) IN (SELECT badge_number, event_date FROM ps)
--              AND badge_number IN (SELECT badge_number FROM vs)) AS on_both;
--   -- Expect: 0 (a badge scanned on BOTH sides appears once per side —
--   -- that is correct; no single SESSION is double-counted: previsit
--   -- lists by IN date, the visit counts visit-day events).
-- 3. Scope: as a dept_incharge holding the department, the same queries
--    return that department's rows; as vss_operator / centre_user they
--    return zero rows (fail closed).
-- 4. Registry:
--   SELECT version FROM public.portal_version WHERE version = 'v62';
--   -- Expect: one row.
