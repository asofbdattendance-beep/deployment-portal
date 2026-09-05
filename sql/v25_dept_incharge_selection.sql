-- ============================================================
-- V25: DEPARTMENT INCHARGE SELECTION — 2 per CENTRE × department
-- Superadmin/ASO pick 2 incharges per department from:
--   • the centre's existing department_incharges pool (preferred)
--   • any deployed sewadar in that dept (1% fallback)
-- New roles: dept_incharge, scanner
-- NON-DESTRUCTIVE — safe to re-run.
-- ============================================================

-- 1. extend portal_users role CHECK to include new roles
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner'));

-- 2. table: department_incharge_selections (the 2 selected)
CREATE TABLE IF NOT EXISTS public.department_incharge_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  centre text NOT NULL, -- root CENTRE (like quotas/locks)
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  badge_number text NOT NULL,
  sewadar_name text,
  rank smallint NOT NULL CHECK (rank IN (1,2)),
  is_from_pool boolean NOT NULL DEFAULT true, -- true if badge was in department_incharges pool
  selected_by text,
  selected_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE (schedule_id, centre, department_id, rank),
  UNIQUE (schedule_id, centre, department_id, badge_number)
);
CREATE INDEX IF NOT EXISTS idx_incharge_sel_schedule ON public.department_incharge_selections(schedule_id);
CREATE INDEX IF NOT EXISTS idx_incharge_sel_centre ON public.department_incharge_selections(centre);
CREATE INDEX IF NOT EXISTS idx_incharge_sel_badge ON public.department_incharge_selections(badge_number);

-- 3. helpers
CREATE OR REPLACE FUNCTION public.is_dept_incharge(p_schedule uuid, p_department uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.department_incharge_selections s
    WHERE s.schedule_id = p_schedule
      AND s.badge_number = (
        SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()
      )
      AND (p_department IS NULL OR s.department_id = p_department)
      AND public.get_root_centre(s.centre) = public.get_root_centre(public.get_portal_user_centre())
  );
$$;

CREATE OR REPLACE FUNCTION public.get_my_dept_ids(p_schedule uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(department_id), '{}'::uuid[])
  FROM public.department_incharge_selections s
  WHERE s.schedule_id = p_schedule
    AND s.badge_number = (SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid())
    AND public.get_root_centre(s.centre) = public.get_root_centre(public.get_portal_user_centre())
$$;

CREATE OR REPLACE FUNCTION public.is_scanner()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.get_portal_user_role() = 'scanner';
$$;

-- 4. RLS
ALTER TABLE public.department_incharge_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incharge_sel_read ON public.department_incharge_selections;
CREATE POLICY incharge_sel_read ON public.department_incharge_selections
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso','super_admin','dept_incharge','scanner')
    OR public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
    OR public.is_dept_incharge(schedule_id)
  );

DROP POLICY IF EXISTS incharge_sel_write ON public.department_incharge_selections;
CREATE POLICY incharge_sel_write ON public.department_incharge_selections
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('aso','super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso','super_admin'));

-- 5. guard: badge must be deployed to that department (requested or finalized) and consented
CREATE OR REPLACE FUNCTION public.check_incharge_selection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_is_pool boolean;
BEGIN
  -- only ASO/super_admin may pick
  IF public.get_portal_user_role() NOT IN ('aso','super_admin') THEN
    RAISE EXCEPTION 'Only ASO can select department incharges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.deployment_schedules WHERE id = NEW.schedule_id AND status='open') THEN
    RAISE EXCEPTION 'Schedule not open';
  END IF;
  -- must be deployed to that department (effective)
  IF NOT EXISTS (
    SELECT 1 FROM public.deployments d
    WHERE d.schedule_id = NEW.schedule_id
      AND d.badge_number = NEW.badge_number
      AND COALESCE(d.deployed_department_id, d.department_id) = NEW.department_id
      AND public.get_root_centre(d.centre) = public.get_root_centre(NEW.centre)
  ) THEN
    RAISE EXCEPTION 'Sewadar must be deployed to this department';
  END IF;
  -- pool flag auto-set
  SELECT EXISTS(
    SELECT 1 FROM public.department_incharges i
    WHERE i.schedule_id = NEW.schedule_id AND i.centre = NEW.centre AND i.department_id = NEW.department_id AND i.badge_number = NEW.badge_number
  ) INTO v_is_pool;
  NEW.is_from_pool := v_is_pool;
  IF NOT v_is_pool THEN
    -- fallback allowed but flagged; no exception
    NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_check_incharge_selection ON public.department_incharge_selections;
CREATE TRIGGER trg_check_incharge_selection BEFORE INSERT OR UPDATE ON public.department_incharge_selections FOR EACH ROW EXECUTE FUNCTION public.check_incharge_selection();

-- VERIFY
-- SELECT * FROM public.department_incharge_selections;
-- SELECT public.is_dept_incharge('<schedule>'), public.get_my_dept_ids('<schedule>');
