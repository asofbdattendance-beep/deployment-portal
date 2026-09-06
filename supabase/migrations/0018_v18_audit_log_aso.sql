-- ============================================================
-- v18 — audit_log: let the ASO record destructive actions too
-- ============================================================
-- v16 (G+) rebuilt audit_log_insert around get_portal_user_role()
-- but kept it super_admin-only. The ASO performs destructive
-- actions from Schedule Maker as well (delete schedule /
-- department / allocations, REMOVE_ALL) — every one of those
-- inserts silently did nothing for an aso account (the JS treats
-- audit writes as best-effort). This widens INSERT to aso +
-- super_admin; reads stay admin-only.
--
-- Non-destructive; safe to re-run.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS audit_log_insert ON public.audit_log;
CREATE POLICY audit_log_insert ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- -- Exactly one insert policy, allowing both admin roles:
-- SELECT policyname, cmd, pg_get_expr(with_check, 'audit_log'::regclass) AS with_check_expr
-- FROM pg_policies
-- WHERE tablename = 'audit_log' AND cmd = 'INSERT';
--
-- -- Simulate: what would an aso see as allowed?
-- SELECT public.get_portal_user_role();  -- run AS the aso account in the app, or:
-- SELECT rolname FROM pg_roles WHERE rolname = 'authenticated';
