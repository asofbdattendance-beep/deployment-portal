-- ============================================================
-- V39: ATTENDANCE ANALYTICS — read-only scope-resolving RPCs
--
-- Problem: attendance is scanned (scan_in / scan_out) and shown live on
-- the Scanner and Dept Incharge pages, but it is invisible to the ASO
-- and to centre users, absent from every Excel export, and has no
-- cross-day view. The visit spans a fixed 5 days (WED–SUN), so "did
-- they show up, and on which days" is the question nobody can answer.
--
-- What this adds — FIVE read-only, SECURITY DEFINER functions. THREE
-- are the analytics RPCs the page calls; TWO are scope helpers they
-- share, so that a future role is added in exactly one place. All
-- five resolve the CALLER'S OWN SCOPE inside the function, so the
-- page never has to filter (and can never be tricked into
-- over-fetching):
--
--   • aso / super_admin  → all centres
--   • centre_user / centre_admin → get_my_subtree_centres() (own + SC_SPs)
--   • dept_incharge      → get_my_dept_ids(schedule) ∩ own centre
--   • scanner / vss_operator / anything else → NO ROWS (fail closed)
--
--   1. attendance_daily_summary(schedule, date)
--        → per centre × department: expected, present, absent, open
--   2. attendance_sewadar_summary(schedule)
--        → per badge: days_present, first_in, last_out, open_sessions,
--          effective department, centre, undeployed_scan flag
--   3. attendance_scanner_ops(schedule, date)
--        → per scanner: scans in / out, first & last scan, open now
--
--   Helpers (not called by the page directly):
--   4. attendance_scope_centres(schedule)  → text[] of centre names
--   5. attendance_allowed_depts(schedule)   → uuid[] or NULL = no
--                                              department restriction
--
-- NOT IN SCOPE (deliberate):
--   • NO new RLS policy, NO grant to anon/authenticated, NO INSERT/UPDATE
--     path. These RPCs are the ONLY way attendance analytics is read;
--     scan_in / scan_out remain the only writers.
--   • Quota, restriction rules, locks, deadlines, switches, the v32
--     deployed-freeze, v15/v16 finalized rows and the v36/v37 operator
--     limits are ALL UNTOUCHED. This migration reads.
--   • dept_incharge is additionally narrowed to the departments they
--     are actually incharge of (v25 department_incharge_selections).
--
-- WHY NOT public.get_open_session():
--   v28 (lines 481-490) redefines it with a MALFORMED statement — a
--   DROP FUNCTION with NAMED parameters, no terminating semicolon,
--   and the CREATE OR REPLACE FUNCTION keyword missing entirely. The
--   redefinition therefore never took effect and the v26 version
--   survived, still resolving `public.attendance_sessions` through
--   the v28 compatibility VIEW. These RPCs query
--   public.dp_attendance_sessions DIRECTLY and never call it.
--   v40 removes the dependency: it redefines get_open_session to
--   read the real table and drops the malformed statement's intent.
--
-- CENTRE SEMANTICS — the single most important detail here:
--   `attendance_sessions.centre` is the physical VENUE at which the
--   scan happened. It is CONSTANT (one bhati) for the whole visit
--   and therefore carries NO reporting value. Every centre filter,
--   grouping and join below uses the sewadar's HOME centre, which is
--   `attendance_sessions.sewadar_centre` on the scan side and
--   `deployments.centre` on the expectation side. Using `centre`
--   here compares a constant against a variable and reports 0%
--   attendance for everyone.
--
-- Non-destructive; safe to re-run. Run AFTER v38c.
-- ROLLBACK: drop all FIVE functions (see verification query 1).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Composite index for the day-scoped summary + scanner ops.
--    v33 covers (schedule_id, badge_number) and the OPEN partial index;
--    neither serves GROUP BY in_date / centre for a whole visit.
--    v40 adds the matching (schedule_id, in_date, sewadar_centre)
--    index, since the scans are filtered and grouped by the sewadar's
--    HOME centre rather than the venue.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dp_att_schedule_date
  ON public.dp_attendance_sessions (schedule_id, in_date, centre);

-- ------------------------------------------------------------
-- 2. attendance_scope_centres — the ONE place scope is decided.
--    Kept as a separate helper so all three analytics RPCs share
--    identical scoping and a future role is added in exactly one place.
--
--    Returns text[]: all centres for aso/super_admin, the caller's
--    subtree for centre roles, the caller's own centre for
--    dept_incharge, and '{}' (empty) for every other role — which
--    makes each RPC return zero rows rather than leak.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_scope_centres(uuid);
CREATE OR REPLACE FUNCTION public.attendance_scope_centres(p_schedule uuid DEFAULT NULL)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text;
  v_centre text;
  v_depts  uuid[];
