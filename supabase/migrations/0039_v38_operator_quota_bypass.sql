-- ============================================================
-- V38: QUOTA BYPASS FOR super_admin + vss_operator (extras / Additional)
--
-- Problem: a centre that needs a few seats beyond its allocated quota
-- forces the ASO to raise centre_allocations.max_count, which destroys
-- the original schedule record. From here on, super_admin and the
-- vss_operator may deploy BEYOND quota; centres stay capped; the
-- schedule (max_count) is never touched for extras. Over-quota rows
-- surface in the UI as "Additional" (deployed − scheduled).
--
-- Scope is deliberately NARROW (quota gate ONLY):
--   • consent existence + consent-given, eligibility (min_days /
--     stay-at-bhati / initiated / VSS rules), ELDERLY + phantom-badge
--     rejection, centre lock, deadline, done, switches, the operator's
--     VSS-switch gate and undeployed-only / INSERT-only limits — ALL
--     UNCHANGED for every role.
--   • aso stays read-only (v20); it never writes, so it needs no bypass.
--   • The batch re-checks keep computing used/max (auditable); only the
--     RAISE is skipped for bypass roles.
--   • Over-quota admin writes are already audited (v17
--     sewadar_audit_log logs admin deployment writes).
--
-- Non-destructive; safe to re-run. Run AFTER v37.
-- ROLLBACK: re-run sql/v36_vss_operator.sql (restores quota binding).
-- ============================================================

