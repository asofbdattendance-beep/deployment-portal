-- ============================================================
-- V43: SCAN RPC DISPLAY FIELDS (NAME + HOME CENTRE + DEPARTMENT)
--
-- Run AFTER v39, v40, v41 and v42. Non-destructive; safe to re-run.
--
-- ------------------------------------------------------------
-- THE PROBLEM THIS FIXES
-- ------------------------------------------------------------
-- After a successful scan, the React scan popup (ScannerPage /
-- DeptInchargePage) can only show the BADGE NUMBER, because
-- `scan_in` and `scan_out` return a bare acknowledgement:
--
--   scan_in  → {"ok": true, "undeployed": <bool>}
--   scan_out → {"ok": true}
--
-- Displaying anything else — the sewadar's name, which CENTRE they
-- belong to, which department they are deployed to — therefore
-- required a SECOND round-trip after every single scan: an extra
-- `get_sewadar_by_badge` plus a department lookup, racing the
-- operator's next scan and failing silently whenever the operator
-- moved on before it resolved.
--
-- Every value needed is ALREADY resolved inside both functions at
-- the moment they return. The data is there; only the reply shape
-- hides it.
--
-- ------------------------------------------------------------
-- THE FIX
-- ------------------------------------------------------------
-- Add three keys to EVERY return path of both functions:
--
--   sewadar_name   text   — the sewadar's display name
--   sewadar_centre text   — the sewadar's HOME centre
--   dept_name      text   — the deployed department's name (NULL
--                           when the sewadar is undeployed)
--
-- The client reads them if present and falls back to the bare badge
-- if not, so nothing is forced to change at the same time as the
-- database.
--
-- ------------------------------------------------------------
-- VENUE vs HOME CENTRE — READ THIS BEFORE EDITING
-- ------------------------------------------------------------
-- v40 split the three jobs one column used to do, and this change
-- MUST NOT collapse them back:
--
--   centre            → the VENUE (a single constant, e.g.
--                       "Bhati - Delhi MC"). Informational ONLY.
--   sewadar_centre    → the sewadar's HOME centre. THIS is the
--                       scope + reporting key, and it is the value
--                       returned here.
--   in_scanner_centre → the OPERATOR's own centre.
--
-- `dp_attendance_sessions.centre` is the venue and is meaningless to
-- the client, so it is never returned, and the key
-- `sewadar_centre` NEVER carries it. In `scan_in` the home centre
-- comes from `get_sewadar_by_badge(...)->>'centre'` (a lookup on the
-- sewadar's own row, which is independent of the session row); in
-- `scan_out` it comes from the session's own `sewadar_centre`
-- column, written by v40 at insert time.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- No existing key is removed, renamed, or retyped, and no existing
-- value changes. Callers that already read `data.ok`,
-- `data.undeployed` (scan_in), `data.dedup` or `data.message`
-- (scan_out) are unaffected — the new keys are simply additional
-- members of the same JSON object.
--
-- This is a pure RPC-RESPONSE change. No table, column, index,
-- trigger, or RLS policy is created, altered or dropped, and no
-- data is written or modified. Both functions keep their exact
-- signatures, their SECURITY DEFINER + `SET search_path = ''`
-- posture, their authorisation ladder, their idempotency
-- semantics, and every guard, validation and RAISE.
--
-- ------------------------------------------------------------
-- NOTE ON THE TWO SOURCE DEFINITIONS
-- ------------------------------------------------------------
--  * `scan_in` is copied from v40 (the current live definition).
--    Its signature is SIX arguments — (text, uuid, timestamptz,
--    text, text, boolean): p_centre is retained for caller
--    compatibility and is deliberately ignored.
--  * `scan_out` is copied from v41, NOT from v28. v41 redefines
--    `scan_out` in full (DROP + CREATE OR REPLACE) and is therefore
--    the live body. Copying v28's older copy would silently REVERT
--    v41: it would restore the unreachable `AND status='OPEN'`
--    lookup, the dead `v_open IS NOT NULL` tests, and the silently-
--    closing badge/schedule mismatch guard. Every v41 fix is
--    preserved here, including its inline explanatory comments.
--
-- The nonce-dedup branch inside `scan_in` is the one place the
-- display values cannot simply be reused: it RETURNs BEFORE
-- `v_s` is loaded and BEFORE `v_dept` is computed, so both are
-- still NULL there. The branch is left exactly where it is —
-- moving it later would change behaviour, since a repeated nonce
-- must still short-circuit ahead of badge validation — and the two
-- lookups are re-performed inside it instead. The dedup path also
-- gains no `undeployed` key: it never had one, and inventing one
-- here is out of scope for an additive change.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. scan_in — add the three display keys to both return paths.
--    Body copied verbatim from v40; only the RETURNs differ.
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
  -- ladder: must not have OPEN
  v_open := public.get_open_session(p_badge, p_schedule);
  IF v_open IS NOT NULL THEN
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
-- 2. scan_out — add the same three keys to both return paths.
--    Body copied verbatim from v41 (NOT v28 — v41 is the live
--    definition and its p_open_id fixes are preserved here);
--    only the RETURNs differ.
--    v_open is a fully loaded row on BOTH paths: the dedup path is
--    guarded by `FOUND AND v_open.status = 'CLOSED'`, and the final
--    path is guarded by the 'No open session to close' RAISE above.
--    So v_open.sewadar_name / .sewadar_centre / .sewadar_dept are
--    all safe to read. `sewadar_centre` is the HOME centre column
--    v40 writes at insert time — never the venue in `centre`.
-- ------------------------------------------------------------
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

COMMIT;

-- ============================================================
-- === VERIFICATION (read-only) ===
-- ============================================================
--
-- 1. Both functions are installed and BOTH carry the new keys.
--    Expect 2 rows. prosrc holds the function body verbatim, so the
--    LIKE patterns below are a reliable "is the new code live?"
--    check that does not need a scan to be performed.
--
-- SELECT p.proname,
--        p.pronargs,
--        p.proname IN ('scan_in','scan_out')         AS is_target,
--        p.prosrc LIKE '%sewadar_centre%'            AS has_sewadar_centre,
--        p.prosrc LIKE '%dept_name%'                 AS has_dept_name,
--        p.prosrc LIKE '%dept_name_by_id%'          AS uses_existing_helper,
--        p.prosrc LIKE '%attendance_venue()%'        AS still_writes_venue
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('scan_in','scan_out');
--
--    Expected: 2 rows, is_target = t, has_sewadar_centre = t,
--    has_dept_name = t, uses_existing_helper = t. For scan_in,
--    still_writes_venue = t (v40's venue split is untouched).
--
-- 2. Confirm the venue never leaks into the display payload.
--    The session row must hold the venue in `centre` and the HOME
--    centre in `sewadar_centre`; the two are expected to differ for
--    every row, which is exactly why `centre` is never returned.
--
-- SELECT badge_number, centre AS venue_column, sewadar_centre AS home_centre,
--        sewadar_dept IS NOT NULL AS deployed
--   FROM public.dp_attendance_sessions
--  WHERE schedule_id = '<paste-a-real-schedule-uuid>'
--  ORDER BY created_at DESC
--  LIMIT 10;
--
-- 3. A real scan_in reply carrying the three keys. Substitute a
--    badge and schedule you are allowed to scan, then check the
--    returned JSON object directly. `sewadar_centre` must read as
--    the sewadar's own CENTRE, and `dept_name` is NULL when that
--    sewadar is undeployed.
--
-- SELECT public.scan_in(
--          '<paste-a-real-badge>',
--          '<paste-a-real-schedule-uuid>',
--          now()
--        ) AS scan_in_reply;
--
--    Expected shape:
--      {"ok": true, "undeployed": false,
--       "sewadar_name": "<name>",
--       "sewadar_centre": "<home centre>",
--       "dept_name": "<dept>"}
--
--    Repeat a scan of the same badge with the same nonce to exercise
--    the dedup branch, which returns the same three keys:
--
-- SELECT public.scan_in(
--          '<paste-a-real-badge>',
--          '<paste-a-real-schedule-uuid>',
--          now(),
--          '<the-nonce-you-just-used>'
--        ) AS scan_in_dedup_reply;
--
--    Expected: {"ok": true, "dedup": true, "sewadar_name": ...,
--    "sewadar_centre": ..., "dept_name": ...} — note there is no
--    "undeployed" key on the dedup path, exactly as before v43.
--
-- 4. scan_out reply. Scan the same badge out, then repeat the OUT
--    against the same open id to exercise its dedup branch.
--
-- SELECT public.scan_out(
--          '<paste-a-real-badge>',
--          '<paste-a-real-schedule-uuid>',
--          now()
--        ) AS scan_out_reply;
--
--    Expected: {"ok": true, "sewadar_name": ..., "sewadar_centre": ...,
--    "dept_name": ...}
--
-- 5. IF v43 IS NOT APPLIED YET, the client degrades gracefully and
--    NOTHING ERRORS. The old replies are still valid objects:
--    scan_in returns {"ok":true,"undeployed":...} and scan_out
--    returns {"ok":true} (plus dedup/message on the repeat path).
--    A client that reads data.sewadar_name / data.sewadar_centre /
--    data.dept_name therefore gets undefined and falls back to
--    showing the badge alone. Every existing caller reading
--    data.ok / data.undeployed / data.dedup / data.message is
--    unaffected in BOTH directions, so v43 can be deployed before,
--    with, or after the client change.
-- ============================================================
