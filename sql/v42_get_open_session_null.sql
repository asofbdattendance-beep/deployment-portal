-- ============================================================
-- V42: get_open_session MUST RETURN SQL NULL, NOT AN ALL-NULL ROW
--
-- Run AFTER v39, v40 and v41. Non-destructive; safe to re-run.
--
-- ------------------------------------------------------------
-- THE PROBLEM THIS FIXES
-- ------------------------------------------------------------
-- `get_open_session` is declared `RETURNS public.dp_attendance_sessions` —
-- a TABLE ROW TYPE — and is written as:
--
--     SELECT * INTO v_row FROM public.dp_attendance_sessions
--      WHERE badge_number = p_badge AND schedule_id = p_schedule
--        AND status='OPEN' LIMIT 1;
--     RETURN v_row;
--
-- When nothing matches, plpgsql assigns an ALL-NULL record to v_row and
-- `RETURN v_row` hands that record back. It compares equal to SQL NULL under
-- `IS NULL`, but PostgREST does not ask that question: it JSON-serialises the
-- returned composite, and an all-NULL record serialises to an OBJECT:
--
--     {"id": null, "status": null, "in_date": null, "in_time": null,
--      "schedule_id": null, "badge_number": null}
--
-- (verified on PG 15: `SELECT to_jsonb(get_open_session(<no match>, …))`)
--
-- So every caller receives a TRUTHY object for "there is no session". The
-- scanner hook read that as "a session exists", took the OUT branch with
-- `open.id = null`, and `scan_out` — falling back to its own lookup — found
-- nothing open and raised:
--
--     SCAN FAILED - No open session to close - <badge>
--
-- for a sewadar who had never scanned IN. The IN branch was unreachable, so
-- no attendance could ever be recorded. The client is hardened against this
-- shape in the same change, but the trap belongs here too: any other caller
-- would hit it again.
--
-- ------------------------------------------------------------
-- THE FIX
-- ------------------------------------------------------------
-- Return a genuine SQL NULL when the lookup misses, so PostgREST sends JSON
-- `null` and "no session" is unambiguous. A session is only returned when a
-- row was actually found, tested via `FOUND` (what SELECT INTO sets) rather
-- than `IS NOT NULL` on the row variable — on a plpgsql ROW variable
-- `IS NOT NULL` does not answer "was a row returned?" (see v41).
--
-- This is a pure read-path change: no table, column, index, trigger, RLS
-- policy or other function is touched, and the row returned for a real
-- session is byte-for-byte what it was.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_open_session(text, uuid);
CREATE OR REPLACE FUNCTION public.get_open_session(p_badge text, p_schedule uuid)
RETURNS public.dp_attendance_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.dp_attendance_sessions;
BEGIN
  IF public.get_portal_user_role() NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
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

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying)
-- ============================================================
--
-- 1. The guard is in place. Expect: 1.
--
-- SELECT count(*) AS guard_present
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'get_open_session'
--    AND p.prosrc LIKE '%IF NOT FOUND THEN RETURN NULL%';
--
-- 2. "No session" is now real NULL, so the JSON a caller receives is `null`
--    rather than an object of nulls. Log in as scanner / dept_incharge and,
--    in the SQL editor, compare the two — the first must be `null`:
--
-- SELECT public.get_open_session('A-BADGE-WITH-NO-SESSION',
--                                 '00000000-0000-0000-0000-000000000000'::uuid)
--        IS NULL AS miss_is_null;                     -- expect: t
--
-- SELECT to_jsonb(public.get_open_session('A-BADGE-WITH-NO-SESSION',
--                                 '00000000-0000-0000-0000-000000000000'::uuid))
--        AS miss_as_json;                             -- expect: null  (was {"id":null,…})
--
-- 3. A real session still comes back intact. Substitute a badge that is
--    genuinely OPEN:
--
-- SELECT to_jsonb(public.get_open_session('A-BADGE-THAT-IS-OPEN',
--                                 '<the-open-schedule-uuid>'::uuid)) AS hit_as_json;
--
-- 4. End-to-end: scan a sewadar IN. The popup must read IN, and a second
--    lookup must then find the session. Before this fix the very first scan
--    already tried to close a session that did not exist.
