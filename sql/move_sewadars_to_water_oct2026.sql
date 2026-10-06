-- ============================================================
-- ONE-OFF DATA FIX: two unplanned Faridabad dept moves, Oct 2026 Visit
-- Schedule : see §0b config (default 'October Visit 2026')
-- SET 1    : Faridabad Deployed in Water.xlsx (Sheet1, 30 rows;
--            deployed_department=WATER is the NEW dept,
--            parent_department_name is the CURRENT/old dept)
-- SET 2    : Faridabad from Medical to Sewa Samiti.xlsx (Sheet1, 29 rows;
--            deployed_department=SEWA SAMITI is the NEW dept,
--            parent_department_name is the CURRENT/old dept)
--
-- WHAT IT DOES
--   1. Stages the 30 badges (additive staging table, re-runnable).
--   2. Ensures a WATER row in deployment_departments (new rows get
--      permissive unplanned-dept rules; an EXISTING WATER row is left
--      byte-for-byte UNTOUCHED).
--   3. Snapshots every touched row into water_move_backup_oct2026
--      (rollback/audit; first run wins on re-run).
--   4. Retargets department_id -> WATER for all 30, and
--      deployed_department_id -> WATER only where it was already set
--      (mirrors the current request-only vs ASO-finalized state).
--      Fills sewadar_name ONLY where blank.
--   5. Inserts centre_allocations max_count=0 per root centre holding
--      WATER rows (the "unplanned / all surplus" marker; v38c already
--      relaxed the CHECK to >= 0, so 0 stores).
--   6. NO incharge grants: incharges will be added later from the UI.
--      (Until granted, an incharge simply sees nothing — fail-closed.)
--   7. SET 2 (§0c staging, §A2 pre-flight, §E move, §F verify, §G rollback):
--      identical treatment for 29 ladies into SEWA SAMITI — own staging /
--      backup tables, 0-count allocations, no grants either.
--
-- WHAT IT DOES *NOT* DO
--   - No DELETE / DROP / TRUNCATE executes at all. The only cleanup
--     statements in this file are COMMENTED OUT for you to opt into.
--   - No consent rows touched (consents are dept-agnostic).
--   - No department rules, quotas, locks, overrides, schedules, or
--     other sewadars touched. WHERE clauses pin ONE schedule + 30 badges.
--   - Triggers are parked ONLY on public.deployments, ONLY the 5 that
--     can reject this UPDATE, ONLY inside the transaction. Audit keeps
--     firing (trail preserved); require_sewadar_exists + the AAS guard
--     stay on (integrity fail-closeds).
--
-- HOW TO RUN (Supabase SQL editor, database owner)
--   §0  staging+config — run alone first. Expect: INSERT 0 30, staged 30, cfg 1 row.
--        If B1 says "not found", its error LISTS the real schedule names — run the
--        §0b UPDATE with the EXACT name, then re-run from §A. No other edits needed.
--   §A  pre-flight — read-only. Review EVERY result before proceeding:
--                    P3 must show 30 'ok' (any '*** NO ROW ***' aborts §B),
--                    P4 finalized+requested must equal 30,
--                    P5 must read CHECK ((max_count >= 0)).
--   §B  the move   — paste B0..COMMIT and run as ONE block.
--                    Expect: UPDATE 30. Any guard failure EXCEPTIONs and
--                    rolls back the whole transaction (triggers included).
--   §C  verify     — run, compare against the EXPECTED notes inline.
--   §E  second move — same pattern for SET 2 (SEWA SAMITI). Run E0..COMMIT
--                    as ONE block. Expect: UPDATE 29.
--   §F  verify set 2 — run, compare against the EXPECTED notes inline.
--   WHOLE-RUN MODE (recommended): paste the ENTIRE file and run once.
--                    Pre-flight grids display inline; B1/E1 abort their own
--                    transaction on any guard failure (nothing half-applied,
--                    and the editor stops at the first ERROR).
--                    Expect: UPDATE 30 (§B) + UPDATE 29 (§E); then review
--                    the §C/§F grids top-to-bottom against EXPECTED notes.
--
-- KNOWN SIDE EFFECT (accepted): a 0-count WATER allocation makes
-- check_centre_lock require a WATER incharge (department_incharges,
-- centre x dept) before an affected centre can lock, raising
-- 'Cannot lock deployment — add an incharge for every allocated
-- department first'. The ConsentPage pre-lock warning does NOT
-- pre-list WATER (it only looks at max_count > 0), so the lock error
-- is the first signal. Fix = nominate the WATER incharge per centre
-- from Centre Lists (guard needs their effective dept = WATER, which
-- this move establishes for the 30). See note N1 at the bottom.
-- ============================================================

