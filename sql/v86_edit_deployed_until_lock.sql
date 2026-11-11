-- ============================================================
-- V86: CENTRE ROLES MAY EDIT DEPLOYED SEWADARS UNTIL THE CENTRE LOCKS
-- Run AFTER v85.
--
-- Why: v32 froze a regular sewadar for centre_user / centre_admin the
-- moment a department was assigned — "even before lock". In practice a
-- centre assigns, notices a mistake (wrong department, consent should be
-- No, wrong stay/chair flag) and is stuck until the ASO intervenes.
-- The intended workflow is: edit freely while preparing, then press
-- "Lock deployment" — the lock is the commit point.
--
-- What: freeze_deployed_rows() keeps the same triggers and the same
-- function name, but for centre roles the freeze now applies only when
-- the centre's editing window is CLOSED:
--   • the centre (root) is locked                      (centre_locks)
--   • the sewadar deployment master switch is off      (portal_settings)
--   • the schedule deadline has passed / status 'done'
-- A normal Control Panel override still reopens deployed rows exactly
-- as in v32 (department-scoped for deployments, centre-wide for
-- consents). The undeployed-only override still never unfreezes.
--
-- Unchanged:
--   • aso / super_admin bypass.
--   • VSS sewadars exempt (VSS switches govern them, v30).
--   • vss_operator: full v32 freeze (undeployed-only role, v36).
--   • ASO-finalized rows (deployed_department_id) stay protected by
--     v15/v16 triggers — this migration does not touch them.
--   • Quota / eligibility (check_deployment + _batch), lock / deadline /
--     switch gates on INSERT/UPDATE (block_after_deadline) and DELETE
--     (block_locked_delete) keep running as before. This function is the
--     only one that gated DELETE on deadline/switch for deployed rows, so
--     it keeps doing so for centre roles.
--
-- Non-destructive; re-runnable.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.freeze_deployed_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_is_vss boolean;
  v_is_deployed boolean := false;
  v_override boolean;
  v_status text;
  v_deadline timestamptz;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_is_vss := OLD.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = OLD.badge_number);
  IF v_is_vss THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'deployments' THEN
    v_is_deployed := OLD.department_id IS NOT NULL;
    IF v_is_deployed THEN
      v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, OLD.department_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'sewadar_consents' THEN
    v_is_deployed := EXISTS (
      SELECT 1 FROM public.deployments d
      WHERE d.schedule_id = OLD.schedule_id
        AND d.centre = OLD.centre
        AND d.badge_number = OLD.badge_number
        AND d.department_id IS NOT NULL
    );
    IF v_is_deployed THEN
      v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, NULL::uuid);
    END IF;
  END IF;

  IF NOT v_is_deployed OR v_override THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- vss_operator keeps the strict v32 freeze (it may only add the undeployed).
  IF v_role = 'vss_operator' THEN
    RAISE EXCEPTION 'This sewadar is already deployed — ask the ASO to adjust the deployment.';
  END IF;

  -- Centre roles: deployed rows stay editable while the window is open.
  IF public.is_centre_locked(OLD.schedule_id, OLD.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;
  IF NOT public.get_sewadar_deployment_open() THEN
    RAISE EXCEPTION 'Sewadar deployment is closed';
  END IF;
  SELECT status, deadline INTO v_status, v_deadline
  FROM public.deployment_schedules WHERE id = OLD.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Triggers are unchanged from v32 (re-created so this file stands alone).
DROP TRIGGER IF EXISTS trg_a_freeze_deployed_deploy ON public.deployments;
CREATE TRIGGER trg_a_freeze_deployed_deploy
  BEFORE UPDATE OR DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.freeze_deployed_rows();

DROP TRIGGER IF EXISTS trg_a_freeze_consent_of_deployed ON public.sewadar_consents;
CREATE TRIGGER trg_a_freeze_consent_of_deployed
  BEFORE UPDATE OR DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.freeze_deployed_rows();

-- Version registry (v50 convention: append own row only).
INSERT INTO public.portal_version (version) VALUES ('v86')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (run as a centre_user of an UNLOCKED centre, before deadline)
--
-- 1. Change a deployed sewadar's department → succeeds (quota still applies).
-- 2. Set that sewadar's consent_given = false and delete the deployments
--    row → both succeed.
-- 3. Lock the centre (INSERT INTO centre_locks …) and repeat 1 → raises
--    'Deployment is locked by this centre — only ASO / Super Admin can change it'.
-- 4. As vss_operator, UPDATE a deployed regular row → still raises
--    'This sewadar is already deployed …'.
-- 5. Finalized rows (deployed_department_id set) → still rejected by v15/v16.
-- ============================================================
