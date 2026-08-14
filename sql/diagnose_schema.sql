-- ============================================================
-- SCHEMA DIAGNOSTIC — NOT a migration, do not keep in production
-- Paste the ENTIRE file into the Supabase SQL editor and Run.
-- It prints one result tab per section (tables, policies,
-- triggers, functions, views, constraints, storage, shapes,
-- counts). Copy ALL result tabs back so the deployment state
-- can be checked against the migration list.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABLES + VIEWS + RLS status (public schema)
-- ------------------------------------------------------------
SELECT c.relkind AS kind, c.relname AS object,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p')
ORDER BY c.relkind, c.relname;

-- ------------------------------------------------------------
-- 2. ALL RLS POLICIES (public + storage) — name, roles, command,
--    USING / WITH CHECK expressions
-- ------------------------------------------------------------
SELECT n.nspname AS schema,
       c.relname AS table_name,
       p.polname AS policy_name,
       CASE p.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
       ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)) AS roles,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
            WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage')
ORDER BY n.nspname, c.relname, p.polname;

-- ------------------------------------------------------------
-- 3. ALL TRIGGERS (public schema) — full CREATE TRIGGER defs
-- ------------------------------------------------------------
SELECT c.relname AS table_name,
       t.tgname AS trigger_name,
       CASE t.tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE t.tgenabled END AS state,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

-- ------------------------------------------------------------
-- 4. ALL FUNCTIONS (public schema)
-- ------------------------------------------------------------
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       CASE p.prosecdef WHEN true THEN 'SECURITY DEFINER' ELSE 'invoker' END AS security
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
ORDER BY p.proname;

-- ------------------------------------------------------------
-- 5. CONSTRAINTS / INDEXES on the deployment tables
--    (unique keys the app's ON CONFLICT upserts depend on)
-- ------------------------------------------------------------
SELECT c.relname AS table_name,
       con.conname AS name,
       con.contype AS type,  -- p=PK, u=unique, f=FK
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND con.contype IN ('u', 'p', 'f')
  AND c.relname IN ('sewadar_consents','deployments','centre_allocations',
                    'deployment_schedules','deployment_departments',
                    'department_incharges','centre_locks')
ORDER BY c.relname, con.conname;

-- ------------------------------------------------------------
-- 6. STORAGE: buckets + public flag
-- ------------------------------------------------------------
SELECT id, name, public AS is_public
FROM storage.buckets
ORDER BY id;

-- ------------------------------------------------------------
-- 7. COLUMN SHAPES of the key tables (v1 vs v2 vs v8+ detection)
--    (information_schema returns nothing for a missing table)
-- ------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('deployment_schedules','deployments','sewadar_consents',
                     'deployment_departments','centre_allocations','portal_users')
ORDER BY table_name, ordinal_position;

-- ------------------------------------------------------------
-- 8. EXISTENCE MARKERS — one row, NULL means "table missing"
-- ------------------------------------------------------------
SELECT
  to_regclass('public.deployment_schedules')    AS schedules_tbl,
  to_regclass('public.deployments')             AS deployments_tbl,
  to_regclass('public.sewadar_consents')        AS consents_tbl,
  to_regclass('public.centre_allocations')      AS allocations_tbl,
  to_regclass('public.department_incharges')    AS incharges_tbl,
  to_regclass('public.centre_locks')            AS centre_locks_tbl,
  to_regclass('public.audit_log')               AS audit_log_tbl,
  to_regclass('public.prev_year_deployments')   AS prev_year_tbl,
  to_regclass('public.vss_registrations')       AS vss_registrations_tbl,
  to_regclass('public.vss_sewadars')            AS vss_sewadars_tbl,
  to_regclass('public.portal_settings')         AS portal_settings_tbl;

-- ------------------------------------------------------------
-- 9. KEY COLUMN CHECKS — true = migration shape present
-- ------------------------------------------------------------
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='deployment_schedules'  AND column_name='name')                   AS sched_v2_shape,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='deployment_schedules'  AND column_name='deadline')               AS sched_has_deadline,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='deployments'           AND column_name='deployed_department_id')  AS deploy_has_final_dept,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='deployments'           AND column_name='department_id')          AS deploy_v2_shape,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sewadar_consents'      AND column_name='available_days_count')   AS consent_has_days,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sewadar_consents'      AND column_name='chair_pass')            AS consent_has_chair,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='deployment_departments' AND column_name='min_days')            AS dept_has_rules,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='portal_users'          AND column_name='centre')                AS users_has_centre;

-- ------------------------------------------------------------
-- 10. OE ESCORTS departments — min_days must be 3 (v10/v16)
--     (errors if deployment_departments is missing — that's fine)
-- ------------------------------------------------------------
SELECT id, name, min_days, vss_min_days
FROM public.deployment_departments
WHERE name ILIKE 'OE ESCORTS%'
ORDER BY name;

-- ------------------------------------------------------------
-- 11. ROW COUNTS (tables that don't exist are skipped)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.diag_counts()
RETURNS TABLE (item text, n bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_regclass('public.deployment_schedules') IS NOT NULL THEN
    RETURN QUERY SELECT 'schedules'::text, count(*) FROM public.deployment_schedules;
  END IF;
  IF to_regclass('public.deployments') IS NOT NULL THEN
    RETURN QUERY SELECT 'deployments'::text, count(*) FROM public.deployments;
  END IF;
  IF to_regclass('public.sewadar_consents') IS NOT NULL THEN
    RETURN QUERY SELECT 'consents'::text, count(*) FROM public.sewadar_consents;
  END IF;
  IF to_regclass('public.centre_allocations') IS NOT NULL THEN
    RETURN QUERY SELECT 'allocations'::text, count(*) FROM public.centre_allocations;
  END IF;
  IF to_regclass('public.prev_year_deployments') IS NOT NULL THEN
    RETURN QUERY SELECT 'prev_year_deployments'::text, count(*) FROM public.prev_year_deployments;
  END IF;
  IF to_regclass('public.vss_registrations') IS NOT NULL THEN
    RETURN QUERY SELECT 'vss_registrations'::text, count(*) FROM public.vss_registrations;
  END IF;
  IF to_regclass('public.vss_sewadars') IS NOT NULL THEN
    RETURN QUERY SELECT 'vss_sewadars'::text, count(*) FROM public.vss_sewadars;
  END IF;
  IF to_regclass('public.centre_locks') IS NOT NULL THEN
    RETURN QUERY SELECT 'centre_locks'::text, count(*) FROM public.centre_locks;
  END IF;
  IF to_regclass('public.department_incharges') IS NOT NULL THEN
    RETURN QUERY SELECT 'department_incharges'::text, count(*) FROM public.department_incharges;
  END IF;
  IF to_regclass('public.portal_users') IS NOT NULL THEN
    RETURN QUERY SELECT 'portal_users'::text, count(*) FROM public.portal_users;
  END IF;
END;
$$;

SELECT * FROM public.diag_counts();

-- optional cleanup of the helper (run this after, if you want):
-- DROP FUNCTION IF EXISTS public.diag_counts();