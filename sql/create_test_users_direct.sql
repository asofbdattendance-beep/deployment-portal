-- ####################################################################
-- #  ⛔ DEPRECATED — DO NOT RUN THIS FILE. IT WILL BREAK AUTH.      #
-- ####################################################################
--
-- PROVEN BROKEN IN PRODUCTION on 2026-09-26. Running this file
-- hand-inserted rows into auth.users that made GoTrue return
--   HTTP 500 on POST /auth/v1/token?grant_type=password
-- so NO user could sign in — and, worse, the Admin API could not
-- repair it either: listUsers 500s because it marshals every user,
-- so the API could not delete the rows that were breaking it.
-- Recovery required running sql/purge_test_auth_users.sql in the SQL
-- editor, then recreating through the Admin API.
--
-- Root cause per Supabase's docs: a hand-inserted auth.users row has
-- NULLs in columns the Auth service expects to hold '' — and GoTrue
-- updates last_sign_in_at BEFORE building the response, so a partially
-- successful login persists and then the response SELECT dies. That
-- makes it look like sign-in worked while it is actually 500ing.
--
-- ✅ USE THIS INSTEAD:  node scripts/rebuild_test_logins.mjs
--    (Admin API — GoTrue writes every field the way it expects)
--    If GoTrue is already wedged, purge first with
--    sql/purge_test_auth_users.sql, THEN run the script.
--
-- This file is retained ONLY as a record of the failed approach.
-- It is kept so nobody re-derives it. Do not "fix" and re-run it.
-- ####################################################################

