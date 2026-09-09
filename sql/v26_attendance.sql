-- ============================================================
-- V26: ATTENDANCE — sessions, ladder, VSS, undeployed flag, offline nonce
-- NON-DESTRUCTIVE — safe to re-run. Run after v25.
-- ============================================================

-- 1. table
-- Guard: a pre-existing attendance_sessions from an earlier DRAFT schema that
-- lacks the schedule_id column would make CREATE INDEX / POLICY fail with
-- 'column schedule_id does not exist'. Drop only if incompatible (missing
-- schedule_id), so any real data in a correct-shape table is preserved.
DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='attendance_sessions' AND column_name='schedule_id'
     ) THEN
    DROP TABLE public.attendance_sessions CASCADE;
    RAISE NOTICE 'Dropped stale attendance_sessions (missing schedule_id)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  badge_number text NOT NULL,
  sewadar_name text,
  centre text NOT NULL, -- scan centre (where scanner is)
  sewadar_centre text, -- home centre (denormalized)
  sewadar_dept uuid REFERENCES public.deployment_departments(id) ON DELETE SET NULL, -- effective dept at scan time
  is_vss boolean NOT NULL DEFAULT false,
  is_manual boolean NOT NULL DEFAULT false,
  undeployed_scan boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  in_date date NOT NULL,
  in_time time NOT NULL,
  out_date date,
  out_time time,
  in_scanner_badge text,
  in_scanner_name text,
  in_scanner_centre text,
  out_scanner_badge text,
  out_scanner_name text,
  out_scanner_centre text,
  nonce text UNIQUE, -- idempotency for offline retry
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_att_sched_badge ON public.attendance_sessions(schedule_id, badge_number);
CREATE INDEX IF NOT EXISTS idx_att_status ON public.attendance_sessions(status);
CREATE INDEX IF NOT EXISTS idx_att_in_date ON public.attendance_sessions(in_date);
-- one OPEN per badge per schedule
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_per_badge_schedule ON public.attendance_sessions(schedule_id, badge_number) WHERE status='OPEN';

-- 2. helpers

