-- ============================================================
-- V75: VISIT SUMMARY COUNTS DEPLOYED BADGES ONLY. Run AFTER v61
-- (needs scoped_dep/badge_eff pattern from v59; any later version
-- is fine — the body below is v61 §3 verbatim except the ONE added
-- predicate marked v75).
--
-- Root cause (Home dashboard, October Visit 2026): the "Open now"
-- tile (attendance_daily_summary, deployed-only since v59 (a)) read
-- 629 while the centre × department matrix TOTAL (attendance_visit_
-- summary) read 630. visit_summary.per_badge never had the deployed-
-- only EXISTS gate the other two attendance RPCs have, so an
-- UNDEPLOYED open session whose scan snapshot (centre, dept)
-- happened to match a real dep_agg cell inflated that cell's
-- open_now (and ever_present). Same rule everywhere now: presence
-- counts DEPLOYED badges only, so present <= deployed per cell and
-- the matrix reconciles with the tiles and the 2587 deployed
-- denominator it already renders against.
--
-- Visible effect after applying: matrix TOTAL open_now drops by the
-- attributed undeployed strays (629 == 629 on the observed data),
-- TOTAL ever_present may drop by the same class of strays while
-- never_present rises to match (GREATEST floor never does work).
-- That is the correction, not data loss — no session row is
-- touched. Undeployed scans stay visible where they belong: the
-- Attendance "Undeployed" tile (attendance_sewadar_summary).
--
-- Grants: untouched — CREATE OR REPLACE preserves every existing
-- grant, and no signature change (no DROP needed).
--
-- NOT TOUCHED: scan_in / scan_out / get_open_session /
-- get_scan_state, attendance_daily_summary, attendance_sewadar_
-- summary, attendance_centre_daily, attendance_scope_centres,
-- attendance_allowed_depts, attendance_badge_dept, RLS policies,
-- tables, columns, triggers, indexes, existing data.
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- INSERT ... ON CONFLICT DO NOTHING). No DELETE, no UPDATE, no DROP.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.attendance_visit_summary(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  centre          text,
  department_id   uuid,
  dept_name       text,
  deployed        bigint,
  ever_present    bigint,
  never_present   bigint,
  open_now        bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- v61 (b): the visit window (see v61 file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  badge_eff AS (
    SELECT DISTINCT ON (sd.badge_number)
           sd.badge_number, sd.centre AS dc, sd.eff AS eff
      FROM scoped_dep sd
     ORDER BY sd.badge_number, sd.centre, sd.eff
  ),
  dep_agg AS (
    -- v59 (f): same one-badge-one-centre grain as pres_agg (see daily agg).
    SELECT be.dc AS centre, be.eff AS department_id,
           count(*) AS deployed
      FROM badge_eff be
     GROUP BY be.dc, be.eff
  ),
  per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_centre) AS sc,
           (array_remove(
              array_agg(a.sewadar_dept ORDER BY a.in_date DESC, a.in_time DESC),
              NULL))[1]          AS dept,
           -- v59 (b): date-scoped Open now — the event-day window keeps
           -- open_now comparable with the Daily tab, so a session opened
           -- day 1 and never closed counts in Open now only on day 1.
           -- p_date NULL disables the window (whole-visit sweep: every OPEN
           -- session counts); the Anomalies STALE_OPEN arm with p_date NULL
           -- is the safety net that still lists such sessions.
           bool_or(a.status = 'OPEN'
                   AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)) AS still_open
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       -- v61 (d): visit-wide presence counts visit days only — a previsit
       -- scan no longer marks a badge ever-present.
       AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
       AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
       -- v55: the attributing department, matching pres_agg's COALESCE below.
       AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
       -- v75: presence counts DEPLOYED badges only (v59 (a) — the same gate
       -- attendance_daily_summary and attendance_centre_daily have). An
       -- undeployed scan could otherwise attribute by snapshot into a real
       -- cell and inflate ever_present / open_now past deployed.
       AND EXISTS (SELECT 1 FROM scoped_dep sd WHERE sd.badge_number = a.badge_number)
     GROUP BY a.badge_number
  ),
  pres_agg AS (
    SELECT COALESCE(be.dc, b.sc) AS centre,
           COALESCE(be.eff, b.dept) AS department_id,
           count(*) AS ever_present,
           count(*) FILTER (WHERE b.still_open) AS open_now
      FROM per_badge b
      LEFT JOIN badge_eff be ON be.badge_number = b.badge_number
     GROUP BY 1, 2
  )
  SELECT agg.centre,
         agg.department_id,
         d.name,
         agg.deployed,
         COALESCE(p.ever_present, 0)::bigint AS ever_present,
         GREATEST(agg.deployed - COALESCE(p.ever_present, 0), 0)::bigint AS never_present,
         COALESCE(p.open_now, 0)::bigint     AS open_now
    FROM dep_agg agg
    LEFT JOIN pres_agg p
      ON p.centre = agg.centre
     AND p.department_id = agg.department_id
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- §2 (v75). Version registry (convention from v50: one row per
-- migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v75')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run in the Supabase SQL editor, as aso)
-- ============================================================
-- '<sched>' below is the October Visit 2026 schedule id.
--
-- 1. The strays this migration removes (run BEFORE applying; on the
--    observed data expect exactly the matrix-minus-tile gap):
--   SELECT count(DISTINCT a.badge_number) AS undeployed_open_today
--     FROM public.dp_attendance_sessions a
--    WHERE a.schedule_id = '<sched>'
--      AND a.status = 'OPEN'
--      AND (a.in_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
--        OR a.out_date = (now() AT TIME ZONE 'Asia/Kolkata')::date)
--      AND NOT EXISTS (SELECT 1 FROM public.deployments d
--                       WHERE d.schedule_id = '<sched>'
--                         AND d.badge_number = a.badge_number);
--   -- Expect (pre-v75): >= 0; each row attributed to a real cell
--   -- inflated matrix open_now by one.
-- 2. No cell exceeds its denominator (run AFTER applying):
--   SELECT count(*) FROM public.attendance_visit_summary('<sched>')
--    WHERE ever_present > deployed OR open_now > deployed;
--   -- Expect: 0.
-- 3. Matrix reconciles with the tiles for today (run AFTER applying;
--    same-day, quiet-system — see note 5):
--   SELECT sum(open_now) FROM public.attendance_visit_summary('<sched>');
--   SELECT sum(open_now) FROM public.attendance_daily_summary(
--     '<sched>', (now() AT TIME ZONE 'Asia/Kolkata')::date);
--   -- Expect: equal (both deployed-only, both today-scoped).
-- 4. Registry:
--   SELECT version FROM public.portal_version WHERE version = 'v75';
--   -- Expect: one row.
-- 5. NOTE on transient ±1: the dashboard fires its six RPCs as separate
--    statements; a scan committing between two statements skews those two
--    sections by the scans that landed mid-load. That shimmer converges on
--    the next refresh/realtime reload and is NOT this bug. Compare the two
--    queries in (3) back-to-back on a quiet system for a clean read.
-- 6. Re-run safety: execute this whole file a second time. Expect no error.
