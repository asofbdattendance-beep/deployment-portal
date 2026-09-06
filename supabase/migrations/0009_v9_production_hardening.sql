-- ============================================================
-- V9: PRODUCTION HARDENING
-- Fixes several regressions and closes authorization gaps:
--
--   1) block_after_deadline(): RESTORES the master-switch checks
--      (sewadar/vss deployment open) that v8 accidentally dropped
--      for centre roles, while keeping the aso/super_admin
--      exemption introduced in v8.
--   2) check_deployment(): RESTORES the full VSS eligibility
--      validation (include_vss, is_active, elderly, vss_min_days,
--      stay-at-bhati, initiated, gender) that v8 dropped, while
--      keeping the aso/super_admin finalizer exemption.
--   3) NEW: centre roles can no longer change
--      deployments.deployed_department_id — only aso/super_admin
--      (enforced inside check_deployment + batch re-check).
--   4) vss_sewadars read is scoped to the caller's subtree for
--      centre roles (was USING(true) — leaked contact/Aadhar PII
--      across every centre).
--   5) vss_registrations: centre roles cannot modify/delete rows
--      that are already 'assigned' (UI hid the buttons, but RLS
--      still allowed it).
--   6) storage vss-photos: uploads restricted to the reg/ folder;
--      update/delete restricted to the owner (+ aso/super_admin).
--      NOTE: owner is compared via owner_id::text = auth.uid()::text —
--      storage.objects.owner_id is uuid on some projects but text on
--      others, so both sides are cast to text to run on either.
--   7) sewadars: explicit read policy for the portal (was relying
--      on the attendance app's policies).
--   8) perf: index on deployments(schedule_id, department_id)
--      used by get_remaining_quota / check_deployment_batch.
--   9) data quality: unique Aadhar index on vss_registrations
--      (created only if no duplicates currently exist).
--  10) portal_users.updated_at now auto-maintained by a trigger.
--
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER v8_deployed_department.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. block_after_deadline: admin exemption + master switches
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_status text;
DECLARE v_deadline timestamptz;
DECLARE v_is_vss boolean;
BEGIN
  -- ASO / Super Admin keep working after the deadline (final allocation)
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  -- Master switches gate ALL centre-role consent/deploy writes
  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
  IF v_is_vss THEN
    IF NOT public.get_vss_deployment_open() THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;
  ELSE
    IF NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
    END IF;
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
-- 2. check_deployment: VSS eligibility + admin exemption
--    + centre roles cannot write deployed_department_id
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
  v_is_vss boolean;
  v_vss public.vss_sewadars%ROWTYPE;
  v_quota integer;
  v_role text;
BEGIN
  v_role := public.get_portal_user_role();

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  -- ASO / Super Admin finalize deployments — no eligibility/quota gates.
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  -- Centre roles may never set the FINAL deployed department.
  IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
    RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
  END IF;

  IF v_sched_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed for this schedule';
  END IF;

  SELECT * INTO v_dept FROM public.deployment_departments WHERE id = NEW.department_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department not found';
  END IF;

  SELECT * INTO v_consent FROM public.sewadar_consents
  WHERE schedule_id = NEW.schedule_id AND centre = NEW.centre AND badge_number = NEW.badge_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No consent recorded for this sewadar';
  END IF;
  IF NOT v_consent.consent_given THEN
    RAISE EXCEPTION 'Consent not given for this sewadar';
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  IF v_is_vss THEN
    IF NOT public.get_vss_deployment_open() THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;

    SELECT * INTO v_vss FROM public.vss_sewadars WHERE badge_number = NEW.badge_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VSS sewadar not found';
    END IF;
    IF NOT v_vss.is_active THEN
      RAISE EXCEPTION 'Cannot deploy sewadar — %', COALESCE(NULLIF(v_vss.remarks, ''), 'inactive VSS sewadar');
    END IF;
    IF NOT v_dept.include_vss THEN
      RAISE EXCEPTION 'This department is not opened for VSS';
    END IF;
    IF v_vss.badge_status = 'ELDERLY' THEN
      RAISE EXCEPTION 'Elderly sewadars cannot be deployed';
    END IF;
    IF v_consent.available_days_count IS NULL OR v_consent.available_days_count < v_dept.vss_min_days THEN
      RAISE EXCEPTION 'VSS sewadar must have at least % consent days for this department', v_dept.vss_min_days;
    END IF;
    IF v_dept.vss_requires_stay_at_bhati AND NOT v_consent.stay_at_bhati THEN
      RAISE EXCEPTION 'This department requires stay-at-bhati VSS sewadars';
    END IF;
    IF v_dept.vss_requires_initiated AND v_vss.is_initiated IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'This department requires initiated VSS sewadars';
    END IF;
    IF v_dept.vss_requires_gender IS NOT NULL AND v_vss.gender IS DISTINCT FROM v_dept.vss_requires_gender THEN
      RAISE EXCEPTION 'This department requires % VSS sewadars', v_dept.vss_requires_gender;
    END IF;
  ELSE
    IF NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.sewadars s
      WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
        AND s.badge_status = 'ELDERLY'
    ) THEN
      RAISE EXCEPTION 'Elderly sewadars cannot be deployed';
    END IF;

    IF v_consent.available_days_count IS NULL OR v_consent.available_days_count < v_dept.min_days THEN
      RAISE EXCEPTION 'Sewadar must have at least % consent days for this department', v_dept.min_days;
    END IF;

    IF v_dept.requires_stay_at_bhati AND NOT v_consent.stay_at_bhati THEN
      RAISE EXCEPTION 'This department requires stay-at-bhati sewadars';
    END IF;

    IF v_dept.requires_initiated THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.sewadars s
        WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
          AND s.is_initiated = true
      ) THEN
        RAISE EXCEPTION 'This department requires initiated sewadars';
      END IF;
    END IF;
  END IF;

  -- Quota (shared across regular + VSS): only on insert or department change
  IF TG_OP = 'INSERT' OR OLD.department_id IS DISTINCT FROM NEW.department_id THEN
    v_quota := public.get_remaining_quota(NEW.schedule_id, NEW.department_id);
    IF v_quota <= 0 THEN
      RAISE EXCEPTION 'Department quota already exhausted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- ------------------------------------------------------------
