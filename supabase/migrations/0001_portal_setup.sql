-- ============================================================
-- DEPLOYMENT PORTAL SETUP
-- Run this in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- TABLE: portal_users (separate auth table for this portal)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.portal_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  badge_number TEXT,
  centre TEXT,
  role TEXT NOT NULL,
  permissions JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Migrate existing table: add centre column if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'portal_users' AND column_name = 'centre'
  ) THEN
    ALTER TABLE public.portal_users ADD COLUMN centre TEXT;
  END IF;
END $$;

-- Migrate existing table: update role CHECK constraint
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user', 'centre_admin', 'aso', 'super_admin'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_users_auth_id ON public.portal_users(auth_id);

-- ============================================================
-- TABLE: deployment_departments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.deployment_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABLE: deployment_schedules (named visit — v2+ shape)
-- Super admin creates a named schedule; deadline optional.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.deployment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  deadline timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- TABLE: deployments
-- Centre users request a department per sewadar per schedule
-- ============================================================
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

CREATE INDEX IF NOT EXISTS idx_deployments_centre ON public.deployments(centre);
CREATE INDEX IF NOT EXISTS idx_deployments_schedule ON public.deployments(schedule_id);

-- ============================================================
-- HELPER: get portal user role (SECURITY DEFINER bypasses RLS)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_portal_user_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.portal_users
  WHERE auth_id = auth.uid() AND is_active = true;
  IF v_role IS NULL THEN RETURN NULL; END IF;
  RETURN v_role;
END;
$$;

-- ============================================================
-- HELPER: get portal user centre
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_portal_user_centre()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text;
BEGIN
  SELECT centre INTO v_centre FROM public.portal_users
  WHERE auth_id = auth.uid() AND is_active = true;
  IF v_centre IS NULL THEN RETURN NULL; END IF;
  RETURN v_centre;
END;
$$;

-- ============================================================
-- HELPER: get portal profile (SECURITY DEFINER)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_portal_profile()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
BEGIN
  SELECT row_to_json(pu.*) INTO v_result
  FROM public.portal_users pu
  WHERE pu.auth_id = auth.uid() AND pu.is_active = true;
  RETURN v_result;
END;
$$;

-- ============================================================
-- RLS: portal_users
-- ============================================================
ALTER TABLE public.portal_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_users_read ON public.portal_users;
DROP POLICY IF EXISTS portal_users_write ON public.portal_users;

CREATE POLICY portal_users_read ON public.portal_users
  FOR SELECT TO authenticated
  USING (
    auth_id = auth.uid()
    OR public.get_portal_user_role() IN ('aso', 'super_admin')
  );

CREATE POLICY portal_users_write ON public.portal_users
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

-- ============================================================
-- RLS: deployment_departments
-- ============================================================
ALTER TABLE public.deployment_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dept_depts_read ON public.deployment_departments;
DROP POLICY IF EXISTS dept_depts_write ON public.deployment_departments;

CREATE POLICY dept_depts_read ON public.deployment_departments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY dept_depts_write ON public.deployment_departments
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));

-- ============================================================
-- RLS: deployment_schedules
-- ============================================================
ALTER TABLE public.deployment_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sched_read ON public.deployment_schedules;
DROP POLICY IF EXISTS sched_write ON public.deployment_schedules;

CREATE POLICY sched_read ON public.deployment_schedules
  FOR SELECT TO authenticated USING (true);

CREATE POLICY sched_write ON public.deployment_schedules
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));

-- ============================================================
-- RLS: deployments
-- ============================================================
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deploy_read ON public.deployments;
DROP POLICY IF EXISTS deploy_insert ON public.deployments;
DROP POLICY IF EXISTS deploy_update ON public.deployments;
DROP POLICY IF EXISTS deploy_delete ON public.deployments;

-- Read: own centre for centre_user/centre_admin; all for aso/super_admin
CREATE POLICY deploy_read ON public.deployments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = public.get_portal_user_centre()
  );

-- Insert: own centre for centre_user/centre_admin; any for super_admin
CREATE POLICY deploy_insert ON public.deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = public.get_portal_user_centre()
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- Update: centre_admin can update their centre's pending/locked; super_admin any
CREATE POLICY deploy_update ON public.deployments
  FOR UPDATE TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = public.get_portal_user_centre()
      AND public.get_portal_user_role() = 'centre_admin'
    )
  )
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = public.get_portal_user_centre()
      AND public.get_portal_user_role() = 'centre_admin'
    )
  );

-- Delete: centre_admin can delete their centre's pending; super_admin any
CREATE POLICY deploy_delete ON public.deployments
  FOR DELETE TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = public.get_portal_user_centre()
      AND public.get_portal_user_role() = 'centre_admin'
      AND status = 'pending'
    )
  );

-- ============================================================
-- VIEW: vw_my_centre_sewadars
-- Centre-scoped sewadar list for deployment
-- ============================================================
CREATE OR REPLACE VIEW public.vw_my_centre_sewadars AS
SELECT s.badge_number, s.sewadar_name, s.centre, s.department, s.badge_status
FROM public.sewadars s
WHERE s.badge_number IS NOT NULL;
