-- ============================================================
-- V4: VSS DEPLOYMENT
-- Adds:
--   1) vss_sewadars table (visit-only sewadars, imported from Excel)
--   2) per-department VSS rules (include_vss + VSS-specific restrictions)
--   3) two global master switches in portal_settings:
--        sewadar_deployment_open — gates ALL regular sewadar consent/deploy
--        vss_deployment_open     — gates ALL VSS consent/deploy
--   4) trigger enforcement (deployments + consents) for VSS eligibility
--      and both master switches. Quota stays SHARED between regular + VSS.
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER portal_setup, v2, v3.
-- Then run vss_sewadars_data.sql to import the 320 VSS sewadars.
-- ============================================================

-- ------------------------------------------------------------
-- 1. vss_sewadars: visit-only sewadars
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vss_sewadars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  badge_number text NOT NULL UNIQUE,
  sewadar_name text NOT NULL,
  father_husband_name text,
  dob text,
  gender text CHECK (gender IN ('MALE', 'FEMALE') OR gender IS NULL),
  badge_status text,
  centre text,
  department text,
  contact_no text,
  emergency_contact text,
  is_initiated boolean NOT NULL DEFAULT false,
  print_status text,
  form_status text,
  age_during_deployment integer,
  is_active boolean NOT NULL DEFAULT true,
  remarks text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vss_centre ON public.vss_sewadars(centre);

ALTER TABLE public.vss_sewadars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vss_sewadars_read ON public.vss_sewadars;
DROP POLICY IF EXISTS vss_sewadars_write ON public.vss_sewadars;
CREATE POLICY vss_sewadars_read ON public.vss_sewadars
  FOR SELECT TO authenticated USING (true);
CREATE POLICY vss_sewadars_write ON public.vss_sewadars
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- ------------------------------------------------------------
-- 2. deployment_departments: VSS rules
--    Only meaningful when include_vss = true
-- ------------------------------------------------------------
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS include_vss boolean NOT NULL DEFAULT false;
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS vss_min_days integer NOT NULL DEFAULT 1 CHECK (vss_min_days BETWEEN 1 AND 5);
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS vss_requires_stay_at_bhati boolean NOT NULL DEFAULT false;
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS vss_requires_initiated boolean NOT NULL DEFAULT false;
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS vss_requires_gender text
    CHECK (vss_requires_gender IS NULL OR vss_requires_gender IN ('MALE', 'FEMALE'));

-- ------------------------------------------------------------
-- 3. portal_settings: single global row with both master switches
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sewadar_deployment_open boolean NOT NULL DEFAULT true,
  vss_deployment_open boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO public.portal_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.portal_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_settings_read ON public.portal_settings;
DROP POLICY IF EXISTS portal_settings_write ON public.portal_settings;
CREATE POLICY portal_settings_read ON public.portal_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY portal_settings_write ON public.portal_settings
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));

CREATE OR REPLACE FUNCTION public.get_sewadar_deployment_open()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT sewadar_deployment_open FROM public.portal_settings WHERE id = 1), true)
$$;

CREATE OR REPLACE FUNCTION public.get_vss_deployment_open()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT vss_deployment_open FROM public.portal_settings WHERE id = 1), false)
$$;

-- ------------------------------------------------------------
-- 4. Triggers
-- ------------------------------------------------------------

-- Block consent/deployment edits when the relevant master switch is
-- closed, after the deadline, or when the schedule is done.
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

-- Enforce deployment rules: schedule open, consent eligibility, VSS rules,
-- both master switches, and shared quota.
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
BEGIN
  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
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
    IF public.get_portal_user_role() <> 'super_admin' THEN
      v_quota := public.get_remaining_quota(NEW.schedule_id, NEW.department_id);
      IF v_quota <= 0 THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