-- 3. check_deployment_batch: also skip admin finalizers
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

DROP TRIGGER IF EXISTS trg_check_deployment_batch_ins ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_ins
  AFTER INSERT ON public.deployments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch();

-- ------------------------------------------------------------
-- 4. vss_sewadars: scope reads to the caller's subtree (PII)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS vss_sewadars_read ON public.vss_sewadars;
CREATE POLICY vss_sewadars_read ON public.vss_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );

-- ------------------------------------------------------------
-- 5. vss_registrations: centre roles cannot touch ASSIGNED rows
-- ------------------------------------------------------------
DROP POLICY IF EXISTS vss_registrations_write ON public.vss_registrations;
CREATE POLICY vss_registrations_write ON public.vss_registrations
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'aso')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'aso')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  );

-- ------------------------------------------------------------
-- 6. storage vss-photos: reg/ folder only, owner-managed
-- ------------------------------------------------------------
DROP POLICY IF EXISTS vss_photos_insert ON storage.objects;
DROP POLICY IF EXISTS vss_photos_update ON storage.objects;
DROP POLICY IF EXISTS vss_photos_delete ON storage.objects;
CREATE POLICY vss_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vss-photos'
    AND name LIKE 'reg/%'
  );
CREATE POLICY vss_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'vss-photos'
    AND (owner_id::text = auth.uid()::text OR public.get_portal_user_role() IN ('aso', 'super_admin'))
  )
  WITH CHECK (
    bucket_id = 'vss-photos'
    AND name LIKE 'reg/%'
    AND (owner_id::text = auth.uid()::text OR public.get_portal_user_role() IN ('aso', 'super_admin'))
  );
CREATE POLICY vss_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'vss-photos'
    AND (owner_id::text = auth.uid()::text OR public.get_portal_user_role() IN ('aso', 'super_admin'))
  );

-- ------------------------------------------------------------
-- 7. sewadars: explicit portal read policy (centre subtree)
-- ------------------------------------------------------------
ALTER TABLE public.sewadars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sewadars_portal_read ON public.sewadars;
CREATE POLICY sewadars_portal_read ON public.sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );

-- ------------------------------------------------------------
-- 8. perf: index for the shared quota lookup
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deployments_schedule_dept
  ON public.deployments(schedule_id, department_id);

-- ------------------------------------------------------------
-- 9. data quality: unique Aadhar (only if no dupes yet)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vss_registrations
    GROUP BY aadhar_number HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS vss_registrations_aadhar_key
      ON public.vss_registrations(aadhar_number);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 10. portal_users.updated_at auto-maintenance
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_portal_users_touch ON public.portal_users;
CREATE TRIGGER trg_portal_users_touch
  BEFORE UPDATE ON public.portal_users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
