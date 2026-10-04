-- ============================================================
-- V67: scan_out CARRIES THE MANUAL FLAG (p_is_manual).
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- scan_in has taken p_is_manual since v26 (stored on the session's
-- is_manual, surfaced in Scanner Ops manual_scans) — but scan_out never
-- declared the parameter, so a hand-typed OUT (manual badge entry, or the
-- forgot-OUT form's operator-entered time) closed the session with no audit
-- mark, and a queued offline OUT drained with no mark either. E2E M8 only
-- ever asserted the IN direction, so the gap was invisible to the matrix.
--
-- The fix mirrors scan_in exactly: an optional trailing
-- p_is_manual boolean DEFAULT false, OR-ed into the session flag on close
-- (a manual OUT of a camera IN is still manual-touch; OR preserves a manual
-- IN closed by camera). DEFAULT false keeps every existing caller working —
-- a client that has not been updated simply records non-manual, as before.
--
-- BACKWARD COMPATIBILITY: the old 4-arg overload is dropped first (same
-- pattern as v56 §4 — otherwise the two signatures are ambiguous to
-- PostgREST). A new client against an OLD server gets PGRST202, which the
-- offline drain already treats as deploy-ordering (skip like network, burn
-- no attempt — C4), so rows wait for the deploy instead of quarantining.
--
-- This is a PURE function change: no table, column, index, trigger, RLS
-- policy or other function is created, altered or dropped — one DROP plus
-- one CREATE OR REPLACE. Re-running is safe.
--
-- Apply AFTER v56 (the scan_out body this copies). Non-destructive.
-- ============================================================

BEGIN;

-- Drop the 4-arg overload so PostgREST sees exactly one scan_out.
DROP FUNCTION IF EXISTS public.scan_out(text, uuid, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.dp_attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text;
BEGIN
  v_role := public.get_portal_user_role();
  -- v56: NULL-safe (a missing role is denied, not admitted).
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  IF p_open_id IS NOT NULL THEN
    -- v41 fix 1: no `AND status='OPEN'` here. Filtering the status away made
    -- the idempotency branch below unreachable.
    --
    -- v41 fix 2: `FOUND`, not `v_open IS NOT NULL`. For a plpgsql ROW variable
    -- `IS NOT NULL` does NOT answer "did the lookup return a row?" — verified
    -- on Postgres 15. `FOUND` is what SELECT INTO actually sets.
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
  -- and stale (> 30d) timestamps. Same bounds here, same messages.
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
  -- v67: OR the manual flag — a manual OUT of a camera IN is still
  -- manual-touch, and OR preserves a manual IN closed by camera.
  UPDATE public.dp_attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, is_manual=(is_manual OR COALESCE(p_is_manual, false)), updated_at=now() WHERE id=v_open.id;
  -- v43: added sewadar_name / sewadar_centre / dept_name.
  RETURN jsonb_build_object(
    'ok', true,
    'sewadar_name', COALESCE(v_open.sewadar_name,''),
    'sewadar_centre', v_open.sewadar_centre,
    'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
END; $$;

-- Repo convention: state the grants even though CREATE OR REPLACE
-- preserves them — they are the security contract of this function.
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) TO authenticated;

-- ------------------------------------------------------------
-- Version registry (convention from v50: one row per migration).
-- Without this row portal_app_version() still reports v66 and the app
-- banner keeps saying the DB needs v67+ — even with scan_out applied.
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v67')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. Exactly one scan_out overload remains, with 5 args. Expect: 1 | 5.
--
-- SELECT count(*) AS overloads,
--        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--          WHERE n.nspname = 'public' AND p.proname = 'scan_out'
--          AND pg_get_function_arguments(p.oid) LIKE '%p_is_manual%') AS with_manual
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_out';
--
-- 2. Old 4-arg callers still work (DEFAULT NULL + DEFAULT false).
--    As a scanner: close an open session passing only 4 args — expect ok:true.
--
-- 3. Manual OUT marks the session. Expect: t.
--
-- SELECT is_manual AS manual_marked
--   FROM public.dp_attendance_sessions WHERE id = '<closed-with-manual-true>';
--
-- 4. Non-manual OUT preserves a manual IN (OR, never overwrite). Expect: t.
--
-- 5. The version registry recorded the migration. Expect: v67.
--
--   SELECT version FROM public.portal_version WHERE version = 'v67';
--
-- 6. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
