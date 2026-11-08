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

SET lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_in
  ON public.dp_attendance_sessions (schedule_id, in_scanner_badge, in_date);

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_out
  ON public.dp_attendance_sessions (schedule_id, out_scanner_badge, out_date);

ANALYZE public.dp_attendance_sessions;

CREATE OR REPLACE FUNCTION public.portal_app_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'v82'::text;
$$;

GRANT EXECUTE ON FUNCTION public.portal_app_version() TO anon, authenticated, service_role;
