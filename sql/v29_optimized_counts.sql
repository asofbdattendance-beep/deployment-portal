-- ============================================================
-- V29: DB-OPTIMIZED COUNT RPCS (SELECT COUNT(*) server-side)
-- ============================================================
-- Purpose:
--   Deployment DB has 3597 regular sewadars + 320 VSS, deployments
--   per schedule >1000 (capped before). We paginated fetches via
--   fetchAllRows, but the UI still did `filter(...).length` after
--   full download. These RPCs push counts to Postgres via
--   `SELECT COUNT(*)` / `COUNT(*) FILTER` + GROUP BY root_centre
--   so the client receives only aggregates — zero row transfer for
--   counts, O(1) latency regardless of 3k+ rows.
--
--   Follows v28 rename: tables are dp_centres / dp_sewadars /
--   dp_attendance_sessions (not the old `centres`/`sewadars` names).
--   All functions are SECURITY DEFINER, search_path = '', and
--   respect RLS via portal role where noted.
--
--   Zero-downtime: single transaction, idempotent, no DDL on hot
--   tables beyond CREATE OR REPLACE FUNCTION + IF NOT EXISTS
--   indexes. Safe to re-run. Run in Supabase SQL Editor as
--   postgres in one go. Do NOT overwrite v28 — this is v29.
--
--   Functions:
--     a) get_schedule_counts(p_schedule uuid) -> jsonb
--        Global per-schedule aggregates via COUNT(*).
--     b) get_deployment_matrix_counts(p_schedule uuid)
--        -> TABLE(centre, department_id, department_name,
--                 scheduled int, deployed int, male int, female int, vss int)
--        Grouped by root_centre + effective department, gender/VSS
--        breakdown server-side. Joins dp_sewadars for gender and
--        vss_sewadars for VSS flag.
--     c) get_centre_counts(p_schedule uuid, p_centre text) -> jsonb
--        Per-centre (subtree) stats for ConsentPage header.
--
-- Non-destructive; safe to re-run. Requires Postgres 15+ (same as v28).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Supporting indexes for COUNT(*) paths (idempotent)
--    Existing indexes cover schedule_id/centre individually; these
--    composite covers make the count GROUP BY root_centre + dept
--    and the subtree counts index-only where possible. IF NOT EXISTS
--    so re-runs are no-ops.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deployments_schedule_centre
  ON public.deployments(schedule_id, centre);
CREATE INDEX IF NOT EXISTS idx_deployments_schedule_effective
  ON public.deployments(schedule_id, department_id, deployed_department_id);
CREATE INDEX IF NOT EXISTS idx_consent_schedule_centre
  ON public.sewadar_consents(schedule_id, centre);
CREATE INDEX IF NOT EXISTS idx_consent_schedule_given
  ON public.sewadar_consents(schedule_id, consent_given);
CREATE INDEX IF NOT EXISTS idx_dp_sewadars_centre
  ON public.dp_sewadars(centre);
CREATE INDEX IF NOT EXISTS idx_vss_sewadars_centre
  ON public.vss_sewadars(centre);
CREATE INDEX IF NOT EXISTS idx_centre_alloc_schedule_centre
  ON public.centre_allocations(schedule_id, centre);

-- ------------------------------------------------------------
-- 1. get_schedule_counts(p_schedule uuid) -> jsonb
--    Global per-schedule aggregates, all via SELECT COUNT(*) —
--    no row transfer. SECURITY DEFINER so counts bypass RLS
--    (aggregates, no PII). STABLE, search_path = ''.
--    Keys:
--      total_sewadars   — count(*) from dp_sewadars (all rows,
--                         simple count; eligible filter is UI-side)
--      total_vss        — count(*) from vss_sewadars
--      total_deployments— count(*) from deployments where schedule
--      total_consents   — where consent_given = true
--      total_finalized  — deployed_department_id IS NOT NULL
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_schedule_counts(uuid);

