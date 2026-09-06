-- ============================================================
-- SOFT RESET v2 — discovers trigger names at runtime
--
-- Fixes: consent → No, deployed dept → NULL, incharges wiped.
-- Temporarily disables ALL triggers on the three tables so no
-- blocking trigger can prevent the reset, then re-enables them.
-- ============================================================

-- Step 1: preview current state
SELECT s.name AS schedule,
       (SELECT count(*) FROM public.sewadar_consents c WHERE c.schedule_id = s.id) AS consents,
       (SELECT count(*) FROM public.sewadar_consents c WHERE c.schedule_id = s.id AND c.consent_given = true) AS consents_given,
       (SELECT count(*) FROM public.deployments d  WHERE d.schedule_id = s.id) AS deployments,
       (SELECT count(*) FROM public.deployments d  WHERE d.schedule_id = s.id AND d.deployed_department_id IS NOT NULL) AS finalized,
       (SELECT count(*) FROM public.department_incharges i WHERE i.schedule_id = s.id) AS incharges
FROM public.deployment_schedules s ORDER BY s.name;

-- Step 2: disable ALL triggers on the three tables (unknown names handled)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, t.tgname AS trg
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgenabled = 'O'
      AND NOT t.tgisinternal
      AND c.relname IN ('sewadar_consents', 'deployments', 'department_incharges')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', r.tbl, r.trg);
    RAISE NOTICE 'Disabled trigger % on %', r.trg, r.tbl;
  END LOOP;
END $$;

-- Step 3: reset consents → No
UPDATE public.sewadar_consents
SET    consent_given = false,
       stay_at_bhati = false,
       chair_pass    = false
WHERE schedule_id = (
  SELECT id FROM public.deployment_schedules WHERE name = 'October Visit 2026'
);

-- Step 4: reset deployed department → NULL
UPDATE public.deployments
SET    deployed_department_id = NULL
WHERE schedule_id = (
  SELECT id FROM public.deployment_schedules WHERE name = 'October Visit 2026'
);

-- Step 5: delete all incharges
DELETE FROM public.department_incharges;
-- WHERE schedule_id = (
--   SELECT id FROM public.deployment_schedules WHERE name = 'October Visit 2026'
-- );

-- Step 6: re-enable ALL triggers
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, t.tgname AS trg
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND c.relname IN ('sewadar_consents', 'deployments', 'department_incharges')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', r.tbl, r.trg);
    RAISE NOTICE 'Enabled trigger % on %', r.trg, r.tbl;
  END LOOP;
END $$;

-- Step 7: verify
SELECT s.name AS schedule,
       (SELECT count(*) FROM public.sewadar_consents c WHERE c.schedule_id = s.id AND c.consent_given = true) AS consents_given,
       (SELECT count(*) FROM public.deployments d  WHERE d.schedule_id = s.id AND d.deployed_department_id IS NOT NULL) AS finalized,
       (SELECT count(*) FROM public.department_incharges i WHERE i.schedule_id = s.id) AS incharges
FROM public.deployment_schedules s ORDER BY s.name;