-- ================= §0 — STAGING (additive, re-runnable) =================
CREATE TABLE IF NOT EXISTS public.water_move_list_oct2026 (
  badge_number text PRIMARY KEY,
  full_name    text NOT NULL
);

INSERT INTO public.water_move_list_oct2026 (badge_number, full_name) VALUES
  ('FB6008GA0126', 'AMIT SHARMA'),
  ('FB6008GA0026', 'HITESH BHATIA'),
  ('FB6008GA0130', 'DEVENDER KUMAR MALHOTRA'),
  ('FB5971GA0063', 'VIRENDER BHATNAGAR'),
  ('FB5972GA0013', 'ARJUN SINGH'),
  ('FB5972GA0010', 'GHAN SHYAM'),
  ('FB5972GA0002', 'PAWAN KUMAR'),
  ('FB5972GA0008', 'SATISH'),
  ('FB5977GA0007', 'KRISHAN KUMAR'),
  ('FB5977GA0001', 'ANIL KANT'),
  ('FB5977GA0015', 'JAGBIR SINGH'),
  ('FB5977GA0006', 'RAMESH KAMBOJ'),
  ('FB5978GA0105', 'SHEETAL BHAKOO'),
  ('FB5978GA0162', 'SACHIN'),
  ('FB5978GA0032', 'MANDHEER KUMAR'),
  ('FB5978GA0160', 'NAVNEET JAIDKAR'),
  ('FB5981GA0016', 'JATINDER KUMAR'),
  ('FB5982GA0159', 'RAJESH SHARMA'),
  ('FB5982GA0003', 'RISHABH KHURANA'),
  ('FB5982GA0177', 'SANJEEV KUMAR'),
  ('FB5983GA0006', 'DAULAT RAM'),
  ('FB5991GA0086', 'SOHAN LAL KHINCHEE'),
  ('FB5991GA0005', 'SATYAPAL SINGH'),
  ('FB5994GA0010', 'SURENDER SINGH'),
  ('FB5994GA0025', 'OM PRAKASH'),
  ('FB5994GA0033', 'MAHABIR'),
  ('FB5997GA0001', 'SOHAN LAL'),
  ('FB5997GA0010', 'JAI BIR'),
  ('FB5997GA0003', 'JAIPAL'),
  ('FB6002GA0002', 'KRISHAN KUMAR')
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 30. Re-run: INSERT 0 0.

SELECT count(*) AS staged_badges FROM public.water_move_list_oct2026;
-- EXPECTED: 30.

-- §0b — SINGLE EDIT POINT: the schedule name. EVERY statement below reads
-- this row, so a name mismatch is fixed in exactly ONE place.
-- (No incharge grants in this script — incharges are added later from the UI.)
CREATE TABLE IF NOT EXISTS public.water_move_cfg_oct2026 (
  id             integer PRIMARY KEY CHECK (id = 1),
  schedule_name  text NOT NULL DEFAULT 'October Visit 2026'
);
-- Converge DBs where an earlier version created badge columns (unused leftovers):
ALTER TABLE public.water_move_cfg_oct2026 DROP COLUMN IF EXISTS incharge_badge;
ALTER TABLE public.water_move_cfg_oct2026 DROP COLUMN IF EXISTS sewasamiti_incharge_badge;
INSERT INTO public.water_move_cfg_oct2026 (id) VALUES (1) ON CONFLICT DO NOTHING;
-- Whole-run convergence: repair the stale default name from earlier revisions.
-- Touches ONLY the known-wrong value; a deliberately different name is left alone.
UPDATE public.water_move_cfg_oct2026 SET schedule_name = 'October Visit 2026' WHERE id = 1 AND schedule_name = 'October 2026 Visit';
-- EXPECTED: UPDATE 1 (first run after the fix) or UPDATE 0.
-- If P1 / the B1 error shows your schedule is named differently, run this ONE
-- statement with the EXACT name, then re-run from §A:
--   UPDATE public.water_move_cfg_oct2026 SET schedule_name = '<EXACT NAME>' WHERE id = 1;
SELECT * FROM public.water_move_cfg_oct2026;
-- EXPECTED: 1 row.


-- ================= §A — PRE-FLIGHT (read-only; run all, review all) =================

-- P1 — ALL schedules (find the EXACT name; it must equal the §0 config
-- schedule_name, ignoring case/outer spaces; is_target flags the match).
SELECT id, name, status, deadline, visit_start_date, visit_end_date,
       (lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026)))) AS is_target
  FROM public.deployment_schedules
 ORDER BY name;