BEGIN
  v_role   := public.get_portal_user_role();
  v_centre := public.get_portal_user_centre();

  -- Admins see every centre.
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN COALESCE((SELECT array_agg(name) FROM public.dp_centres), ARRAY[]::text[]);
  END IF;

  -- Centre roles see their own subtree (self + SC_SPs).
  IF v_role IN ('centre_user', 'centre_admin') THEN
    RETURN COALESCE(public.get_my_subtree_centres(), ARRAY[]::text[]);
  END IF;

  -- Dept incharge sees only their own centre, narrowed further to their
  -- own departments by the caller.
  IF v_role = 'dept_incharge' THEN
    IF p_schedule IS NULL THEN
      RETURN CASE WHEN v_centre IS NULL THEN ARRAY[]::text[] ELSE ARRAY[v_centre] END;
    END IF;
    v_depts := public.get_my_dept_ids(p_schedule);
    -- No incharge selection for this schedule → no scope at all.
    IF v_depts IS NULL OR cardinality(v_depts) = 0 THEN
      RETURN ARRAY[]::text[];
    END IF;
    RETURN CASE WHEN v_centre IS NULL THEN ARRAY[]::text[] ELSE ARRAY[v_centre] END;
  END IF;

  -- scanner / vss_operator / unknown / SQL-editor (no portal role) → fail closed.
  RETURN ARRAY[]::text[];
END;
$$;

-- ------------------------------------------------------------
-- 3. attendance_allowed_depts — departments the caller may see.
--    NULL means "no department restriction" (admins, centre roles).
--    For dept_incharge it is the intersection of their incharge
--    departments with the schedule, so they can never read a sibling
--    department's attendance even inside their own centre.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_allowed_depts(uuid);
CREATE OR REPLACE FUNCTION public.attendance_allowed_depts(p_schedule uuid)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_depts uuid[];
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge') THEN
    RETURN NULL; -- no restriction
  END IF;
  IF p_schedule IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  v_depts := public.get_my_dept_ids(p_schedule);
  RETURN COALESCE(v_depts, ARRAY[]::uuid[]);
END;
$$;

-- ------------------------------------------------------------
-- 4. attendance_daily_summary — per centre × department, for one day.
--    "expected" = deployed sewadars in that dept (effective dept,
--    mirroring v17 COALESCE(deployed_department_id, department_id))
--    plus the caller's dept restriction.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_daily_summary(uuid, date);
CREATE OR REPLACE FUNCTION public.attendance_daily_summary(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  centre        text,
  department_id uuid,
  dept_name     text,
  expected      bigint,
  present       bigint,
  absent        bigint,
  open_now      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  RETURN QUERY
  WITH scoped_dep AS (
    SELECT d.badge_number, d.centre,
           COALESCE(d.deployed_department_id, d.department_id) AS eff
      FROM public.deployments d
     WHERE d.schedule_id = p_schedule
       AND d.centre = ANY (v_centres)
       AND COALESCE(d.deployed_department_id, d.department_id) IS NOT NULL
       AND (v_depts IS NULL OR COALESCE(d.deployed_department_id, d.department_id) = ANY (v_depts))
  ),
  agg AS (
    SELECT sd.centre, sd.eff AS department_id,
           count(DISTINCT sd.badge_number) AS expected
      FROM scoped_dep sd
     GROUP BY sd.centre, sd.eff
  ),
  -- HOME centre on the presence side. `a.centre` is the constant
  -- venue and must never appear here: joining it against agg.centre
  -- (the home centre) never matches, so present collapsed to 0 for
  -- every row. v_admin bypasses the centre predicate entirely so an
  -- ASO still sees sewadars whose home centre could not be resolved
  -- (sewadar_centre IS NULL).
  present_agg AS (
    SELECT a.sewadar_centre AS centre, a.sewadar_dept AS department_id,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status IN ('OPEN','CLOSED')) AS present,
           count(DISTINCT a.badge_number) FILTER (WHERE a.status = 'OPEN')             AS open_now
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND a.in_date = p_date
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
     GROUP BY a.sewadar_centre, a.sewadar_dept
  )
  SELECT agg.centre,
         agg.department_id,
         d.name,
         agg.expected,
         COALESCE(p.present, 0)  AS present,
         GREATEST(agg.expected - COALESCE(p.present, 0), 0)::bigint AS absent,
         COALESCE(p.open_now, 0) AS open_now
    FROM agg
    LEFT JOIN present_agg p
      ON p.centre = agg.centre
     AND (p.department_id = agg.department_id
          OR (p.department_id IS NULL AND agg.department_id IS NULL))
    LEFT JOIN public.deployment_departments d ON d.id = agg.department_id
   ORDER BY agg.centre, d.name;
