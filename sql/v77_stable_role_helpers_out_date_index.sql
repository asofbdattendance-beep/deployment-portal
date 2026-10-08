-- ============================================================
-- V77: RLS IDENTITY HELPERS -> STABLE + out_date INDEX
--
-- Purpose: fix the two queries that were eating the database.
--
-- Symptom (production pg_stat_statements):
--   1. SELECT count(*) FROM public.dp_attendance_sessions
--      WHERE (in_date = $1 OR out_date = $2) AND schedule_id = $3
--      11032 calls, mean 3217ms, max 7995ms, total 35,491,250ms
--      = 66.2% of ALL database time on the instance.
--      Emitted every 15s by InchargeScannerPage (src/pages/
--      InchargeScannerPage.jsx:73 load + :97 refreshSessions) through
--      fetchAllRows, which asks for count:'exact' on page 1.
--   2. SELECT count(*) FROM public.deployments
--      WHERE schedule_id = $1
--      1312 calls, mean 3293ms, max 7978ms, total 4,321,463ms
--      = 8.1% of all DB time. Emitted by useSewadarDirectory
--      (src/hooks/useSewadarDirectory.js:28) on every scanner page.
--   Contrast: the same sessions read WITH .eq('in_scanner_badge')
--   and ORDER BY created_at DESC runs at 21ms mean (9429 calls).
--
-- ROOT CAUSE 1 — get_portal_user_role() / get_portal_user_centre()
--   are VOLATILE by accident.
--   Postgres defaults a plpgsql function with no volatility keyword to
--   VOLATILE. v70_force_logout.sql:53-72 and :74-93 wrote both with no
--   keyword, so they are VOLATILE today.
--
--   A VOLATILE function in a qual cannot be treated as an index
--   condition or folded into an InitPlan: Postgres must re-run it, and
--   force a heap tuple fetch, for EVERY candidate row.
--
--   Both are read exactly once per row from the same WHERE clause and
--   are pure reads of portal_users by auth.uid(). STABLE is therefore
--   correct AND it is what every other helper in this schema already
--   declares — attendance_caller_badge, attendance_sewadar_centre_visible,
--   get_my_subtree_centres, get_root_centre, get_my_dept_ids and
--   is_my_incharge_dept_badge are all STABLE. These two were the
--   outliers.
--
--   Blast radius, why it is a big win:
--     - att_read (sql/v59_attendance_aso_truth.sql:126-138) calls
--       attendance_sewadar_centre_visible() once per session row, and
--       that function calls get_portal_user_role() TWICE in its own
--       CASE (sql/v40_attendance_venue_scope.sql:113,114). That is two
--       VOLATILE plpgsql invocations per candidate session row. The
--       policy then calls get_portal_user_role() a third time in the
--       dept_incharge arm.
--     - deploy_v2_read (sql/v59_attendance_aso_truth.sql:144-162)
--       calls get_portal_user_role() up to FIVE times per deployment
--       row, plus get_portal_user_centre().
--   Making them STABLE lets the planner evaluate each once per query
--   and — because the result is then loop-invariant — use an index-only
--   path for the count instead of a heap-visiting per-row evaluation.
--
--   SAFETY: these functions only SELECT from portal_users. They write
--   nothing, and they are not used in any CHECK constraint, generated
--   column, or index expression (STABLE would be rejected there).
--   Inside a statement the answer cannot change, so folding it once is
--   semantics-preserving. Behaviour is unchanged; only the number of
--   evaluations changes.
--
--   NOT CHANGED ON PURPOSE: check_login_rate (v73:27) does DELETE +
--   INSERT on login_attempts and MUST stay VOLATILE. No other function
--   is touched by this migration.
--
-- ROOT CAUSE 2 — no index anywhere on dp_attendance_sessions.out_date.
--   grep across sql/ finds zero indexes leading with out_date. The
--   in_date arm is covered twice (idx_dp_att_schedule_date v39:78,
--   idx_dp_att_schedule_homecentre v40:208), so the planner can use a
--   BitmapOr for (in_date = ? OR out_date = ?) only if BOTH sides are
--   indexed. Today the out_date side falls back to a heap scan of the
--   whole table, which is why the OR predicate is so expensive on a
--   table that accumulates a row per IN and per OUT forever (nothing
--   ever DELETEs from it — no DELETE on this table exists in sql/).
--
--   Adding (schedule_id, out_date) makes the OR a two-sided BitmapOr.
--   This is additive and does not change any query result.
--
-- Non-destructive: two CREATE OR REPLACE (signature and all grants
-- preserved) plus one CREATE INDEX IF NOT EXISTS. No table, column,
-- policy, trigger or role change. No data change. Safe to re-run.
--
-- MIN_SUPPORTED_DB_VERSION stays v75: this migration is a pure
-- performance fix. Nothing in the app gates on v77.
--
-- Rollback: re-run the v70_force_logout.sql bodies verbatim (drop the
--   STABLE keyword) and DROP INDEX IF EXISTS idx_dp_att_sched_out_date;
-- ============================================================

