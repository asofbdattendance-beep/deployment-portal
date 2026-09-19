-- ============================================================
-- V38b: RESTORE THE ORIGINAL SCHEDULE (centre_allocations.max_count)
--
-- Context: to fit a few extra deployments, 7 allocation rows were raised
-- above the Excel plan and 1 lowered (proven by diffing live max_count
-- against "Schedule Baba Ji's October Visit - 2026.xlsx", Table 1):
--   DLF CITY GURGAON / LUGGAGE        25 -> 27   (restore 25)
--   DLF CITY GURGAON / OLD ENCLOSURE  70 -> 72   (restore 70)
--   FIROZPUR JHIRKA  / MEDICAL         0 -> 1    (restore 0, needs v38c)
--   MOHANA           / LANGAR         20 -> 21   (restore 20)
--   NANGLA GUJRAN    / LANGAR         15 -> 16   (restore 15)
--   SURAJ KUND       / LUGGAGE         0 -> 1    (restore 0, needs v38c)
--   ZAIBABAD KHERLI  / TRAFFIC INSIDE  5 -> 8    (restore 5)
--   BALLABGARH       / MEDICAL         5 -> 4    (restore 5)
-- This file rewrites max_count for the 8 Excel-mapped departments
-- (LANGAR, CANTEEN, OLD ENCLOSURE, SECURITY, TRAFFIC INSIDE, LUGGAGE,
-- SEWA SAMITI, MEDICAL) x 18 root CENTREs from the plan. Rows already
-- equal are untouched (IS DISTINCT FROM guard).
--
-- SCOPE — centre_allocations ONLY:
--   * deployments / sewadar_consents / every other table: UNTOUCHED.
--     All 2,567 deployment rows stay exactly as punched; rows deployed
--     past the restored plan surface as Additional (deployed - scheduled).
--   * TRAFFIC OUTSIDE BHATI, OE ESCORTS, AUDIO / VISUAL: UNTOUCHED
--     (not in the Excel plan).
--   * plan = 0 cells are SKIPPED here (CHECK max_count > 0 forbids 0);
--     the two that exist live (FIROZPUR/MEDICAL, SURAJ KUND/LUGGAGE)
--     are set by v38c AFTER the constraint is relaxed.
--
-- Non-destructive; safe to re-run. Run in any order relative to v38c.
-- ROLLBACK: re-run your previous allocation values from audit_log.
-- ============================================================

