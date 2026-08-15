-- ============================================================
-- v17: rules + quota for EVERYONE (incl. ASO/super_admin) and a
--      per-sewadar audit trail for major changes
-- ============================================================
-- Fixes two production bugs found in review:
--   1. check_deployment / check_deployment_batch short-circuited for
--      aso/super_admin, so the ASO could assign sewadars past a CENTRE's
--      allocated quota (e.g. 50 → 53 on the Finalize Deployment page) and
--      out of a department's restriction rules (min_days / stay-at-bhati /
--      initiated / VSS rules). Admins keep their DESIGNED exemptions
--      (deadline passed, schedule done, master switches off, centre locked)
--      but now pass the same eligibility + quota gates as centre roles.
--   2. No record of WHO changed WHAT on WHICH sewadar. Adds
--      `sewadar_audit_log` + SECURITY DEFINER triggers that log MAJOR
--      events only: admin deployment writes, anything touching the FINAL
--      deployed department, admin consent fixes, and centre lock/unlock.
--      (Centre-role routine consent/deployment writes are everyday
--      transactions and are NOT logged.)
--
-- Quota semantics: a sewadar consumes quota from the department they
-- EFFECTIVELY occupy — COALESCE(deployed_department_id, department_id).
-- Quota is evaluated per the ROW's centre root (not the caller's), so
-- admin writes are held to the same per-CENTRE allocations as centre
-- writes. Multi-row statements are re-checked after the write
-- (AFTER INSERT + AFTER UPDATE statement triggers), closing the
-- snapshot hole where a whole chunk of rows could pass per-row checks.
--
-- Non-destructive; safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. quota helper keyed by the ROW's centre (not the caller's)
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
  SELECT count(*) INTO v_used
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule
    AND COALESCE(d.deployed_department_id, d.department_id) = p_department
    AND public.get_root_centre(d.centre) = v_root;
  RETURN GREATEST(v_max - v_used, 0);
END;
$$;

-- ------------------------------------------------------------
-- 2. check_deployment — eligibility + quota for ALL roles
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
  v_is_admin boolean;
  v_dept_id uuid;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    -- Admins keep working after the deadline / when done / when locked / with
    -- the master switches off (final allocation). Rules + quota below apply to
    -- them exactly like centre roles.
    NULL;
  ELSE
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
  END IF;

  -- Rules are judged against the department the sewadar WILL occupy: the
  -- FINAL deployed department when one is set, else the requested one.
  v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
  SELECT * INTO v_dept FROM public.deployment_departments WHERE id = v_dept_id;
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
    IF NOT v_is_admin AND NOT public.get_vss_deployment_open() THEN
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
    IF NOT v_is_admin AND NOT public.get_sewadar_deployment_open() THEN
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

  -- Quota (shared across regular + VSS): on insert or when the effective
  -- department changes, judged against the ROW's centre root.
  IF TG_OP = 'INSERT' OR COALESCE(OLD.deployed_department_id, OLD.department_id) IS DISTINCT FROM v_dept_id THEN
    v_quota := public.get_dept_quota_remaining(NEW.schedule_id, v_dept_id, NEW.centre);
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
-- 3. check_deployment_batch — after-statement quota re-check for
--    INSERT **and** UPDATE (multi-row statements see one snapshot,
--    so per-row checks alone can let a whole chunk slip past)
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

  -- INSERT: every new row matters (multi-row inserts must not slip past the
  -- per-row checks via a shared statement snapshot).
  FOR r IN
    SELECT DISTINCT schedule_id,
                    COALESCE(deployed_department_id, department_id) AS dept_id
    FROM new_rows
  LOOP
    IF NOT v_is_admin THEN
      -- a locked centre cannot deploy (even via batched inserts/updates)
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
    END IF;

    -- evaluate quota from the perspective of each affected row's centre root
    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root;

      IF v_used > v_max THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- UPDATE variant: only rows whose EFFECTIVE department actually changed in
-- this statement are re-checked (a row already occupying dept X that gets a
-- benign update must not trip the quota gate). OLD TABLE is only legal on
-- DELETE/UPDATE triggers, hence the separate function for UPDATE.
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
      -- a locked centre cannot deploy (even via batched updates)
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
    END IF;

    -- evaluate quota from the perspective of each affected row's centre root
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
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root;

      SELECT count(*) INTO v_pre FROM old_rows o
      WHERE o.schedule_id = r.schedule_id
        AND COALESCE(o.deployed_department_id, o.department_id) = r.dept_id
        AND public.get_root_centre(o.centre) = v_root;

      IF v_used > v_max AND v_used > v_pre THEN
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

DROP TRIGGER IF EXISTS trg_check_deployment_batch_upd ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_upd
  AFTER UPDATE ON public.deployments
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch_upd();