BEGIN;

-- --------------------------------------------------------------------
-- 1a. get_portal_user_role(): VOLATILE -> STABLE. Body unchanged.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_portal_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.portal_users
  WHERE auth_id = auth.uid()
    AND is_active = true
    AND archived_at IS NULL
    AND (force_logout_at IS NULL
         OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
             >= EXTRACT(EPOCH FROM force_logout_at)::bigint);
  IF v_role IS NULL THEN RETURN NULL; END IF;
  RETURN v_role;
END;
$$;

-- --------------------------------------------------------------------
-- 1b. get_portal_user_centre(): VOLATILE -> STABLE. Body unchanged.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_portal_user_centre()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text;
BEGIN
  SELECT centre INTO v_centre FROM public.portal_users
  WHERE auth_id = auth.uid()
    AND is_active = true
    AND archived_at IS NULL
    AND (force_logout_at IS NULL
         OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
             >= EXTRACT(EPOCH FROM force_logout_at)::bigint);
  IF v_centre IS NULL THEN RETURN NULL; END IF;
  RETURN v_centre;
END;
$$;

-- --------------------------------------------------------------------
-- 2. out_date coverage, so (in_date = ? OR out_date = ?) can be a
--    BitmapOr over two index scans instead of one index scan plus a
--    heap scan of the whole table.
-- --------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dp_att_sched_out_date
  ON public.dp_attendance_sessions (schedule_id, out_date);

COMMIT;

-- ── Verification (run as database owner AFTER applying) ─────────────
--
-- 1. Volatility actually changed:
-- SELECT p.proname, p.provolatile
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('get_portal_user_role','get_portal_user_centre');
-- -- expect provolatile = 's' (STABLE) for BOTH rows.
--
-- 2. Index exists:
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public'
--    AND tablename = 'dp_attendance_sessions'
--    AND indexname = 'idx_dp_att_sched_out_date';
-- -- expect one row.
--
-- 3. The hot plan. Run as an authenticated role, NOT the owner —
--    RLS does not apply to the table owner, so an owner-run EXPLAIN
--    would hide the whole problem. Substitute a real schedule uuid:
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT count(*) FROM public.dp_attendance_sessions
--  WHERE (in_date = CURRENT_DATE OR out_date = CURRENT_DATE)
--    AND schedule_id = '<a-real-schedule-uuid>';
-- -- BEFORE: one seq scan / heap scan dominated by dp_attendance_sessions.
-- -- AFTER:  Bitmap Heap Scan, "Recheck Cond" on both date columns,
-- --         and the count itself drops to index-only.
--
-- 4. Behaviour unchanged (must be identical before and after):
-- SELECT public.is_valid_badge_format('FB5971GA0001'),
--        public.is_valid_badge_format('BH1234AB0001');
-- -- expect t, f
--
-- ── If latency does not improve ─────────────────────────────────────
-- pg_stat_statements is cumulative since the last stats reset, so the
-- old 3217ms mean will not drop retroactively. Reset stats, let one
-- scanner page sit open for ~5 minutes (20 polls), then re-read:
--   SELECT calls, mean_time, total_time FROM pg_stat_statements
--    WHERE query LIKE '%dp_attendance_sessions%' ORDER BY total_time DESC;