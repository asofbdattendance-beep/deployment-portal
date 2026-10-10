-- ============================================================
-- OPS: v77 verification — run AFTER both apply files, paste output back
--
-- Run queries 1, 2, 4 in the SQL editor (any role). Query 3 MUST run as an
-- AUTHENTICATED app role (a scanner login via the app, or psql with the
-- user's JWT) — RLS does not apply to the table owner, so an owner-run
-- EXPLAIN hides the whole problem. Substitute a real schedule UUID in q3.
-- All four are pure reads: nothing is written by this file.
-- ============================================================

-- 1. Volatility actually changed: expect 's' (STABLE) for BOTH rows.
--    BEFORE: provolatile = 'v' for both. AFTER: 's', 's'.
SELECT p.proname, p.provolatile
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('get_portal_user_role', 'get_portal_user_centre');

-- 2. Index exists AND is valid: expect exactly one row, indisvalid = t.
--    If indisvalid = f, the CONCURRENTLY build was interrupted — see the
--    recovery note in ops_v77_out_date_index_concurrently.sql. If zero
--    rows, part 2 was never run.
SELECT i.indexname, x.indisvalid
  FROM pg_indexes i
  JOIN pg_index x ON x.indexrelid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass
 WHERE i.schemaname = 'public'
   AND i.tablename = 'dp_attendance_sessions'
   AND i.indexname = 'idx_dp_att_sched_out_date';

-- 3. THE HOT PLAN (authenticated role only — see header).
--    Substitute a real schedule UUID for <SCHEDULE_UUID>:
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT count(*) FROM public.dp_attendance_sessions
--  WHERE (in_date = CURRENT_DATE OR out_date = CURRENT_DATE)
--    AND schedule_id = '<SCHEDULE_UUID>';
-- BEFORE: seq scan / heap scan dominated by dp_attendance_sessions.
-- AFTER:  Bitmap Heap Scan with a BitmapOr over in_date + out_date arms.

-- 4. Behaviour unchanged (must be identical before and after): expect t, f.
SELECT public.is_valid_badge_format('FB5971GA0001'),
       public.is_valid_badge_format('BH1234AB0001');

-- 5. Effect on the top consumer (optional). pg_stat_statements is
--    cumulative, so the old ~3200 ms mean will NOT drop retroactively.
--    Reset, leave one scanner page open ~5 minutes (~20 polls), re-read:
-- SELECT calls, mean_exec_time, max_exec_time FROM pg_stat_statements
--  WHERE query LIKE '%dp_attendance_sessions%' ORDER BY total_exec_time DESC;
-- Expect the count+page row's mean_exec_time in the tens of ms.
