-- ============================================================
-- ONE-OFF DATA FIX (STANDALONE): 20 sewadars -> SEWA COLLECTION
-- (+ 2 new deployments via §K into TRAFFIC OUTSIDE BHATI)
-- Schedule : see §0 config (default 'October Visit 2026' — confirmed live)
-- Source   : Sewa Collection (1).xlsx (sheet 'Sewa collection', 22 rows;
--            target SEWA COLLECTION is implied (no target column in sheet),
--            'Current Deployment' is the CURRENT/old dept)
-- Context  : sets 1-2 (WATER 30 + SEWA SAMITI 29) were already migrated with
--            the sibling file. THIS file contains ONLY the SEWA COLLECTION
--            move. Re-running the sibling file later is harmless (every write
--            is conflict-guarded / idempotent) but unnecessary.
--
-- WHAT IT DOES
--   1. Stages the 20 badges (additive staging table, re-runnable).
--   2. Ensures a SEWA COLLECTION row in deployment_departments (new rows get
--      permissive unplanned-dept rules; an EXISTING row is left UNTOUCHED).
--   3. Snapshots every touched row into sewacollection_move_backup_oct2026
--      (rollback/audit; first run wins on re-run).
--   4. Retargets department_id -> SEWA COLLECTION for all 20, and
--      deployed_department_id -> SEWA COLLECTION only where already set
--      (mirrors request-only vs ASO-finalized state). Fills sewadar_name
--      ONLY where blank.
--   5. Inserts centre_allocations max_count=0 per root centre holding
--      SEWA COLLECTION rows (unplanned / all-surplus marker).
--   6. NO incharge grants — incharges are added later from the UI.
--   7. SET 3B (§0e centres, §K insert, §L verify, §M rollback): the 2 badges
--      with no deployment row become NEW ASO-finalized deployments into
--      TRAFFIC OUTSIDE BHATI + their consent rows (FB6003GA0013 chairpass
--      yes, both stay_at_bhati no).
--
-- WHAT IT DOES *NOT* DO
--   - No DELETE / DROP / TRUNCATE executes at all. Cleanup statements are
--     COMMENTED OUT for you to opt into.
--   - Consent rows are written ONLY for the 2 new badges (§K); the §H move
--     itself touches no consent row. WHERE clauses pin ONE schedule + the
--     listed badges; nothing else is written.
--   - Triggers parked ONLY on public.deployments, ONLY the 5 that can reject
--     the UPDATE, ONLY inside the transaction. Audit keeps firing;
--     require_sewadar_exists + AAS guard stay on.
--
-- HOW TO RUN (Supabase SQL editor, database owner): paste the ENTIRE file
-- and run once. Set the 2 centres in §0e first (K1 aborts while placeholders
-- remain). Pre-flight grids (§A3) display inline; H1/K1 abort their own
-- transaction on any guard failure (nothing half-applied; editor stops at
-- first ERROR). Expect: UPDATE 20 (§H) + 2 INSERTs (§K); then review the
-- §I/§L grids top-to-bottom.
--
-- KNOWN SIDE EFFECT: a 0-count allocation makes check_centre_lock require a
-- SEWA COLLECTION incharge per affected centre before it can lock. Nominate
-- from Centre Lists once the UI grants exist.
-- ============================================================

-- ================= §0 — CONFIG (additive, re-runnable) =================
CREATE TABLE IF NOT EXISTS public.sewacollection_move_cfg_oct2026 (
  id            integer PRIMARY KEY CHECK (id = 1),
  schedule_name text NOT NULL DEFAULT 'October Visit 2026'
);
INSERT INTO public.sewacollection_move_cfg_oct2026 (id) VALUES (1) ON CONFLICT DO NOTHING;
-- If P13 / the H1 error shows a different schedule name, run this ONE statement
-- with the EXACT name, then re-run from §A3:
--   UPDATE public.sewacollection_move_cfg_oct2026 SET schedule_name = '<EXACT NAME>' WHERE id = 1;
SELECT * FROM public.sewacollection_move_cfg_oct2026; -- EXPECTED: 1 row.


-- ================= §0d — SET 3 STAGING (additive, re-runnable) =================
-- Third move-set: 22 sewadars (mixed GA/LA), current depts -> SEWA COLLECTION
-- (same schedule). Target dept is implied by the workbook (no target column).
CREATE TABLE IF NOT EXISTS public.sewacollection_move_list_oct2026 (
  badge_number text PRIMARY KEY,
  full_name    text NOT NULL
);