CREATE OR REPLACE FUNCTION public.get_schedule_counts(p_schedule uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total_sewadars bigint;
  v_total_vss bigint;
  v_total_deployments bigint;
  v_total_consents bigint;
  v_total_finalized bigint;
BEGIN
  -- simple counts — no row data shipped to client
  SELECT count(*) INTO v_total_sewadars FROM public.dp_sewadars;
  SELECT count(*) INTO v_total_vss FROM public.vss_sewadars;

  IF p_schedule IS NULL THEN
    SELECT count(*) INTO v_total_deployments FROM public.deployments;
    SELECT count(*) INTO v_total_consents FROM public.sewadar_consents WHERE consent_given = true;
    SELECT count(*) INTO v_total_finalized FROM public.deployments WHERE deployed_department_id IS NOT NULL;
  ELSE
    SELECT count(*) INTO v_total_deployments FROM public.deployments WHERE schedule_id = p_schedule;
    SELECT count(*) INTO v_total_consents FROM public.sewadar_consents WHERE schedule_id = p_schedule AND consent_given = true;
    SELECT count(*) INTO v_total_finalized FROM public.deployments WHERE schedule_id = p_schedule AND deployed_department_id IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'total_sewadars', v_total_sewadars,
    'total_vss', v_total_vss,
    'total_deployments', v_total_deployments,
    'total_consents', v_total_consents,
    'total_finalized', v_total_finalized,
    'schedule_id', p_schedule
  );
END;
$$;

COMMENT ON FUNCTION public.get_schedule_counts(uuid)
  IS 'DB-optimized global counts for a schedule (v29). All fields via SELECT COUNT(*) — no row transfer. total_sewadars is simple count(*) from dp_sewadars; total_vss from vss_sewadars; other fields scoped to p_schedule.';