-- P2 — WATER dept today (0 rows = §B will create it; 1 row = §B leaves it untouched).
SELECT id, name, is_active, min_days, requires_stay_at_bhati, requires_initiated, include_vss
  FROM public.deployment_departments
 WHERE name = 'WATER';

-- P3 — every badge's current row (30 'ok' required; any '*** NO ROW ***' aborts §B by design).
SELECT l.badge_number,
       l.full_name,
       d.centre,
       d.sewadar_name,
       rd.name AS requested_dept,
       fd.name AS final_dept,
       d.status,
       CASE WHEN d.badge_number IS NULL THEN '*** NO ROW — §B will abort ***' ELSE 'ok' END AS state
  FROM public.water_move_list_oct2026 l
  LEFT JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- P4 — request-only vs ASO-finalized split (finalized + requested_only must equal 30).
SELECT count(*) FILTER (WHERE d.deployed_department_id IS NOT NULL) AS finalized,
       count(*) FILTER (WHERE d.deployed_department_id IS NULL)     AS requested_only
  FROM public.water_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;

-- P5 — zero-alloc storable? (must read CHECK ((max_count >= 0)) — v38c).
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.centre_allocations'::regclass
   AND conname = 'centre_allocations_max_count_check';

-- P6 — existing WATER footprint in this schedule (expect 0 / 0 / 0 before the move).
SELECT (SELECT count(*) FROM public.deployments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND (department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER')
             OR deployed_department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER'))) AS water_rows,
       (SELECT count(*) FROM public.centre_allocations
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER')) AS water_allocs,
       (SELECT count(*) FROM public.department_incharge_assignments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER')) AS water_grants;

-- P7 — master-table flags (ELDERLY rows are trigger-blocked everywhere; informative here).
SELECT s.badge_number, s.badge_status
  FROM public.dp_sewadars s
 WHERE s.badge_number IN (SELECT badge_number FROM public.water_move_list_oct2026)
 ORDER BY s.badge_number;

-- P8 — incharge records naming any of the 30 (informative; see note N2 at the bottom).
SELECT i.centre, dd.name AS incharge_for_dept, i.badge_number
  FROM public.department_incharges i
  JOIN public.deployment_departments dd ON dd.id = i.department_id
 WHERE i.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND i.badge_number IN (SELECT badge_number FROM public.water_move_list_oct2026)
 ORDER BY 1, 2;


-- ================= §B — THE MOVE (run B0..COMMIT as ONE block) =================
BEGIN;

-- B0 — confirm the single config row (§0b): schedule_name.
-- If wrong, do NOT proceed: fix §0b config first, then re-run §B.
SELECT * FROM public.water_move_cfg_oct2026;

-- B1 — guards. Schedule must exist; every badge must have a row.
-- Any failure RAISEs EXCEPTION = the whole transaction rolls back, nothing changed.
DO $$
DECLARE
  v_sched_name text;
  v_sched      uuid;
  v_missing    text[];
  v_names      text;
BEGIN
  SELECT schedule_name INTO v_sched_name FROM public.water_move_cfg_oct2026;
  SELECT id INTO v_sched
    FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim(v_sched_name));
  IF v_sched IS NULL THEN
    SELECT string_agg(name, ' | ' ORDER BY name) INTO v_names FROM public.deployment_schedules;
    RAISE EXCEPTION 'Schedule ''%'' not found (schedules in DB: %). Fix water_move_cfg_oct2026.schedule_name and re-run. Nothing changed.',
      v_sched_name, COALESCE(v_names, '(none)');
  END IF;

  SELECT array_agg(l.badge_number) INTO v_missing
    FROM public.water_move_list_oct2026 l
    LEFT JOIN public.deployments d
      ON d.schedule_id = v_sched AND d.badge_number = l.badge_number
   WHERE d.badge_number IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Badges with NO deployments row in this schedule: % — fix the list and re-run. Nothing changed.',
      array_to_string(v_missing, ', ');
  END IF;
END $$;

-- B2 — ensure WATER exists. Values apply ONLY to a newly inserted row;
-- an existing WATER row is left UNTOUCHED (no rule changes, no logic drift).
INSERT INTO public.deployment_departments
      (name, description, is_active, min_days,
       requires_stay_at_bhati, requires_initiated,
       include_vss, vss_min_days, vss_requires_stay_at_bhati, vss_requires_initiated)
VALUES ('WATER',
        'Unplanned WATER deployment point (Oct 2026 Visit) — 0-count allocations, every row surplus.',
        true, 1,
        false, false,
        false, 1, false, false)
ON CONFLICT DO NOTHING;

-- B3 — park the 5 UPDATE-blocking triggers (guarded; repo idiom from v10/v16).
-- The SQL editor carries no portal role (NULL = centre role per v32), so each
-- of these would reject the move: freeze (v32), finalized-edit (v16),
-- quota+deadline row gate (v38/v37), statement batch quota (v38), deadline (v37).
-- Deliberately LEFT ENABLED: audit (AFTER-row, cannot block, keeps the trail),
-- require_sewadar_exists + AAS guard (integrity fail-closeds), OE-clamp (no-op here).
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

-- B4 — snapshot pre-move state (rollback + audit; first run wins on re-run).
CREATE TABLE IF NOT EXISTS public.water_move_backup_oct2026 (
  schedule_id                  uuid        NOT NULL,
  badge_number                 text        NOT NULL,
  centre                       text        NOT NULL,
  old_department_id            uuid,
  old_deployed_department_id   uuid,
  moved_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, badge_number)
);

INSERT INTO public.water_move_backup_oct2026
      (schedule_id, badge_number, centre, old_department_id, old_deployed_department_id)
SELECT d.schedule_id, d.badge_number, d.centre, d.department_id, d.deployed_department_id
  FROM public.deployments d
  JOIN public.water_move_list_oct2026 l ON l.badge_number = d.badge_number
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 30.

-- B5 — THE MOVE. department_id -> WATER for all 30; deployed_department_id ->
-- WATER only where already set (mirror state); sewadar_name filled only if blank.
UPDATE public.deployments d
   SET department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER'),
       deployed_department_id = CASE
         WHEN d.deployed_department_id IS NOT NULL
         THEN (SELECT id FROM public.deployment_departments WHERE name = 'WATER')
         ELSE NULL
       END,
       sewadar_name = COALESCE(NULLIF(btrim(d.sewadar_name), ''), l.full_name)
  FROM public.water_move_list_oct2026 l
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;
-- EXPECTED: UPDATE 30.

-- B6 — assert the move (mismatch EXCEPTIONs everything, triggers included).
DO $$
DECLARE
  v_sched   uuid;
  v_water   uuid;
  v_list    integer;
  v_water_n integer;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026)));
  SELECT id INTO v_water FROM public.deployment_departments WHERE name = 'WATER';
  SELECT count(*) INTO v_list FROM public.water_move_list_oct2026;
  SELECT count(*) INTO v_water_n
    FROM public.deployments
   WHERE schedule_id = v_sched
     AND department_id = v_water
     AND badge_number IN (SELECT badge_number FROM public.water_move_list_oct2026);
  IF v_water_n <> v_list THEN
    RAISE EXCEPTION 'Only % of % badges are WATER — rolling everything back.', v_water_n, v_list;
  END IF;
  RAISE NOTICE 'Move ok: %/% rows now WATER.', v_water_n, v_list;
