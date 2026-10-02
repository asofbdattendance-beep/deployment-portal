-- ============================================================
-- V60: VISIT WINDOW ON THE SCHEDULE + DATE-SPLIT HELPERS.
-- Run AFTER v59.
--
-- Why: the portal never stored which dates a 5-day visit spans — the
-- window lived only as a hardcoded client constant. The Previsit /
-- Bhati Visit mode needs one source of truth in the DB: "before those
-- days" and "when bhati visit dates are not there" are unknowable
-- without it.
--
-- Rule (product decision, locked in planning):
--   - A scan dated inside [visit_start_date, visit_end_date] = Bhati Visit.
--   - A scan dated outside it = Previsit sewa. A sewa never falls on a
--     visit date, so the date IS the class — the mode never writes a
--     label, and nothing in dp_attendance_sessions is renamed or moved.
--   - A schedule with NO window set ⇒ every date reads as previsit
--     ("when bhati visit dates are not there, use the previsit only").
--     When the ASO sets the window later, history reclassifies itself
--     because every consumer derives the class from (window, date).
--
-- NOT TOUCHED: no table renamed; no column renamed or dropped; no RLS
-- policy, trigger, index, or attendance RPC redefined here (v61/v62 do
-- the reporting side). Backfill touches only rows still NULL.
--
-- Non-destructive; safe to re-run (IF NOT EXISTS; CREATE OR REPLACE;
-- guarded UPDATE; INSERT ... ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- §1. The window columns. Nullable by design: a schedule without
-- dates is a valid "previsit-only" schedule.
-- ------------------------------------------------------------
ALTER TABLE public.deployment_schedules
  ADD COLUMN IF NOT EXISTS visit_start_date date;
ALTER TABLE public.deployment_schedules
  ADD COLUMN IF NOT EXISTS visit_end_date date;

-- ------------------------------------------------------------
-- §2. Backfill the current visit only (guarded: NULL rows matching
-- the October 2026 visit name). Every other schedule keeps NULL and
-- therefore reads as previsit-only until the ASO sets its window.
-- ------------------------------------------------------------
UPDATE public.deployment_schedules
   SET visit_start_date = DATE '2026-10-07',
       visit_end_date   = DATE '2026-10-11'
 WHERE visit_start_date IS NULL
   AND visit_end_date IS NULL
   AND lower(name) = lower('October 2026 Visit');

-- ------------------------------------------------------------
-- §3. schedule_visit_dates: the ordered inclusive date list for a
-- schedule. '{}' when no usable window (NULL side or end < start) —
-- callers therefore read NULL-window schedules as previsit-only.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_visit_dates(p_schedule uuid)
RETURNS date[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT ARRAY(
       SELECT (g::date)
         FROM public.deployment_schedules s,
              LATERAL generate_series(s.visit_start_date, s.visit_end_date, interval '1 day') AS g
        WHERE s.id = p_schedule
          AND s.visit_start_date IS NOT NULL
          AND s.visit_end_date IS NOT NULL
          AND s.visit_end_date >= s.visit_start_date
     )),
    '{}'
  );
$$;

REVOKE ALL ON FUNCTION public.schedule_visit_dates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_visit_dates(uuid) TO authenticated;

-- ------------------------------------------------------------
-- §4. is_visit_date: the single choke point both sides use.
-- TRUE  → the date is a Bhati Visit day for this schedule.
-- FALSE → previsit (including: NULL window, NULL args, end < start).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_visit_date(p_schedule uuid, p_date date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_schedule IS NOT NULL
     AND p_date IS NOT NULL
     AND public.schedule_visit_dates(p_schedule) @> ARRAY[p_date];
$$;

REVOKE ALL ON FUNCTION public.is_visit_date(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_visit_date(uuid, date) TO authenticated;

-- ------------------------------------------------------------
-- §5. Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v60')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- 1. Columns exist and are nullable dates:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'deployment_schedules'
--      AND column_name IN ('visit_start_date', 'visit_end_date');
--   -- Expect: two rows, data_type 'date', is_nullable 'YES'.
-- 2. Backfill applied to the October visit only:
--   SELECT name, visit_start_date, visit_end_date
--     FROM public.deployment_schedules;
--   -- Expect: 'October 2026 Visit' reads 2026-10-07 .. 2026-10-11;
--   -- every other schedule NULL/NULL.
-- 3. Window returns the five dates in order:
--   SELECT public.schedule_visit_dates(id) FROM public.deployment_schedules
--    WHERE lower(name) = lower('October 2026 Visit');
--   -- Expect: {2026-10-07,2026-10-08,2026-10-09,2026-10-10,2026-10-11}.
-- 4. The split rule:
--   SELECT public.is_visit_date(id, DATE '2026-10-08') AS in_window,
--          public.is_visit_date(id, DATE '2026-10-06') AS previsit,
--          public.is_visit_date(id, DATE '2026-10-12') AS previsit_after
--     FROM public.deployment_schedules
--    WHERE lower(name) = lower('October 2026 Visit');
--   -- Expect: true, false, false.
-- 5. NULL window reads as previsit-only (fail toward previsit, never visit):
--   SELECT public.schedule_visit_dates('00000000-0000-0000-0000-000000000000') AS empty_window,
--          public.is_visit_date('00000000-0000-0000-0000-000000000000', CURRENT_DATE) AS not_visit,
--          public.is_visit_date(NULL, CURRENT_DATE) AS null_schedule,
--          public.is_visit_date('00000000-0000-0000-0000-000000000000', NULL) AS null_date;
--   -- Expect: '{}', false, false, false.
-- 6. Registry:
--   SELECT version FROM public.portal_version WHERE version = 'v60';
--   -- Expect: one row.