INSERT INTO public.sewacollection_move_list_oct2026 (badge_number, full_name) VALUES
  ('FB6002GA0012', 'Bhagwant'),
  ('FB6002GA0023', 'Deepak Bhatia'),
  ('FB6002LA0044', 'Manisha Verma'),
  ('FB6002LA0046', 'Pooja Marwah'),
  ('FB5971GA0045', 'Om Prakash'),
  ('FB5971GA0056', 'Ravinder Kumar'),
  ('FB5971LA0121', 'Divya Wadhwa'),
  ('FB5971LA0041', 'Gurupyari Dwivedi'),
  ('FB5982GA0026', 'Shivcharan Baghotiya'),
  ('FB5982GA0143', 'Vipin Kumar Sachdeva'),
  ('FB5982LA0035', 'Rekha'),
  ('FB5982LA0059', 'Sangita Saini'),
  ('FB6008GA0022', 'Jugesh Chitkara'),
  ('FB6008GA0015', 'Satish Narula'),
  ('FB5993LA0003', 'Kanta Ahuja'),
  ('FB5993LA0004', 'Sunita Devi'),
  ('FB5992GA0030', 'Pawan Jindal'),
  ('FB5992GA0016', 'Satya Prakash'),
  ('FB5991GA0029', 'Deva Singh Chauhan'),
  ('FB5991GA0030', 'Mahipal Awana')
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 20. Re-run: INSERT 0 0.

SELECT count(*) AS staged_badges_set3 FROM public.sewacollection_move_list_oct2026;
-- EXPECTED: 20.


-- ================= §A3 — SET 3 PRE-FLIGHT (read-only; run all, review all) =================

-- P13 — every badge's current row (20 'ok' required; any '*** NO ROW ***' aborts §H).
SELECT l.badge_number,
       l.full_name,
       d.centre,
       d.sewadar_name,
       rd.name AS requested_dept,
       fd.name AS final_dept,
       d.status,
       CASE WHEN d.badge_number IS NULL THEN '*** NO ROW — §H will abort ***' ELSE 'ok' END AS state
  FROM public.sewacollection_move_list_oct2026 l
  LEFT JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- P14 — request-only vs ASO-finalized split (finalized + requested_only must equal 20).
SELECT count(*) FILTER (WHERE d.deployed_department_id IS NOT NULL) AS finalized,
       count(*) FILTER (WHERE d.deployed_department_id IS NULL)     AS requested_only
  FROM public.sewacollection_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;

-- P15 — SEWA COLLECTION dept rules + existing footprint.
-- If the dept row EXISTS (any casing variant counts — check the name exactly),
-- §H leaves its rules untouched.
SELECT id, name, is_active, min_days, requires_stay_at_bhati, requires_initiated, include_vss
  FROM public.deployment_departments
 WHERE lower(name) = lower('SEWA COLLECTION');

