-- ============================================================
-- V21: SUPERADMIN CONTROL PANEL — per-centre permission overrides
-- (phase-2 hardening)
-- ============================================================
-- Gives the super_admin a Control Panel (frontend tab, super_admin
-- only) that can selectively REOPEN deployment work past the normal
-- gates (deadline passed / master switch off / centre locked):
--
--   centre_overrides      presence of a row = OPEN for that scope
--     • centre '*'        → ALL centres, otherwise the root CENTRE
--                           (its SC_SPs inherit, same as quotas/locks)
--     • department_id NULL→ all departments (full centre unlock),
--                           otherwise just THAT department
--     • scope of an open: bypasses centre-lock + master switch +
--       deadline. It NEVER bypasses status='done' (reopen the
--       schedule instead) and never touches quota or restriction
--       rules (min_days / bhati / initiated still bind).
--     • Frozen rows: anything the ASO already FINALIZED
--       (deployed_department_id set) stays untouchable — that is
--       universal v15/v16 protection, an override adds nothing.
--
--   centre_vss_overrides  tri-state VSS knobs per centre ('*' = all)
--     • creation_open     NULL = inherit (global switch ∧ window)
--                         TRUE = force open, FALSE = force closed
--     • deployment_open   NULL = inherit global VSS-deployment switch
--                         TRUE = force open, FALSE = force closed
--
-- Consent-vs-department scoping: a DEPARTMENT-scoped override opens
-- deployments into that department only; consent rows reopen only
-- through a CENTRE-WIDE (department_id IS NULL) override.
--
-- Non-destructive; safe to re-run. Run AFTER portal_setup + v2…v20.
-- (Self-sufficient for the v19 switch/window helpers: a drifted DB without
-- v19 would otherwise abort at creation time, because SQL-language function
-- bodies are validated against referenced functions. Run v19 anyway — the
-- Add-VSS gate UI writes depend on it.)
-- ============================================================

-- ------------------------------------------------------------
-- 0. prerequisites (exact copies of the v19 definitions) so this
--    file also runs on databases that skipped v19
-- ------------------------------------------------------------
ALTER TABLE public.portal_settings
  ADD COLUMN IF NOT EXISTS vss_creation_open boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.get_vss_creation_open()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT vss_creation_open FROM public.portal_settings WHERE id = 1;
$$;

CREATE OR REPLACE FUNCTION public.vss_creation_window_open()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deployment_schedules
    WHERE status = 'open'
      AND (deadline IS NULL OR deadline > now())
  );
$$;

-- ------------------------------------------------------------
-- 1. tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.centre_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  centre text NOT NULL DEFAULT '*',            -- '*' = ALL centres, else root CENTRE
  department_id uuid REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  undeployed_only boolean NOT NULL DEFAULT false, -- when true: opens deployment for the
                                                  -- UNDEPLOYED cohort only (consent=No OR
                                                  -- yes-not-deployed) to ANY allocated
                                                  -- department within quota. Already-deployed
                                                  -- sewadars (a deployment row with a
                                                  -- requested/final department) stay frozen.
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
-- idempotent for databases created before this column existed
ALTER TABLE public.centre_overrides ADD COLUMN IF NOT EXISTS undeployed_only boolean NOT NULL DEFAULT false;
-- unique per scope (NULL department collapses to a sentinel so Postgres
-- treats "all departments" as one distinct value per centre). undeployed_only
-- is part of the key so a centre may hold BOTH a normal and an undeployed-only
-- override simultaneously (they are independent signals).
DROP INDEX IF EXISTS uq_centre_overrides_scope;
CREATE UNIQUE INDEX uq_centre_overrides_scope
  ON public.centre_overrides (
    schedule_id, centre,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    undeployed_only
  );
CREATE INDEX IF NOT EXISTS idx_centre_overrides_schedule ON public.centre_overrides(schedule_id);

CREATE TABLE IF NOT EXISTS public.centre_vss_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre text NOT NULL UNIQUE,                 -- '*' = ALL centres, else root CENTRE
  creation_open boolean,                       -- NULL = inherit global switch + window
  deployment_open boolean,                     -- NULL = inherit global VSS-deployment switch
  updated_by text,
  updated_at timestamptz DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. helpers (SECURITY DEFINER: readable inside triggers, RLS-proof)
