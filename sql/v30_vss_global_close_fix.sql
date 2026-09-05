-- ============================================================
-- V30: VSS GLOBAL CLOSE FIX — ensure VSS respects its own switch
-- ============================================================
-- Problem: `portal_settings.vss_deployment_open = false` (global
-- VSS closed) was still bypassed when a generic `centre_overrides`
-- row existed for the same schedule/centre. `block_after_deadline`
-- and `check_deployment` both did `IF NOT v_open THEN check VSS
-- switch` — so any `centre_overrides` presence (even for regular
-- sewadars) made `v_open = true` and the VSS switch was never
-- checked. Centres could mark VSS consent/deployment while the
-- super_admin dashboard showed "VSS deployment is CLOSED".
--
-- Fix: VSS deployment is now gated SOLELY by the VSS-specific
-- effective switch `vss_deploy_open_for_centre(centre)` (global
-- `vss_deployment_open` with the per-centre tri-state
-- `centre_vss_overrides` applied). A generic `centre_overrides`
-- row no longer reopens VSS past a closed VSS switch, past a
-- lock, or past the deadline. Regular sewadars keep the old
-- behaviour (generic override beats lock/switch/deadline).
--
-- VSS creation (vss_registrations) already used the correct
-- `vss_creation_open_for_centre` check — no change needed there.
--
-- Non-destructive; safe to re-run. Run AFTER v29.
-- ============================================================

-- ------------------------------------------------------------
-- 1. block_after_deadline — VSS vs regular split
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
  v_vss_override boolean;
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

  -- VSS branch: gated solely by the VSS-specific effective switch.
  -- A generic centre_overrides row must NOT reopen VSS when the
  -- VSS global switch is closed. Only a VSS tri-state override
  -- (centre_vss_overrides.deployment_open = true) makes v_vss_open true.
  IF v_is_vss THEN
    v_vss_open := public.vss_deploy_open_for_centre(NEW.centre);
    -- Check deployment_open tri-state for this centre (force-open)
    SELECT (o.deployment_open = true)
      INTO v_vss_override
      FROM public.centre_vss_overrides o
      WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
      ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END
      LIMIT 1;
    -- If no VSS override row, v_vss_override will be NULL — treat as not forced open
    v_vss_override := COALESCE(v_vss_override, false);

    IF NOT v_vss_open THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;

    -- Lock and deadline for VSS: only a VSS force-open bypasses them.
    -- Generic v_open must NOT bypass VSS lock/deadline.
    IF NOT v_vss_override AND public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
      RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
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

  -- Deadline check: VSS uses VSS override, regular uses generic v_open
  IF v_is_vss THEN
    IF NOT v_vss_override AND v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed — editing disabled';
    END IF;
  ELSE
    IF NOT v_open AND v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed — editing disabled';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 2. check_deployment — same VSS/regular split
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
  v_vss_override boolean;
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

    IF NOT v_open THEN
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
  -- For consent, we need to know if VSS is open (effective) OR if generic override is open for that vss cohort?
  -- Keep original: generic v_open relaxes consent for VSS too, but we now make VSS consent respect VSS switch first.
  -- If VSS switch is open (effective), consent may be No and still deploy under override — handled below.
  -- Determine if we are in an override-like state for consent:
  -- For VSS, overrideDeploy = v_vss_open OR (v_open AND v_is_vss) ? No — just v_vss_open true means VSS is open via tri-state.
  -- But generic override should NOT relax VSS consent either — keep consistent with block_after_deadline.
  -- So for VSS, use v_vss_open as the "open" that relaxes consent; for regular, use v_open.
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
    -- VSS switch: must be open via VSS tri-state, not generic
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

-- Re-attach other triggers (idempotent)
DROP TRIGGER IF EXISTS trg_block_after_deadline ON public.sewadar_consents;
CREATE TRIGGER trg_block_after_deadline
  BEFORE INSERT OR UPDATE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

DROP TRIGGER IF EXISTS trg_block_after_deadline_deploy ON public.deployments;
CREATE TRIGGER trg_block_after_deadline_deploy
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

-- ------------------------------------------------------------
-- Verification: VSS global closed must block despite generic override
-- ------------------------------------------------------------
-- SELECT public.vss_deploy_open_for_centre('GURGAON'); -- false when global closed and no VSS override
-- SELECT public.is_centre_override_open('<schedule>', 'GURGAON', null::uuid); -- true if generic wildcard exists
-- -- Try as centre_user:
-- -- INSERT INTO sewadar_consents ... with VS badge should raise 'VSS deployment is closed' even if centre_overrides exists
-- -- Regular sewadar should still be allowed via generic override past the switch

-- ------------------------------------------------------------
-- Optional cleanup helper: call this to clear stale VSS overrides
-- that keep VSS open after the super_admin globally closed it.
-- ------------------------------------------------------------
-- SELECT * FROM public.centre_vss_overrides WHERE deployment_open = true OR creation_open = true;
-- UPDATE public.centre_vss_overrides SET deployment_open = NULL WHERE deployment_open = true;
-- UPDATE public.centre_vss_overrides SET creation_open = NULL WHERE creation_open = true;

