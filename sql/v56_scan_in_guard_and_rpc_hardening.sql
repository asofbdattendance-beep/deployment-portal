-- ============================================================
-- V56 — SCAN_IN LADDER GUARD THAT SURVIVES A FROM-FUNCTION MISS,
--       NULL-SAFE ROLE GATES, SCAN_OUT TIMESTAMP BOUNDS, RPC GRANTS
-- ============================================================
-- Run AFTER v55. Non-destructive; safe to re-run (DROP + CREATE OR
-- REPLACE per repo convention; no table, column, index, trigger or
-- RLS policy touched).
--
-- THREE DEFECTS, ONE FILE.
--
-- (1) THE LADDER STILL FIRES WITH NOTHING OPEN (v46 bug live).
-- v46 replaced the dead `v_open := f()` + `IF v_open IS NOT NULL`
-- with `SELECT * INTO v_open FROM get_open_session(...)` +
-- `IF FOUND`. That trades one dead test for a live false positive:
-- get_open_session() returns a single COMPOSITE (not SETOF), and a
-- composite-returning function that returns SQL NULL still yields
-- ONE all-NULL row through the FROM clause — so FOUND is TRUE on a
-- miss too, and the very first scan of a badge with no open session
-- raises 'Already IN — OUT first (open since <null> <null>)'. The
-- discriminator that survives both shapes is the row's PRIMARY KEY:
-- `id` is NOT NULL on a real session and NULL on the all-NULL miss
-- row. Hence the new guard below:
--
--   SELECT * INTO v_open FROM public.get_open_session(p_badge, p_schedule);
--   IF v_open.id IS NOT NULL THEN RAISE ... END IF;
--
-- Never `IF FOUND` on a FROM-function call, never `IS NOT NULL` on
-- the row variable itself (FALSE even with a real row loaded — v41).
-- Nothing else in scan_in changes: the body is otherwise copied
-- verbatim from v46 (which is v43 + the ladder block).
--
-- (2) THE ROLE GATE ADMITS CALLERS WITH NO ROLE. scan_in, scan_out,
-- get_open_session and get_scan_state all guard with a bare
-- `IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin')`.
-- `NULL NOT IN (...)` is NULL, not TRUE, so the IF never fires for a
-- caller with NO portal role (SQL-editor session, unknown JWT) and
-- execution falls through to the writes. All four gates become
--
--   IF v_role IS NULL OR v_role NOT IN (...) THEN RAISE ... END IF;
--
-- A missing role is denied — fail closed, matching the v39/v40
-- attendance scope posture (vss_operator stays denied everywhere).
--
-- (3) scan_out NEVER VALIDATED p_ts. scan_in rejects timestamps in
-- the future (> now() + 5 minutes leeway) and older than 30 days;
-- scan_out accepted anything, so a skewed or replayed clock could
-- write an OUT years away from its IN (and past the
-- 'OUT must be after IN' check in the wrong direction). The same two
-- bounds, with the same messages, are added to scan_out. Its body is
-- otherwise copied verbatim from v43 (which is v41 + display keys).
--
-- (4) GRANTS STATED EXPLICITLY. The four functions are SECURITY
-- DEFINER and resolve the caller's own scope inside the body, so
-- they are callable by any signed-in user and by nobody else:
-- REVOKE ALL FROM PUBLIC and from anon, GRANT EXECUTE TO
-- authenticated — the same pattern v55 uses for attendance_badge_dept.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. get_open_session — NULL-safe role gate only.
--    Body copied verbatim from v42; only the gate differs.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_open_session(text, uuid);
CREATE OR REPLACE FUNCTION public.get_open_session(p_badge text, p_schedule uuid)
RETURNS public.dp_attendance_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.dp_attendance_sessions; v_role text;
BEGIN
  -- v56: NULL-safe. The old bare `NOT IN` let a caller with no portal
  -- role through (`NULL NOT IN (...)` is NULL, never TRUE).
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_row FROM public.dp_attendance_sessions
   WHERE badge_number = p_badge AND schedule_id = p_schedule AND status='OPEN' LIMIT 1;
  -- v42: a miss must be SQL NULL so PostgREST sends JSON null. Returning v_row
  -- directly sent an all-NULL record, which serialises to a truthy object and
  -- every caller misread it as an open session. `FOUND`, not `IS NOT NULL` —
  -- the latter is false for a plpgsql row variable even when it holds a row.
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_row;
END; $$;

