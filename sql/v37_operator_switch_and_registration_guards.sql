-- ============================================================
-- V37: OPERATOR VSS-SWITCH GATE + REGISTRATION GUARDS
-- ============================================================
-- Purpose:
--   Locked decision: role `vss_operator` (added in v36) HONORS the
--   effective VSS switch (fail-closed), and `aso` has zero
--   VSS-registration write surface (v20 read-only was regressed by
--   v36, which added an 'aso' arm to `vss_registrations_write` and to
--   the `guard_vss_registration_write` bypass). `done` schedules bind
--   everyone, including the operator.
--
--   1. OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only): recreated
--      `check_deployment`, `block_after_deadline`, `block_locked_delete`
--      (v36 bodies verbatim + inserted gate) raise
--      'VSS deployment is closed' when caller = vss_operator AND the row
--      is VSS-population AND NOT vss_deploy_open_for_centre(row.centre).
--      Regular-population operator rows keep v36 bypass behavior.
--   2. ASO REGISTRATION WRITE REMOVED: `vss_registrations_write`
--      recreated WITHOUT the 'aso' arm; `guard_vss_registration_write`
--      bypass drops 'aso' (keeps super_admin + vss_operator) and locks
--      VSFB-assigned rows against operator UPDATE/DELETE.
--   3. DONE-ORDERING: `block_after_deadline` resolves status='done'
--      BEFORE any bypass return; the `block_locked_delete` operator
--      branch checks 'done' before its bypass return.
--   4. ASSIGN LOCK: `assign_vss_registration` fetches the registration
--      row with SELECT ... FOR UPDATE. NO new unique index is created:
--      step-0 grep found vss_sewadars(badge_number) is already UNIQUE
--      (v4_vss.sql line 20, inline `badge_number text NOT NULL UNIQUE`,
--      auto-named constraint `vss_sewadars_badge_number_key`; v6 adds no
--      further badge constraint/index and no `uq_vss_sewadars_badge`
--      exists anywhere in sql/).
--   5. PHOTO RLS: storage `vss-photos` read policy recreated with an
--      added vss_operator arm; storage delete extended so vss_operator
--      may delete reg/ objects.
--
-- Run AFTER: v36.
--
-- IDEMPOTENT + NON-DESTRUCTIVE — safe to re-run. Allowed operations
-- only: DROP POLICY IF EXISTS + CREATE POLICY, CREATE OR REPLACE
-- FUNCTION. Zero data writes, zero data deletion.
--
-- MANUAL APPLY: run this file in the Supabase SQL editor.
-- ROLLBACK: re-run sql/v36_vss_operator.sql (restores the v36 bodies).
-- ============================================================

-- ------------------------------------------------------------
-- 1. vss_registrations write — v36 body MINUS the 'aso' arm
--    (v20: aso is read-only). Keeps super_admin + vss_operator
--    blanket arms and the centre-role subtree arm unchanged.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS vss_registrations_write ON public.vss_registrations;
CREATE POLICY vss_registrations_write ON public.vss_registrations
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  );

-- ------------------------------------------------------------
-- 2. guard_vss_registration_write — v36 body with 'aso' REMOVED
--    from the early-return bypass (keeps super_admin +
--    vss_operator), plus a VSFB-assigned lock for the operator:
--    vss_operator with TG_OP <> 'INSERT' on an assigned row raises.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_vss_registration_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_centre text;
  v_ov_creation boolean;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IN ('super_admin', 'vss_operator') THEN
    IF v_role = 'vss_operator' AND TG_OP <> 'INSERT' AND OLD.status = 'assigned' THEN
      RAISE EXCEPTION 'VSFB-assigned registration is locked';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_centre := CASE WHEN TG_OP = 'DELETE' THEN OLD.centre ELSE NEW.centre END;
  v_ov_creation := public.centre_vss_creation_override(v_centre);

  IF TG_OP = 'INSERT' THEN
    IF NOT public.vss_creation_open_for_centre(v_centre) THEN
      IF v_ov_creation IS FALSE THEN
        RAISE EXCEPTION 'Adding VSS is currently closed for your centre by the ASO';
      END IF;
      IF NOT public.get_vss_creation_open() THEN
        RAISE EXCEPTION 'Adding VSS is currently closed by the ASO';
      END IF;
      RAISE EXCEPTION 'The deadline has passed — adding VSS is disabled';
    END IF;
  ELSE  -- UPDATE / DELETE
    IF NOT COALESCE(v_ov_creation, public.vss_creation_window_open()) THEN
      RAISE EXCEPTION 'The deadline has passed — VSS registrations can no longer be changed';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_a_guard_vss_registration ON public.vss_registrations;
CREATE TRIGGER trg_a_guard_vss_registration
  BEFORE INSERT OR UPDATE OR DELETE ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.guard_vss_registration_write();