SELECT (SELECT count(*) FROM public.deployments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
           AND (department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')
             OR deployed_department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION'))) AS sewacollection_rows,
       (SELECT count(*) FROM public.centre_allocations
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')) AS sewacollection_allocs,
       (SELECT count(*) FROM public.department_incharge_assignments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')) AS sewacollection_grants;
-- EXPECTED before the move: 0 / 0 / 0.

-- P16 — master-table flags + incharge records naming any of the 20 (informative).
-- (This workbook carries no is_initiated column, so initiation is NOT checked.)
SELECT s.badge_number, s.badge_status
  FROM public.dp_sewadars s
 WHERE s.badge_number IN (SELECT badge_number FROM public.sewacollection_move_list_oct2026)
 ORDER BY s.badge_number;

SELECT i.centre, dd.name AS incharge_for_dept, i.badge_number
  FROM public.department_incharges i
  JOIN public.deployment_departments dd ON dd.id = i.department_id
 WHERE i.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND i.badge_number IN (SELECT badge_number FROM public.sewacollection_move_list_oct2026)
 ORDER BY 1, 2;


-- ================= §H — SET 3 MOVE (run H0..COMMIT as ONE block) =================
BEGIN;

-- H0 — confirm the config row (schedule_name). Fix the §0 config first if wrong.
SELECT * FROM public.sewacollection_move_cfg_oct2026;

-- H1 — guards (same fail-closed pattern; error lists real schedule names).
DO $$
DECLARE
  v_sched_name text;
  v_sched      uuid;
  v_missing    text[];
  v_names      text;
BEGIN
  SELECT schedule_name INTO v_sched_name FROM public.sewacollection_move_cfg_oct2026;
  SELECT id INTO v_sched
    FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim(v_sched_name));
  IF v_sched IS NULL THEN
    SELECT string_agg(name, ' | ' ORDER BY name) INTO v_names FROM public.deployment_schedules;
    RAISE EXCEPTION 'Schedule ''%'' not found (schedules in DB: %). Fix sewacollection_move_cfg_oct2026.schedule_name and re-run. Nothing changed.',
      v_sched_name, COALESCE(v_names, '(none)');
  END IF;

  SELECT array_agg(l.badge_number) INTO v_missing
    FROM public.sewacollection_move_list_oct2026 l
    LEFT JOIN public.deployments d
      ON d.schedule_id = v_sched AND d.badge_number = l.badge_number
   WHERE d.badge_number IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Badges with NO deployments row in this schedule: % — fix the list and re-run. Nothing changed.',
      array_to_string(v_missing, ', ');
  END IF;
END $$;

-- H2 — ensure SEWA COLLECTION exists (values apply ONLY to a newly inserted row;
-- an existing row is left UNTOUCHED).
INSERT INTO public.deployment_departments
      (name, description, is_active, min_days,
       requires_stay_at_bhati, requires_initiated,
       include_vss, vss_min_days, vss_requires_stay_at_bhati, vss_requires_initiated)
VALUES ('SEWA COLLECTION',
        'Unplanned SEWA COLLECTION deployment point (Oct 2026 Visit) — 0-count allocations, every row surplus.',
        true, 1,
        false, false,
        false, 1, false, false)
ON CONFLICT DO NOTHING;

-- H3 — park the same 5 UPDATE-blocking triggers (guarded).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_a_freeze_deployed_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_block_finalized_deploy_edit;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment_batch_upd;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_block_after_deadline_deploy;
  END IF;
END $$;

-- H4 — snapshot pre-move state (first run wins on re-run).
CREATE TABLE IF NOT EXISTS public.sewacollection_move_backup_oct2026 (
  schedule_id                  uuid        NOT NULL,
  badge_number                 text        NOT NULL,
  centre                       text        NOT NULL,
  old_department_id            uuid,
  old_deployed_department_id   uuid,
  moved_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, badge_number)
);

INSERT INTO public.sewacollection_move_backup_oct2026
      (schedule_id, badge_number, centre, old_department_id, old_deployed_department_id)
SELECT d.schedule_id, d.badge_number, d.centre, d.department_id, d.deployed_department_id
  FROM public.deployments d
  JOIN public.sewacollection_move_list_oct2026 l ON l.badge_number = d.badge_number
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 20.

-- H5 — THE MOVE (mirror-state CASE + blank-name fill, pinned to 20 badges).
UPDATE public.deployments d
   SET department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION'),
       deployed_department_id = CASE
         WHEN d.deployed_department_id IS NOT NULL
         THEN (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')
         ELSE NULL
       END,
       sewadar_name = COALESCE(NULLIF(btrim(d.sewadar_name), ''), l.full_name)
  FROM public.sewacollection_move_list_oct2026 l
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;
-- EXPECTED: UPDATE 20.

-- H6 — assert (mismatch EXCEPTIONs everything).
DO $$
DECLARE
  v_sched   uuid;
  v_target  uuid;
  v_list    integer;
  v_got     integer;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)));
  SELECT id INTO v_target FROM public.deployment_departments WHERE name = 'SEWA COLLECTION';
  SELECT count(*) INTO v_list FROM public.sewacollection_move_list_oct2026;
  SELECT count(*) INTO v_got
    FROM public.deployments
   WHERE schedule_id = v_sched
     AND department_id = v_target
     AND badge_number IN (SELECT badge_number FROM public.sewacollection_move_list_oct2026);
  IF v_got <> v_list THEN
    RAISE EXCEPTION 'Only % of % badges are SEWA COLLECTION — rolling everything back.', v_got, v_list;
  END IF;
  RAISE NOTICE 'Move ok: %/% rows now SEWA COLLECTION.', v_got, v_list;
END $$;

-- H7 — triggers back on (same 5, guarded).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_a_freeze_deployed_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_block_finalized_deploy_edit;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment_batch_upd;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_block_after_deadline_deploy;
  END IF;
