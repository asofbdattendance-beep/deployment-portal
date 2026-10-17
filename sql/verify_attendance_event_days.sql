-- ============================================================
-- VERIFY (READ-ONLY): is the live database actually reporting
-- attendance by EVENT DAY — and if not, which rows are misleading?
--
-- NOT a migration. Nothing here writes. CI's migration-parity job does not
-- check this file (it only inspects sql/v[0-9]*_*.sql).
--
-- Run this BEFORE applying v79 — it deliberately never mentions is_auto_out,
-- so it is valid against the database as it stands today.
--
-- WHY THIS FILE EXISTS
-- The checked-in report SQL ALREADY implements the correct law: a sewadar is
-- present on a date only if something happened on that date:
--     in_date = p_date OR out_date = p_date
-- (sql/v61_visit_window_scope.sql, sql/v74_visit_centre_daily.sql), and
-- days_present is count(DISTINCT in_date UNION out_date) — so a Wednesday IN
-- with a Sunday OUT is TWO days, not five.
--
-- But the app's DB floor (v79 in src/lib/version.js) does NOT prove v61 is
-- applied, and the repo's own git branch differs from the deployed one. So
-- the checked-in source cannot answer "what does the live database do".
-- These queries answer it, on the real data.
--
-- Run the sections in order and read the results — sections 2 and 3 are the
-- direct answer to "he shows present for all five days".
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 1 — WHICH REPORT LAW IS ACTUALLY INSTALLED?
-- ------------------------------------------------------------
-- 1a. How far has the live database been migrated?
--     This is a plain list of every migration that has been recorded.
-- SELECT version FROM public.portal_version ORDER BY version;

-- 1b. The version the app itself reports (should match the newest row above).
-- SELECT public.portal_app_version();

-- 1c. THE DECISIVE CHECK — does the installed days-present function count
--     EVENT DAYS (v45+) or only IN days (v39 and earlier)?
--     Expect: union_law_present = 1 (and a position > 0), in_only_law = 0.
--     If union_law_present = 0 the live function is PRE-v45: that database
--     counts IN days only, and the fix is migrating it, not editing the app.
-- SELECT p.proname,
--        position('count(DISTINCT e.d)' in p.prosrc) AS union_law_pos,
--        position('count(DISTINCT a.in_date)' in p.prosrc) AS in_only_law_pos
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('attendance_sewadar_summary',
--                      'attendance_day_badges',
--                      'attendance_centre_daily',
--                      'attendance_visit_summary');

-- 1d. The does-it-filter-by-the-visit-window check (v61+). Expect a positive
--     position for the windowed functions. A 0 here, on a DB that is not
--     early, means previsit scans are inflating visit reports.
-- SELECT p.proname,
--        position('in_date = ANY' in p.prosrc) AS window_filter_pos,
--        position('v_windowed' in p.prosrc)    AS window_flag_pos
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('attendance_sewadar_summary', 'attendance_day_badges')
--  ORDER BY p.proname;

-- 1e. If a fingerprint above looks wrong, read the installed source itself
--     and compare it with sql/v61_visit_window_scope.sql in the repo.
-- SELECT p.proname, pg_get_functiondef(p.oid)
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname = 'attendance_sewadar_summary';

-- ------------------------------------------------------------
-- SECTION 2 — THE EVENT-DAY PROOF (the complaint, in one table)
-- ------------------------------------------------------------
-- Every CLOSED session that spans more than one date. For each one this
-- shows the RAW span in days next to the number of DISTINCT EVENT DAYS —
-- exactly the law the report uses.
--
-- A Wednesday IN with a Sunday OUT MUST read: span_days = 4,
-- distinct_event_days = 2. If distinct_event_days showed 5 here, the law
-- would be broken; it cannot, because it is a property of the data, not of
-- any function. This is the ground truth to compare the shown report against.
--
-- If this list is LONG, that is the real problem: it means sewadars are not
-- scanning OUT, which is what sql/v79_attendance_auto_out.sql fixes.
SELECT s.id,
       s.badge_number,
       s.sewadar_name,
       s.centre,
       s.in_date,
       s.in_time,
       s.out_date,
       s.out_time,
       (s.out_date - s.in_date) AS span_days,
       (SELECT count(DISTINCT d)
          FROM unnest(ARRAY[s.in_date, s.out_date]) AS d) AS distinct_event_days,
       s.is_manual,
       s.undeployed_scan,
       (s.out_scanner_badge IS NULL) AS closed_without_scanner
  FROM public.dp_attendance_sessions s
 WHERE s.status = 'CLOSED'
   AND s.out_date IS NOT NULL
   AND s.out_date <> s.in_date
 ORDER BY s.in_date DESC
 LIMIT 100;