-- ------------------------------------------------------------
-- Is deployment writing open for this centre (+ optional department)?
-- p_department NULL  → only centre-wide/global rows count (consents)
-- p_department given → that department's scoped rows count too
CREATE OR REPLACE FUNCTION public.is_centre_override_open(
  p_schedule uuid, p_centre text, p_department uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.centre_overrides o
    WHERE o.schedule_id = p_schedule
      AND o.centre IN (public.get_root_centre(p_centre), '*')
      -- undeployed-only rows are a DIFFERENT signal (handled by
      -- is_centre_undeployed_override_open) and must not behave as a full
      -- centre/department unlock.
      AND (o.undeployed_only IS NULL OR o.undeployed_only = false)
      AND (
        (p_department IS NULL AND o.department_id IS NULL)
        OR (p_department IS NOT NULL AND (o.department_id IS NULL OR o.department_id = p_department))
      )
  );
$$;

-- True if ANY override row exists for this centre (centre-wide OR department-
-- scoped). Consent rows carry no department, so they cannot be matched to a
-- single opened department — a department-scoped override therefore reopens
-- consent editing for the whole centre (the ASO opened its deployment for a
-- purpose; the centre may fix consent before assigning to the opened dept).
CREATE OR REPLACE FUNCTION public.is_any_centre_override_open(
  p_schedule uuid, p_centre text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.centre_overrides o
    WHERE o.schedule_id = p_schedule
      AND o.centre IN (public.get_root_centre(p_centre), '*')
  );
$$;

-- True if an UNDEPLOYED-ONLY override is active for this centre: a row with
-- undeployed_only = true and department_id IS NULL (centre-wide, all depts).
-- Under such an override the centre may deploy the UNDEPLOYED cohort (consent
-- No OR consent Yes-but-not-yet-assigned) to ANY allocated department within
-- quota; sewadars who ALREADY have a deployment row with a requested/final
-- department stay frozen at the DB (see block_after_deadline / check_deployment).
CREATE OR REPLACE FUNCTION public.is_centre_undeployed_override_open(
  p_schedule uuid, p_centre text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.centre_overrides o
    WHERE o.schedule_id = p_schedule
      AND o.centre IN (public.get_root_centre(p_centre), '*')
      AND o.department_id IS NULL
      AND o.undeployed_only = true
  );
$$;

-- True if any NON-undeployed (normal) override row exists for this centre. Used
-- by the undeployed-only cohort gate: when an undeployed override is the ONLY
-- override active, already-deployed sewadars stay frozen — but a normal full
-- override that is also present takes precedence and opens everything.
CREATE OR REPLACE FUNCTION public.is_any_normal_override_open(
  p_schedule uuid, p_centre text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.centre_overrides o
    WHERE o.schedule_id = p_schedule
      AND o.centre IN (public.get_root_centre(p_centre), '*')
      AND (o.undeployed_only IS NULL OR o.undeployed_only = false)
  );
$$;

-- Raw tri-state VSS creation knob for a centre (NULL = inherit).
CREATE OR REPLACE FUNCTION public.centre_vss_creation_override(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.creation_open
  FROM public.centre_vss_overrides o
  WHERE o.centre IN (public.get_root_centre(p_centre), '*')
  ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END
  LIMIT 1;
$$;

-- Effective VSS CREATION gate for a centre: override wins, else the
-- global switch AND the open-schedule window (the v19 INSERT rule).
CREATE OR REPLACE FUNCTION public.vss_creation_open_for_centre(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.centre_vss_creation_override(p_centre),
    public.get_vss_creation_open() AND public.vss_creation_window_open()
  );
$$;

-- Effective VSS DEPLOYMENT switch for a centre: override wins, else global.
CREATE OR REPLACE FUNCTION public.vss_deploy_open_for_centre(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT o.deployment_open
     FROM public.centre_vss_overrides o
     WHERE o.centre IN (public.get_root_centre(p_centre), '*')
     ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END
     LIMIT 1),
    public.get_vss_deployment_open()
  );
$$;

-- Client-side gating: what the calling user's centre may do right now.
-- Admins are exempt everywhere, so they get the resolved switches back.
--
-- Override signals (mirror is_centre_override_open semantics):
--   centre_wide_override_open — a CENTRE-WIDE / global override row exists.
--       This reopens CONSENT editing too (a department-scoped unlock does not).
--   any_override_open        — ANY override row exists for this centre
--       (centre-wide OR department-scoped). This reopens DEPLOYMENT writing.
--   open_departments         — when an override is active: NULL means the
--       centre-wide/global row opens ALL departments; otherwise the array
--       lists the department ids a department-scoped override opened. The UI
--       uses this to disable non-open departments while a scoped unlock is on.
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
         bool_or(o.undeployed_only),
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
    'vss_creation_open', public.vss_creation_open_for_centre(v_centre),
    'locked', public.is_centre_locked(p_schedule, v_centre)
  );