END $$;

-- H8 — 0-count allocations per root centre (same unplanned/surplus marker).
INSERT INTO public.centre_allocations (schedule_id, department_id, centre, max_count)
SELECT k.sched, k.target, public.get_root_centre(d.centre), 0
  FROM public.deployments d
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)))) AS sched,
                    (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION') AS target) k
 WHERE d.schedule_id = k.sched
   AND d.department_id = k.target
 GROUP BY k.sched, k.target, public.get_root_centre(d.centre)
ON CONFLICT DO NOTHING;
-- EXPECTED: INSERT 0 <distinct root-centre count, up to 8>.

COMMIT;


-- ================= §I — SET 3 VERIFICATION (read-only; run after COMMIT) =================

-- I1 — the 20 with new effective dept (expect requested=SEWA COLLECTION for all).
SELECT l.badge_number,
       d.centre,
       rd.name AS requested,
       fd.name AS final,
       COALESCE(fd.name, rd.name) AS effective,
       d.status
  FROM public.sewacollection_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- I2 — per-centre SEWA COLLECTION counts (sheet split for cross-check; DB centre
-- spellings may differ in case — totals must equal 20; the sheet's 2
-- blank-centre rows are the §K pair, not here).
-- Sheet (minus §K pair): Ankheer 4, Dlf City Gurgaon 4, Gurgaon 4, Nit-2 2,
-- Palwal 2, Rajendra Park 2, Suraj Kund 2.
SELECT d.centre, count(*) AS sewacollection_count
  FROM public.deployments d
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')
 GROUP BY d.centre
 ORDER BY sewacollection_count DESC, d.centre;

-- I3 — old depts released (counts should have DROPPED by: OLD ENCLOSURE 9,
-- LUGGAGE 3, SEWA SAMITI 3, TRAFFIC 2, SECURITY 2, MEDICAL 1; 'ASO' 2 only if
-- ASO is a real department — otherwise those 2 rows surface in P13 instead).
SELECT dd.name, count(*) AS remaining
  FROM public.deployments d
  JOIN public.deployment_departments dd ON dd.id = d.department_id
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND dd.name IN ('OLD ENCLOSURE','LUGGAGE','SEWA SAMITI','TRAFFIC','SECURITY','MEDICAL','ASO')
 GROUP BY dd.name
 ORDER BY remaining DESC, dd.name;

-- I4 — the 0-count allocations (expect one row per root centre, all 0).
SELECT a.centre, a.max_count
  FROM public.centre_allocations a
 WHERE a.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND a.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA COLLECTION')
 ORDER BY a.centre;

-- I5 — triggers ALL back on (EVERY row must read ENABLED).
SELECT tgname,
       CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tgenabled::text END AS state
  FROM pg_trigger
 WHERE tgrelid = 'public.deployments'::regclass
   AND NOT tgisinternal
 ORDER BY tgname;

-- I6 — backup intact (expect 20).
SELECT count(*) AS backup_rows
  FROM public.sewacollection_move_backup_oct2026
 WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))));


-- ================= §J — SET 3 ROLLBACK (COMMENTED OUT; run ONLY to undo §H) =================
-- Restores department_id + deployed_department_id from the §H snapshot.
-- Re-run I1 afterwards: requested/final must read the OLD departments again.
-- NOTE: this does NOT remove the 0-count allocations, the SEWA COLLECTION
-- department row, or the staging/backup tables — remove those explicitly only
-- if you truly want them gone.
--
-- BEGIN;
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments DISABLE TRIGGER trg_a_freeze_deployed_deploy;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments DISABLE TRIGGER trg_block_finalized_deploy_edit;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment_batch_upd;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments DISABLE TRIGGER trg_block_after_deadline_deploy;
--   END IF;
-- END $$;
-- UPDATE public.deployments d
--    SET department_id = b.old_department_id,
--        deployed_department_id = b.old_deployed_department_id
--   FROM public.sewacollection_move_backup_oct2026 b
--  WHERE d.schedule_id = b.schedule_id
--    AND d.badge_number = b.badge_number
--    AND b.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))));
-- -- EXPECTED: UPDATE 20.
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments ENABLE TRIGGER trg_a_freeze_deployed_deploy;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments ENABLE TRIGGER trg_block_finalized_deploy_edit;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment_batch_upd;
--   END IF;
--   IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
--     ALTER TABLE public.deployments ENABLE TRIGGER trg_block_after_deadline_deploy;
--   END IF;
-- END $$;
-- COMMIT;

