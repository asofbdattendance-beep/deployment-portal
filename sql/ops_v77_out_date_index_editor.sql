-- ============================================================
-- OPS: v77 part 2 of 2 — EDITOR variant (plain build, off-peak only)
--
-- Use this file when pasting into the Supabase SQL editor. The twin file
-- ops_v77_out_date_index_concurrently.sql is the zero-downtime path but it
-- CANNOT run here (the editor wraps everything in BEGIN/COMMIT and
-- CONCURRENTLY is rejected inside a transaction block).
--
-- WHAT IT COSTS: plain CREATE INDEX holds an ACCESS EXCLUSIVE lock on
-- dp_attendance_sessions for the whole build — scans stall while it runs.
-- Run ONLY off-peak (your peak was ~04:30–05:00 IST). Run PASTE 0 first:
-- if the table is small the build takes seconds; if the build ever fails
-- with "canceling statement due to statement timeout", the table is big —
-- STOP and use the psql CONCURRENTLY file instead.
--
-- SAFETY: lock_timeout makes the build abort (cleanly — a failed plain
-- build rolls back with no leftover, unlike an interrupted CONCURRENTLY)
-- instead of queueing behind live scans. CREATE INDEX never modifies rows.
-- ANALYZE only refreshes planner stats. Rollback: DROP INDEX IF EXISTS
-- public.idx_dp_att_sched_out_date; (plain DROP is fine here).
-- ============================================================

-- Fail fast instead of piling up behind live scans: if the lock is not
-- available within 3 s, abort with nothing changed — retry in a quieter
-- minute or switch to the CONCURRENTLY file via psql.
SET lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_dp_att_sched_out_date
  ON public.dp_attendance_sessions (schedule_id, out_date);

ANALYZE public.dp_attendance_sessions;

-- Gate for the operator: expect exactly one row, indisvalid = t.
SELECT indexrelid::regclass AS index_name, indisvalid
  FROM pg_index
 WHERE indexrelid = 'public.idx_dp_att_sched_out_date'::regclass;