GRANT EXECUTE ON FUNCTION public.get_schedule_counts(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. get_deployment_matrix_counts(p_schedule uuid)
--    -> TABLE(centre, department_id, department_name,
--             scheduled int, deployed int, male int, female int, vss int)
--    Server-side GROUP BY root_centre (via get_root_centre) +
--    effective department (COALESCE deployed else requested).
--    Uses COUNT(*) and COUNT(*) FILTER for gender/VSS, all
--    inside Postgres. Joins dp_sewadars for gender and
--    vss_sewadars for VSS flag. Efficient with the indexes above.
--
--    Semantics:
--      centre          — root CENTRE name (SC_SPs rolled up)
--      department_id   — effective department uuid
--      department_name — deployment_departments.name
--      scheduled       — total deployments with this effective dept
--                        (requested + finalized, i.e. what the matrix
--                        shows as Deployed live)
--      deployed        — subset where deployed_department_id IS NOT NULL
--                        (finalized by super_admin)
--      male/female     — gender breakdown from dp_sewadars (regular
--                        only; VSS gender counted via vss_sewadars but
--                        flagged separately as vss)
--      vss             — count where badge is in vss_sewadars
--    Note: Scheduled QUOTA (centre_allocations.max_count) is not
--    part of this deployments-only aggregate; fetch allocations
--    separately or compute diff client-side as
--    deployed - quota. This keeps the GROUP BY on one table.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_deployment_matrix_counts(uuid);

CREATE OR REPLACE FUNCTION public.get_deployment_matrix_counts(p_schedule uuid)
RETURNS TABLE (
  centre text,
  department_id uuid,
  department_name text,
  scheduled integer,
  deployed integer,
  male integer,
  female integer,
  vss integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    public.get_root_centre(d.centre) AS centre,
    COALESCE(d.deployed_department_id, d.department_id) AS department_id,
    dep.name AS department_name,
    count(*)::integer AS scheduled,
    count(*) FILTER (WHERE d.deployed_department_id IS NOT NULL)::integer AS deployed,
    count(*) FILTER (WHERE ds.gender ILIKE 'MALE')::integer AS male,
    count(*) FILTER (WHERE ds.gender ILIKE 'FEMALE')::integer AS female,
    count(*) FILTER (WHERE vs.badge_number IS NOT NULL)::integer AS vss
  FROM public.deployments d
  JOIN public.deployment_departments dep
    ON dep.id = COALESCE(d.deployed_department_id, d.department_id)
  LEFT JOIN public.dp_sewadars ds
    ON ds.badge_number = d.badge_number AND ds.centre = d.centre
  LEFT JOIN public.vss_sewadars vs
    ON vs.badge_number = d.badge_number
  WHERE d.schedule_id = p_schedule
  GROUP BY public.get_root_centre(d.centre), COALESCE(d.deployed_department_id, d.department_id), dep.name
  ORDER BY 1, 3;
$$;

COMMENT ON FUNCTION public.get_deployment_matrix_counts(uuid)
  IS 'DB-optimized deployment matrix (v29). GROUP BY root_centre + effective department, COUNT(*) + FILTER for gender/VSS, all server-side. scheduled = effective deployments; deployed = finalized subset. Joins dp_sewadars/vss_sewadars.';

GRANT EXECUTE ON FUNCTION public.get_deployment_matrix_counts(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 3. get_centre_counts(p_schedule uuid, p_centre text) -> jsonb
--    Per-centre (subtree) stats for ConsentPage header. Builds the
--    subtree via recursive CTE on dp_centres (self + descendants)
--    and counts scoped to that subtree. SECURITY DEFINER, but
--    respects RLS via portal role: centre_user/centre_admin may
--    only query their own subtree; aso/super_admin may query any.
--    Returns allocated_seats (sum max_count for the root centre)
--    alongside the COUNT(*) aggregates.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_centre_counts(uuid, text);

CREATE OR REPLACE FUNCTION public.get_centre_counts(p_schedule uuid, p_centre text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_subtree text[];
  v_root text;
  v_total_sewadars bigint;
  v_total_vss bigint;
  v_total_deployments bigint;
  v_total_consents bigint;
  v_total_finalized bigint;
  v_allocated bigint;
BEGIN
  IF p_schedule IS NULL OR p_centre IS NULL OR btrim(p_centre) = '' THEN
    RAISE EXCEPTION 'p_schedule and p_centre are required';
  END IF;

  -- RLS via portal role: non-admin may only query own subtree
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('aso', 'super_admin') THEN
    IF NOT (p_centre = ANY (public.get_my_subtree_centres())) THEN
      RAISE EXCEPTION 'Not authorized for centre %', p_centre;
    END IF;
  END IF;

  -- build subtree: p_centre + all descendants via dp_centres
  WITH RECURSIVE sub(name) AS (
    SELECT name FROM public.dp_centres WHERE name = p_centre
    UNION ALL
    SELECT c.name FROM public.dp_centres c JOIN sub s ON c.parent_centre = s.name
  )
  SELECT array_agg(name) INTO v_subtree FROM sub;

  IF v_subtree IS NULL THEN
    v_subtree := ARRAY[p_centre];
  END IF;

  v_root := public.get_root_centre(p_centre);

  -- counts scoped to subtree centres — all via COUNT(*)
  SELECT count(*) INTO v_total_sewadars
  FROM public.dp_sewadars s
  WHERE s.centre = ANY (v_subtree)
    AND COALESCE(s.badge_status, '') <> 'ELDERLY';

  SELECT count(*) INTO v_total_vss
  FROM public.vss_sewadars vs
  WHERE vs.centre = ANY (v_subtree);

  SELECT count(*) INTO v_total_deployments
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.centre = ANY (v_subtree);

  SELECT count(*) INTO v_total_consents
  FROM public.sewadar_consents sc
  WHERE sc.schedule_id = p_schedule AND sc.centre = ANY (v_subtree) AND sc.consent_given = true;

  SELECT count(*) INTO v_total_finalized
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.centre = ANY (v_subtree) AND d.deployed_department_id IS NOT NULL;

  SELECT COALESCE(sum(max_count), 0)::bigint INTO v_allocated
  FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND centre = v_root;

  RETURN jsonb_build_object(
    'centre', p_centre,
    'root_centre', v_root,
    'subtree', to_jsonb(v_subtree),
    'subtree_size', COALESCE(array_length(v_subtree, 1), 1),
    'total_sewadars', v_total_sewadars,
    'total_vss', v_total_vss,
    'total_deployments', v_total_deployments,
    'total_consents', v_total_consents,
    'total_finalized', v_total_finalized,
    'allocated_seats', v_allocated,
    'schedule_id', p_schedule
  );
END;
$$;

COMMENT ON FUNCTION public.get_centre_counts(uuid, text)
  IS 'DB-optimized per-centre (subtree) counts for ConsentPage header (v29). Subtree via dp_centres recursion, all metrics via SELECT COUNT(*), respects portal role. allocated_seats = sum max_count for root centre.';

GRANT EXECUTE ON FUNCTION public.get_centre_counts(uuid, text) TO authenticated;

COMMIT;

-- ============================================================
-- VERIFICATION QUERIES (run after COMMIT, copy-paste in SQL Editor)
-- ============================================================
-- -- 1. Global counts for a schedule (replace uuid):
-- SELECT public.get_schedule_counts('b1f448d1-0a1a-4a1a-8a1a-aaaaaaaaaaaa'::uuid);
-- -- Expect keys: total_sewadars ~3597, total_vss ~320, total_deployments, total_consents, total_finalized
--
-- -- 2. Global counts with NULL (all schedules):
-- SELECT public.get_schedule_counts(NULL);
--
-- -- 3. Matrix counts (grouped by root_centre + effective department):
-- SELECT * FROM public.get_deployment_matrix_counts('b1f448d1-0a1a-4a1a-8a1a-aaaaaaaaaaaa'::uuid);
-- -- Each row = one root_centre x department with scheduled/deployed/male/female/vss via COUNT(*) FILTER
-- -- Verify no download-then-count: EXPLAIN ANALYZE shows Aggregate / GroupAggregate with index scans
--
-- -- 4. Per-centre subtree counts (ConsentPage header):
-- SELECT public.get_centre_counts('b1f448d1-0a1a-4a1a-8a1a-aaaaaaaaaaaa'::uuid, 'FARIDABAD');
-- -- Expect subtree array includes SC_SPs, allocated_seats = sum max_count for root centre
--
-- -- 5. Functions reference dp_* only (should return 0 rows for old literals outside comments):
-- SELECT proname, prosrc FROM pg_proc
-- WHERE proname IN ('get_schedule_counts','get_deployment_matrix_counts','get_centre_counts')
--   AND (prosrc LIKE '%public.centres%' OR prosrc LIKE '%public.sewadars%' OR prosrc LIKE '%public.attendance_sessions%');
-- -- ^ should return 0 rows
--
-- -- 6. Grants:
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
-- WHERE routine_name IN ('get_schedule_counts','get_deployment_matrix_counts','get_centre_counts')
-- ORDER BY routine_name, grantee;
-- -- ^ should show authenticated has EXECUTE
--
-- -- 7. Indexes exist:
-- SELECT relname FROM pg_class WHERE relname LIKE 'idx_deployments_schedule%' OR relname LIKE 'idx_consent_schedule%' OR relname LIKE 'idx_dp_sewadars_centre' ORDER BY relname;
--
-- -- 8. Compare DB counts vs old client method (spot check):
-- SELECT
--   (SELECT count(*) FROM public.dp_sewadars) AS db_sewadars,
--   (SELECT count(*) FROM public.vss_sewadars) AS db_vss,
--   (SELECT count(*) FROM public.deployments WHERE schedule_id = 'b1f448d1-0a1a-4a1a-8a1a-aaaaaaaaaaaa'::uuid) AS db_deployments
-- UNION ALL
-- SELECT * FROM (SELECT public.get_schedule_counts('b1f448d1-0a1a-4a1a-8a1a-aaaaaaaaaaaa'::uuid) ->> 'total_sewadars', NULL, NULL) t;
