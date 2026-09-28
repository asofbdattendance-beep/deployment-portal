-- ============================================================
-- V40: ATTENDANCE VENUE + HOME-CENTRE SCOPE
--
-- Run AFTER v39. Non-destructive; safe to re-run.
--
-- ------------------------------------------------------------
-- THE PROBLEM THIS FIXES
-- ------------------------------------------------------------
-- Attendance is scanned at ONE physical venue ("Bhati - Delhi MC")
-- by operators (scanner / dept_incharge / aso / super_admin) who may
-- scan ANY sewadar, regardless of department or centre. But v26 and
-- v28 used a single column, `attendance_sessions.centre`, for THREE
-- different jobs, and the jobs disagreed:
--
--   centre              → recorded as "the SCAN centre"
--   att_read RLS policy → used as the ACCESS key
--   v39 daily summary   → used as the REPORTING axis
--
-- Two consequences, both silent:
--
-- 1. REPORTING (v39 attendance_daily_summary). It grouped the
--    expectation side by deployments.centre (the sewadar's HOME
--    centre) and the presence side by attendance.centre (the VENUE),
--    then joined them `ON p.centre = agg.centre`. With one constant
--    venue those two values never match, so `present` was always 0
--    and EVERY row rendered as absent. The rows were correctly
--    SHAPED, so nothing looked broken — the Daily tab simply
--    reported 0% attendance for every centre, every day.
--
-- 2. ACCESS (att_read / att_update RLS). Both gated on
--    `centre = get_portal_user_centre()`. A dept_incharge at
--    SECTOR-15-A therefore matched ZERO rows, because every row's
--    centre was the venue. ScannerPage.jsx and DeptInchargePage.jsx
--    read the table directly, so both rendered blank, and the
--    incharge could not see a sewadar who was physically checked in
--    — leading to a scan_in that raised 'Already IN'. The policy
--    also compared a SINGLE centre name, so it could never have
--    matched an SC_SP's sewadars for a root CENTRE user anyway.
--
-- ------------------------------------------------------------
-- THE FIX
-- ------------------------------------------------------------
-- Split the three jobs across three columns, which the schema
-- already provides:
--
--   centre            → the VENUE (constant, informational)
--   sewadar_centre    → the sewadar's HOME centre  → scope + report
--   in_scanner_centre → the scanner's OWN centre    → accountability
--
-- 1. scan_in writes the VENUE into `centre` and the operator's own
--    centre into `in_scanner_centre` (previously both were the same
--    value, because v26 pinned v_centre to the caller's centre).
--    The anti-spoofing pin is removed: `centre` is no longer a scope
--    or reporting key, so it carries no privilege, and open scanning
--    is a requirement. p_centre is retained in the signature for
--    caller compatibility and is deliberately IGNORED.
-- 2. att_read / att_update now scope on sewadar_centre against
--    get_my_subtree_centres() (so sub-tree SC_SPs resolve), OR the
--    caller's own scans (so a scanner keeps visibility of the
--    "last N scans I did" and the forgot-OUT recovery, even for a
--    sewadar from another centre).
-- 3. get_open_session reads the real table instead of the v28
--    compatibility VIEW. v28's redefinition of this function is
--    syntactically invalid (see sql/v28_rename_shared_tables.sql
--    481-490 — a DROP FUNCTION with NAMED parameters, no
--    terminating semicolon, and the CREATE OR REPLACE FUNCTION
--    keyword missing entirely), so the v26 version survived and has
--    been resolving `public.attendance_sessions` through that view.
--    Reading the table directly removes the dependency.
--
-- DELIBERATELY UNTOUCHED: quota, restriction rules, locks,
-- deadlines, master switches, the v32 deployed-freeze, v15/v16
-- finalized rows, the v36/v37 operator limits, and the scan
-- authorisation ladder (only scanner / dept_incharge / aso /
-- super_admin may scan — unchanged).
--
-- ROLLBACK: see the verification block at the bottom.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The venue, in one place. This is the ONLY place the string
--    lives. Changing it is a one-line edit plus a re-run.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_venue()
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'Bhati - Delhi MC'::text;
$$;

COMMENT ON FUNCTION public.attendance_venue() IS
  'The single physical venue where attendance is scanned. Recorded in attendance_sessions.centre for information only — it is NEVER used for scope, access control or reporting, because it is constant.';


-- ------------------------------------------------------------
-- 2. Caller helpers. SECURITY DEFINER so they can read
--    portal_users regardless of its RLS, and STABLE so the planner
--    may fold them into the policy predicate.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_caller_badge()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT p.badge_number FROM public.portal_users p WHERE p.auth_id = auth.uid());
$$;

