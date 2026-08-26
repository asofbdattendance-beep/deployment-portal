-- ============================================================
-- V20: ASO becomes READ-ONLY everywhere (hardening, phase 2)
--
-- Product decision (phase-2 hardening): accounts with the `aso`
-- role must be able to VIEW data and DOWNLOAD exports only.
-- Every write moves to `super_admin`:
--   • sewadar_consents.consent_write  (v8 had widened FOR ALL to aso)
--   • deployments.deploy_v2_insert    (v14 widened for finalizing)
--   • deployments.deploy_v2_update    (v8/v14 widened for finalizing)
--   • deployments.deploy_v2_delete    (v14 widened for finalizing)
-- Centre-role subtree writes are preserved verbatim.
-- Reads stay open to aso via consent_read / deploy_v2_read (v2).
--
-- NOTE on schedules/departments/allocations: v16 H1 already removed
-- the last aso write grants there, so nothing to do in this file.
-- audit_log_insert (v18) intentionally keeps its aso arm — harmless
-- and future-proof if a destructive action ever returns to aso.
--
-- Frontend counterpart: Finalize Deployment hides "Enable editing" /
-- "Save Draft", Consent/VSS dashboards hide switches + Unlock, and
-- AddVssForm goes view-only for aso (same commit).
--
-- NON-DESTRUCTIVE — safe to re-run.
-- Run AFTER portal_setup.sql + v2 … v19.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sewadar_consents: super_admin unrestricted + centre roles
--    on their own subtree. aso loses the blanket write grant
--    but keeps reading through `consent_read` (v2).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS consent_write ON public.sewadar_consents;
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

-- ------------------------------------------------------------
-- 2. deployments: same shape, all three write commands.
--    super_admin is now the sole finalizer.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deploy_v2_update ON public.deployments;
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

DROP POLICY IF EXISTS deploy_v2_insert ON public.deployments;
CREATE POLICY deploy_v2_insert ON public.deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

DROP POLICY IF EXISTS deploy_v2_delete ON public.deployments;
CREATE POLICY deploy_v2_delete ON public.deployments
  FOR DELETE TO authenticated
  USING (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- Verification (paste into Supabase SQL editor):
--   SELECT tablename, policyname, cmd,
--          pg_get_expr(qual, 'public.deployments'::regclass) AS using_expr
--   FROM pg_policies
--   WHERE tablename IN ('deployments', 'sewadar_consents')
--     AND policyname IN ('consent_write','deploy_v2_insert',
--                        'deploy_v2_update','deploy_v2_delete')
--   ORDER BY tablename, policyname;
-- Every expression above must mention 'super_admin' and the two
-- centre roles — 'aso' should appear ONLY in *_read policies.
