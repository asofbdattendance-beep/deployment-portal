-- ============================================================
-- V65: get_scan_state — ALSO RETURN THE SCANNED SEWADAR'S
--       IDENTITY (NAME / HOME CENTRE / DEPLOYED DEPARTMENT)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- The scan popup asks the operator a question BEFORE anything is
-- written ("this is who you scanned — Mark IN or Mark OUT?"), so
-- it cannot take its identity from `scan_in` / `scan_out`, which
-- only run after the tap. It can only read what `get_scan_state`
-- returns today:
--
--     {"open": <row|null>, "last_out": <row|null>}
--
-- and BOTH of those are rows of `dp_attendance_sessions`. A badge
-- that has never scanned in THIS schedule has NO session row, so
-- `last_out` is null and the IN-side prompt resolved identity from
-- a null payload:
--
--     const dispChoose = displayOf(lastOut)   // useScanHandler.js
--
-- Result: the popup for the single most common scan — a fresh
-- badge, or the first scan of a visit — showed a badge number and
-- a clock and NOTHING else. No name, no centre, no department.
-- That is exactly the "my popup shows nothing" report this fixes.
--
-- The fix is to answer identity from the SOURCE tables, not from
-- session history, in the same round trip. A third key:
--
--     {"open": …, "last_out": …, "sewadar": <object|null>}
--
-- with `sewadar` shaped so the client's existing resolver
-- `scanDisplay(payload, deptNameById)` can consume it UNCHANGED:
--
--     sewadar_name   text   — dp_sewadars/vss_sewadars name
--     sewadar_centre text   — the HOME centre (never the venue)
--     sewadar_dept   uuid   — effective dept id (may be null)
--     dept_name      text   — resolved label; null when undeployed
--     is_vss         bool   — VSS vs regular badge
--
-- Source of truth, copied verbatim from `scan_in` so the popup and
-- the record it is about to write can never disagree:
--   * identity  — `public.get_sewadar_by_badge(p_badge)` (v28)
--                 searches `dp_sewadars` then `vss_sewadars`.
--   * effective department — `COALESCE(deployed_department_id,
--                 department_id)` from `deployments`, ordered
--                 `deployed_department_id NULLS LAST,
--                 department_id` (v57's determinism: one badge can
--                 hold rows under more than one centre key, so a
--                 bare LIMIT 1 could attribute it either way).
--                 Mirrors scan_in exactly → the department shown in
--                 the prompt is the department scan_in would store.
--   * label     — `public.dept_name_by_id(...)`.
--
-- An UNKNOWN badge returns `sewadar: null` (JSON null, not an
-- object of nulls — the v42 ambiguity), consistent with how `open`
-- and `last_out` already report a miss. Nothing here RAISES on a
-- missing badge: this is a read, and the client degrades to the
-- blank popup it shows today rather than failing the whole scan.
--
-- This is a PURE READ function: no table, column, index, trigger,
-- RLS policy or other function is created, altered or dropped —
-- only one `CREATE OR REPLACE`. Re-running is safe.
--
-- BACKWARD COMPATIBILITY: two keys are untouched, so a client that
-- has not been updated still works (it reads `open`/`last_out` as
-- before); and a client that HAS been updated works against the
-- old function (a missing `sewadar` key reads as undefined → null
-- → today's behaviour). Migration and frontend may land in either
-- order.
--
-- Apply AFTER v44 and v56 (the two prior definitions of this
-- function) and v57 (the scan_in ordering this copies), and after
-- v28/v58 prerequisites — i.e. wherever the current head sits.
-- Non-destructive; safe to re-run.
--
-- The role gate is copied from the LIVE (v56) definition, NOT from
-- v44: it must stay NULL-safe (`v_role IS NULL OR v_role NOT IN
-- (…)`) or a caller with no portal role slips through.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_scan_state(p_badge text, p_schedule uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_open  jsonb;
  v_last  jsonb;
  v_s     jsonb;
  v_id    jsonb;
  v_dept  uuid;
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

  -- v65: IDENTITY, independent of session history. A badge with zero
  -- session rows still resolves a name/centre/department, which is
  -- precisely what the IN-side prompt was missing. Both lookups are
  -- copied from scan_in (v57) so prompt and record cannot disagree.
  v_s := public.get_sewadar_by_badge(p_badge);
  IF v_s IS NOT NULL THEN
    SELECT COALESCE(d.deployed_department_id, d.department_id) INTO v_dept
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.badge_number = p_badge
     ORDER BY d.deployed_department_id NULLS LAST, d.department_id
     LIMIT 1;

    -- `sewadar_centre` is deliberately NOT coalesced: it reads the
    -- HOME centre column and must stay null rather than fall back to
    -- anything else (never the scan VENUE). `dept_name` is null when
    -- the badge holds no deployment for this schedule — undeployed,
    -- which is a fact the prompt shows rather than hides.
    v_id := jsonb_build_object(
      'sewadar_name',   COALESCE(v_s->>'sewadar_name', ''),
      'sewadar_centre', v_s->>'centre',
      'sewadar_dept',   v_dept,
      'dept_name',      public.dept_name_by_id(v_dept),
      'is_vss',         COALESCE((v_s->>'is_vss')::boolean, false));
  ELSE
    -- Unknown badge: JSON null, never an object of nulls (v42 trap).
    v_id := NULL;
  END IF;

  -- v44: jsonb_build_object renders a NULL jsonb as JSON `null`, so
  -- "not open", "never scanned out" and "unknown badge" are all
  -- unambiguous. The v42 all-NULL-record trap cannot recur here: on a
  -- miss each of the three holds SQL NULL in a jsonb column, never a
  -- record of nulls.
  RETURN jsonb_build_object(
    'open',     v_open,
    'last_out', v_last,
    'sewadar',  v_id);
END; $$;

-- Repo convention: state the grants even though CREATE OR REPLACE
-- preserves them — they are the security contract of this function,
-- and a copy of this file must read complete on its own.
REVOKE ALL ON FUNCTION public.get_scan_state(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_scan_state(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_scan_state(text, uuid) TO authenticated;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The function exists exactly once. Expect: 1.
--
-- SELECT count(*) AS function_present
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'get_scan_state';
--
-- 2. Its attributes are the ones that matter, not just the name:
--    SECURITY DEFINER, empty search_path. Expect: t | {search_path=""}
--
-- SELECT p.prosecdef AS security_definer,
--        p.proconfig AS search_path_setting
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'get_scan_state';
--
-- 3. THE BUG THIS FIXES — a badge with NO sessions in the schedule
--    still yields identity. Substitute a real badge and schedule.
--    Expect: a JSON object under "sewadar" with a real name/centre,
--    NOT null, while BOTH "open" and "last_out" are null:
--
-- SELECT public.get_scan_state('A-BADGE-WITH-NO-SESSIONS',
--                              '<the-schedule-uuid>'::uuid);
--
-- -- expect:
-- -- { "open": null, "last_out": null,
-- --   "sewadar": { "sewadar_name": "…", "sewadar_centre": "…",
-- --                "sewadar_dept": "…"|null, "dept_name": "…"|null,
-- --                "is_vss": false } }
--
-- 4. An unknown badge yields THREE JSON nulls — not objects of nulls.
--    This is the v42 failure mode, inverted. Expect: t | t | t
--
-- SELECT (public.get_scan_state('NOT-A-REAL-BADGE',
--                               '<the-schedule-uuid>'::uuid) -> 'open')     IS NULL AS open_is_null,
--        (public.get_scan_state('NOT-A-REAL-BADGE',
--                               '<the-schedule-uuid>'::uuid) -> 'last_out') IS NULL AS last_out_is_null,
--        (public.get_scan_state('NOT-A-REAL-BADGE',
--                               '<the-schedule-uuid>'::uuid) -> 'sewadar')  IS NULL AS sewadar_is_null;
--
-- 5. The new identity agrees with `scan_in` for the same badge — the
--    department shown in the prompt is the department scan_in stores,
--    and the name/centre come from the same two resolvers. Expect:
--    NULL on all three compared rows.
--
-- SELECT s.id,
--        COALESCE((public.get_scan_state(s.badge_number, s.schedule_id)
--                    -> 'sewadar' ->> 'sewadar_name'), '') <> COALESCE(s.sewadar_name, '') AS name_differs,
--        (public.get_scan_state(s.badge_number, s.schedule_id)
--           -> 'sewadar' ->> 'sewadar_centre') IS DISTINCT FROM s.sewadar_centre AS centre_differs,
--        public.get_scan_state(s.badge_number, s.schedule_id)
--           -> 'sewadar' ->> 'dept_name' IS DISTINCT FROM public.dept_name_by_id(s.sewadar_dept) AS dept_differs
--   FROM public.dp_attendance_sessions s
--  LIMIT 10;
--
-- 6. The open/closed halves are unchanged (regression guard for
--    v44/v56). A badge that is OPEN must still report `open` as an
--    object — Expect: t
--
-- SELECT jsonb_typeof(public.get_scan_state('<A-BADGE-THAT-IS-OPEN>',
--                        '<the-schedule-uuid>'::uuid) -> 'open') = 'object'
--        AS open_still_works;
--
-- 7. The role gate is UNCHANGED and still NULL-safe. A signed-in
--    user whose role is NOT one of dept_incharge / scanner / aso /
--    super_admin — centre_user, centre_admin or vss_operator — must
--    get an error and no data:
--
-- SELECT public.get_scan_state('A-BADGE-NUMBER',
--                              '00000000-0000-0000-0000-000000000000'::uuid);
--                                    -- expect: ERROR: Not authorized
--
--    Run it from the portal, NOT the SQL editor: an editor session
--    carries no portal role, so it is refused too — intended.
--
-- 8. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
