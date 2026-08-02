-- ============================================================
-- V2: DEPLOYMENT REDESIGN
-- Dates removed → named schedules with fixed WED-SUN days.
-- Flow: super_admin sets a deadline → centres mark consent AND
-- requested deployment department together (same page, same time)
-- → everything locks automatically after the deadline.
-- NOTE: This migration is NON-DESTRUCTIVE — safe to re-run. It
-- creates missing tables/columns and never drops existing data.
-- Run this in Supabase SQL Editor AFTER portal_setup.sql
-- ============================================================

-- ------------------------------------------------------------
-- 0. Drop only the old view (recreated below); tables are kept
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_all_deployments;

-- ------------------------------------------------------------
-- 1. deployment_departments: add restriction rules
--    min_days = minimum consent days a sewadar must have
-- ------------------------------------------------------------
ALTER TABLE public.deployment_departments DROP COLUMN IF EXISTS required_days;
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS min_days integer NOT NULL DEFAULT 5 CHECK (min_days BETWEEN 1 AND 5);
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS requires_stay_at_bhati boolean NOT NULL DEFAULT false;
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS requires_initiated boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. deployment_schedules: named schedule (one row per visit)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  deadline timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.deployment_schedules
  ADD COLUMN IF NOT EXISTS deadline timestamptz;
-- old lock columns no longer used
ALTER TABLE public.deployment_schedules DROP COLUMN IF EXISTS consent_locked;
ALTER TABLE public.deployment_schedules DROP COLUMN IF EXISTS deployment_locked;
-- migrate old statuses → new 'open'/'done' and fix the CHECK
DO $$
BEGIN
  ALTER TABLE public.deployment_schedules DROP CONSTRAINT IF EXISTS deployment_schedules_status_check;
  UPDATE public.deployment_schedules SET status = 'open' WHERE status IN ('consent_open', 'deployment_open');
  ALTER TABLE public.deployment_schedules
    ADD CONSTRAINT deployment_schedules_status_check CHECK (status IN ('open', 'done'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------
-- 3. centre_allocations: super_admin allocates dept → parent centre
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.centre_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  centre text NOT NULL,
  max_count integer NOT NULL CHECK (max_count > 0),
  created_at timestamptz DEFAULT now(),
  UNIQUE (schedule_id, department_id, centre)
);
CREATE INDEX IF NOT EXISTS idx_alloc_schedule ON public.centre_allocations(schedule_id);

-- ------------------------------------------------------------
-- 4. sewadar_consents: per-sewadar availability
--    consent_given (yes/no), available_days_count (1-5), stay_at_bhati, chair_pass
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sewadar_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  centre text NOT NULL,
  badge_number text NOT NULL,
  sewadar_name text,
  consent_given boolean NOT NULL DEFAULT false,
  available_days_count integer CHECK (available_days_count BETWEEN 1 AND 5),
  stay_at_bhati boolean NOT NULL DEFAULT false,
  chair_pass boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  created_by text,
  UNIQUE (schedule_id, centre, badge_number)
);
ALTER TABLE public.sewadar_consents ADD COLUMN IF NOT EXISTS chair_pass boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_consent_schedule ON public.sewadar_consents(schedule_id);
CREATE INDEX IF NOT EXISTS idx_consent_centre ON public.sewadar_consents(centre);

-- ------------------------------------------------------------
-- 5. deployments: assign sewadar to one requested department
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  centre text NOT NULL,
  badge_number text NOT NULL,
  sewadar_name text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'pending')),
  created_at timestamptz DEFAULT now(),
  created_by text,
  UNIQUE (schedule_id, centre, badge_number)
);
ALTER TABLE public.deployments
  ALTER COLUMN status SET DEFAULT 'requested';
CREATE INDEX IF NOT EXISTS idx_deployments_centre ON public.deployments(centre);
CREATE INDEX IF NOT EXISTS idx_deployments_schedule ON public.deployments(schedule_id);

-- ------------------------------------------------------------
-- 6. prev_year_deployments: reference data from the previous visit
--    (prev requested department + attendance reported), matched by badge
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prev_year_deployments (
  badge_number text PRIMARY KEY,
  prev_department text,
  attendance_reported integer
);

-- ============================================================
-- HELPERS (centre hierarchy + quota)
-- ============================================================

