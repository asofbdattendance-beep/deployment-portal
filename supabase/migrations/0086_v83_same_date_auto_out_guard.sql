-- ============================================================
-- V83: NO SECOND SESSION ON A DATE AFTER A 21:00 AUTO-OUT
-- Run AFTER v82.
--
-- Why: the 21:00 IST sweep (v79/v80) is only for sewadars who FORGOT to
-- scan OUT. A scan later the same date must correct that session's OUT
-- time, not open a second session for the date. The app already routes
-- that scan to Mark OUT (useScanHandler + sameDayAutoOutSession); this is
-- the server-side backstop for paths the app check cannot see — an IN
-- queued offline and synced later, another device, an old cached build.
--
-- Rule (scan_in): refuse an IN when the badge already has a session on the
-- same IST in_date that the sweep closed (status CLOSED, is_auto_out).
--   * A REAL OUT earlier in the day (is_auto_out = false) is unaffected —
--     lunch-break re-entry still opens a new session.
--   * Once scan_out corrects the auto-closed session (it clears
--     is_auto_out, v80), the guard lifts on its own.
--   * Nonce replays still dedup first (an IN that already landed returns
--     its original result, never this error).
--
-- Error text contract (offlineQueue.classifyScanError / friendly):
--   'Auto-closed at 21:00 — scan OUT instead (session <uuid>)'
--
-- Body is v81's scan_in plus the guard only. Signature, grants and return
-- shape unchanged. Non-destructive; safe to re-run.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.scan_in(
  p_badge text,
  p_schedule uuid,
  p_ts timestamptz,
  p_nonce text DEFAULT NULL,
  p_centre text DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_venue text;
  v_own_centre text;
  v_s jsonb;
  v_dept uuid;
  v_is_vss boolean;
  v_undeployed boolean;
  v_open public.dp_attendance_sessions;
  v_in_date date;
  v_in_time time;
  v_name text;
  v_badge text;
  v_expected_in time;
  v_is_late_in boolean := false;
  v_auto public.dp_attendance_sessions;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;

  -- Idempotency check
  IF p_nonce IS NOT NULL THEN
    SELECT is_late_in INTO v_is_late_in
      FROM public.dp_attendance_sessions
     WHERE schedule_id = p_schedule AND nonce = p_nonce
     LIMIT 1;
    IF FOUND THEN
      v_s := public.get_sewadar_by_badge(p_badge);
      SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
        FROM public.deployments
       WHERE schedule_id = p_schedule AND badge_number = p_badge
       ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;
      RETURN jsonb_build_object(
        'ok', true,
        'dedup', true,
        'undeployed', (v_dept IS NULL),
        'late_in', COALESCE(v_is_late_in, false),
        'sewadar_name', COALESCE(v_s->>'sewadar_name',''),
        'sewadar_centre', v_s->>'centre',
        'dept_name', public.dept_name_by_id(v_dept));
    END IF;
    -- FIX #1: The SELECT INTO above overwrites the := false default with NULL
    -- when the nonce is not found (NOT FOUND). Re-default so the INSERT below
    -- never writes NULL into the NOT NULL column.
    v_is_late_in := false;
  END IF;

  IF NOT public.is_valid_badge_format(p_badge) THEN
    RAISE EXCEPTION 'Invalid badge format';
  END IF;

  v_s := public.get_sewadar_by_badge(p_badge);
  IF v_s IS NULL THEN
    RAISE EXCEPTION 'Badge not found';
  END IF;

  v_is_vss := public.is_vss_badge(p_badge);

  -- Ladder: must not have OPEN session
  SELECT * INTO v_open FROM public.get_open_session(p_badge, p_schedule);
  IF v_open.id IS NOT NULL THEN
    RAISE EXCEPTION 'Already IN — OUT first (open since % %)', v_open.in_date, v_open.in_time;
  END IF;

  -- Effective department
  SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
    FROM public.deployments
   WHERE schedule_id = p_schedule AND badge_number = p_badge
   ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;

  v_undeployed := (v_dept IS NULL);

  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;
  IF p_ts < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Timestamp too old (more than 30 days)';
  END IF;

  v_in_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_in_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;

  -- v83: ONE session per date after a forgotten OUT. The 21:00 sweep closed
  -- today's session because the OUT was forgotten; a later scan on the SAME
  -- date is that session's real OUT (scan_out pinned by id replaces the
  -- is_auto_out close), never a second session. A REAL OUT earlier in the day
  -- does not trip this (is_auto_out = false), so lunch-break re-entry stays a
  -- new IN. The session id rides in the message so the offline drain can turn
  -- a queued IN into the OUT it actually was.
  SELECT * INTO v_auto
    FROM public.dp_attendance_sessions
   WHERE schedule_id = p_schedule
     AND badge_number = p_badge
     AND status = 'CLOSED'
     AND is_auto_out
     AND in_date = v_in_date
   ORDER BY in_time DESC
   LIMIT 1;
  IF v_auto.id IS NOT NULL THEN
    RAISE EXCEPTION 'Auto-closed at 21:00 — scan OUT instead (session %)', v_auto.id;
  END IF;

  -- Evaluate shift cutoff for Late In
  IF v_dept IS NOT NULL THEN
    SELECT COALESCE(sdt.expected_in_time, d.expected_in_time) INTO v_expected_in
      FROM public.deployment_departments d
      LEFT JOIN public.schedule_department_timings sdt
        ON sdt.department_id = d.id AND sdt.schedule_id = p_schedule
     WHERE d.id = v_dept;
    IF v_expected_in IS NOT NULL AND v_in_time > v_expected_in THEN
      v_is_late_in := true;
    END IF;
  END IF;

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
    is_manual, undeployed_scan, nonce, is_late_in)
  VALUES (
    p_schedule, p_badge, COALESCE(v_s->>'sewadar_name',''),
    v_venue, v_s->>'centre', v_dept,
    v_is_vss, 'OPEN', v_in_date, v_in_time,
    v_badge, v_name, v_own_centre,
    p_is_manual, v_undeployed, COALESCE(p_nonce, gen_random_uuid()::text), v_is_late_in);

  RETURN jsonb_build_object(
    'ok', true,
    'undeployed', v_undeployed,
    'late_in', v_is_late_in,
    'sewadar_name', COALESCE(v_s->>'sewadar_name',''),
    'sewadar_centre', v_s->>'centre',
    'dept_name', public.dept_name_by_id(v_dept));
END;
$$;

REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) TO authenticated, service_role;

-- Version registry (v50 convention: append own row only).
INSERT INTO public.portal_version (version) VALUES ('v83')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
-- 1. Version: expect 'v83'.
-- SELECT public.portal_app_version();
--
-- 2. Guard present in the live body: expect t.
-- SELECT prosrc LIKE '%Auto-closed at 21:00%' FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in';
--
-- 3. Badges the guard would block right now (auto-closed today, IST):
-- SELECT badge_number, schedule_id, in_time, out_time
--   FROM public.dp_attendance_sessions
--  WHERE status = 'CLOSED' AND is_auto_out
--    AND in_date = (now() AT TIME ZONE 'Asia/Kolkata')::date;