-- ================= NOTES (SET 3) =================
-- N8 (overlap): FB6002LA0044 + FB6002LA0046 were ALSO in SET 2 (SEWA SAMITI,
--   already migrated by the sibling file). This move retargets absolutely
--   (never relative), so they end in SEWA COLLECTION; the §H backup snapshot
--   records SEWA SAMITI as their pre-move state, and §J would restore exactly that.
-- N9 (source gaps): this workbook has no is_initiated column and no target
--   column; 2 rows have blank centre, 2 list 'ASO' as current deployment, and
--   centre spellings vary in case vs the DB. Matching is by badge (immune to
--   all of that); P13/P16 surface anything unmatched BEFORE §H touches rows.
-- N10 (re-runs): §0d/§H-upsert/H4/H8 are ON CONFLICT DO NOTHING (first run
--   wins); H1/H6 abort loudly instead of half-applying. Safe to re-run.


-- ================= §0e — SET 3B CONFIG (additive, re-runnable) =================
-- Centres for the 2 badges that had no deployment row (P13 NO ROW). These are
-- NEW deployments, not moves.
-- §0e-auto below fills any still-placeholder centre from the sewadar master
-- (normalized to the canonical centres-table spelling); a manually set value
-- always wins. K1 aborts only on a genuine gap.
ALTER TABLE public.sewacollection_move_cfg_oct2026
  ADD COLUMN IF NOT EXISTS centre_fb6003ga0013 text NOT NULL DEFAULT 'REPLACE_WITH_CENTRE';
ALTER TABLE public.sewacollection_move_cfg_oct2026
  ADD COLUMN IF NOT EXISTS centre_fb5991ga0050 text NOT NULL DEFAULT 'REPLACE_WITH_CENTRE';
-- Manual override (ONE statement, re-runnable; wins over auto-fill):
--   UPDATE public.sewacollection_move_cfg_oct2026 SET centre_fb6003ga0013 = '<CENTRE>', centre_fb5991ga0050 = '<CENTRE>' WHERE id = 1;
UPDATE public.sewacollection_move_cfg_oct2026 SET centre_fb6003ga0013 =
  (SELECT c.name FROM public.dp_sewadars s JOIN public.dp_centres c ON lower(c.name) = lower(btrim(s.centre)) WHERE s.badge_number = 'FB6003GA0013' LIMIT 1)
WHERE id = 1
  AND (centre_fb6003ga0013 IS NULL OR btrim(centre_fb6003ga0013) = '' OR centre_fb6003ga0013 = 'REPLACE_WITH_CENTRE')
  AND EXISTS (SELECT 1 FROM public.dp_sewadars s JOIN public.dp_centres c ON lower(c.name) = lower(btrim(s.centre)) WHERE s.badge_number = 'FB6003GA0013');
UPDATE public.sewacollection_move_cfg_oct2026 SET centre_fb5991ga0050 =
  (SELECT c.name FROM public.dp_sewadars s JOIN public.dp_centres c ON lower(c.name) = lower(btrim(s.centre)) WHERE s.badge_number = 'FB5991GA0050' LIMIT 1)
WHERE id = 1
  AND (centre_fb5991ga0050 IS NULL OR btrim(centre_fb5991ga0050) = '' OR centre_fb5991ga0050 = 'REPLACE_WITH_CENTRE')
  AND EXISTS (SELECT 1 FROM public.dp_sewadars s JOIN public.dp_centres c ON lower(c.name) = lower(btrim(s.centre)) WHERE s.badge_number = 'FB5991GA0050');
-- EXPECTED: UPDATE 0 (you set them / nothing to fill) / 1 / 2 (auto-filled).
SELECT * FROM public.sewacollection_move_cfg_oct2026; -- EXPECTED: 1 row, real centres.


-- ================= §K — INSERT 2 ASO deployments (run K0..COMMIT as ONE block) =================
-- FB6003GA0013 (Manohar Lal): consent yes, chairpass YES, stay_at_bhati NO.
-- FB5991GA0050 (Jatin singh): consent yes, chairpass no, stay_at_bhati NO.
-- Both: NEW ASO-finalized rows into TRAFFIC OUTSIDE BHATI
-- (requested + final set together).
BEGIN;