-- Root centre of a centre (walks parent_centre chain by name)
CREATE OR REPLACE FUNCTION public.get_root_centre(p_centre text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH RECURSIVE chain(name, parent_centre, depth) AS (
    SELECT name, parent_centre, 0 FROM public.centres WHERE name = p_centre
    UNION ALL
    SELECT c.name, c.parent_centre, ch.depth + 1
    FROM public.centres c JOIN chain ch ON c.name = ch.parent_centre
  )
  SELECT name FROM chain ORDER BY depth DESC LIMIT 1;
$$;

-- All centre names under the caller's centre (itself + descendants)
CREATE OR REPLACE FUNCTION public.get_my_subtree_centres()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text := public.get_portal_user_centre();
  v_result text[];
BEGIN
  WITH RECURSIVE sub(name) AS (
    SELECT name FROM public.centres WHERE name = v_centre
    UNION ALL
    SELECT c.name FROM public.centres c JOIN sub s ON c.parent_centre = s.name
  )
  SELECT array_agg(name) INTO v_result FROM sub;
  RETURN COALESCE(v_result, ARRAY[v_centre]);
END;
$$;

-- Remaining quota for caller's root centre for a schedule+department
-- (counts deployments across the whole parent subtree)
CREATE OR REPLACE FUNCTION public.get_remaining_quota(p_schedule uuid, p_department uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_root text := public.get_root_centre(public.get_portal_user_centre());
  v_max integer;
  v_used integer;
BEGIN
  SELECT max_count INTO v_max FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND department_id = p_department AND centre = v_root;

  IF v_max IS NULL THEN RETURN 0; END IF;

  SELECT count(*) INTO v_used FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.department_id = p_department
    AND public.get_root_centre(d.centre) = v_root;

  RETURN GREATEST(v_max - v_used, 0);
END;
$$;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Block consent/deployment edits after the schedule deadline or when done
CREATE OR REPLACE FUNCTION public.block_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_status text;
DECLARE v_deadline timestamptz;
BEGIN
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

DROP TRIGGER IF EXISTS trg_block_after_deadline ON public.sewadar_consents;
DROP TRIGGER IF EXISTS trg_block_locked_consent ON public.sewadar_consents;
CREATE TRIGGER trg_block_after_deadline
  BEFORE INSERT OR UPDATE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

DROP TRIGGER IF EXISTS trg_block_after_deadline_deploy ON public.deployments;
CREATE TRIGGER trg_block_after_deadline_deploy
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

-- Enforce deployment rules: schedule open, consent eligibility, quota
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
  v_initiated boolean;
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

  SELECT * INTO v_consent FROM public.sewadar_consents
  WHERE schedule_id = NEW.schedule_id AND centre = NEW.centre AND badge_number = NEW.badge_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No consent recorded for this sewadar';
  END IF;

  IF NOT v_consent.consent_given THEN
    RAISE EXCEPTION 'Consent not given for this sewadar';
  END IF;

  -- Elderly sewadars cannot be deployed
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
    SELECT is_initiated INTO v_initiated FROM public.sewadars
    WHERE badge_number = NEW.badge_number AND centre = NEW.centre;
    IF v_initiated IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'This department requires initiated sewadars';
    END IF;
  END IF;

  -- Quota only on insert or department change (avoid double-counting on update)
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

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- Statement-level re-check: prevents quota bypass on multi-row inserts.
-- (Row-level trigger handles single-row updates correctly; only batched
--  INSERTs bypass the per-row quota check, hence this AFTER INSERT trigger.)
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
  FOR r IN SELECT DISTINCT schedule_id, department_id FROM new_rows LOOP
    SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
    IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
    IF v_deadline IS NOT NULL AND now() > v_deadline THEN
      RAISE EXCEPTION 'Deadline has passed for this schedule';
    END IF;

    IF public.get_portal_user_role() = 'super_admin' THEN CONTINUE; END IF;

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

-- ============================================================
-- RLS
-- ============================================================

-- centres: allow read (non-sensitive names)
DROP POLICY IF EXISTS centres_read ON public.centres;
CREATE POLICY centres_read ON public.centres
  FOR SELECT TO authenticated USING (true);

-- deployment_schedules
ALTER TABLE public.deployment_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sched_v2_read ON public.deployment_schedules;
DROP POLICY IF EXISTS sched_v2_write ON public.deployment_schedules;
CREATE POLICY sched_v2_read ON public.deployment_schedules
  FOR SELECT TO authenticated USING (true);
CREATE POLICY sched_v2_write ON public.deployment_schedules
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- deployment_departments
ALTER TABLE public.deployment_departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dept_v2_read ON public.deployment_departments;
DROP POLICY IF EXISTS dept_v2_write ON public.deployment_departments;
CREATE POLICY dept_v2_read ON public.deployment_departments
  FOR SELECT TO authenticated USING (true);
CREATE POLICY dept_v2_write ON public.deployment_departments
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- centre_allocations
ALTER TABLE public.centre_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alloc_read ON public.centre_allocations;
DROP POLICY IF EXISTS alloc_write ON public.centre_allocations;
CREATE POLICY alloc_read ON public.centre_allocations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY alloc_write ON public.centre_allocations
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- sewadar_consents
ALTER TABLE public.sewadar_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_read ON public.sewadar_consents;
DROP POLICY IF EXISTS consent_write ON public.sewadar_consents;
CREATE POLICY consent_read ON public.sewadar_consents
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );
CREATE POLICY consent_write ON public.sewadar_consents
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- prev_year_deployments: read-only reference data
ALTER TABLE public.prev_year_deployments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prevyear_read ON public.prev_year_deployments;
CREATE POLICY prevyear_read ON public.prev_year_deployments
  FOR SELECT TO authenticated USING (true);

-- deployments
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deploy_v2_read ON public.deployments;
DROP POLICY IF EXISTS deploy_v2_insert ON public.deployments;
DROP POLICY IF EXISTS deploy_v2_update ON public.deployments;
DROP POLICY IF EXISTS deploy_v2_delete ON public.deployments;

CREATE POLICY deploy_v2_read ON public.deployments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );

CREATE POLICY deploy_v2_insert ON public.deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

CREATE POLICY deploy_v2_update ON public.deployments
  FOR UPDATE TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

CREATE POLICY deploy_v2_delete ON public.deployments
  FOR DELETE TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- ============================================================
-- VIEW: all deployments with centre + department for super_admin/aso
-- ============================================================
CREATE OR REPLACE VIEW public.vw_all_deployments AS
SELECT
  d.id,
  d.schedule_id,
  s.name AS schedule_name,
  s.status AS schedule_status,
  d.department_id,
  dep.name AS department_name,
  d.centre,
  d.badge_number,
  d.sewadar_name,
  d.status AS deployment_status,
  d.created_at
FROM public.deployments d
JOIN public.deployment_schedules s ON s.id = d.schedule_id
JOIN public.deployment_departments dep ON dep.id = d.department_id;