-- ============================================================
-- CREATE TEST USERS — PURE SQL (auth.users + auth.identities + portal_users)
-- ------------------------------------------------------------
-- ⛔ HISTORICAL / DO NOT RUN — see the deprecation banner above.
--    Everything below is the failed approach, kept for reference only.
-- ============================================================
-- One transaction. Idempotent. Safe to re-run.
--
-- For each test login this inserts/updates THREE things:
--   1. auth.users        — with a real bcrypt encrypted_password
--   2. auth.identities   — REQUIRED by GoTrue v2 for email/password login
--   3. public.portal_users — looked up by auth_id (ON CONFLICT)
--
-- ⚠️  KNOWN RISK, stated once and then left alone: this repo recorded that
--     hand-inserting auth.users can make GoTrue 500 ("Database error
--     querying schema") — see sql/create_test_users.sql lines 10-17, which
--     disarmed exactly this approach in favour of the Admin API.
--
--     ⚠️  IF YOU HIT A 500 ON /auth/v1/token?grant_type=password, THIS FILE
--     IS THE REASON. A 500 (not 400) means the auth row exists but a field
--     GoTrue reads at token time is wrong. The usual culprit is
--     auth.identities.email: newer GoTrue versions have that column and
--     expect it populated, and a hand-written INSERT cannot know to write
--     it. The identities INSERT below therefore sets it CONDITIONALLY —
--     only when your schema actually has the column — and a self-check at
--     the end reports any identity field still unpopulated.
--     Run sql/diagnose_auth_500.sql to confirm, or use
--     scripts/create_test_logins.mjs (Admin API) which cannot produce a row
--     GoTrue's own token handler rejects.
--
-- REQUIRES: pgcrypto (for crypt/gen_salt). Enabled by default on Supabase;
--           if crypt() is unknown, run: CREATE EXTENSION IF NOT EXISTS pgcrypto;
--
-- PASSWORD: "Test@123" for every account, as requested. Hardcoded on
--           purpose because this is throwaway test data — but it is a weak,
--           publicly-known password. Do NOT reuse it anywhere real, and
--           delete these accounts when the visit ends (see step 4).
--
-- ⚠️  DO NOT RE-RUN v23_sync_portal_users_centre_admins.sql afterwards.
--     Its line 22 deletes every portal_users row whose role is not
--     aso/super_admin, which would wipe all of these.
-- ============================================================

DO $$
DECLARE
  c_password   constant text := 'Test@123';
  c_centre     constant text := 'SECTOR-15-A';   -- real root CENTRE (parent_centre IS NULL)
  v_hash       text;
  v_instance   uuid;
  v_uid        uuid;
  v_email      text;
  v_name       text;
  v_role       text;
  v_badge      text;
  v_missing    text;
  v_created    integer := 0;
  v_updated    integer := 0;
BEGIN
  ------------------------------------------------------------------
  -- 0a. PREFLIGHT. This script writes a fixed column list to auth.users.
  --      If the deployed GoTrue version lacks any of them, the INSERT
  --      would die mid-statement and create NOTHING at all. Detect that
  --      up front and say which column, instead of failing cryptically.
  ------------------------------------------------------------------
  FOR v_missing IN
    SELECT c.name
      FROM unnest(ARRAY['instance_id','id','aud','role','email','encrypted_password',
                        'email_confirmed_at','confirmation_sent_at','created_at','updated_at',
                        'raw_app_meta_data','raw_user_meta_data','is_super_admin','is_sso_user']) AS c(name)
     WHERE NOT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = c.name)
  LOOP
    RAISE EXCEPTION
      'auth.users has no column "%" — this GoTrue version differs from the one this script targets. Use scripts/create_test_logins.mjs (Admin API) instead, which writes whatever fields the deployed version needs.', v_missing;
  END LOOP;

  ------------------------------------------------------------------
  -- 0. One bcrypt hash for everyone (bcrypt is slow — do it once).
  --    gen_salt('bf') defaults to cost 10, matching GoTrue, so the
  --    hash is verifiable by the real login path.
  ------------------------------------------------------------------
  v_hash := crypt(c_password, gen_salt('bf'));

  -- instance_id: reuse the live one if the table has any row.
  SELECT instance_id INTO v_instance
    FROM auth.users WHERE instance_id IS NOT NULL LIMIT 1;
  IF v_instance IS NULL THEN
    v_instance := '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  -- Sanity check on the centre before we hang 6 rows off it.
  IF to_regclass('public.dp_centres') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.dp_centres WHERE name = c_centre) THEN
    RAISE EXCEPTION 'centre % not found in dp_centres — change c_centre and re-run', c_centre;
  END IF;

  ------------------------------------------------------------------
  -- 1 + 2 + 3. auth user, identity, and portal row, per account.
  ------------------------------------------------------------------
  FOR v_email, v_name, v_role, v_badge IN
    SELECT * FROM (VALUES
      ('test.aso@portal.test',          'Test ASO',           'aso',           NULL::text),
      ('test.operator@portal.test',     'Test VSS Operator',  'vss_operator',  NULL::text),
      ('test.centre.admin@portal.test', 'Test Centre Admin',  'centre_admin',  NULL::text),
      ('test.centre.user@portal.test',  'Test Centre User',   'centre_user',   NULL::text),
      -- Synthetic badge: intentionally NOT a real FB/BH/VS sewadar badge so
      -- a scanner account can never be mistaken for a sewadar. This value
      -- is only an attribution label (in_scanner_badge) — never validated.
      ('test.scanner@portal.test',      'Test Scanner',       'scanner',       'SC-TEST-01')
    ) AS t(email, name, role, badge)
  LOOP
    -- ---- 1. auth.users (lookup by email, insert if absent) ----
    SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email);

    IF v_uid IS NULL THEN
      v_uid := gen_random_uuid();
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, confirmation_sent_at,
        created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        is_super_admin, is_sso_user
      ) VALUES (
        v_instance, v_uid, 'authenticated', 'authenticated', v_email, v_hash,
        now(), now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('name', v_name, 'role', v_role, 'centre', c_centre),
        false, false
      );
      v_created := v_created + 1;
    ELSE
      -- Existing account: just reset the password and confirm the email.
      UPDATE auth.users
         SET encrypted_password = v_hash,
             email_confirmed_at = now(),
             updated_at = now()
       WHERE id = v_uid;
      v_updated := v_updated + 1;
    END IF;

    -- ---- 2. auth.identities ----
    -- GoTrue v2 authenticates email/password through this table. A user
    -- with encrypted_password but NO identity row fails to sign in, so this
    -- is the step hand-written scripts most often miss.
    IF NOT EXISTS (
      SELECT 1 FROM auth.identities WHERE user_id = v_uid AND provider = 'email'
    ) THEN
      INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(),
        v_uid,
        v_uid::text,
        jsonb_build_object(
          'sub', v_uid::text,
          'email', v_email,
          'email_verified', true
        ),
        'email',
        now(), now(), now()
      );
    END IF;

    -- ---- 2b. Populate identities.email WHEN YOUR SCHEMA HAS IT ----
    -- Newer GoTrue carries an `email` column on auth.identities and the
    -- password-grant token handler reads it. A hand-written INSERT has no
    -- way to know the column exists, so we probe for it and set it when
    -- present. Done with EXECUTE so the statement is only parsed on
    -- schemas that actually have the column — otherwise this file would
    -- not even run on older Supabase projects.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'identities'
         AND column_name = 'email'
    ) THEN
      EXECUTE $q$
        UPDATE auth.identities
           SET email = $1
         WHERE user_id = $2
           AND provider = 'email'
           AND (email IS NULL OR email <> $1)
      $q$ USING v_email, v_uid;
    END IF;

    -- ---- 3. public.portal_users, looked up by auth_id ----
    INSERT INTO public.portal_users
      (auth_id, name, email, badge_number, centre, role, permissions, is_active)
    VALUES (v_uid, v_name, v_email, v_badge, c_centre, v_role, '{}'::jsonb, true)
    ON CONFLICT (auth_id) DO UPDATE
      SET name         = EXCLUDED.name,
          email        = EXCLUDED.email,
          badge_number = EXCLUDED.badge_number,
          centre       = EXCLUDED.centre,
          role         = EXCLUDED.role,
          is_active    = true,
          updated_at   = now();
  END LOOP;

  RAISE NOTICE 'auth users: % created, % password-reset', v_created, v_updated;