-- K0 — confirm centres (and schedule). Fix §0e first if wrong.
SELECT * FROM public.sewacollection_move_cfg_oct2026;

-- K1 — guards. Centres must be set; badges must exist as sewadars; and NEITHER
-- may already have a deployment row (that case belongs in §H, not here).
-- Any failure RAISEs EXCEPTION = whole transaction rolls back, nothing changed.
DO $$
DECLARE
  v_sched   uuid;
  v_c1      text;
  v_c2      text;
  v_missing text[];
  v_have    text[];
BEGIN
  SELECT centre_fb6003ga0013, centre_fb5991ga0050
    INTO v_c1, v_c2
    FROM public.sewacollection_move_cfg_oct2026;
  IF v_c1 IS NULL OR btrim(v_c1) = '' OR v_c1 = 'REPLACE_WITH_CENTRE'
     OR v_c2 IS NULL OR btrim(v_c2) = '' OR v_c2 = 'REPLACE_WITH_CENTRE' THEN
    RAISE EXCEPTION 'Centres still unset (got ''%'' / ''%'') and the sewadar master has no usable centre either — set both via §0e and re-run. Nothing changed.', v_c1, v_c2;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dp_centres WHERE lower(name) = lower(btrim(v_c1))) THEN
    RAISE EXCEPTION 'Centre ''%'' (FB6003GA0013) matches no known centre — fix the spelling via §0e. Known centres: %. Nothing changed.', v_c1, (SELECT string_agg(name, ' | ' ORDER BY name) FROM public.dp_centres);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dp_centres WHERE lower(name) = lower(btrim(v_c2))) THEN
    RAISE EXCEPTION 'Centre ''%'' (FB5991GA0050) matches no known centre — fix the spelling via §0e. Known centres: %. Nothing changed.', v_c2, (SELECT string_agg(name, ' | ' ORDER BY name) FROM public.dp_centres);
  END IF;

  SELECT id INTO v_sched FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)));
  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'Schedule not found — fix the §0 config and re-run. Nothing changed.';
  END IF;

  SELECT array_agg(m.badge) INTO v_missing
    FROM (VALUES ('FB6003GA0013'), ('FB5991GA0050')) AS m(badge)
    LEFT JOIN public.dp_sewadars s ON s.badge_number = m.badge
   WHERE s.badge_number IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Badges NOT FOUND as sewadars: % — fix and re-run. Nothing changed.',
      array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(m.badge) INTO v_have
    FROM (VALUES ('FB6003GA0013'), ('FB5991GA0050')) AS m(badge)
    JOIN public.deployments d ON d.schedule_id = v_sched AND d.badge_number = m.badge;
  IF v_have IS NOT NULL THEN
    RAISE EXCEPTION 'Badges ALREADY have a deployment row: % — they belong in §H, not §K. Nothing changed.',
      array_to_string(v_have, ', ');
  END IF;
END $$;

-- K2 — ensure TRAFFIC OUTSIDE BHATI exists (values apply ONLY to a newly
-- inserted row; an existing row is left UNTOUCHED).
INSERT INTO public.deployment_departments
      (name, description, is_active, min_days,
       requires_stay_at_bhati, requires_initiated,
       include_vss, vss_min_days, vss_requires_stay_at_bhati, vss_requires_initiated)
VALUES ('TRAFFIC OUTSIDE BHATI',
        'Unplanned TRAFFIC OUTSIDE BHATI deployment point (Oct 2026 Visit) — 0-count allocations, every row surplus.',
        true, 1,
        false, false,
        false, 1, false, false)
ON CONFLICT DO NOTHING;

-- K3 — park the 5 deployments UPDATE/INSERT-blocking triggers (guarded) PLUS
-- the 2 consent-write triggers that could reject the consent upsert (guarded).
-- Audit + require_sewadar_exists + AAS guard + OE-clamp stay on throughout.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_a_freeze_deployed_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_block_finalized_deploy_edit;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_check_deployment_batch_upd;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments DISABLE TRIGGER trg_block_after_deadline_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents DISABLE TRIGGER trg_block_after_deadline;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_consent' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents DISABLE TRIGGER trg_block_finalized_consent;
  END IF;
END $$;

