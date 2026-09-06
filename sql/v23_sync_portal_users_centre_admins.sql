-- ============================================================
-- V23: SYNC CENTRE ADMINS FROM attendance users → portal_users
-- ============================================================
-- Requirement: portal_users must contain ONLY
--   - existing aso + super_admin logins (preserved untouched)
--   - centre admins taken from public.users (attendance portal)
-- All other portal centre users are removed. Credentials/passwords
-- stay the same because we copy auth_id (FK to auth.users) — the
-- two portals share the same Supabase auth.users, so the password
-- hash stays valid. No password reset needed.
--
-- Attendance role for a centre admin is 'admin' (see
-- sewadar-attendance/src/lib/supabase.js ROLES.ADMIN). We also
-- accept 'centre_admin' for forward-compat.
--
-- NON-DESTRUCTIVE to aso/super_admin; safe to re-run.
-- Run this in Supabase SQL Editor AFTER v22.
-- ============================================================

BEGIN;

-- 1) Keep aso + super_admin, drop every other portal user
--    (previous centre_user / centre_admin rows, stale, etc.)
DELETE FROM public.portal_users
WHERE role NOT IN ('aso', 'super_admin');

-- 2) Insert / refresh centre admins from public.users
--    Only users that can actually log in (auth_id IS NOT NULL)
--    and are active are copied. Role is normalised to
--    'centre_admin' for the deployment portal.
INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, permissions, is_active)
SELECT
  u.auth_id,
  u.name,
  u.email,
  u.badge_number,
  u.centre,
  'centre_admin'::text,
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

COMMIT;

-- ------------------------------------------------------------
-- VERIFY (run after the migration)
-- ------------------------------------------------------------
-- Portal users by role — should show only aso, super_admin, centre_admin
SELECT role, count(*) FROM public.portal_users GROUP BY role ORDER BY role;

-- Centre admins now in the portal (should match attendance admin count)
SELECT name, email, centre, badge_number, role
FROM public.portal_users WHERE role = 'centre_admin' ORDER BY centre, name;

-- Attendance source count for cross-check
SELECT lower(role) AS src_role, count(*) FROM public.users
WHERE lower(role) IN ('admin','centre_admin') AND auth_id IS NOT NULL AND COALESCE(is_active,true)=true
GROUP BY lower(role);

-- Spot-check that a portal login shares auth_id + password with attendance:
SELECT u.email, u.role AS attendance_role, p.role AS portal_role, (u.auth_id = p.auth_id) AS same_auth
FROM public.users u JOIN public.portal_users p USING (auth_id)
WHERE p.role = 'centre_admin' LIMIT 10;
