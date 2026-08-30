-- ============================================================
-- CREATE TEST USERS for Scanner (v3 — SHORT EMAIL)
-- ------------------------------------------------------------
-- v3: delete old test users (scanner.test@gmail.com / dept.incharge@gmail.com)
--     and create a single short scanner login: sc@test.com / 123456
-- Short email is easier to type on the handheld BigPickle scanner.
-- Run in Supabase SQL Editor as postgres AFTER v25/v26/v27.
-- Safe to re-run (idempotent).
-- ============================================================

-- role check (idempotent — also covers "run before v25")
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner'));

-- 1) delete OLD test users + any prior sc@test.com (idempotent, for re-runs)
-- Identities must be deleted first if FK is not CASCADE (prevents 500 "Database error querying schema")
DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com','sc@test.com'));
DELETE FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com','sc@test.com');
DELETE FROM public.portal_users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com','sc@test.com');

DO $$
DECLARE v_instance uuid;
BEGIN
  SELECT instance_id INTO v_instance FROM auth.users LIMIT 1;
  IF v_instance IS NULL THEN v_instance := '00000000-0000-0000-0000-000000000000'::uuid; END IF;

  -- ============ SCANNER: sc@test.com / 123456 ============
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='sc@test.com') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmation_sent_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
    ) VALUES (
      v_instance, gen_random_uuid(), 'authenticated', 'authenticated',
      'sc@test.com', crypt('123456', gen_salt('bf')),
      now(), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Test Scanner"}'::jsonb,
      false, false
    );
    INSERT INTO auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    )
    SELECT u.id, u.id, u.id::text, 'email',
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', false, 'phone_verified', false),
           now(), now(), now()
    FROM auth.users u WHERE u.email = 'sc@test.com';
  END IF;

  -- Repair broken case: user exists but identities missing (500 "Database error querying schema")
  INSERT INTO auth.identities (
    id, user_id, provider_id, provider, identity_data,
    last_sign_in_at, created_at, updated_at
  )
  SELECT u.id, u.id, u.id::text, 'email',
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', false, 'phone_verified', false),
         now(), now(), now()
  FROM auth.users u
  WHERE u.email='sc@test.com'
  AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Scanner', 'sc@test.com', 'FB5971GA', 'SECTOR-15-A', 'scanner', true
  FROM auth.users WHERE email='sc@test.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='scanner', centre='SECTOR-15-A', is_active=true, updated_at=now();

  RAISE NOTICE 'Test scanner ready: sc@test.com / 123456';
END $$;

-- VERIFY
SELECT email, role, centre, is_active, badge_number FROM public.portal_users
WHERE email IN ('sc@test.com') ORDER BY email;
SELECT u.email, i.provider, (i.id IS NOT NULL) AS has_identity
FROM auth.users u LEFT JOIN auth.identities i ON i.user_id = u.id
WHERE u.email IN ('sc@test.com') ORDER BY u.email;

-- OPTIONAL: confirm old test users are gone (should return 0 rows)
-- SELECT email FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com');
-- SELECT email FROM public.portal_users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com');