-- K4 — consent upserts (consent YES; chairpass YES only for FB6003GA0013;
-- stay_at_bhati NO for both).
-- CONFIRM available_days_count: no workbook carries consented days; 5 assumed
-- (minimum the gates need is 1). Correct the two rows via ConsentPage if
-- their real consented days differ.
INSERT INTO public.sewadar_consents
      (schedule_id, centre, badge_number, consent_given, available_days_count, stay_at_bhati, chair_pass)
SELECT k.sched,
       CASE m.badge WHEN 'FB6003GA0013'
                     THEN (SELECT centre_fb6003ga0013 FROM public.sewacollection_move_cfg_oct2026)
                     ELSE (SELECT centre_fb5991ga0050 FROM public.sewacollection_move_cfg_oct2026) END,
       m.badge,
       true,
       5,
       false,
       CASE WHEN m.badge = 'FB6003GA0013' THEN true ELSE false END
  FROM (VALUES ('FB6003GA0013'), ('FB5991GA0050')) AS m(badge)
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)))) AS sched) k
ON CONFLICT (schedule_id, centre, badge_number) DO UPDATE
   SET consent_given = EXCLUDED.consent_given,
       available_days_count = EXCLUDED.available_days_count,
       stay_at_bhati = EXCLUDED.stay_at_bhati,
       chair_pass = EXCLUDED.chair_pass;
-- EXPECTED: INSERT 0 2 (or UPDATE 2 if consent rows already existed).

-- K5 — deployment INSERTs, ASO-finalized (requested + final = TRAFFIC OUTSIDE BHATI).
INSERT INTO public.deployments
      (schedule_id, centre, badge_number, sewadar_name, department_id, deployed_department_id)
SELECT k.sched,
       CASE m.badge WHEN 'FB6003GA0013'
                     THEN (SELECT centre_fb6003ga0013 FROM public.sewacollection_move_cfg_oct2026)
                     ELSE (SELECT centre_fb5991ga0050 FROM public.sewacollection_move_cfg_oct2026) END,
       m.badge,
       l.full_name,
       w.id,
       w.id
  FROM (VALUES ('FB6003GA0013'), ('FB5991GA0050')) AS m(badge)
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)))) AS sched) k
 CROSS JOIN (SELECT id FROM public.deployment_departments WHERE name = 'TRAFFIC OUTSIDE BHATI') w
  JOIN (VALUES ('FB6003GA0013', 'Manohar Lal'), ('FB5991GA0050', 'Jatin singh')) AS l(badge_number, full_name)
    ON l.badge_number = m.badge
ON CONFLICT DO NOTHING;
-- EXPECTED: INSERT 0 2 (K1 guarantees no row exists; a conflict means someone
-- created one concurrently — assert K6 still passes, then investigate).

-- K6 — assert both rows exist now, requested + FINAL = TRAFFIC OUTSIDE BHATI.
DO $$
DECLARE
  v_sched  uuid;
  v_target uuid;
  v_got    integer;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)));
  SELECT id INTO v_target FROM public.deployment_departments WHERE name = 'TRAFFIC OUTSIDE BHATI';
  SELECT count(*) INTO v_got
    FROM public.deployments
   WHERE schedule_id = v_sched
     AND department_id = v_target
     AND deployed_department_id = v_target
     AND badge_number IN ('FB6003GA0013', 'FB5991GA0050');
  IF v_got <> 2 THEN
    RAISE EXCEPTION 'Only % of 2 badges are finalized TRAFFIC OUTSIDE BHATI — rolling everything back.', v_got;
  END IF;
  RAISE NOTICE 'Inserts ok: %/2 rows finalized TRAFFIC OUTSIDE BHATI.', v_got;
END $$;

-- K7 — triggers back on (same 7, guarded).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_a_freeze_deployed_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_a_freeze_deployed_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_deploy_edit' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_block_finalized_deploy_edit;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_deployment_batch_upd' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_check_deployment_batch_upd;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline_deploy' AND tgrelid = 'public.deployments'::regclass) THEN
    ALTER TABLE public.deployments ENABLE TRIGGER trg_block_after_deadline_deploy;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents ENABLE TRIGGER trg_block_after_deadline;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_consent' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents ENABLE TRIGGER trg_block_finalized_consent;
  END IF;
END $$;

