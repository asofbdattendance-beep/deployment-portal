-- ============================================================
-- V11: SCHEMA CONSISTENCY — align a drifted production schema
--      with what the app + migrations require.
--
-- WHY THIS EXISTS
--   The production schema dump showed `deployments`,
--   `sewadar_consents` and `centre_allocations` WITHOUT the
--   UNIQUE constraints and CASCADE/SET NULL FK actions that
--   v2/v8 define. Classic drift: the tables pre-existed, so
--   v2's `CREATE TABLE IF NOT EXISTS` silently skipped the
--   inline constraints and the `ADD COLUMN IF NOT EXISTS`
--   repairs never added them. Consequences on a drifted DB:
--     • every consent / deployment upsert 400s
--       (the app uses `onConflict: 'schedule_id,centre,badge_number'`,
--        which requires a matching unique constraint)
--     • "delete schedule" / "delete department" fails with a
--       foreign-key violation (the app relies on CASCADE —
--       it issues a single DELETE and lets the DB clean up)
--     • schedule / centre / dept lookups miss supporting indexes
--
-- WHAT THIS FILE DOES (all idempotent — safe to re-run)
--   1. Adds the missing UNIQUE constraints (deduping first so
--      the ADD cannot fail; keeps the OLDEST row per key).
--      Skips when a unique index on the EXACT columns already
--      exists — adding a second one would make the app's
--      ON CONFLICT inference fail with "matches multiple
--      unique constraints".
--   2. Rebuilds FKs whose referential action is missing/wrong
--      (CASCADE for schedule/dept FKs, SET NULL for the
--      deployed-department FK). Leaves correct FKs untouched.
--   3. Adds the supporting indexes if missing.
--
-- NON-DESTRUCTIVE — the only writes are deletions of TRUE
-- duplicate rows (same schedule+centre+badge / same
-- schedule+dept+centre) that could not exist on a healthy DB.
-- Run AFTER v10. Verify with the queries at the bottom.
-- ============================================================

-- ------------------------------------------------------------
-- 1. UNIQUE CONSTRAINTS (dedupe first, skip if already present)
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_has boolean;
  v_dup integer;
  v_cols text;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      ('sewadar_consents'::text, ARRAY['schedule_id'::text, 'centre'::text, 'badge_number'::text]::text[], 'uq_sewadar_consents_schedule_centre_badge'::text),
      ('deployments',       ARRAY['schedule_id', 'centre', 'badge_number'], 'uq_deployments_schedule_centre_badge'),
      ('centre_allocations', ARRAY['schedule_id', 'department_id', 'centre'], 'uq_centre_allocations_schedule_dept_centre')
    ) AS t(tab, cols, conname)
  LOOP
    -- 1a) does a unique index on EXACTLY these columns already exist?
    --     (skip if so — a second one would break ON CONFLICT inference)
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_class c     ON c.oid = i.indrelid AND c.relname = %L
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = ''public''
         WHERE i.indisunique
           AND i.indpred IS NULL
           AND i.indnkeyatts = %s
           AND (SELECT array_agg(a.attname::text ORDER BY k.ord) -- attname is name-typed; cast to text
                FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                  AND k.ord <= i.indnkeyatts) -- key columns only, ignore INCLUDE
               = %L::text[])',
      r.tab, array_length(r.cols, 1), r.cols)
    INTO v_has;

    IF v_has THEN
      RAISE NOTICE 'v11: % already has a unique index on (%) — skipping', r.tab, array_to_string(r.cols, ', ');
      CONTINUE;
    END IF;

    v_cols := array_to_string(r.cols, ', ');

    -- 1b) dedupe first (keep the OLDEST row per key) so the ADD cannot fail
    EXECUTE format(
      'SELECT count(*) FROM (SELECT 1 FROM public.%I GROUP BY %s HAVING count(*) > 1) d',
      r.tab, v_cols)
    INTO v_dup;

    IF v_dup > 0 THEN
      RAISE NOTICE 'v11: % has % duplicate key group(s) — deleting all but the oldest row per key', r.tab, v_dup;
      EXECUTE format(
        'WITH ranked AS (
           SELECT id, row_number() OVER (PARTITION BY %s ORDER BY id) AS rn
           FROM public.%I
         )
         DELETE FROM public.%I c USING ranked r
         WHERE c.id = r.id AND r.rn > 1',
        v_cols, r.tab, r.tab);
    END IF;

    -- 1c) add the constraint (this is the app''s ON CONFLICT target)
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (%s)', r.tab, r.conname, v_cols);
    RAISE NOTICE 'v11: added unique constraint % on %', r.conname, r.tab;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. FK REFERENTIAL ACTIONS (CASCADE / SET NULL)