END $$;

-- B7 — triggers back on (same 5, guarded).
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

-- B8 — 0-count allocations: one per ROOT centre holding WATER rows
-- (the "unplanned / all surplus" marker; hidden from ConsentPage pickers).
INSERT INTO public.centre_allocations (schedule_id, department_id, centre, max_count)
SELECT k.sched, k.water, public.get_root_centre(d.centre), 0
  FROM public.deployments d
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026)))) AS sched,
                    (SELECT id FROM public.deployment_departments WHERE name = 'WATER') AS water) k
 WHERE d.schedule_id = k.sched
   AND d.department_id = k.water
 GROUP BY k.sched, k.water, public.get_root_centre(d.centre)
ON CONFLICT DO NOTHING;
-- EXPECTED: INSERT 0 <distinct root-centre count, up to 12>.

-- B9 — REMOVED (owner decision): no incharge grants from this script.
-- Incharges for WATER are added later from the Users / Centre Lists UI.

COMMIT;


-- ================= §C — VERIFICATION (read-only; run after COMMIT) =================

-- C1 — the 30 with their new effective dept (expect requested=WATER for all 30;
-- final=WATER where P4 said finalized, NULL where request-only).
SELECT l.badge_number,
       d.centre,
       rd.name AS requested,
       fd.name AS final,
       COALESCE(fd.name, rd.name) AS effective,
       d.status
  FROM public.water_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- C2 — per-centre WATER counts
-- EXPECTED: ABHEYPUR 4, TAORU 4, SECTOR-15-A 4, NIT - 2 3, GURGAON 3,
-- BAROLI 3, SIHA 3, SURAJ KUND 2, ANKHEER 1, DLF CITY GURGAON 1,
-- FARUKH NAGAR 1, GREATER FARIDABAD 1 (root centres if SC_SP-mapped).
SELECT d.centre, count(*) AS water_count
  FROM public.deployments d
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER')
 GROUP BY d.centre
 ORDER BY water_count DESC, d.centre;

