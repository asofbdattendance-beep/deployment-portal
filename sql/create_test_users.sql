-- ============================================================
-- CREATE TEST USERS for Scanner + Dept Incharge
-- Run this in Supabase SQL Editor (as postgres) AFTER v25-v27
-- Creates auth users with password 'Scanner@123' / 'Incharge@123'
-- and portal_users rows. Safe to re-run.
-- ============================================================

-- Ensure role check allows new roles even if v25 not yet run
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner'));

-- Helper: get instance_id (single row in auth.users)
DO $$
DECLARE v_instance uuid;
BEGIN
  SELECT instance_id INTO v_instance FROM auth.users LIMIT 1;
  IF v_instance IS NULL THEN v_instance := '00000000-0000-0000-0000-000000000000'::uuid; END IF;

  -- 1) Scanner test user (existing pending user + fresh)
  -- Confirm the pending signUp we created via anon key (c7bf81be-...)
  UPDATE auth.users
  SET email_confirmed_at = now(), is_sso_user = false
  WHERE id = 'c7bf81be-1978-4f5a-b925-5adaadda2463';

  -- Ensure portal_users for that pending scanner
  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  VALUES (
    'c7bf81be-1978-4f5a-b925-5adaadda2463',
    'Test Scanner',
    'scanner.test.1788070468500@gmail.com',
    'FB5971GA0001',
    'SECTOR-15-A',
    'scanner',
    true
  ) ON CONFLICT (auth_id) DO UPDATE SET role='scanner', centre='SECTOR-15-A', is_active=true, updated_at=now();

  -- 2) Fresh deterministic scanner (scanner.test@gmail.com)
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='scanner.test@gmail.com') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_sent_at, recovery_sent_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_super_admin, is_sso_user
    )
    VALUES (
      v_instance,
      gen_random_uuid(),
      'authenticated', 'authenticated',
      'scanner.test@gmail.com',
      crypt('Scanner@123', gen_salt('bf')),
      now(), now(), null,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Test Scanner"}'::jsonb,
      now(), now(),
      false, false
    );
  END IF;

  -- confirm it (in case it was rate-limited but now inserted)
  UPDATE auth.users SET email_confirmed_at = now() WHERE email = 'scanner.test@gmail.com';

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Scanner', 'scanner.test@gmail.com', 'FB5971GA0001', 'SECTOR-15-A', 'scanner', true
  FROM auth.users WHERE email='scanner.test@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='scanner', centre='SECTOR-15-A', is_active=true, updated_at=now();

  -- 3) Dept Incharge test user (dept.incharge@gmail.com)
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email='dept.incharge@gmail.com') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_sent_at, recovery_sent_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_super_admin, is_sso_user
    )
    VALUES (
      v_instance,
      gen_random_uuid(),
      'authenticated', 'authenticated',
      'dept.incharge@gmail.com',
      crypt('Incharge@123', gen_salt('bf')),
      now(), now(), null,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Test Dept Incharge"}'::jsonb,
      now(), now(),
      false, false
    );
  END IF;

  UPDATE auth.users SET email_confirmed_at = now() WHERE email='dept.incharge@gmail.com';

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Dept Incharge', 'dept.incharge@gmail.com', 'FB5971GA0002', 'SECTOR-15-A', 'dept_incharge', true
  FROM auth.users WHERE email='dept.incharge@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='dept_incharge', centre='SECTOR-15-A', is_active=true, updated_at=now();

  RAISE NOTICE 'Test users ready';
END $$;

-- After running, also make the Dept Incharge a REAL deployed sewadar so it
-- can actually resolve its department (My Dept / Scanning / Absentees).
-- A fake badge can't be deployed (check_deployment rejects non-sewadars).
-- So: pick an existing sewadar in SECTOR-15-A that is already consented +
-- deployed to some department, reuse that badge as the dept_incharge user's
-- badge, and create the selection for it. Requires an open schedule + allocation.
DO $$
DECLARE v_sched uuid; v_dept uuid; v_badge text; v_name text;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules WHERE status='open' ORDER BY created_at DESC LIMIT 1;
  IF v_sched IS NULL THEN RAISE NOTICE 'No open schedule — create one first'; RETURN; END IF;

  -- a real sewadar already deployed (effective dept) in SECTOR-15-A subtree
  SELECT d.badge_number, COALESCE(d.deployed_department_id, d.department_id), COALESCE(d.sewadar_name,'')
  INTO v_badge, v_dept, v_name
  FROM public.deployments d
  WHERE d.schedule_id = v_sched
    AND public.get_root_centre(d.centre) = 'SECTOR-15-A'
    AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
  LIMIT 1;
  IF v_badge IS NULL THEN
    RAISE NOTICE 'No deployed sewadar in SECTOR-15-A for schedule — deploy one via Consent & Deploy first';
    RETURN;
  END IF;

  -- point the dept_incharge test user at that real badge
  UPDATE public.portal_users SET badge_number = v_badge, centre = 'SECTOR-15-A', is_active = true, updated_at = now()
  WHERE email = 'dept.incharge@gmail.com';

  -- make that sewadar a selected incharge (rank 1) for the dept
  INSERT INTO public.department_incharge_selections(schedule_id, centre, department_id, badge_number, sewadar_name, rank, is_from_pool)
  VALUES (v_sched, 'SECTOR-15-A', v_dept, v_badge, NULLIF(v_name,''), 1, true)
  ON CONFLICT (schedule_id, centre, department_id, rank) DO UPDATE
  SET badge_number = EXCLUDED.badge_number, sewadar_name = EXCLUDED.sewadar_name;

  RAISE NOTICE 'Dept Incharge wired: badge % dept % sched %', v_badge, v_dept, v_sched;
END $$;

-- VERIFY
SELECT email, role, centre, is_active, badge_number FROM public.portal_users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com','scanner.test.1788070468500@gmail.com') ORDER BY email;
SELECT * FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com') ORDER BY email;
SELECT * FROM public.department_incharge_selections ORDER BY created_at DESC;
