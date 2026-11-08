-- ============================================================
-- V81: DEPARTMENT SHIFT CUTOFFS & TIMING TAGS (Late In / Early Out)
-- Run AFTER v80.
--
-- Why: December 2026 visit requires department-wise shift cutoffs
-- (Expected IN time / Expected OUT time) configured per schedule or
-- falling back to department defaults, without blocking scanning.
-- When a sewadar is scanned, the system automatically evaluates
-- whether they arrived after the IN cutoff ("Late In") or departed
-- before the OUT cutoff ("Early Out").
--
-- Non-destructive; safe to re-run.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Add timing tags to dp_attendance_sessions
-- ------------------------------------------------------------
ALTER TABLE public.dp_attendance_sessions
  ADD COLUMN IF NOT EXISTS is_late_in boolean NOT NULL DEFAULT false;

ALTER TABLE public.dp_attendance_sessions
  ADD COLUMN IF NOT EXISTS is_early_out boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. Add default shift cutoffs to deployment_departments
-- ------------------------------------------------------------
ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS expected_in_time time DEFAULT '08:00';

ALTER TABLE public.deployment_departments
  ADD COLUMN IF NOT EXISTS expected_out_time time DEFAULT '17:00';

-- ------------------------------------------------------------
-- 3. Per-schedule department timing overrides
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schedule_department_timings (
  schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  expected_in_time time,
  expected_out_time time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, department_id)
);

ALTER TABLE public.schedule_department_timings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sdt_read ON public.schedule_department_timings;
CREATE POLICY sdt_read ON public.schedule_department_timings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS sdt_write ON public.schedule_department_timings;
CREATE POLICY sdt_write ON public.schedule_department_timings
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('super_admin', 'aso'));

