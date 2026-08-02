-- Copy users from existing users table → portal_users
-- Run this after portal_setup.sql

INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, permissions, is_active)
SELECT
  u.auth_id, u.name, u.email, u.badge_number, u.centre,
  CASE
    WHEN u.role = 'super_admin' THEN 'super_admin'
    WHEN u.role = 'aso' THEN 'aso'
    WHEN u.role IN ('admin', 'centre_user') THEN 'centre_admin'
    ELSE 'centre_user'
  END,
  u.permissions,
  true
FROM public.users u
WHERE u.role IN ('super_admin', 'aso', 'admin', 'centre_user')
  AND u.is_active = true
  AND u.auth_id IS NOT NULL
ON CONFLICT (auth_id) DO NOTHING;

-- Verify
SELECT auth_id, name, email, centre, role FROM public.portal_users ORDER BY role, name;
