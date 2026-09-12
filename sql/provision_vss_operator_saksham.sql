-- ============================================================
-- Provision SAKSHAM ARORA as vss_operator (MANUAL super_admin step)
-- Paste into Supabase SQL editor. Reads first, then ONE guarded write.
-- v36_vss_operator.sql must already be applied (re-run is safe).
-- Replace '<operator email>' with Saksham's exact login email.
-- ============================================================

-- 0. Who is Saksham right now? (UI shows Centre Admin / NIT-2)
SELECT email, role, centre, is_active
FROM public.portal_users
WHERE lower(email) = lower('<operator email>');

-- 1. Role CHECK accepts the new value
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conname = 'portal_users_role_check';
-- Expected: CHECK (role IN ('centre_user','centre_admin','aso','super_admin','dept_incharge','scanner','vss_operator'))

-- 2. v36 policies exist (expect 10 rows)
SELECT tablename, policyname FROM pg_policies
WHERE policyname IN ('consent_read','deploy_v2_read','vss_sewadars_read',
  'vss_registrations_read','sewadars_portal_read','consent_write',
  'deploy_v2_insert','deploy_v2_update','deploy_v2_delete',
  'vss_registrations_write')
ORDER BY tablename, policyname;

-- 3. Functions mention vss_operator (expect 7 rows)
SELECT n.nspname || '.' || p.proname AS fn
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('assign_vss_registration','guard_vss_registration_write',
    'block_after_deadline','check_deployment','check_deployment_batch',
    'check_deployment_batch_upd','block_locked_delete')
  AND p.prosrc LIKE '%vss_operator%';

-- 4. Freeze/final guards must NOT mention it (expect 0 rows)
SELECT n.nspname || '.' || p.proname AS fn
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('freeze_deployed_rows','block_finalized_delete',
    'block_finalized_consent_edit','block_finalized_deploy_edit','require_sewadar_exists')
  AND p.prosrc LIKE '%vss_operator%';

-- 5. Guarded provisioning: touches ONLY Saksham's row, no-op if already operator
UPDATE public.portal_users SET role = 'vss_operator'
WHERE lower(email) = lower('<operator email>')
  AND role IS DISTINCT FROM 'vss_operator'
RETURNING email, role AS new_role, centre;

-- 6. Verify (expect 1 row, role='vss_operator')
SELECT email, role, centre
FROM public.portal_users
WHERE lower(email) = lower('<operator email>');
SELECT count(*) AS vss_operator_count FROM public.portal_users WHERE role = 'vss_operator';

-- After this: Saksham signs out/in (or hard-refresh), header shows
-- "VSS Operator (All centres)", Consent & VSS filters list every centre.
-- To deprovision: UPDATE public.portal_users SET role = 'centre_admin'
-- WHERE lower(email) = lower('<operator email>');
