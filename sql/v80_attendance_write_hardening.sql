-- ============================================================
-- V80: ATTENDANCE WRITE HARDENING — December 2026 readiness.
--
-- Five confirmed defects from the pre-event DB audit, fixed in one file.
-- Nothing here adds a column or an RPC the client calls, so the frontend
-- floor (MIN_SUPPORTED_DB_VERSION) stays v79: a v79 database and a v80
-- database serve the same app.
--
-- ------------------------------------------------------------
-- 1. AUTO-OUT SWEEP CLOSED PEOPLE STILL ON SITE (v79)
-- ------------------------------------------------------------
-- attendance_auto_close_open_sessions() closed every session opened TODAY
-- before 21:00 — whatever the time it actually ran. v79's own verification
-- step 3 tells the operator to run it by hand; run at 10:00 IST on an event
-- day it would stamp everybody present OUT at a FUTURE 21:00, tagged
-- is_auto_out. A scheduler firing early (GitHub Actions drift, a mis-set
-- cron expression, a UTC/IST mix-up) does the same.
--   Fix: today's sessions are swept only once the sweep's own IST clock has
--   reached 21:00. Earlier days are swept at any hour, as before. A p_ts in
--   the future is refused outright.
--
-- Also: v78's loop grants authenticated EXECUTE on EVERY public SECURITY
-- DEFINER function and is documented "safe to re-run" — re-running it
-- after v79 silently undoes v79's REVOKE, letting any logged-in user
-- mass-close every open session. The function now refuses any end-user
-- caller in its body, so a grant alone can never expose it again.
--
-- ------------------------------------------------------------
-- 2. SESSIONS WRITABLE DIRECTLY OVER POSTGREST (v28 att_insert, v40 att_update)
-- ------------------------------------------------------------
-- att_insert let any scanning role INSERT an arbitrary row (any badge,
-- date, status, is_auto_out). att_update let centre_user/centre_admin
-- UPDATE any session of their centre's sewadars, and any scanner UPDATE
-- every row they ever scanned (badge_number, in_date, ...). A single
-- PATCH /rest/v1/dp_attendance_sessions fakes presence.
--   Nothing legitimate needs them: the client only SELECTs this table
--   (src/pages/ScannerPage.jsx, src/hooks/useAnomalyDetail.js), and the
--   only writers are scan_in, scan_out and the auto-out sweep — all
--   SECURITY DEFINER, owned by the table owner, and the table has no FORCE
--   ROW LEVEL SECURITY, so they are unaffected by these policies.
--   Fix: drop both policies and revoke the write privileges from the API
--   roles. att_read (SELECT) and realtime are untouched.
--
-- ------------------------------------------------------------
-- 3. ANON COULD WIPE THE LOGIN THROTTLE (v73, re-granted in v78 §3d)
-- ------------------------------------------------------------
-- The anon key ships in the bundle. check_login_rate('x','y',1,-1) runs
-- DELETE ... WHERE attempted_at < now() + 1s — emptying login_attempts and
-- defeating resolve-login's throttle. Anon could also lock out a known
-- badge for a shared event-wifi IP.
--   v78 §3d listed it as "pre-auth" — but the only callers are the
--   resolve-login and create-login edge functions, which call it with the
--   SERVICE ROLE client. Throttling is pre-auth for the USER, not for the
--   caller of this function.
--   Fix: revoke from anon/authenticated, refuse end-user callers in the
--   body (survives a v78 re-run), and clamp the window/max to sane bounds.
--
-- ------------------------------------------------------------
-- 4. ARCHIVED / DEACTIVATED / FORCED-OUT LOGINS KEPT SESSION ACCESS (v40)
-- ------------------------------------------------------------
-- attendance_caller_badge() matched on auth_id only. v69/v70 taught the
-- role helpers to fail closed on is_active / archived_at / force_logout_at,
-- but att_read's "rows I scanned" arm goes through this helper, so a
-- killed scanner's still-valid JWT kept reading every session it scanned.
--   Fix: the same three predicates as get_portal_user_role() (v77).
--
-- ------------------------------------------------------------
-- 5. scan_out CHECK-THEN-UPDATE RACE (v67)
-- ------------------------------------------------------------
-- The open row was read without a lock and closed with WHERE id = ... only.
-- Two phones (or a live scan and an offline replay) both answered
-- "OUT marked" and the last writer won out_time/scanner. A scan_out racing
-- the 21:00 sweep left a real scanner on a row still tagged is_auto_out.
--   Fix: the row is locked FOR UPDATE before it is judged; the loser of a
--   race now sees CLOSED and gets the existing dedup answer. A REAL OUT
--   arriving after the sweep auto-closed the row replaces the synthetic
--   21:00 and clears is_auto_out — a real scan is the better record, and it
--   still has to be after the IN.
--
-- Re-running this file is safe.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Auto-out sweep: clock guard + server-only body guard.
--    Signature unchanged, so v79's grants (service_role only) carry over;
--    they are re-stated in §6 regardless.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_auto_close_open_sessions(
  p_ts timestamptz DEFAULT now()
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ist_date date;
  v_ist_time time;
  v_closed   integer;
BEGIN
  -- Server routine: pg_cron, the SQL editor and the service-role key carry
  -- no end-user identity. Any logged-in or anon caller is refused even if a
  -- later grant (a v78 re-run) exposes the function at /rest/v1/rpc.
  IF auth.uid() IS NOT NULL OR COALESCE(auth.jwt()->>'role', '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'attendance_auto_close_open_sessions is server-only';
  END IF;
  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;

  v_ist_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_ist_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;

  UPDATE public.dp_attendance_sessions s
     SET status      = 'CLOSED',
         out_date    = s.in_date,
         out_time    = CASE WHEN s.in_time < TIME '21:00' THEN TIME '21:00'
                            ELSE TIME '23:59:59.999999' END,
         is_auto_out = true,
         updated_at  = now()
   WHERE s.status = 'OPEN'
     AND (s.in_date < v_ist_date
          -- Today's INs only once it is actually 21:00 IST or later — a
          -- daytime run must never close someone who is still on site.
          OR (s.in_date = v_ist_date
              AND s.in_time < TIME '21:00'
              AND v_ist_time >= TIME '21:00'));

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END; $$;

-- ------------------------------------------------------------
-- 2. No direct session writes from the API roles.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS att_insert ON public.dp_attendance_sessions;
DROP POLICY IF EXISTS att_update ON public.dp_attendance_sessions;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.dp_attendance_sessions FROM anon, authenticated;

-- ------------------------------------------------------------
-- 3. Login throttle: service-role only, bounded inputs.
--    Callers: resolve-login (10 / 900s), create-login (30 / 60s).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_login_rate(
  p_ip text, p_identity text, p_max int, p_window_secs int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count  int;
  v_max    int := LEAST(GREATEST(COALESCE(p_max, 10), 1), 100);
  v_window interval := make_interval(secs => LEAST(GREATEST(COALESCE(p_window_secs, 900), 60), 3600));
BEGIN
  IF auth.uid() IS NOT NULL OR COALESCE(auth.jwt()->>'role', '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'check_login_rate is server-only';
  END IF;
  -- Prune with the FIXED ceiling, never the caller's window: a short window
  -- must not be able to delete another caller's still-live attempts.
  DELETE FROM public.login_attempts
    WHERE attempted_at < now() - interval '3600 seconds';
  SELECT count(*) INTO v_count
    FROM public.login_attempts
    WHERE ip = p_ip AND identity = p_identity
      AND attempted_at >= now() - v_window;
  IF v_count >= v_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.login_attempts (ip, identity) VALUES (p_ip, p_identity);
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- 4. attendance_caller_badge fails closed like the role helpers (v77).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_caller_badge()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT p.badge_number FROM public.portal_users p
           WHERE p.auth_id = auth.uid()
             AND p.is_active = true
             AND p.archived_at IS NULL
             AND (p.force_logout_at IS NULL
                  OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
                      >= EXTRACT(EPOCH FROM p.force_logout_at)::bigint));
$$;

-- ------------------------------------------------------------
-- 5. scan_out: lock before judging, close only what is still closable.
--    v67 body otherwise verbatim (same checks, messages and response).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.dp_attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text; v_found boolean;
BEGIN
  v_role := public.get_portal_user_role();
  -- v56: NULL-safe (a missing role is denied, not admitted).
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  IF p_open_id IS NOT NULL THEN
    -- v41: no `AND status='OPEN'` (keeps the idempotency branch reachable)
    -- and `FOUND`, not `v_open IS NOT NULL`, for a ROW variable.
    -- v80: FOR UPDATE — a concurrent close waits here, then reads CLOSED.
    SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = p_open_id LIMIT 1 FOR UPDATE;
    v_found := FOUND;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
    v_found := v_open.id IS NOT NULL;
    -- v80: re-read under a row lock; it may have closed since the lookup.
    IF v_found THEN
      SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = v_open.id FOR UPDATE;
      v_found := FOUND;
    END IF;
  END IF;
  IF v_found AND (v_open.badge_number <> p_badge OR v_open.schedule_id <> p_schedule) THEN
    RAISE EXCEPTION 'Session does not match badge/schedule';
  END IF;
  -- Already closed by a real scan → success (idempotent). A row closed by
  -- the 21:00 sweep (is_auto_out) falls through: this real OUT replaces it.
  IF v_found AND v_open.status = 'CLOSED' AND NOT v_open.is_auto_out THEN
    -- v43: sewadar_centre is the HOME centre column, not the venue.
    RETURN jsonb_build_object(
      'ok', true,
      'dedup', true,
      'message', 'Session already closed',
      'sewadar_name', COALESCE(v_open.sewadar_name,''),
      'sewadar_centre', v_open.sewadar_centre,
      'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
  END IF;
  IF NOT v_found THEN RAISE EXCEPTION 'No open session to close'; END IF;
  -- v56: same p_ts bounds as scan_in, same messages.
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
  -- v67: OR the manual flag. v80: only a still-closable row is written, and
  -- a real OUT always clears the sweep's tag.
  UPDATE public.dp_attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, is_manual=(is_manual OR COALESCE(p_is_manual, false)), is_auto_out=false, updated_at=now()
   WHERE id=v_open.id AND (status='OPEN' OR is_auto_out);
  -- v43: added sewadar_name / sewadar_centre / dept_name.
  RETURN jsonb_build_object(
    'ok', true,
    'sewadar_name', COALESCE(v_open.sewadar_name,''),
    'sewadar_centre', v_open.sewadar_centre,
    'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
END; $$;

-- ------------------------------------------------------------
-- 6. Grants (v78 rule; the two server-only functions are the recorded
--    exceptions — service_role only, no authenticated, no anon).
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_auto_close_open_sessions(timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.check_login_rate(text, text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_login_rate(text, text, int, int) FROM anon;
REVOKE ALL ON FUNCTION public.check_login_rate(text, text, int, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text, int, int) TO service_role;

REVOKE ALL ON FUNCTION public.attendance_caller_badge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_caller_badge() FROM anon;
GRANT EXECUTE ON FUNCTION public.attendance_caller_badge() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Version registry (v50 convention: append own row only).
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v80')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only unless stated — run AFTER applying)
-- ============================================================
-- 1. The sweep is a no-op for today before 21:00 IST. Pick a daytime
--    instant TODAY (IST) and dry-run inside a transaction you roll back:
-- BEGIN;
-- SELECT public.attendance_auto_close_open_sessions(
--   date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' + interval '10 hours');
-- -- expect: only rows with in_date < today (IST) are counted; 0 if none.
-- ROLLBACK;
--
-- 2. The DRY-RUN predicate the sweep now uses (replaces v79 query 2):
-- SELECT schedule_id, badge_number, sewadar_name, in_date, in_time
--   FROM public.dp_attendance_sessions
--  WHERE status = 'OPEN'
--    AND (in_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
--         OR (in_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
--             AND in_time < TIME '21:00'
--             AND (now() AT TIME ZONE 'Asia/Kolkata')::time >= TIME '21:00'))
--  ORDER BY in_date, in_time;
--
-- 3. No direct write path remains. Expect only att_read:
-- SELECT policyname, cmd FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'dp_attendance_sessions';
-- -- and no INSERT/UPDATE/DELETE for the API roles (expect 0 rows):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'dp_attendance_sessions'
--    AND grantee IN ('anon','authenticated')
--    AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
--
-- 4. Server-only functions are not reachable by API roles (expect 0 rows):
-- SELECT p.oid::regprocedure AS fn, a.grantee::regrole AS grantee
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace,
--        LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('attendance_auto_close_open_sessions','check_login_rate')
--    AND a.privilege_type = 'EXECUTE'
--    AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 0);
--
-- 5. Login still works end to end: sign in once through the portal
--    (resolve-login calls check_login_rate as service_role). Then:
-- SELECT count(*) FROM public.login_attempts WHERE attempted_at > now() - interval '5 minutes';
-- -- expect >= 1.
--
-- 6. Scanning still works: one IN and one OUT from a scanner login, then
--    the same OUT again → the second answer carries "dedup": true.
--
-- 7. The registry recorded the migration. Expect: v80.
-- SELECT version FROM public.portal_version WHERE version = 'v80';