END;
$$;

-- ------------------------------------------------------------
-- 3. block_after_deadline (consents + deployments row gate)
--    An open override bypasses lock + master switch + deadline for
--    that centre — never status='done'.
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
BEGIN
  -- Super Admin keep working after the deadline (aso is read-only since v20,
  -- but keep both roles exempt for safety)
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  -- Control Panel override. On deployments the row's target department counts
  -- (a department-scoped unlock opens only that dept); on consents there is no
  -- department column, so ANY override for the centre reopens consent editing.
  -- This trigger fires BEFORE trg_check_deployment (name order), so without the
  -- department the dept-scoped unlock would die right here.
  v_override := CASE
    WHEN TG_RELID = 'public.deployments'::regclass
      THEN public.is_centre_override_open(
             NEW.schedule_id, NEW.centre,
             COALESCE(NEW.deployed_department_id, NEW.department_id))
    ELSE public.is_any_centre_override_open(NEW.schedule_id, NEW.centre)
  END;
  v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
  v_open := v_override OR v_undeployed;

  -- UNDEPLOYED-ONLY override: already-deployed sewadars stay frozen even while
  -- the undeployed cohort is open. "Already deployed" = a deployment row with a
  -- requested/final department. Consent edits on those rows are also blocked.
  -- This gate fires whenever an undeployed override is active for the centre,
  -- UNLESS a normal (non-undeployed) override is also active — that one takes
  -- precedence and opens everything. We key on is_any_normal_override_open() so a
  -- department-scoped normal override (which makes is_any_centre_override_open()
  -- true) still counts as "a normal override is present".
  IF v_undeployed AND NOT public.is_any_normal_override_open(NEW.schedule_id, NEW.centre) THEN
    IF TG_RELID = 'public.deployments'::regclass THEN
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
    ELSIF EXISTS (
      SELECT 1 FROM public.deployments d
      WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
        AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Already deployed — locked under this override';
    END IF;
  END IF;

  IF NOT v_open THEN
    -- A locked centre cannot edit consent/deployment (regular + VSS)
    IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
      RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
    END IF;

    -- Master switches gate ALL centre-role consent/deploy writes
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
    IF v_is_vss THEN
      IF NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
        RAISE EXCEPTION 'VSS deployment is closed';
      END IF;
    ELSE
      IF NOT public.get_sewadar_deployment_open() THEN
        RAISE EXCEPTION 'Sewadar deployment is closed';
      END IF;
    END IF;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF NOT v_open AND v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 4. check_deployment — override-aware closure gates; the
--    consent_given requirement relaxes under an override (product
--    decision: consent yes OR no may be deployed once opened, as
--    long as the ASO has not finalized them). Rules + quota still bind.
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
    v_override := false;
  ELSE
    -- Centre roles may never set the FINAL deployed department.
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

    -- UNDEPLOYED-ONLY override: already-deployed sewadars stay frozen even
    -- while the undeployed cohort is open. "Already deployed" = a deployment
    -- row with a requested department.
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
    ELSIF v_sched_status = 'done' THEN
      -- an override reopens work, but never a finished schedule
      RAISE EXCEPTION 'This schedule is done — editing disabled';
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
  IF NOT v_consent.consent_given AND NOT (v_open OR v_is_admin) THEN
    RAISE EXCEPTION 'Consent not given for this sewadar';
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  IF v_is_vss THEN
    IF NOT v_is_admin AND NOT v_open
       AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
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

  -- Quota (shared across regular + VSS): on insert or when the effective
  -- department changes, judged against the ROW's centre root. Overrides
  -- never lift quotas — allocate seats first (Control Panel → additional
  -- department).
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
-- 5. batch re-checks — same override-awareness for the closure
--    scans (quota loops unchanged)
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
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
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
      -- a locked centre cannot deploy unless the Control Panel opened it
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
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
-- 6. DELETE guard — an open override lets the centre clean up
--    UNFINALIZED rows (e.g. consent flipped to No) even while
--    locked / past the deadline. Finalized rows stay protected by
--    v15 regardless.
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
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;

  IF TG_RELID = 'public.deployments'::regclass THEN
    v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, OLD.department_id);
  ELSE
    -- consents / incharges: only a centre-wide override reopens them
    v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, NULL::uuid);
  END IF;
  v_undeployed := public.is_centre_undeployed_override_open(OLD.schedule_id, OLD.centre);

  IF NOT (v_override OR v_undeployed) AND public.is_centre_locked(OLD.schedule_id, OLD.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;

  -- UNDEPLOYED-ONLY override: already-deployed deployment rows stay frozen even
  -- against a delete (the cohort that may be cleaned up is only the undeployed).
  IF v_undeployed AND NOT v_override AND TG_RELID = 'public.deployments'::regclass AND OLD.department_id IS NOT NULL THEN
    RAISE EXCEPTION 'Already deployed — locked under this override';
  END IF;
  RETURN OLD;
END;
$$;

-- ------------------------------------------------------------
-- 6b. lock CREATOR follows the override too — a centre working under
--     an opened override may finish and lock even though the switch
--     is off / deadline passed. The incharge compulsion below still
--     applies; status='done' stays terminal.
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
  v_override boolean;
BEGIN
  -- Only centre roles go through the compulsion; admins manage locks directly.
  IF public.get_portal_user_role() NOT IN ('centre_user', 'centre_admin') THEN
    RETURN NEW;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;

  v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, NULL::uuid)
              OR public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
  IF NOT v_override THEN
    IF v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed — editing disabled';
    END IF;
    IF NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
    END IF;
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

