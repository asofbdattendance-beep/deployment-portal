-- ============================================================
-- V41: SCAN_OUT IDEMPOTENCY — MAKE THE DEDUP BRANCH REACHABLE
--
-- Run AFTER v39 and v40. Non-destructive; safe to re-run.
--
-- ------------------------------------------------------------
-- THE PROBLEM THIS FIXES
-- ------------------------------------------------------------
-- `scan_out` has carried an idempotency branch since v26, with a
-- comment stating the intent plainly:
--
--     -- If session is already CLOSED, return success (idempotent)
--     IF v_open.status = 'CLOSED' THEN
--       RETURN jsonb_build_object('ok', true, 'dedup', true, ...);
--     END IF;
--
-- That branch was DEAD CODE, because the lookup immediately above it
-- filtered the status away:
--
--     SELECT * INTO v_open
--       FROM public.dp_attendance_sessions
--      WHERE id = p_open_id AND status='OPEN' LIMIT 1;
--
-- `AND status='OPEN'` guarantees the row it returns is OPEN. So v_open
-- could only ever be NULL, or OPEN — never CLOSED. The CLOSED test
-- could not be true, control always fell through, and the final guard
--
--     IF v_open IS NULL THEN RAISE EXCEPTION 'No open session to close'; END IF;
--
-- fired instead. The operator saw "SCAN FAILED - No open session to
-- close - <badge>" for what is, semantically, a successful repeat of a
-- scan they had already completed.
--
-- WHY IT ONLY NOW SURFACES
-- ------------------------------------------------------------
-- Nothing reaches this path until an OUT is attempted against a
-- session that is already closed. Until v40 the OUT could not even be
-- attempted: `withTimeout` (src/lib/scannerUtils.js) called `.catch()`
-- directly on the supabase rpc builder, which implements `then` but has
-- NO `catch`, so every scan RPC threw a TypeError client-side before
-- its response was read. That has been fixed, so OUTs now reach the
-- server, and a repeat OUT — a double scan, the post-popup re-fire in
-- ScannerPage, or an offline-queued OUT draining after the session was
-- already closed — hits the dead branch and reports a failure.
--
-- ------------------------------------------------------------
-- THE FIX
-- ------------------------------------------------------------
-- 1. Look the session up by id ALONE, so a CLOSED row is found and
--    the intended idempotency reply is returned.
--
-- 2. Test that lookup with `FOUND`, not `IS NOT NULL`. See the note
--    inline; this also revives a guard that has been dead since v26.
--
-- Behaviour is otherwise identical:
--   * p_open_id naming a CLOSED session  -> ok/dedup (was: raise)
--   * p_open_id naming a real OPEN session -> unchanged
--   * p_open_id naming nothing at all      -> still 'No open session to close'
--   * badge/schedule mismatch              -> now actually raises (was: silently closed the wrong session)
--
-- The offline queue is NOT changed: it may keep retrying a closed
-- session, and now each attempt is a clean no-op success instead of an
-- error that poisons the row with `failed`.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.scan_out(text, uuid, timestamptz, uuid);
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.dp_attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  IF p_open_id IS NOT NULL THEN
    -- v41 fix 1: no `AND status='OPEN'` here. Filtering the status away made
    -- the idempotency branch below unreachable — see the header.
    --
    -- v41 fix 2: `FOUND`, not `v_open IS NOT NULL`. For a plpgsql ROW variable
    -- `IS NOT NULL` does NOT answer "did the lookup return a row?" — verified
    -- on Postgres 15: with a real row loaded, both `v_open IS NULL` and
    -- `v_open IS NOT NULL` evaluate to FALSE. So the guard below was
    -- pre-existing dead code in v26/v28 too, and a p_open_id belonging to a
    -- different badge or schedule silently closed THAT sewadar's session
    -- instead of raising. `FOUND` is what SELECT INTO actually sets.
    SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = p_open_id LIMIT 1;
    IF FOUND AND (v_open.badge_number <> p_badge OR v_open.schedule_id <> p_schedule) THEN
      RAISE EXCEPTION 'Session does not match badge/schedule';
    END IF;
    -- If session is already CLOSED, return success (idempotent).
    IF FOUND AND v_open.status = 'CLOSED' THEN
      RETURN jsonb_build_object('ok', true, 'dedup', true, 'message', 'Session already closed');
    END IF;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
  END IF;
  IF v_open IS NULL THEN RAISE EXCEPTION 'No open session to close'; END IF;
  v_out_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_out_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  IF v_out_date < v_open.in_date OR (v_out_date = v_open.in_date AND v_out_time <= v_open.in_time) THEN
    RAISE EXCEPTION 'OUT time must be after IN time';
  END IF;
  v_centre := public.get_portal_user_centre();
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  UPDATE public.dp_attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, updated_at=now() WHERE id=v_open.id;
  RETURN jsonb_build_object('ok', true);
END; $$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The dedup branch is now reachable: the function body must NOT
--    contain `AND status='OPEN'` in the p_open_id lookup.
--    Expect: zero rows.
--
-- SELECT count(*) AS still_filtering_status
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_out'
--    AND p.prosrc LIKE '%id = p_open_id AND status=%';
--
-- 2. Repeat-OUT now succeeds instead of raising. As a scanner /
--    dept_incharge, scan the same badge in, then scan it out, then
--    scan it out AGAIN. The third scan must report success
--    (a dedup, not an error).
--
-- 3. Orphan OPEN sessions — sessions created by a scan that the UI
--    reported as FAILED. Before v41's client-side fix, `withTimeout`
--    called `.then()` on the rpc builder BEFORE `.catch()` threw, which
--    is what starts the request; the server therefore executed
--    scan_in even though the browser showed a TypeError. Those rows are
--    real and currently OPEN. Inspect them here and decide per row
--    whether to close them:
--
-- SELECT id, badge_number, schedule_id, in_date, in_time, in_scanner_centre, created_at
--   FROM public.dp_attendance_sessions
--  WHERE status = 'OPEN'
--  ORDER BY created_at DESC;
--
-- Close one deliberately (substitute a real id from the list above):
--
-- UPDATE public.dp_attendance_sessions
--    SET status = 'CLOSED',
--        out_date = in_date,
--        out_time = in_time + interval '1 minute',
--        updated_at = now()
--  WHERE id = '<paste-the-id-here>' AND status = 'OPEN';
