-- ============================================================
-- FIX: block_locked_delete() — OLD.department_id on wrong table
--
-- PostgreSQL does NOT short-circuit AND in PL/pgSQL boolean
-- expressions. The flat chain:
--
--   ... AND TG_RELID = 'public.deployments'::regclass
--        AND OLD.department_id IS NOT NULL
--
-- evaluates OLD.department_id even when the trigger fires on
-- sewadar_consents (which has no department_id column), causing:
--
--   ERROR: 42703: record "old" has no field "department_id"
--
-- Fix: nest the department_id check inside the TG_RELID guard
-- so it is only evaluated on the deployments table.
-- ============================================================

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
  -- Nest the check: PG doesn't short-circuit AND, so OLD.department_id must only
  -- be evaluated when TG_RELID confirms we're on the deployments table (sewadar_consents
  -- and department_incharges have no department_id column).
  IF v_undeployed AND NOT v_override AND TG_RELID = 'public.deployments'::regclass THEN
    IF OLD.department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Already deployed — locked under this override';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