-- ------------------------------------------------------------
-- 3. assign_vss_registration() — v36 body with the registration
--    fetch changed to SELECT ... FOR UPDATE (serializes concurrent
--    assigns of the same registration). Allow-list stays
--    ('super_admin','vss_operator'). SECURITY DEFINER + search_path
--    preserved. No new unique index: vss_sewadars(badge_number) is
--    already UNIQUE via the v4 inline column constraint
--    (auto-named `vss_sewadars_badge_number_key`), so a concurrent
--    duplicate VSFB insert still fails on the constraint.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_vss_registration(p_reg uuid, p_vsfb text, p_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg public.vss_registrations%ROWTYPE;
  v_role text;
  v_roster_id uuid;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('super_admin', 'vss_operator') THEN
    RAISE EXCEPTION 'Only Super Admin or VSS Operator can assign VSS numbers';
  END IF;

  IF p_vsfb IS NULL OR btrim(p_vsfb) = '' THEN
    RAISE EXCEPTION 'VSS number is required';
  END IF;
  IF p_vsfb !~ '^VS' THEN
    RAISE EXCEPTION 'VSS number must start with VS';
  END IF;

  SELECT * INTO v_reg FROM public.vss_registrations WHERE id = p_reg FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Registration not found';
  END IF;
  IF v_reg.status = 'assigned' THEN
    RAISE EXCEPTION 'This registration already has an assigned VSS number';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vss_sewadars WHERE badge_number = p_vsfb) THEN
    RAISE EXCEPTION 'This VSS number is already in use';
  END IF;

  INSERT INTO public.vss_sewadars (
    badge_number, sewadar_name, father_husband_name, dob, gender, badge_status,
    centre, department, contact_no, emergency_contact, is_initiated,
    print_status, form_status, is_active, remarks, aadhar_number
  ) VALUES (
    p_vsfb, v_reg.sewadar_name, v_reg.father_husband_name, v_reg.dob, v_reg.gender,
    'VSS', v_reg.centre, 'SANGAT', v_reg.contact_no, v_reg.emergency_contact,
    v_reg.is_initiated, 'ReadyToPrint-VSS', 'Approved', true, NULL, v_reg.aadhar_number
  )
  RETURNING id INTO v_roster_id;

  UPDATE public.vss_registrations
  SET status = 'assigned',
      assigned_badge_number = p_vsfb,
      assigned_by = p_by,
      assigned_at = now()
  WHERE id = p_reg;

  INSERT INTO public.audit_log (action, table_name, record_id, schedule_id, payload, acted_by)
  VALUES ('ASSIGN_VSS', 'vss_sewadars', v_roster_id, NULL,
    jsonb_build_object(
      'registration_id', p_reg,
      'temp_vss_id', v_reg.temp_vss_id,
      'badge_number', p_vsfb,
      'centre', v_reg.centre,
      'name', v_reg.sewadar_name
    ),
    p_by);

  RETURN p_vsfb;
END;
$$;

-- ------------------------------------------------------------
-- 4. block_after_deadline — v36 body with TWO v37 changes:
--    (a) DONE-ORDERING: the schedule status SELECT + 'done' RAISE are
--        moved ABOVE every bypass return, so status='done' binds every
--        role including vss_operator. (The original done re-check
--        further below is kept verbatim; it is unreachable but harmless.)
--    (b) OPERATOR VSS-SWITCH GATE: the operator keeps the v36 bypass
--        for regular-population rows, but VSS-population rows raise
--        'VSS deployment is closed' unless the effective VSS switch is
--        open for the row's centre.
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
  -- V37 DONE-ORDERING: 'done' binds EVERY role including vss_operator —
  -- resolve it BEFORE any bypass return.
  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;

  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  -- V37 OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only): the
  -- operator keeps the v36 bypass for regular rows, but VSS rows honor
  -- the effective VSS switch.
  IF public.get_portal_user_role() = 'vss_operator' THEN
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
    IF v_is_vss AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;
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
-- 5. check_deployment — v36 body VERBATIM plus ONE inserted block:
--    the OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only). The
--    operator honors the effective VSS switch via the canonical
--    vss_deploy_open_for_centre() helper; regular-population operator
--    rows keep the v36 v_bypass behavior unchanged (incl. the
--    deployed_department_id setter raise, undeployed-only UPDATE raise,
--    quota + eligibility binding every role).
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
  v_is_operator boolean;
  v_bypass boolean;
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
-- 6. block_locked_delete — v36 body with TWO v37 changes inside
--    the operator branch ONLY (rest verbatim):
--    (a) DONE-ORDERING: a status='done' check raises BEFORE any
--        bypass return, so done schedules bind the operator.
--    (b) OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only):
--        VSS-population rows raise 'VSS deployment is closed' unless
--        the effective VSS switch is open for the row's centre.
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
  v_op_deployed boolean := false;
  v_sched_status text;
  v_vss_closed boolean := false;
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;

  -- V36 vss_operator: lock bypass like an admin, but undeployed-only.
  -- V37: 'done' binds the operator, and VSS rows honor the VSS switch.
  IF public.get_portal_user_role() = 'vss_operator' THEN
    SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = OLD.schedule_id;
    IF v_sched_status = 'done' THEN
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
    IF TG_RELID = 'public.deployments'::regclass THEN
      EXECUTE 'SELECT ($1).department_id IS NOT NULL' USING OLD INTO v_op_deployed;
      IF v_op_deployed THEN
        RAISE EXCEPTION 'Already deployed — vss_operator may not delete deployment rows';
      END IF;
    END IF;
    -- department_incharges has no badge_number column, so only
    -- deployments / sewadar_consents qualify for the VSS gate.
    IF TG_RELID IN ('public.deployments'::regclass, 'public.sewadar_consents'::regclass) THEN
      EXECUTE 'SELECT (($1).badge_number ILIKE ''VS%''
                       OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = ($1).badge_number))
                       AND NOT public.vss_deploy_open_for_centre(($1).centre)'
        USING OLD INTO v_vss_closed;
      IF v_vss_closed THEN
        RAISE EXCEPTION 'VSS deployment is closed';
      END IF;
    END IF;
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
-- 7. PHOTO RLS — storage `vss-photos`:
--    (a) read policy: v16 body verbatim + one added vss_operator arm
--        on the exact v16 role-check expression.
--    (b) delete policy: v9 body verbatim + the vss_operator arm, so
--        the operator may delete reg/ objects (owner-or-admin
--        structure preserved). Insert/update policies untouched.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS vss_photos_read ON storage.objects;
CREATE POLICY vss_photos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'vss-photos'
    AND (
      owner_id::text = auth.uid()::text
      OR public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
      OR (
        public.get_portal_user_role() IN ('centre_user', 'centre_admin')
        AND EXISTS (
          SELECT 1 FROM public.vss_registrations r
          WHERE (r.photo_url = name OR r.photo_url LIKE '%/vss-photos/' || name)
            AND r.centre = ANY (public.get_my_subtree_centres())
        )
      )
    )
  );