END $$;

-- ------------------------------------------------------------------
-- 2. dept_incharge — needs REAL data, not just a row.
--
--    get_my_dept_ids() matches department_incharge_selections.badge_number
--    against portal_users.badge_number, so an incharge without a selection
--    sees "Not a Dept Incharge for this schedule" AND an empty v39
--    attendance scope. So we borrow the badge of a sewadar who is genuinely
--    deployed, discovered at run time.
--
--    trg_check_incharge_selection (BEFORE INSERT) enforces: schedule open,
--    badge deployed to that department, root centres match. It is
--    SECURITY DEFINER so it applies to this run too. Its "Only ASO" branch
--    does NOT block us: with no portal role get_portal_user_role() is NULL,
--    and `IF NULL` is treated as false.
--
--    Same password as the rest. Skips cleanly (NOTICE, no error) if there
--    is no open schedule with a deployment yet.
-- ------------------------------------------------------------------
DO $$
DECLARE
  c_password constant text := 'Test@123';
  c_email    constant text := 'test.incharge@portal.test';
  c_name     constant text := 'Test Dept Incharge';
  v_hash     text;
  v_instance uuid;
  v_uid      uuid;
  v_badge    text;
  v_centre   text;
  v_dept     uuid;
  v_sched    uuid;
BEGIN
  -- Anything unexpected in this block (a renamed/absent deployments table, a
  -- permission quirk) becomes a NOTICE rather than aborting the script, so a
  -- dept_incharge problem can never leave you thinking the whole run failed.
  -- The 5 accounts from block 1 are already committed and usable.
  BEGIN
  v_hash := crypt(c_password, gen_salt('bf'));
  SELECT instance_id INTO v_instance
    FROM auth.users WHERE instance_id IS NOT NULL LIMIT 1;
  IF v_instance IS NULL THEN
    v_instance := '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  -- 1. find a real deployed sewadar to act as
  SELECT d.schedule_id, d.badge_number, d.centre,
         COALESCE(d.deployed_department_id, d.department_id)
    INTO v_sched, v_badge, v_centre, v_dept
    FROM public.deployments d
    JOIN public.deployment_schedules s
      ON s.id = d.schedule_id AND s.status = 'open'
   WHERE COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
   ORDER BY (d.centre = 'SECTOR-15-A') DESC, d.centre, d.badge_number
   LIMIT 1;

  IF v_sched IS NULL THEN
    RAISE NOTICE 'dept_incharge SKIPPED: no OPEN schedule with a deployed sewadar found.';
    RAISE NOTICE 'Finish a deployment on the Schedule Maker, then re-run this file.';
    RETURN;
  END IF;

  -- 2. auth user + identity
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(c_email);
  IF v_uid IS NULL THEN
    v_uid := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmation_sent_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
    ) VALUES (
      v_instance, v_uid, 'authenticated', 'authenticated', c_email, v_hash,
      now(), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('name', c_name, 'role', 'dept_incharge'),
      false, false
    );
  ELSE
    UPDATE auth.users SET encrypted_password = v_hash,
                          email_confirmed_at = now(), updated_at = now()
     WHERE id = v_uid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = v_uid AND provider = 'email') THEN
    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object('sub', v_uid::text, 'email', c_email, 'email_verified', true),
      'email', now(), now(), now()
    );
  END IF;

  -- 2b. Populate identities.email when your schema has the column (see block 1)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'identities'
       AND column_name = 'email'
  ) THEN
    EXECUTE $q$
      UPDATE auth.identities
         SET email = $1
       WHERE user_id = $2
         AND provider = 'email'
         AND (email IS NULL OR email <> $1)
    $q$ USING c_email, v_uid;
  END IF;

  -- 3. portal row carrying the real badge
  INSERT INTO public.portal_users
    (auth_id, name, email, badge_number, centre, role, permissions, is_active)
  VALUES (v_uid, c_name, c_email, v_badge, v_centre, 'dept_incharge', '{}'::jsonb, true)
  ON CONFLICT (auth_id) DO UPDATE
    SET badge_number = EXCLUDED.badge_number, centre = EXCLUDED.centre,
        role = 'dept_incharge', is_active = true, updated_at = now();

  -- 4. the selection that makes get_my_dept_ids() resolve
  INSERT INTO public.department_incharge_selections
    (schedule_id, centre, department_id, badge_number, rank, is_from_pool, selected_by)
  VALUES (v_sched, v_centre, v_dept, v_badge, 1, false, 'create_test_users_direct')
  ON CONFLICT (schedule_id, centre, department_id, badge_number) DO NOTHING;

  RAISE NOTICE 'dept_incharge wired: badge=% centre=% dept=% schedule=%',
    v_badge, v_centre, v_dept, v_sched;

  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'dept_incharge could not be wired: % — the other 5 accounts are unaffected', SQLERRM;
  END;
