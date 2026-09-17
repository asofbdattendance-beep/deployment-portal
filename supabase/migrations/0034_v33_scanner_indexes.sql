-- v33_scanner_indexes.sql — Covering index for scan_in's deployment lookup
-- Non-destructive; safe to re-run.
--
-- scan_in does: SELECT ... FROM deployments WHERE schedule_id=X AND badge_number=Y
-- Without this index, it's a sequential scan per RPC. With 200 concurrent scanners,
-- this holds DB connections longer and accelerates PgBouncer pool exhaustion.

-- Covering index for the scan_in deployment lookup
-- Created non-concurrently: brief lock acceptable for the table sizes.
-- CONCURRENTLY cannot run inside a transaction block; Supabase SQL editor and
-- `supabase db push` wrap migrations in BEGIN/COMMIT, so plain CREATE INDEX is used.
CREATE INDEX IF NOT EXISTS idx_deployments_scan_lookup
  ON deployments (schedule_id, badge_number)
  INCLUDE (department_id, deployed_department_id, centre, status);

-- Also add a covering index for the get_open_session lookup
-- scan_in and scan_out both call: get_open_session(badge, schedule)
-- which does: SELECT ... FROM dp_attendance_sessions WHERE badge=X AND schedule=Y AND status='OPEN'
CREATE INDEX IF NOT EXISTS idx_attendance_scan_lookup
  ON dp_attendance_sessions (schedule_id, badge_number, status)
  WHERE status = 'OPEN';

-- Verification query (run after migration):
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename = 'deployments' AND indexname = 'idx_deployments_scan_lookup';
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename = 'dp_attendance_sessions' AND indexname = 'idx_attendance_scan_lookup';
