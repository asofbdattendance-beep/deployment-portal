-- ============================================================
-- V51: DEPARTMENT-SCOPED DEPT INCHARGE — a dept_incharge oversees a
--       DEPARTMENT across ALL centres, not a centre × department slice.
-- Run AFTER v50.
--
-- WHY (what v25/v28/v39 got wrong for this role):
--
--   A `dept_incharge` login used to be scoped by matching the ROOT CENTRE of
--   its `department_incharge_selections` row against the root centre of its own
--   `portal_users.centre` (sql/v25_dept_incharge_selection.sql:47 and the
--   v28 redefinition at :626-651). So the SAME department was overseen by a
--   different login per centre, and a department incharge could never see a
--   sibling centre's attendance for the department they actually manage.
--
--   v39 then compounded it: `attendance_scope_centres` handed a dept_incharge
--   ARRAY[v_centre] — their own centre ONLY — and `attendance_allowed_depts`
--   intersected that with their department ids. The narrow department filter
--   was therefore applied on top of a centre wall it could never cross.
--
--   The department is the unit of deployment (`deployments.deployed_department_id`
--   / `department_id`, the EFFECTIVE department), so the department is the unit
--   of oversight. This migration makes the scope the department and lifts the
--   centre wall for that one role.
--
-- WHAT CHANGES
--   §1  department_incharge_assignments — the new, per-schedule,
--       department-scoped binding written by the Users page at creation.
--       The legacy `department_incharge_selections` (centre × dept × rank 1/2)
--       table and its Centre-Lists picker are NOT removed: they keep feeding
--       the centre lock's incharge record, and §2 still honours them so an
--       incharge selected the old way keeps working after this ships.
--   §2  get_my_dept_ids / is_dept_incharge — department-only. The centre
--       predicate is GONE; the two sources are UNIONed.
--   §3  attendance_scope_centres — a dept_incharge now gets EVERY centre,
--       still gated on holding at least one department (fail-closed).
--       `attendance_allowed_depts` is NOT redefined: it already returns exactly
--       `get_my_dept_ids(p_schedule)`, so it inherits §2 automatically. This is
--       the single choke point — all eight attendance RPCs call these two
--       helpers (v49 §-list), so none of them needs a body change.
--   §4  att_read — a dept_incharge may now read the sessions of sewadars
--       deployed to their departments even when those sewadars belong to
--       another centre. `att_insert` stays role-only (open scanning) and
--       `att_update` keeps v40's predicate: this widens READING, not writing.
--   §5  portal_invitations — `schedule_id` + `dept_ids` so an invite can carry
--       the department grant. A trigger writes the assignments the moment the
--       invite is claimed, which is why `claim_portal_invite` itself is NOT
--       redefined (v48 stays byte-for-byte intact and re-runnable).
--
-- NOTHING ELSE MOVES: quota, restriction rules, department locking, deadlines,
-- master switches, the v32 deployed-freeze, v15/v16 finalized rows, the scan
-- authorisation ladder and the centre×department incharge record used by the
-- lock are all untouched. A `dept_incharge` still cannot write deployments.
--
-- Non-destructive; safe to re-run. Verification queries at the bottom.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. department_incharge_assignments — the department binding.
--    No `centre` column, deliberately: that is the point of the change.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.department_incharge_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,
  badge_number  text NOT NULL,
  assigned_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, department_id, badge_number)
);
-- get_my_dept_ids is called PER ROW inside the att_read policy, so the lookup
-- has to be an index hit, not a seq scan.
CREATE INDEX IF NOT EXISTS idx_incharge_assign_badge
  ON public.department_incharge_assignments (badge_number, schedule_id);
CREATE INDEX IF NOT EXISTS idx_incharge_assign_schedule
  ON public.department_incharge_assignments (schedule_id, department_id);

