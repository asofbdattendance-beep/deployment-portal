-- ============================================================
-- V79: AUTO-OUT — forgotten OPEN sessions close on a 21:00 IST sweep,
--      tagged is_auto_out so no report can mistake one for a scan.
--
-- ------------------------------------------------------------
-- WHY (both halves of the reported problem trace back to this row shape)
-- ------------------------------------------------------------
-- 1. A sewadar who scans IN and walks away without scanning OUT leaves an
--    OPEN row forever. Two harms follow:
--
--    a. uq_dp_one_open_per_badge_schedule allows exactly ONE OPEN row per
--       (schedule_id, badge_number) — so the forgotten row BLOCKS that
--       sewadar's next IN. They get "Already IN" on every later attempt
--       until somebody closes the row by hand.
--
--    b. The row's in_date and out_date then sit days apart, and every
--       IN->OUT-spanning number in the app reads as a multi-day visit.
--       The Duration column renders the TRUE elapsed span on purpose
--       (src/lib/attendance.js sessionMinutes, pinned since L-06: Wed
--       09:00 -> Sun 16:00 = 103h). Days-present does NOT span — v61
--       counts count(DISTINCT in_date UNION out_date) = 2 — but a bare
--       "103h" beside a 5-day visit window is what makes a forgotten OUT
--       LOOK like a five-day presence. Closing the row at 21:00 on the
--       day it opened removes the span without touching one legitimately
--       scanned OUT.
--
-- 2. A closure nobody performed must be LABELLED, never silent. A bare
--    21:00 CLOSED row is indistinguishable from a real 21:00 scan in the
--    Logs tab and in the Excel export.
--
-- ------------------------------------------------------------
-- WHAT THIS MIGRATION DOES (one additive column + one new function)
-- ------------------------------------------------------------
--   * ADD COLUMN is_auto_out boolean NOT NULL DEFAULT false. Every
--     existing row reads false (a real scan closed it), so no backfill.
--   * CREATE FUNCTION attendance_auto_close_open_sessions(p_ts) — the
--     sweep itself. Deterministic, idempotent, IST-based.
--   * Re-running this file is safe.
--
-- ------------------------------------------------------------
-- THE SCHEDULE IS A SEPARATE FILE, ON PURPOSE
-- ------------------------------------------------------------
-- This file does NOT call cron.schedule(...). If the project has no
-- pg_cron, that statement ERRORS and would abort the whole migration.
-- The timer wiring lives in sql/ops_attendance_auto_close_cron.sql, which
-- detects pg_cron first and prints what to do when it is absent.
-- Apply THIS file first, verify it, then wire the timer.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The marker. NOT an overload of is_manual: is_manual means "an
--    operator typed this" (v67), which stays true for an operator-entered
--    IN that this sweep later closes. They are independent facts and the
--    OR-semantics of v67 must not be reused here.
-- ------------------------------------------------------------
ALTER TABLE public.dp_attendance_sessions
  ADD COLUMN IF NOT EXISTS is_auto_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dp_attendance_sessions.is_auto_out IS
  'true when the 21:00 IST sweep (attendance_auto_close_open_sessions) closed this session; out_date/out_time are then the sweep''s assumed values, not a scan. out_scanner_* stay NULL.';

