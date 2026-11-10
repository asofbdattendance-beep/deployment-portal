-- ============================================================
-- V85: SCANNER DEVICE TELEMETRY.
-- Run AFTER v84.
--
-- Why: the camera scanner reads badges on most phones but not all, and
-- nothing recorded WHICH phones fail. dp_attendance_sessions.is_manual
-- already says camera vs typed per scan; it cannot say which phone,
-- browser, lens or decoder was involved, or that a scanner opened the
-- camera for ten minutes and never read a badge. This adds a small
-- write-only log the scanner page fills in the background, so the
-- failing devices can be found and every scanner fix measured.
--
-- What:
--   1. dp_scanner_telemetry — one row per event:
--        read          a badge accepted from the live camera or a photo
--        photo_fail    a photo that held no single readable badge
--        session       summary when a camera session ends
--        camera_error  the camera could not be opened
--      No badge of the person scanned is stored. The scanner's own badge
--      is taken from the JWT server-side (attendance_caller_badge), never
--      from the client.
--   2. log_scanner_telemetry(p_events jsonb) — the ONLY write path.
--      SECURITY DEFINER; rejects callers without an active portal badge;
--      takes at most 50 events per call; validates and truncates every
--      field; caps each scanner at 600 rows per 10 minutes; prunes rows
--      older than 90 days in small bounded batches.
--   3. scanner_device_report(p_days int) — per-device summary for
--      aso / super_admin: sessions, sessions that never read, live vs
--      photo reads, photo failures, median time to read.
--
-- RLS: enabled. authenticated gets SELECT only, filtered to aso /
-- super_admin. No INSERT/UPDATE/DELETE grant, so the table can only be
-- written through the function.
--
-- NOT TOUCHED: no existing table, policy, trigger or function changes.
-- Non-destructive; safe to re-run.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dp_scanner_telemetry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  client_ts     timestamptz,
  scanner_badge text        NOT NULL,
  event         text        NOT NULL CHECK (event IN ('read', 'photo_fail', 'session', 'camera_error')),
  input         text        CHECK (input IN ('live', 'photo')),
  engine        text,
  platform      text,
  browser       text,
  in_app        text,
  user_agent    text,
  lens_label    text,
  stream_w      integer     CHECK (stream_w BETWEEN 0 AND 20000),
  stream_h      integer     CHECK (stream_h BETWEEN 0 AND 20000),
  zoom          real        CHECK (zoom BETWEEN 0 AND 100),
  ms            integer     CHECK (ms BETWEEN 0 AND 86400000),
  misses        integer     CHECK (misses BETWEEN 0 AND 10000000),
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Report and prune both scan by time; the rate cap scans by scanner + time.
CREATE INDEX IF NOT EXISTS dp_scanner_telemetry_received_idx
  ON public.dp_scanner_telemetry (received_at);
CREATE INDEX IF NOT EXISTS dp_scanner_telemetry_badge_received_idx
  ON public.dp_scanner_telemetry (scanner_badge, received_at);

ALTER TABLE public.dp_scanner_telemetry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dp_scanner_telemetry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.dp_scanner_telemetry TO authenticated;

DROP POLICY IF EXISTS scanner_telemetry_admin_read ON public.dp_scanner_telemetry;
CREATE POLICY scanner_telemetry_admin_read ON public.dp_scanner_telemetry
  FOR SELECT TO authenticated
  USING ((SELECT public.get_portal_user_role()) IN ('super_admin', 'aso'));