ALTER TABLE public.department_incharge_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incharge_assign_read ON public.department_incharge_assignments;
CREATE POLICY incharge_assign_read ON public.department_incharge_assignments
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    -- your own grant
    OR badge_number = public.attendance_caller_badge()
    -- NO CENTRE ARM, deliberately. It used to be
    --   OR public.get_root_centre(public.get_portal_user_centre()) IS NOT NULL
    -- which answers "do you have ANY centre", not "is this row in your
    -- subtree" — so every centre account in the portal could enumerate the
    -- whole portal's badge → department incharge grants. Nothing needs it:
    -- the only client reader of this table is the super_admin-only Users page
    -- (src/pages/UsersPage.jsx), and the Centre Lists picker reads the legacy
    -- `department_incharge_selections` / `department_incharges` tables, which
    -- keep their own centre-scoped policies. Fail closed instead.
  );

DROP POLICY IF EXISTS incharge_assign_write ON public.department_incharge_assignments;
CREATE POLICY incharge_assign_write ON public.department_incharge_assignments
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'))
  WITH CHECK (public.get_portal_user_role() IN ('aso', 'super_admin'));

GRANT ALL ON public.department_incharge_assignments TO authenticated;

-- ------------------------------------------------------------
-- 2. Scope resolution — DEPARTMENT ONLY.
--    UNION of the new grants and the legacy centre × dept selections so the
--    old Centre-Lists picker keeps granting access (it is still the record the
--    centre lock reads) and nobody is locked out by this migration.
--    A `dept_incharge` with no grant of either kind gets '{}' → zero rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_dept_ids(p_schedule uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT array_agg(DISTINCT src.dept)
      FROM (
        SELECT a.department_id AS dept
          FROM public.department_incharge_assignments a
         WHERE a.schedule_id = p_schedule
           AND a.badge_number = public.attendance_caller_badge()
        UNION
        SELECT s.department_id
          FROM public.department_incharge_selections s
         WHERE s.schedule_id = p_schedule
           AND s.badge_number = public.attendance_caller_badge()
      ) src
     WHERE src.dept IS NOT NULL
  ), '{}'::uuid[]);
$$;

