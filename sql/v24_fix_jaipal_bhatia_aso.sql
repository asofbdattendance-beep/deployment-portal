-- ============================================================
-- V24: FIX missing portal_users row for JAIPAL BHATIA (FB5978GA0088)
-- ============================================================
-- Symptom (29/8/2026):
--   New user created via attendance portal (public.users) as:
--     Name:   JAIPAL BHATIA
--     Email:  qualityestate_123@rediffmail.com
--     Badge:  FB5978GA0088 (sewadars.centre = SECTOR-15-A, PERMANENT)
--     Centre: SECTOR-15-A (root CENTRE, parent_centre IS NULL)
--     Role:   aso
--     Auth:   55e943b5-d5e1-444d-b185-976f12eee2da  (password SEC0088 verified)
--   Login to deployment portal SUCCEEDS (auth.users + public.users OK)
--   but deployment portal shows "Couldn't load your profile" / Access Denied
--   because public.portal_users has NO row for that auth_id — so
--   get_portal_profile() returns NULL and portal_users_read yields 0 rows.
--
-- Root cause:
--   portal_users is the deployment portal's auth mirror. v23 deletes
--   non-aso/super_admin rows and copies only centre_admin from public.users;
--   it PRESERVES existing aso/super_admin but does NOT auto-create a new
--   aso that was only added to public.users. This aso was created only in
--   auth.users + public.users (attendance), never in portal_users.
--   RLS portal_users_write is super_admin-only, so the aso cannot self-insert
--   (42501 RLS violation confirmed via anon-key test).
--
-- Fix: backfill the missing portal_users row from public.users (security
-- definer, bypasses RLS when run in SQL Editor as postgres). Also provides
-- a generic backfill for ANY future missing aso/super_admin that exists in
-- public.users but not yet in portal_users.
--
-- Safe to re-run. Run in Supabase SQL Editor.
-- ============================================================

-- 1) Surgical fix for THIS user (idempotent)
INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, permissions, is_active)
SELECT
  u.auth_id,
  u.name,
  u.email,
  u.badge_number,
  u.centre,
  'aso'::text,
  COALESCE(u.permissions, '{}'::jsonb),
  true
FROM public.users u
WHERE u.email = 'qualityestate_123@rediffmail.com'
  AND u.auth_id = '55e943b5-d5e1-444d-b185-976f12eee2da'
  AND lower(u.role) = 'aso'
ON CONFLICT (auth_id) DO UPDATE SET
  name         = EXCLUDED.name,
  email        = EXCLUDED.email,
  badge_number = EXCLUDED.badge_number,
  centre       = EXCLUDED.centre,
  role         = 'aso',
  permissions  = EXCLUDED.permissions,
  is_active    = true,
  updated_at   = now();

-- 2) Generic backfill — any aso/super_admin in public.users missing from portal_users
--    (future-proof; mirrors the surgical fix above)
INSERT INTO public.portal_users (auth_id, name, email, badge_number, centre, role, permissions, is_active)
SELECT
  u.auth_id,
  u.name,
  u.email,
  u.badge_number,
  u.centre,
  lower(u.role)::text,
  COALESCE(u.permissions, '{}'::jsonb),
  true
FROM public.users u
LEFT JOIN public.portal_users p ON p.auth_id = u.auth_id
WHERE lower(u.role) IN ('aso', 'super_admin')
  AND u.auth_id IS NOT NULL
  AND COALESCE(u.is_active, true) = true
  AND p.auth_id IS NULL
ON CONFLICT (auth_id) DO NOTHING;

-- ------------------------------------------------------------
-- VERIFY (run after)
-- ------------------------------------------------------------
-- Should now return 1 row with role=aso
SELECT auth_id, name, email, centre, role, badge_number, is_active
FROM public.portal_users
WHERE email = 'qualityestate_123@rediffmail.com';

-- Cross-check attendance ↔ portal match
SELECT u.email, u.role AS attendance_role, p.role AS portal_role,
       (u.auth_id = p.auth_id) AS same_auth,
       u.centre AS att_centre, p.centre AS portal_centre
FROM public.users u
JOIN public.portal_users p USING (auth_id)
WHERE u.email = 'qualityestate_123@rediffmail.com';

-- Confirm get_portal_profile will succeed once the user logs in again:
-- (run as that user or check that row exists)
SELECT count(*) AS portal_users_total FROM public.portal_users;
SELECT role, count(*) FROM public.portal_users GROUP BY role ORDER BY role;

-- Notes on correctness:
-- • SECTOR-15-A is a root CENTRE (parent_centre IS NULL) — valid for any
--   centre-scoped sewadar and harmless for aso (aso scope is ALL centres;
--   header will show "(SECTOR-15-A)" but permissions are global, read-only
--   per v20 — zero writes everywhere).
-- • Sewadar FB5978GA0088 exists in sewadars as PERMANENT / AREA SECRETARY
--   OFFICE / SECTOR-15-A — valid, not ELDERLY, so deployment eligibility
--   checks will pass.
-- • Password SEC0088 verified via supabase.auth.signInWithPassword (anon key).
--   No reset needed.