-- ------------------------------------------------------------
-- 4. sewadar_audit_log — who changed what on which sewadar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sewadar_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id uuid,
  centre text,
  badge_number text,
  sewadar_name text,
  action text NOT NULL,
  old_dept_name text,
  new_dept_name text,
  old_consent boolean,
  new_consent boolean,
  payload jsonb,
  acted_by text,
  acted_by_role text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sewadar_audit_schedule ON public.sewadar_audit_log(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sewadar_audit_badge ON public.sewadar_audit_log(badge_number);

-- small name resolvers used by the audit triggers
CREATE OR REPLACE FUNCTION public.dept_name_by_id(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT name FROM public.deployment_departments WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.sewadar_display_name(p_badge text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT name FROM public.sewadars WHERE badge_number = p_badge LIMIT 1),
    (SELECT sewadar_name FROM public.vss_sewadars WHERE badge_number = p_badge LIMIT 1),
    p_badge
  );
$$;

-- 4a. deployments — admin writes + anything touching the FINAL department
CREATE OR REPLACE FUNCTION public.audit_deployment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_action text;
  v_actor text;
  v_schedule_id uuid;
  v_centre text;
  v_badge text;
  v_req uuid;
  v_fin uuid;
BEGIN
  v_role := public.get_portal_user_role();
  -- Centre-role routine writes (requested-dept changes, consent flips) are
  -- everyday transactions — only admin actions and anything touching the
  -- FINAL deployed department are major events.
  IF v_role NOT IN ('aso', 'super_admin') THEN
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' AND OLD.deployed_department_id IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS NOT DISTINCT FROM OLD.deployed_department_id THEN RETURN NULL; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'deploy_add';
    v_schedule_id := NEW.schedule_id; v_centre := NEW.centre; v_badge := NEW.badge_number;
    v_req := NEW.department_id; v_fin := NEW.deployed_department_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deploy_remove';
    v_schedule_id := OLD.schedule_id; v_centre := OLD.centre; v_badge := OLD.badge_number;
    v_req := OLD.department_id; v_fin := OLD.deployed_department_id;
  ELSE
    v_schedule_id := NEW.schedule_id; v_centre := NEW.centre; v_badge := NEW.badge_number;
    v_req := NEW.department_id; v_fin := NEW.deployed_department_id;
    IF NEW.deployed_department_id IS NULL THEN
      v_action := 'unfinalize';
    ELSIF OLD.deployed_department_id IS NULL THEN
      v_action := 'finalize';
    ELSIF NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      v_action := 'change_final';
    ELSE
      v_action := 'deploy_edit';
    END IF;
  END IF;

  SELECT name INTO v_actor FROM public.portal_users WHERE auth_id = auth.uid();

  INSERT INTO public.sewadar_audit_log
    (schedule_id, centre, badge_number, sewadar_name, action,
     old_dept_name, new_dept_name, payload, acted_by, acted_by_role)
  VALUES
    (v_schedule_id, v_centre, v_badge, public.sewadar_display_name(v_badge), v_action,
     CASE WHEN TG_OP = 'INSERT' THEN NULL
          ELSE public.dept_name_by_id(COALESCE(OLD.deployed_department_id, OLD.department_id)) END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL
          ELSE public.dept_name_by_id(COALESCE(NEW.deployed_department_id, NEW.department_id)) END,
     jsonb_build_object('requested_dept_id', v_req, 'final_dept_id', v_fin),
     v_actor, v_role);
  RETURN NULL;
END;
$$;

-- 4b. sewadar_consents — admin changes only (post-deadline fixes)
CREATE OR REPLACE FUNCTION public.audit_consent_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_action text;
  v_actor text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('aso', 'super_admin') THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'consent_add';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'consent_remove';
  ELSE
    IF OLD.consent_given IS NOT DISTINCT FROM NEW.consent_given
       AND OLD.available_days_count IS NOT DISTINCT FROM NEW.available_days_count
       AND OLD.stay_at_bhati IS NOT DISTINCT FROM NEW.stay_at_bhati
       AND OLD.chair_pass IS NOT DISTINCT FROM NEW.chair_pass THEN
      RETURN NULL;
    END IF;
    v_action := 'consent_edit';
  END IF;

  SELECT name INTO v_actor FROM public.portal_users WHERE auth_id = auth.uid();

  INSERT INTO public.sewadar_audit_log
    (schedule_id, centre, badge_number, sewadar_name, action,
     old_consent, new_consent, payload, acted_by, acted_by_role)
  VALUES
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.schedule_id ELSE NEW.schedule_id END,
     CASE WHEN TG_OP = 'DELETE' THEN OLD.centre ELSE NEW.centre END,
     CASE WHEN TG_OP = 'DELETE' THEN OLD.badge_number ELSE NEW.badge_number END,
     public.sewadar_display_name(CASE WHEN TG_OP = 'DELETE' THEN OLD.badge_number ELSE NEW.badge_number END),
     v_action,
     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.consent_given END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.consent_given END,
     jsonb_build_object(
       'old_days', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.available_days_count END,
       'new_days', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.available_days_count END,
       'old_stay_at_bhati', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.stay_at_bhati END,
       'new_stay_at_bhati', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.stay_at_bhati END,
       'old_chair_pass', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.chair_pass END,
       'new_chair_pass', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.chair_pass END
     ),
     v_actor, v_role);
  RETURN NULL;
