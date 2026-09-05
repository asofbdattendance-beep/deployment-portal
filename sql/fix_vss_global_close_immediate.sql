-- ============================================================
-- IMMEDIATE FIX for "VSS globally closed but centres can still mark"
-- Run this in Supabase SQL Editor to diagnose and clear stale overrides.
-- ============================================================

-- 1. Diagnose: what is globally closed vs what is still forced open?

-- Global switches (what the dashboard shows)
SELECT id, sewadar_deployment_open, vss_deployment_open, vss_creation_open, updated_by, updated_at
FROM public.portal_settings WHERE id = 1;

-- Stale VSS tri-state overrides that force OPEN despite global CLOSED
-- (centre '*' = ALL centres, otherwise that CENTRE + its SC_SPs)
SELECT centre, creation_open, deployment_open, updated_by, updated_at
FROM public.centre_vss_overrides
WHERE creation_open = true OR deployment_open = true
ORDER BY centre;

-- Stale generic deployment overrides (per-schedule) that also reopen VSS
-- Check for the currently open schedule(s) — replace <schedule_uuid> if needed
-- SELECT id, name, status, deadline FROM public.deployment_schedules WHERE status = 'open' ORDER BY created_at DESC;
SELECT schedule_id, centre, department_id, undeployed_only, created_by, created_at
FROM public.centre_overrides
WHERE centre = '*' OR centre IN (SELECT name FROM public.centres WHERE parent_centre IS NULL)
ORDER BY schedule_id, centre;

-- Effective VSS gates for a specific centre (replace 'GURGAON' with actual centre)
-- SELECT public.vss_deploy_open_for_centre('GURGAON'), public.vss_creation_open_for_centre('GURGAON');
-- SELECT public.get_my_effective_gates((SELECT id FROM public.deployment_schedules WHERE status='open' LIMIT 1));

-- 2. Fix: clear the overrides that keep VSS open after you closed it globally.
--    Pick the block that matches what you closed:

-- If you closed "VSS Deployment" globally and want it truly closed for everyone:
UPDATE public.centre_vss_overrides SET deployment_open = NULL WHERE deployment_open = true;
-- Optional: remove rows that are now fully Auto (both knobs null)
DELETE FROM public.centre_vss_overrides WHERE creation_open IS NULL AND deployment_open IS NULL;

-- If you closed "Add VSS" globally:
UPDATE public.centre_vss_overrides SET creation_open = NULL WHERE creation_open = true;
DELETE FROM public.centre_vss_overrides WHERE creation_open IS NULL AND deployment_open IS NULL;

-- If you also want to clear generic deployment overrides that were opened
-- for testing and now keep BOTH regular and (before v30) VSS open:
-- (Be careful: this clears ALL per-schedule overrides for the open schedule)
-- SELECT * FROM public.centre_overrides WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE status='open' LIMIT 1);
-- DELETE FROM public.centre_overrides WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE status='open' LIMIT 1);

-- 3. Verify: re-run the diagnose queries above — vss_deploy_open_for_centre should now
--    equal the global switch, and centres should see "VSS deployment is closed" in the UI.

