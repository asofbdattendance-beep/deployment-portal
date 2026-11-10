-- ============================================================
-- V84: PREVIOUS-SESSION REFERENCE FOR CONSENT & DEPLOYMENT.
-- Run AFTER v83.
--
-- Why: the Consent page's "Prev. Dept" / "Attendance Reported" columns
-- read prev_year_deployments, a one-off manual import that is not tied
-- to any schedule. Creating a new schedule (e.g. December 2026) kept
-- showing that stale import instead of what was actually deployed and
-- scanned in the session before it (October 2026).
--
-- What: prev_session_reference(p_schedule) resolves the schedule that
-- came immediately before p_schedule and returns, per badge deployed in
-- it, the final department and the number of distinct VISIT days the
-- badge scanned in. It rolls forward automatically: December reads
-- October, the next visit reads December, and so on.
--
-- Rules:
--   - "Before" = ordered by COALESCE(visit_start_date, created_at::date),
--     ties broken by created_at. Only schedules with at least one
--     deployments row qualify, so an empty/test schedule is skipped.
--   - Prev. Dept = deployed_department_id (ASO finalize) if set, else the
--     requested department_id.
--   - Attendance = COUNT(DISTINCT in_date) of dp_attendance_sessions for
--     that badge in the previous schedule where is_visit_date() is TRUE.
--     Previsit sewa days are not counted (the column reads "x / 5").
--     If the previous schedule has NO visit window, attendance is NULL
--     (unknown) rather than a misleading 0.
--   - No previous schedule ⇒ prev_schedule_id NULL; the client then keeps
--     using prev_year_deployments, so the first portal schedule (October)
--     renders exactly as before.
--   - Scope mirrors deploy_v2_read: aso / super_admin / vss_operator see
--     every centre; everyone else only get_my_subtree_centres().
--
-- Returns jsonb (not SETOF) so PostgREST's max-rows cap never truncates
-- a large centre list.
--
-- NOT TOUCHED: no table, column, policy, trigger or existing function is
-- altered. prev_year_deployments stays as the fallback.
-- Non-destructive; safe to re-run (CREATE OR REPLACE).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.prev_session_reference(p_schedule uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role       text := public.get_portal_user_role();
  v_all        boolean;
  v_subtree    text[];
  v_cur        public.deployment_schedules;
  v_prev       public.deployment_schedules;
  v_has_window boolean;
  v_rows       jsonb;
BEGIN
  IF p_schedule IS NULL OR v_role IS NULL THEN
    RETURN jsonb_build_object('prev_schedule_id', NULL, 'prev_schedule_name', NULL, 'rows', '[]'::jsonb);
  END IF;

  v_all := v_role IN ('aso', 'super_admin', 'vss_operator');
  IF NOT v_all THEN
    v_subtree := COALESCE(public.get_my_subtree_centres(), ARRAY[]::text[]);
  END IF;

  SELECT * INTO v_cur FROM public.deployment_schedules WHERE id = p_schedule;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('prev_schedule_id', NULL, 'prev_schedule_name', NULL, 'rows', '[]'::jsonb);
  END IF;

  SELECT s.* INTO v_prev
    FROM public.deployment_schedules s
   WHERE s.id <> v_cur.id
     AND (
       COALESCE(s.visit_start_date, s.created_at::date) < COALESCE(v_cur.visit_start_date, v_cur.created_at::date)
       OR (
         COALESCE(s.visit_start_date, s.created_at::date) = COALESCE(v_cur.visit_start_date, v_cur.created_at::date)
         AND s.created_at < v_cur.created_at
       )
     )
     AND EXISTS (SELECT 1 FROM public.deployments d WHERE d.schedule_id = s.id)
   ORDER BY COALESCE(s.visit_start_date, s.created_at::date) DESC, s.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('prev_schedule_id', NULL, 'prev_schedule_name', NULL, 'rows', '[]'::jsonb);
  END IF;

  v_has_window := cardinality(public.schedule_visit_dates(v_prev.id)) > 0;

  WITH dep AS (
    SELECT d.centre,
           d.badge_number,
           dd.name AS prev_department
      FROM public.deployments d
      LEFT JOIN public.deployment_departments dd
        ON dd.id = COALESCE(d.deployed_department_id, d.department_id)
     WHERE d.schedule_id = v_prev.id
       AND (v_all OR d.centre = ANY (v_subtree))
  ),
  att AS (
    SELECT a.badge_number, COUNT(DISTINCT a.in_date)::int AS days
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = v_prev.id
       AND v_has_window
       AND public.is_visit_date(v_prev.id, a.in_date)
       AND a.badge_number IN (SELECT badge_number FROM dep)
     GROUP BY a.badge_number
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'centre', dep.centre,
           'badge_number', dep.badge_number,
           'prev_department', dep.prev_department,
           'attendance_reported', CASE WHEN v_has_window THEN COALESCE(att.days, 0) ELSE NULL END
         )), '[]'::jsonb)
    INTO v_rows
    FROM dep
    LEFT JOIN att ON att.badge_number = dep.badge_number;

  RETURN jsonb_build_object(
    'prev_schedule_id', v_prev.id,
    'prev_schedule_name', v_prev.name,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prev_session_reference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prev_session_reference(uuid) TO authenticated;

COMMIT;

-- ------------------------------------------------------------
-- VERIFY (run as an ASO/super_admin session, or swap in a real id):
-- SELECT id, name, visit_start_date FROM public.deployment_schedules ORDER BY created_at DESC;
-- SELECT public.prev_session_reference('<december schedule id>') -> 'prev_schedule_name';
-- SELECT jsonb_array_length(public.prev_session_reference('<december schedule id>') -> 'rows');
-- ------------------------------------------------------------
