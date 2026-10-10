-- ============================================================
-- OPS: v77 part 2 of 2 — out_date index, built WITHOUT locking scans
--
-- HOW TO RUN (read first — wrong runner = failure, never damage):
--   * Run via a DIRECT psql connection in AUTOCOMMIT mode, e.g.
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/ops_v77_out_date_index_concurrently.sql
--     ON_ERROR_STOP=1 makes psql abort on the first failure instead of
--     running the later statements against a half-built state.
--   * NEVER via the Supabase SQL editor or `supabase db push`: both wrap
--     statements in BEGIN/COMMIT and CONCURRENTLY is rejected inside a
--     transaction ("CREATE INDEX CONCURRENTLY cannot run inside a
--     transaction block"). That error is harmless — nothing is changed —
--     just re-run via psql.
--   * Do NOT add BEGIN/COMMIT to this file.
--   * Off-peak preferred, but CONCURRENTLY takes only millisecond
--     SHARE UPDATE EXCLUSIVE locks, so live scans keep working throughout.
--
-- WHAT IT DOES: creates idx_dp_att_sched_out_date (schedule_id, out_date)
-- so the hot (in_date = ? OR out_date = ?) predicate becomes a two-sided
-- BitmapOr instead of an index scan plus a whole-table heap scan.
-- CREATE INDEX never modifies rows. ANALYZE only refreshes planner stats.
--
-- IF IT IS INTERRUPTED: a failed CONCURRENTLY build leaves an INVALID
-- index (harmless — the planner ignores it). Check with ops_v77_verify.sql
-- query 2; if indisvalid = false, run:
--     DROP INDEX CONCURRENTLY IF EXISTS public.idx_dp_att_sched_out_date;
-- then re-run this file. (DROP ... CONCURRENTLY also needs psql/autocommit.)
--
-- AFTER this file: run ops_v77_verify.sql. NOTE on db push bookkeeping:
-- the versioned v77 file (sql/v77_* + supabase/migrations/0080_*) is
-- unchanged and still the source of truth; its CREATE INDEX IF NOT EXISTS
-- becomes a no-op once this index exists, so a later `supabase db push`
-- of v77 changes nothing. Rollback: the DROP above.
-- ============================================================

-- The build can take longer than the 58 s statement_timeout on a large
-- table. This override is SESSION-scoped (dies with this connection) and
-- affects only the statements below — it changes no database setting.
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dp_att_sched_out_date
  ON public.dp_attendance_sessions (schedule_id, out_date);

-- Let the planner see the new index immediately (lightweight lock only;
-- does not block reads or writes).
ANALYZE public.dp_attendance_sessions;

-- Validity gate for the operator: expect exactly one row, indisvalid = t.
-- If f, follow the INVALID-index recovery in the header above.
SELECT indexrelid::regclass AS index_name, indisvalid
  FROM pg_index
 WHERE indexrelid = 'public.idx_dp_att_sched_out_date'::regclass;
