-- ============================================================
-- V78: SECURITY DEFINER + RLS hardening (linter ERRORs + WARNs)
--
-- WHY THIS RECURS (read before "fixing" again):
--   Postgres grants EXECUTE to PUBLIC by default on every new
--   function, so anon + authenticated can call any public
--   SECURITY DEFINER function over /rest/v1/rpc/* until a migration
--   explicitly REVOKEs it. Newer migrations in this repo already do
--   (v56, v58, v62, v63, v73, v74: REVOKE ALL FROM PUBLIC + GRANT to
--   authenticated), but ~70 older functions predate the convention,
--   so every `supabase db advisors` run re-lists them. This migration
--   applies the convention to ALL of them at once, generically, so a
--   future v79+ function is covered even if its author forgets the
--   REVOKE — and establishes the rule below for new code.
--
-- RULE FOR NEW MIGRATIONS (do not drift):
--   Every CREATE OR REPLACE FUNCTION ... SECURITY DEFINER in public
--   MUST be followed by:
--     REVOKE ALL ON FUNCTION <sig> FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION <sig> TO authenticated, service_role;
--   plus SET search_path = '' on the function itself. Anon EXECUTE is
--   allowed ONLY for pre-auth functions (today: check_login_rate,
--   portal_app_version) with a comment saying why.
--
-- WHAT THIS CHANGES (non-destructive, safe to re-run):
--   1. public.dp_centres: ENABLE RLS (policy centres_read already
--      exists from v28:176 but RLS was never enabled — that is the
--      policy_exists_rls_disabled + rls_disabled_in_public ERRORs).
--      Frontend reads dp_centres as authenticated (src/lib/supabase.js
--      fetchAllRows('dp_centres')), so behaviour is unchanged; anon
--      direct reads are now denied (fail-closed).
--   2. public.users: INTENTIONALLY EXCLUDED (review BLOCKER).
--      Legacy attendance-portal table, NOT owned here (never created in
--      sql/ or supabase/; sibling tables are "SHARED TABLES" per v28).
--      RLS is currently OFF, so the sibling app may read it as anon via
--      PostgREST today — turning RLS ON (with any policy set, or with
--      zero policies) would silently zero-out that app's reads. The
--      rls_disabled_in_public ERROR on users is therefore ACKNOWLEDGED
--      as cosmetic and left for the owning app to fix. This migration
--      does not touch public.users at all.
--   3. ALL public SECURITY DEFINER functions, any signature:
--      a. ALTER ... SET search_path = '' (defensive no-op: every
--         repo-defined SD function already declares it; this covers
--         drift plus any non-repo function sharing public).
--      b. REVOKE ALL FROM PUBLIC, anon (kills the anon_* WARNs).
--      c. GRANT EXECUTE TO authenticated, service_role (preserves
--         every current frontend RPC + policy-helper + edge-function
--         path; no access widened, none narrowed for signed-in use).
--      d. Re-grant the two pre-auth functions to anon:
--         check_login_rate (v73 posture preserved; edge callers use
--         service_role, anon grant is defense-in-depth) and
--         portal_app_version (v50: fetchDbVersion runs at boot before
--         login, null-safe). These two anon WARNs are
--         INTENTIONAL and will still lint — documented, not a miss.
--
-- WHAT THIS DELIBERATELY DOES NOT DO (do not "finish" it later
-- without a plan):
--   Authenticated EXECUTE on SECURITY DEFINER RPCs is the app's API:
--   the frontend calls scan_in/scan_out/get_scan_state/attendance_*
--   /previsit_*/claim_portal_invite/... as authenticated, and RLS
--   policies call get_portal_user_role()/get_my_subtree_centres/
--   is_my_incharge_dept_badge()/... during evaluation (revoking
--   authenticated would break both). Every such function gates on
--   the caller's portal role inside its body (v56 pattern). So the
--   authenticated_* WARNs REMAIN BY DESIGN after this migration —
--   narrowed to signed-in callers with in-body authz, which is the
--   strongest posture available without a SECURITY INVOKER rewrite.
--   Treat further authenticated_* lines as accepted-risk, not defects.
--
-- NOT IN SQL (user does in Dashboard):
--   auth_leaked_password_protection: Dashboard → Authentication →
--   Password protection → enable "Check for leaked passwords"
--   (HaveIBeenPwned). No migration can set it; the WARN clears on
--   the next advisor run after toggling.
--
-- Run AFTER v77. MIN_SUPPORTED_DB_VERSION stays v75 (pure hardening;
-- nothing in the app gates on v78).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. dp_centres: enable RLS (policy already exists, recreate
--    idempotently in case a DB diverged from v28).
-- ------------------------------------------------------------
ALTER TABLE public.dp_centres ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS centres_read ON public.dp_centres;
CREATE POLICY centres_read ON public.dp_centres
  FOR SELECT TO authenticated USING (true);

