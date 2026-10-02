-- ============================================================
-- V57 — NONCE DEDUP SCOPED TO (SCHEDULE, NONCE) + UNDEPLOYED ON
--       THE DEDUP PATH + DETERMINISTIC EFFECTIVE DEPARTMENT
-- ============================================================
-- Run AFTER v56. Non-destructive; safe to re-run (IF NOT EXISTS +
-- DROP + CREATE OR REPLACE per repo convention; no table, column,
-- trigger or RLS policy touched — one index ADDED, nothing dropped).
--
-- THREE SMALL CORRECTNESS FIXES ON TOP OF v56's scan_in. scan_out,
-- get_open_session and get_scan_state are untouched.
--
-- (1) NONCE DEDUP SCOPED TO THE SCHEDULE. The idempotency check is
--
--   PERFORM 1 FROM dp_attendance_sessions WHERE nonce = p_nonce;
--
-- global: a nonce replayed under schedule B dedups against (and
-- returns success for) a session written under schedule A. Nonces
-- are per-attempt uuids minted by the client, so a cross-schedule
-- replay is never legitimate — but when it happens (queue drain
-- after a schedule switch, manual retry pasted into the wrong
-- visit), the scoped check is the one that answers correctly:
--
--   ... WHERE schedule_id = p_schedule AND nonce = p_nonce;
--
-- plus the matching composite unique backstop:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_attendance_schedule_nonce
--     ON dp_attendance_sessions(schedule_id, nonce);
--
-- The pre-existing global UNIQUE on nonce (v26, carried through the
-- v28 rename) is deliberately LEFT in place: it is stricter, so a
-- pathological cross-schedule replay now fails loudly on the INSERT
-- instead of silently returning another schedule's dedup — loud is
-- correct for a value that must never repeat.
--
-- (2) `undeployed` ON THE DEDUP PATH. The main IN return carries
-- `{ok, undeployed, sewadar_name, sewadar_centre, dept_name}` but
-- the nonce-replay return never had `undeployed` (v43 called it out
-- of scope). Callers that branch on it read `undefined` for a
-- replayed IN and misrender the popup. Same value the main path
-- would return: `(v_dept IS NULL)`, computed from the same lookup.
-- Purely additive: callers that never read the key are unaffected.
--
-- (3) DETERMINISTIC EFFECTIVE DEPARTMENT. Both lookups are
--
--   SELECT COALESCE(deployed_department_id, department_id) ...
--    WHERE schedule_id = p_schedule AND badge_number = p_badge LIMIT 1;
--
-- but one badge can hold deployment rows under more than one centre
-- key, so a bare LIMIT 1 could attribute the session to either
-- department — and the dedup path and the main path could DISAGREE
-- with each other. Both now use the same ordering v55's
-- attendance_badge_dept uses (final beats requested, ties on the
-- requested id), so the two paths always attribute alike:
--
--   ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;
-- ============================================================

BEGIN;

-- Scoped uniqueness backstop for the scoped dedup check. IF NOT EXISTS
-- so re-runs are no-ops; nonces are per-attempt uuids, so no existing
-- rows can collide on (schedule_id, nonce).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_attendance_schedule_nonce
  ON public.dp_attendance_sessions(schedule_id, nonce);

-- scan_in only: v56 body verbatim except the scoped PERFORM, the
-- `undeployed` dedup key, and the two ORDER BYs.
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
  -- idempotency, scoped to this schedule (v57: the global `nonce =`
  -- check deduped a replay against another schedule's session).
  IF p_nonce IS NOT NULL THEN
    PERFORM 1 FROM public.dp_attendance_sessions
     WHERE schedule_id = p_schedule AND nonce = p_nonce;
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
      -- v57: deterministic — same ORDER BY as the main path, so the
      -- two paths can never attribute the same badge differently.
      SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
        FROM public.deployments
       WHERE schedule_id = p_schedule AND badge_number = p_badge
       ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;
      RETURN jsonb_build_object(
        'ok', true,
        'dedup', true,
        -- v57: the dedup path never carried `undeployed`; callers that
        -- branch on it read it as undefined for a replayed IN. Same
        -- value the main path would return for this badge.
        'undeployed', (v_dept IS NULL),
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
  -- v57: deterministic — one badge can hold deployment rows under more
  -- than one centre key, so a bare LIMIT 1 could attribute the session
  -- to either department. Final (deployed) beats requested; ties break
  -- on the requested id. Same ordering attendance_badge_dept (v55) uses.
  SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
    FROM public.deployments
   WHERE schedule_id = p_schedule AND badge_number = p_badge
   ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;
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
-- 1. The scoped index exists, exactly once. Expect: 1.
--
-- SELECT count(*) AS scoped_nonce_index
--   FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'dp_attendance_sessions'
--    AND indexname = 'uq_dp_attendance_schedule_nonce';
--
-- 2. The dedup check is schedule-scoped. Expect: 1 (scoped), then 0
--    (no bare global `WHERE nonce =` remains in scan_in).
--
-- SELECT count(*) AS scoped_dedup
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%schedule_id = p_schedule AND nonce = p_nonce%';
--
-- 3. The dedup path carries `undeployed`. Expect: the dedup RETURN
--    builds it from the looked-up department.
--
-- SELECT count(*) AS dedup_has_undeployed
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%''undeployed'', (v_dept IS NULL)%';
--
-- 4. Both effective-dept lookups are deterministic. Expect: 2 (dedup
--    path + main path share the one ordering).
--
-- SELECT count(*) AS ordered_lookups
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'scan_in'
--    AND p.prosrc LIKE '%ORDER BY deployed_department_id NULLS LAST%';
--    -- (LIKE counts the function once if either lookup matches; read the
--    -- body to confirm both. A stricter count: split prosrc on the dedup
--    -- RETURN and check each half.)
--
-- 5. A nonce replayed under a DIFFERENT schedule does NOT dedup. As a
--    scanner: scan badge B IN under schedule S1 with nonce N (ok:true),
--    then scan B IN under schedule S2 with the SAME nonce N — expect a
--    fresh ok:true under S2 (or the global-unique backstop to raise),
--    never a dedup:true attributed to S1.
--
-- 6. Replay under the SAME schedule still dedups, and now reports
--    undeployed: repeat the S1 scan with nonce N — expect
--    {"ok": true, "dedup": true, "undeployed": ..., ...}.
--
-- 7. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
-- ============================================================