-- ------------------------------------------------------------
-- SECTION 3 — WHAT THE SHOWN REPORT SHOULD SAY, PER BADGE
-- ------------------------------------------------------------
-- This reproduces the v45+ law over the raw rows for ONE badge, so you can
-- hold it beside the Days Present figure in the app. Set the badge below and
-- the visit window of the schedule in question.
--
-- Expect the event_days list to contain ONLY dates on which the sewadar
-- actually scanned. A Wed IN / Sun OUT pair yields exactly two dates.
--
-- >>> EDIT: badge_number, and the window bounds.
SELECT d AS event_day
  FROM (
    SELECT s.in_date AS d
      FROM public.dp_attendance_sessions s
     WHERE s.badge_number = 'FB1'
       AND s.in_date BETWEEN DATE '2026-10-07' AND DATE '2026-10-11'
    UNION
    SELECT s.out_date AS d
      FROM public.dp_attendance_sessions s
     WHERE s.badge_number = 'FB1'
       AND s.out_date BETWEEN DATE '2026-10-07' AND DATE '2026-10-11'
  ) e
 WHERE d IS NOT NULL
 ORDER BY event_day;
-- The ROW COUNT of that result is what the app must show as Days Present.
-- Compare it with the Days Present column and with the app's expected_days
-- (3 for OE ESCORTS, 5 otherwise) before believing any discrepancy is a bug.

-- ------------------------------------------------------------
-- SECTION 4 — THE DECOY: WHY IT *LOOKS* LIKE FIVE DAYS
-- ------------------------------------------------------------
-- The Duration column is the only number in the whole app that spans IN to
-- OUT, and it does so on purpose (src/lib/attendance.js sessionMinutes,
-- documented since L-06). These are the rows where that column will read as
-- a multi-day figure. Pair each with Section 2's distinct_event_days, which
-- stays 2 — the Duration is not a presence count, and this is where the two
-- get confused.
SELECT badge_number,
       sewadar_name,
       in_date || ' ' || in_time AS in_at,
       out_date || ' ' || out_time AS out_at,
       round(EXTRACT(EPOCH FROM (
         (out_date::timestamp + out_time) - (in_date::timestamp + in_time)
       )) / 60) AS duration_minutes_as_shown,
       (SELECT count(DISTINCT d)
          FROM unnest(ARRAY[in_date, out_date]) AS d) AS days_actually_present
  FROM public.dp_attendance_sessions
 WHERE status = 'CLOSED'
   AND out_date IS NOT NULL
   AND out_date <> in_date
 ORDER BY in_date DESC
 LIMIT 50;

-- ------------------------------------------------------------
-- SECTION 5 — THE HIDDEN HARM: A FORGOTTEN OUT BLOCKS THE NEXT IN
-- ------------------------------------------------------------
-- uq_dp_one_open_per_badge_schedule allows exactly ONE OPEN row per
-- (schedule_id, badge_number). A forgotten OUT therefore blocks that
-- sewadar's next IN — he is told "Already IN" and cannot start his day.
-- These are those rows. Every row here is also a future phantom Duration.
SELECT s.schedule_id,
       s.badge_number,
       s.sewadar_name,
       s.centre,
       s.in_date,
       s.in_time,
       (CURRENT_DATE - s.in_date) AS days_still_open,
       (CURRENT_DATE - s.in_date) > 1 AS spans_multiple_days
  FROM public.dp_attendance_sessions s
 WHERE s.status = 'OPEN'
   AND s.in_date < CURRENT_DATE              -- opened on an earlier day, still not closed
 ORDER BY s.in_date, s.badge_number;

-- ------------------------------------------------------------
-- SECTION 6 — HOW MUCH THE SWEEP WILL CATCH, PER DAY
-- ------------------------------------------------------------
-- The daily size of the problem: sessions left OPEN on a past day, and
-- sessions opened today at/after 21:00 (those stay open until their own
-- 21:00, by design in v79).
SELECT s.in_date,
       count(*) AS still_open,
       count(*) FILTER (WHERE s.in_time < TIME '21:00') AS sweepable_now,
       count(*) FILTER (WHERE s.in_time >= TIME '21:00') AS after_21h_waits_for_own_day
  FROM public.dp_attendance_sessions s
 WHERE s.status = 'OPEN'
 GROUP BY s.in_date
 ORDER BY s.in_date DESC;

-- ------------------------------------------------------------
-- SECTION 7 — SANITY: ANY MALFORMED CLOSED ROWS ALREADY IN THE DATA?
-- ------------------------------------------------------------
-- OUT at or before IN should be impossible; the row would still count as an
-- event on a day it never happened. Expect 0 rows before v79 as well as
-- after it. Any row here predates the checks and needs a hand fix.
SELECT id, badge_number, in_date, in_time, out_date, out_time, updated_at
  FROM public.dp_attendance_sessions
 WHERE status = 'CLOSED'
   AND out_date IS NOT NULL
   AND (out_date < in_date OR (out_date = in_date AND out_time <= in_time))
 ORDER BY in_date DESC
 LIMIT 50;

-- ============================================================
-- HOW TO READ ALL OF THIS
-- ------------------------------------------------------------
-- * Sections 2 and 4 together are the answer to "he looks present on all
--   five days": in the same row the true event-day count is 2 while the
--   Duration column reads ~103h. The presence columns are already right;
--   the Duration is intentionally a span. Section 4 is what to point at.
-- * Section 5 is the concrete harm the sweep removes: a sewadar who cannot
--   scan IN again because yesterday's row never closed.
-- * Section 1d tells you whether the LIVE database is even applying the
--   correct law. If 1c shows in_only_law_pos > 0 on
--   attendance_sewadar_summary, the live function is pre-v45 and the fix
--   is to apply the v45..v61 migrations, not to change the app.
-- ============================================================