-- C3 — old depts released (counts should have DROPPED by: PANDAL 9, TRAFFIC 6,
-- SECURITY 5, ADMINISTRATION 3, SANITATION/B.A.V./PATHI/AUDIO-VISUAL/
-- HORTICULTURE/MEDICAL 1 each).
SELECT dd.name, count(*) AS remaining
  FROM public.deployments d
  JOIN public.deployment_departments dd ON dd.id = d.department_id
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND dd.name IN ('PANDAL','TRAFFIC','SECURITY','ADMINISTRATION','SANITATION',
                   'B.A.V.','PATHI','AUDIO-VISUAL','HORTICULTURE','MEDICAL')
 GROUP BY dd.name
 ORDER BY remaining DESC, dd.name;

-- C4 — the 0-count allocations (expect one row per root centre, all max_count 0).
SELECT a.centre, a.max_count
  FROM public.centre_allocations a
 WHERE a.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND a.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'WATER')
 ORDER BY a.centre;

-- C5 — REMOVED with B9 (grants live in the UI now; nothing to verify here).

-- C6 — triggers ALL back on (EVERY row must read ENABLED, especially the 5 parked in B3).
SELECT tgname,
       CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tgenabled::text END AS state
  FROM pg_trigger
 WHERE tgrelid = 'public.deployments'::regclass
   AND NOT tgisinternal
 ORDER BY tgname;

-- C7 — backup intact (expect 30).
SELECT count(*) AS backup_rows
  FROM public.water_move_backup_oct2026
 WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))));


-- ================= §D — ROLLBACK (COMMENTED OUT; run ONLY to undo §B) =================
-- Restores department_id + deployed_department_id from the §B snapshot.
-- Re-run C1 afterwards: requested/final must read the OLD departments again.
-- NOTE: this does NOT remove the 0-count allocations, the WATER
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
--   FROM public.water_move_backup_oct2026 b
--  WHERE d.schedule_id = b.schedule_id
--    AND d.badge_number = b.badge_number
--    AND b.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))));
-- -- EXPECTED: UPDATE 30.
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

-- ================= NOTES =================
-- N1 (centre lock): after §B, locking an affected centre requires a WATER
--   incharge (department_incharges, centre x dept) because the 0-count WATER
--   allocation participates in check_centre_lock. Nominate from Centre Lists;
--   the v21 guard only accepts a badge whose EFFECTIVE dept is WATER in that
--   root centre — true for the 30 after this move. The ConsentPage pre-lock
--   warning will NOT pre-list WATER (it filters max_count > 0); the lock's
--   RAISE EXCEPTION is the signal. This is the accepted trade-off of the
--   "0-count allocation" choice.
-- N2 (dangling incharge records): if P8 lists any of the 30 as an incharge of
--   their OLD dept, that record's premise ("assigned to this department") no
--   longer holds after §B. Show it to the ASO first; ONLY with confirmation,
--   run (uncommented, own transaction):
--     -- DELETE FROM public.department_incharges
--     --  WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
--     --    AND badge_number IN (SELECT badge_number FROM public.water_move_list_oct2026);
-- N3 (audit): the v17 audit trigger stays ENABLED through §B, so each moved
--   row still writes its audit entry (acted_by_role NULL = SQL-editor run).
-- N4 (re-runs): §0/§B-upsert/B4/B8 are ON CONFLICT DO NOTHING (first run
--   wins); B1/B6 abort loudly instead of half-applying. Safe to re-run.


-- ================= §0c — SET 2 STAGING (additive, re-runnable) =================
-- Second move-set: 29 ladies, current depts -> SEWA SAMITI (same schedule).

CREATE TABLE IF NOT EXISTS public.sewasamiti_move_list_oct2026 (
  badge_number text PRIMARY KEY,
  full_name    text NOT NULL
);

