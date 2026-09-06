-- ============================================================
-- V22: AREA SECRETARY OFFICE DEPARTMENT RESTRICTION
-- ============================================================
-- Sewadars whose department is "AREA SECRETARY OFFICE" cannot be
-- deployed by centre admins — only super_admin can deploy them.
--
-- This migration adds a DB trigger that:
--   1) Checks if the sewadar's department (from sewadars.department
--      or vss_sewadars.department) is 'AREA SECRETARY OFFICE'
--   2) If so, only allows the INSERT/UPDATE if the caller is
--      super_admin (via get_portal_user_role())
--   3) Raises an exception otherwise
--
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER v21_centre_control_panel.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Block AREA SECRETARY OFFICE deployments from centre roles
-- ------------------------------------------------------------
-- Runs BEFORE INSERT OR UPDATE on deployments.
-- Looks up the sewadar's department from sewadars or vss_sewadars,
-- then checks the caller's role via get_portal_user_role().

CREATE OR REPLACE FUNCTION public.block_aas_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dept text;
  v_role text;
BEGIN
  -- Get the sewadar's department
  SELECT department INTO v_dept
  FROM public.sewadars
  WHERE badge_number = NEW.badge_number
    AND centre = NEW.centre
  LIMIT 1;

  IF v_dept IS NULL THEN
    -- Try VSS sewadars
    SELECT department INTO v_dept
    FROM public.vss_sewadars
    WHERE badge_number = NEW.badge_number
      AND centre = NEW.centre
    LIMIT 1;
  END IF;

  -- If department is AREA SECRETARY OFFICE, only super_admin may deploy
  IF v_dept IS NOT NULL AND trim(upper(v_dept)) = 'AREA SECRETARY OFFICE' THEN
    v_role := public.get_portal_user_role();
    IF v_role IS NULL OR v_role != 'super_admin' THEN
      RAISE EXCEPTION 'AREA SECRETARY OFFICE sewadars can only be deployed by Super Admin';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_aas_deployment ON public.deployments;
CREATE TRIGGER trg_block_aas_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_aas_deployment();

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- -- A centre role trying to deploy an AREA SECRETARY OFFICE sewadar
-- -- should get the error above. Super_admin should succeed.
-- -- Test with:
-- -- SET LOCAL ROLE authenticated;
-- -- SET request.jwt.claims TO '{"role": "centre_admin"}';
-- -- INSERT INTO public.deployments (...) VALUES (...); -- should fail
