-- ============================================================
-- V69: USER LIFECYCLE — ARCHIVE SUPPORT (portal_users.archived_at)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- The Users page needs to ARCHIVE logins (leaver / departed sewadars)
-- without deleting history: an archived login must instantly stop
-- working everywhere — every RLS policy, every SECURITY DEFINER
-- helper, invite redemption — while the row (and its audit trail)
-- stays in the database for restore. Soft-delete via a timestamp:
-- archived_at IS NULL means "live"; archived_by records who did it.
--
-- SCOPE / SAFETY
-- ------------------------------------------------------------
-- - ADD COLUMN IF NOT EXISTS archived_at timestamptz, archived_by
--   text — pure additive, zero data loss, zero breakage for existing
--   rows (both default NULL = live, exactly today's behaviour).
-- - Partial index on archived_at (archived rows are rare; the Users
--   page archive list and the helper filters are the only readers).
-- - get_portal_user_role / get_portal_user_centre / get_portal_profile
--   recreated with IDENTICAL signatures, adding
--   AND archived_at IS NULL. An archived login resolves to NULL
--   role/centre/profile → every policy and helper that gates on
--   these denies it, fail-closed.
-- - claim_portal_invite: an archived login cannot be re-provisioned
--   through an invite (raise 'archived — restore from Users page');
--   a LEGIT re-provision (row restored to archived_at IS NULL by the
--   admin, then invite claimed) clears archived_at/archived_by.
-- - GRANTs re-issued on all four functions.
-- - NO DELETE / UPDATE / DROP anywhere in this file. Non-destructive;
--   safe to re-run (every statement is IF NOT EXISTS / OR REPLACE).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Columns (idempotent; existing rows stay live)
-- ------------------------------------------------------------
ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by text;

-- ------------------------------------------------------------
-- 2. Partial index — archived rows are the rare case
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_portal_users_archived_at
  ON public.portal_users(archived_at)
  WHERE archived_at IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Helpers — identical signatures, archived logins resolve
--    to NULL (denied) instead of their role/centre/profile.
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
  WHERE auth_id = auth.uid() AND is_active = true AND archived_at IS NULL;
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
  WHERE auth_id = auth.uid() AND is_active = true AND archived_at IS NULL;
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
  WHERE pu.auth_id = auth.uid() AND pu.is_active = true AND pu.archived_at IS NULL;
  RETURN v_result;
END;
$$;

-- ------------------------------------------------------------
-- 4. claim_portal_invite — archived logins are refused; a legit
--    re-provision clears the archive stamp.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_portal_invite(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inv public.portal_invitations;
  v_uid uuid;
  v_email text;
  v_base text;
  v_exists boolean;
  v_archived boolean;
BEGIN
  -- Caller must be signed in. RLS cannot express this for us (the caller
  -- has no portal_users row yet, so every policy denies them) — hence
  -- SECURITY DEFINER with explicit checks, and EXECUTE granted to
  -- `authenticated` only (revoked from PUBLIC below).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  v_uid := auth.uid();
  v_email := lower(auth.jwt()->>'email');
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'Enter an invite code';
  END IF;

  -- Token (uuid) or short code — never enumerate which half matched.
  IF btrim(p_token) ~ '^[0-9a-fA-F-]{36}$' THEN
    SELECT * INTO v_inv FROM public.portal_invitations
     WHERE token = btrim(p_token)::uuid;
  ELSE
    SELECT * INTO v_inv FROM public.portal_invitations
     WHERE code = btrim(p_token);
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite code not recognized';
  END IF;
  IF v_inv.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invite has already been used';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'This invite has expired — ask the ASO office for a new one';
  END IF;
  -- Bind the invite to its email: a leaked code is useless to anyone else.
  IF v_email IS NULL OR lower(v_inv.email) <> v_email THEN
    RAISE EXCEPTION 'This invite was issued to a different email address';
  END IF;
  -- Completeness, mirroring the Users-page validator (invitationErrors):
  -- centre roles need a centre, scanner/incharge need a badge.
  IF v_inv.role IN ('centre_user','centre_admin')
     AND (v_inv.centre IS NULL OR btrim(v_inv.centre) = '') THEN
    RAISE EXCEPTION 'This invite is missing its centre — ask the ASO office to re-issue it';
  END IF;
  IF v_inv.role IN ('dept_incharge','scanner')
     AND (v_inv.badge_number IS NULL OR btrim(v_inv.badge_number) = '') THEN
    RAISE EXCEPTION 'This invite is missing its badge number — ask the ASO office to re-issue it';
  END IF;
  -- Custom role must exist and agree with the invite's base role.
  IF v_inv.custom_role_id IS NOT NULL THEN
    SELECT base_role INTO v_base FROM public.custom_roles
     WHERE id = v_inv.custom_role_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This invite names a role that no longer exists — ask the ASO office to re-issue it';
    END IF;
    IF v_base <> v_inv.role THEN
      RAISE EXCEPTION 'This invite is inconsistent — ask the ASO office to re-issue it';
    END IF;
  END IF;
  -- An archived login cannot be re-provisioned through an invite — the
  -- admin must restore it from the Users page first. Checked BEFORE the
  -- active-login check so the archived user gets the actionable message.
  SELECT EXISTS(
    SELECT 1 FROM public.portal_users
     WHERE auth_id = v_uid AND archived_at IS NOT NULL
  ) INTO v_archived;
  IF v_archived THEN
    RAISE EXCEPTION 'archived — restore from Users page';
  END IF;
  -- An already-active login cannot be re-provisioned (role changes go
  -- through the Users page). The invite stays open for the admin to revoke.
  SELECT EXISTS(
    SELECT 1 FROM public.portal_users
     WHERE auth_id = v_uid AND is_active IS NOT FALSE
  ) INTO v_exists;
  IF v_exists THEN
    RAISE EXCEPTION 'This login is already active — ask the ASO office to update it instead';
  END IF;

  -- Provision (or reactivate) the login. Enforcement reads `role`, which is
  -- always a base value — custom_role_id is display only. A legit
  -- re-provision (admin restored the row, or a half-created row) clears
  -- any archive stamp so the login is live again.
  INSERT INTO public.portal_users
    (auth_id, email, name, role, custom_role_id, centre, badge_number, is_active)
  VALUES
    (v_uid, v_inv.email, NULLIF(btrim(v_inv.name), ''), v_inv.role,
     v_inv.custom_role_id, NULLIF(btrim(v_inv.centre), ''),
     NULLIF(btrim(v_inv.badge_number), ''), true)
  ON CONFLICT (auth_id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    custom_role_id = EXCLUDED.custom_role_id,
    centre = EXCLUDED.centre,
    badge_number = EXCLUDED.badge_number,
    is_active = true,
    archived_at = NULL,
    archived_by = NULL;

  -- Single-use: burn the invite only AFTER the login exists.
  UPDATE public.portal_invitations
     SET claimed_at = now(), claimed_by = v_uid
   WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'role', v_inv.role, 'centre', v_inv.centre);
END;
$$;

-- ------------------------------------------------------------
-- 5. GRANTs re-issued
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_portal_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_user_centre() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_portal_profile() TO authenticated;
REVOKE ALL ON FUNCTION public.claim_portal_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_portal_invite(text) TO authenticated;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run as the postgres/super_admin role)
-- ============================================================
--
-- 1. Both columns exist with the right types. Expect 2 rows:
--    archived_at timestamptz, archived_by text.
--
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'portal_users'
--    AND column_name IN ('archived_at', 'archived_by')
--  ORDER BY column_name;
--
-- 2. Partial index exists. Expect 1 row.
--
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'portal_users'
--    AND indexname = 'idx_portal_users_archived_at';
--
-- 3. All three helpers carry the archived guard. Expect 3 rows,
--    every has_guard = true.
--
-- SELECT p.proname,
--        pg_get_functiondef(p.oid) LIKE '%archived_at IS NULL%' AS has_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('get_portal_user_role','get_portal_user_centre','get_portal_profile')
--  ORDER BY p.proname;
--
-- 4. claim_portal_invite refuses archived logins and clears the
--    stamp on re-provision. Expect raise_guard = true AND
--    clears_stamp = true.
--
-- SELECT pg_get_functiondef(p.oid) LIKE '%archived — restore from Users page%' AS raise_guard,
--        pg_get_functiondef(p.oid) LIKE '%archived_at = NULL%'               AS clears_stamp
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'claim_portal_invite';
--
-- 5. Live check (needs a real archived user — do this LAST, on a
--    THROWAWAY test row you delete afterwards, or skip): sign in as
--    an archived portal user and confirm every portal screen denies
--    them (helpers return NULL), and that claiming their invite
--    raises 'archived — restore from Users page'.
--
-- 6. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
