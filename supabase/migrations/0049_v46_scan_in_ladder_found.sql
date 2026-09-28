-- ============================================================
-- v46 — scan_in ladder guard: FOUND, not IS NOT NULL
-- ============================================================
-- Run AFTER v43 → v44 → v45. Non-destructive; safe to re-run.
--
-- BUG (C5): scan_in's "Already IN" ladder guard was the exact
-- plpgsql-row `IS NOT NULL` pattern v41 declared non-functional:
--
--   v_open := public.get_open_session(p_badge, p_schedule);
--   IF v_open IS NOT NULL THEN RAISE EXCEPTION 'Already IN ...' END IF;
--
-- Two compounding defects, both documented in v41's own header:
-- (1) `v_open := f()` is an ASSIGNMENT, which never sets FOUND; and
-- (2) for a plpgsql ROW variable, `IS NOT NULL` does not answer "was a
-- row found?" — with a real row loaded, both `IS NULL` and
-- `IS NOT NULL` evaluate FALSE (an OPEN session always has NULL
-- out_date/out_time fields). Net: the RAISE never fired, so the DB's
-- ladder backstop against double-IN was inert. Offline IN replays each
-- carry a distinct nonce, so nonce dedup could not collapse them
-- either — duplicate unclosable OPEN rows, double-counted open_now.
--
-- FIX: SELECT INTO (which is what actually sets FOUND) + IF FOUND.
-- Nothing else in the function changes — body copied verbatim from
-- v43, only the ladder block differs.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.scan_in(text, uuid, timestamptz, text, text, boolean);
CREATE OR REPLACE FUNCTION public.scan_in(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_nonce text DEFAULT NULL,
  p_centre text DEFAULT NULL, p_is_manual boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text; v_venue text; v_own_centre text; v_s jsonb; v_dept uuid;
  v_is_vss boolean; v_undeployed boolean;
  v_open public.dp_attendance_sessions;
  v_in_date date; v_in_time time; v_name text; v_badge text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  -- idempotency
  IF p_nonce IS NOT NULL THEN
    PERFORM 1 FROM public.dp_attendance_sessions WHERE nonce = p_nonce;
    IF FOUND THEN
      -- v43: this branch RETURNS before v_s is loaded (below) and
      -- before v_dept is computed, so both are still NULL here and
      -- the display keys cannot be reused. Re-perform the same two
      -- lookups the main body does, from the same sources:
      -- get_sewadar_by_badge ->> 'centre' is the sewadar's HOME
      -- centre, never the venue. Neither call can RAISE (an unknown
      -- badge simply yields NULL -> '' / NULL), so the dedup path
      -- still returns a clean success.
      v_s := public.get_sewadar_by_badge(p_badge);
      SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
        FROM public.deployments
       WHERE schedule_id = p_schedule AND badge_number = p_badge LIMIT 1;
      RETURN jsonb_build_object(
        'ok', true,
        'dedup', true,
        'sewadar_name', COALESCE(v_s->>'sewadar_name',''),
        'sewadar_centre', v_s->>'centre',
        'dept_name', public.dept_name_by_id(v_dept));
    END IF;
  END IF;
  IF NOT public.is_valid_badge_format(p_badge) THEN
    RAISE EXCEPTION 'Invalid badge format';
  END IF;
  v_s := public.get_sewadar_by_badge(p_badge);
  IF v_s IS NULL THEN
    RAISE EXCEPTION 'Badge not found';
  END IF;
  v_is_vss := public.is_vss_badge(p_badge);
  -- ladder: must not have OPEN.
  -- v46 fix: SELECT INTO sets FOUND; the old `v_open := f()` assignment
  -- plus `IF v_open IS NOT NULL` never fired (see file header).
  SELECT * INTO v_open FROM public.get_open_session(p_badge, p_schedule);
  IF FOUND THEN
    RAISE EXCEPTION 'Already IN — OUT first (open since % %)', v_open.in_date, v_open.in_time;
  END IF;
  -- effective dept
  SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
    FROM public.deployments
   WHERE schedule_id = p_schedule AND badge_number = p_badge LIMIT 1;
  v_undeployed := (v_dept IS NULL);
  v_in_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  -- Validate timestamp: not in the future (5-min leeway) and not older than 30 days
  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;
  IF p_ts < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Timestamp too old (more than 30 days)';
  END IF;
  v_in_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;

  -- THE SPLIT: venue goes to `centre`, accountability to
  -- in_scanner_centre. p_centre is ignored on purpose.
  v_venue      := public.attendance_venue();
  v_own_centre := public.get_portal_user_centre();
  v_badge      := public.attendance_caller_badge();
  v_name       := COALESCE(
    (SELECT name FROM public.portal_users WHERE auth_id = auth.uid()),
    v_own_centre);

  INSERT INTO public.dp_attendance_sessions(
    schedule_id, badge_number, sewadar_name, centre, sewadar_centre, sewadar_dept,
    is_vss, status, in_date, in_time,
    in_scanner_badge, in_scanner_name, in_scanner_centre,
    is_manual, undeployed_scan, nonce)
  VALUES (
    p_schedule, p_badge, COALESCE(v_s->>'sewadar_name',''),
    v_venue, v_s->>'centre', v_dept,
    v_is_vss, 'OPEN', v_in_date, v_in_time,
    v_badge, v_name, v_own_centre,
    p_is_manual, v_undeployed, COALESCE(p_nonce, gen_random_uuid()::text));
  -- v43: added sewadar_name / sewadar_centre / dept_name.
  -- 'sewadar_centre' is v_s->>'centre' (the HOME centre) — the
  -- venue lives in the session column `centre` and is not returned.
  -- dept_name is NULL for an undeployed sewadar, which is correct.
  RETURN jsonb_build_object(
    'ok', true,
    'undeployed', v_undeployed,
    'sewadar_name', COALESCE(v_s->>'sewadar_name',''),
    'sewadar_centre', v_s->>'centre',
    'dept_name', public.dept_name_by_id(v_dept));
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The ladder guard must use FOUND, never IS NOT NULL on the row:
--    Expect: zero rows.
--
-- SELECT count(*) AS still_broken
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%IF v_open IS NOT NULL%';
--
-- 2. Double-IN now raises. As a scanner: scan badge B IN, then scan B
--    IN again. The second scan must report
--    'Already IN — OUT first (open since …)' instead of opening a
--    second session. Then OUT, then IN again — must succeed.
--
-- 3. Offline replay still works: a queued IN replayed after its session
--    was closed server-side must succeed (no open row → guard silent);
--    a replay while a session is open must raise 'Already IN' (the
--    drain treats it as resolved).