--    Rebuild only when the FK is missing or has the wrong action.
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_conname text;
  v_deltype text;
  v_action text;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      -- child, column, parent, desired action ('c' = CASCADE, 'n' = SET NULL)
      ('centre_allocations'::text,  'schedule_id'::text,           'deployment_schedules'::text,  'c'::text),
      ('centre_allocations',        'department_id',               'deployment_departments',      'c'),
      ('sewadar_consents',          'schedule_id',                 'deployment_schedules',        'c'),
      ('deployments',               'schedule_id',                 'deployment_schedules',        'c'),
      ('deployments',               'department_id',               'deployment_departments',      'c'),
      ('deployments',               'deployed_department_id',      'deployment_departments',      'n')
    ) AS t(child, col, parent, action)
  LOOP
    v_action := CASE r.action WHEN 'c' THEN 'CASCADE' ELSE 'SET NULL' END;

    SELECT pc.conname, pc.confdeltype::text INTO v_conname, v_deltype
    FROM pg_constraint pc
    JOIN pg_class c ON c.oid = pc.conrelid AND c.relname = r.child
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_class p ON p.oid = pc.confrelid AND p.relname = r.parent
    WHERE pc.contype = 'f'
      AND pc.conkey = ARRAY[(
            SELECT a.attnum FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = r.col
          )]::smallint[]
      AND pc.confkey = ARRAY[(
            SELECT a.attnum FROM pg_attribute a
            WHERE a.attrelid = p.oid AND a.attname = 'id'
          )]::smallint[];

    IF v_conname IS NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE %s',
        r.child, r.child || '_' || r.col || '_fkey', r.col, r.parent, v_action);
      RAISE NOTICE 'v11: added FK % on % (ON DELETE %)', r.child || '_' || r.col || '_fkey', r.child, v_action);
    ELSIF v_deltype <> r.action THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.child, v_conname);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE %s',
        r.child, r.child || '_' || r.col || '_fkey', r.col, r.parent, v_action);
      RAISE NOTICE 'v11: rebuilt FK % on % (was %, now %)', r.child || '_' || r.col || '_fkey', r.child,
        CASE v_deltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'a' THEN 'NO ACTION' ELSE v_deltype END,
        v_action);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. SUPPORTING INDEXES (idempotent)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_alloc_schedule          ON public.centre_allocations(schedule_id);
CREATE INDEX IF NOT EXISTS idx_consent_schedule        ON public.sewadar_consents(schedule_id);
CREATE INDEX IF NOT EXISTS idx_consent_centre          ON public.sewadar_consents(centre);
CREATE INDEX IF NOT EXISTS idx_deployments_centre      ON public.deployments(centre);
CREATE INDEX IF NOT EXISTS idx_deployments_schedule    ON public.deployments(schedule_id);
CREATE INDEX IF NOT EXISTS idx_deployments_deployed_dept ON public.deployments(deployed_department_id);
CREATE INDEX IF NOT EXISTS idx_deployments_schedule_dept ON public.deployments(schedule_id, department_id);

-- ============================================================
-- VERIFICATION (run these after the migration to confirm)
-- ============================================================
-- Expected: three rows, all `is_unique` = true
-- SELECT c.relname AS table, i.relname AS index_name
-- FROM pg_index x
-- JOIN pg_class c ON c.oid = x.indrelid
-- JOIN pg_class i ON i.oid = x.indexrelid
-- WHERE x.indisunique AND x.indisprimary = false
--   AND c.relname IN ('sewadar_consents', 'deployments', 'centre_allocations')
-- ORDER BY c.relname;
--
-- Expected: six rows — five with deltype = c (CASCADE),
-- one (deployments.deployed_department_id) with deltype = n (SET NULL)
-- SELECT c.relname AS child, a.attname AS column,
--        CASE pc.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END AS on_delete
-- FROM pg_constraint pc
-- JOIN pg_class c ON c.oid = pc.conrelid
-- JOIN pg_class p ON p.oid = pc.confrelid
-- JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pc.conkey[1]
-- WHERE pc.contype = 'f'
--   AND p.relname = 'deployment_departments'
--   AND c.relname IN ('deployments', 'centre_allocations')
-- ORDER BY c.relname, a.attname;
-- (re-run with p.relname = 'deployment_schedules' for the schedule FKs)
--
-- Expected: empty (no duplicates remain)
-- SELECT schedule_id, centre, badge_number, count(*) FROM public.sewadar_consents GROUP BY 1,2,3 HAVING count(*) > 1;
-- SELECT schedule_id, centre, badge_number, count(*) FROM public.deployments GROUP BY 1,2,3 HAVING count(*) > 1;
-- SELECT schedule_id, department_id, centre, count(*) FROM public.centre_allocations GROUP BY 1,2,3 HAVING count(*) > 1;