GRANT SELECT ON public.schedule_department_timings TO authenticated;
GRANT ALL ON public.schedule_department_timings TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. scan_in: evaluate and stamp is_late_in
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scan_in(
  p_badge text,
  p_schedule uuid,
  p_ts timestamptz,
  p_nonce text DEFAULT NULL,
  p_centre text DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_venue text;
  v_own_centre text;
  v_s jsonb;
  v_dept uuid;
  v_is_vss boolean;
  v_undeployed boolean;
  v_open public.dp_attendance_sessions;
  v_in_date date;
  v_in_time time;
  v_name text;
  v_badge text;
  v_expected_in time;
  v_is_late_in boolean := false;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;

  -- Idempotency check
  IF p_nonce IS NOT NULL THEN
    PERFORM 1 FROM public.dp_attendance_sessions
     WHERE schedule_id = p_schedule AND nonce = p_nonce;
    IF FOUND THEN
      v_s := public.get_sewadar_by_badge(p_badge);
      SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
        FROM public.deployments
       WHERE schedule_id = p_schedule AND badge_number = p_badge
       ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;
      RETURN jsonb_build_object(
        'ok', true,
        'dedup', true,
        'undeployed', (v_dept IS NULL),
        'late_in', false,
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

  -- Ladder: must not have OPEN session
  SELECT * INTO v_open FROM public.get_open_session(p_badge, p_schedule);
  IF v_open.id IS NOT NULL THEN
    RAISE EXCEPTION 'Already IN — OUT first (open since % %)', v_open.in_date, v_open.in_time;
  END IF;

  -- Effective department
  SELECT COALESCE(deployed_department_id, department_id) INTO v_dept
    FROM public.deployments
   WHERE schedule_id = p_schedule AND badge_number = p_badge
   ORDER BY deployed_department_id NULLS LAST, department_id LIMIT 1;

  v_undeployed := (v_dept IS NULL);

  IF p_ts > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Timestamp cannot be in the future';
  END IF;
  IF p_ts < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Timestamp too old (more than 30 days)';
  END IF;

  v_in_date := (p_ts AT TIME ZONE 'Asia/Kolkata')::date;
  v_in_time := (p_ts AT TIME ZONE 'Asia/Kolkata')::time;

  -- Evaluate shift cutoff for Late In
  IF v_dept IS NOT NULL THEN
    SELECT COALESCE(sdt.expected_in_time, d.expected_in_time) INTO v_expected_in
      FROM public.deployment_departments d
      LEFT JOIN public.schedule_department_timings sdt
        ON sdt.department_id = d.id AND sdt.schedule_id = p_schedule
     WHERE d.id = v_dept;
    IF v_expected_in IS NOT NULL AND v_in_time > v_expected_in THEN
      v_is_late_in := true;
    END IF;
  END IF;

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
    is_manual, undeployed_scan, nonce, is_late_in)
  VALUES (
    p_schedule, p_badge, COALESCE(v_s->>'sewadar_name',''),
    v_venue, v_s->>'centre', v_dept,
    v_is_vss, 'OPEN', v_in_date, v_in_time,
    v_badge, v_name, v_own_centre,
    p_is_manual, v_undeployed, COALESCE(p_nonce, gen_random_uuid()::text), v_is_late_in);

  RETURN jsonb_build_object(
    'ok', true,
    'undeployed', v_undeployed,
    'late_in', v_is_late_in,
    'sewadar_name', COALESCE(v_s->>'sewadar_name',''),
    'sewadar_centre', v_s->>'centre',
    'dept_name', public.dept_name_by_id(v_dept));
END;
$$;

-- ------------------------------------------------------------
-- 5. scan_out: evaluate and stamp is_early_out
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scan_out(
  p_badge text,
  p_schedule uuid,
  p_ts timestamptz,
  p_open_id uuid DEFAULT NULL,
  p_is_manual boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_open public.dp_attendance_sessions;
  v_role text;
  v_out_date date;
  v_out_time time;
  v_name text;
  v_centre text;
  v_found boolean;
  v_expected_out time;
  v_is_early_out boolean := false;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role IS NULL OR v_role NOT IN ('dept_incharge','scanner','aso','super_admin') THEN
    RAISE EXCEPTION 'Not authorized to scan';
  END IF;

  IF p_open_id IS NOT NULL THEN
    SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = p_open_id LIMIT 1 FOR UPDATE;
    v_found := FOUND;
  ELSE
    v_open := public.get_open_session(p_badge, p_schedule);
    v_found := v_open.id IS NOT NULL;
    IF v_found THEN
      SELECT * INTO v_open FROM public.dp_attendance_sessions WHERE id = v_open.id FOR UPDATE;
      v_found := FOUND;
    END IF;
  END IF;

  IF v_found AND (v_open.badge_number <> p_badge OR v_open.schedule_id <> p_schedule) THEN
    RAISE EXCEPTION 'Session does not match badge/schedule';
  END IF;

  -- Dedup branch: already closed by a real scan
  IF v_found AND v_open.status = 'CLOSED' AND NOT v_open.is_auto_out THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dedup', true,
      'early_out', v_open.is_early_out,
      'message', 'Session already closed',
      'sewadar_name', COALESCE(v_open.sewadar_name,''),
      'sewadar_centre', v_open.sewadar_centre,
      'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
  END IF;

  IF NOT v_found THEN
    RAISE EXCEPTION 'No open session to close';
  END IF;

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

  -- Evaluate shift cutoff for Early Out
  IF v_open.sewadar_dept IS NOT NULL THEN
    SELECT COALESCE(sdt.expected_out_time, d.expected_out_time) INTO v_expected_out
      FROM public.deployment_departments d
      LEFT JOIN public.schedule_department_timings sdt
        ON sdt.department_id = d.id AND sdt.schedule_id = p_schedule
     WHERE d.id = v_open.sewadar_dept;
    IF v_expected_out IS NOT NULL AND v_out_time < v_expected_out THEN
      v_is_early_out := true;
    END IF;
  END IF;

  v_centre := public.get_portal_user_centre();
  v_name := COALESCE((SELECT name FROM public.portal_users WHERE auth_id = auth.uid()), v_centre);

  UPDATE public.dp_attendance_sessions
     SET status = 'CLOSED',
         out_date = v_out_date,
         out_time = v_out_time,
         out_scanner_badge = public.attendance_caller_badge(),
         out_scanner_name = v_name,
         out_scanner_centre = v_centre,
         is_manual = is_manual OR p_is_manual,
         is_auto_out = false,
         is_early_out = v_is_early_out,
         updated_at = now()
   WHERE id = v_open.id
     AND (status = 'OPEN' OR is_auto_out);

  RETURN jsonb_build_object(
    'ok', true,
    'early_out', v_is_early_out,
    'sewadar_name', COALESCE(v_open.sewadar_name,''),
    'sewadar_centre', v_open.sewadar_centre,
    'dept_name', public.dept_name_by_id(v_open.sewadar_dept));
END;
$$;

-- ------------------------------------------------------------
-- 6. Grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_in(text, uuid, timestamptz, text, text, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.scan_out(text, uuid, timestamptz, uuid, boolean) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Version registry
-- ------------------------------------------------------------
INSERT INTO public.portal_version (version) VALUES ('v81')
ON CONFLICT (version) DO NOTHING;

COMMIT;
