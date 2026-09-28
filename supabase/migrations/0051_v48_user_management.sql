-- ============================================================
-- v48 — superadmin user management: custom roles, invites, access status
-- ============================================================
-- Run AFTER v47. Non-destructive; safe to re-run.
--
-- WHAT THIS ADDS (and what it deliberately does NOT):
-- 1. custom_roles — named roles that map onto ONE base role. Enforcement
--    stays exactly where it is: portal_users.role always holds a base
--    value, so every RLS policy, trigger and client gate behaves
--    identically. A custom role can never widen access; unknown custom
--    ids are ignored. This keeps the fail-closed design intact with zero
--    policy rewrites.
-- 2. portal_users.custom_role_id — display label for the Users page.
-- 3. portal_invitations + claim_portal_invite(p_token) — invite-based
--    provisioning WITHOUT a service_role key anywhere near the client.
--    The superadmin issues an invite (email + role + centre/badge);
--    the invitee signs in (public signup or a dashboard-created auth
--    user) and claims it. The RPC checks: signed in, invite exists,
--    unclaimed, unexpired, email matches the caller's auth email,
--    role/centre/badge completeness — then upserts portal_users and
--    burns the invite (single-use).
-- 4. my_access_status() — lets the AccessDenied screen tell "suspended"
--    apart from "no login", without exposing anyone else's row.
-- 5. audit_log index on (table_name, created_at) for user-admin audit
--    reads (table_name='portal_users' etc.).
--
-- NOT included on purpose:
-- - Per-user permission flags beyond roles. portal_users.permissions
--   is client-read only and unenforced server-side; wiring UI grants to
--   it would be insecure theater (RLS answers from `role`). Roles —
--   system or custom-mapped — remain the single permission model.
-- - Auth user creation/deletion. Impossible with the anon key by design;
--   suspension (is_active, already wired into the identity helpers)
--   plus invite revocation covers the lifecycle.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. custom_roles
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_role text NOT NULL
    CHECK (base_role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner','vss_operator')),
  description text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz DEFAULT now()
);
-- Case-insensitive uniqueness: 'Night Scanner' vs 'night scanner' must not
-- fork into two labels for the same privilege.
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_roles_name
  ON public.custom_roles (lower(name));

ALTER TABLE public.custom_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_roles_admin ON public.custom_roles;
CREATE POLICY custom_roles_admin ON public.custom_roles
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');
GRANT ALL ON public.custom_roles TO authenticated;

-- ------------------------------------------------------------
-- 2. portal_users.custom_role_id (display label; enforcement unchanged)
-- ------------------------------------------------------------
ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS custom_role_id uuid
  REFERENCES public.custom_roles (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_portal_users_custom_role
  ON public.portal_users (custom_role_id);

-- ------------------------------------------------------------
-- 3. portal_invitations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  role text NOT NULL
    CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner','vss_operator')),
  custom_role_id uuid REFERENCES public.custom_roles (id) ON DELETE SET NULL,
  centre text,
  badge_number text,
  -- Claim code: short, human-transcribable. Generated client-side
  -- (crypto-random) with retry-on-conflict; the token is the fallback.
  code text NOT NULL UNIQUE,
  token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  claimed_at timestamptz,
  claimed_by uuid,
  created_by text,
  created_at timestamptz DEFAULT now()
);
-- One open invite per email: re-inviting replaces the pending one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invite_open_email
  ON public.portal_invitations (lower(email)) WHERE claimed_at IS NULL;

ALTER TABLE public.portal_invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invite_admin ON public.portal_invitations;
CREATE POLICY invite_admin ON public.portal_invitations
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');
GRANT ALL ON public.portal_invitations TO authenticated;

-- ------------------------------------------------------------
-- 4. claim_portal_invite(p_token) — invite redemption (single-use)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_portal_invite(text);
CREATE OR REPLACE FUNCTION public.claim_portal_invite(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inv public.portal_invitations;
  v_uid uuid;
  v_email text;
  v_base text;
  v_exists boolean;
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
  -- always a base value — custom_role_id is display only.
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
    is_active = true;

  -- Single-use: burn the invite only AFTER the login exists.
  UPDATE public.portal_invitations
     SET claimed_at = now(), claimed_by = v_uid
   WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'role', v_inv.role, 'centre', v_inv.centre);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_portal_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_portal_invite(text) TO authenticated;

-- ------------------------------------------------------------
-- 5. my_access_status() — own login state for the denied screen
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.my_access_status();
CREATE OR REPLACE FUNCTION public.my_access_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_found boolean;
  v_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('signed_in', false, 'has_login', false, 'active', false);
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.portal_users WHERE auth_id = auth.uid()) INTO v_found;
  SELECT is_active INTO v_active FROM public.portal_users WHERE auth_id = auth.uid();
  RETURN jsonb_build_object('signed_in', true, 'has_login', v_found, 'active', COALESCE(v_active, false));
END;
$$;
REVOKE ALL ON FUNCTION public.my_access_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_access_status() TO authenticated;

-- ------------------------------------------------------------
-- 6. audit_log index for user-admin reads
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audit_log_table_created_idx
  ON public.audit_log (table_name, created_at DESC);

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying, as super_admin)
-- ============================================================
--
-- 1. Tables, column and functions exist:
--    SELECT to_regclass('public.custom_roles'),
--           to_regclass('public.portal_invitations'),
--           proname FROM pg_proc WHERE proname IN ('claim_portal_invite','my_access_status');
--    Expect: both classes non-null, both functions present.
--
-- 2. RLS is on and EXECUTE is authenticated-only:
--    SELECT tablename, rowsecurity FROM pg_tables
--     WHERE tablename IN ('custom_roles','portal_invitations');
--    Expect: rowsecurity = true, true.
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--     WHERE routine_name = 'claim_portal_invite';
--    Expect: authenticated EXECUTE, no PUBLIC row.
--
-- 3. Invite lifecycle (replace values; run as different auth users where noted):
--    a. As super_admin: INSERT INTO portal_invitations
--       (email, name, role, centre, code) VALUES
--       ('probe@example.com','Probe','centre_user','DELHI','PROBE123');
--       Expect: 1 row.
--    b. Second open invite for the same email must fail:
--       INSERT ... same email ...; Expect: unique violation on uq_invite_open_email.
--    c. Signed in as probe@example.com (no portal_users row):
--       SELECT public.my_access_status();
--       Expect: {"signed_in": true, "has_login": false, "active": false}.
--    d. SELECT public.claim_portal_invite('WRONGCODE');
--       Expect: 'Invite code not recognized'.
--    e. SELECT public.claim_portal_invite('PROBE123');
--       Expect: {"ok": true, "role": "centre_user", "centre": "DELHI"};
--       portal_users now has the row with is_active = true.
--    f. SELECT public.claim_portal_invite('PROBE123') again;
--       Expect: 'already been used'.
--    g. Signed in as anyone else: claim another open invite issued to a
--       different email. Expect: 'different email address'.
--    h. Expired invite (expires_at < now()): Expect: 'has expired'.
--    Clean up probe rows afterwards (DELETE the invite + portal_users row).
--
-- 4. Existing logins unaffected: SELECT count(*) FROM portal_users WHERE
--    custom_role_id IS NULL; Expect: the pre-migration count (column defaults
--    to NULL; no enforcement change since role values are untouched).
--
-- 5. Advisor checklist: run `supabase db advisors` (needs CLI v2.81.3+) and
--    confirm no new SECURITY DEFINER / RLS warnings beyond the reviewed
--    auth.uid()-checked functions above.