END;
$$;

-- 4c. centre_locks — lock / unlock events
CREATE OR REPLACE FUNCTION public.audit_lock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor text;
  v_role text;
BEGIN
  v_role := public.get_portal_user_role();
  SELECT name INTO v_actor FROM public.portal_users WHERE auth_id = auth.uid();

  INSERT INTO public.sewadar_audit_log
    (schedule_id, centre, action, payload, acted_by, acted_by_role)
  VALUES
    (CASE WHEN TG_OP = 'INSERT' THEN NEW.schedule_id ELSE OLD.schedule_id END,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.centre ELSE OLD.centre END,
     CASE WHEN TG_OP = 'INSERT' THEN 'lock' ELSE 'unlock' END,
     jsonb_build_object(
       'locked_by', CASE WHEN TG_OP = 'INSERT' THEN NEW.locked_by ELSE OLD.locked_by END,
       'locked_at', CASE WHEN TG_OP = 'INSERT' THEN NEW.locked_at ELSE OLD.locked_at END
     ),
     v_actor, v_role);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_deployment ON public.deployments;
CREATE TRIGGER trg_audit_deployment
  AFTER INSERT OR UPDATE OR DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.audit_deployment_change();

DROP TRIGGER IF EXISTS trg_audit_consent ON public.sewadar_consents;
CREATE TRIGGER trg_audit_consent
  AFTER INSERT OR UPDATE OR DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.audit_consent_change();

DROP TRIGGER IF EXISTS trg_audit_lock ON public.centre_locks;
CREATE TRIGGER trg_audit_lock
  AFTER INSERT OR DELETE ON public.centre_locks
  FOR EACH ROW EXECUTE FUNCTION public.audit_lock_change();

-- ------------------------------------------------------------
-- 4d. incharge assignment check follows the EFFECTIVE department
--     too: an incharge must hold an assignment in the department
--     they represent, judged the same way quota is
--     (COALESCE(deployed_department_id, department_id)) — otherwise
--     an ASO-finalized override could leave the DB check passing on
--     a requested dept the sewadar no longer effectively occupies.
-- ------------------------------------------------------------
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
      AND d.badge_number = NEW.badge_number
      AND COALESCE(d.deployed_department_id, d.department_id) = NEW.department_id
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
-- 5. RLS — read for aso/super_admin; writes come from the
--    SECURITY DEFINER triggers above (function owner bypasses RLS)
-- ------------------------------------------------------------
ALTER TABLE public.sewadar_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sewadar_audit_read ON public.sewadar_audit_log;
CREATE POLICY sewadar_audit_read ON public.sewadar_audit_log
  FOR SELECT TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));

DROP POLICY IF EXISTS sewadar_audit_insert ON public.sewadar_audit_log;
CREATE POLICY sewadar_audit_insert ON public.sewadar_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- ------------------------------------------------------------
-- Verification queries
-- ------------------------------------------------------------
-- 1. quota helper works for a specific centre:
--    SELECT public.get_dept_quota_remaining(s.id, d.id, 'CENTRE_NAME')
--    FROM deployment_schedules s, deployment_departments d LIMIT 1;
-- 2. admins are now held to rules/quota (no blanket RETURN NEW):
--    SELECT prosrc FROM pg_proc WHERE proname = 'check_deployment';
--    -- should NOT contain "RETURN NEW;" immediately after the role lookup
-- 3. audit trail fills on major events:
--    SELECT action, badge_number, sewadar_name, old_dept_name, new_dept_name,
--           acted_by, created_at
--    FROM public.sewadar_audit_log ORDER BY created_at DESC LIMIT 25;
-- 4. trigger list:
--    SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.deployments'::regclass
--      AND NOT tgisinternal ORDER BY tgname;
--    -- expect trg_audit_deployment, trg_check_deployment,
--    --    trg_check_deployment_batch_ins, trg_check_deployment_batch_upd
-- 5. no row is counted twice across requested/final:
--    SELECT COALESCE(deployed_department_id, department_id) AS eff, count(*)
--    FROM public.deployments GROUP BY 1;