-- 1. check_deployment — v37 body + quota bypass
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
  v_is_operator boolean;
  v_bypass boolean;
  v_quota_bypass boolean;
  v_dept_id uuid;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_vss_open boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');
  v_is_operator := (v_role = 'vss_operator');
  v_bypass := v_is_admin OR v_is_operator;
  -- V38: super_admin + vss_operator may deploy BEYOND the allocated
  -- quota (extras surface as Additional); quota still binds centre roles.
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    v_override := false;
  ELSE
    -- Final-department setter: admins only. The operator lands here, so any
    -- write carrying deployed_department_id raises — operator can NEVER set
    -- the final department (v20 made aso read-only; super_admin finalizes).
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;

    -- Undeployed-only: the operator may INSERT new deployments but never
    -- UPDATE an existing deployment row (every row has department_id set,
    -- so any UPDATE touches a deployed row).
    IF v_is_operator AND TG_OP = 'UPDATE' AND OLD.department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Already deployed — vss_operator may only insert new (undeployed) deployments';
    END IF;

    v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
    v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept_id);
    v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
    v_open := v_override OR v_undeployed;

    IF v_undeployed AND NOT v_override THEN
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (
          SELECT 1 FROM public.deployments d
          WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
            AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      ELSIF OLD.department_id IS NOT NULL THEN
        RAISE EXCEPTION 'Already deployed — locked under this override';
      END IF;
    END IF;

    -- VSS rows skip the generic lock + deadline gate — they are gated by the
    -- VSS-specific effective switch in the VSS branch below (which raises
    -- 'VSS deployment is closed' when the switch is off). status='done'
    -- stays terminal. The operator skips it the same way (v_bypass).
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

    IF NOT (v_open OR v_is_vss OR v_is_operator) THEN
      IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF v_sched_status = 'done' THEN
        RAISE EXCEPTION 'This schedule is done — editing disabled';
      END IF;
      IF v_deadline IS NOT NULL AND now() > v_deadline THEN
        RAISE EXCEPTION 'Deadline has passed for this schedule';
      END IF;
    ELSIF v_sched_status = 'done' THEN
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
  END IF;

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

  -- Consent-given relaxation: VSS uses VSS open, regular uses generic v_open;
  -- bypass roles (admins + operator) are exempt, mirroring the v21 override.
  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
  -- Compute VSS openness for consent check (same as in block_after_deadline)
  SELECT COALESCE(
    (SELECT o.deployment_open FROM public.centre_vss_overrides o
     WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
     ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
    public.get_vss_deployment_open()
  ) INTO v_vss_open;
  IF v_is_vss THEN
    IF NOT v_consent.consent_given AND NOT (v_vss_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  ELSE
    IF NOT v_consent.consent_given AND NOT (v_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  -- V37 OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only): unlike the
  -- v36 bypass in the branch below (NOT v_bypass, which includes the
  -- operator), the operator honors the effective VSS switch via the
  -- canonical helper. Regular-population operator rows keep the v36
  -- bypass behavior unchanged.
  IF v_is_operator AND v_is_vss AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
    RAISE EXCEPTION 'VSS deployment is closed';
  END IF;

  IF v_is_vss THEN
    -- VSS switch: must be open via the VSS-specific effective switch,
    -- unless a bypass role (admins + operator) is writing.
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open;
    IF NOT v_bypass AND NOT v_vss_open THEN
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
    -- Regular: generic override already checked via v_open; now check sewadar switch only if not open
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open; -- dummy to avoid unused var warning
    IF NOT v_bypass AND NOT v_open
       AND NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.dp_sewadars s
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
        SELECT 1 FROM public.dp_sewadars s
        WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
          AND s.is_initiated = true
      ) THEN
        RAISE EXCEPTION 'This department requires initiated sewadars';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR COALESCE(OLD.deployed_department_id, OLD.department_id) IS DISTINCT FROM v_dept_id THEN
    -- V38: quota bypass for super_admin + vss_operator. All other gates
    -- (consent, eligibility, lock, deadline, done, switches) are untouched.
    IF NOT v_quota_bypass THEN
      v_quota := public.get_dept_quota_remaining(NEW.schedule_id, v_dept_id, NEW.centre);
      IF v_quota <= 0 THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- 2. check_deployment_batch — v36 body + quota bypass
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
  v_quota_bypass boolean;
BEGIN
  v_role := public.get_portal_user_role();
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');
  -- V38: super_admin + vss_operator may deploy beyond quota (Additional).
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

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
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from the count (v35).
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.dp_sewadars s
          WHERE s.badge_number = d.badge_number AND s.centre = d.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      -- V38: quota bypass (see above); the used/max computation stays
      -- so the numbers remain auditable in logs.
      IF NOT v_quota_bypass AND v_used > v_max THEN
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

-- 3. check_deployment_batch_upd — v36 body + quota bypass
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
  v_quota_bypass boolean;
BEGIN
  v_role := public.get_portal_user_role();
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');
  -- V38: super_admin + vss_operator may deploy beyond quota (Additional).
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  FOR r IN
    SELECT DISTINCT nr.schedule_id,
                    COALESCE(nr.deployed_department_id, nr.department_id) AS dept_id
    FROM new_rows nr
    JOIN old_rows o ON nr.id = o.id
    WHERE COALESCE(nr.deployed_department_id, nr.department_id) IS DISTINCT FROM COALESCE(o.deployed_department_id, o.department_id)
  LOOP
    IF NOT v_is_admin THEN
      -- a locked centre cannot deploy unless the Control Panel opened it
      -- (or the row is a VSS row — VSS is gated solely by its effective switch)
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
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from both counts (v35).
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.dp_sewadars s
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
          SELECT 1 FROM public.dp_sewadars s
          WHERE s.badge_number = o.badge_number AND s.centre = o.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = o.badge_number AND vs.centre = o.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      -- V38: quota bypass (see above).
      IF NOT v_quota_bypass AND v_used > v_max AND v_used > v_pre THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment_batch_upd ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_upd
  AFTER UPDATE ON public.deployments
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch_upd();

-- ------------------------------------------------------------
-- Verification queries (run after applying; expect the listed results)
-- ------------------------------------------------------------
-- 1. Functions carry the bypass:
--    SELECT proname FROM pg_proc WHERE proname LIKE 'check_deployment%';
--      → check_deployment, check_deployment_batch, check_deployment_batch_upd
-- 2. Bypass variable present in all three bodies:
--    SELECT count(*) FROM pg_proc
--     WHERE proname IN ('check_deployment','check_deployment_batch','check_deployment_batch_upd')
--       AND prosrc LIKE '%v_quota_bypass%';
--      → 3
-- 3. Behavioural: as a centre role, inserting past quota still raises
--    'Department quota already exhausted'; as super_admin / vss_operator
--    the same insert succeeds (verify on a scratch badge, then delete it).