-- ------------------------------------------------------------
-- 2. get_scan_state — NULL-safe role gate only.
--    Body copied verbatim from v44; only the gate differs.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scan_state(p_badge text, p_schedule uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_open  jsonb;
  v_last  jsonb;
  v_role  text;
BEGIN
  -- v44: a pure read. The same four roles v40's get_open_session
  -- accepts, and the same refusal for everyone else — vss_operator
  -- included, so this fails closed exactly like the path it mirrors.
  -- v56: NULL-safe (a missing role is denied, not admitted).
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- open session (row is NULL on a miss)
  SELECT to_jsonb(t) INTO v_open
    FROM public.dp_attendance_sessions t
   WHERE t.badge_number = p_badge
     AND t.schedule_id = p_schedule
     AND t.status = 'OPEN'
   LIMIT 1;

  -- most recently CLOSED session (row is NULL when the sewadar never scanned OUT)
  SELECT to_jsonb(t) INTO v_last
    FROM public.dp_attendance_sessions t
   WHERE t.badge_number = p_badge
     AND t.schedule_id = p_schedule
     AND t.status = 'CLOSED'
     AND t.out_date IS NOT NULL
   ORDER BY t.out_date DESC, t.out_time DESC
   LIMIT 1;

  -- v44: jsonb_build_object renders a NULL jsonb as JSON `null`, so
  -- "not open" and "never scanned out" are unambiguous. The v42
  -- all-NULL-record trap cannot recur here: on a miss v_open/v_last
  -- hold SQL NULL in a jsonb column, never a record of nulls.
  RETURN jsonb_build_object('open', v_open, 'last_out', v_last);
END; $$;

-- ------------------------------------------------------------
-- 3. scan_in — new ladder guard + NULL-safe role gate.
--    Body copied verbatim from v46; only those two blocks differ.
--    (Nonce dedup stays global and the dedup path still carries no
--    `undeployed` key — v57 scopes both. The effective-dept lookup
--    stays LIMIT 1 without ORDER BY — v57 makes it deterministic.)
-- ------------------------------------------------------------
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
  -- v56: NULL-safe. `NULL NOT IN (...)` is NULL, not TRUE, so the old
  -- bare `NOT IN` let a caller with NO portal role (SQL editor, unknown
  -- JWT) straight through to the writes. A missing role is denied.
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
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
  -- v56 fix: test the row's PRIMARY KEY, never FOUND and never the row
  -- variable. `SELECT ... FROM get_open_session(...)` reads the function
  -- through the FROM clause, and a composite-returning function that
  -- returns SQL NULL still yields ONE all-NULL row there — so FOUND is
  -- TRUE on a miss too, and v46's `IF FOUND` raised 'Already IN' on the
  -- very first scan of a badge with no open session. The old
  -- `IF v_open IS NOT NULL` was no better (FALSE even with a real row
  -- loaded — see v41). `id` is the table PK: NOT NULL on a real
  -- session, NULL on the all-NULL miss row. That is the discriminator.
  SELECT * INTO v_open FROM public.get_open_session(p_badge, p_schedule);
  IF v_open.id IS NOT NULL THEN
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

-- ------------------------------------------------------------
-- 4. scan_out — NULL-safe role gate + p_ts bounds.
--    Body copied verbatim from v43 (which is v41 + display keys);
--    only the gate and the new bounds differ. The v41 fixes are
--    preserved: lookup by id ALONE (no `AND status='OPEN'`), the
--    mismatch guard tested with FOUND, the CLOSED dedup tested with
--    `FOUND AND status = 'CLOSED'`.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.scan_out(text, uuid, timestamptz, uuid);
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.dp_attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text;
BEGIN
  v_role := public.get_portal_user_role();
  -- v56: NULL-safe (see scan_in — a missing role is denied).
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
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
      -- v43: added sewadar_name / sewadar_centre / dept_name.
      -- sewadar_centre is the HOME centre column, not the venue.
      RETURN jsonb_build_object(
        'ok', true,
        'dedup', true,
        'message', 'Session already closed',
        'sewadar_name', COALESCE(v_open.sewadar_name,''),
        'sewadar_centre', v_open.sewadar_centre,
        'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
    END IF;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
  END IF;
  IF v_open IS NULL THEN RAISE EXCEPTION 'No open session to close'; END IF;
  -- v56: scan_out never validated p_ts; scan_in rejects future (> now()+5m)
  -- and stale (> 30d) timestamps. Same bounds here, same messages, so a
  -- skewed or replayed clock cannot write an OUT years from its IN.
  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;
  IF p_ts < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Timestamp too old (more than 30 days)';
  END IF;
  v_out_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_out_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  IF v_out_date < v_open.in_date OR (v_out_date = v_open.in_date AND v_out_time <= v_open.in_time) THEN
    RAISE EXCEPTION 'OUT time must be after IN time';
  END IF;
  v_centre := public.get_portal_user_centre();
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  UPDATE public.dp_attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, updated_at=now() WHERE id=v_open.id;
  -- v43: added sewadar_name / sewadar_centre / dept_name.
  RETURN jsonb_build_object(
    'ok', true,
    'sewadar_name', COALESCE(v_open.sewadar_name,''),
    'sewadar_centre', v_open.sewadar_centre,
    'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
END; $$;

-- ------------------------------------------------------------
-- 5. Grants, stated rather than inherited. All four functions are
--    SECURITY DEFINER and resolve the caller's own scope inside the
--    body (fail closed for every other role), so they are callable
--    by any signed-in user and by nobody else.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_open_session(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_open_session(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_open_session(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_scan_state(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_scan_state(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_scan_state(text, uuid) TO authenticated;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The new ladder guard is live, and the v46 false positive is gone.
--    Expect: 1 (guard present), then 0 (no FOUND-tested ladder remains —
--    the remaining `IF FOUND` hits are the nonce-dedup and p_open_id
--    lookups against the TABLE, which is what SELECT INTO sets FOUND for).
--
-- SELECT count(*) AS ladder_pk_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%IF v_open.id IS NOT NULL%';
--
-- SELECT count(*) AS found_tested_ladder
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%IF FOUND THEN%Already IN%';
--
-- 2. All four role gates are NULL-safe. Expect: 4.
--
-- SELECT count(*) AS null_safe_gates
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('scan_in','scan_out','get_open_session','get_scan_state')
--    AND p.prosrc LIKE '%IS NULL OR%NOT IN%scanner%';
--
-- 3. Both scan RPCs now bound p_ts. Expect: 2.
--
-- SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname IN ('scan_in','scan_out')
--    AND p.prosrc LIKE '%Timestamp cannot be in the future%';
--
-- 4. A caller with NO portal role is now denied, not admitted. Run as a
--    signed-in user with no portal_users row (or the SQL editor): expect
--    ERROR on all four, with no row written by the scan_in attempt.
--
-- SELECT public.scan_in('VS00000', '00000000-0000-0000-0000-000000000000'::uuid, now());
--                                    -- expect: ERROR: Not authorized to scan
-- SELECT public.get_open_session('VS00000', '00000000-0000-0000-0000-000000000000'::uuid);
--                                    -- expect: ERROR: Not authorized
-- SELECT public.get_scan_state('VS00000', '00000000-0000-0000-0000-000000000000'::uuid);
--                                    -- expect: ERROR: Not authorized
--
-- 5. End-to-end ladder (the CI V1 gate replays this on a scratch DB).
--    As a scanner: scan badge B IN (fresh nonce) — expect ok:true. Scan B
--    IN again (fresh nonce) — expect 'Already IN — OUT first (open since
--    <date> <time>)' with REAL dates. Before v56 the FIRST call already
--    raised 'Already IN' with null dates — that is the v46 bug, and the
--    null date/time in the message is its signature.
--
-- 6. scan_out bounds: OUT with p_ts a year ago or tomorrow must raise
--    'Timestamp too old' / 'Timestamp cannot be in the future' instead of
--    writing the row.
--
-- 7. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
-- ============================================================
