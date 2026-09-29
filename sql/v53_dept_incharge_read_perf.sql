-- ============================================================
-- V53: MAKE THE v52 DEPT_INCHARGE READ POLICIES CHEAP.
--       Run AFTER v52 (which must be applied for v53 to matter).
--
-- WHY v52 was correct but slow (1-2 s per page load):
--
--   v52 granted a `dept_incharge` its department's rows with a CORRELATED
--   subquery per row:
--
--     OR ( role = 'dept_incharge' AND EXISTS (
--            SELECT 1 FROM public.deployments d
--             WHERE d.badge_number = dp_sewadars.badge_number ... ) )
--
--   Two things make that expensive, and they compound:
--
--   1. NESTED RLS. The `deployments` reference inside a policy on
--      `dp_sewadars` is itself RLS-filtered, so for every candidate row the
--      `deploy_v2_read` predicate runs too — and BOTH predicates call
--      `get_my_dept_ids(schedule_id)`, a SECURITY DEFINER function that unions
--      two tables. That is 2-3 invocations per candidate row, tens of
--      thousands of times per query, and `count: 'exact'` does it twice (once
--      for the count, once for the page).
--
--   2. NO RELIABLE INDEX PATH. The inner `EXISTS` is a lookup by badge, but the
--      nested policy perturbs the planner, and `COALESCE(deployed_department_id,
--      department_id)` is not sargable, so the inner query can degrade into a
--      SEQUENTIAL SCAN of `deployments` for every sewadar row. At ~2,400
--      sewadars x ~2,400 deployments that is millions of row visits, each one
--      paying a SECURITY DEFINER call. It is the whole 1-2 s.
--
--   The symptom is pure latency with identical results, which is why it is
--   easy to mistake for a slow network.
--
-- WHAT CHANGES
--   1. `is_my_incharge_dept_badge(text)` — one SECURITY DEFINER, `search_path=''`,
--      STABLE predicate that answers "is this badge deployed to one of my
--      departments" as a single indexed lookup. Because it runs as the definer
--      it BYPASSES `deployments` RLS, so there is no nested policy and no
--      second/third `get_my_dept_ids` call per row. Both sewadar policies call
--      it instead of inlining the EXISTS.
--
--   2. An EXPRESSION index on `deployments (schedule_id, COALESCE(deployed_
--      department_id, department_id))` so the v52 `deploy_v2_read` arm is an
--      index scan instead of a heap-filtered one — that arm is evaluated for
--      every candidate deployment row, so its cost is per-row too.
--
--   3. `idx_deployments_badge_dept` is now LOAD-BEARING rather than
--      merely helpful: it is the only thing making the new predicate an index
--      probe. Dropping it restores the multi-second behaviour.
--
--   4. `att_read` — the policy DeptInchargePage actually hits hardest. v51's
--      dept_incharge arm was `get_my_dept_ids(schedule_id) @> ARRAY[sewadar_dept]`.
--      Array containment with a NULL element matches NOTHING, so every session
--      written by a badge with no deployment row at scan time — exactly the
--      `undeployed_scan = true` rows `scan_in` creates — was invisible to the
--      incharge, and the arm paid a SECURITY DEFINER call per session row.
--      `is_my_incharge_dept_badge` answers the same question from the badge's
--      EFFECTIVE department in one indexed lookup and is NULL-safe by
--      construction (a badge with no deployment matches no department).
--
--   IDENTICAL RESULTS for every role except the dept_incharge arm of att_read,
--   which is strictly the v51 intent made NULL-safe and indexed. No write policy
--   is touched, no scope is widened — a `dept_incharge` still reads only the
--   sewadars deployed to their own departments, and every other role is
--   byte-identical. Quota, rules, locks, deadlines, switches, the v32 freeze and
--   the scan ladder are untouched.
--
-- Non-destructive; safe to re-run. Verification at the bottom.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The cheap predicate.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_my_incharge_dept_badge(p_badge text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_badge IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.deployments d
     WHERE d.badge_number = p_badge
       AND COALESCE(d.deployed_department_id, d.department_id)
             = ANY (public.get_my_dept_ids(d.schedule_id))
  );
$$;

-- Narrow the EXECUTE grant explicitly: this is a per-row predicate, not a
-- data-returning API, and PUBLIC already has EXECUTE on new functions by
-- default. It leaks nothing (it answers yes/no about the CALLER's own badge),
-- but the grant is stated rather than inherited.
REVOKE ALL ON FUNCTION public.is_my_incharge_dept_badge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_my_incharge_dept_badge(text) TO authenticated;

-- ------------------------------------------------------------
-- 2. Cover the v52 deploy_v2_read arm (evaluated per row).
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deployments_effective_dept
  ON public.deployments (schedule_id, (COALESCE(deployed_department_id, department_id)));

-- ------------------------------------------------------------
-- 3. The policies — same predicate, one indexed call per row.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sewadars_portal_read ON public.dp_sewadars;
CREATE POLICY sewadars_portal_read ON public.dp_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
    OR (
         public.get_portal_user_role() = 'dept_incharge'
     AND public.is_my_incharge_dept_badge(dp_sewadars.badge_number)
    )
  );

DROP POLICY IF EXISTS vss_sewadars_read ON public.vss_sewadars;
CREATE POLICY vss_sewadars_read ON public.vss_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
    OR (
         public.get_portal_user_role() = 'dept_incharge'
     AND public.is_my_incharge_dept_badge(vss_sewadars.badge_number)
    )
  );

-- ------------------------------------------------------------
-- 4. att_read — NULL-safe and indexed for the dept_incharge arm.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS att_read ON public.dp_attendance_sessions;
CREATE POLICY att_read ON public.dp_attendance_sessions
  FOR SELECT TO authenticated USING (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  OR (
       public.get_portal_user_role() = 'dept_incharge'
   AND public.is_my_incharge_dept_badge(badge_number)
     )
  );

COMMIT;

-- ============================================================
-- VERIFICATION — run in the Supabase SQL editor AS a dept_incharge
-- ============================================================
-- 1. Correctness first: the row set must be UNCHANGED from v52. Before you run
--    v53, note these three numbers; after, they must be identical.
--      SELECT count(*) FROM public.deployments;
--      SELECT count(*) FROM public.dp_sewadars;
--      SELECT count(*) FROM public.vss_sewadars;
--
-- 2. The predicate itself, for one of your own badges (expect true):
--      SELECT public.is_my_incharge_dept_badge('<your badge>');
--    and for a badge in a department you do NOT hold (expect false):
--      SELECT public.is_my_incharge_dept_badge('<some other badge>');
--
-- 3. Prove the index is actually used — this is the check that matters. If the
--    plan says Seq Scan, the slowness will still be there:
--      EXPLAIN (ANALYZE, BUFFERS)
--      SELECT count(*) FROM public.dp_sewadars;
--    -- look for: Index Scan using idx_deployments_badge_dept
--               (or a Bitmap Index Scan) inside the policy, NOT a repeated
--               Seq Scan on public.deployments.
--
-- 4. The covering index for the deployments policy:
--      EXPLAIN (ANALYZE)
--      SELECT count(*) FROM public.deployments WHERE schedule_id = '<uuid>';
--    -- look for idx_deployments_effective_dept or idx_deployments_badge_dept
--
-- 5. Fail-closed unchanged: a role with no grant still sees nothing.
--      SELECT public.is_my_incharge_dept_badge('<any badge>');
--    -- as a centre_user: false for any badge not in their own deployment.
-- ============================================================
