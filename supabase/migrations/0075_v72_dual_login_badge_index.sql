-- v72: badge→email lookup index for dual login (email OR badge).
--
-- portal_users.email and badge_number are both nullable TEXT with no badge
-- uniqueness; badge login must resolve badge → email WITHOUT touching any
-- existing row. This migration adds ONE partial expression index and nothing
-- else: lookup-only, no column, no backfill, no UPDATE / DELETE / DROP.
-- Existing ASO / super_admin / deployment users keep email login working;
-- badge login only READS via this index (see supabase/functions/resolve-login).
--
-- Non-destructive: one CREATE INDEX IF NOT EXISTS, safe to re-run.
-- Apply after v71.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_portal_users_badge_norm
  ON public.portal_users (lower(btrim(badge_number)))
  WHERE badge_number IS NOT NULL AND btrim(badge_number) <> '';

COMMIT;

-- ── Verification (run as super_admin after applying) ──
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'portal_users'
--    AND indexname = 'idx_portal_users_badge_norm';  -- expect 1 row
-- EXPLAIN SELECT email FROM public.portal_users
--  WHERE lower(btrim(badge_number)) = lower(btrim('TEST123'));  -- expect Index Scan
