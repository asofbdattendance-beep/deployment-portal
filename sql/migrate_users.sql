-- Sync centre admins from attendance users → portal_users
-- Requirement: portal_users must contain ONLY aso/super_admin (preserved) + centre admins
-- from public.users. Same credentials/passwords are kept by copying auth_id (FK to auth.users).
-- Centre admin in attendance is role = 'admin' (also handles 'centre_admin' for compat).
-- Run this in Supabase SQL Editor AFTER portal_setup.sql. Safe to re-run.

-- 1) Empty portal_users leaving only aso + super_admin logins
DELETE FROM public.portal_users
WHERE role NOT IN ('aso', 'super_admin');

-- 2) Copy centre admins from public.users (same auth_id = same password)
INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, permissions, is_active)

SELECT
  u.auth_id,
  u.name,
  u.email,
  u.badge_number,
  u.centre,
  'centre_admin',
  COALESCE(u.permissions, '{}'::jsonb),
  true
FROM public.users u
WHERE lower(u.role) IN ('admin', 'centre_admin')
  AND COALESCE(u.is_active, true) = true
  AND u.auth_id IS NOT NULL
ON CONFLICT (auth_id) DO UPDATE SET
  name         = EXCLUDED.name,
  email        = EXCLUDED.email,
  badge_number = EXCLUDED.badge_number,
  centre       = EXCLUDED.centre,
  role         = EXCLUDED.role,
  permissions  = EXCLUDED.permissions,
  is_active    = true,
  updated_at   = now()
WHERE public.portal_users.role NOT IN ('aso', 'super_admin');

-- Verify
SELECT role, count(*) AS cnt FROM public.portal_users GROUP BY role ORDER BY role;
SELECT auth_id, name, email, centre, role FROM public.portal_users ORDER BY role, name;
