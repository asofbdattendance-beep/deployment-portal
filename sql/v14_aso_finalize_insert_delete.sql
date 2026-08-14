-- ============================================================
-- V14: ASO / SUPER ADMIN — full deployment-row lifecycle on
--      the Finalize Deployment page
-- As of v8 the ASO could UPDATE deployments (set the finalized
-- department) but the v2-era INSERT / DELETE policies still only
-- allowed super_admin + centre roles. The Finalize Deployment
-- page needs both:
--   • INSERT — an "awaiting" sewadar (consented, no deployment
--     row yet) that the finalizer assigns a department to
--     creates a fresh deployment row.
--   • DELETE — when the finalizer flips consent to "no", the
--     stale deployment row must be removed (centre-page
--     semantics: no consent ⇒ no deployment row).
-- The v13 centre-lock delete trigger already exempts
-- aso / super_admin, so only these policies need widening.
-- NOTE: NON-DESTRUCTIVE — safe to re-run.
-- Run AFTER portal_setup.sql + v2 … v13
-- ============================================================

-- deployments: allow aso + super_admin to UPDATE (set finalized dept).
-- Recreated here (same shape as v8) so this file is self-sufficient on any
-- DB — a drifted prod without v8 would otherwise still lock the ASO out of
-- updates while allowing inserts/deletes.
DROP POLICY IF EXISTS deploy_v2_update ON public.deployments;
CREATE POLICY deploy_v2_update ON public.deployments
  FOR UPDATE TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- deployments: allow aso + super_admin to INSERT (assign awaiting sewadars)
DROP POLICY IF EXISTS deploy_v2_insert ON public.deployments;
CREATE POLICY deploy_v2_insert ON public.deployments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- deployments: allow aso + super_admin to DELETE (consent flipped to "no")
DROP POLICY IF EXISTS deploy_v2_delete ON public.deployments;
CREATE POLICY deploy_v2_delete ON public.deployments
  FOR DELETE TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- Verification (paste into Supabase SQL editor):
--   SELECT policyname, cmd, pg_get_expr(qual, 'public.deployments'::regclass) AS using_expr
--   FROM pg_policies WHERE tablename = 'deployments'
--   ORDER BY cmd;
-- Both deploy_v2_insert and deploy_v2_delete should list
-- 'aso', 'super_admin' in their WITH CHECK / USING expressions.
