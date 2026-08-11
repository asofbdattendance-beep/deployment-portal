-- ============================================================
-- V10: OE ESCORTS FIXED AT 3 DAYS — DB RULE + DATA BACKFILL
--
-- BUG FIXED: selecting OE ESCORTS set the UI days to 3, but the
-- check_deployment trigger rejected the write with
--   "Sewadar must have at least 5 consent days for this department"
-- because deployment_departments.min_days for OE ESCORTS was still
-- the v2 default of 5. The app rule (fixed 3 days) must be mirrored
-- in the DB rule or the DB trigger will keep rejecting valid writes.
--
-- This migration:
--   1) sets min_days = 3 (and vss_min_days = 3) for every department
--      whose name starts with "OE ESCORTS",
--   2) backfills existing consent rows for sewadars whose requested
--      OR final (deployed) department is OE ESCORTS to 3 days,
--   3) adds a BEFORE-trigger on deployment_departments that FORCES
--      min_days/vss_min_days = 3 whenever a department named OE ESCORTS
--      is inserted or renamed — so a department created LATER through
--      the UI (whose form defaults min_days to 1) can never re-introduce
--      the mismatch,
--   4) adds a BEFORE-trigger on deployments that FORCES the matching
--      consent row to 3 days whenever a row is written with an OE
--      ESCORTS requested/final department — defense in depth, so the
--      rule can never drift again even if a client sends a bad value.
--
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER v9_production_hardening.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Align the department rule with the app rule
-- ------------------------------------------------------------
UPDATE public.deployment_departments
SET min_days = 3, vss_min_days = 3
WHERE name ILIKE 'OE ESCORTS%'
  AND (min_days <> 3 OR vss_min_days <> 3);

-- ------------------------------------------------------------
-- 2. Backfill existing consents to 3 days for OE ESCORTS rows
--    (matches requested OR final department)
-- ------------------------------------------------------------
UPDATE public.sewadar_consents sc
SET available_days_count = 3
WHERE sc.available_days_count IS DISTINCT FROM 3
  AND EXISTS (
    SELECT 1 FROM public.deployments d
    LEFT JOIN public.deployment_departments req ON req.id = d.department_id
    LEFT JOIN public.deployment_departments fin ON fin.id = d.deployed_department_id
    WHERE d.schedule_id = sc.schedule_id
      AND d.centre = sc.centre
      AND d.badge_number = sc.badge_number
      AND (req.name ILIKE 'OE ESCORTS%' OR fin.name ILIKE 'OE ESCORTS%')
  );

-- ------------------------------------------------------------
-- 3. Department guard: any department named OE ESCORTS (created now
--    or in the future, incl. renames) is forced to min_days = 3 and
--    vss_min_days = 3 — the UI form defaults min_days to 1, so without
--    this guard a later-created OE ESCORTS dept would silently re-break
--    the rule.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_oe_escorts_min_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.name ILIKE 'OE ESCORTS%' THEN
    NEW.min_days := 3;
    NEW.vss_min_days := 3;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_oe_escorts_min_days ON public.deployment_departments;
CREATE TRIGGER trg_guard_oe_escorts_min_days
  BEFORE INSERT OR UPDATE ON public.deployment_departments
  FOR EACH ROW EXECUTE FUNCTION public.guard_oe_escorts_min_days();

-- ------------------------------------------------------------
-- 4. Defense-in-depth: force 3 days for OE ESCORTS at write time.
--    BEFORE INSERT OR UPDATE on deployments — whenever the requested
--    or final department is OE ESCORTS, clamp the matching consent
--    row to 3 days in the same statement, so the check_deployment
--    trigger always sees a valid value.
--    NOTE: named trg_a_... so it sorts BEFORE trg_check_deployment
--    (BEFORE triggers fire in alphabetical order of trigger name) —
--    the clamp must run first, then validation sees days = 3.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clamp_oe_escorts_consent_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_oe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.deployment_departments dd
    WHERE dd.id IN (NEW.department_id, NEW.deployed_department_id)
      AND dd.name ILIKE 'OE ESCORTS%'
  ) INTO v_is_oe;

  IF v_is_oe THEN
    UPDATE public.sewadar_consents sc
    SET available_days_count = 3
    WHERE sc.schedule_id = NEW.schedule_id
      AND sc.centre = NEW.centre
      AND sc.badge_number = NEW.badge_number
      AND sc.available_days_count IS DISTINCT FROM 3;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_a_clamp_oe_escorts_days ON public.deployments;
CREATE TRIGGER trg_a_clamp_oe_escorts_days
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.clamp_oe_escorts_consent_days();

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- SELECT id, name, min_days, vss_min_days FROM public.deployment_departments
-- WHERE name ILIKE 'OE ESCORTS%';
--
-- -- Sanity: inserting a brand-new OE ESCORTS dept must auto-set 3 days
-- -- INSERT INTO public.deployment_departments (name, min_days, vss_min_days)
-- -- VALUES ('OE ESCORTS (TEST)', 5, 5)
-- -- RETURNING name, min_days, vss_min_days;
-- -- (expect min_days = 3, vss_min_days = 3; then delete the test row)
--
-- SELECT count(*) AS clamped_rows FROM public.sewadar_consents sc
-- WHERE sc.available_days_count = 3 AND EXISTS (
--   SELECT 1 FROM public.deployments d
--   LEFT JOIN public.deployment_departments req ON req.id = d.department_id
--   LEFT JOIN public.deployment_departments fin ON fin.id = d.deployed_department_id
--   WHERE d.schedule_id = sc.schedule_id AND d.centre = sc.centre
--     AND d.badge_number = sc.badge_number
--     AND (req.name ILIKE 'OE ESCORTS%' OR fin.name ILIKE 'OE ESCORTS%')
-- );
