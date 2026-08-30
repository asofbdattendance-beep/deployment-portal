-- ============================================================
-- CREATE TEST USERS for Scanner + Dept Incharge
-- Run this in Supabase SQL Editor (as postgres) AFTER v25-v27
-- Creates auth users with password 'Scanner@123' / 'Incharge@123'
-- and portal_users rows. Safe to re-run.
-- ============================================================

-- Helper: get instance_id (single row in auth.users)
DO $$
DECLARE v_instance uuid;
BEGIN
  SELECT instance_id INTO v_instance FROM auth.users LIMIT 1;
  IF v_instance IS NULL THEN v_instance := '00000000-0000-0000-0000-000000000000'::uuid; END IF;

  -- 1) Scanner test user (existing pending user + fresh)
  -- Confirm the pending signUp we created via anon key (c7bf81be-...)
  UPDATE auth.users
  SET email_confirmed_at = now(), confirmed_at = now(), is_sso_user = false
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
  ) ON CONFLICT (email) DO NOTHING;

  -- confirm it (in case it was rate-limited but now inserted)
  UPDATE auth.users SET email_confirmed_at = now(), confirmed_at = now() WHERE email = 'scanner.test@gmail.com';

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Scanner', 'scanner.test@gmail.com', 'FB5971GA0001', 'SECTOR-15-A', 'scanner', true
  FROM auth.users WHERE email='scanner.test@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='scanner', centre='SECTOR-15-A', is_active=true, updated_at=now();

  -- 3) Dept Incharge test user (dept.incharge@gmail.com)
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
  ) ON CONFLICT (email) DO NOTHING;

  UPDATE auth.users SET email_confirmed_at = now(), confirmed_at = now() WHERE email='dept.incharge@gmail.com';

  INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, is_active)
  SELECT id, 'Test Dept Incharge', 'dept.incharge@gmail.com', 'FB5971GA0002', 'SECTOR-15-A', 'dept_incharge', true
  FROM auth.users WHERE email='dept.incharge@gmail.com'
  ON CONFLICT (auth_id) DO UPDATE SET role='dept_incharge', centre='SECTOR-15-A', is_active=true, updated_at=now();

  RAISE NOTICE 'Test users ready';
END $$;

-- After running, also select 2 incharges for this centre×dept so Dept Incharge can login and see his dept
-- Pick a real deployed dept for SECTOR-15-A (first allocation)
DO $$
DECLARE v_sched uuid; v_dept uuid;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules WHERE status='open' ORDER BY created_at DESC LIMIT 1;
  IF v_sched IS NULL THEN RAISE NOTICE 'No open schedule — create one first'; RETURN; END IF;
  SELECT department_id INTO v_dept FROM public.centre_allocations WHERE schedule_id=v_sched AND centre='SECTOR-15-A' LIMIT 1;
  IF v_dept IS NULL THEN RAISE NOTICE 'No allocation for SECTOR-15-A — allocate a dept first'; RETURN; END IF;
  -- ensure test incharge is deployed to that dept (or fallback)
  IF NOT EXISTS (SELECT 1 FROM public.deployments WHERE schedule_id=v_sched AND badge_number='FB5971GA0002' AND COALESCE(deployed_department_id,department_id)=v_dept) THEN
    INSERT INTO public.sewadar_consents(schedule_id, centre, badge_number, sewadar_name, consent_given, available_days_count, stay_at_bhati)
    VALUES (v_sched,'SECTOR-15-A','FB5971GA0002','Test Dept Incharge', true, 5, true)
    ON CONFLICT (schedule_id,centre,badge_number) DO UPDATE SET consent_given=true, available_days_count=5;
    INSERT INTO public.deployments(schedule_id, department_id, centre, badge_number, sewadar_name) VALUES (v_sched, v_dept, 'SECTOR-15-A','FB5971GA0002','Test Dept Incharge')
    ON CONFLICT (schedule_id,centre,badge_number) DO UPDATE SET department_id=v_dept;
  END IF;
  INSERT INTO public.department_incharges(schedule_id, centre, department_id, badge_number, sewadar_name)
  VALUES (v_sched,'SECTOR-15-A',v_dept,'FB5971GA0002','Test Dept Incharge')
  ON CONFLICT (schedule_id,centre,department_id) DO UPDATE SET badge_number='FB5971GA0002', sewadar_name='Test Dept Incharge';
  INSERT INTO public.department_incharge_selections(schedule_id, centre, department_id, badge_number, sewadar_name, rank)
  VALUES (v_sched,'SECTOR-15-A',v_dept,'FB5971GA0002','Test Dept Incharge',1)
  ON CONFLICT (schedule_id,centre,department_id,rank) DO UPDATE SET badge_number='FB5971GA0002', sewadar_name='Test Dept Incharge';
  RAISE NOTICE 'Dept Incharge wired to % dept %', v_sched, v_dept;
END $$;

-- VERIFY
SELECT email, role, centre, is_active, badge_number FROM public.portal_users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com','scanner.test.1788070468500@gmail.com') ORDER BY email;
SELECT * FROM auth.users WHERE email IN ('scanner.test@gmail.com','dept.incharge@gmail.com') ORDER BY email;
