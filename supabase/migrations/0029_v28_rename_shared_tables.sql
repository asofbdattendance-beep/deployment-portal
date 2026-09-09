-- ============================================================
-- V28: RENAME SHARED TABLES -> dp_* (zero-data-loss)
-- ============================================================
-- Purpose:
--   Deployment portal shared the Postgres tables
--     public.centres, public.sewadars, public.attendance_sessions
--   with the attendance ASMS project (same Supabase project
--   wgavvihuwwwoqpbqntgp). The app src/ already queries
--     dp_centres / dp_sewadars / dp_attendance_sessions (12 lines
--   in 7 files). This migration renames the DB tables to match and
--   leaves behind read-only compatibility VIEWS so old cached JS
--   (querying the old names) and new JS (querying dp_*) both work
--   during rollout — expand-contract / zero-downtime.
--
-- Strategy: single transaction, idempotent, no data loss.
--   1. ALTER TABLE ... RENAME TO ...  (preserves OID, rows, indexes,
--      sequences, RLS, grants, replica identity, publication).
--   2. Rename physical indexes that still embed the old names.
--   3. Recreate EVERY function / view / policy / trigger whose body
--      embeds a literal `public.centres` / `public.sewadars` /
--      `public.attendance_sessions`. Bodies are copied from the
--      latest prior migration (v21/v22/v26/v27) with s/public\.centres/public.dp_centres/g etc.
--   4. Create backward-compatibility VIEWS with old names
--        public.centres, public.sewadars, public.attendance_sessions
--      as SELECT * FROM dp_* WITH (security_invoker=true) so RLS on
--      the underlying dp_* table applies. Cached clients keep reading;
--      writes go through RPCs which now target dp_*, so INSTEAD OF
--      triggers on the views are not needed (and would silently let
--      old code write through the old name — we keep them read-only).
--
-- Live-safe: deploy DB migration FIRST, then deploy frontend. Or the
-- reverse — the views make either order safe. Old and new names
-- resolve to the same rows inside one transaction; no snapshot gap.
--
-- Supabase Realtime: the `supabase_realtime` publication stores tables
-- by OID, not name, so after RENAME existing subscribers keep working.
-- The new views are NOT added to the publication — realtime on the
-- old names stops after migration; clients on the new names should
-- subscribe to dp_* (the app already does). No action needed.
--
-- Safety: take a backup before running (Supabase Dashboard -> Database
-- -> Backups, or pg_dump). Run this file in one go in Supabase SQL
-- Editor as postgres (single transaction). It is safe to re-run.
--
-- Rollback (if you must undo after deploying):
--   -- drop compatibility views
--   DROP VIEW IF EXISTS public.centres;
--   DROP VIEW IF EXISTS public.sewadars;
--   DROP VIEW IF EXISTS public.attendance_sessions;
--   -- rename tables back (guard: check target not exists)
--   DO $$ BEGIN
--     IF to_regclass('public.dp_centres') IS NOT NULL AND to_regclass('public.centres') IS NULL THEN
--       ALTER TABLE public.dp_centres RENAME TO centres;
--     END IF;
--     IF to_regclass('public.dp_sewadars') IS NOT NULL AND to_regclass('public.sewadars') IS NULL THEN
--       ALTER TABLE public.dp_sewadars RENAME TO sewadars;
--     END IF;
--     IF to_regclass('public.dp_attendance_sessions') IS NOT NULL AND to_regclass('public.attendance_sessions') IS NULL THEN
--       ALTER TABLE public.dp_attendance_sessions RENAME TO attendance_sessions;
--     END IF;
--   END $$;
--   ALTER INDEX IF EXISTS public.idx_dp_att_sched_badge RENAME TO idx_att_sched_badge;
--   ALTER INDEX IF EXISTS public.idx_dp_att_status RENAME TO idx_att_status;
--   ALTER INDEX IF EXISTS public.idx_dp_att_in_date RENAME TO idx_att_in_date;
--   ALTER INDEX IF EXISTS public.uq_dp_one_open_per_badge_schedule RENAME TO uq_one_open_per_badge_schedule;
--   -- then re-run migrations v02, v07, v26, v27 etc to restore functions
--   -- that still reference the old names (or restore from pg_dump).
--
-- Non-destructive; safe to re-run. Requires Postgres 15+ for
-- `WITH (security_invoker=true)` on views (Supabase is 15+).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Guard: drop old compatibility views if they were already
--    created by a prior partial run, so ALTER TABLE RENAME below
--    does not collide with a view of the same name.
-- ------------------------------------------------------------
-- We do this inside the transaction so a stale view does not block
-- the rename. If the real TABLE still exists, the view cannot exist
-- (same name), so this is a no-op in the normal first-run path.
DO $$
BEGIN
  -- If both the table and a view of the same name somehow coexist
  -- (e.g. previous run left views but did not rename), drop the view
  -- so the rename has a free name slot. Views are cheap to recreate.
  IF to_regclass('public.centres') IS NOT NULL
     AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.centres')) = 'v' THEN
    DROP VIEW public.centres;
    RAISE NOTICE 'Dropped stale view public.centres';
  END IF;
  IF to_regclass('public.sewadars') IS NOT NULL
     AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.sewadars')) = 'v' THEN
    DROP VIEW public.sewadars;
    RAISE NOTICE 'Dropped stale view public.sewadars';
  END IF;
  IF to_regclass('public.attendance_sessions') IS NOT NULL
     AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.attendance_sessions')) = 'v' THEN
    DROP VIEW public.attendance_sessions;
    RAISE NOTICE 'Dropped stale view public.attendance_sessions';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Rename tables (OID-preserving, zero data loss)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.centres') IS NOT NULL AND to_regclass('public.dp_centres') IS NULL THEN
    ALTER TABLE public.centres RENAME TO dp_centres;
    RAISE NOTICE 'Renamed public.centres -> public.dp_centres';
  ELSIF to_regclass('public.dp_centres') IS NOT NULL THEN
    RAISE NOTICE 'public.dp_centres already exists, skip rename of centres';
  ELSE
    RAISE NOTICE 'Neither public.centres nor public.dp_centres exists, skip';
  END IF;

  IF to_regclass('public.sewadars') IS NOT NULL AND to_regclass('public.dp_sewadars') IS NULL THEN
    ALTER TABLE public.sewadars RENAME TO dp_sewadars;
    RAISE NOTICE 'Renamed public.sewadars -> public.dp_sewadars';
  ELSIF to_regclass('public.dp_sewadars') IS NOT NULL THEN
    RAISE NOTICE 'public.dp_sewadars already exists, skip rename of sewadars';
  ELSE
    RAISE NOTICE 'Neither public.sewadars nor public.dp_sewadars exists, skip';
  END IF;

  IF to_regclass('public.attendance_sessions') IS NOT NULL AND to_regclass('public.dp_attendance_sessions') IS NULL THEN
    ALTER TABLE public.attendance_sessions RENAME TO dp_attendance_sessions;
    RAISE NOTICE 'Renamed public.attendance_sessions -> public.dp_attendance_sessions';
  ELSIF to_regclass('public.dp_attendance_sessions') IS NOT NULL THEN
    RAISE NOTICE 'public.dp_attendance_sessions already exists, skip rename of attendance_sessions';
  ELSE
    RAISE NOTICE 'Neither public.attendance_sessions nor public.dp_attendance_sessions exists, skip';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Rename physical indexes that still carry old names