WITH plan(centre, dept_name, planned) AS (
VALUES
  ('ANKHEER','LANGAR',10),
  ('ANKHEER','CANTEEN',10),
  ('ANKHEER','OLD ENCLOSURE',10),
  ('ANKHEER','SECURITY',12),
  ('ANKHEER','TRAFFIC INSIDE',20),
  ('ANKHEER','LUGGAGE',15),
  ('ANKHEER','SEWA SAMITI',10),
  ('ANKHEER','MEDICAL',5),
  ('BALLABGARH','LANGAR',5),
  ('BALLABGARH','CANTEEN',10),
  ('BALLABGARH','OLD ENCLOSURE',30),
  ('BALLABGARH','SECURITY',15),
  ('BALLABGARH','TRAFFIC INSIDE',10),
  ('BALLABGARH','LUGGAGE',10),
  ('BALLABGARH','SEWA SAMITI',10),
  ('BALLABGARH','MEDICAL',5),
  ('BAROLI','LANGAR',20),
  ('BAROLI','SECURITY',3),
  ('BAROLI','MEDICAL',5),
  ('DLF CITY GURGAON','LANGAR',20),
  ('DLF CITY GURGAON','CANTEEN',30),
  ('DLF CITY GURGAON','OLD ENCLOSURE',70),
  ('DLF CITY GURGAON','SECURITY',25),
  ('DLF CITY GURGAON','TRAFFIC INSIDE',25),
  ('DLF CITY GURGAON','LUGGAGE',25),
  ('DLF CITY GURGAON','SEWA SAMITI',25),
  ('DLF CITY GURGAON','MEDICAL',10),
  ('FIROZPUR JHIRKA','LANGAR',15),
  ('FIROZPUR JHIRKA','SEWA SAMITI',6),
  ('GURGAON','LANGAR',35),
  ('GURGAON','CANTEEN',45),
  ('GURGAON','OLD ENCLOSURE',135),
  ('GURGAON','SECURITY',50),
  ('GURGAON','TRAFFIC INSIDE',40),
  ('GURGAON','LUGGAGE',30),
  ('GURGAON','SEWA SAMITI',25),
  ('GURGAON','MEDICAL',5),
  ('HODAL','LANGAR',15),
  ('HODAL','TRAFFIC INSIDE',10),
  ('HODAL','SEWA SAMITI',2),
  ('MOHANA','LANGAR',20),
  ('MOHANA','SECURITY',5),
  ('MOHANA','TRAFFIC INSIDE',15),
  ('NANGLA GUJRAN','LANGAR',15),
  ('NANGLA GUJRAN','CANTEEN',10),
  ('NANGLA GUJRAN','OLD ENCLOSURE',20),
  ('NANGLA GUJRAN','SECURITY',20),
  ('NANGLA GUJRAN','TRAFFIC INSIDE',15),
  ('NANGLA GUJRAN','LUGGAGE',15),
  ('NANGLA GUJRAN','SEWA SAMITI',5),
  ('NIT - 2','LANGAR',15),
  ('NIT - 2','CANTEEN',15),
  ('NIT - 2','OLD ENCLOSURE',80),
  ('NIT - 2','SECURITY',10),
  ('NIT - 2','LUGGAGE',15),
  ('NIT - 2','SEWA SAMITI',38),
  ('NIT - 2','MEDICAL',10),
  ('PALWAL','LANGAR',60),
  ('PALWAL','CANTEEN',55),
  ('PALWAL','OLD ENCLOSURE',60),
  ('PALWAL','SECURITY',15),
  ('PALWAL','TRAFFIC INSIDE',15),
  ('PALWAL','LUGGAGE',15),
  ('PALWAL','SEWA SAMITI',5),
  ('PALWAL','MEDICAL',5),
  ('PRITHLA','CANTEEN',20),
  ('PRITHLA','SEWA SAMITI',5),
  ('RAJENDRA PARK','LANGAR',10),
  ('RAJENDRA PARK','CANTEEN',15),
  ('RAJENDRA PARK','OLD ENCLOSURE',25),
  ('RAJENDRA PARK','SECURITY',5),
  ('RAJENDRA PARK','TRAFFIC INSIDE',5),
  ('RAJENDRA PARK','SEWA SAMITI',10),
  ('SECTOR-15-A','LANGAR',15),
  ('SECTOR-15-A','CANTEEN',15),
  ('SECTOR-15-A','OLD ENCLOSURE',75),
  ('SECTOR-15-A','SECURITY',25),
  ('SECTOR-15-A','TRAFFIC INSIDE',40),
  ('SECTOR-15-A','LUGGAGE',25),
  ('SECTOR-15-A','SEWA SAMITI',30),
  ('SECTOR-15-A','MEDICAL',15),
  ('SURAJ KUND','LANGAR',25),
  ('SURAJ KUND','CANTEEN',25),
  ('SURAJ KUND','OLD ENCLOSURE',30),
  ('SURAJ KUND','SECURITY',10),
  ('SURAJ KUND','TRAFFIC INSIDE',35),
  ('SURAJ KUND','SEWA SAMITI',29),
  ('SURAJ KUND','MEDICAL',10),
  ('TAORU','LANGAR',10),
  ('TAORU','SECURITY',5),
  ('TAORU','MEDICAL',10),
  ('TIGAON','OLD ENCLOSURE',15),
  ('TIGAON','TRAFFIC INSIDE',15),
  ('TIGAON','SEWA SAMITI',25),
  ('ZAIBABAD KHERLI','LANGAR',10),
  ('ZAIBABAD KHERLI','TRAFFIC INSIDE',5)
)
INSERT INTO public.centre_allocations (schedule_id, department_id, centre, max_count)
SELECT 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'::uuid, d.id, p.centre, p.planned
  FROM plan p
  JOIN public.deployment_departments d ON d.name = p.dept_name
ON CONFLICT (schedule_id, department_id, centre)
DO UPDATE SET max_count = EXCLUDED.max_count
WHERE public.centre_allocations.max_count IS DISTINCT FROM EXCLUDED.max_count;

-- ------------------------------------------------------------
-- Verification (expect the listed results)
-- ------------------------------------------------------------
-- 1. Nothing differs from the plan anymore (mapped depts):
--    WITH plan(centre, dept_name, planned) AS (VALUES /* same 96 rows */)
--    SELECT a.centre, d.name, a.max_count AS live, p.planned
--      FROM public.centre_allocations a
--      JOIN public.deployment_departments d ON d.id = a.department_id
--      JOIN plan p ON p.centre = a.centre AND p.dept_name = d.name
--     WHERE a.schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
--       AND a.max_count IS DISTINCT FROM p.planned;
--      → 2 rows (FIROZPUR JHIRKA / MEDICAL, SURAJ KUND / LUGGAGE)
--      until v38c is applied, else 0 rows
--      NOTE: the two plan=0 rows are handled by v38c, not here.
-- 2. Deployments untouched:
--    SELECT count(*) FROM public.deployments
--     WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53';
--      → 2567
