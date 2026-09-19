-- ============================================================
-- V38c: ALLOW plan = 0 (scheduled-zero allocations)
--
-- The Excel plan gives two centre×department cells a scheduled count of
-- 0, but centre_allocations carries CHECK (max_count > 0), so "scheduled
-- 0" cannot be stored. Relax the check to >= 0 and set those two rows
-- to 0. They then read as "scheduled 0 · additional 1" instead of
-- pretending the plan was 1. The app already filters max_count > 0 out
-- of quota cards/dropdowns, and get_dept_quota_remaining() treats 0 as
-- exhausted — no app change needed for correctness.
--
-- SCOPE: constraint + 2 rows. deployments / everything else UNTOUCHED.
-- Non-destructive; safe to re-run. Run BEFORE or AFTER v38b.
-- ROLLBACK: re-run the two UPDATEs below with the old values (1, 1).
-- ============================================================

ALTER TABLE public.centre_allocations DROP CONSTRAINT IF EXISTS centre_allocations_max_count_check;
ALTER TABLE public.centre_allocations ADD CONSTRAINT centre_allocations_max_count_check CHECK (max_count >= 0);

UPDATE public.centre_allocations a
   SET max_count = 0
  FROM public.deployment_departments d
 WHERE a.schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND a.department_id = d.id
   AND (
     (a.centre = 'FIROZPUR JHIRKA' AND d.name = 'MEDICAL')
     OR
     (a.centre = 'SURAJ KUND' AND d.name = 'LUGGAGE')
   )
   AND a.max_count IS DISTINCT FROM 0;

-- ------------------------------------------------------------
-- Verification (expect the listed results)
-- ------------------------------------------------------------
-- 1. Constraint allows zero:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'public.centre_allocations'::regclass
--       AND conname = 'centre_allocations_max_count_check';
--      → CHECK ((max_count >= 0))
-- 2. The two rows read 0:
--    SELECT a.centre, d.name, a.max_count
--      FROM public.centre_allocations a
--      JOIN public.deployment_departments d ON d.id = a.department_id
--     WHERE a.schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
--       AND ((a.centre = 'FIROZPUR JHIRKA' AND d.name = 'MEDICAL')
--         OR (a.centre = 'SURAJ KUND' AND d.name = 'LUGGAGE'));
--      → 0, 0
