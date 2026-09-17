-- ============================================================
-- V36: REUSABLE `vss_operator` ROLE — all-centre read + scoped
--      all-centre write (requested dept INSERT + consents + VSS)
-- ============================================================
-- Purpose:
--   Introduce ONE reusable portal role, `vss_operator`, for staff who
--   deploy undeployed sewadars and manage VSS across ALL centres from
--   the Consent & Deploy and VSS pages. No hardcoded emails/names —
--   any portal_users row with role='vss_operator' gets the powers.
--
--   What the operator CAN do (any centre):
--     • read everything the pages need (consents, deployments,
--       sewadars, vss_sewadars, vss_registrations)
--     • INSERT new (undeployed-only) deployments with a REQUESTED
--       department_id, plus create/update consent rows
--     • create VSS registrations + assign VSFB numbers (any centre)
--     • bypass deadline + centre lock (+ master/VSS switches),
--       like super_admin
--   What ALWAYS binds the operator (never bypassed):
--     • status='done', quota (incl. v35 ASO-dept exclusion),
--       min_days / stay-at-bhati / initiated / VSS rules, ELDERLY,
--       phantom-badge, FINAL/finalized (v15/v16), DEPLOYED freeze (v32)
--     • NEVER deployed_department_id (final) — only super_admin
--       (aso is read-only since v20); the setter raise keeps firing
--       for vss_operator. No Finalize tab, no Control Panel, no
--       schedule/department/allocation/override writes, no audit writes.
--
-- Run AFTER: v34 + v35 (batch bodies below are v35-based — they keep
-- the v35 AREA SECRETARY OFFICE quota exclusion verbatim; only the
-- bypass line gains the operator).
--
-- IDEMPOTENT + NON-DESTRUCTIVE — safe to re-run. Allowed operations
-- only: DROP CONSTRAINT IF EXISTS + ADD CHECK, DROP POLICY IF EXISTS
-- + CREATE POLICY, CREATE OR REPLACE FUNCTION. No data-table writes,
-- no data deletion. Second run succeeds with zero data loss.
--
-- MANUAL PROVISIONING (super_admin runs this once per operator in the
-- SQL editor — deliberately NOT part of this migration):
--   UPDATE public.portal_users SET role = 'vss_operator'
--   WHERE email = '<operator email>';
--
-- ROLLBACK (= reassign role + revert frontend):
--   1. UPDATE public.portal_users SET role = 'centre_user'
--      WHERE role = 'vss_operator';   -- manual, super_admin step
--   2. Revert the frontend role gating (see design doc).
--   3. Optionally re-run v20/v34/v35 to drop the operator arms from
--      policies/functions (this file is otherwise inert once no user
--      holds the role).
-- ============================================================

-- ------------------------------------------------------------
-- 0. portal_users role CHECK — add 'vss_operator' (v25 pattern).
--    Keeps every pre-existing value so current rows stay valid.
-- ------------------------------------------------------------
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner','vss_operator'));

-- ------------------------------------------------------------
-- 1. READS — all-centre read for the operator (v2/v5/v9 bodies +
--    OR get_portal_user_role()='vss_operator').
-- ------------------------------------------------------------
DROP POLICY IF EXISTS consent_read ON public.sewadar_consents;
CREATE POLICY consent_read ON public.sewadar_consents
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
  );

DROP POLICY IF EXISTS deploy_v2_read ON public.deployments;
CREATE POLICY deploy_v2_read ON public.deployments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
  );

DROP POLICY IF EXISTS vss_sewadars_read ON public.vss_sewadars;
CREATE POLICY vss_sewadars_read ON public.vss_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
  );

DROP POLICY IF EXISTS vss_registrations_read ON public.vss_registrations;
CREATE POLICY vss_registrations_read ON public.vss_registrations
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
  );

