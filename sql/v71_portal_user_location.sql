-- v71: optional free-text location on portal_users (attendance logins).
--
-- Lets the ASO record WHERE an attendance-side login (scanner, dept_incharge,
-- centre roles) operates — e.g. "Bhati Gate 2", "Parking Team". Display-only:
-- no RLS policy, trigger, or helper reads it, so existing behaviour is
-- unchanged. NULL = not set.
--
-- Non-destructive: one ADD COLUMN IF NOT EXISTS, no data rewrite, safe to
-- re-run. Apply after v70.
BEGIN;

ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS location text;

COMMIT;

-- ── Verification (run as super_admin after applying) ──
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'portal_users'
--    AND column_name = 'location';  -- expect 1 row (text)