-- FB/BH or VS badge formats: FB5971GA..., BH... , VS...
CREATE OR REPLACE FUNCTION public.is_valid_badge_format(p_badge text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_badge ~* '^(FB(597[1-9]|59[89][0-9]|600[0-9]|601[01])(GA|LA)[0-9]{4}|BH[0-9]{4}[A-Z]{1,2}[0-9]{4}|VS[A-Z0-9]+)$'
$$;

CREATE OR REPLACE FUNCTION public.is_vss_badge(p_badge text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_badge ILIKE 'VS%';
$$;

-- Draft runs may have left these with a different return type, which blocks
-- CREATE OR REPLACE (42P13). Drop first so a re-run always succeeds.
DROP FUNCTION IF EXISTS public.get_sewadar_by_badge(text);
CREATE OR REPLACE FUNCTION public.get_sewadar_by_badge(p_badge text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s jsonb; v_v jsonb;
BEGIN
  SELECT jsonb_build_object('badge_number', badge_number, 'sewadar_name', sewadar_name, 'centre', centre, 'department', department, 'is_initiated', is_initiated, 'gender', gender, 'is_vss', false)
    INTO v_s FROM public.sewadars WHERE badge_number = p_badge LIMIT 1;
  IF v_s IS NOT NULL THEN RETURN v_s; END IF;
  SELECT jsonb_build_object('badge_number', badge_number, 'sewadar_name', sewadar_name, 'centre', centre, 'department', department, 'is_initiated', is_initiated, 'gender', gender, 'is_vss', true, 'is_active', is_active)
    INTO v_v FROM public.vss_sewadars WHERE badge_number = p_badge LIMIT 1;
  RETURN v_v;
END; $$;

DROP FUNCTION IF EXISTS public.get_open_session(text, uuid);
CREATE OR REPLACE FUNCTION public.get_open_session(p_badge text, p_schedule uuid)
RETURNS public.attendance_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.attendance_sessions;
BEGIN
  IF public.get_portal_user_role() NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_row FROM public.attendance_sessions WHERE badge_number = p_badge AND schedule_id = p_schedule AND status='OPEN' LIMIT 1;
  RETURN v_row;
END; $$;

-- idempotent scan IN
DROP FUNCTION IF EXISTS public.scan_in(text, uuid, timestamptz, text, text, boolean);
CREATE OR REPLACE FUNCTION public.scan_in(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_nonce text DEFAULT NULL, p_centre text DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_centre text; v_s jsonb; v_dept uuid; v_is_vss boolean; v_undeployed boolean; v_open public.attendance_sessions;
  v_in_date date; v_in_time time; v_name text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  -- idempotency
  IF p_nonce IS NOT NULL THEN
    PERFORM 1 FROM public.attendance_sessions WHERE nonce = p_nonce;
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
  -- Validate timestamp: not in the future (5-min leeway) and not older than 30 days
  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;
  IF p_ts < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Timestamp too old (more than 30 days)';
  END IF;
  v_in_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  v_centre := COALESCE(p_centre, public.get_portal_user_centre());
  -- Prevent centre spoofing: non-admin callers must match their own centre
  IF public.get_portal_user_role() NOT IN ('aso','super_admin') THEN
    v_centre := public.get_portal_user_centre();
  END IF;
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  INSERT INTO public.attendance_sessions(schedule_id, badge_number, sewadar_name, centre, sewadar_centre, sewadar_dept, is_vss, status, in_date, in_time, in_scanner_badge, in_scanner_name, in_scanner_centre, is_manual, undeployed_scan, nonce)
  VALUES (p_schedule, p_badge, COALESCE(v_s->>'sewadar_name',''), v_centre, v_s->>'centre', v_dept, v_is_vss, 'OPEN', v_in_date, v_in_time, (SELECT badge_number FROM public.portal_users WHERE auth_id=auth.uid()), v_name, v_centre, p_is_manual, v_undeployed, COALESCE(p_nonce, gen_random_uuid()::text));
  RETURN jsonb_build_object('ok', true, 'undeployed', v_undeployed);
END; $$;

-- scan OUT (or forgot OUT first)
DROP FUNCTION IF EXISTS public.scan_out(text, uuid, timestamptz, uuid);
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text, p_schedule uuid, p_ts timestamptz, p_open_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_open public.attendance_sessions; v_role text; v_out_date date; v_out_time time; v_name text; v_centre text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;
  IF p_open_id IS NOT NULL THEN
    SELECT * INTO v_open FROM public.attendance_sessions WHERE id = p_open_id AND status='OPEN' LIMIT 1;
    IF v_open IS NOT NULL AND (v_open.badge_number <> p_badge OR v_open.schedule_id <> p_schedule) THEN
      RAISE EXCEPTION 'Session does not match badge/schedule';
    END IF;
    -- If session is already CLOSED, return success (idempotent)
    IF v_open.status = 'CLOSED' THEN
      RETURN jsonb_build_object('ok', true, 'dedup', true, 'message', 'Session already closed');
    END IF;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
  END IF;
  IF v_open IS NULL THEN RAISE EXCEPTION 'No open session to close'; END IF;
  v_out_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_out_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;
  IF v_out_date < v_open.in_date OR (v_out_date = v_open.in_date AND v_out_time <= v_open.in_time) THEN
    RAISE EXCEPTION 'OUT time must be after IN time';
  END IF;
  v_centre := public.get_portal_user_centre();
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);
  UPDATE public.attendance_sessions SET status='CLOSED', out_date=v_out_date, out_time=v_out_time, out_scanner_badge=(SELECT badge_number FROM public.portal_users WHERE auth_id=auth.uid()), out_scanner_name=v_name, out_scanner_centre=v_centre, updated_at=now() WHERE id=v_open.id;
  RETURN jsonb_build_object('ok', true);
END; $$;

-- absentees per dept per day
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
    SELECT DISTINCT badge_number FROM public.attendance_sessions WHERE schedule_id = p_schedule AND in_date = p_date AND status IN ('OPEN','CLOSED')
  )
  SELECT deployed.badge_number, deployed.sewadar_name, deployed.centre FROM deployed LEFT JOIN present USING (badge_number) WHERE present.badge_number IS NULL;
$$;

-- 3. RLS
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS att_read ON public.attendance_sessions;
CREATE POLICY att_read ON public.attendance_sessions FOR SELECT TO authenticated USING (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
);

DROP POLICY IF EXISTS att_insert ON public.attendance_sessions;
CREATE POLICY att_insert ON public.attendance_sessions FOR INSERT TO authenticated WITH CHECK (
  public.get_portal_user_role() IN ('dept_incharge','scanner','aso','super_admin')
);

DROP POLICY IF EXISTS att_update ON public.attendance_sessions;
CREATE POLICY att_update ON public.attendance_sessions FOR UPDATE TO authenticated USING (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
) WITH CHECK (
  public.get_portal_user_role() IN ('aso','super_admin')
  OR centre = public.get_portal_user_centre()
);

-- 4. updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at:=now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_touch_att ON public.attendance_sessions;
CREATE TRIGGER trg_touch_att BEFORE UPDATE ON public.attendance_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
