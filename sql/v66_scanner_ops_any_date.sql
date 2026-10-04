-- ============================================================
-- V66: SCANNER OPS REPORTS ANY DATE. Run AFTER v65.
--
-- Baseline: the function body below is copied from
-- sql/v61_visit_window_scope.sql VERBATIM except the listed diffs:
--
--   (a) DECLARE drops `v_window date[]` + `v_windowed boolean`
--       (v61 lines 621-622) — unused after (c).
--   (b) Prologue drops the window assignment (v61 lines 636-637):
--         v_window := public.schedule_visit_dates(p_schedule);
--         v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);
--   (c) Drops the previsit early return (v61 line 640):
--         IF v_windowed AND NOT (p_date = ANY (v_window)) THEN RETURN; END IF;
--
-- Why: v61 made Scanner Ops a visit-day-only view so a previsit scan could
-- never inflate a visit report. But the Live Scanners / Scanner Ops tab is
-- an OPERATIONS view, not a visit report — during previsit scanning (which
-- is most of the calendar outside the 5-day window) the tab read empty for
-- every role, looking broken. The visit REPORTS keep their window scoping
-- (attendance_visit_summary, attendance_sewadar_summary, attendance_trend,
-- attendance_anomalies are untouched); only this per-day operator view is
-- ungated. The row predicate `a.in_date = p_date OR a.out_date = p_date`
-- already scopes the result to the picked day, and the centre/department
-- scoping arms are unchanged, so no role sees more than before.
--
-- Semantics:
--   - Schedules WITH a window: Scanner Ops now answers for ANY p_date,
--     including previsit days. Previsit scans no longer read as "no
--     scanner activity".
--   - Schedules with NO window: identical behaviour to v61 (the gate
--     short-circuited on NOT v_windowed, so it never fired there anyway).
--
-- Non-destructive; safe to re-run (BEGIN/COMMIT; CREATE OR REPLACE;
-- no table, column, index, trigger, policy or RLS change). Grants:
-- untouched — CREATE OR REPLACE preserves every existing grant, and no
-- signature changes (no DROP needed).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. attendance_scanner_ops — the Scanner Ops tab.
-- v66 diff: (a)(b)(c) — the v61 previsit early return is removed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_scanner_ops(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  scanner_badge   text,
  scanner_name    text,
  scanner_centre  text,
  scans_in        bigint,
  scans_out       bigint,
  open_now        bigint,
  manual_scans    bigint,
  first_in_time   time,
  last_scan_time  time
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

  RETURN QUERY
  SELECT COALESCE(a.in_scanner_badge, a.out_scanner_badge) AS scanner_badge,
         COALESCE(max(a.in_scanner_name), max(a.out_scanner_name)) AS scanner_name,
         -- The operator's OWN centre, not the venue. `a.centre` is the
         -- single constant bhati and would be identical on every row,
         -- which tells an ops review nothing.
         COALESCE(max(a.in_scanner_centre), max(a.out_scanner_centre)) AS scanner_centre,
         count(*) FILTER (WHERE a.in_date = p_date)                               AS scans_in,
         count(*) FILTER (WHERE a.out_date = p_date AND a.status = 'CLOSED')      AS scans_out,
         count(*) FILTER (WHERE a.status = 'OPEN')::bigint                        AS open_now,
         count(*) FILTER (WHERE a.is_manual)::bigint                              AS manual_scans,
         min(a.in_time) FILTER (WHERE a.in_date = p_date)                         AS first_in_time,
         max(CASE WHEN a.out_date = p_date THEN a.out_time
                  WHEN a.in_date = p_date THEN a.in_time END)                     AS last_scan_time
    FROM public.dp_attendance_sessions a
   WHERE a.schedule_id = p_schedule
     AND (a.in_date = p_date OR a.out_date = p_date)
     -- Scoped on the SEWADAR's home centre: a centre user sees ops
     -- for scans of their own subtree's people, and open scanning
     -- still works because a foreign-centre scan is attributed to the
     -- sewadar, not to the operator.
     AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
     -- v55: the attributing department.
     AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
   GROUP BY COALESCE(a.in_scanner_badge, a.out_scanner_badge)
   ORDER BY count(*) DESC, 2
   -- Safety ceiling only, not a report limit. This was 200, which
   -- silently dropped the LEAST active scanners — precisely the rows
   -- an ops review is looking for, since the sort is by scan count
   -- descending.
   LIMIT 1000;
END;
$$;

-- ------------------------------------------------------------
-- §2. Version registry (convention from v50: one row per migration).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v66')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The v61 previsit gate is gone: calling the function with a date
--    OUTSIDE the schedule's visit window returns that day's rows instead
--    of zero rows. Expect: one row per scanner active on <previsit-date>.
--
--   SELECT * FROM public.attendance_scanner_ops('<sched>', '<previsit-date>');
--
-- 2. The function still carries no v_window/v_windowed locals. Expect: 0.
--
--   SELECT count(*) AS window_refs
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'attendance_scanner_ops'
--      AND p.prosrc LIKE '%v_windowed%';
--
-- 3. The version registry recorded the migration. Expect: v66.
--
--   SELECT version FROM public.portal_version WHERE version = 'v66';