END $$;

-- ------------------------------------------------------------------
-- 2b. SELF-CHECK — run automatically after provisioning.
--     Reports any auth field GoTrue's token handler may read that is
--     still unpopulated on a test user. This is the fastest way to tell
--     whether a future 500 is ours or something else. All rows should
--     read ok = t. If identities_has_email is f your GoTrue predates
--     that column and it is not a problem.
-- ------------------------------------------------------------------
DO $$
DECLARE v_missing text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users u
              JOIN public.portal_users p ON p.auth_id = u.id
             WHERE p.email LIKE 'test.%@portal.test'
               AND u.encrypted_password IS NULL) THEN
    v_missing := v_missing || ' no_encrypted_password';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u
              JOIN public.portal_users p ON p.auth_id = u.id
             WHERE p.email LIKE 'test.%@portal.test'
               AND u.email_confirmed_at IS NULL) THEN
    v_missing := v_missing || ' email_not_confirmed';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u
              JOIN public.portal_users p ON p.auth_id = u.id
             WHERE p.email LIKE 'test.%@portal.test'
               AND NOT EXISTS (SELECT 1 FROM auth.identities i
                                WHERE i.user_id = u.id AND i.provider = 'email')) THEN
    v_missing := v_missing || ' missing_email_identity';
  END IF;
  -- identities.email check. Done with EXECUTE because Postgres resolves a
  -- column reference at parse time, so a plain `i.email IS NULL` would make
  -- this whole file ERROR on projects whose GoTrue predates that column —
  -- even inside an AND-guarded IF that would otherwise short-circuit.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='auth' AND table_name='identities' AND column_name='email') THEN
    EXECUTE $q$
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM auth.identities i
          JOIN auth.users u ON u.id = i.user_id
          JOIN public.portal_users p ON p.auth_id = u.id
         WHERE p.email LIKE 'test.%@portal.test'
           AND i.provider = 'email'
           AND i.email IS NULL
      ) THEN ' identities.email_null(500 suspect)' ELSE '' END
    $q$ INTO v_missing;
    v_missing := v_missing || '';
  END IF;

  IF v_missing = '' THEN
    RAISE NOTICE 'SELF-CHECK ok — every auth field GoTrue reads is populated';
  ELSE
    RAISE WARNING 'SELF-CHECK found:%  (a 500 on /token is likely)', v_missing;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- 3. VERIFY (run after applying; expect the listed results)
