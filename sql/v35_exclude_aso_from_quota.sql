-- ============================================================
-- V35: EXCLUDE AREA SECRETARY OFFICE SEWADARS FROM DEPLOYMENT QUOTA
-- ============================================================
-- Sewadars whose own department (sewadars.department or
-- vss_sewadars.department) is "AREA SECRETARY OFFICE" are deployed
-- exclusively by the super_admin and must NOT consume a centre's
-- allocated deployment quota.  Before this migration the quota count
-- functions counted every deployments row blindly, so an ASO-dept
-- sewadar occupying e.g. LANGAR would eat one LANGAR seat even
-- though the centre never chose that sewadar.
--
-- Fix: every quota-counting path now skips deployments whose badge
-- belongs to an ASO-dept sewadar (via a NOT EXISTS anti-join against
-- sewadars / vss_sewadars).
--
-- Affected functions:
--   1. get_dept_quota_remaining  (per-row gate in check_deployment)
--   2. check_deployment_batch    (AFTER-statement INSERT re-check)
--   3. check_deployment_batch_upd(AFTER-statement UPDATE re-check)
--
-- Non-destructive; safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. get_dept_quota_remaining — exclude ASO-dept from count
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dept_quota_remaining(p_schedule uuid, p_department uuid, p_centre text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_root text;
  v_max integer;
  v_used integer;
BEGIN
  v_root := public.get_root_centre(p_centre);
  IF v_root IS NULL THEN
    RETURN 0;
  END IF;
  SELECT max_count INTO v_max
  FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND department_id = p_department AND centre = v_root;
  IF v_max IS NULL THEN
    RETURN 0;
  END IF;
  -- count by the row's EFFECTIVE department (final when set, else requested)
  -- EXCLUDE sewadars whose own department is AREA SECRETARY OFFICE — they
  -- are deployed by the super_admin and do not consume centre quota.
  SELECT count(*) INTO v_used
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule
    AND COALESCE(d.deployed_department_id, d.department_id) = p_department
    AND public.get_root_centre(d.centre) = v_root
    AND NOT EXISTS (
      SELECT 1 FROM public.sewadars s
      WHERE s.badge_number = d.badge_number AND s.centre = d.centre
        AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.vss_sewadars vs
      WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
        AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
    );
  RETURN GREATEST(v_max - v_used, 0);
END;
$$;

-- ------------------------------------------------------------
-- 2. check_deployment_batch (INSERT) — exclude ASO-dept from count
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_deployment_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  r2 record;
  v_max integer;
  v_used integer;
  v_root text;
  v_sched_status text;
  v_deadline timestamptz;
  v_role text;
  v_is_admin boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  FOR r IN
    SELECT DISTINCT schedule_id,
                    COALESCE(deployed_department_id, department_id) AS dept_id
    FROM new_rows
  LOOP
    IF NOT v_is_admin THEN
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
      ) THEN
        SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
        IF v_deadline IS NOT NULL AND now() > v_deadline THEN
          RAISE EXCEPTION 'Deadline has passed for this schedule';
        END IF;
      ELSE
        SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
      END IF;
    END IF;

    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota.
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from the count.
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.sewadars s
          WHERE s.badge_number = d.badge_number AND s.centre = d.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      IF v_used > v_max THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 3. check_deployment_batch_upd (UPDATE) — exclude ASO-dept from count
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_deployment_batch_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  r2 record;
  v_max integer;
  v_used integer;
  v_pre integer;
  v_root text;
  v_sched_status text;
  v_deadline timestamptz;
  v_role text;
  v_is_admin boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  FOR r IN
    SELECT DISTINCT nr.schedule_id,
                    COALESCE(nr.deployed_department_id, nr.department_id) AS dept_id
    FROM new_rows nr
    JOIN old_rows o ON nr.id = o.id
    WHERE COALESCE(nr.deployed_department_id, nr.department_id) IS DISTINCT FROM COALESCE(o.deployed_department_id, o.department_id)
  LOOP
    IF NOT v_is_admin THEN
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
      ) THEN
        SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
        IF v_deadline IS NOT NULL AND now() > v_deadline THEN
          RAISE EXCEPTION 'Deadline has passed for this schedule';
        END IF;
      ELSE
        SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
      END IF;
    END IF;

    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota.
      -- But a statement that only REDUCES a department (corrective moves out
      -- of a legacy over-quota state) must not be blocked, so raise only when
      -- the statement NET-increased the count (post > max AND post > pre).
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from both counts.
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.sewadars s
          WHERE s.badge_number = d.badge_number AND s.centre = d.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      SELECT count(*) INTO v_pre FROM old_rows o
      WHERE o.schedule_id = r.schedule_id
        AND COALESCE(o.deployed_department_id, o.department_id) = r.dept_id
        AND public.get_root_centre(o.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.sewadars s
          WHERE s.badge_number = o.badge_number AND s.centre = o.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = o.badge_number AND vs.centre = o.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      IF v_used > v_max AND v_used > v_pre THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- 1. Check that get_dept_quota_remaining excludes ASO-dept:
--    SELECT public.get_dept_quota_remaining(
--      '<schedule uuid>',
--      '<department uuid>',
--      'CENTRE_NAME'
--    );
-- 2. Insert an ASO-dept deployment and verify it doesn't consume quota:
--    INSERT INTO deployments (schedule_id, centre, badge_number, department_id)
--    VALUES ('<schedule>', 'CENTRE', '<ASO badge>', '<dept uuid>');
--    -- quota should NOT decrease
-- 3. Insert a normal deployment and verify it DOES consume quota:
--    INSERT INTO deployments (schedule_id, centre, badge_number, department_id)
--    VALUES ('<schedule>', 'CENTRE', '<normal badge>', '<dept uuid>');
--    -- quota should decrease by 1
