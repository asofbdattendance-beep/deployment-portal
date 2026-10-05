-- ============================================================
-- V74: VISIT CENTRE × DAY READ RPC. Run AFTER v73 (needs
-- schedule_visit_dates from v60; complements the v61 visit-side
-- restriction and the v62/v64 previsit RPCs).
--
-- Rule (product decision): from the day before the visit starts, every
-- role views Bhati Visit. The Bhati Visit dashboard needs the same
-- centre × sewa-day grid the previsit dashboard has — present by day,
-- heatmap, denominators — but over VISIT dates only. This RPC reads
-- that class: one row per centre × visit date with present / open_now /
-- deployed. It writes nothing, moves nothing, and touches no visit RPC.
--
--   attendance_centre_daily(schedule) — one row per centre × visit date:
--     event_date, centre, present (distinct deployed badges with an
--     event on that date), open_now (date-scoped OPEN), deployed
--     (distinct deployed badges in scope for the centre, constant
--     across dates).
--
-- Window gating: a schedule with no usable window returns ZERO rows —
-- the visit view has no dates to show, so the dashboard renders its
-- honest empty state instead of a fabricated grid.
--
-- Event law: the visit law (v45/v61) — a badge counts present on date d
-- when in_date = d OR out_date = d. Presence counts DEPLOYED badges
-- only (scoped_dep EXISTS arm, v59 (a)), so present <= deployed per
-- cell. Scope: the v39/v51 helpers verbatim (scope-then-dept early
-- returns), matching attendance_daily_summary — centre roles see their
-- subtree, dept_incharge sees their departments, aso / super_admin see
-- all. One badge, one centre via badge_eff DISTINCT ON (v59 (f)), so
-- the denominator can never double-count.
--
-- Grants: new function — REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO
-- authenticated, matching the v53/v55/v60 predicate pattern.
--
-- Indexes: none new. Sessions filter (schedule_id, in_date / out_date)
-- — covered by idx_dp_attendance_sessions (v39) and idx_dp_att_in_date
-- (v28); the dept gate reuses idx_deployments_effective_dept (v53)
-- through attendance_badge_dept.
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session / get_scan_state,
-- every other visit RPC, every previsit RPC, RLS policies, tables,
-- columns, triggers, indexes, existing data.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- INSERT ... ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.attendance_centre_daily(p_schedule uuid)
RETURNS TABLE(
  event_date date,
  centre     text,
  present    bigint,
  open_now   bigint,
  deployed   bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  -- No usable window ⇒ no visit dates ⇒ zero rows (honest empty state).
  v_window := public.schedule_visit_dates(p_schedule);
  IF v_window IS NULL OR cardinality(v_window) = 0 THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

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
  centres AS (
    SELECT be.dc AS centre, count(*) AS deployed
      FROM badge_eff be
     GROUP BY be.dc
  ),
  days AS (
    SELECT unnest(v_window) AS d
  ),
  presence AS (
    SELECT dd.d AS event_date,
           COALESCE(be.dc, a.sewadar_centre) AS centre,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status IN ('OPEN','CLOSED')) AS present,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status = 'OPEN')             AS open_now
      FROM days dd
      JOIN public.dp_attendance_sessions a
        ON a.schedule_id = p_schedule
       AND (a.in_date = dd.d OR a.out_date = dd.d)
      LEFT JOIN badge_eff be ON be.badge_number = a.badge_number
     WHERE (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
       -- v59 (a): presence counts DEPLOYED badges only.
       AND EXISTS (SELECT 1 FROM scoped_dep sd WHERE sd.badge_number = a.badge_number)
     GROUP BY 1, 2
  )
  SELECT dd.d,
         c.centre,
         COALESCE(p.present, 0)::bigint  AS present,
         COALESCE(p.open_now, 0)::bigint AS open_now,
         c.deployed::bigint              AS deployed
    FROM days dd
   CROSS JOIN centres c
   LEFT JOIN presence p
     ON p.event_date = dd.d
    AND p.centre = c.centre
   ORDER BY dd.d, c.centre;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_centre_daily(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_centre_daily(uuid) TO authenticated;

-- ------------------------------------------------------------
-- Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v74')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- 1. Function exists with the grouped shape:
--   SELECT parameter_name, data_type FROM information_schema.parameters
--    WHERE specific_schema = 'public'
--      AND specific_name LIKE 'attendance_centre_daily%';
--   -- Expect: p_schedule uuid.
-- 2. Windowed schedule returns centres × window dates:
--   SELECT count(*), count(DISTINCT centre), count(DISTINCT event_date)
--     FROM public.attendance_centre_daily(
--       (SELECT id FROM public.deployment_schedules
--         WHERE lower(name) = lower('October 2026 Visit') LIMIT 1));
--   -- Expect: count = centres × 5, distinct dates = 5.
-- 3. No cell exceeds its denominator:
--   SELECT count(*) FROM public.attendance_centre_daily(
--       (SELECT id FROM public.deployment_schedules
--         WHERE lower(name) = lower('October 2026 Visit') LIMIT 1))
--    WHERE present > deployed;
--   -- Expect: 0.
-- 4. Windowless schedule is honestly empty:
--   SELECT count(*) FROM public.attendance_centre_daily(
--       (SELECT id FROM public.deployment_schedules
--         WHERE visit_start_date IS NULL LIMIT 1));
--   -- Expect: 0.
-- 5. Re-run safety: execute this whole file a second time. Expect no error.
