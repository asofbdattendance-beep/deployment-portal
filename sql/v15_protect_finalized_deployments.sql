-- ============================================================
-- V15: PROTECT ASO-FINALIZED DEPLOYMENTS FROM CENTRE DELETES
-- The centre pages' auto-save removes a deployment row when a
-- sewadar's department request is cleared or consent flips to
-- "no". Before v15 that delete also destroyed rows the ASO had
-- FINALIZED on the Finalize Deployment page (deployments with a
-- non-null deployed_department_id) — silently wiping the ASO's
-- final decision. The centre pages now skip finalized rows
-- themselves (they load the flag), and this trigger is the DB
-- backstop: centre roles can never DELETE such a row, no matter
-- what client or SQL issues the delete.
--   • aso / super_admin keep full delete rights (they own
--     finalization, including consent-flip cleanups).
--   • centre roles can still delete their own NON-finalized
--     deployment rows (clear a request / un-consent) as before.
-- NOTE: NON-DESTRUCTIVE — safe to re-run.
-- Run AFTER v13 + v14 in Supabase.
-- ============================================================

CREATE OR REPLACE FUNCTION public.block_finalized_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;
  IF OLD.deployed_department_id IS NOT NULL THEN
    RAISE EXCEPTION 'This deployment was finalized by the ASO — only ASO / Super Admin can remove it';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_finalized_delete_deploy ON public.deployments;
CREATE TRIGGER trg_block_finalized_delete_deploy
  BEFORE DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_finalized_delete();

-- Verification (paste into Supabase SQL editor):
--   SELECT tgname, tgrelid::regclass
--   FROM pg_trigger
--   WHERE tgname = 'trg_block_finalized_delete_deploy';
-- Expected: one row on public.deployments.