-- sewadar roster itself (v28 sewadars_portal_read body on dp_sewadars +
-- operator arm) — the Consent page lists sewadars of ANY centre for the
-- operator. NOTE: post-v28 the real table is dp_sewadars; public.sewadars
-- is only a read-only compat VIEW, and CREATE/DROP POLICY on a view
-- raises 42809 ("sewadars is not a table") — hence dp_sewadars here.
DROP POLICY IF EXISTS sewadars_portal_read ON public.dp_sewadars;
CREATE POLICY sewadars_portal_read ON public.dp_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
  );

-- ------------------------------------------------------------
-- 2. WRITES — v20 bodies + blanket operator arm.
--    CHOICE (documented): RLS grants the operator all-centre
--    INSERT/UPDATE/DELETE, and the ROW-LEVEL triggers below narrow it
--    to undeployed-only: UPDATE of an existing deployment row raises in
--    check_deployment (v36), DELETE of one raises in block_locked_delete
--    (v36), deployed regular rows raise in the v32 freeze triggers
--    (operator NOT exempt), finalized rows raise in v15/v16 (operator
--    NOT exempt). Net effect: INSERT new deployments + consent edits
--    for undeployed sewadars only.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS consent_write ON public.sewadar_consents;
CREATE POLICY consent_write ON public.sewadar_consents
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

DROP POLICY IF EXISTS deploy_v2_insert ON public.deployments;
CREATE POLICY deploy_v2_insert ON public.deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

DROP POLICY IF EXISTS deploy_v2_update ON public.deployments;
CREATE POLICY deploy_v2_update ON public.deployments
  FOR UPDATE TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

DROP POLICY IF EXISTS deploy_v2_delete ON public.deployments;
CREATE POLICY deploy_v2_delete ON public.deployments
  FOR DELETE TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- vss_registrations write — v9 body + blanket operator arm (any centre,
-- incl. assigned rows, like the admin arm; centre-role arm unchanged).
DROP POLICY IF EXISTS vss_registrations_write ON public.vss_registrations;
CREATE POLICY vss_registrations_write ON public.vss_registrations
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'aso', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'aso', 'vss_operator')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
      AND status IS DISTINCT FROM 'assigned'
    )
  );