-- K8 — 0-count allocations for their root centres (surplus marker; existing
-- real allocations are kept by ON CONFLICT DO NOTHING).
INSERT INTO public.centre_allocations (schedule_id, department_id, centre, max_count)
SELECT k.sched, k.target, public.get_root_centre(d.centre), 0
  FROM public.deployments d
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026)))) AS sched,
                    (SELECT id FROM public.deployment_departments WHERE name = 'TRAFFIC OUTSIDE BHATI') AS target) k
 WHERE d.schedule_id = k.sched
   AND d.badge_number IN ('FB6003GA0013', 'FB5991GA0050')
 GROUP BY k.sched, k.target, public.get_root_centre(d.centre)
ON CONFLICT DO NOTHING;
-- EXPECTED: INSERT 0 1 or 2 (distinct root centres of the two rows).

COMMIT;


-- ================= §L — SET 3B VERIFICATION (read-only; run after COMMIT) =================

-- L1 — the 2 rows (expect requested = final = TRAFFIC OUTSIDE BHATI for both).
SELECT d.badge_number,
       d.sewadar_name,
       d.centre,
       rd.name AS requested,
       fd.name AS final,
       d.status
  FROM public.deployments d
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.badge_number IN ('FB6003GA0013', 'FB5991GA0050')
 ORDER BY d.badge_number;

-- L2 — their consent rows (expect consent yes, days 5, stay no both;
-- chair yes ONLY for FB6003GA0013).
SELECT badge_number, centre, consent_given, available_days_count, stay_at_bhati, chair_pass
  FROM public.sewadar_consents
 WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND badge_number IN ('FB6003GA0013', 'FB5991GA0050')
 ORDER BY badge_number;

-- L3 — parked triggers ALL back on (EVERY row must read ENABLED; ABSENT rows
-- mean that trigger never existed in this DB — also fine).
SELECT (CASE WHEN tgrelid = 'public.deployments'::regclass THEN 'deployments' ELSE 'sewadar_consents' END) AS tbl,
       tgname,
       CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tgenabled::text END AS state
  FROM pg_trigger
 WHERE tgrelid IN ('public.deployments'::regclass, 'public.sewadar_consents'::regclass)
   AND NOT tgisinternal
   AND tgname IN ('trg_a_freeze_deployed_deploy', 'trg_block_finalized_deploy_edit',
                  'trg_check_deployment', 'trg_check_deployment_batch_upd',
                  'trg_block_after_deadline_deploy', 'trg_block_after_deadline',
                  'trg_block_finalized_consent')
 ORDER BY tbl, tgname;

-- L4 — TRAFFIC OUTSIDE BHATI totals in this schedule (informational: the dept
-- may hold other rows; the 2 new ones must be present with FINAL set).
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE deployed_department_id IS NOT NULL) AS finalized_rows
  FROM public.deployments d
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
   AND d.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'TRAFFIC OUTSIDE BHATI');


-- ================= §M — SET 3B ROLLBACK (COMMENTED OUT; run ONLY to undo §K) =================
-- Deletes the 2 inserted deployment rows (+ optionally their consent rows).
-- Re-run L1/L2 afterwards: both queries must return 0 rows.
--
-- BEGIN;
-- -- (same 7 triggers parked as K3 — copy that block here before deleting)
-- DELETE FROM public.deployments
--  WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
--    AND badge_number IN ('FB6003GA0013', 'FB5991GA0050');
-- -- EXPECTED: DELETE 2.
-- -- Optional: remove the consent rows this script wrote (only if nothing else uses them):
-- -- DELETE FROM public.sewadar_consents
-- --  WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.sewacollection_move_cfg_oct2026))))
-- --    AND badge_number IN ('FB6003GA0013', 'FB5991GA0050');
-- -- (re-enable the 7 triggers as K7, then COMMIT; verify with L3.)
-- COMMIT;

-- ================= NOTES (SET 3B) =================
-- N11 (assumptions to confirm): centres auto-fill from the sewadar master
--   (§0e-auto, canonical spelling; manual §0e values win) — the sheet blanks
--   are therefore resolved logically, not guessed. available_days_count=5 is
--   assumed (no workbook carries consented days; gates need >= 1). Correct
--   both via ConsentPage if the real values differ — they are
--   display/eligibility data, the deployments stand.
-- N12 (FINAL meaning): both rows carry deployed_department_id, so they read
--   FINAL everywhere and are v15/v16-protected like any ASO-finalized row.
--   Centre roles cannot edit them afterwards (freeze + passed deadline).
-- N13 (re-runs): §0e/§K-upsert/K2/K8 are conflict-guarded; K1/K6 abort loudly
--   instead of half-applying. Safe to re-run.