-- Fail closed. Only the roles that legitimately need attendance
-- visibility get any; everything else (vss_operator, a SQL-editor run
-- with no portal role, any future role) is denied.
CREATE OR REPLACE FUNCTION public.attendance_sewadar_centre_visible(p_centre text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN public.get_portal_user_role() IN ('aso','super_admin')      THEN true
    WHEN public.get_portal_user_role() NOT IN
         ('centre_user','centre_admin','dept_incharge','scanner')    THEN false
    WHEN p_centre IS NOT NULL
         AND p_centre = ANY (public.get_my_subtree_centres())       THEN true
    ELSE false
  END;
$$;


-- ------------------------------------------------------------
-- 3. scan_in — record the VENUE in `centre`, the operator's own
--    centre in `in_scanner_centre`.
--    NOTE p_centre is intentionally ignored (see header).
--    The declared type of v_open moves to the real table, matching
--    the get_open_session redefinition in section 5.
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
    IF FOUND THEN RETURN jsonb_build_object('ok', true, 'dedup', true); END IF;
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
  RETURN jsonb_build_object('ok', true, 'undeployed', v_undeployed);
END;
$$;


-- ------------------------------------------------------------
-- 4. RLS — scope on the sewadar's HOME centre, and always let an
--    operator see the scans they personally performed.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_dp_att_schedule_homecentre;
CREATE INDEX IF NOT EXISTS idx_dp_att_schedule_homecentre
  ON public.dp_attendance_sessions (schedule_id, in_date, sewadar_centre);

DROP POLICY IF EXISTS att_read ON public.dp_attendance_sessions;
CREATE POLICY att_read ON public.dp_attendance_sessions
  FOR SELECT TO authenticated USING (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  );

DROP POLICY IF EXISTS att_update ON public.dp_attendance_sessions;
CREATE POLICY att_update ON public.dp_attendance_sessions
  FOR UPDATE TO authenticated
  USING (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  )
  WITH CHECK (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  );

-- att_insert is role-only and stays exactly as v28 left it: any of
-- the four scanning roles may insert, with no centre condition. That
-- is what makes "anyone may scan for anyone" true, and it is correct
-- because INSERT carries no data beyond the row's own contents.


-- ------------------------------------------------------------
-- 5. get_open_session — read the real table, not the v28 compat
--    VIEW. The DROP names the ARGUMENT TYPES, never the parameter
--    names: naming them is exactly the bug in v28 481-490.
--    DROP-then-CREATE (not OR REPLACE) because the return type moves
--    from the view's rowtype to the table's.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_open_session(text, uuid);
CREATE OR REPLACE FUNCTION public.get_open_session(p_badge text, p_schedule uuid)
RETURNS public.dp_attendance_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.dp_attendance_sessions;
BEGIN
  IF public.get_portal_user_role() NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_row
    FROM public.dp_attendance_sessions
   WHERE badge_number = p_badge AND schedule_id = p_schedule AND status = 'OPEN'
   LIMIT 1;
  RETURN v_row;
END;
$$;


-- ============================================================
-- Verification (run AFTER applying; read the results)
-- ============================================================

-- 1. The four new/changed objects exist, and get_open_session now
--    points at the TABLE, not the view. The last two rows are the
--    proof the v28 workaround is no longer load-bearing.
--    Expect 4 rows; get_functiondef must contain dp_attendance_sessions
--    twice (RETURNS + FROM) and must NOT contain attendance_sessions.
SELECT p.proname,
       pg_get_functiondef(p.oid) LIKE '%dp_attendance_sessions%' AS mentions_real_table,
       pg_get_functiondef(p.oid) LIKE '%FROM public.attendance_sessions%' AS still_reads_compat_view
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('attendance_venue','attendance_caller_badge',
                     'attendance_sewadar_centre_visible','get_open_session');

-- 2. THE KEY REGRESSION CHECK for the reporting bug. A sewadar whose
--    HOME centre differs from the VENUE must still be counted
--    present. Seed one session with centre = the venue and a
--    different sewadar_centre, then run v39's daily summary.
--    Expect present = 1. Before v40 this returned present = 0.
-- SELECT * FROM public.attendance_daily_summary('<schedule>', CURRENT_DATE);

-- 3. The venue is recorded in `centre` and the operator's own centre
--    in `in_scanner_centre`. After any scan by a non-admin operator,
--    the two MUST differ (or the operator's centre IS the venue).
-- Expect: every row has centre = 'Bhati - Delhi MC'.
SELECT centre, in_scanner_centre, count(*)
  FROM public.dp_attendance_sessions
 GROUP BY centre, in_scanner_centre
 ORDER BY count(*) DESC;

-- 4. RLS is scoped on the HOME centre. As a centre_user whose
--    centre is SECTOR-15-A, this must return sessions for sewadars
--    home in SECTOR-15-A / DHATIR / GREATER FARIDABAD even though
--    every row's `centre` is the venue.
-- SELECT count(*) FROM public.dp_attendance_sessions
--  WHERE sewadar_centre = ANY (SELECT public.get_my_subtree_centres());

-- 5. A scanner still sees what THEY scanned, including a sewadar
--    from outside their own subtree (open scanning).
-- SELECT count(*) FROM public.dp_attendance_sessions
--  WHERE in_scanner_badge = public.attendance_caller_badge();

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.attendance_venue();
--   DROP FUNCTION IF EXISTS public.attendance_caller_badge();
--   DROP FUNCTION IF EXISTS public.attendance_sewadar_centre_visible(text);
--   DROP INDEX IF EXISTS public.idx_dp_att_schedule_homecentre;
--   Then re-create att_read / att_update from sql/v28_rename_shared_tables.sql
--   lines 192-211, and scan_in / get_open_session from
--   sql/v26_attendance.sql lines 83-147.