INSERT INTO public.sewasamiti_move_list_oct2026 (badge_number, full_name) VALUES
  ('FB6008LA0079', 'POONAM'),
  ('FB6008LA0112', 'MUSKAAN MALHOTRA'),
  ('FB6008LA0194', 'DEEPANSHI MALHOTRA'),
  ('FB6008LA0004', 'SEEMA MALHOTRA'),
  ('FB6008LA0077', 'SEEMA KUMARI'),
  ('FB6008LA0025', 'ASHU BHATIA'),
  ('FB6008LA0065', 'NISHA SANDHU'),
  ('FB5971LA0155', 'DRISHTI ANAND'),
  ('FB5977LA0017', 'RUPAL'),
  ('FB5977LA0013', 'NISHA VED'),
  ('FB5977LA0020', 'KAILASH TANEJA'),
  ('FB5977LA0016', 'MISHRO DEVI'),
  ('FB5977LA0006', 'KRISHNA KUMARI'),
  ('FB5978LA0104', 'SHEELANI BHANOT'),
  ('FB5978LA0179', 'SANTOSH ARORA'),
  ('FB5981LA0016', 'DEEPIKA VIRMANI'),
  ('FB5981LA0006', 'REKHA NAGAR'),
  ('FB5981LA0018', 'KAMLESH'),
  ('FB5981LA0024', 'MANJU'),
  ('FB5991LA0110', 'SHARDA DEVI'),
  ('FB5991LA0184', 'SUNITA'),
  ('FB5991LA0008', 'BABLEE DEVI'),
  ('FB5991LA0106', 'GEETA'),
  ('FB5991LA0149', 'SHASHI'),
  ('FB5997LA0001', 'KRISNA WATI'),
  ('FB5997LA0002', 'NIRMALA'),
  ('FB6002LA0044', 'MANISHA VERMA'),
  ('FB6002LA0046', 'POOJA MARWAH'),
  ('FB6002LA0068', 'ISHA VERMA')
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 29. Re-run: INSERT 0 0.

SELECT count(*) AS staged_badges_set2 FROM public.sewasamiti_move_list_oct2026;
-- EXPECTED: 29.


-- ================= §A2 — SET 2 PRE-FLIGHT (read-only; run all, review all) =================

-- P9 — every badge's current row (29 'ok' required; any '*** NO ROW ***' aborts §E).
SELECT l.badge_number,
       l.full_name,
       d.centre,
       d.sewadar_name,
       rd.name AS requested_dept,
       fd.name AS final_dept,
       d.status,
       CASE WHEN d.badge_number IS NULL THEN '*** NO ROW — §E will abort ***' ELSE 'ok' END AS state
  FROM public.sewasamiti_move_list_oct2026 l
  LEFT JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- P10 — request-only vs ASO-finalized split (finalized + requested_only must equal 29).
SELECT count(*) FILTER (WHERE d.deployed_department_id IS NOT NULL) AS finalized,
       count(*) FILTER (WHERE d.deployed_department_id IS NULL)     AS requested_only
  FROM public.sewasamiti_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;

-- P11 — SEWA SAMITI dept rules + existing footprint.
-- If the dept row EXISTS, §E leaves its rules untouched: check requires_initiated
-- below against P12's 4 non-initiated badges (future non-admin writes on those
-- 4 rows would re-validate; the move itself runs triggerless, so it is safe).
SELECT id, name, is_active, min_days, requires_stay_at_bhati, requires_initiated, include_vss
  FROM public.deployment_departments
 WHERE name = 'SEWA SAMITI';

