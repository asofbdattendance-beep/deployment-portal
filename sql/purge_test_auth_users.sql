-- ============================================================
-- PURGE hand-inserted test auth users  (run in the Supabase SQL editor)
-- ------------------------------------------------------------
-- USE THIS WHEN: `node scripts/rebuild_test_logins.mjs` fails with
--   HTTP 500 on listUsers / deleteUser
-- i.e. GoTrue will not let the Admin API remove the malformed rows.
--
-- WHY THIS EXISTS
--   listUsers is GET /auth/v1/admin/users — it enumerates and marshals
--   EVERY user. A hand-inserted row with NULLs where GoTrue expects
--   strings makes that call 500, which means the Admin API cannot be
--   used to delete the very row that is breaking it. Deadlock.
--   The SQL editor runs as postgres and can delete rows directly, which
--   is the only way out.
--
-- ORDER MATTERS. auth.identities.user_id REFERENCES auth.users(id), so
-- identities MUST go first or the users delete raises. (The repo's own
-- sql/create_test_users.sql notes this: "Identities must be deleted first
-- if FK is not CASCADE".)
--
-- CASCADE DIRECTION — verified, and a trap:
--   public.portal_users.auth_id is REFERENCES auth.users(id) ON DELETE
--   CASCADE, which cascades the OTHER way: deleting an auth.users row
--   removes the portal_users rows pointing at it. Deleting a
--   portal_users row does NOT delete the auth user. So capture the
--   auth_ids BEFORE deleting portal_users.
--
-- ⚠️  DESTRUCTIVE. Scoped to test.%@portal.test only — verified below.
--     Real accounts (e.g. the ASO) are never touched.
-- ============================================================


-- ============================================================
-- STEP 0 — SAFETY PREVIEW. Run this FIRST and READ the output.
--         Nothing is deleted in this step.
-- ============================================================
SELECT u.email,
       u.id,
       (SELECT count(*) FROM auth.identities i WHERE i.user_id = u.id) AS identities,
       (SELECT count(*) FROM public.portal_users p WHERE p.auth_id = u.id) AS portal_rows
  FROM auth.users u
 WHERE u.email LIKE 'test.%@portal.test'
 ORDER BY u.email;

-- If that returns MORE than 6 rows, or shows a real account, STOP and tell me.
-- Expected: 6 rows, the test.%@portal.test addresses only.


-- ============================================================
-- STEP 1 — the purge. Uncomment and run ONLY after Step 0 looks right.
-- ============================================================
-- CREATE TEMP TABLE _test_ids AS
--   SELECT id FROM auth.users WHERE email LIKE 'test.%@portal.test';

-- -- 1a. identities first (FK to auth.users)
-- DELETE FROM auth.identities
--  WHERE user_id IN (SELECT id FROM _test_ids);

-- -- 1b. sessions / tokens that reference the users
-- DELETE FROM auth.sessions
--  WHERE user_id IN (SELECT id FROM _test_ids);
-- DELETE FROM auth.mfa_factors
--  WHERE user_id IN (SELECT id FROM _test_ids);

-- -- 1c. the auth users themselves
-- DELETE FROM auth.users
--  WHERE id IN (SELECT id FROM _test_ids);

-- -- 1d. now the portal-side rows (safe: their auth rows are already gone)
-- DELETE FROM public.department_incharge_selections
--  WHERE selected_by IN ('create_test_users_direct','provision_test_logins','rebuild_test_logins');
-- DELETE FROM public.portal_users
--  WHERE email LIKE 'test.%@portal.test';

-- The statements above are intentionally separate: if 1c raises, 1a/1b have
-- already run and 1d simply has nothing to do. Re-run is harmless.


-- ============================================================
-- STEP 2 — VERIFY the purge (expect 0 / 0 / 0), then check GoTrue:
--           Dashboard → Authentication → Users. The list must load
--           without error. That is the real proof the 500 is gone.
-- ============================================================
SELECT (SELECT count(*) FROM auth.users         WHERE email LIKE 'test.%@portal.test') AS users_left,
       (SELECT count(*) FROM auth.identities    WHERE user_id NOT IN (SELECT id FROM auth.users)) AS orphan_identities,
       (SELECT count(*) FROM public.portal_users WHERE email LIKE 'test.%@portal.test') AS portal_left;


-- ============================================================
-- STEP 3 — recreate the accounts through GoTrue, which writes every
--           column the way GoTrue expects ('' rather than NULL):
--
--   export SUPABASE_URL="https://wgavvihuwwwoqpbqntgp.supabase.co"
--   export SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."   # Dashboard → API Keys → Secret
--   export TEST_USER_PASSWORD='Test@123'
--   node scripts/rebuild_test_logins.mjs
--
-- With the bad rows gone, listUsers will succeed and the script will
-- create all six roles, link portal_users by auth_id, and wire the
-- dept-incharge selection.
-- ============================================================
