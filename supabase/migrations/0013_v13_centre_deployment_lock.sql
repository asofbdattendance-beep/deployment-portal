-- ============================================================
-- V13: CENTRE DEPLOYMENT LOCK (+ incharge compulsion)
-- A CENTRE "locks deployment" once its consent & deployment are
-- final. Locking requires an incharge for every allocated
-- department that has at least one REGULAR sewadar deployed to
-- it (a department with nobody deployed needs no incharge).
-- While locked, centre-role writes to sewadar_consents /
-- deployments / department_incharges are blocked (regular AND
-- VSS — they share those tables). Only aso/super_admin can
-- unlock (DELETE from centre_locks).
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER v12 in Supabase.
-- ============================================================

-- ------------------------------------------------------------
-- 1. centre_locks table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.centre_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  centre text NOT NULL,                       -- the CENTRE (root) that locked
  locked_at timestamptz DEFAULT now(),
  locked_by text,
  UNIQUE (schedule_id, centre)
);
CREATE INDEX IF NOT EXISTS idx_centre_locks_schedule ON public.centre_locks(schedule_id);

-- ------------------------------------------------------------
-- 2. helper: is this centre's deployment locked?
--    (centre match is by ROOT so an SC_SP write counts as the CENTRE's)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_centre_locked(p_schedule uuid, p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.centre_locks cl
    WHERE cl.schedule_id = p_schedule
      AND cl.centre = public.get_root_centre(p_centre)
  );
$$;

-- ------------------------------------------------------------
-- 3. Lock compulsion: cannot lock until every allocated
--    department with ≥1 regular deployed sewadar has an incharge
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_centre_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  v_status text;
  v_deadline timestamptz;
BEGIN
  -- Only centre roles go through the compulsion; admins manage locks directly.
  IF public.get_portal_user_role() NOT IN ('centre_user', 'centre_admin') THEN
    RETURN NEW;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;
  IF NOT public.get_sewadar_deployment_open() THEN
    RAISE EXCEPTION 'Sewadar deployment is closed';
  END IF;

  FOR r IN
    SELECT a.department_id
    FROM public.centre_allocations a
    WHERE a.schedule_id = NEW.schedule_id AND a.centre = NEW.centre
      AND EXISTS (
        SELECT 1 FROM public.deployments d
        WHERE d.schedule_id = NEW.schedule_id
          AND d.department_id = a.department_id
          AND public.get_root_centre(d.centre) = NEW.centre
          AND d.badge_number NOT ILIKE 'VS%'
      )
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.department_incharges i
      WHERE i.schedule_id = NEW.schedule_id
        AND i.centre = NEW.centre
        AND i.department_id = r.department_id
    ) THEN
      RAISE EXCEPTION 'Cannot lock deployment — add an incharge for every allocated department first';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_centre_lock ON public.centre_locks;
CREATE TRIGGER trg_check_centre_lock
  BEFORE INSERT ON public.centre_locks
  FOR EACH ROW EXECUTE FUNCTION public.check_centre_lock();

-- ------------------------------------------------------------
-- 4. Enforce the lock in the existing edit triggers
-- ------------------------------------------------------------

-- 4a. block_after_deadline (sewadar_consents + deployments)
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

  -- A locked centre cannot edit consent/deployment (regular + VSS)
  IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
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

-- 4b. check_deployment (deployments)
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

  -- A locked centre cannot edit deployments
  IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
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

-- 4c. check_deployment_batch (multi-row inserts)
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
    -- a locked centre cannot deploy (even via batched inserts)
    IF EXISTS (
      SELECT 1 FROM new_rows nr
      WHERE nr.schedule_id = r.schedule_id
        AND public.is_centre_locked(r.schedule_id, nr.centre)
    ) THEN
      RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
    END IF;

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

-- 4d. DELETE guard: the INSERT/UPDATE triggers above don't stop a locked
--     centre from DELETING rows via RLS — close that gap.
CREATE OR REPLACE FUNCTION public.block_locked_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;
  IF public.is_centre_locked(OLD.schedule_id, OLD.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_locked_delete_consent ON public.sewadar_consents;
CREATE TRIGGER trg_block_locked_delete_consent
  BEFORE DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

DROP TRIGGER IF EXISTS trg_block_locked_delete_deploy ON public.deployments;
CREATE TRIGGER trg_block_locked_delete_deploy
  BEFORE DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

DROP TRIGGER IF EXISTS trg_block_locked_delete_incharge ON public.department_incharges;
CREATE TRIGGER trg_block_locked_delete_incharge
  BEFORE DELETE ON public.department_incharges
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

-- 4e. check_department_incharge (incharge writes, from v12)
CREATE OR REPLACE FUNCTION public.check_department_incharge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched_status text;
  v_deadline timestamptz;
BEGIN
  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_sched_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;

  -- a locked centre cannot change incharges either
  IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;

  -- Match by badge within the same CENTRE (root): the incharge row is stored
  -- against the CENTRE (myRoot), but the sewadar's own consent/deployment
  -- rows live at their actual centre (possibly an SC_SP).
  IF NOT EXISTS (
    SELECT 1 FROM public.sewadar_consents c
    WHERE c.schedule_id = NEW.schedule_id
      AND c.badge_number = NEW.badge_number AND c.consent_given
      AND public.get_root_centre(c.centre) = public.get_root_centre(NEW.centre)
  ) THEN
    RAISE EXCEPTION 'Incharge must be a consented sewadar';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.deployments d
    WHERE d.schedule_id = NEW.schedule_id
      AND d.badge_number = NEW.badge_number AND d.department_id = NEW.department_id
      AND public.get_root_centre(d.centre) = public.get_root_centre(NEW.centre)
  ) THEN
    RAISE EXCEPTION 'Incharge must be assigned to this department';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_incharge ON public.department_incharges;
CREATE TRIGGER trg_check_incharge
  BEFORE INSERT OR UPDATE ON public.department_incharges
  FOR EACH ROW EXECUTE FUNCTION public.check_department_incharge();

-- ------------------------------------------------------------
-- 5. RLS — centre roles lock (INSERT), only admins unlock (DELETE)
-- ------------------------------------------------------------
ALTER TABLE public.centre_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS centre_locks_read ON public.centre_locks;
CREATE POLICY centre_locks_read ON public.centre_locks
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
  );

DROP POLICY IF EXISTS centre_locks_insert ON public.centre_locks;
CREATE POLICY centre_locks_insert ON public.centre_locks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

DROP POLICY IF EXISTS centre_locks_delete ON public.centre_locks;
CREATE POLICY centre_locks_delete ON public.centre_locks
  FOR DELETE TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));

DROP POLICY IF EXISTS centre_locks_update ON public.centre_locks;
CREATE POLICY centre_locks_update ON public.centre_locks
  FOR UPDATE TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));