-- ------------------------------------------------------------
-- 3. assign_vss_registration() — v6 body with the assign right moved
--    from aso to vss_operator (aso is read-only since v20; the
--    operator takes over VSFB assignment for ANY centre's
--    registrations). SECURITY DEFINER, so the roster INSERT inside
--    needs no vss_sewadars_write grant (which stays super_admin-only).
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

  SELECT * INTO v_reg FROM public.vss_registrations WHERE id = p_reg;
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
-- 4. guard_vss_registration_write — v21 body + operator bypass
--    (creation gate + deadline window do not bind the operator).
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
  IF v_role IN ('aso', 'super_admin', 'vss_operator') THEN
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
-- 5. block_after_deadline — v34 body + operator bypass (regular +
--    VSS rows: lock + switches + deadline do not bind the operator;
--    status='done' stays terminal for every role).
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
  IF public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator') THEN
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
-- 6. check_deployment — v34 body + vss_operator as a bypass role for
--    lock/deadline/switch/consent-given ONLY:
--      • v_bypass (= admin OR operator) replaces v_is_admin in the four
--        openness gates (generic lock/deadline, consent-given, VSS
--        switch, sewadar switch).
--      • the deployed_department_id setter raise stays EXCLUDING the
--        operator: the operator enters the ELSE branch, so setting the
--        final department raises 'Only ASO or Super Admin...'.
--      • undeployed-only: any UPDATE touching an existing deployment
--        row raises (department_id is NOT NULL on every row, so any
--        UPDATE = touching a deployed row). Upserts that hit an
--        existing row become UPDATEs and raise here too.
--      • quota + eligibility (min_days/stay/initiated/VSS rules) +
--        ELDERLY + phantom-badge (require_sewadar_exists, untouched)
--        bind every role, operator included.
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
-- 7. check_deployment_batch / _upd — v35 bodies VERBATIM except the
--    bypass line, which gains the operator (lock/deadline re-checks
--    skip bypass roles; quota incl. the v35 AREA SECRETARY OFFICE
--    exclusion + done re-checks still bind every role).
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
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');

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
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');

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
-- 8. block_locked_delete — v34 body + operator branch: bypasses the
--    centre lock like an admin, but undeployed-only — deleting an
--    existing deployment row raises (INSERT-only role). Consent-row
--    cleanup stays allowed; deployed-regular consent rows stay frozen
--    via the v32 freeze trigger and finalized rows via v15/v16
--    (operator is exempt from NEITHER — deliberately untouched).
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
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;

  -- V36 vss_operator: lock bypass like an admin, but undeployed-only.
  IF public.get_portal_user_role() = 'vss_operator' THEN
    IF TG_RELID = 'public.deployments'::regclass THEN
      EXECUTE 'SELECT ($1).department_id IS NOT NULL' USING OLD INTO v_op_deployed;
      IF v_op_deployed THEN
        RAISE EXCEPTION 'Already deployed — vss_operator may not delete deployment rows';
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
-- EXPLICITLY UNTOUCHED (operator gains NOTHING here):
--   • deployment_schedules / deployment_departments / centre_allocations
--     writes — super_admin only (v16 H1, v2).
--   • centre_overrides / centre_vss_overrides writes — super_admin only;
--     reads — aso/super_admin only (v21). Operator cannot open itself.
--   • portal_users writes — super_admin only (portal_setup).
--   • audit_log writes — super_admin (+aso arm kept, v18); no operator arm.
--   • finalized/final guards — block_finalized_delete (v15),
--     block_finalized_consent_edit + block_finalized_deploy_edit (v16):
--     operator NOT exempt.
--   • DEPLOYED freeze — freeze_deployed_rows (v32): operator NOT exempt.
--   • phantom-badge — require_sewadar_exists (v16 M4): binds every role.
--   • status='done' bypass — none of the v36 bypasses skip 'done'.
--   • vss_sewadars direct writes — vss_sewadars_write stays
--     super_admin-only (v4); roster rows arrive via the RPC above.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- VERIFICATION (paste into Supabase SQL editor after running):
-- ------------------------------------------------------------
-- -- 1. role CHECK accepts the new value (and keeps the old ones):
-- SELECT conname, pg_get_constraintdef(oid) AS def
-- FROM pg_constraint WHERE conname = 'portal_users_role_check';
-- -- Expected: CHECK (role IN ('centre_user','centre_admin','aso',
-- --   'super_admin','dept_incharge','scanner','vss_operator'))
--
-- -- 2. every recreated policy mentions vss_operator:
-- SELECT tablename, policyname FROM pg_policies
-- WHERE policyname IN ('consent_read','deploy_v2_read','vss_sewadars_read',
--   'vss_registrations_read','sewadars_portal_read','consent_write',
--   'deploy_v2_insert','deploy_v2_update','deploy_v2_delete',
--   'vss_registrations_write')
-- ORDER BY tablename, policyname;
-- -- then: SELECT policyname, pg_get_expr(qual,'public.deployments'::regclass)
-- -- FROM pg_policies WHERE ... AND policyname LIKE 'deploy_v2%' (spot-check
-- -- the OR 'vss_operator' arm in each expression).
--
-- -- 3. every recreated function body mentions vss_operator:
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('assign_vss_registration',
--   'guard_vss_registration_write','block_after_deadline',
--   'check_deployment','check_deployment_batch',
--   'check_deployment_batch_upd','block_locked_delete')
--   AND p.prosrc LIKE '%vss_operator%';
-- -- Expected: all 7 rows.
--
-- -- 4. freeze/finalized guards do NOT mention vss_operator (still bind it):
-- SELECT n.nspname || '.' || p.proname AS fn
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('freeze_deployed_rows','block_finalized_delete',
--   'block_finalized_consent_edit','block_finalized_deploy_edit',
--   'require_sewadar_exists')
--   AND p.prosrc LIKE '%vss_operator%';
-- -- Expected: zero rows.
