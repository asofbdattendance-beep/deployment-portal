-- ============================================================
-- V31: HARD VSS GLOBAL CLOSE — global is the master
-- ============================================================
-- User requirement: "I want to disable everything in VSS until its open"
-- Before this, a per-centre tri-state `true` (`centre_vss_overrides`)
-- could reopen VSS even after the super_admin globally closed
-- `portal_settings.vss_deployment_open` / `vss_creation_open`.
-- Soft gate was `COALESCE(override, global)` — a `true` override
-- stayed true after global closed.
--
-- Hard gate (this file): global must be true AND
-- (override ?? default). A `true` override can only keep the
-- global value, never resurrect it after it is closed.
--
--   deployment: global && COALESCE(override, true)
--     - global false => false always (hard closed)
--     - global true, override true => true
--     - global true, override false => false (force closed)
--     - global true, override null => true (inherit)
--
--   creation: global && COALESCE(override, window)
--     - global false => false always
--     - global true, override true => true (bypass window)
--     - global true, override false => false
--     - global true, override null => window
--
-- Non-destructive; safe to re-run. Run AFTER v30.
-- ============================================================

-- Effective VSS CREATION gate — hard global
CREATE OR REPLACE FUNCTION public.vss_creation_open_for_centre(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.get_vss_creation_open()
         AND COALESCE(
               public.centre_vss_creation_override(p_centre),
               public.vss_creation_window_open()
             );
$$;

-- Effective VSS DEPLOYMENT gate — hard global
CREATE OR REPLACE FUNCTION public.vss_deploy_open_for_centre(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.get_vss_deployment_open()
         AND COALESCE(
               (SELECT o.deployment_open
                FROM public.centre_vss_overrides o
                WHERE o.centre IN (public.get_root_centre(p_centre), '*')
                ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END
                LIMIT 1),
               true
             );
$$;

-- get_my_effective_gates already calls the two helpers above, so it
-- automatically reflects the hard gate — no change needed there.
-- Verify after running:
--   SELECT public.get_vss_deployment_open(), public.vss_deploy_open_for_centre('GURGAON');
--   SELECT public.get_vss_creation_open(), public.vss_creation_window_open(), public.vss_creation_open_for_centre('GURGAON');
--   -- With global false, both should be false even if centre_vss_overrides has true
--   -- With global true and override false, should be false (force closed)
