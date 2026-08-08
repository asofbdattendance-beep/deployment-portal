-- ============================================================
-- V8: DEPLOYED DEPARTMENT (final allocation by ASO / Super Admin)
-- Centres record their REQUESTED deployment department in
-- deployments.department_id. ASO / Super Admin now finalize it:
--   deployments.deployed_department_id  (nullable)
-- The finalizers are exempt from the deadline lock and from the
-- consent-eligibility / quota rules (they own the final call).
-- NOTE: NON-DESTRUCTIVE — safe to re-run.
-- Run AFTER portal_setup.sql + v2 + v3 + v4 + v5 + v6 + v7
-- ============================================================

-- ------------------------------------------------------------
-- 1. Column
-- ------------------------------------------------------------
ALTER TABLE public.deployments
  ADD COLUMN IF NOT EXISTS deployed_department_id uuid
  REFERENCES public.deployment_departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deployments_deployed_dept
  ON public.deployments(deployed_department_id);

-- ------------------------------------------------------------
-- 2. block_after_deadline: aso / super_admin are allowed to
--    keep working (final allocation) after the deadline & done.
--    (Centre users still locked by the deadline / done status.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_status text;
DECLARE v_deadline timestamptz;
BEGIN
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 3. check_deployment: aso / super_admin are the finalizers —
--    they may set the deployed department (and fix consent) for
--    any sewadar regardless of deadline / eligibility / quota.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched_status text;
  v_deadline timestamptz;
  v_dept public.deployment_departments%ROWTYPE;
  v_consent public.sewadar_consents%ROWTYPE;
  v_initiated boolean;
  v_quota integer;
BEGIN
  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  -- ASO / Super Admin finalize deployments — no eligibility/quota gates.
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  IF v_sched_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed for this schedule';
  END IF;

  SELECT * INTO v_dept FROM public.deployment_departments WHERE id = NEW.department_id;

  SELECT * INTO v_consent FROM public.sewadar_consents
  WHERE schedule_id = NEW.schedule_id AND centre = NEW.centre AND badge_number = NEW.badge_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No consent recorded for this sewadar';
  END IF;

  IF NOT v_consent.consent_given THEN
    RAISE EXCEPTION 'Consent not given for this sewadar';
  END IF;

  -- Elderly sewadars cannot be deployed
  IF EXISTS (
    SELECT 1 FROM public.sewadars s
    WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
      AND s.badge_status = 'ELDERLY'
  ) THEN
    RAISE EXCEPTION 'Elderly not deployed';
  END IF;

  IF v_consent.available_days_count IS NULL OR v_consent.available_days_count < v_dept.min_days THEN
    RAISE EXCEPTION 'Sewadar must have at least % consent days for this department', v_dept.min_days;
  END IF;

  IF v_dept.requires_stay_at_bhati AND NOT v_consent.stay_at_bhati THEN
    RAISE EXCEPTION 'This department requires stay-at-bhati sewadars';
  END IF;

  IF v_dept.requires_initiated THEN
    SELECT is_initiated INTO v_initiated FROM public.sewadars
    WHERE badge_number = NEW.badge_number AND centre = NEW.centre;
    IF v_initiated IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'This department requires an initiated sewadar';
    END IF;
  END IF;

  -- Quota only on insert or department change (avoid double-counting on update)
  IF TG_OP = 'INSERT' OR OLD.department_id IS DISTINCT FROM NEW.department_id THEN
    v_quota := public.get_remaining_quota(NEW.schedule_id, NEW.department_id);
    IF v_quota <= 0 THEN
      RAISE EXCEPTION 'Department quota already exhausted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 4. check_deployment_batch: skip the statement-level quota
--    re-check for finalizers (row triggers already bypassed).
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
BEGIN
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NULL;
  END IF;

  FOR r IN SELECT DISTINCT schedule_id, department_id FROM new_rows LOOP
    SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
    IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
    IF v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed for this schedule';
    END IF;

    -- evaluate quota from the perspective of each affected row's centre root
    FOR r2 IN SELECT DISTINCT centre FROM new_rows
             WHERE schedule_id = r.schedule_id AND department_id = r.department_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.department_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id AND d.department_id = r.department_id
        AND public.get_root_centre(d.centre) = v_root;

      IF v_used > v_max THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 5. RLS: let aso + super_admin write consents and deployments
--    (they finalize the allocation; centre roles unchanged).
-- ------------------------------------------------------------

-- sewadar_consents: allow aso + super_admin to edit anything
DROP POLICY IF EXISTS consent_write ON public.sewadar_consents;
CREATE POLICY consent_write ON public.sewadar_consents
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- deployments: allow aso + super_admin to update (set deployed dept)
DROP POLICY IF EXISTS deploy_v2_update ON public.deployments;
CREATE POLICY deploy_v2_update ON public.deployments
  FOR UPDATE TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- ------------------------------------------------------------
-- 6. View: include the deployed department for finalizers
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_all_deployments;
CREATE VIEW public.vw_all_deployments AS
SELECT
  d.id,
  d.schedule_id,
  s.name AS schedule_name,
  s.status AS schedule_status,
  d.department_id,
  dep.name AS department_name,
  d.deployed_department_id,
  ddep.name AS deployed_department_name,
  d.centre,
  d.badge_number,
  d.sewadar_name,
  d.status AS deployment_status,
  d.created_at
FROM public.deployments d
JOIN public.deployment_schedules s ON s.id = d.schedule_id
JOIN public.deployment_departments dep ON dep.id = d.department_id
LEFT JOIN public.deployment_departments ddep ON ddep.id = d.deployed_department_id;