-- ------------------------------------------------------------------
-- A. All three layers present, and the password actually verifies.
--    This is the check that matters — a row in portal_users alone does not
--    let anyone log in.
--    SELECT p.role, p.email, p.centre, p.badge_number, p.is_active,
--           (u.id IS NOT NULL)  AS has_auth_user,
--           (i.id IS NOT NULL)  AS has_identity,
--           (u.encrypted_password = crypt('Test@123', u.encrypted_password)) AS password_ok
--      FROM public.portal_users p
--      JOIN auth.users u ON u.id = p.auth_id
--      LEFT JOIN auth.identities i ON i.user_id = u.id AND i.provider = 'email'
--     WHERE p.email LIKE 'test.%@portal.test'
--     ORDER BY p.role;
--      → 6 rows, all has_auth_user = true, all has_identity = true,
--        all password_ok = true
--      → dept_incharge must have a NON-NULL badge_number
--
-- B. Row counts per email must be exactly 1 (idempotency).
--    SELECT email, count(*) FROM public.portal_users
--     WHERE email LIKE 'test.%@portal.test' GROUP BY email ORDER BY email;
--      → 6 rows, every count = 1
--
-- C. Role coverage. super_admin is absent unless you added it.
--    SELECT role, count(*) FROM public.portal_users
--     WHERE email LIKE 'test.%@portal.test' GROUP BY role ORDER BY role;
--
-- D. The scanner badge must not collide with a real sewadar.
--    SELECT EXISTS (SELECT 1 FROM public.dp_sewadars
--                    WHERE badge_number = 'SC-TEST-01') AS collides_with_sewadar;
--      → f
--
-- E. dept_incharge resolves to a department.
--    SELECT public.is_dept_incharge(s.id, NULL) AS is_incharge
--      FROM public.deployment_schedules s WHERE s.status = 'open' LIMIT 1;
--      → t
--
-- F. THEN actually sign in at the portal with Test@123. If GoTrue returns
--    "Database error querying schema" or "Invalid login credentials", fall
--    back to scripts/create_test_logins.mjs (Admin API) — that is the
--    supported path and the failure this file's header warns about.

-- ------------------------------------------------------------------
-- 4. TEARDOWN (destructive — uncomment deliberately)
-- ------------------------------------------------------------------
-- DELETE FROM public.department_incharge_selections
--  WHERE selected_by = 'create_test_users_direct';
-- DELETE FROM public.portal_users WHERE email LIKE 'test.%@portal.test';
-- DELETE FROM auth.identities WHERE user_id IN
--   (SELECT auth_id FROM public.portal_users WHERE email LIKE 'test.%@portal.test');
--   ↑ run the portal_users DELETE LAST-FIRST: capture the auth_ids BEFORE
--     deleting portal_users, because ON DELETE CASCADE on portal_users.auth_id
--     will already have removed the auth.users rows.