SELECT (SELECT count(*) FROM public.deployments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND (department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')
             OR deployed_department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI'))) AS sewasamiti_rows,
       (SELECT count(*) FROM public.centre_allocations
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')) AS sewasamiti_allocs,
       (SELECT count(*) FROM public.department_incharge_assignments
         WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
           AND department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')) AS sewasamiti_grants;
-- EXPECTED before the move: 0 / 0 / 0.

-- P12 — master-table flags (incl. is_initiated: 4 badges are False — see N5)
-- + incharge records naming any of the 29 (informative; see N2 pattern).
SELECT s.badge_number, s.badge_status, s.is_initiated
  FROM public.dp_sewadars s
 WHERE s.badge_number IN (SELECT badge_number FROM public.sewasamiti_move_list_oct2026)
 ORDER BY s.badge_number;

SELECT i.centre, dd.name AS incharge_for_dept, i.badge_number
  FROM public.department_incharges i
  JOIN public.deployment_departments dd ON dd.id = i.department_id
 WHERE i.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND i.badge_number IN (SELECT badge_number FROM public.sewasamiti_move_list_oct2026)
 ORDER BY 1, 2;


-- ================= §E — SET 2 MOVE (run E0..COMMIT as ONE block) =================
BEGIN;

-- E0 — confirm the config row (schedule_name). Fix §0b first if wrong.
SELECT * FROM public.water_move_cfg_oct2026;

-- E1 — guards (same fail-closed pattern as B1; error lists real schedule names).
DO $$
DECLARE
  v_sched_name text;
  v_sched      uuid;
  v_missing    text[];
  v_names      text;
BEGIN
  SELECT schedule_name INTO v_sched_name FROM public.water_move_cfg_oct2026;
  SELECT id INTO v_sched
    FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim(v_sched_name));
  IF v_sched IS NULL THEN
    SELECT string_agg(name, ' | ' ORDER BY name) INTO v_names FROM public.deployment_schedules;
    RAISE EXCEPTION 'Schedule ''%'' not found (schedules in DB: %). Fix water_move_cfg_oct2026.schedule_name and re-run. Nothing changed.',
      v_sched_name, COALESCE(v_names, '(none)');
  END IF;

  SELECT array_agg(l.badge_number) INTO v_missing
    FROM public.sewasamiti_move_list_oct2026 l
    LEFT JOIN public.deployments d
      ON d.schedule_id = v_sched AND d.badge_number = l.badge_number
   WHERE d.badge_number IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Badges with NO deployments row in this schedule: % — fix the list and re-run. Nothing changed.',
      array_to_string(v_missing, ', ');
  END IF;
END $$;

-- E2 — ensure SEWA SAMITI exists (values apply ONLY to a newly inserted row;
-- an existing row is left UNTOUCHED).
INSERT INTO public.deployment_departments
      (name, description, is_active, min_days,
       requires_stay_at_bhati, requires_initiated,
       include_vss, vss_min_days, vss_requires_stay_at_bhati, vss_requires_initiated)
VALUES ('SEWA SAMITI',
        'Unplanned SEWA SAMITI deployment point (Oct 2026 Visit) — 0-count allocations, every row surplus.',
        true, 1,
        false, false,
        false, 1, false, false)
ON CONFLICT DO NOTHING;

-- E3 — park the same 5 UPDATE-blocking triggers (guarded).
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

-- E4 — snapshot pre-move state (first run wins on re-run).
CREATE TABLE IF NOT EXISTS public.sewasamiti_move_backup_oct2026 (
  schedule_id                  uuid        NOT NULL,
  badge_number                 text        NOT NULL,
  centre                       text        NOT NULL,
  old_department_id            uuid,
  old_deployed_department_id   uuid,
  moved_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, badge_number)
);

INSERT INTO public.sewasamiti_move_backup_oct2026
      (schedule_id, badge_number, centre, old_department_id, old_deployed_department_id)
SELECT d.schedule_id, d.badge_number, d.centre, d.department_id, d.deployed_department_id
  FROM public.deployments d
  JOIN public.sewasamiti_move_list_oct2026 l ON l.badge_number = d.badge_number
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
ON CONFLICT DO NOTHING;
-- EXPECTED first run: INSERT 0 29.

-- E5 — THE MOVE (mirror-state CASE + blank-name fill, pinned to 29 badges).
UPDATE public.deployments d
   SET department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI'),
       deployed_department_id = CASE
         WHEN d.deployed_department_id IS NOT NULL
         THEN (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')
         ELSE NULL
       END,
       sewadar_name = COALESCE(NULLIF(btrim(d.sewadar_name), ''), l.full_name)
  FROM public.sewasamiti_move_list_oct2026 l
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number;
-- EXPECTED: UPDATE 29.

-- E6 — assert (mismatch EXCEPTIONs everything).
DO $$
DECLARE
  v_sched   uuid;
  v_target  uuid;
  v_list    integer;
  v_got     integer;
BEGIN
  SELECT id INTO v_sched FROM public.deployment_schedules
   WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026)));
  SELECT id INTO v_target FROM public.deployment_departments WHERE name = 'SEWA SAMITI';
  SELECT count(*) INTO v_list FROM public.sewasamiti_move_list_oct2026;
  SELECT count(*) INTO v_got
    FROM public.deployments
   WHERE schedule_id = v_sched
     AND department_id = v_target
     AND badge_number IN (SELECT badge_number FROM public.sewasamiti_move_list_oct2026);
  IF v_got <> v_list THEN
    RAISE EXCEPTION 'Only % of % badges are SEWA SAMITI — rolling everything back.', v_got, v_list;
  END IF;
  RAISE NOTICE 'Move ok: %/% rows now SEWA SAMITI.', v_got, v_list;
END $$;

-- E7 — triggers back on (same 5, guarded).
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