-- ------------------------------------------------------------
-- 2. Write path
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_scanner_telemetry(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_badge     text := public.attendance_caller_badge();
  v_recent    integer;
  v_inserted  integer;
BEGIN
  IF v_badge IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  -- Per-scanner flood cap. A healthy phone sends a few rows a minute.
  SELECT count(*) INTO v_recent
    FROM public.dp_scanner_telemetry t
   WHERE t.scanner_badge = v_badge
     AND t.received_at > now() - interval '10 minutes';
  IF v_recent >= 600 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.dp_scanner_telemetry (
    client_ts, scanner_badge, event, input, engine, platform, browser,
    in_app, user_agent, lens_label, stream_w, stream_h, zoom, ms, misses, detail
  )
  SELECT
    CASE WHEN e.v->>'ts' ~ '^\d{12,13}$'
         THEN to_timestamp((e.v->>'ts')::bigint / 1000.0) END,
    v_badge,
    e.v->>'event',
    CASE WHEN e.v->>'input' IN ('live', 'photo') THEN e.v->>'input' END,
    left(e.v->>'engine', 24),
    left(e.v->>'platform', 24),
    left(e.v->>'browser', 24),
    left(e.v->>'in_app', 24),
    left(e.v->>'user_agent', 300),
    left(e.v->>'lens_label', 80),
    CASE WHEN e.v->>'stream_w' ~ '^\d{1,5}$' AND (e.v->>'stream_w')::integer <= 20000
         THEN (e.v->>'stream_w')::integer END,
    CASE WHEN e.v->>'stream_h' ~ '^\d{1,5}$' AND (e.v->>'stream_h')::integer <= 20000
         THEN (e.v->>'stream_h')::integer END,
    CASE WHEN e.v->>'zoom' ~ '^\d{1,2}(\.\d{1,3})?$'
         THEN (e.v->>'zoom')::real END,
    CASE WHEN e.v->>'ms' ~ '^\d{1,8}$' AND (e.v->>'ms')::integer <= 86400000
         THEN (e.v->>'ms')::integer END,
    CASE WHEN e.v->>'misses' ~ '^\d{1,7}$'
         THEN (e.v->>'misses')::integer END,
    CASE WHEN jsonb_typeof(e.v->'detail') = 'object' AND length((e.v->'detail')::text) <= 2000
         THEN e.v->'detail' ELSE '{}'::jsonb END
  FROM jsonb_array_elements(p_events) WITH ORDINALITY AS e(v, i)
  WHERE e.i <= 50
    AND jsonb_typeof(e.v) = 'object'
    AND e.v->>'event' IN ('read', 'photo_fail', 'session', 'camera_error');

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Retention: about 1 call in 50 deletes up to 2000 rows older than
  -- 90 days. Bounded, so no call ever pays for a large delete.
  IF random() < 0.02 THEN
    DELETE FROM public.dp_scanner_telemetry
     WHERE id IN (SELECT t.id FROM public.dp_scanner_telemetry t
                   WHERE t.received_at < now() - interval '90 days'
                   ORDER BY t.received_at
                   LIMIT 2000);
  END IF;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.log_scanner_telemetry(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_scanner_telemetry(jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 3. Per-device report
-- ------------------------------------------------------------
-- Groups by platform + browser + in-app host + the phone model part of the
-- user agent (Android UAs carry "; <model> Build" or "; <model>)"). Returns
-- jsonb so PostgREST's max-rows cap never truncates it.
CREATE OR REPLACE FUNCTION public.scanner_device_report(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_out  jsonb;
BEGIN
  -- COALESCE: get_portal_user_role() is NULL for inactive / archived /
  -- force-logged-out users, and `NULL NOT IN (...)` is NULL, which IF
  -- treats as false — without it those callers would get the report.
  IF COALESCE(public.get_portal_user_role(), '') NOT IN ('super_admin', 'aso') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  WITH t AS (
    SELECT
      COALESCE(platform, '?') AS platform,
      COALESCE(browser, '?')  AS browser,
      COALESCE(in_app, '')    AS in_app,
      COALESCE(nullif(regexp_replace(substring(user_agent FROM 'Android [0-9.]+; ([^;)]+)'), ' Build/.*$', ''), ''),
               CASE WHEN user_agent ~ 'iPhone' THEN 'iPhone'
                    WHEN user_agent ~ 'iPad'   THEN 'iPad' ELSE '?' END) AS model,
      event, input, ms, detail, scanner_badge
    FROM public.dp_scanner_telemetry
    WHERE received_at > now() - make_interval(days => v_days)
  ), g AS (
    SELECT platform, browser, in_app, model,
      count(DISTINCT scanner_badge)                                   AS scanners,
      count(*) FILTER (WHERE event = 'session')                       AS sessions,
      count(*) FILTER (WHERE event = 'session'
                         AND COALESCE(detail->>'reads', '0') = '0'
                         AND detail->>'duration_ms' ~ '^\d{5,9}$'
                         AND (detail->>'duration_ms')::bigint >= 30000) AS sessions_no_read,
      count(*) FILTER (WHERE event = 'read' AND input = 'live')       AS live_reads,
      count(*) FILTER (WHERE event = 'read' AND input = 'photo')      AS photo_reads,
      count(*) FILTER (WHERE event = 'photo_fail')                    AS photo_fails,
      count(*) FILTER (WHERE event = 'camera_error')                  AS camera_errors,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)
        FILTER (WHERE event = 'read' AND input = 'live')              AS median_live_ms
    FROM t
    GROUP BY platform, browser, in_app, model
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.sessions_no_read DESC, g.sessions DESC), '[]'::jsonb)
    INTO v_out
    FROM g;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.scanner_device_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scanner_device_report(integer) TO authenticated;

COMMIT;

-- ============================================================
-- Verification (run manually after applying):
--
-- 1. Table, policy and functions exist:
--    SELECT to_regclass('public.dp_scanner_telemetry');
--    SELECT polname FROM pg_policy WHERE polrelid = 'public.dp_scanner_telemetry'::regclass;
--    SELECT proname, prosecdef FROM pg_proc
--     WHERE proname IN ('log_scanner_telemetry', 'scanner_device_report');
--
-- 2. authenticated cannot write the table directly (expect 'f'):
--    SELECT has_table_privilege('authenticated', 'public.dp_scanner_telemetry', 'INSERT');
--
-- 3. Devices that open the camera and never read, last 14 days:
--    SELECT jsonb_pretty(public.scanner_device_report(14));   -- as aso / super_admin
-- ============================================================