-- trigger binding survives CREATE OR REPLACE, but recreate for drifted DBs
DROP TRIGGER IF EXISTS trg_check_centre_lock ON public.centre_locks;
CREATE TRIGGER trg_check_centre_lock
  BEFORE INSERT ON public.centre_locks
  FOR EACH ROW EXECUTE FUNCTION public.check_centre_lock();

-- ------------------------------------------------------------
-- 7. incharge writes follow the override too (a department-scoped
--    unlock permits that department's incharge changes)
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
  v_override boolean;
BEGIN
  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_sched_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;

  v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, NEW.department_id)
              OR public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
  IF NOT v_override THEN
    IF v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed — editing disabled';
    END IF;

    -- a locked centre cannot change incharges either
    IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
      RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
    END IF;
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
-- 8. VSS registration guard — per-centre tri-state overrides
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
  IF v_role IN ('aso', 'super_admin') THEN
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

-- recreate the trigger (function replaced above, trigger unchanged —
-- kept for self-sufficiency on drifted databases)
DROP TRIGGER IF EXISTS trg_a_guard_vss_registration ON public.vss_registrations;
CREATE TRIGGER trg_a_guard_vss_registration
  BEFORE INSERT OR UPDATE OR DELETE ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.guard_vss_registration_write();

-- ------------------------------------------------------------
-- 9. RLS — admins read; super_admin writes (the Control Panel)
-- ------------------------------------------------------------
ALTER TABLE public.centre_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS centre_overrides_read ON public.centre_overrides;
CREATE POLICY centre_overrides_read ON public.centre_overrides
  FOR SELECT TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));

DROP POLICY IF EXISTS centre_overrides_write ON public.centre_overrides;
CREATE POLICY centre_overrides_write ON public.centre_overrides
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

ALTER TABLE public.centre_vss_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS centre_vss_overrides_read ON public.centre_vss_overrides;
CREATE POLICY centre_vss_overrides_read ON public.centre_vss_overrides
  FOR SELECT TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));

DROP POLICY IF EXISTS centre_vss_overrides_write ON public.centre_vss_overrides;
CREATE POLICY centre_vss_overrides_write ON public.centre_vss_overrides
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- 1. Override resolution honours root-centre + wildcard scopes:
--    SELECT public.is_centre_override_open('<schedule uuid>', 'Some SC_SP', NULL::uuid);
-- 2. Effective VSS knobs for a centre:
--    SELECT public.vss_creation_open_for_centre('CENTRE'), public.vss_deploy_open_for_centre('CENTRE');
-- 3. Client gates RPC:
--    SELECT public.get_my_effective_gates('<schedule uuid>');
-- 4. Trigger list on deployments:
--    SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.deployments'::regclass
--      AND NOT tgisinternal ORDER BY tgname;
