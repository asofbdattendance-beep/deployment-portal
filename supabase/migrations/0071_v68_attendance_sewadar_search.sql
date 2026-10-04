-- ============================================================
-- V68: SEWADAR SEARCH FOR THE ASO SCANNER PICKER
-- (attendance_search_sewadars).
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- ASO / super_admin can now open the Scanner page, but a scanner only
-- helps when the sewadar is standing in front of you with a badge. The
-- picker ("mark attendance for anyone") needs a searchable directory:
-- type a name, badge fragment or centre and get the top matches with
-- identity + deployment + open-session state, so Mark IN/OUT can start
-- without a physical scan.
--
-- No existing RPC answers that question. get_sewadar_by_badge (v28) is
-- exact-badge only; the scanner directory (client cache) covers deployed
-- badges only and is subtree-RLS shaped, so it cannot serve "anyone".
-- This function searches BOTH rosters (dp_sewadars + vss_sewadars, the
-- same union get_sewadar_by_badge reads) server-side, applies the
-- standard attendance scope, and returns everything the picker and the
-- scan popup need in one round trip.
--
-- SCOPE / SAFETY
-- ------------------------------------------------------------
-- - Role gate: the four scan roles only
--   (dept_incharge/scanner/aso/super_admin), NULL-safe (v56 pattern).
--   A NULL role is denied, not admitted.
-- - Centre scope: attendance_sewadar_centre_visible(home centre) — the
--   same predicate the att_read/att_update RLS policies enforce, so the
--   picker can never name a sewadar the caller may not scan. ASO and
--   super_admin see all; centre/dept roles see their own scope.
-- - Empty/blank query returns zero rows (never a roster dump).
-- - LIKE metacharacters (\, %, _) in the query are escaped — the box is
--   a literal contains-match, not a pattern.
-- - Exact-prefix matches rank first (badge, then name), then
--   alphabetical — deterministic, LIMIT-clamped (1..50, default 25).
-- - deployed = a deployments row exists for this schedule (requested OR
--   final — the picker does not care which); open_now = an OPEN session
--   exists for this schedule (tells the picker whether IN or OUT comes
--   next). dept_name resolves through attendance_badge_dept (v59 law:
--   effective dept, else latest scan snapshot) so prompt and record agree.
--
-- This is a PURE function addition: no table, column, index, trigger,
-- RLS policy or other function is created, altered or dropped.
-- Non-destructive; safe to re-run. Apply AFTER v59 (uses
-- attendance_badge_dept + attendance_sewadar_centre_visible).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.attendance_search_sewadars(
  p_schedule uuid,
  p_query    text    DEFAULT NULL,
  p_limit    integer DEFAULT 25
)
RETURNS TABLE(
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  dept_name      text,
  is_vss         boolean,
  deployed       boolean,
  open_now       boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_q    text;
  v_lim  integer;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to search sewadars';
  END IF;

  IF p_schedule IS NULL THEN RETURN; END IF;

  v_q := NULLIF(btrim(COALESCE(p_query, '')), '');
  IF v_q IS NULL THEN RETURN; END IF;

  -- Literal contains-match: escape LIKE metacharacters first.
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  v_lim := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 50);

  RETURN QUERY
  WITH roster AS (
    SELECT s.badge_number, s.sewadar_name, s.centre AS sewadar_centre, false AS is_vss
      FROM public.dp_sewadars s
    UNION
    SELECT v.badge_number, v.sewadar_name, v.centre AS sewadar_centre, true AS is_vss
      FROM public.vss_sewadars v
  ),
  matched AS (
    SELECT r.badge_number, r.sewadar_name, r.sewadar_centre, r.is_vss
      FROM roster r
     WHERE (r.badge_number ILIKE '%' || v_q || '%' ESCAPE '\'
         OR r.sewadar_name ILIKE '%' || v_q || '%' ESCAPE '\'
         OR r.sewadar_centre ILIKE '%' || v_q || '%' ESCAPE '\')
       AND public.attendance_sewadar_centre_visible(r.sewadar_centre)
     ORDER BY CASE WHEN r.badge_number ILIKE v_q || '%' ESCAPE '\' THEN 0
                   WHEN r.sewadar_name ILIKE v_q || '%' ESCAPE '\' THEN 1
                   ELSE 2 END,
              r.sewadar_name, r.badge_number
     LIMIT v_lim
  ),
  ranked AS (
    SELECT m.*,
           row_number() OVER (PARTITION BY m.badge_number ORDER BY m.is_vss ASC) AS rn
      FROM matched m
  )
  SELECT r.badge_number,
         r.sewadar_name,
         r.sewadar_centre,
         dd.name AS dept_name,
         r.is_vss,
         EXISTS (SELECT 1 FROM public.deployments dep
                  WHERE dep.schedule_id = p_schedule
                    AND dep.badge_number = r.badge_number) AS deployed,
         EXISTS (SELECT 1 FROM public.dp_attendance_sessions o
                  WHERE o.schedule_id = p_schedule
                    AND o.badge_number = r.badge_number
                    AND o.status = 'OPEN') AS open_now
    FROM ranked r
    LEFT JOIN public.deployment_departments dd
      ON dd.id = public.attendance_badge_dept(r.badge_number, p_schedule)
   WHERE r.rn = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_search_sewadars(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_search_sewadars(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_search_sewadars(uuid, text, integer) TO authenticated;

-- ------------------------------------------------------------
-- Version registry: this app build starts calling
-- attendance_search_sewadars, so the floor moves to v68. Without it the
-- picker gets PGRST202 — the client degrades to an explicit error, and
-- the DbVersionBanner keeps saying the DB needs v68+.
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v68')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run as an authenticated scanner/aso).
-- ============================================================
--
-- 1. Exactly one overload. Expect: 1.
--
-- SELECT count(*) AS overloads
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'attendance_search_sewadars';
--
-- 2. Blank query returns nothing (never a roster dump). Expect: 0 rows.
--
-- SELECT * FROM public.attendance_search_sewadars('<schedule-uuid>', '   ');
--
-- 3. Badge-fragment search ranks the exact prefix first. Expect: the
--    badge itself on top with deployed/open_now flags.
--
-- SELECT badge_number, sewadar_name, sewadar_centre, dept_name, is_vss,
--        deployed, open_now
--   FROM public.attendance_search_sewadars('<schedule-uuid>', '<badge-frag>', 10);
--
-- 4. A role outside the four scan roles is denied. Expect: error
--    'Not authorized to search sewadars'.
--
-- 5. The version registry recorded the migration. Expect: v68.
--
--   SELECT version FROM public.portal_version WHERE version = 'v68';
--
-- 6. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
