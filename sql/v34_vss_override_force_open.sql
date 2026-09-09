-- ============================================================
-- V34: VSS IS GATED SOLELY BY ITS EFFECTIVE SWITCH (LOCK + DEADLINE
-- DO NOT BIND VSS)
-- ============================================================
-- Product rule (v30's stated intent, never fully implemented):
--   "VSS deployment is gated SOLELY by the VSS-specific effective switch
--    vss_deploy_open_for_centre(centre) — global vss_deployment_open with the
--    per-centre tri-state applied. A generic centre_overrides row must NOT
--    reopen VSS."
--
-- The ASO flips the GLOBAL VSS switches in the Control Panel and expects
-- centres to be able to mark VSS consent + deployment + add VSS, even after
-- the deadline and even when a centre has LOCKED deployment. That did not
-- work because the enforcement gates still made VSS rows subject to the
-- centre lock and the deadline unless a per-centre tri-state "Open" knob
-- existed:
--
--   1. block_after_deadline() (v30) — VSS branch bypassed lock + deadline
--      ONLY under an explicit tri-state row; global-only "Auto" still raised
--      "Deployment is locked by this centre" / "Deadline has passed".
--   2. check_deployment() (v30) — generic lock/deadline gate only honoured
--      GENERIC centre_overrides rows, so EVERY VSS deployment write on a
--      locked / past-deadline centre died even with a tri-state Open knob.
--   3. check_deployment_batch() / _upd() (v28) — same generic-only gap in the
--      AFTER-statement re-checks.
--   4. block_locked_delete() (v22) — deleting a VSS deployment / consent row
--      on a locked centre raised "Deployment is locked".
--
-- Fix (this file): for VSS rows, ALL of these gates now key off the VSS-
-- specific EFFECTIVE switch (vss_deploy_open_for_centre = global &&
-- COALESCE(override, true)):
--   • switch ON  → VSS consent + deployment fully open for the centre,
--                  regardless of centre lock or deadline
--   • switch OFF → "VSS deployment is closed" (v31 hard global: a per-centre
--                  Open knob cannot reopen it; a per-centre Closed knob can
--                  force-close)
--   • status='done' stays terminal; quotas + restriction rules always bind;
--     ASO-finalized rows stay frozen (v15/v16).
--
-- The per-centre tri-state still exists as a FORCE-CLOSE (Auto = follow the
-- global switch; Closed = force closed). This matches the Control Panel copy
-- "Auto = follow the global switches & deadline window · Open/Closed = force
-- for that centre".
--
-- Non-destructive; safe to re-run. Run AFTER v30 + v31. Supersedes the
-- earlier force-open-only draft of this file (re-run to upgrade in place).
-- ============================================================

-- ------------------------------------------------------------
-- 0. helper — informational: does an explicit VSS tri-state Open knob exist
--    for this centre? (specific-centre row wins over '*'). Used by
--    get_my_effective_gates so the UI / SQL console can tell force-open from
--    Auto-inherit. NOT required for the gates below (they use the effective
--    switch), but kept for transparency + the frontend banner distinction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vss_deployment_force_open(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT o.deployment_open = true
     FROM public.centre_vss_overrides o
     WHERE o.centre IN (public.get_root_centre(p_centre), '*')
     ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END
     LIMIT 1),
    false
  );
$$;

-- ------------------------------------------------------------
-- 1. block_after_deadline — VSS rows gated ONLY by the effective switch;
--    lock + deadline do NOT bind VSS.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_deadline timestamptz;
  v_is_vss boolean;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_dept uuid := NULL;
  v_old_dept uuid := NULL;
  v_vss_open boolean;
