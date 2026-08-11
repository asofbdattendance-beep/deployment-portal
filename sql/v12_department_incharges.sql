-- ============================================================
-- V12: DEPARTMENT INCHARGES
-- Each CENTRE nominates ONE incharge per allocated department
-- ("one incharge from one centre for one department").
-- Centre roles pick the incharge from sewadars of their subtree
-- who consented AND were assigned (requested) to that department.
-- The UNIQUE key enforces one incharge per (schedule, centre, dept).
-- NON-DESTRUCTIVE — safe to re-run. Run after v11 in Supabase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.department_incharges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  centre text NOT NULL,
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  badge_number text NOT NULL,
  sewadar_name text,
  created_at timestamptz DEFAULT now(),
  created_by text,
  UNIQUE (schedule_id, centre, department_id)
);
CREATE INDEX IF NOT EXISTS idx_incharge_schedule ON public.department_incharges(schedule_id);
CREATE INDEX IF NOT EXISTS idx_incharge_centre ON public.department_incharges(centre);

-- ------------------------------------------------------------
-- Guard trigger: incharge must be a consented sewadar assigned
-- to the department, and the schedule must still be editable
-- (not done / past deadline).
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
      AND d.badge_number = NEW.badge_number AND d.department_id = NEW.department_id
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
-- RLS: everyone may read (aso/super_admin + same-CENTRE users);
-- centre roles write only for their own CENTRE's departments.
-- ------------------------------------------------------------
ALTER TABLE public.department_incharges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incharge_read ON public.department_incharges;
CREATE POLICY incharge_read ON public.department_incharges
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
  );

DROP POLICY IF EXISTS incharge_write ON public.department_incharges;
CREATE POLICY incharge_write ON public.department_incharges
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      public.get_root_centre(centre) = public.get_root_centre(public.get_portal_user_centre())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );
