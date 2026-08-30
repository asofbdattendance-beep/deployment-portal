-- ============================================================
-- CREATE TEST USERS for Scanner + Dept Incharge  (v2 — FIXED)
-- ------------------------------------------------------------
-- WHY v2: the v1 script did a bare INSERT INTO auth.users with NO
-- matching auth.identities row. Supabase's password grant
-- (get_user_by_email) then fails for those rows with:
--     "Database error querying schema" (HTTP 500)
-- i.e. login shows error {}.
-- v2 deletes those broken rows and recreates them exactly the way
-- supabase.auth.signUp does: auth.users + auth.identities (email).
-- Password login then works immediately (no confirmation email).
--
-- Run in Supabase SQL Editor as postgres AFTER v25/v26/v27.
-- Safe to re-run.
-- ============================================================

-- role check (idempotent — also covers "run before v25")
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner'));

-- 1) remove any broken identity-less rows from a prior run (idempotent)
DELETE FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com');
DELETE FROM public.portal_users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com');

DO $$
DECLARE v_instance uuid;
BEGIN
  SELECT instance_id INTO v_instance FROM auth.users LIMIT 1;
  IF v_instance IS NULL THEN v_instance := '00000000-0000-0000-0000-000000000000'::uuid; END IF;

  -- ============ SCANNER: scanner.test@gmail.com / Scanner@123 ============
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='scanner.test@gmail.com') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmation_sent_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
    ) VALUES (
      v_instance, gen_random_uuid(), 'authenticated', 'authenticated',
      'scanner.test@gmail.com', crypt('Scanner@123', gen_salt('bf')),
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
    FROM auth.users u WHERE u.email = 'scanner.test@gmail.com';
  END IF;

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Scanner', 'scanner.test@gmail.com', 'FB5971GA0001', 'SECTOR-15-A', 'scanner', true
  FROM auth.users WHERE email='scanner.test@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='scanner', centre='SECTOR-15-A', is_active=true, updated_at=now();

  -- ============ DEPT INCHARGE: dept.incharge@gmail.com / Incharge@123 ============
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='dept.incharge@gmail.com') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmation_sent_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
    ) VALUES (
      v_instance, gen_random_uuid(), 'authenticated', 'authenticated',
      'dept.incharge@gmail.com', crypt('Incharge@123', gen_salt('bf')),
      now(), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Test Dept Incharge"}'::jsonb,
      false, false
    );
    INSERT INTO auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    )
    SELECT u.id, u.id, u.id::text, 'email',
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', false, 'phone_verified', false),
           now(), now(), now()
    FROM auth.users u WHERE u.email = 'dept.incharge@gmail.com';
  END IF;

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Dept Incharge', 'dept.incharge@gmail.com', 'FB5971GA0002', 'SECTOR-15-A', 'dept_incharge', true
  FROM auth.users WHERE email='dept.incharge@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='dept_incharge', centre='SECTOR-15-A', is_active=true, updated_at=now();

  RAISE NOTICE 'Test users (with identities) ready';
END $$;

-- 2) wire Dept Incharge to a REAL deployed sewadar so get_my_dept_ids resolves
DO $$
DECLARE v_sched uuid; v_dept uuid; v_badge text; v_name text;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules WHERE status='open' ORDER BY created_at DESC LIMIT 1;
  IF v_sched IS NULL THEN RAISE NOTICE 'No open schedule'; RETURN; END IF;
  SELECT d.badge_number, COALESCE(d.deployed_department_id, d.department_id), COALESCE(d.sewadar_name,'')
  INTO v_badge, v_dept, v_name
  FROM public.deployments d
  WHERE d.schedule_id = v_sched AND public.get_root_centre(d.centre)='SECTOR-15-A'
    AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
  LIMIT 1;
  IF v_badge IS NULL THEN RAISE NOTICE 'No deployed sewadar in SECTOR-15-A'; RETURN; END IF;
  UPDATE public.portal_users SET badge_number=v_badge, centre='SECTOR-15-A', updated_at=now() WHERE email='dept.incharge@gmail.com';
  INSERT INTO public.department_incharge_selections(schedule_id, centre, department_id, badge_number, sewadar_name, rank, is_from_pool)
  VALUES (v_sched,'SECTOR-15-A',v_dept,v_badge,NULLIF(v_name,''),1,true)
  ON CONFLICT (schedule_id, centre, department_id, rank) DO UPDATE
  SET badge_number=EXCLUDED.badge_number, sewadar_name=EXCLUDED.sewadar_name;
  RAISE NOTICE 'Dept Incharge wired: % dept % sched %', v_badge, v_dept, v_sched;
END $$;

-- VERIFY
SELECT email, role, centre, is_active, badge_number FROM public.portal_users
WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com') ORDER BY email;
SELECT u.email, i.provider, (i.id IS NOT NULL) AS has_identity
FROM auth.users u LEFT JOIN auth.identities i ON i.user_id = u.id
WHERE u.email IN ('scanner.test@gmail.com','dept.incharge@gmail.com') ORDER BY u.email;
