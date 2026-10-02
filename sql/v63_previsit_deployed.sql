-- ============================================================
-- V63: PREVISIT TOTAL LIST. Run AFTER v62.
--
-- The previsit Reports tab shows Total + Present tabs (never Absent):
-- Total is the deployed strength in the caller's scope, Present is who
-- scanned on the selected sewa day. previsit_sewadars (v62) only returns
-- scanned sessions, so Total needs its own read: one row per deployed
-- badge — badge/name/home-centre/effective-department/VSS flag.
--
-- Scope: the v39/v51 helpers verbatim (scope-then-dept early returns),
-- so a dept_incharge sees their departments' strength across every
-- centre, aso/super_admin see all, everyone else gets zero rows.
--
-- Names: deployments.sewadar_name first (the app writes it on every
-- persist), dp_sewadars / vss_sewadars as fallback — older deployment
-- rows can carry a NULL name, and Total must never print a blank row it
-- could have named. VSS flag from the VSS roster (no sessions here).
--
-- Grants: REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated
-- (new function, v53/v55/v60/v62 pattern). No new indexes: the
-- schedule_id + effective-dept predicates ride
-- idx_deployments_effective_dept (v53) and the roster probes ride the
-- badge PKs.
--
-- NOT TOUCHED: scan ladder, visit RPCs, previsit RPCs, RLS policies,
-- tables, columns, triggers, indexes, existing data.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- INSERT ... ON CONFLICT DO NOTHING).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.previsit_deployed(p_schedule uuid)
RETURNS TABLE(
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  department_id  uuid,
  dept_name      text,
  is_vss         boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- Centre roles and every other non-previsit role fail closed HERE, not
  -- in the client: attendance_scope_centres hands them a subtree, but the
  -- previsit surface is dept_incharge / aso / super_admin only (product
  -- decision, v62). v_admin and the dept gate below already encode that —
  -- v_depts IS NULL for admins, non-NULL for dept_incharge, and every
  -- other role resolves v_depts NULL with v_admin false, so the
  -- centre-arm predicate below would admit them. The explicit role gate
  -- keeps them out.
  IF NOT v_admin AND v_depts IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.sewadar_name, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    -- One badge, one centre (v59 (f) grain).
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  names AS (
    SELECT be.badge_number,
           COALESCE(max(sd.sewadar_name),
                    max(s.sewadar_name),
                    max(vs.sewadar_name),
                    '') AS nm,
           bool_or(vs.badge_number IS NOT NULL) AS vss
      FROM badge_eff be
      LEFT JOIN scoped_dep sd ON sd.badge_number = be.badge_number
      LEFT JOIN public.dp_sewadars s ON s.badge_number = be.badge_number
      LEFT JOIN public.vss_sewadars vs ON vs.badge_number = be.badge_number
     GROUP BY be.badge_number
  )
  SELECT be.badge_number, n.nm, be.dc, be.eff, dd.name,
         n.vss
    FROM badge_eff be
    JOIN names n ON n.badge_number = be.badge_number
    LEFT JOIN public.deployment_departments dd ON dd.id = be.eff
   ORDER BY be.dc, n.nm NULLS LAST, be.badge_number;
END;
$$;

REVOKE ALL ON FUNCTION public.previsit_deployed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.previsit_deployed(uuid) TO authenticated;

-- ------------------------------------------------------------
-- §2. Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v63')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- 1. Total lists the deployed strength in scope:
--   SELECT count(*) FROM public.previsit_deployed('<sched>');
--   -- Expect: the deployed count (matches the visit expectation set).
-- 2. Fail-closed roles get zero rows (set claims per role first):
--   SELECT count(*) FROM public.previsit_deployed('<sched>');
--   -- Expect: own-department rows as dept_incharge; 0 as centre_user,
--   -- centre_admin, scanner, vss_operator.
-- 3. Registry:
--   SELECT version FROM public.portal_version WHERE version = 'v63';
--   -- Expect: one row.
