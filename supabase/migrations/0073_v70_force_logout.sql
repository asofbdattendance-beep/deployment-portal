-- ============================================================
-- V70: FORCE LOGOUT (portal_users.force_logout_at)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- When a login must be killed IMMEDIATELY (compromised credentials,
-- a leaver still holding a live session), flipping is_active is not
-- enough: the user's existing Supabase JWT stays valid until it
-- expires. force_logout_at is a per-user kill switch — any JWT
-- issued BEFORE that instant stops working, everywhere, the moment
-- this migration lands. The user simply signs in again and gets a
-- fresh token.
--
-- SCOPE / SAFETY
-- ------------------------------------------------------------
-- - ADD COLUMN IF NOT EXISTS force_logout_at timestamptz — pure
--   additive; NULL means "no force logout" (today's behaviour).
-- - The three portal helpers (get_portal_user_role /
--   get_portal_user_centre / get_portal_profile) are recreated with
--   IDENTICAL signatures, adding a NULL-safe issued-at guard on top
--   of the v69 archived guard:
--
--     AND (force_logout_at IS NULL
--          OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
--              >= EXTRACT(EPOCH FROM force_logout_at)::bigint)
--
--   Semantics: a token survives only if it was issued at/after the
--   force-logout instant. NULL force_logout_at → guard passes
--   (nobody logged out). Missing iat claim → COALESCE 0 → fails
--   closed when a force-logout IS set. Because CREATE OR REPLACE
--   swaps the whole body, the v69 archived_at IS NULL guard is
--   carried forward here — the final state has BOTH guards.
-- - ISOLATED: this file touches only force_logout_at and the three
--   helpers. No claim_portal_invite change, no archived_at change,
--   no DELETE / UPDATE / DROP. Non-destructive; safe to re-run.
-- - Apply AFTER v69 (the recreated helpers reference archived_at).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Column (idempotent; NULL = no force logout)
-- ------------------------------------------------------------
ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS force_logout_at timestamptz;

-- ------------------------------------------------------------
-- 2. Helpers — identical signatures, v69 archived guard carried
--    forward + NULL-safe iat guard. A forced-out login resolves
--    to NULL (denied) until it re-authenticates.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_portal_user_role()
RETURNS TEXT
LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION public.get_portal_user_centre()
RETURNS TEXT
LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION public.get_portal_profile()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
BEGIN
  SELECT row_to_json(pu.*) INTO v_result
  FROM public.portal_users pu
  WHERE pu.auth_id = auth.uid()
    AND pu.is_active = true
    AND pu.archived_at IS NULL
    AND (pu.force_logout_at IS NULL
         OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
             >= EXTRACT(EPOCH FROM pu.force_logout_at)::bigint);
  RETURN v_result;
END;
$$;

-- ------------------------------------------------------------
-- 3. GRANTs re-issued (idempotent)
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_portal_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_user_centre() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_profile() TO authenticated;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run as the postgres/super_admin role)
-- ============================================================
--
-- 1. Column exists. Expect 1 row: force_logout_at timestamptz.
--
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'portal_users'
--    AND column_name = 'force_logout_at';
--
-- 2. All three helpers carry BOTH guards (v69 archived + v70 iat).
--    Expect 3 rows, every row true/true.
--
-- SELECT p.proname,
--        pg_get_functiondef(p.oid) LIKE '%archived_at IS NULL%' AS has_archived_guard,
--        pg_get_functiondef(p.oid) LIKE '%auth.jwt()->>''iat''%' AS has_iat_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('get_portal_user_role','get_portal_user_centre','get_portal_profile')
--  ORDER BY p.proname;
--
-- 3. Live check (needs a real forced-out user — do this LAST, on a
--    THROWAWAY test row you reset afterwards, or skip): sign in as
--    the user, set force_logout_at = now(), and confirm every portal
--    screen denies them with their EXISTING token; sign out and sign
--    back in — the new token works again.
--
-- 4. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
