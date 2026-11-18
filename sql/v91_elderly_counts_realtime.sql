-- V91 — run AFTER v90. Non-destructive; re-runnable.

-- ======== V91: elderly consistency + realtime publication ========
-- v90 made regular ELDERLY sewadars deployable, but three read functions still
-- treated them as ineligible: centre counts and the parent consent matrix left
-- them out, and attendance anomalies flagged their scans. Each body below is the
-- latest existing definition with ONLY the ELDERLY condition changed.
BEGIN;

-- get_centre_counts: from sql/v29_optimized_counts.sql
CREATE OR REPLACE FUNCTION public.get_centre_counts(p_schedule uuid, p_centre text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_subtree text[];
  v_root text;
  v_total_sewadars bigint;
  v_total_vss bigint;
  v_total_deployments bigint;
  v_total_consents bigint;
  v_total_finalized bigint;
  v_allocated bigint;
BEGIN
  IF p_schedule IS NULL OR p_centre IS NULL OR btrim(p_centre) = '' THEN
    RAISE EXCEPTION 'p_schedule and p_centre are required';
  END IF;

  -- RLS via portal role: non-admin may only query own subtree
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('aso', 'super_admin') THEN
    IF NOT (p_centre = ANY (public.get_my_subtree_centres())) THEN
      RAISE EXCEPTION 'Not authorized for centre %', p_centre;
    END IF;
  END IF;

  -- build subtree: p_centre + all descendants via dp_centres
  WITH RECURSIVE sub(name) AS (
    SELECT name FROM public.dp_centres WHERE name = p_centre
    UNION ALL
    SELECT c.name FROM public.dp_centres c JOIN sub s ON c.parent_centre = s.name
  )
  SELECT array_agg(name) INTO v_subtree FROM sub;

  IF v_subtree IS NULL THEN
    v_subtree := ARRAY[p_centre];
  END IF;

  v_root := public.get_root_centre(p_centre);

  -- counts scoped to subtree centres — all via COUNT(*)
  SELECT count(*) INTO v_total_sewadars
  FROM public.dp_sewadars s
  WHERE s.centre = ANY (v_subtree)
    ;

  SELECT count(*) INTO v_total_vss
  FROM public.vss_sewadars vs
  WHERE vs.centre = ANY (v_subtree);

  SELECT count(*) INTO v_total_deployments
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.centre = ANY (v_subtree);

  SELECT count(*) INTO v_total_consents
  FROM public.sewadar_consents sc
  WHERE sc.schedule_id = p_schedule AND sc.centre = ANY (v_subtree) AND sc.consent_given = true;

  SELECT count(*) INTO v_total_finalized
  FROM public.deployments d
  WHERE d.schedule_id = p_schedule AND d.centre = ANY (v_subtree) AND d.deployed_department_id IS NOT NULL;

  SELECT COALESCE(sum(max_count), 0)::bigint INTO v_allocated
  FROM public.centre_allocations
  WHERE schedule_id = p_schedule AND centre = v_root;

  RETURN jsonb_build_object(
    'centre', p_centre,
    'root_centre', v_root,
    'subtree', to_jsonb(v_subtree),
    'subtree_size', COALESCE(array_length(v_subtree, 1), 1),
    'total_sewadars', v_total_sewadars,
    'total_vss', v_total_vss,
    'total_deployments', v_total_deployments,
    'total_consents', v_total_consents,
    'total_finalized', v_total_finalized,
    'allocated_seats', v_allocated,
    'schedule_id', p_schedule
  );
END;
$$;

-- get_parent_consent_matrix: from sql/v28_rename_shared_tables.sql
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
    ON s.centre = sub.centre
  LEFT JOIN public.sewadar_consents con
    ON con.centre = s.centre
   AND con.badge_number = s.badge_number
   AND con.schedule_id = p_schedule
  GROUP BY sub.parent_centre
  ORDER BY sub.parent_centre;
END;
$$;

-- attendance_anomalies: from sql/v61_visit_window_scope.sql
CREATE OR REPLACE FUNCTION public.attendance_anomalies(
  p_schedule uuid,
  p_date     date DEFAULT NULL
)
RETURNS TABLE(
  rule           text,
  badge_number   text,
  sewadar_name   text,
  sewadar_centre text,
  dept_name      text,
  detail         text,
  event_date     date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_centres text[];
  v_depts   uuid[];
  v_role    text;
  v_admin   boolean;
  v_today   date;
  v_window  date[];
  v_windowed boolean;
BEGIN
  IF p_schedule IS NULL THEN RETURN; END IF;

  v_centres := public.attendance_scope_centres(p_schedule);
  IF v_centres IS NULL OR cardinality(v_centres) = 0 THEN RETURN; END IF;

  v_depts := public.attendance_allowed_depts(p_schedule);
  IF v_depts IS NOT NULL AND cardinality(v_depts) = 0 THEN RETURN; END IF;

  v_role  := public.get_portal_user_role();
  v_admin := (v_role IN ('aso','super_admin'));
  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;

  -- v61 (b): the visit window (see file header).
  v_window := public.schedule_visit_dates(p_schedule);
  v_windowed := (v_window IS NOT NULL AND cardinality(v_window) > 0);

  RETURN QUERY
  -- v61 (e): the six arms feed the subselect below; the severity ordering
  -- applies OUTSIDE it (see tail). A CASE over a UNION result is not a
  -- legal UNION ORDER BY — v59's form raised on every call, so v61 could
  -- not ship it verbatim. Same newest-500-per-arm inputs, same 2000-row
  -- cap, same severity-then-date order.
  SELECT q.rule, q.badge_number, q.sewadar_name, q.sewadar_centre,
         q.dept_name, q.detail, q.event_date
    FROM (
  -- UNDEPLOYED_SCAN: scanned with no deployment row at scan time.
  -- (First arm carries the AS aliases: UNION takes the first branch's
  -- column names, and the outer SELECT reads them as q.rule etc.)
  (SELECT 'UNDEPLOYED_SCAN'::text AS rule,
          a.badge_number, a.sewadar_name, a.sewadar_centre, d.name AS dept_name,
          ('Scanned ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
           || ' with no deployment for this schedule')::text AS detail,
          a.in_date AS event_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.undeployed_scan = true
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC, a.in_time DESC
    LIMIT 500)
  UNION ALL
  -- BAD_STATUS: current badge status outside the eligible list.
  -- v59 (i): the dp_sewadars arm below is unchanged; the second arm against
  -- public.vss_sewadars (same shape) covers VSS badges, which live in the
  -- VSS roster rather than dp_sewadars (columns verified:
  -- sql/v4_vss.sql:18-37).
  (SELECT 'BAD_STATUS'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Badge status ' || max(s.badge_status)
           || ' is not OPEN/PERMANENT — scanned '
           || count(DISTINCT a.id)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.dp_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT','ELDERLY')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY max(a.in_date) DESC
    LIMIT 500)
  UNION ALL
  -- v59 (i): VSS-roster arm, same shape as above.
  (SELECT 'BAD_STATUS'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Badge status ' || max(s.badge_status)
           || ' is not OPEN/PERMANENT — scanned '
           || count(DISTINCT a.id)::text || ' time(s) this visit')::text,
          CASE WHEN p_date IS NULL THEN NULL ELSE p_date END
     FROM public.dp_attendance_sessions a
     JOIN public.vss_sewadars s ON s.badge_number = a.badge_number
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND s.badge_status IS NOT NULL
      AND s.badge_status NOT IN ('OPEN','PERMANENT','ELDERLY')
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number
    ORDER BY max(a.in_date) DESC
    LIMIT 500)
  UNION ALL
  -- MULTI_SESSION: ≥3 INs for one badge on one in_date.
  (SELECT 'MULTI_SESSION'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          (count(*)::text || ' sessions on ' || a.in_date::text)::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND (p_date IS NULL OR a.in_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
   HAVING count(*) >= 3
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  UNION ALL
  -- STALE_OPEN: an OPEN session whose IN is before today (IST).
  (SELECT 'STALE_OPEN'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('Open since ' || a.in_date::text || ' ' || substring(a.in_time::text, 1, 5)
           || ' — no OUT recorded')::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.status = 'OPEN'
      AND a.in_date < v_today
      -- v59 (d): the standard date predicate — a dated Anomalies view shows
      -- only that day's stale opens; p_date NULL keeps the whole-visit sweep.
      AND (p_date IS NULL OR a.in_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date, a.in_time
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  UNION ALL
  -- VSS_DEPT_MISMATCH: a VSS badge scanned outside a VSS department.
  -- v59 (c): the name-prefix HAVING (d.name ILIKE 'VSS%') is replaced with
  -- the v45 predicate on the EFFECTIVE department
  -- (sql/v45_attendance_reports.sql:590): a department is VSS-open iff
  -- deployment_departments.include_vss — verified present at
  -- sql/v4_vss.sql:55 (boolean NOT NULL DEFAULT false). With the LEFT JOIN
  -- kept, a NULL department (undeployed badge with no snapshot) reads as
  -- NOT VSS-open and is flagged — fail closed.
  (SELECT 'VSS_DEPT_MISMATCH'::text,
          a.badge_number,
          max(a.sewadar_name), max(a.sewadar_centre), max(d.name),
          ('VSS badge scanned in ' || coalesce(max(d.name), 'no department')
           || ' — not a VSS department')::text,
          a.in_date
     FROM public.dp_attendance_sessions a
     LEFT JOIN public.deployment_departments d ON d.id = public.attendance_badge_dept(a.badge_number, p_schedule)
    WHERE a.schedule_id = p_schedule
      AND a.is_vss = true
      AND COALESCE(d.include_vss, false) = false
      AND (p_date IS NULL OR a.in_date = p_date OR a.out_date = p_date)
      -- v61 (d): the visit sweep covers visit days only.
      AND (NOT v_windowed OR a.in_date = ANY (v_window) OR a.out_date = ANY (v_window))
      AND (v_admin OR v_depts IS NOT NULL OR a.sewadar_centre = ANY (v_centres))
      -- v55: the attributing department.
      AND (v_depts IS NULL OR public.attendance_badge_dept(a.badge_number, p_schedule) = ANY (v_depts))
    GROUP BY a.badge_number, a.in_date
    -- v59 (g): newest-first so the per-arm cap keeps the newest rows.
    ORDER BY a.in_date DESC
    LIMIT 500)
  -- v59 (g): severity-then-date. The old ORDER BY rule listed BAD_STATUS
  -- first (alphabetical), so one rule's flood filled the old global cap
  -- before v49's per-arm caps; ordering by severity surfaces hung sessions
  -- and undeployed scans first. Exact per-rule counts would need a second
  -- result set, which a single TABLE function cannot return without a
  -- signature change — so the signature is untouched (pure CREATE OR
  -- REPLACE): each arm contributes its NEWEST 500 rows (ORDER BY inside
  -- the arm); the outer query keeps 2000. A simultaneous flood in 4+ arms
  -- can still evict the lowest-severity rule — narrow with p_date in
  -- that case.
  ) q
  ORDER BY CASE q.rule
             WHEN 'STALE_OPEN' THEN 0
             WHEN 'UNDEPLOYED_SCAN' THEN 1
             WHEN 'VSS_DEPT_MISMATCH' THEN 2
             WHEN 'MULTI_SESSION' THEN 3
             WHEN 'BAD_STATUS' THEN 4
             ELSE 5 END,
           q.event_date DESC NULLS LAST
  LIMIT 2000;
END;
$$;

-- Realtime: every table the portal listens to must be in supabase_realtime,
-- otherwise pages never auto-update (re-run of v54, idempotent, add-only).
DO $do$
DECLARE
  v_pub  text := 'supabase_realtime';
  v_list text[] := ARRAY[
    'public.dp_attendance_sessions',
    'public.deployments',
    'public.sewadar_consents',
    'public.deployment_departments',
    'public.centre_allocations',
    'public.centre_locks',
    'public.centre_overrides',
    'public.centre_vss_overrides',
    'public.portal_settings',
    'public.portal_users',
    'public.portal_invitations',
    'public.custom_roles',
    'public.department_incharges',
    'public.department_incharge_selections',
    'public.department_incharge_assignments',
    'public.sewadar_audit_log',
    'public.centre_vss_float'
  ];
  v_t    text;
  v_added text := '';
  v_skipped text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = v_pub) THEN
    RAISE NOTICE 'V91: publication % does not exist on this database — realtime is NOT available. Skipping.', v_pub;
    RETURN;
  END IF;

  FOREACH v_t IN ARRAY v_list LOOP
    IF to_regclass(v_t) IS NULL THEN
      v_skipped := v_skipped || v_t || ' ';
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = v_pub AND schemaname || '.' || tablename = v_t
    ) THEN
      EXECUTE format('ALTER PUBLICATION %I ADD TABLE %s', v_pub, v_t);
      v_added := v_added || v_t || ' ';
    END IF;
  END LOOP;

  RAISE NOTICE 'V91: added to %: %', v_pub, COALESCE(NULLIF(v_added, ''), '(nothing — all already members)');
  IF v_skipped <> '' THEN
    RAISE NOTICE 'V91: skipped, table absent: %', v_skipped;
  END IF;
END;
$do$;

INSERT INTO public.portal_version (version) VALUES ('v91')
ON CONFLICT (version) DO NOTHING;

COMMIT;