-- ------------------------------------------------------------
-- 2. public.users: SKIPPED ON PURPOSE (see header §2).
--    Shared table owned by the attendance portal; enabling RLS here
--    risks breaking that app's anon reads. Pre-flight for the owning
--    app (user runs, read-only):
--      SELECT c.relrowsecurity FROM pg_class c
--       WHERE c.oid = 'public.users'::regclass;
--      SELECT grantee, privilege_type
--        FROM information_schema.role_table_grants
--       WHERE table_schema='public' AND table_name='users';
--    If anon holds any grant, do NOT enable RLS from this repo.
-- ------------------------------------------------------------
-- (no statement)

-- ------------------------------------------------------------
-- 3a. Pin empty search_path on every public SECURITY DEFINER fn.
--     (ALTER preserves the body; only the config changes.)
-- ------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %L', r.sig, '');
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 3b. Revoke PUBLIC + anon on every public SECURITY DEFINER fn.
-- ------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 3c. Preserve signed-in + service_role on every public SD fn.
--     (Status quo for authenticated; without this, functions that
--     relied on the PUBLIC default would break for the app.)
-- ------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 3d. Pre-auth allowlist: anon EXECUTE ONLY here, with reasons.
--     check_login_rate: login throttling runs before a session
--       exists (v73). portal_app_version: boot version handshake
--       runs before login (src/lib/version.js fetchDbVersion).
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text, int, int) TO anon;
GRANT EXECUTE ON FUNCTION public.portal_app_version() TO anon;

-- ------------------------------------------------------------
-- 4. Version registry (v50 convention: append own row only).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v78')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — user runs AFTER applying)
-- ============================================================
-- -- 1. RLS now enabled on dp_centres (users intentionally untouched):
-- -- SELECT relname, relrowsecurity FROM pg_class
-- --  WHERE relnamespace = 'public'::regnamespace
-- --    AND relname = 'dp_centres';
-- -- -- expect 1 row, relrowsecurity = t.
--
-- -- 2. No anon EXECUTE left except the 2 intentional pre-auth fns:
-- -- SELECT p.oid::regprocedure AS fn
-- --   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
-- --        LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
-- --  WHERE n.nspname = 'public' AND p.prosecdef
-- --    AND a.grantee = 'anon'::regrole AND a.privilege_type = 'EXECUTE';
-- -- -- expect exactly check_login_rate(text,text,integer,integer)
-- -- -- and portal_app_version(), nothing else.
--
-- -- 3. Empty search_path pinned everywhere:
-- -- SELECT p.oid::regprocedure AS fn, s.setconfig
-- --   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- --   LEFT JOIN pg_db_role_setting s
-- --     ON s.setfunction = p.oid AND s.setrole = 0 AND s.setdatabase = 0
-- --  WHERE n.nspname = 'public' AND p.prosecdef
-- --    AND NOT (s.setconfig = ARRAY['search_path=']);
-- -- -- expect 0 rows.
--
-- -- 4. Behaviour spot-checks (as authenticated):
-- -- SELECT public.portal_app_version();  -- expect 'v78'
-- -- SELECT * FROM public.dp_centres ORDER BY name LIMIT 3;  -- expect rows
-- -- SELECT public.get_portal_user_role();  -- expect own role (not error)
