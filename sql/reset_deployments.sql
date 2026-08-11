-- ============================================================
-- RESET DEPLOYMENTS (regular + VSS)
--
-- Clears the `deployments` table, which holds the requested AND
-- final (deployed) department for EVERY sewadar — regular and VSS
-- both write to this same table, so one command resets everyone.
--
-- SAFETY NOTES
--   * Run the PREVIEW query first to see exactly what will go.
--   * No trigger blocks DELETEs on `deployments` (the deadline /
--     eligibility triggers are BEFORE INSERT OR UPDATE only), so a
--     reset works even after the deadline has passed.
--   * In the Supabase SQL Editor you run as the table owner, so RLS
--     does not block you.
--   * This file is NOT idempotent by design — it deletes data.
--   * After running, the app pages reload empty and sewadars can
--     re-request departments (OE ESCORTS rows auto-fix at 3 days).
-- ============================================================

-- ------------------------------------------------------------
-- 1. PREVIEW (SAFE — changes nothing)
--    See every deployment row that a reset would remove.
-- ------------------------------------------------------------
SELECT d.badge_number, d.sewadar_name, d.centre,
       dd.name AS requested_dept,
       d.deployed_department_id IS NOT NULL AS final_set,
       s.name AS schedule
FROM public.deployments d
JOIN public.deployment_schedules s ON s.id = d.schedule_id
LEFT JOIN public.deployment_departments dd ON dd.id = d.department_id
ORDER BY s.name, d.centre, d.sewadar_name;

-- ------------------------------------------------------------
-- 2. RESET ONE SCHEDULE (recommended)
--    Change the schedule name before running.
-- ------------------------------------------------------------
-- DELETE FROM public.deployments
-- WHERE schedule_id = (
--   SELECT id FROM public.deployment_schedules WHERE name = 'October 2026 Visit'
-- );

-- ------------------------------------------------------------
-- 3. RESET ALL SCHEDULES (full wipe of deployments)
-- ------------------------------------------------------------
-- DELETE FROM public.deployments;

-- ------------------------------------------------------------
-- 4. (OPTIONAL) ALSO CLEAR CONSENT RECORDS
--    Wipes consent Yes/No, days, stay-at-bhati, chair-pass too.
--    Combine with #3 for a fully blank slate.
-- ------------------------------------------------------------
-- DELETE FROM public.sewadar_consents;

-- ------------------------------------------------------------
-- 5. (OPTIONAL) RESET VSS REGISTRATION ASSIGNMENT STATE
--    Undoes the v6 assign_vss_registration() step (badge hand-out).
--    Does NOT delete roster rows in vss_sewadars — they survive.
-- ------------------------------------------------------------
-- UPDATE public.vss_registrations
-- SET status = 'registered',
--     assigned_badge_number = NULL,
--     assigned_by = NULL,
--     assigned_at = NULL
-- WHERE status = 'assigned';
