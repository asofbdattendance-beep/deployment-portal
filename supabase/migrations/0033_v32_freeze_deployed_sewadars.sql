-- ============================================================
-- V32: FREEZE DEPLOYED SEWADARS — centre users cannot edit or
--      change a sewadar once it is deployed (even before lock)
-- ============================================================
-- Problem: a centre could keep editing/removing a sewadar after
-- assigning its department (change the department, flip consent
-- to No, delete the deployment row) right up until the schedule
-- deadline or the centre lock. The user wants "once deployed,
-- frozen": from the moment `deployments.department_id` is set
-- for a REGULAR sewadar, centre roles may no longer UPDATE or
-- DELETE that deployment row, nor UPDATE/DELETE the sewadar's
-- consent row.
--
-- Exceptions (only these):
--   • aso / super_admin — always bypass (Finalize Deployment owns
--     post-deploy changes).
--   • a NORMAL centre override (via `is_centre_override_open`) —
--     department-scoped rows unfreeze THAT department's deployed
--     rows; consent rows reopen only via a centre-wide (NULL dept)
--     override. The undeployed-only override NEVER unfreezes
--     (deployed sewadars stay frozen under it — v21/v30 semantics).
--   • VSS sewadars (badge ILIKE 'VS%' OR row in vss_sewadars) are
--     exempt — their lifecycle is governed by the VSS switches /
--     tri-state overrides (v30).
--
-- Note on postgres / SQL-editor runs: like every other enforcement
-- trigger in this repo, get_portal_user_role() returns NULL there
-- and NULL is treated as a centre role — a deliberate, consistent
-- choice (the migrations themselves disable triggers when bulk
-- backfilling). To bypass for a cleanup, either run as the ASO app
-- user or:
--   ALTER TABLE public.deployments      DISABLE TRIGGER trg_a_freeze_deployed_deploy;
--   ALTER TABLE public.sewadar_consents DISABLE TRIGGER trg_a_freeze_consent_of_deployed;
--   ... cleanup ... then re-ENABLE the triggers.
--
-- Non-destructive; safe to re-run. Run AFTER v31.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Enforcement function (handles both tables via TG_TABLE_NAME)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.freeze_deployed_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_is_vss boolean;
  v_override boolean;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- VSS sewadars are exempt: their deploy/consent lifecycle is gated by the
  -- VSS-specific switches/overrides (v30) — this freeze is for regular sewadars.
  v_is_vss := OLD.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = OLD.badge_number);
  IF v_is_vss THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'deployments' THEN
    -- department_id is NOT NULL on every row → a row existing = deployed.
    -- A NORMAL override that opens this sewadar's department unfreezes it;
    -- the undeployed-only override never does (is_centre_override_open
    -- excludes undeployed_only rows).
    IF OLD.department_id IS NOT NULL THEN
      v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, OLD.department_id);
      IF NOT v_override THEN
        RAISE EXCEPTION 'This sewadar is already deployed — centre users cannot change or remove a deployed sewadar. Ask the ASO to adjust the deployment.';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'sewadar_consents' THEN
    -- Consent rows of deployed sewadars are frozen too (flipping consent to
    -- No would silently orphan the deployment). Only a centre-wide override
    -- reopens them (a department-scoped override never reopens consent —
    -- v21 semantics).
    IF EXISTS (
      SELECT 1 FROM public.deployments d
      WHERE d.schedule_id = OLD.schedule_id
        AND d.centre = OLD.centre
        AND d.badge_number = OLD.badge_number
        AND d.department_id IS NOT NULL
    ) THEN
      v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, NULL::uuid);
      IF NOT v_override THEN
        RAISE EXCEPTION 'This sewadar is already deployed — consent is frozen for centre users. Ask the ASO to adjust.';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ------------------------------------------------------------
-- 2. Triggers (dropped first so the migration is re-runnable)
--    Names sort BEFORE trg_a_clamp_oe_escorts_days / the deadline
--    and finalize gates so the freeze error is the one surfaced.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_a_freeze_deployed_deploy ON public.deployments;
CREATE TRIGGER trg_a_freeze_deployed_deploy
  BEFORE UPDATE OR DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.freeze_deployed_rows();

DROP TRIGGER IF EXISTS trg_a_freeze_consent_of_deployed ON public.sewadar_consents;
CREATE TRIGGER trg_a_freeze_consent_of_deployed
  BEFORE UPDATE OR DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.freeze_deployed_rows();

-- ------------------------------------------------------------
-- Verification
-- ------------------------------------------------------------
-- -- 1) trigger + function present:
-- SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_a_freeze%' ORDER BY tgname;
--
-- -- 2) pick a deployed regular sewadar (a deployments row with department_id set):
-- SELECT schedule_id, centre, badge_number, department_id
-- FROM public.deployments d
-- WHERE NOT (d.badge_number LIKE 'VS%')
--   AND NOT EXISTS (SELECT 1 FROM public.vss_sewadars v WHERE v.badge_number = d.badge_number)
-- LIMIT 1;
--
-- -- 3) as a centre_user, UPDATE that row's department_id to a different dept
-- --    → expect: 'This sewadar is already deployed — centre users cannot change...'
-- --    (same for DELETE, and for UPDATE/DELETE of the matching sewadar_consents row)
--
-- -- 4) super_admin / aso UPDATE of the same row → succeeds (v20: aso read-only
-- --    in the app, but the trigger does not block admins)