DROP POLICY IF EXISTS vss_photos_delete ON storage.objects;
CREATE POLICY vss_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'vss-photos'
    AND (owner_id::text = auth.uid()::text OR public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator'))
  );

-- ------------------------------------------------------------
-- EXPLICITLY UNTOUCHED (operator gains NOTHING here):
--   • deployment_schedules / deployment_departments / centre_allocations
--     writes — super_admin only (v16 H1, v2).
--   • centre_overrides / centre_vss_overrides writes — super_admin only;
--     reads — aso/super_admin only (v21). Operator cannot open itself.
--   • portal_users writes — super_admin only (portal_setup).
--   • audit_log writes — super_admin (+aso arm kept, v18); no operator arm.
--   • finalized/final guards — block_finalized_delete (v15),
--     block_finalized_consent_edit + block_finalized_deploy_edit (v16):
--     operator NOT exempt (this file does not touch them).
--   • DEPLOYED freeze — freeze_deployed_rows (v32): operator NOT exempt.
--   • phantom-badge — require_sewadar_exists (v16 M4): binds every role.
--   • check_deployment_batch / check_deployment_batch_upd — NOT recreated
--     here; their v36 bypass lines are unchanged.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- VERIFICATION (paste into Supabase SQL editor after running):
-- ------------------------------------------------------------
-- -- (a) no vss_registrations policy mentions 'aso':
-- SELECT policyname, cmd FROM pg_policies
-- WHERE tablename = 'vss_registrations'
--   AND (COALESCE(qual, '') LIKE '%''aso''%' OR COALESCE(with_check, '') LIKE '%''aso''%');
-- -- Expected: zero rows.
-- --
-- -- (b) switch-gated functions contain both 'vss_operator' and
-- -- 'vss_deploy_open_for_centre':
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('check_deployment', 'block_after_deadline', 'block_locked_delete')
--   AND p.prosrc LIKE '%vss_operator%'
--   AND p.prosrc LIKE '%vss_deploy_open_for_centre%';
-- -- Expected: all 3 rows.
-- --
-- -- (b2) assign fn: 'vss_operator' + 'FOR UPDATE':
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'assign_vss_registration'
--   AND p.prosrc LIKE '%vss_operator%'
--   AND p.prosrc LIKE '%FOR UPDATE%';
-- -- Expected: 1 row.
-- --
-- -- (b3) guard bypass keeps operator, drops aso:
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'guard_vss_registration_write'
--   AND p.prosrc LIKE '%vss_operator%'
--   AND p.prosrc NOT LIKE '%''aso''%';
-- -- Expected: 1 row.
-- --
-- -- (c) freeze/finalized guards do NOT mention vss_operator (still bind it):
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('freeze_deployed_rows', 'block_finalized_delete',
--   'block_finalized_consent_edit', 'block_finalized_deploy_edit',
--   'require_sewadar_exists')
--   AND p.prosrc LIKE '%vss_operator%';
-- -- Expected: zero rows.