-- E8 — 0-count allocations per root centre (same unplanned/surplus marker as WATER).
INSERT INTO public.centre_allocations (schedule_id, department_id, centre, max_count)
SELECT k.sched, k.target, public.get_root_centre(d.centre), 0
  FROM public.deployments d
 CROSS JOIN (SELECT (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026)))) AS sched,
                    (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI') AS target) k
 WHERE d.schedule_id = k.sched
   AND d.department_id = k.target
 GROUP BY k.sched, k.target, public.get_root_centre(d.centre)
ON CONFLICT DO NOTHING;
-- EXPECTED: INSERT 0 <distinct root-centre count, up to 8>.

-- E9 — REMOVED (owner decision): no incharge grants from this script.
-- Incharges for SEWA SAMITI are added later from the Users / Centre Lists UI.

COMMIT;


-- ================= §F — SET 2 VERIFICATION (read-only; run after COMMIT) =================

-- F1 — the 29 with new effective dept (expect requested=SEWA SAMITI for all).
SELECT l.badge_number,
       d.centre,
       rd.name AS requested,
       fd.name AS final,
       COALESCE(fd.name, rd.name) AS effective,
       d.status
  FROM public.sewasamiti_move_list_oct2026 l
  JOIN public.deployments d
    ON d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.badge_number = l.badge_number
  LEFT JOIN public.deployment_departments rd ON rd.id = d.department_id
  LEFT JOIN public.deployment_departments fd ON fd.id = d.deployed_department_id
 ORDER BY l.badge_number;

-- F2 — per-centre SEWA SAMITI counts
-- EXPECTED: NIT - 2 7, TAORU 5, SURAJ KUND 5, GREATER FARIDABAD 4,
-- ANKHEER 3, SECTOR-15-A 2, SIHA 2, DLF CITY GURGAON 1.
SELECT d.centre, count(*) AS sewasamiti_count
  FROM public.deployments d
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND d.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')
 GROUP BY d.centre
 ORDER BY sewasamiti_count DESC, d.centre;

-- F3 — old depts released (counts should have DROPPED by: SECURITY 6, PANDAL 6,
-- HORTICULTURE 5, SANITATION 5, PATHI 2, WATER/MEDICAL/B.A.V./BAAL SATSANG/
-- SATSANG KARTA 1 each).
SELECT dd.name, count(*) AS remaining
  FROM public.deployments d
  JOIN public.deployment_departments dd ON dd.id = d.department_id
 WHERE d.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND dd.name IN ('SECURITY','PANDAL','HORTICULTURE','SANITATION','PATHI',
                   'WATER','MEDICAL','B.A.V.','BAAL SATSANG','SATSANG KARTA')
 GROUP BY dd.name
 ORDER BY remaining DESC, dd.name;

-- F4 — the 0-count allocations (expect one row per root centre, all 0).
SELECT a.centre, a.max_count
  FROM public.centre_allocations a
 WHERE a.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))))
   AND a.department_id = (SELECT id FROM public.deployment_departments WHERE name = 'SEWA SAMITI')
 ORDER BY a.centre;

-- F5 — REMOVED with E9 (grants live in the UI now; nothing to verify here).

-- F6 — triggers ALL back on (EVERY row must read ENABLED).
SELECT tgname,
       CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tgenabled::text END AS state
  FROM pg_trigger
 WHERE tgrelid = 'public.deployments'::regclass
   AND NOT tgisinternal
 ORDER BY tgname;

-- F7 — backup intact (expect 29).
SELECT count(*) AS backup_rows
  FROM public.sewasamiti_move_backup_oct2026
 WHERE schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))));


-- ================= §G — SET 2 ROLLBACK (COMMENTED OUT; run ONLY to undo §E) =================
-- Restores department_id + deployed_department_id from the §E snapshot.
-- Re-run F1 afterwards: requested/final must read the OLD departments again.
-- NOTE: this does NOT remove the 0-count allocations, the SEWA SAMITI
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
--   FROM public.sewasamiti_move_backup_oct2026 b
--  WHERE d.schedule_id = b.schedule_id
--    AND d.badge_number = b.badge_number
--    AND b.schedule_id = (SELECT id FROM public.deployment_schedules WHERE lower(btrim(name)) = lower(btrim((SELECT schedule_name FROM public.water_move_cfg_oct2026))));
-- -- EXPECTED: UPDATE 29.
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

-- ================= NOTES (SET 2) =================
-- N5 (initiated): 4 badges in SET 2 are is_initiated=False (FB6008LA0112,
--   FB6008LA0194, FB5977LA0017, FB6002LA0068). The §E move runs triggerless so
--   it is unaffected; but if the SEWA SAMITI dept row already exists with
--   requires_initiated=true, later non-admin writes touching those 4 rows
--   would re-validate and reject. Check P11 vs P12 and ask the ASO whether
--   those 4 should stay uninitiated under SEWA SAMITI.
-- N6 (allocations): SET 2 mirrors SET 1 — 0-count allocations per root centre
--   (unplanned/surplus marker, hidden from ConsentPage pickers) with the same
--   centre-lock trade-off as N1. If SEWA SAMITI was actually PLANNED with a
--   real quota, do NOT run E8; instead set the true max_count per centre via
--   the Allocation page and delete the 0-rows E8 would create.
-- N7 (re-runs): §0c/§E-upsert/E4/E8 are ON CONFLICT DO NOTHING (first run
--   wins); E1/E6 abort loudly instead of half-applying. Safe to re-run.