END;
$$;

-- ------------------------------------------------------------
-- 5. attendance_sewadar_summary — one row per badge for the whole
--    visit. days_present counts DISTINCT in_date, so an IN/OUT pair
--    on one day counts once, and an overnight OUT (out_date > in_date)
--    still counts on its scan day.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_sewadar_summary(uuid);
CREATE OR REPLACE FUNCTION public.attendance_sewadar_summary(p_schedule uuid)
RETURNS TABLE(
  badge_number    text,
  sewadar_name    text,
  sewadar_centre  text,
  department_id   uuid,
  dept_name       text,
  is_vss          boolean,
  days_present    integer,
  total_scans     bigint,
  open_sessions   bigint,
  first_in_date   date,
  first_in_time   time,
  last_out_date   date,
  last_out_time   time,
  still_open      boolean,
  undeployed_scan boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  -- ONE ROW PER BADGE. This used to GROUP BY badge_number,
  -- sewadar_dept, d.name — but sewadar_dept is a SNAPSHOT TAKEN AT
  -- SCAN TIME, so a sewadar scanned before being deployed (NULL) and
  -- again afterwards yielded TWO rows with split days_present, each
  -- understating the 5-day total. Aggregating first and resolving the
  -- department to the most recent NON-NULL scan fixes the grain.
  RETURN QUERY
  WITH per_badge AS (
    SELECT a.badge_number,
           max(a.sewadar_name)   AS sewadar_name,
           max(a.sewadar_centre) AS sewadar_centre,
           (array_remove(
              array_agg(a.sewadar_dept ORDER BY a.in_date DESC, a.in_time DESC),
              NULL))[1]           AS department_id,
           bool_or(a.is_vss)     AS is_vss,
           count(DISTINCT a.in_date)::integer AS days_present,
           count(*)::bigint      AS total_scans,
           count(*) FILTER (WHERE a.status = 'OPEN')::bigint AS open_sessions,
           min(a.in_date)        AS first_in_date,
           (array_agg(a.in_time ORDER BY a.in_date, a.in_time))[1] AS first_in_time,
           max(a.out_date)       AS last_out_date,
           (array_agg(a.out_time ORDER BY a.out_date DESC NULLS LAST, a.out_time DESC NULLS LAST))[1] AS last_out_time,
           bool_or(a.status = 'OPEN')  AS still_open,
           bool_or(a.undeployed_scan)  AS undeployed_scan
      FROM public.dp_attendance_sessions a
     WHERE a.schedule_id = p_schedule
       AND (v_admin OR a.sewadar_centre = ANY (v_centres))
       AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
     GROUP BY a.badge_number
  )
  SELECT b.badge_number,
         b.sewadar_name,
         b.sewadar_centre,
         b.department_id,
         d.name                       AS dept_name,
         b.is_vss,
         b.days_present,
         b.total_scans,
         b.open_sessions,
         b.first_in_date,
         b.first_in_time,
         b.last_out_date,
         b.last_out_time,
         b.still_open,
         b.undeployed_scan
    FROM per_badge b
    LEFT JOIN public.deployment_departments d ON d.id = b.department_id
   ORDER BY b.sewadar_centre, b.sewadar_name, b.badge_number;
END;
$$;

-- ------------------------------------------------------------
-- 6. attendance_scanner_ops — per scanner, per day. Reports the
--    operator's OWN centre (`in_scanner_centre`), which identifies
--    whose device it was. The scan VENUE (`centre`) is deliberately
--    not reported: it is a single constant bhati for the whole visit.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_scanner_ops(uuid, date);
CREATE OR REPLACE FUNCTION public.attendance_scanner_ops(
  p_schedule uuid,
  p_date     date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
)
RETURNS TABLE(
  scanner_badge   text,
  scanner_name    text,
  scanner_centre  text,
  scans_in        bigint,
  scans_out       bigint,
  open_now        bigint,
  manual_scans    bigint,
  first_in_time   time,
  last_scan_time  time
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));

  RETURN QUERY
  SELECT COALESCE(a.in_scanner_badge, a.out_scanner_badge) AS scanner_badge,
         COALESCE(max(a.in_scanner_name), max(a.out_scanner_name)) AS scanner_name,
         -- The operator's OWN centre, not the venue. `a.centre` is the
         -- single constant bhati and would be identical on every row,
         -- which tells an ops review nothing.
         COALESCE(max(a.in_scanner_centre), max(a.out_scanner_centre)) AS scanner_centre,
         count(*)                    AS scans_in,
         count(*) FILTER (WHERE a.status = 'CLOSED')::bigint AS scans_out,
         count(*) FILTER (WHERE a.status = 'OPEN')::bigint   AS open_now,
         count(*) FILTER (WHERE a.is_manual)::bigint         AS manual_scans,
         (array_agg(a.in_time ORDER BY a.in_time))[1] AS first_in_time,
         (array_agg(COALESCE(a.out_time, a.in_time) ORDER BY COALESCE(a.out_time, a.in_time) DESC))[1] AS last_scan_time
    FROM public.dp_attendance_sessions a
   WHERE a.schedule_id = p_schedule
     AND a.in_date = p_date
     -- Scoped on the SEWADAR's home centre: a centre user sees ops
     -- for scans of their own subtree's people, and open scanning
     -- still works because a foreign-centre scan is attributed to the
     -- sewadar, not to the operator.
     AND (v_admin OR a.sewadar_centre = ANY (v_centres))
     AND (v_depts IS NULL OR a.sewadar_dept = ANY (v_depts))
   GROUP BY COALESCE(a.in_scanner_badge, a.out_scanner_badge)
   ORDER BY count(*) DESC, 2
   -- Safety ceiling only, not a report limit. This was 200, which
   -- silently dropped the LEAST active scanners — precisely the rows
   -- an ops review is looking for, since the sort is by scan count
   -- descending.
   LIMIT 1000;
