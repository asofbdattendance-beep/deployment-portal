-- ============================================================
-- V52: DEPT_INCHARGE READ ACCESS — the tables the incharge LISTS
--       actually come from. Run AFTER v51.
--
-- WHY (this is the completion of v51, which was incomplete):
--
--   v51 correctly changed SCOPE — `get_my_dept_ids` is now department-only and
--   it widened `att_read` so a dept_incharge could read attendance sessions.
--   But the Dept Incharge page's "Complete list", "Present" and "Absent" tabs
--   are NOT built from sessions. They are built from `deployments` (the rows
--   themselves) enriched with `dp_sewadars` / `vss_sewadars` for names, gender
--   and initiated. v51 left all three read policies untouched.
--
--   Every one of them is gated on `centre = ANY(get_my_subtree_centres())`:
--
--     deploy_v2_read       sql/v36_vss_operator.sql:72
--     sewadars_portal_read sql/v36_vss_operator.sql:100
--     vss_sewadars_read    sql/v36_vss_operator.sql:80
--     consent_read         sql/v2_deployment_redesign.sql:427
--
--   and a dept_incharge has NO centre. `create-login` only sets
--   `portal_users.centre` for the CENTRE roles, so a dept_incharge's centre is
--   NULL — which is correct for a department-scoped role and is exactly why
--   v51 dropped the centre predicate. `get_my_subtree_centres()` with a NULL
--   centre returns `ARRAY[NULL]` (v28:249-268: the recursive CTE matches no
--   row, so `array_agg` is NULL and the COALESCE wraps a single NULL), so
--   `centre = ANY(...)` evaluates to NULL. An RLS `USING` clause admits a row
--   only when it is TRUE, and NULL is not TRUE — so the policy denies EVERY
--   row.
--
--   The symptom is silent and looks like empty data, not like a permission
--   error: the header says "All my departments (1)" (the SECURITY DEFINER
--   `get_my_dept_ids` RPC has no such gate and resolves fine), then every tab
--   reads Complete list (0) / Present (0) / Absent (0) and "No sewadars in
--   this dept".
--
-- WHAT CHANGES
--   §1 deploy_v2_read — a dept_incharge reads every deployment row whose
--      EFFECTIVE department (final else requested, matching the page's
--      `effectiveDept`) is one of their grants, in ANY centre. This is the
--      table the whole page hangs off, so it is the actual fix.
--   §2 sewadars_portal_read / vss_sewadars_read — the same department
--      predicate, expressed as "this badge is deployed to one of my
--      departments", so names/gender/initiated resolve. Scoped by BADGE +
--      department, never by centre: the incharge sees their department's
--      people from every centre and nobody else's.
--   §3 index to keep §2's correlated EXISTS an index probe rather than a
--      sequential scan of `deployments` (no such index existed).
--
--   `sewadar_consents` is DELIBERATELY NOT widened. The incharge page never
--   reads it, and consent rows carry per-sewadar availability/bhati/chair
--   detail for EVERY sewadar in a centre — a department predicate would have
--   to be resolved through a join to deployments, and the page gains nothing
--   from it. Not touching it keeps the blast radius at exactly the three
--   tables that were broken.
--
--   NOTHING ELSE MOVES: no write policy is touched, so a dept_incharge still
--   cannot write a deployment, a consent or an incharge selection. Quota,
--   restriction rules, locks, deadlines, master switches, the v32 freeze and
--   the scan ladder are all untouched. `att_read` stays exactly as v51 left it.
--
-- Non-destructive; safe to re-run. Verification queries at the bottom.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 3. Index first: §2's EXISTS is evaluated per sewadar row, and
--    without this it seq-scans `deployments` for every one of the
--    thousands of sewadars the policy is tested against.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deployments_badge_dept
  ON public.deployments (badge_number, schedule_id, department_id);

-- ------------------------------------------------------------
-- 1. deploy_v2_read — THE fix. Same predicate shape as v36 plus
--    the department arm; every other role is byte-identical.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deploy_v2_read ON public.deployments;
CREATE POLICY deploy_v2_read ON public.deployments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
    OR (
         public.get_portal_user_role() = 'dept_incharge'
     AND COALESCE(deployed_department_id, department_id)
           = ANY (public.get_my_dept_ids(schedule_id))
    )
  );

-- ------------------------------------------------------------
-- 2. sewadars_portal_read / vss_sewadars_read — the same grant,
--    keyed on the badge being deployed to one of my departments
--    in the schedule they hold the grant for. get_my_dept_ids is
--    evaluated against d.schedule_id, so the predicate is correct
--    for any schedule rather than assuming the caller's current one.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sewadars_portal_read ON public.dp_sewadars;
CREATE POLICY sewadars_portal_read ON public.dp_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin', 'vss_operator')
    OR centre = ANY (public.get_my_subtree_centres())
    OR (
         public.get_portal_user_role() = 'dept_incharge'
     AND EXISTS (
           SELECT 1
             FROM public.deployments d
            WHERE d.badge_number = dp_sewadars.badge_number
              AND COALESCE(d.deployed_department_id, d.department_id)
                    = ANY (public.get_my_dept_ids(d.schedule_id))
         )
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
     AND EXISTS (
           SELECT 1
             FROM public.deployments d
            WHERE d.badge_number = vss_sewadars.badge_number
              AND COALESCE(d.deployed_department_id, d.department_id)
                    = ANY (public.get_my_dept_ids(d.schedule_id))
         )
    )
  );

COMMIT;

-- ============================================================
-- VERIFICATION — run as a real dept_incharge, in this order
-- ============================================================
-- 1. Prove the NULL-centre theory (this is the thing that silently
--    denied every row). Expect a one-element array holding NULL:
--      SELECT public.get_portal_user_centre() AS my_centre,
--             public.get_my_subtree_centres()  AS my_subtree;
--
-- 2. The grant resolves (this already worked before v52 — it is why
--    the header shows a department):
--      SELECT public.get_my_dept_ids('<schedule uuid>') AS my_depts;
--
-- 3. THE FIX — the department's deployments, across centres:
--      SELECT count(*) FROM public.deployments;
--    -- before v52: 0. after: the full deployed count for your department(s)
--      SELECT centre, count(*) FROM public.deployments
--       GROUP BY 1 ORDER BY 1;
--    -- MUST show MORE THAN ONE centre, and the totals must sum to (3)
--
-- 4. Names resolve (Complete list needs these to be non-empty):
--      SELECT count(*) FROM public.dp_sewadars;
--      SELECT count(*) FROM public.vss_sewadars;
--
-- 5. The incharge did NOT gain anything else — both must be 0:
--      SELECT count(*) FROM public.sewadar_consents;
--      SELECT count(*) FROM public.deployment_departments WHERE false;
--    -- a deployment in a department you do NOT hold must not appear:
--      SELECT count(*) FROM public.deployments d
--       WHERE NOT (COALESCE(d.deployed_department_id, d.department_id)
--                    = ANY (public.get_my_dept_ids(d.schedule_id)));
--    -- expect 0: every visible row belongs to your department
--
-- 6. Fail-closed for a role with no grant — as a centre_user this
--    must still be their subtree only, never all departments:
--      SELECT public.attendance_scope_centres('<schedule uuid>');
-- ============================================================
