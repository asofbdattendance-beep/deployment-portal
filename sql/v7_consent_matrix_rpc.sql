-- ============================================================
-- V7: PARENT-CENTRE MATRIX RPCs (server-side aggregation)
-- Two efficient RPCs that aggregate in Postgres instead of the
-- frontend pulling every sewadar/consent/deployment row:
--   1) get_parent_consent_matrix(p_schedule)  → per parent centre:
--        total badges, consented, initiated, non-initiated, staying
--   2) get_parent_department_matrix(p_schedule) → per parent centre
--        + department: number of consented sewadars who requested it
-- IDEMPOTENT — safe to re-run. Run AFTER v6_vss_roster.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Consent matrix
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_parent_consent_matrix(p_schedule uuid)
RETURNS TABLE (
  parent_centre text,
  total_badges bigint,
  consented bigint,
  initiated bigint,
  non_initiated bigint,
  staying bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.get_portal_user_role() NOT IN ('aso', 'super_admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE sub(parent_centre, centre) AS (
    SELECT c.name, c.name
    FROM public.centres c
    WHERE COALESCE(c.parent_centre, '') = ''
    UNION ALL
    SELECT sub.parent_centre, c.name
    FROM public.centres c
    JOIN sub ON c.parent_centre = sub.centre
  )
  SELECT
    sub.parent_centre,
    count(s.badge_number) AS total_badges,
    count(s.badge_number) FILTER (WHERE con.consent_given) AS consented,
    count(s.badge_number) FILTER (WHERE con.consent_given AND s.is_initiated) AS initiated,
    count(s.badge_number) FILTER (WHERE con.consent_given AND NOT s.is_initiated) AS non_initiated,
    count(s.badge_number) FILTER (WHERE con.consent_given AND con.stay_at_bhati) AS staying
  FROM sub
  LEFT JOIN public.sewadars s
    ON s.centre = sub.centre AND COALESCE(s.badge_status, '') <> 'ELDERLY'
  LEFT JOIN public.sewadar_consents con
    ON con.centre = s.centre
   AND con.badge_number = s.badge_number
   AND con.schedule_id = p_schedule
  GROUP BY sub.parent_centre
  ORDER BY sub.parent_centre;
END;
$$;

-- ------------------------------------------------------------
-- 2. Department matrix
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_parent_department_matrix(p_schedule uuid)
RETURNS TABLE (
  parent_centre text,
  department_id uuid,
  department_name text,
  cnt bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.get_portal_user_role() NOT IN ('aso', 'super_admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    public.get_root_centre(d.centre) AS parent_centre,
    d.department_id,
    dep.name AS department_name,
    count(*) AS cnt
  FROM public.deployments d
  JOIN public.deployment_departments dep ON dep.id = d.department_id
  WHERE d.schedule_id = p_schedule
  GROUP BY public.get_root_centre(d.centre), d.department_id, dep.name
  ORDER BY 1, 3;
END;
$$;