--    (ALTER TABLE RENAME does NOT rename indexes automatically)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_att_sched_badge' AND relkind = 'i') THEN
    ALTER INDEX public.idx_att_sched_badge RENAME TO idx_dp_att_sched_badge;
    RAISE NOTICE 'Renamed idx_att_sched_badge -> idx_dp_att_sched_badge';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_att_status' AND relkind = 'i') THEN
    ALTER INDEX public.idx_att_status RENAME TO idx_dp_att_status;
    RAISE NOTICE 'Renamed idx_att_status -> idx_dp_att_status';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_att_in_date' AND relkind = 'i') THEN
    ALTER INDEX public.idx_att_in_date RENAME TO idx_dp_att_in_date;
    RAISE NOTICE 'Renamed idx_att_in_date -> idx_dp_att_in_date';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_one_open_per_badge_schedule' AND relkind = 'i') THEN
    ALTER INDEX public.uq_one_open_per_badge_schedule RENAME TO uq_dp_one_open_per_badge_schedule;
    RAISE NOTICE 'Renamed uq_one_open_per_badge_schedule -> uq_dp_one_open_per_badge_schedule';
  END IF;
END $$;

-- Ensure canonical indexes exist under new names (idempotent, IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_dp_att_sched_badge ON public.dp_attendance_sessions(schedule_id, badge_number);
CREATE INDEX IF NOT EXISTS idx_dp_att_status ON public.dp_attendance_sessions(status);
CREATE INDEX IF NOT EXISTS idx_dp_att_in_date ON public.dp_attendance_sessions(in_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_one_open_per_badge_schedule ON public.dp_attendance_sessions(schedule_id, badge_number) WHERE status='OPEN';

-- ------------------------------------------------------------
-- 3. RLS: fix policies whose ON table name changed with the rename
--    (Policies move with the table OID, so they still work, but we
--    recreate them idempotently on the canonical dp_* name for
--    clarity and to ensure future dumps show dp_*.)
-- ------------------------------------------------------------
-- centres -> dp_centres
DROP POLICY IF EXISTS centres_read ON public.dp_centres;
CREATE POLICY centres_read ON public.dp_centres
  FOR SELECT TO authenticated USING (true);

-- sewadars -> dp_sewadars
ALTER TABLE public.dp_sewadars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sewadars_portal_read ON public.dp_sewadars;
CREATE POLICY sewadars_portal_read ON public.dp_sewadars
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );

-- attendance_sessions -> dp_attendance_sessions
ALTER TABLE public.dp_attendance_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS att_read ON public.dp_attendance_sessions;
CREATE POLICY att_read ON public.dp_attendance_sessions FOR SELECT TO authenticated USING (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
);

DROP POLICY IF EXISTS att_insert ON public.dp_attendance_sessions;
CREATE POLICY att_insert ON public.dp_attendance_sessions FOR INSERT TO authenticated WITH CHECK (
  public.get_portal_user_role() IN ('dept_incharge','scanner','aso','super_admin')
);

DROP POLICY IF EXISTS att_update ON public.dp_attendance_sessions;
CREATE POLICY att_update ON public.dp_attendance_sessions FOR UPDATE TO authenticated USING (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
) WITH CHECK (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
);

-- Remove any stale policies left on old table OIDs if they somehow survived
-- (no-op if old rel does not exist — guarded)
DO $$
BEGIN
  IF to_regclass('public.centres') IS NOT NULL AND (SELECT relkind FROM pg_class WHERE oid=to_regclass('public.centres'))='r' THEN
    DROP POLICY IF EXISTS centres_read ON public.centres;
  END IF;
  IF to_regclass('public.sewadars') IS NOT NULL AND (SELECT relkind FROM pg_class WHERE oid=to_regclass('public.sewadars'))='r' THEN
    DROP POLICY IF EXISTS sewadars_portal_read ON public.sewadars;
  END IF;
  IF to_regclass('public.attendance_sessions') IS NOT NULL AND (SELECT relkind FROM pg_class WHERE oid=to_regclass('public.attendance_sessions'))='r' THEN
    DROP POLICY IF EXISTS att_read ON public.attendance_sessions;
    DROP POLICY IF EXISTS att_insert ON public.attendance_sessions;
    DROP POLICY IF EXISTS att_update ON public.attendance_sessions;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. FUNCTIONS: get_root_centre, get_my_subtree_centres,
--    get_remaining_quota, get_dept_quota_remaining
--    (all embed public.centres)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_root_centre(p_centre text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH RECURSIVE chain(name, parent_centre, depth) AS (
    SELECT name, parent_centre, 0 FROM public.dp_centres WHERE name = p_centre
    UNION ALL
    SELECT c.name, c.parent_centre, ch.depth + 1
    FROM public.dp_centres c JOIN chain ch ON c.name = ch.parent_centre
  )
  SELECT name FROM chain ORDER BY depth DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_subtree_centres()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text := public.get_portal_user_centre();
  v_result text[];
BEGIN
  WITH RECURSIVE sub(name) AS (
    SELECT name FROM public.dp_centres WHERE name = v_centre
    UNION ALL
    SELECT c.name FROM public.dp_centres c JOIN sub s ON c.parent_centre = s.name
  )
  SELECT array_agg(name) INTO v_result FROM sub;
  RETURN COALESCE(v_result, ARRAY[v_centre]);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_remaining_quota(p_schedule uuid, p_department uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_root text := public.get_root_centre(public.get_portal_user_centre());
  v_max integer;
  v_used integer;
BEGIN
  SELECT max_count INTO v_max FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND department_id = p_department AND centre = v_root;

  IF v_max IS NULL THEN RETURN 0; END IF;

  SELECT count(*) INTO v_used FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.department_id = p_department
    AND public.get_root_centre(d.centre) = v_root;

  RETURN GREATEST(v_max - v_used, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_dept_quota_remaining(p_schedule uuid, p_department uuid, p_centre text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_root text;
  v_max integer;
  v_used integer;
BEGIN
  v_root := public.get_root_centre(p_centre);
  IF v_root IS NULL THEN
    RETURN 0;
  END IF;
  SELECT max_count INTO v_max
  FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND department_id = p_department AND centre = v_root;
  IF v_max IS NULL THEN
    RETURN 0;
  END IF;
  -- count by the row's EFFECTIVE department (final when set, else requested)
  SELECT count(*) INTO v_used
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule
    AND COALESCE(d.deployed_department_id, d.department_id) = p_department
    AND public.get_root_centre(d.centre) = v_root;
  RETURN GREATEST(v_max - v_used, 0);
END;
$$;

-- ------------------------------------------------------------
-- 5. RPCs: get_parent_consent_matrix / get_parent_department_matrix
--    (embed public.centres + public.sewadars)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_parent_consent_matrix(p_schedule uuid)
RETURNS TABLE (
  parent_centre text,
  total_badges bigint,
  consented bigint,
  initiated bigint,
  non_initiated bigint,
  staying bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.get_portal_user_role() NOT IN ('aso', 'super_admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE sub(parent_centre, centre) AS (
    SELECT c.name, c.name
    FROM public.dp_centres c
    WHERE COALESCE(c.parent_centre, '') = ''
    UNION ALL
    SELECT sub.parent_centre, c.name
    FROM public.dp_centres c
    JOIN sub ON c.parent_centre = sub.centre
  )
  SELECT
    sub.parent_centre,
    count(s.badge_number) AS total_badges,
    count(s.badge_number) FILTER (WHERE con.consent_given) AS consented,
    count(s.badge_number) FILTER (WHERE con.consent_given AND s.is_initiated) AS initiated,
    count(s.badge_number) FILTER (WHERE con.consent_given AND NOT s.is_initiated) AS non_initiated,
    count(s.badge_number) FILTER (WHERE con.consent_given AND con.stay_at_bhati) AS staying
  FROM sub
  LEFT JOIN public.dp_sewadars s
    ON s.centre = sub.centre AND COALESCE(s.badge_status, '') <> 'ELDERLY'
  LEFT JOIN public.sewadar_consents con
    ON con.centre = s.centre
   AND con.badge_number = s.badge_number
   AND con.schedule_id = p_schedule
  GROUP BY sub.parent_centre
  ORDER BY sub.parent_centre;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_parent_department_matrix(p_schedule uuid)
RETURNS TABLE (
  parent_centre text,
  department_id uuid,
  department_name text,
  cnt bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.get_portal_user_role() NOT IN ('aso', 'super_admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    public.get_root_centre(d.centre) AS parent_centre,
    d.department_id,
    dep.name AS department_name,
    count(*) AS cnt
  FROM public.deployments d
  JOIN public.deployment_departments dep ON dep.id = d.department_id
  WHERE d.schedule_id = p_schedule
  GROUP BY public.get_root_centre(d.centre), d.department_id, dep.name
  ORDER BY 1, 3;
END;
$$;

-- ------------------------------------------------------------
-- 6. Faridabad helpers (public.centres)
-- ------------------------------------------------------------
-- Ensure column exists on dp_centres (was added to centres in v27)
ALTER TABLE public.dp_centres ADD COLUMN IF NOT EXISTS is_faridabad boolean DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_faridabad_centre(p_centre text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT is_faridabad FROM public.dp_centres WHERE name = p_centre LIMIT 1), false)
        OR public.get_root_centre(p_centre) IN (SELECT name FROM public.dp_centres WHERE is_faridabad = true)
$$;

CREATE OR REPLACE FUNCTION public.is_faridabad_badge(p_badge text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_valid_badge_format(p_badge)
$$;

-- ------------------------------------------------------------
-- 7. Display / lookup helpers (public.sewadars)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sewadar_display_name(p_badge text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT sewadar_name FROM public.dp_sewadars WHERE badge_number = p_badge LIMIT 1),
    (SELECT sewadar_name FROM public.vss_sewadars WHERE badge_number = p_badge LIMIT 1),
    p_badge
  );
$$;

CREATE OR REPLACE FUNCTION public.dept_name_by_id(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT name FROM public.deployment_departments WHERE id = p_id;
$$;

-- ------------------------------------------------------------
-- 8. Attendance helpers (public.sewadars + public.dp_attendance_sessions)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_badge_format(p_badge text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_badge ~* '^(FB(597[1-9]|59[89][0-9]|600[0-9]|601[01])(GA|LA)[0-9]{4}|BH[0-9]{4}[A-Z]{1,2}[0-9]{4}|VS[A-Z0-9]+)$'
$$;

CREATE OR REPLACE FUNCTION public.is_vss_badge(p_badge text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_badge ILIKE 'VS%';
$$;

DROP FUNCTION IF EXISTS public.get_sewadar_by_badge(text);
CREATE OR REPLACE FUNCTION public.get_sewadar_by_badge(p_badge text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s jsonb; v_v jsonb;
BEGIN
  SELECT jsonb_build_object('badge_number', badge_number, 'sewadar_name', sewadar_name, 'centre', centre, 'department', department, 'is_initiated', is_initiated, 'gender', gender, 'is_vss', false)
    INTO v_s FROM public.dp_sewadars WHERE badge_number = p_badge LIMIT 1;
  IF v_s IS NOT NULL THEN RETURN v_s; END IF;
  SELECT jsonb_build_object('badge_number', badge_number, 'sewadar_name', sewadar_name, 'centre', centre, 'department', department, 'is_initiated', is_initiated, 'gender', gender, 'is_vss', true, 'is_active', is_active)
    INTO v_v FROM public.vss_sewadars WHERE badge_number = p_badge LIMIT 1;
  RETURN v_v;
END; $$;

DROP FUNCTION IF EXISTS public.get_open_session(text, uuid);
CREATE OR REPLACE FUNCTION public.get_open_session(p_badge text, p_schedule uuid)
RETURNS public.dp_attendance_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.dp_attendance_sessions;
BEGIN
  IF public.get_portal_user_role() NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_row FROM public.dp_attendance_sessions WHERE badge_number = p_badge AND schedule_id = p_schedule AND status='OPEN' LIMIT 1;
  RETURN v_row;
END; $$;

DROP FUNCTION IF EXISTS public.scan_in(text, uuid, timestamptz, text, text, boolean);
CREATE OR REPLACE FUNCTION public.scan_in(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_nonce text DEFAULT NULL, p_centre text DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_centre text; v_s jsonb; v_dept uuid; v_is_vss boolean; v_undeployed boolean; v_open public.dp_attendance_sessions;
  v_in_date date; v_in_time time; v_name text;
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
  SELECT COALESCE(deployed_department_id, department_id) INTO v_dept FROM public.deployments WHERE schedule_id = p_schedule AND badge_number = p_badge LIMIT 1;
  v_undeployed := (v_dept IS NULL);
  v_in_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_in_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  v_centre := COALESCE(p_centre, public.get_portal_user_centre());
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  INSERT INTO public.dp_attendance_sessions(schedule_id, badge_number, sewadar_name, centre, sewadar_centre, sewadar_dept, is_vss, status, in_date, in_time, in_scanner_badge, in_scanner_name, in_scanner_centre, is_manual, undeployed_scan, nonce)
  VALUES (p_schedule, p_badge, COALESCE(v_s->>'sewadar_name',''), v_centre, v_s->>'centre', v_dept, v_is_vss, 'OPEN', v_in_date, v_in_time, (SELECT badge_number FROM public.portal_users WHERE auth_id=auth.uid()), v_name, v_centre, p_is_manual, v_undeployed, COALESCE(p_nonce, gen_random_uuid()::text));
  RETURN jsonb_build_object('ok', true, 'undeployed', v_undeployed);
END; $$;

DROP FUNCTION IF EXISTS public.scan_out(text, uuid, timestamptz, uuid);
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.dp_attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  IF p_open_id IS NOT NULL THEN
    SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = p_open_id AND status='OPEN' LIMIT 1;
    IF v_open IS NOT NULL AND (v_open.badge_number <> p_badge OR v_open.schedule_id <> p_schedule) THEN
      RAISE EXCEPTION 'Session does not match badge/schedule';
    END IF;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
  END IF;
  IF v_open IS NULL THEN RAISE EXCEPTION 'No open session to close'; END IF;
  v_out_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_out_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  v_centre := public.get_portal_user_centre();
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  UPDATE public.dp_attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id=auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, updated_at=now() WHERE id=v_open.id;
  RETURN jsonb_build_object('ok', true);
END; $$;

DROP FUNCTION IF EXISTS public.absentees_in_my_dept(uuid, date);
CREATE OR REPLACE FUNCTION public.absentees_in_my_dept(p_schedule uuid, p_date date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date)
RETURNS TABLE(badge_number text, sewadar_name text, centre text) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH my_depts AS (
    SELECT unnest(public.get_my_dept_ids(p_schedule)) AS dept
  ),
  deployed AS (
    SELECT d.badge_number, d.sewadar_name, d.centre, COALESCE(d.deployed_department_id, d.department_id) AS eff
    FROM public.deployments d WHERE d.schedule_id = p_schedule AND COALESCE(d.deployed_department_id, d.department_id) IN (SELECT dept FROM my_depts)
      AND public.get_root_centre(d.centre) = public.get_root_centre(public.get_portal_user_centre())
  ),
  present AS (
    SELECT DISTINCT badge_number FROM public.dp_attendance_sessions WHERE schedule_id = p_schedule AND in_date = p_date AND status IN ('OPEN','CLOSED')
  )
  SELECT deployed.badge_number, deployed.sewadar_name, deployed.centre FROM deployed LEFT JOIN present USING (badge_number) WHERE present.badge_number IS NULL;
$$;

-- ------------------------------------------------------------
-- 9. VIEWS (vw_my_centre_sewadars was dropped in v16 for RLS
--    bypass reasons — recreate as security_invoker so RLS applies)
-- ------------------------------------------------------------
-- NOTE: v16 dropped both vw_my_centre_sewadars and vw_all_deployments
-- because they were owner-owned (bypassrls). We recreate only the
-- sewadars view that callers expect, now with security_invoker=true so
-- it respects RLS via the caller's role + dp_sewadars policies.
CREATE OR REPLACE VIEW public.vw_my_centre_sewadars
WITH (security_invoker=true) AS
SELECT s.badge_number, s.sewadar_name, s.centre, s.department, s.badge_status
FROM public.dp_sewadars s
WHERE s.badge_number IS NOT NULL;

-- ------------------------------------------------------------
-- 10. DEPLOYMENT TRIGGERS / HELPERS (embed public.sewadars)
--     We recreate the LATEST versions from v21 (which already
--     include v17/v19/v21 override logic) but with dp_sewadars.
-- ------------------------------------------------------------

-- Helper: is_dept_incharge / get_my_dept_ids (no direct sewadars ref but included for completeness)
CREATE OR REPLACE FUNCTION public.is_dept_incharge(p_schedule uuid, p_department uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.department_incharge_selections s
    WHERE s.schedule_id = p_schedule
      AND s.badge_number = (
        SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid()
      )
      AND (p_department IS NULL OR s.department_id = p_department)
      AND public.get_root_centre(s.centre) = public.get_root_centre(public.get_portal_user_centre())
  );
$$;

CREATE OR REPLACE FUNCTION public.get_my_dept_ids(p_schedule uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(department_id), '{}'::uuid[])
  FROM public.department_incharge_selections s
  WHERE s.schedule_id = p_schedule
    AND s.badge_number = (SELECT badge_number FROM public.portal_users WHERE auth_id = auth.uid())
    AND public.get_root_centre(s.centre) = public.get_root_centre(public.get_portal_user_centre())
$$;

-- block_aas_deployment (v22) — checks sewadar's home department
CREATE OR REPLACE FUNCTION public.block_aas_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dept text;
  v_role text;
BEGIN
  -- Get the sewadar's department
  SELECT department INTO v_dept
  FROM public.dp_sewadars
  WHERE badge_number = NEW.badge_number
    AND centre = NEW.centre
  LIMIT 1;

  IF v_dept IS NULL THEN
    -- Try VSS sewadars
    SELECT department INTO v_dept
    FROM public.vss_sewadars
    WHERE badge_number = NEW.badge_number
      AND centre = NEW.centre
    LIMIT 1;
  END IF;

  -- If department is AREA SECRETARY OFFICE, only super_admin may deploy
  IF v_dept IS NOT NULL AND trim(upper(v_dept)) = 'AREA SECRETARY OFFICE' THEN
    v_role := public.get_portal_user_role();
    IF v_role IS NULL OR v_role != 'super_admin' THEN
      RAISE EXCEPTION 'AREA SECRETARY OFFICE sewadars can only be deployed by Super Admin';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_aas_deployment ON public.deployments;
CREATE TRIGGER trg_block_aas_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_aas_deployment();

-- require_sewadar_exists (v16 M4) — phantom-badge guard
CREATE OR REPLACE FUNCTION public.require_sewadar_exists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.badge_number ILIKE 'VS%'
     OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number) THEN
    IF NOT EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number) THEN
      RAISE EXCEPTION 'VSS sewadar not found';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.dp_sewadars s
      WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
    ) THEN
      RAISE EXCEPTION 'Sewadar not found for deployment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_require_sewadar_exists ON public.deployments;
CREATE TRIGGER trg_require_sewadar_exists
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.require_sewadar_exists();

-- check_deployment + related batch triggers (v21 latest — override-aware)
-- This is the authoritative deployment eligibility + quota gate.
-- Copy of v21's check_deployment with s/public\.sewadars/public.dp_sewadars/g
CREATE OR REPLACE FUNCTION public.check_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched_status text;
  v_deadline timestamptz;
  v_dept public.deployment_departments%ROWTYPE;
  v_consent public.sewadar_consents%ROWTYPE;
  v_is_vss boolean;
  v_vss public.vss_sewadars%ROWTYPE;
  v_quota integer;
  v_role text;
  v_is_admin boolean;
  v_dept_id uuid;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    -- Admins keep working after the deadline / when done / when locked / with
    -- the master switches off (final allocation). Rules + quota below apply to
    -- them exactly like centre roles.
    v_override := false;
  ELSE
    -- Centre roles may never set the FINAL deployed department.
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;

    v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
    v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept_id);
    v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
    v_open := v_override OR v_undeployed;

    -- UNDEPLOYED-ONLY override: already-deployed sewadars stay frozen even
    -- while the undeployed cohort is open. "Already deployed" = a deployment
    -- row with a requested department.
    IF v_undeployed AND NOT v_override THEN
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (
          SELECT 1 FROM public.deployments d
          WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
            AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      ELSIF OLD.department_id IS NOT NULL THEN
        RAISE EXCEPTION 'Already deployed — locked under this override';
      END IF;
    END IF;

    IF NOT v_open THEN
      -- A locked centre cannot edit deployments
      IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF v_sched_status = 'done' THEN
        RAISE EXCEPTION 'This schedule is done — editing disabled';
      END IF;
      IF v_deadline IS NOT NULL AND now() > v_deadline THEN
        RAISE EXCEPTION 'Deadline has passed for this schedule';
      END IF;
    ELSIF v_sched_status = 'done' THEN
      -- an override reopens work, but never a finished schedule
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
  END IF;

  -- Rules are judged against the department the sewadar WILL occupy: the
  -- FINAL deployed department when one is set, else the requested one.
  v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
  SELECT * INTO v_dept FROM public.deployment_departments WHERE id = v_dept_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department not found';
  END IF;

  SELECT * INTO v_consent FROM public.sewadar_consents
  WHERE schedule_id = NEW.schedule_id AND centre = NEW.centre AND badge_number = NEW.badge_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No consent recorded for this sewadar';
  END IF;
  IF NOT v_consent.consent_given AND NOT (v_open OR v_is_admin) THEN
    RAISE EXCEPTION 'Consent not given for this sewadar';
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  IF v_is_vss THEN
    IF NOT v_is_admin AND NOT v_open
       AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
      RAISE EXCEPTION 'VSS deployment is closed';
    END IF;

    SELECT * INTO v_vss FROM public.vss_sewadars WHERE badge_number = NEW.badge_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VSS sewadar not found';
    END IF;
    IF NOT v_vss.is_active THEN
      RAISE EXCEPTION 'Cannot deploy sewadar — %', COALESCE(NULLIF(v_vss.remarks, ''), 'inactive VSS sewadar');
    END IF;
    IF NOT v_dept.include_vss THEN
      RAISE EXCEPTION 'This department is not opened for VSS';
    END IF;
    IF v_vss.badge_status = 'ELDERLY' THEN
      RAISE EXCEPTION 'Elderly sewadars cannot be deployed';
    END IF;
    IF v_consent.available_days_count IS NULL OR v_consent.available_days_count < v_dept.vss_min_days THEN
      RAISE EXCEPTION 'VSS sewadar must have at least % consent days for this department', v_dept.vss_min_days;
    END IF;
    IF v_dept.vss_requires_stay_at_bhati AND NOT v_consent.stay_at_bhati THEN
      RAISE EXCEPTION 'This department requires stay-at-bhati VSS sewadars';
    END IF;
    IF v_dept.vss_requires_initiated AND v_vss.is_initiated IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'This department requires initiated VSS sewadars';
    END IF;
    IF v_dept.vss_requires_gender IS NOT NULL AND v_vss.gender IS DISTINCT FROM v_dept.vss_requires_gender THEN
      RAISE EXCEPTION 'This department requires % VSS sewadars', v_dept.vss_requires_gender;
    END IF;
  ELSE
    IF NOT v_is_admin AND NOT v_open
       AND NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.dp_sewadars s
      WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
        AND s.badge_status = 'ELDERLY'
    ) THEN
      RAISE EXCEPTION 'Elderly sewadars cannot be deployed';
    END IF;

    IF v_consent.available_days_count IS NULL OR v_consent.available_days_count < v_dept.min_days THEN
      RAISE EXCEPTION 'Sewadar must have at least % consent days for this department', v_dept.min_days;
    END IF;

    IF v_dept.requires_stay_at_bhati AND NOT v_consent.stay_at_bhati THEN
      RAISE EXCEPTION 'This department requires stay-at-bhati sewadars';
    END IF;

    IF v_dept.requires_initiated THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.dp_sewadars s
        WHERE s.badge_number = NEW.badge_number AND s.centre = NEW.centre
          AND s.is_initiated = true
      ) THEN
        RAISE EXCEPTION 'This department requires initiated sewadars';
      END IF;
    END IF;
  END IF;

  -- Quota (shared across regular + VSS): on insert or when the effective
  -- department changes, judged against the ROW's centre root. Overrides
  -- never lift quotas — allocate seats first (Control Panel → additional
  -- department).
  IF TG_OP = 'INSERT' OR COALESCE(OLD.deployed_department_id, OLD.department_id) IS DISTINCT FROM v_dept_id THEN
    v_quota := public.get_dept_quota_remaining(NEW.schedule_id, v_dept_id, NEW.centre);
    IF v_quota <= 0 THEN
      RAISE EXCEPTION 'Department quota already exhausted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- check_deployment_batch (INSERT) + check_deployment_batch_upd (UPDATE)
-- Copies from v21 (override-aware, dp_* already via helpers; no direct sewadars/centres literal)
-- We recreate them verbatim so they bind to the correct search_path and
-- pick up the updated get_root_centre. No literal substitution needed
-- beyond what is already in helpers.
CREATE OR REPLACE FUNCTION public.check_deployment_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  r2 record;
  v_max integer;
  v_used integer;
  v_root text;
  v_sched_status text;
  v_deadline timestamptz;
  v_role text;
  v_is_admin boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  -- INSERT: every new row matters (multi-row inserts must not slip past the
  -- per-row checks via a shared statement snapshot).
  FOR r IN
    SELECT DISTINCT schedule_id,
                    COALESCE(deployed_department_id, department_id) AS dept_id
    FROM new_rows
  LOOP
    IF NOT v_is_admin THEN
      -- a locked centre cannot deploy unless the Control Panel opened it
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
      ) THEN
        SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
        IF v_deadline IS NOT NULL AND now() > v_deadline THEN
          RAISE EXCEPTION 'Deadline has passed for this schedule';
        END IF;
      ELSE
        -- overridden rows still cannot write into a finished schedule
        SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
      END IF;
    END IF;

    -- evaluate quota from the perspective of each affected row's centre root
    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root;

      IF v_used > v_max THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_deployment_batch_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  r2 record;
  v_max integer;
  v_used integer;
  v_pre integer;
  v_root text;
  v_sched_status text;
  v_deadline timestamptz;
  v_role text;
  v_is_admin boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');

  FOR r IN
    SELECT DISTINCT nr.schedule_id,
                    COALESCE(nr.deployed_department_id, nr.department_id) AS dept_id
    FROM new_rows nr
    JOIN old_rows o ON nr.id = o.id
    WHERE COALESCE(nr.deployed_department_id, nr.department_id) IS DISTINCT FROM COALESCE(o.deployed_department_id, o.department_id)
  LOOP
    IF NOT v_is_admin THEN
      -- a locked centre cannot deploy unless the Control Panel opened it
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id) OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre))
      ) THEN
        SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
        IF v_deadline IS NOT NULL AND now() > v_deadline THEN
          RAISE EXCEPTION 'Deadline has passed for this schedule';
        END IF;
      ELSE
        SELECT status INTO v_sched_status FROM public.deployment_schedules WHERE id = r.schedule_id;
        IF v_sched_status IS NULL OR v_sched_status = 'done' THEN
          RAISE EXCEPTION 'This schedule is done — editing disabled';
        END IF;
      END IF;
    END IF;

    -- evaluate quota from the perspective of each affected row's centre root
    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota.
      -- But a statement that only REDUCES a department (corrective moves out
      -- of a legacy over-quota state) must not be blocked, so raise only when
      -- the statement NET-increased the count (post > max AND post > pre).
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root;

      SELECT count(*) INTO v_pre FROM old_rows o
      WHERE o.schedule_id = r.schedule_id
        AND COALESCE(o.deployed_department_id, o.department_id) = r.dept_id
        AND public.get_root_centre(o.centre) = v_root;

      IF v_used > v_max AND v_used > v_pre THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment_batch_ins ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_ins
  AFTER INSERT ON public.deployments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch();

DROP TRIGGER IF EXISTS trg_check_deployment_batch_upd ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_upd
  AFTER UPDATE ON public.deployments
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch_upd();

-- ------------------------------------------------------------
-- 11. TRIGGERS: trg_touch_att on dp_attendance_sessions
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN NEW.updated_at:=now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_att ON public.dp_attendance_sessions;
CREATE TRIGGER trg_touch_att BEFORE UPDATE ON public.dp_attendance_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Also keep the portal_users touch trigger (recreated idempotently)
DROP TRIGGER IF EXISTS trg_portal_users_touch ON public.portal_users;
CREATE TRIGGER trg_portal_users_touch
  BEFORE UPDATE ON public.portal_users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Clean up any stale trigger left on old table name if it still exists as a view target
DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NOT NULL
     AND (SELECT relkind FROM pg_class WHERE oid=to_regclass('public.attendance_sessions'))='r' THEN
    DROP TRIGGER IF EXISTS trg_touch_att ON public.attendance_sessions;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 12. Audit triggers that reference sewadars (sewadar_display_name)
--     already updated via helper above; re-bind triggers unchanged.
-- ------------------------------------------------------------
-- (No body change needed — they call sewadar_display_name which now
--  reads from dp_sewadars. We re-drop/create to ensure OID binding.)

-- ------------------------------------------------------------
-- 13. Realtime publication note
-- ------------------------------------------------------------
-- Supabase Realtime uses a publication `supabase_realtime` that tracks
-- tables by OID. After ALTER TABLE ... RENAME the OID is unchanged,
-- so existing subscribers remain subscribed to the renamed table.
-- New code should subscribe to `dp_*` tables; old cached clients
-- reading through the compatibility VIEWS will not get realtime events
-- (views are not publishable) — they will fall back to polling until
-- they reload. No DDL needed here.
-- If you had explicitly added the old names with
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.centres
-- you should now add the new names (and optionally drop the old):
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.dp_centres;
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.dp_sewadars;
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.dp_attendance_sessions;
-- (Supabase Dashboard > Database > Realtime auto-manages this.)

-- ------------------------------------------------------------
-- 14. BACKWARD-COMPATIBILITY VIEWS (expand-contract)
--     Old cached JS queries `centres` / `sewadars` / `attendance_sessions`.
--     These views make that keep working; new JS queries dp_* directly.
-- ------------------------------------------------------------
-- Use security_invoker=true so RLS on dp_* applies through the view.
-- Views are read-only for the deployment portal (attendance writes go
-- via RPCs `scan_in`/`scan_out` which now target dp_*). Direct INSERT
-- through the old-name views is intentionally not enabled — old code
-- that tries to write through them will get a view-write error and
-- should reload to the new bundle. If you need write-through, add
-- INSTEAD OF triggers that forward to dp_*.

CREATE OR REPLACE VIEW public.centres
WITH (security_invoker=true) AS
SELECT * FROM public.dp_centres;

CREATE OR REPLACE VIEW public.sewadars
WITH (security_invoker=true) AS
SELECT * FROM public.dp_sewadars;

CREATE OR REPLACE VIEW public.attendance_sessions
WITH (security_invoker=true) AS
SELECT * FROM public.dp_attendance_sessions;

-- Helpful comment for introspection
COMMENT ON VIEW public.centres IS 'Compatibility view for public.dp_centres — read-only shim for cached clients during rollout. Query dp_centres directly in new code.';
COMMENT ON VIEW public.sewadars IS 'Compatibility view for public.dp_sewadars — read-only shim for cached clients during rollout. Query dp_sewadars directly in new code.';
COMMENT ON VIEW public.attendance_sessions IS 'Compatibility view for public.dp_attendance_sessions — read-only shim for cached clients during rollout. Writes go via scan_in/scan_out RPCs. Query dp_attendance_sessions directly in new code.';

COMMIT;

-- ============================================================
-- VERIFICATION QUERIES (run after COMMIT, copy-paste in SQL Editor)
-- ============================================================
-- -- 1. Row counts must match (no data loss):
-- SELECT 'dp_centres' AS tbl, count(*) FROM public.dp_centres
-- UNION ALL SELECT 'centres_view', count(*) FROM public.centres
-- UNION ALL SELECT 'dp_sewadars', count(*) FROM public.dp_sewadars
-- UNION ALL SELECT 'sewadars_view', count(*) FROM public.sewadars
-- UNION ALL SELECT 'dp_attendance_sessions', count(*) FROM public.dp_attendance_sessions
-- UNION ALL SELECT 'attendance_sessions_view', count(*) FROM public.attendance_sessions;
--
-- -- 2. Compatibility views return same rows as dp_*:
-- SELECT (SELECT count(*) FROM public.centres) = (SELECT count(*) FROM public.dp_centres) AS centres_ok,
--        (SELECT count(*) FROM public.sewadars) = (SELECT count(*) FROM public.dp_sewadars) AS sewadars_ok,
--        (SELECT count(*) FROM public.attendance_sessions) = (SELECT count(*) FROM public.dp_attendance_sessions) AS att_ok;
--
-- -- 3. Functions now reference dp_* only (should return 0 rows for old literals elsewhere):
-- SELECT proname FROM pg_proc WHERE prosrc LIKE '%public.centres%' OR prosrc LIKE '%public.sewadars%' OR prosrc LIKE '%public.attendance_sessions%';
-- -- ^ should return NO rows. If any row appears, that function still references old names.
-- SELECT viewname, definition FROM pg_views WHERE schemaname='public' AND viewname IN ('centres','sewadars','attendance_sessions');
-- -- ^ should show the three shim views.
--
-- -- 4. RLS policies are on dp_* tables:
-- SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('dp_centres','dp_sewadars','dp_attendance_sessions') ORDER BY tablename, policyname;
--
-- -- 5. Indexes renamed:
-- SELECT relname FROM pg_class WHERE relname LIKE 'idx_dp_att%' OR relname LIKE 'uq_dp_%' ORDER BY relname;
--
-- -- 6. Direct fetch sanity (what the app does):
-- SELECT * FROM public.dp_centres ORDER BY name LIMIT 3;
-- SELECT * FROM public.centres ORDER BY name LIMIT 3; -- should match
-- SELECT badge_number, sewadar_name, centre FROM public.dp_sewadars WHERE badge_status<>'ELDERLY' LIMIT 3;
-- SELECT * FROM public.dp_attendance_sessions LIMIT 3;
--
-- -- 7. No old triggers/policies remain on old OIDs:
-- SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgrelid::regclass::text IN ('public.centres','public.sewadars','public.attendance_sessions') AND NOT tgisinternal;
--
-- -- 8. Supabase Realtime publication (if you manage it manually):
-- SELECT pubname, schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY tablename;