END;
$$;

-- ------------------------------------------------------------
-- Verification queries (run after applying; expect the listed results)
-- ------------------------------------------------------------
-- 1. All five functions exist:
--    SELECT proname FROM pg_proc
--     WHERE proname IN ('attendance_scope_centres','attendance_allowed_depts',
--                       'attendance_daily_summary','attendance_sewadar_summary',
--                       'attendance_scanner_ops') ORDER BY 1;
--      → 5 rows
-- 2. New index created (and not duplicated):
--    SELECT indexname FROM pg_indexes
--     WHERE tablename = 'dp_attendance_sessions' AND indexname = 'idx_dp_att_schedule_date';
--      → idx_dp_att_schedule_date
-- 3. SCOPE — the important one. Log in as each role and call with a
--    real schedule id:
--      a) aso / super_admin  → attendance_scope_centres(sched) returns
--         EVERY centre name (array length = SELECT count(*) FROM dp_centres).
--      b) centre_user        → returns ONLY their subtree (self + SC_SPs).
--      c) dept_incharge      → array length 1 (their own centre), and
--         attendance_sewadar_summary(sched) returns rows ONLY for
--         departments in their get_my_dept_ids(sched).
--      d) scanner / vss_operator → '{}' (empty) and all three summary
--         RPCs return ZERO rows. This is the fail-closed check.
--    SQL-editor runs (no portal role) also return '{}' → zero rows.
-- 4. Row counts are sane for an admin:
--    SELECT count(*) FROM attendance_sewadar_summary('<schedule>');
--      → ≤ the number of attendance_sessions rows for that schedule
--        (one row per DISTINCT badge), never more.
-- 5. days_present never exceeds the number of distinct scan days:
--    SELECT badge_number, days_present FROM attendance_sewadar_summary('<schedule>')
--     WHERE days_present > 5;
--      → 0 rows
-- 6. GRAIN (C2). The summary must return exactly ONE row per badge.
--    A badge scanned before it was deployed (sewadar_dept IS NULL) and
--    again after MUST still appear once, with its days summed.
--    SELECT count(*) AS rows, count(DISTINCT badge_number) AS badges
--      FROM attendance_sewadar_summary('<schedule>');
--      → rows == badges. Before the fix: rows > badges.
-- 7. VENUE (C1 — apply v40 first). A sewadar whose HOME centre
--    differs from the venue MUST be counted present. This is the
--    check that would have caught the original bug.
--    SELECT centre, sewadar_centre, count(*) FROM dp_attendance_sessions
--     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;
--    Then, as aso, run attendance_daily_summary for a day that has
--    sessions and confirm present > 0 for at least one centre. If
--    every row reads present = 0, the home-centre fix is missing.
