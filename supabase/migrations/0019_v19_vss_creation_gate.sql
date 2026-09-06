-- ============================================================
-- V19: VSS CREATION GATE + DEADLINE SYNC
-- ============================================================
-- Three rules, all enforced in the DB (the UI mirrors them):
--
--   1) ADD GATE — centres cannot create VSS registrations until the
--      ASO opens the new "Add VSS" master switch
--      (portal_settings.vss_creation_open, default CLOSED).
--   2) DEADLINE SYNC — once every open schedule's deadline has passed
--      (or a schedule is done with no other open schedule), centre-role
--      INSERT/UPDATE/DELETE on vss_registrations is blocked. A NULL
--      deadline never blocks (deadline optional, same as consents).
--   3) ASO/SUPER_ADMIN EXEMPT from both gates (same pattern as
--      block_after_deadline / check_deployment).
--
-- VSFB immutability is NOT re-done here — v9 RLS already stops centre
-- roles from touching registrations with status = 'assigned', and the
-- v4 policy keeps vss_sewadars (roster) writes super_admin-only.
--
-- Non-destructive; safe to re-run.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. New master switch: Add VSS (default closed)
-- ------------------------------------------------------------
ALTER TABLE public.portal_settings
  ADD COLUMN IF NOT EXISTS vss_creation_open boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.get_vss_creation_open()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT vss_creation_open FROM public.portal_settings WHERE id = 1;
$$;

-- ------------------------------------------------------------
-- 2. Creation window: any open schedule still inside its deadline?
--    NULL deadline = no time limit. status='done' schedules don't
--    count as open windows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vss_creation_window_open()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deployment_schedules
    WHERE status = 'open'
      AND (deadline IS NULL OR deadline > now())
  );
$$;

-- ------------------------------------------------------------
-- 3. Write guard on vss_registrations
--    Runs BEFORE the temp-ID/age triggers (trg_a_ prefix sorts
--    first) so rejected inserts don't burn sequence numbers.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_vss_registration_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT public.get_vss_creation_open() THEN
      RAISE EXCEPTION 'Adding VSS is currently closed by the ASO';
    END IF;
    IF NOT public.vss_creation_window_open() THEN
      RAISE EXCEPTION 'The deadline has passed — adding VSS is disabled';
    END IF;
  ELSE  -- UPDATE / DELETE
    IF NOT public.vss_creation_window_open() THEN
      RAISE EXCEPTION 'The deadline has passed — VSS registrations can no longer be changed';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_a_guard_vss_registration ON public.vss_registrations;
CREATE TRIGGER trg_a_guard_vss_registration
  BEFORE INSERT OR UPDATE OR DELETE ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.guard_vss_registration_write();

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- -- Switch exists and defaults to closed:
-- SELECT id, sewadar_deployment_open, vss_deployment_open, vss_creation_open
-- FROM public.portal_settings;
--
-- -- Window helper reflects your schedules:
-- SELECT id, name, status, deadline FROM public.deployment_schedules ORDER BY created_at DESC;
-- SELECT public.vss_creation_window_open();
--
-- -- Guard trigger present:
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.vss_registrations'::regclass AND NOT tgisinternal;