CREATE OR REPLACE FUNCTION public.is_dept_incharge(p_schedule uuid, p_department uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_department IS NULL
      THEN COALESCE(cardinality(public.get_my_dept_ids(p_schedule)), 0) > 0
    ELSE public.get_my_dept_ids(p_schedule) @> ARRAY[p_department]
  END;
$$;

-- ------------------------------------------------------------
-- 3. attendance_scope_centres — the centre wall comes down for
--    dept_incharge ONLY, and only when they hold a department.
--    Every other role is byte-identical to v39: aso/super_admin all centres,
--    centre roles their subtree, everyone else '{}' (fail closed).
--    `attendance_allowed_depts` (v39:132-157) needs NO change — it already
--    returns exactly get_my_dept_ids(p_schedule), so the department
--    restriction survives the wider centre list.
-- ------------------------------------------------------------
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

  -- Centre roles see their own subtree (self + SC_SPs). Unchanged.
  IF v_role IN ('centre_user', 'centre_admin') THEN
    RETURN COALESCE(public.get_my_subtree_centres(), ARRAY[]::text[]);
  END IF;

  -- Dept incharge: the DEPARTMENT is the scope, so every centre is in scope —
  -- still fail-closed on holding no grant at all.
  IF v_role = 'dept_incharge' THEN
    IF p_schedule IS NULL THEN
      RETURN ARRAY[]::text[];
    END IF;
    v_depts := public.get_my_dept_ids(p_schedule);
    IF v_depts IS NULL OR cardinality(v_depts) = 0 THEN
      RETURN ARRAY[]::text[];
    END IF;
    RETURN COALESCE((SELECT array_agg(name) FROM public.dp_centres), ARRAY[]::text[]);
  END IF;

  -- scanner / vss_operator / unknown / SQL-editor (no portal role) → fail closed.
  RETURN ARRAY[]::text[];
END;
$$;

-- ------------------------------------------------------------
-- 4. att_read — a dept_incharge may read the sessions of sewadars in
--    THEIR departments, whichever centre those sewadars belong to.
--    This is a READ widening only: att_insert stays role-only (anyone may scan
--    for anyone) and att_update keeps v40's predicate, so a dept_incharge still
--    cannot rewrite somebody else's session.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS att_read ON public.dp_attendance_sessions;
CREATE POLICY att_read ON public.dp_attendance_sessions
  FOR SELECT TO authenticated USING (
     public.attendance_sewadar_centre_visible(sewadar_centre)
  OR in_scanner_badge  = public.attendance_caller_badge()
  OR out_scanner_badge = public.attendance_caller_badge()
  OR (
       public.get_portal_user_role() = 'dept_incharge'
   AND public.get_my_dept_ids(schedule_id) @> ARRAY[sewadar_dept]
  )
  );

-- ------------------------------------------------------------
-- 5. Invites carry the grant; a trigger applies it on claim.
--    `claim_portal_invite` (v48) is deliberately NOT redefined — adding a
--    column and a trigger keeps that file byte-for-byte intact and re-runnable.
-- ------------------------------------------------------------
ALTER TABLE public.portal_invitations
  ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES public.deployment_schedules(id) ON DELETE CASCADE;
ALTER TABLE public.portal_invitations
  ADD COLUMN IF NOT EXISTS dept_ids uuid[];

CREATE OR REPLACE FUNCTION public.grant_incharge_departments_on_claim()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.claimed_at IS NOT NULL
     AND OLD.claimed_at IS NULL
     AND NEW.role = 'dept_incharge'
     AND NEW.schedule_id IS NOT NULL
     AND NEW.badge_number IS NOT NULL THEN
    INSERT INTO public.department_incharge_assignments
      (schedule_id, department_id, badge_number, assigned_by)
    SELECT NEW.schedule_id, d, NEW.badge_number, 'invite'
      FROM unnest(COALESCE(NEW.dept_ids, ARRAY[]::uuid[])) AS d
    ON CONFLICT (schedule_id, department_id, badge_number) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grant_incharge_on_claim ON public.portal_invitations;
CREATE TRIGGER trg_grant_incharge_on_claim
  AFTER UPDATE ON public.portal_invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_incharge_departments_on_claim();

-- ------------------------------------------------------------
-- 6. Backfill: a login that already holds a legacy centre × department
--    selection is UNCHANGED (§2 unions it), so this only materialises the
--    new table for those grants so the Users page can display and edit them.
--    Centre stays out of it on purpose — the row is department-scoped.
-- ------------------------------------------------------------
INSERT INTO public.department_incharge_assignments
  (schedule_id, department_id, badge_number, assigned_by)
SELECT DISTINCT s.schedule_id, s.department_id, s.badge_number, 'backfill:v51'
  FROM public.department_incharge_selections s
 WHERE s.badge_number IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.portal_users p
                WHERE p.badge_number = s.badge_number
                  AND p.role = 'dept_incharge')
ON CONFLICT (schedule_id, department_id, badge_number) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (run in the Supabase SQL editor)
-- ============================================================
-- 1. The table exists with the department key and no centre column:
--    SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'department_incharge_assignments' ORDER BY ordinal_position;
--    -- expect: id, schedule_id, department_id, badge_number, assigned_by, created_at
--
-- 2. As a real dept_incharge (log in as one, then run):
--    SELECT public.get_my_dept_ids('<schedule uuid>') AS my_depts;
--    -- expect: their department ids — NOT empty, and NOT centre-filtered
--
-- 3. Same login, same schedule:
--    SELECT public.attendance_scope_centres('<schedule uuid>') AS centres;
--    -- expect: EVERY centre name (department-scoped, all centres)
--
-- 4. The grant reached the new table (replace the badge):
--    SELECT * FROM public.department_incharge_assignments
--     WHERE badge_number = '<badge>';
--
-- 5. Attendance now crosses centres for that department:
--    SELECT sewadar_centre, count(*) FROM public.dp_attendance_sessions
--     WHERE schedule_id = '<schedule uuid>' GROUP BY 1 ORDER BY 1;
--    -- as the dept_incharge, rows from MORE THAN ONE centre must appear
--
-- 6. A role with no grant still sees nothing (fail closed):
--    SELECT public.attendance_scope_centres('<schedule uuid>');
--    -- as centre_user → their subtree; as scanner → {}
-- ============================================================