BEGIN
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_RELID = 'public.deployments'::regclass THEN
    EXECUTE 'SELECT COALESCE(($1).deployed_department_id, ($1).department_id)'
      USING NEW INTO v_dept;
    IF TG_OP <> 'INSERT' THEN
      EXECUTE 'SELECT ($1).department_id' USING OLD INTO v_old_dept;
    END IF;
  END IF;

  v_override := CASE
    WHEN TG_RELID = 'public.deployments'::regclass
      THEN public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept)
    ELSE public.is_any_centre_override_open(NEW.schedule_id, NEW.centre)
  END;
  v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
  v_open := v_override OR v_undeployed;

  -- VSS vs regular: determine which population this row is
  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  -- UNDEPLOYED-ONLY already-deployed freeze (kept for both populations)
  IF v_undeployed THEN
    IF TG_RELID = 'public.deployments'::regclass THEN
      IF NOT v_override THEN
        IF TG_OP = 'INSERT' THEN
          IF EXISTS (
            SELECT 1 FROM public.deployments d
            WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
              AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Already deployed — locked under this override';
          END IF;
        ELSIF v_old_dept IS NOT NULL THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      END IF;
    ELSE
      IF NOT public.is_any_normal_override_open(NEW.schedule_id, NEW.centre) THEN
        IF EXISTS (
          SELECT 1 FROM public.deployments d
          WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
            AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      END IF;
    END IF;
  END IF;

  -- VSS: gated SOLELY by the VSS-specific effective switch. When the switch
  -- is ON, the centre lock and the deadline do NOT bind VSS — the ASO opening
  -- VSS deployment reopens it for the centre (v30's stated intent). When it
  -- is OFF, raise closed (v31 hard global: a per-centre Open knob cannot
  -- reopen it). status='done' stays terminal below.
  IF v_is_vss THEN
    v_vss_open := public.vss_deploy_open_for_centre(NEW.centre);
    IF NOT v_vss_open THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;
  ELSE
    -- Regular sewadars: original logic — generic override bypasses lock/switch/deadline
    IF NOT v_open THEN
      IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;
      IF NOT public.get_sewadar_deployment_open() THEN
        RAISE EXCEPTION 'Sewadar deployment is closed';
      END IF;
    END IF;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;

  -- Deadline: binds regular rows (unless a generic override is open); VSS rows
  -- are already gated by the effective switch above.
  IF NOT v_is_vss AND NOT v_open AND v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_after_deadline ON public.sewadar_consents;
CREATE TRIGGER trg_block_after_deadline
  BEFORE INSERT OR UPDATE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

DROP TRIGGER IF EXISTS trg_block_after_deadline_deploy ON public.deployments;
CREATE TRIGGER trg_block_after_deadline_deploy
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

-- ------------------------------------------------------------
-- 2. check_deployment — VSS rows skip the generic lock/deadline gate; the VSS
--    branch below still raises 'VSS deployment is closed' when the switch is off.
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
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_vss_open boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    v_override := false;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
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
    -- stays terminal.
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

    IF NOT (v_open OR v_is_vss) THEN
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

  -- Consent-given relaxation: VSS uses VSS open, regular uses generic v_open
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
    IF NOT v_consent.consent_given AND NOT (v_vss_open OR v_is_admin) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  ELSE
    IF NOT v_consent.consent_given AND NOT (v_open OR v_is_admin) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  IF v_is_vss THEN
    -- VSS switch: must be open via the VSS-specific effective switch
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open;
    IF NOT v_is_admin AND NOT v_vss_open THEN
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
    IF NOT v_is_admin AND NOT v_open
       AND NOT public.get_sewadar_deployment_open() THEN
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
-- 3. check_deployment_batch / _upd — the AFTER-statement lock/deadline
--    re-checks exempt VSS rows entirely (the switch is enforced row-level in
--    check_deployment / block_after_deadline before the statement completes).
--    Quota + done checks unchanged.
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
        -- overridden rows still cannot write into a finished schedule
        SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
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
-- 4. block_locked_delete — VSS rows are exempt from the lock raise when the
--    VSS-specific effective switch is ON (a centre may clean up its own VSS
--    deployment / consent rows on a locked centre). Regular rows unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_locked_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_override boolean;
  v_undeployed boolean;
  v_old_dept uuid := NULL;
  v_vss_exempt boolean := false;
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;

  IF TG_RELID = 'public.deployments'::regclass THEN
    -- Reference department_id dynamically: sewadar_consents /
    -- department_incharges do not have this column, and a static
    -- OLD.department_id reference would fail to compile for those triggers.
    EXECUTE 'SELECT public.is_centre_override_open(($1).schedule_id, ($1).centre, ($1).department_id)'
      USING OLD INTO v_override;
  ELSE
    -- consents / incharges: only a centre-wide override reopens them
    v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, NULL::uuid);
  END IF;
  v_undeployed := public.is_centre_undeployed_override_open(OLD.schedule_id, OLD.centre);

  -- VSS rows are exempt from the lock raise while the VSS effective switch is
  -- ON — the ASO opening VSS reopens it for the centre. department_incharges
  -- has no badge_number column, so only deployments / sewadar_consents qualify.
  IF TG_RELID IN ('public.deployments'::regclass, 'public.sewadar_consents'::regclass) THEN
    EXECUTE 'SELECT (($1).badge_number ILIKE ''VS%''
                     OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = ($1).badge_number))
                     AND public.vss_deploy_open_for_centre(($1).centre)'
      USING OLD INTO v_vss_exempt;
  END IF;

  IF NOT (v_override OR v_undeployed OR v_vss_exempt) AND public.is_centre_locked(OLD.schedule_id, OLD.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;

  -- UNDEPLOYED-ONLY override: already-deployed deployment rows stay frozen
  -- even against a delete (the cohort that may be cleaned up is only the
  -- undeployed). Nest the check so OLD.department_id is only evaluated on
  -- the deployments table.
  IF v_undeployed AND NOT v_override AND TG_RELID = 'public.deployments'::regclass THEN
    EXECUTE 'SELECT ($1).department_id IS NOT NULL' USING OLD INTO v_old_dept;
    IF v_old_dept THEN
      RAISE EXCEPTION 'Already deployed — locked under this override';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_locked_delete_deploy ON public.deployments;
CREATE TRIGGER trg_block_locked_delete_deploy
  BEFORE DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

DROP TRIGGER IF EXISTS trg_block_locked_delete_consent ON public.sewadar_consents;
CREATE TRIGGER trg_block_locked_delete_consent
  BEFORE DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

-- ------------------------------------------------------------
-- 5. get_my_effective_gates — expose the effective VSS switch AND the
--    informational force-open knob so the frontend can show the right banner.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_effective_gates(p_schedule uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text;
  v_root text;
  v_open_all boolean;
  v_undeployed boolean;
  v_open_depts uuid[];
BEGIN
  v_centre := public.get_portal_user_centre();
  IF v_centre IS NULL THEN
    RETURN jsonb_build_object('admin', true);
  END IF;
  v_root := public.get_root_centre(v_centre);
  SELECT bool_or(o.department_id IS NULL AND (o.undeployed_only IS NOT TRUE)),
         bool_or(o.undeployed_only AND o.department_id IS NULL),
         array_agg(o.department_id) FILTER (WHERE o.department_id IS NOT NULL AND (o.undeployed_only IS NOT TRUE))
    INTO v_open_all, v_undeployed, v_open_depts
    FROM public.centre_overrides o
    WHERE o.schedule_id = p_schedule
      AND o.centre IN (v_root, '*');
  RETURN jsonb_build_object(
    'admin', public.get_portal_user_role() IN ('aso', 'super_admin'),
    'centre_wide_override_open', COALESCE(v_open_all, false),
    'undeployed_override_open', COALESCE(v_undeployed, false),
    'any_override_open',
      COALESCE(v_open_all, false) OR COALESCE(v_undeployed, false) OR COALESCE(array_length(v_open_depts, 1), 0) > 0,
    'open_departments', CASE WHEN COALESCE(v_open_all, false) OR COALESCE(v_undeployed, false) THEN NULL ELSE v_open_depts END,
    'vss_deployment_open', public.vss_deploy_open_for_centre(v_centre),
    'vss_deployment_force_open', public.vss_deployment_force_open(v_centre),
    'vss_creation_open', public.vss_creation_open_for_centre(v_centre),
    'locked', public.is_centre_locked(p_schedule, v_centre)
  );
END;
$$;

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- 1. Global switch + effective + force-open for a centre:
--    SELECT public.vss_deploy_open_for_centre('SECTOR-15-A'),
--           public.vss_deployment_force_open('SECTOR-15-A');
-- 2. Client gates RPC (now includes vss_deployment_open / vss_deployment_force_open):
--    SELECT public.get_my_effective_gates('<schedule uuid>');
-- 3. Scenario proof (LOCKED centre + PASSED deadline + global vss_deployment_open=true):
--    a centre-role VSS deployment INSERT / consent UPDATE should now succeed —
--    previously it raised 'Deployment is locked by this centre' /
--    'Deadline has passed for this schedule'.
