-- ============================================================
-- v47 — attendance_trend: present counts DEPLOYED badges only
-- ============================================================
-- Run AFTER v45 (v46 order-independent). Non-destructive; safe to re-run.
--
-- BUG (C6): attendance_trend counted every scanned badge in `present`
-- (no deployments predicate) while deriving `absent` from the deployed
-- count floored at zero. Any undeployed scan — expected traffic, since
-- open scanning is a requirement (v40) and UNDEPLOYED_SCAN is a defined
-- anomaly rule (v45) — inflated present and the excess silently became
-- "nobody absent": 5 deployed, 3 scanned, 2 undeployed scanned read as
-- a green 100% day instead of 60%. Every other summary RPC joins
-- presence to the expectation set; trend was the only one that didn't.
--
-- FIX: redefine attendance_trend with a scoped deployed-badge set; both
-- the present and absent subqueries count within it. absent is still
-- floored at 0. Nothing else changes.
-- ============================================================

BEGIN;

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
  ),
  -- v47: the expectation set — badges holding a deployment in scope.
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
             AND (v_depts IS NULL OR s.sewadar_dept = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep))::bigint AS present,
         GREATEST(v_deployed - (SELECT count(DISTINCT s.badge_number)
            FROM public.dp_attendance_sessions s
           WHERE s.schedule_id = p_schedule
             AND (s.in_date = dy.d OR s.out_date = dy.d)
             AND (v_admin OR s.sewadar_centre = ANY (v_centres))
             AND (v_depts IS NULL OR s.sewadar_dept = ANY (v_depts))
             AND s.badge_number IN (SELECT badge_number FROM scoped_dep)), 0)::bigint AS absent
    FROM days dy
   ORDER BY dy.d;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. present + absent == deployed on every trend row, even with
--    undeployed scans present. As aso/super_admin on a schedule with
--    an undeployed scan on day D: the D row must satisfy
--    present + absent = (SELECT count(DISTINCT badge_number)
--      FROM deployments WHERE schedule_id = <sched>).
--
-- WITH t AS (SELECT * FROM public.attendance_trend('<sched>'::uuid))
-- SELECT t.day, t.present, t.absent,
--        (SELECT count(DISTINCT badge_number) FROM public.deployments
--          WHERE schedule_id = '<sched>'::uuid) AS deployed,
--        (t.present + t.absent) = (SELECT count(DISTINCT badge_number)
--          FROM public.deployments
--          WHERE schedule_id = '<sched>'::uuid) AS reconciles
--   FROM t ORDER BY t.day;
--    Expect: reconciles = true on every row.
--
-- 2. An undeployed-only scan day still lists the day (days CTE is
--    unchanged) with present = 0 and absent = deployed.
