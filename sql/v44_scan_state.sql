-- ============================================================
-- V44: get_scan_state — IS THIS SEWADAR OPEN, AND IF NOT, WHEN
--       DID THEY LAST GO OUT? (ONE ROUND TRIP)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- The scanner client has to answer two questions about a badge
-- before it can decide what a scan means:
--
--   1. Is this sewadar OPEN right now?   -> the IN branch
--   2. If not, when did they last go OUT? -> the confirmation an
--      operator expects after a missed OUT
--
-- Neither is available in one call today. `get_open_session`
-- returns a single TABLE ROW TYPE, so it can only ever answer
-- question 1 — and only in the shape v42 had to repair (a miss
-- must be a real SQL NULL, never an all-NULL record, or PostgREST
-- serialises it to a truthy object and the client reads it as
-- "open"). Question 2 has no server-side answer at all: the
-- client reaches into `dp_attendance_sessions` itself, with its
-- own RLS, its own column list and its own idea of which row is
-- "the last one" — a second round trip in the middle of a scan,
-- racing the operator's next badge.
--
-- `get_scan_state` answers BOTH in one call, as a single jsonb
-- object:
--
--     {"open": <row|null>, "last_out": <row|null>}
--
-- `open` is the OPEN session if there is one; `last_out` is the
-- most recently CLOSED session that carries an OUT timestamp
-- (NULL when the sewadar has never scanned OUT). Both are full
-- rows, so the client also gets id / status / dates / times —
-- and, since v40, `sewadar_centre` (the HOME centre) — with no
-- extra query.
--
-- `get_open_session` is deliberately NOT touched or redefined
-- here. The server-side `scan_out` calls it and treats a NON-NULL
-- result as OPEN; replacing or wrapping it would put that
-- contract — and the v41/v42 fixes behind it — at risk for no
-- gain. This migration adds a function beside it, nothing more.
--
-- The role gate is verbatim v40's `get_open_session` gate, and so
-- deliberately EXCLUDES `vss_operator`: fail closed, identical to
-- the attendance read path it mirrors.
--
-- This is a PURE READ function. No table, column, index, trigger,
-- RLS policy or other function is created, altered or dropped —
-- the only statement is a single CREATE OR REPLACE, so re-running
-- is safe.
--
-- Apply AFTER v39, v40, v41, v42 and v43. Non-destructive; safe to
-- re-run. Apply BEFORE the frontend that calls it — the client
-- degrades gracefully when the function is missing (it falls back
-- to its own lookup, at the cost of the extra round trip this
-- exists to remove), but until then every scan pays for it.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_scan_state(p_badge text, p_schedule uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_open  jsonb;
  v_last  jsonb;
BEGIN
  -- v44: a pure read. The same four roles v40's get_open_session
  -- accepts, and the same refusal for everyone else — vss_operator
  -- included, so this fails closed exactly like the path it mirrors.
  IF public.get_portal_user_role() NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
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

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The function exists, exactly once. Expect: 1.
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
-- 3. Live call. Substitute a real badge and the schedule uuid it was
--    scanned under. A sewadar who is open shows that row under
--    "open" and their most recent OUT under "last_out":
--
-- SELECT public.get_scan_state('A-BADGE-NUMBER',
--                              '00000000-0000-0000-0000-000000000000'::uuid);
--
-- -- expect the shape:
-- -- {
-- --   "open":      { "id": "…", "status": "OPEN",  "in_date": "…",
-- --                 "in_time": "…", "sewadar_centre": "…", … },
-- --   "last_out":  { "id": "…", "status": "CLOSED", "out_date": "…",
-- --                 "out_time": "…", "sewadar_centre": "…", … }
-- -- }
--
-- 4. A sewadar who has never been scanned yields two JSON nulls —
--    not objects of nulls. This is the v42 failure mode, inverted:
--    Expect: t | t
--
-- SELECT (public.get_scan_state('A-BADGE-WITH-NO-SESSIONS',
--                               '00000000-0000-0000-0000-000000000000'::uuid)
--           -> 'open')     IS NULL AS open_is_null,
--        (public.get_scan_state('A-BADGE-WITH-NO-SESSIONS',
--                               '00000000-0000-0000-0000-000000000000'::uuid)
--           -> 'last_out') IS NULL AS last_out_is_null;
--
-- 5. It agrees with `get_open_session`, the call `scan_out` actually
--    makes — the contract this migration deliberately left alone.
--    Substitute a badge that is genuinely OPEN. Expect: t
--
-- SELECT jsonb_typeof(public.get_scan_state('A-BADGE-THAT-IS-OPEN',
--                        '<the-schedule-uuid>'::uuid) -> 'open') = 'object'
--        AS open_agrees;
--
-- 6. The role gate. A signed-in user whose role is NOT one of
--    dept_incharge / scanner / aso / super_admin — centre_user,
--    centre_admin or vss_operator — must get an error and no data:
--
-- SELECT public.get_scan_state('A-BADGE-NUMBER',
--                              '00000000-0000-0000-0000-000000000000'::uuid);
--                                    -- expect: ERROR: Not authorized
--
--    Run this as one of those users (from the portal, or a signed-in
--    request), NOT from the SQL editor: an editor session carries no
--    portal role, so it is refused too — intended, and the reason
--    checks 3-5 above must be run with a signed-in role as well.
--
-- 7. Re-run safety: execute this whole file a second time. Expect no
--    error and no schema change.