-- ------------------------------------------------------------
-- 2. The sweep.
--
-- Decisions that matter, each deliberate:
--
--   * out_date = the session's OWN in_date. The closure belongs to the day
--     the sewadar arrived. Using the sweep's date instead would add a
--     LATER event-date to the row, and attendance_day_badges counts
--     presence as (in_date = p_date OR out_date = p_date)
--     (sql/v61_visit_window_scope.sql). A Sunday out_date on a Wednesday
--     IN would make him look present on Sunday too — that is exactly the
--     "marked present on days he was not there" complaint, so it must not
--     be reintroduced here.
--
--   * out_time = 21:00 IST on that day; 23:59:59.999999 when the IN itself
--     was at/after 21:00, because OUT must be strictly after IN and NOTHING
--     enforces that at table level — only scan_out's body checks it
--     (sql/v67_scan_out_manual.sql), and a bulk UPDATE bypasses that body.
--     out_date is pinned to in_date, so the strictly-later OUT must come
--     from the time of that SAME day; 23:59:59.999999 is its ceiling and
--     the CASE alone carries the guarantee (the WHERE clause adds none).
--     The one input the CASE cannot beat is in_time = 23:59:59.999999 —
--     the last representable instant of the day, which no scan can stamp.
--     That single throwaway edge closes with an equal OUT time rather than
--     staying OPEN: leaving it OPEN would block that sewadar's next IN,
--     which is the very harm this function exists to remove.
--
--   * out_scanner_* stay NULL. No portal user performed this close, and
--     inventing a badge would corrupt the identity checks that read
--     out_scanner_badge. NULL is already this repo's convention for
--     "closed without a scanner"
--     (sql/ops_attendance_close_stuck_sessions.sql).
--
--   * IST, never the server's UTC date: attendance is an IST concept
--     everywhere else in this repo (fixed WED..SUN days, IST stamps).
--
--   * Only OPEN rows. A real OUT is never overwritten, and a second run
--     matches nothing because the rows are CLOSED — idempotent by
--     construction, so overlapping or retried runs cannot double-write.
--
--   * Today's INs at/after 21:00 stay OPEN: those sewadars are still on
--     site. They are swept by a later run, at 21:00 of their own day.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_auto_close_open_sessions(
  p_ts timestamptz DEFAULT now()
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ist_date date;
  v_closed   integer;
BEGIN
  v_ist_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;

  UPDATE public.dp_attendance_sessions s
     SET status      = 'CLOSED',
         out_date    = s.in_date,
         out_time    = CASE WHEN s.in_time < TIME '21:00' THEN TIME '21:00'
                            ELSE TIME '23:59:59.999999' END,
         is_auto_out = true,
         updated_at  = now()
   WHERE s.status = 'OPEN'
     AND (s.in_date < v_ist_date
          OR (s.in_date = v_ist_date AND s.in_time < TIME '21:00'));

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END; $$;

-- ------------------------------------------------------------
-- 3. Grants — the v78 rule, with its documented deviation.
--
-- DEVIATION FROM THE v78 RULE, stated plainly rather than dressed up.
-- v78's header ("RULE FOR NEW MIGRATIONS (do not drift)") mandates
-- REVOKE from PUBLIC + anon AND GRANT EXECUTE to authenticated and
-- service_role. Its only recorded carve-out concerns anon, and only for
-- pre-auth functions. v79 is not that carry-out: it drifts in the OTHER
-- direction, withholding the authenticated grant, which v78 does not
-- contemplate at all. So there is no text to point at — this is a
-- deliberate, reviewed drift, recorded here so it is not mistaken for
-- an oversight. The reason: authenticated can reach this function at
-- /rest/v1/rpc, and it mass-closes EVERY tenant's rows as the function
-- owner (SECURITY DEFINER), so a single logged-in centre user could
-- close the whole estate. It is a scheduler/server routine.
--
-- service_role (server-only key, never shipped to a browser) covers the
-- external-scheduler fallback in sql/ops_attendance_auto_close_cron.sql.
-- pg_cron runs the job as its owner and needs no grant at all.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) TO service_role;

-- ------------------------------------------------------------
-- 4. Version registry (v50 convention: append own row only).
--    Without this row portal_app_version() still reports v78 and the app
--    banner keeps saying the DB needs v79+ even with this applied.
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v79')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run AFTER applying, BEFORE wiring the timer)
-- ============================================================
-- The sweep is a writer, so prove it on real rows first.
--
-- 1. The column arrived and every existing row reads false: expect tagged = 0.
-- SELECT count(*) FILTER (WHERE is_auto_out) AS tagged,
--        count(*) AS total
--   FROM public.dp_attendance_sessions;
--
-- 2. DRY RUN — the exact rows the sweep would close right now. Read them:
--    every one must be somebody who plausibly went home. This predicate is
--    character-for-character the function's WHERE clause.
-- SELECT schedule_id, badge_number, sewadar_name, in_date, in_time, status
--   FROM public.dp_attendance_sessions
--  WHERE status = 'OPEN'
--    AND (in_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
--         OR (in_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
--             AND in_time < TIME '21:00'))
--  ORDER BY in_date, in_time;
--
-- 3. Run it (SQL editor / service role — it is not client-callable):
-- SELECT public.attendance_auto_close_open_sessions();
-- -- returns the number of rows closed; must equal the count from query 2.
--
-- 4. No tagged row may be malformed. Expect broken = 0.
-- SELECT count(*) AS broken
--   FROM public.dp_attendance_sessions
--  WHERE is_auto_out
--    AND (out_date <> in_date
--         OR out_time <= in_time
--         OR out_scanner_badge IS NOT NULL
--         OR status <> 'CLOSED');
--
-- 5. Idempotent: run query 3 again. Expect 0.
--
-- 6. The registry recorded the migration. Expect: v79.
-- SELECT version FROM public.portal_version WHERE version = 'v79';
--
-- 7. The function is not reachable by a logged-in user (must be empty):
-- SELECT p.oid::regprocedure AS fn, a.grantee::regrole AS grantee
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace,
--        LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
--  WHERE n.nspname = 'public'
--    AND p.proname = 'attendance_auto_close_open_sessions'
--    AND a.grantee = 'authenticated'::regrole;
