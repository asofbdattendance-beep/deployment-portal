-- ============================================================
-- v82: Composite Scanner Indexes & Version Bump
--
-- Optimization for 150 concurrent scanners on Supabase Free Tier.
-- Adds composite indexes to eliminate multi-second seq/bitmap scans
-- when scanner operators fetch their recent scans on load, 15s poll,
-- and post-scan refresh.
--
-- Non-destructive, idempotent, safe to re-run.
-- ============================================================

BEGIN;

SET lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_in
  ON public.dp_attendance_sessions (schedule_id, in_scanner_badge, in_date);

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_out
  ON public.dp_attendance_sessions (schedule_id, out_scanner_badge, out_date);

ANALYZE public.dp_attendance_sessions;

INSERT INTO public.portal_version (version) VALUES ('v82')
ON CONFLICT (version) DO NOTHING;

COMMIT;
