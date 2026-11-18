-- CATCH-UP PATCH: v88 -> v89 -> v90 -> v91, run as ONE script in Supabase SQL Editor.
-- Additive + idempotent only: no table, column or row is deleted. The only DROP
-- lines drop-and-immediately-recreate triggers/policies. Safe to run twice.
-- Fixes: "function public.vss_float_count_for_centre(text) does not exist" on
-- every centre deploy / consent+department save; elderly counts/anomalies;
-- realtime publication so pages auto-update.

BEGIN;  -- ONE transaction: any error rolls back EVERYTHING, nothing half-applied
SET LOCAL lock_timeout = '10s';  -- never queue behind a long save; just fail cleanly and retry

-- ======== sql/v88_vss_duplicate_guard.sql ========
-- ============================================================
-- V88: BLOCK DUPLICATE VSS REGISTRATIONS (fuzzy match)
-- Run AFTER v87.
--
-- Why: a centre could register the same person twice (a typo in the name,
-- different spacing / word order, or a person already on the VSS roster
-- from another centre). The only duplicate check was an exact name/Aadhar
-- warning at VSFB-assign time, after the duplicate already existed.
--
-- What:
--   • find_vss_duplicates(...) — SECURITY DEFINER so a centre user sees
--     matches in EVERY centre (RLS would hide them). Returns only the VSS ID,
--     name, centre and match reasons — never Aadhar / contact / DOB.
--   • trg_vss_reg_block_duplicate — BEFORE INSERT on vss_registrations:
--     raises 'This VSS record already exists: <ids>' when any match is found.
--     Applies to every role.
--
-- Match rule (a row matches when ANY holds):
--   1. same Aadhar (digits only)
--   2. similar name AND same date of birth
--        similar = equal after normalising (case, punctuation, spacing,
--        word order) or a small edit distance (1 for names ≤ 6 letters,
--        2 up to 12, 3 beyond)
--   3. same normalised name AND (similar father/husband name OR same phone)
-- Rule 3 needs the name to match exactly (after normalising) because family
-- members share a father's name and phone number.
--
-- Searched: vss_sewadars (roster, VSS ID = badge_number) and
-- vss_registrations not yet on the roster (VSS ID = temp_vss_id).
-- Non-destructive; re-runnable.
-- ============================================================

-- (inner BEGIN removed — whole patch is one transaction)
-- Upper-case letters only, single spaces between words.
CREATE OR REPLACE FUNCTION public._vss_norm_name(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(upper(coalesce(p, '')), '[^A-Z ]', '', 'g'), '\s+', ' ', 'g')), '')
$$;

-- Words sorted, no spaces — "KUMAR RAM" = "RAM KUMAR" = "RAMKUMAR".
CREATE OR REPLACE FUNCTION public._vss_name_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NULLIF(string_agg(w, '' ORDER BY w), '')
  FROM unnest(string_to_array(public._vss_norm_name(p), ' ')) AS w
$$;

-- Roster rows store DD/MM/YYYY, registrations store YYYY-MM-DD.
CREATE OR REPLACE FUNCTION public._vss_norm_dob(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(p) ~ '^\d{4}-\d{1,2}-\d{1,2}$' THEN
      split_part(btrim(p), '-', 1) || '-' || lpad(split_part(btrim(p), '-', 2), 2, '0') || '-' || lpad(split_part(btrim(p), '-', 3), 2, '0')
    WHEN btrim(p) ~ '^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$' THEN
      split_part(regexp_replace(btrim(p), '[/.-]', '/', 'g'), '/', 3) || '-' ||
      lpad(split_part(regexp_replace(btrim(p), '[/.-]', '/', 'g'), '/', 2), 2, '0') || '-' ||
      lpad(split_part(regexp_replace(btrim(p), '[/.-]', '/', 'g'), '/', 1), 2, '0')
    ELSE NULL
  END
$$;

-- Last 10 digits of a phone number (drops +91 / leading 0).
CREATE OR REPLACE FUNCTION public._vss_norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN length(d) >= 10 THEN right(d, 10) END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$$;

-- Plain Levenshtein distance (no fuzzystrmatch dependency).
CREATE OR REPLACE FUNCTION public._vss_levenshtein(a text, b text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  la int := length(a);
  lb int := length(b);
  prev int[];
  cur int[];
  i int;
  j int;
BEGIN
  IF la = 0 THEN RETURN lb; END IF;
  IF lb = 0 THEN RETURN la; END IF;
  prev := array(SELECT generate_series(0, lb));
  FOR i IN 1..la LOOP
    cur := array[i];
    FOR j IN 1..lb LOOP
      cur := cur || least(
        cur[j] + 1,
        prev[j + 1] + 1,
        prev[j] + CASE WHEN substr(a, i, 1) = substr(b, j, 1) THEN 0 ELSE 1 END
      );
    END LOOP;
    prev := cur;
  END LOOP;
  RETURN prev[lb + 1];
END;
$$;

CREATE OR REPLACE FUNCTION public._vss_names_similar(a text, b text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN ka IS NULL OR kb IS NULL THEN false
    WHEN ka = kb THEN true
    ELSE public._vss_levenshtein(ka, kb) <=
      CASE WHEN least(length(ka), length(kb)) <= 6 THEN 1
           WHEN least(length(ka), length(kb)) <= 12 THEN 2
           ELSE 3 END
  END
  FROM (SELECT public._vss_name_key(a) AS ka, public._vss_name_key(b) AS kb) s
$$;

CREATE OR REPLACE FUNCTION public.find_vss_duplicates(
  p_name text,
  p_father text DEFAULT NULL,
  p_dob text DEFAULT NULL,
  p_aadhar text DEFAULT NULL,
  p_contact text DEFAULT NULL,
  p_emergency text DEFAULT NULL,
  p_exclude_reg uuid DEFAULT NULL
)
RETURNS TABLE (source text, vss_id text, sewadar_name text, centre text, reasons text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH input AS (
    SELECT public._vss_name_key(p_name) AS name_key,
           public._vss_norm_dob(p_dob) AS dob,
           NULLIF(regexp_replace(coalesce(p_aadhar, ''), '\D', '', 'g'), '') AS aadhar,
           array_remove(ARRAY[public._vss_norm_phone(p_contact), public._vss_norm_phone(p_emergency)], NULL) AS phones
  ),
  candidates AS (
    SELECT 'roster'::text AS source, v.badge_number AS vss_id, v.sewadar_name, v.centre,
           v.father_husband_name AS father, v.dob, v.aadhar_number AS aadhar,
           v.contact_no, v.emergency_contact
    FROM public.vss_sewadars v
    UNION ALL
    SELECT 'registration', coalesce(r.assigned_badge_number, r.temp_vss_id), r.sewadar_name, r.centre,
           r.father_husband_name, r.dob, r.aadhar_number, r.contact_no, r.emergency_contact
    FROM public.vss_registrations r
    WHERE (p_exclude_reg IS NULL OR r.id <> p_exclude_reg)
      -- assigned registrations are already listed through the roster
      AND NOT EXISTS (SELECT 1 FROM public.vss_sewadars v WHERE v.badge_number = r.assigned_badge_number)
  ),
  scored AS (
    SELECT c.source, c.vss_id, c.sewadar_name, c.centre,
      array_remove(ARRAY[
        CASE WHEN i.aadhar IS NOT NULL
              AND regexp_replace(coalesce(c.aadhar, ''), '\D', '', 'g') = i.aadhar
             THEN 'same Aadhar' END,
        CASE WHEN i.dob IS NOT NULL AND public._vss_norm_dob(c.dob) = i.dob
              AND public._vss_names_similar(p_name, c.sewadar_name)
             THEN 'similar name + same date of birth' END,
        CASE WHEN i.name_key IS NOT NULL AND public._vss_name_key(c.sewadar_name) = i.name_key
              AND public._vss_names_similar(p_father, c.father)
             THEN 'same name + same father/husband name' END,
        CASE WHEN i.name_key IS NOT NULL AND public._vss_name_key(c.sewadar_name) = i.name_key
              AND cardinality(i.phones) > 0
              AND (public._vss_norm_phone(c.contact_no) = ANY (i.phones)
                   OR public._vss_norm_phone(c.emergency_contact) = ANY (i.phones))
             THEN 'same name + same phone number' END
      ], NULL) AS reasons
    FROM candidates c CROSS JOIN input i
  )
  SELECT source, vss_id, sewadar_name, centre, reasons
  FROM scored
  WHERE cardinality(reasons) > 0
  ORDER BY source DESC, vss_id
$$;

REVOKE ALL ON FUNCTION public.find_vss_duplicates(text, text, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_vss_duplicates(text, text, text, text, text, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.vss_reg_block_duplicate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text;
BEGIN
  -- serialise registration inserts so two sessions cannot both slip the
  -- same person past the check (registrations are low-volume)
  PERFORM pg_advisory_xact_lock(hashtext('vss_registrations_duplicate_guard'));
  SELECT string_agg(DISTINCT d.vss_id || ' (' || d.sewadar_name || ', ' || coalesce(d.centre, '—') || ')', ', ')
    INTO v_ids
  FROM public.find_vss_duplicates(NEW.sewadar_name, NEW.father_husband_name, NEW.dob,
                                  NEW.aadhar_number, NEW.contact_no, NEW.emergency_contact, NEW.id) d;
  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'This VSS record already exists: %', v_ids;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vss_reg_block_duplicate ON public.vss_registrations;
CREATE TRIGGER trg_vss_reg_block_duplicate
  BEFORE INSERT ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.vss_reg_block_duplicate();

INSERT INTO public.portal_version (version) VALUES ('v88')
ON CONFLICT (version) DO NOTHING;

-- (inner COMMIT removed)
-- ============================================================
-- VERIFICATION
-- 1. SELECT * FROM public.find_vss_duplicates('abhay  singh', NULL, '2007-09-06');
--    → the roster row VSFB5971GB4629 (similar name + same date of birth)
-- 2. SELECT * FROM public.find_vss_duplicates('Singh Abhay', 'Kamaljit Singh');
--    → same row (same name + same father/husband name)
-- 3. INSERT a vss_registrations row for that person → raises
--    'This VSS record already exists: VSFB5971GB4629 (ABHAY SINGH, DLF CITY GURGAON)'
-- ============================================================

-- ======== sql/v89_vss_float_count.sql ========
-- ============================================================
-- V89: VSS FLOAT COUNT — VSS deployments may exceed the department quota
-- Run AFTER v88.
--
-- Why: a centre with more willing VSS than its allocated seats had to ask
-- the ASO to raise centre_allocations.max_count, which rewrites the
-- schedule. The super_admin can now switch "Float count" on — globally or
-- per centre — and that centre's VSS sewadars can be deployed to a
-- department even when its quota is full.
--
-- Resolution (per ROOT centre, like the other VSS knobs):
--   centre row → All-centres ('*') row → global switch
--   centre_vss_float.float_count  (row absent = Auto / inherit)
--   portal_settings.vss_float_count (global, default false)
-- Stored in its own table on purpose: adding a row to centre_vss_overrides
-- for this knob would change how that centre's deployment_open resolves
-- (the specific row wins even when its value is NULL).
--
-- Scope is the QUOTA GATE ONLY, VSS rows ONLY:
--   • Regular sewadars stay capped. Floated VSS still COUNT toward the
--     department, so once VSS fill a department the regular sewadars cannot
--     be added beyond max_count.
--   • Every other gate is unchanged: VSS switch, done, consent, eligibility
--     (initiated / days / stay), ELDERLY, phantom badge, finalize.
--   • Over-quota rows surface as "Additional" (deployed − scheduled), the
--     same as v38's super_admin / operator extras.
--
-- The three function bodies are v38's, changed only at the quota RAISE.
-- Non-destructive; re-runnable. ROLLBACK: re-run sql/v38_operator_quota_bypass.sql.
-- ============================================================

-- (inner BEGIN removed — whole patch is one transaction)
-- 1. storage ---------------------------------------------------------
ALTER TABLE public.portal_settings
  ADD COLUMN IF NOT EXISTS vss_float_count boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.centre_vss_float (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre text NOT NULL UNIQUE,          -- '*' = all centres, else a ROOT centre
  float_count boolean NOT NULL,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.centre_vss_float ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS centre_vss_float_read ON public.centre_vss_float;
CREATE POLICY centre_vss_float_read ON public.centre_vss_float
  FOR SELECT TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));
DROP POLICY IF EXISTS centre_vss_float_write ON public.centre_vss_float;
CREATE POLICY centre_vss_float_write ON public.centre_vss_float
  FOR ALL TO authenticated
  USING (public.get_portal_user_role() = 'super_admin')
  WITH CHECK (public.get_portal_user_role() = 'super_admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.centre_vss_float TO authenticated;

-- live updates in the Control Panel / VSS page (skip where realtime is absent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'centre_vss_float') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.centre_vss_float;
  END IF;
END $$;

-- 2. resolver (SECURITY DEFINER: centre users call it; triggers use it) --
CREATE OR REPLACE FUNCTION public.vss_float_count_for_centre(p_centre text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT f.float_count FROM public.centre_vss_float f WHERE f.centre = public.get_root_centre(p_centre)),
    (SELECT f.float_count FROM public.centre_vss_float f WHERE f.centre = '*'),
    (SELECT s.vss_float_count FROM public.portal_settings s WHERE s.id = 1),
    false
  )
$$;
REVOKE ALL ON FUNCTION public.vss_float_count_for_centre(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vss_float_count_for_centre(text) TO authenticated, service_role;

-- 3. check_deployment — v38 body + VSS float-count quota bypass
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
  v_is_operator boolean;
  v_bypass boolean;
  v_quota_bypass boolean;
  v_dept_id uuid;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_vss_open boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');
  v_is_operator := (v_role = 'vss_operator');
  v_bypass := v_is_admin OR v_is_operator;
  -- V38: super_admin + vss_operator may deploy BEYOND the allocated
  -- quota (extras surface as Additional); quota still binds centre roles.
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    v_override := false;
  ELSE
    -- Final-department setter: admins only. The operator lands here, so any
    -- write carrying deployed_department_id raises — operator can NEVER set
    -- the final department (v20 made aso read-only; super_admin finalizes).
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;

    -- Undeployed-only: the operator may INSERT new deployments but never
    -- UPDATE an existing deployment row (every row has department_id set,
    -- so any UPDATE touches a deployed row).
    IF v_is_operator AND TG_OP = 'UPDATE' AND OLD.department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Already deployed — vss_operator may only insert new (undeployed) deployments';
    END IF;

    v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
    v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept_id);
    v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
    v_open := v_override OR v_undeployed;

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

    -- VSS rows skip the generic lock + deadline gate — they are gated by the
    -- VSS-specific effective switch in the VSS branch below (which raises
    -- 'VSS deployment is closed' when the switch is off). status='done'
    -- stays terminal. The operator skips it the same way (v_bypass).
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

    IF NOT (v_open OR v_is_vss OR v_is_operator) THEN
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
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
  END IF;

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

  -- Consent-given relaxation: VSS uses VSS open, regular uses generic v_open;
  -- bypass roles (admins + operator) are exempt, mirroring the v21 override.
  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
  -- Compute VSS openness for consent check (same as in block_after_deadline)
  SELECT COALESCE(
    (SELECT o.deployment_open FROM public.centre_vss_overrides o
     WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
     ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
    public.get_vss_deployment_open()
  ) INTO v_vss_open;
  IF v_is_vss THEN
    IF NOT v_consent.consent_given AND NOT (v_vss_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  ELSE
    IF NOT v_consent.consent_given AND NOT (v_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  -- V37 OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only): unlike the
  -- v36 bypass in the branch below (NOT v_bypass, which includes the
  -- operator), the operator honors the effective VSS switch via the
  -- canonical helper. Regular-population operator rows keep the v36
  -- bypass behavior unchanged.
  IF v_is_operator AND v_is_vss AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
    RAISE EXCEPTION 'VSS deployment is closed';
  END IF;

  IF v_is_vss THEN
    -- VSS switch: must be open via the VSS-specific effective switch,
    -- unless a bypass role (admins + operator) is writing.
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open;
    IF NOT v_bypass AND NOT v_vss_open THEN
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
    -- Regular: generic override already checked via v_open; now check sewadar switch only if not open
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open; -- dummy to avoid unused var warning
    IF NOT v_bypass AND NOT v_open
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

  IF TG_OP = 'INSERT' OR COALESCE(OLD.deployed_department_id, OLD.department_id) IS DISTINCT FROM v_dept_id THEN
    -- V38: quota bypass for super_admin + vss_operator. All other gates
    -- (consent, eligibility, lock, deadline, done, switches) are untouched.
    -- V89: a VSS row skips the quota when float count is on for its centre.
    IF NOT v_quota_bypass AND NOT (v_is_vss AND public.vss_float_count_for_centre(NEW.centre)) THEN
      v_quota := public.get_dept_quota_remaining(NEW.schedule_id, v_dept_id, NEW.centre);
      IF v_quota <= 0 THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- 4. check_deployment_batch — v38 body + VSS float-count quota bypass
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
  v_quota_bypass boolean;
  v_float boolean := false;
BEGIN
  v_role := public.get_portal_user_role();
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');
  -- V38: super_admin + vss_operator may deploy beyond quota (Additional).
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  FOR r IN
    SELECT DISTINCT schedule_id,
                    COALESCE(deployed_department_id, department_id) AS dept_id
    FROM new_rows
  LOOP
    IF NOT v_is_admin THEN
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
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

    FOR r2 IN SELECT DISTINCT nr.centre FROM new_rows nr
             WHERE nr.schedule_id = r.schedule_id
               AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id LOOP
      v_root := public.get_root_centre(r2.centre);
      SELECT max_count INTO v_max FROM public.centre_allocations
      WHERE schedule_id = r.schedule_id AND department_id = r.dept_id AND centre = v_root;
      IF v_max IS NULL THEN CONTINUE; END IF;

      -- runs AFTER the statement: the new rows are already in the table, so a
      -- strict > rejects even multi-row batches that blow past the quota.
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from the count (v35).
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.dp_sewadars s
          WHERE s.badge_number = d.badge_number AND s.centre = d.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      -- V38: quota bypass (see above); the used/max computation stays
      -- so the numbers remain auditable in logs.
      -- V89: VSS float count — when it is on for this root centre and every
      -- row this statement wrote to the department is a VSS row, the quota
      -- does not bind (regular sewadars stay capped).
      v_float := public.vss_float_count_for_centre(v_root)
        AND NOT EXISTS (
          SELECT 1 FROM new_rows nr
          WHERE nr.schedule_id = r.schedule_id
            AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
            AND public.get_root_centre(nr.centre) = v_root
            AND NOT (nr.badge_number ILIKE 'VS%'
                     OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number))
        );
      IF NOT v_quota_bypass AND NOT v_float AND v_used > v_max THEN
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

-- 5. check_deployment_batch_upd — v38 body + VSS float-count quota bypass
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
  v_quota_bypass boolean;
  v_float boolean := false;
BEGIN
  v_role := public.get_portal_user_role();
  -- V36: vss_operator bypasses the lock/deadline re-checks like an admin;
  -- quota + done re-checks below still bind every role.
  v_is_admin := v_role IN ('aso', 'super_admin', 'vss_operator');
  -- V38: super_admin + vss_operator may deploy beyond quota (Additional).
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  FOR r IN
    SELECT DISTINCT nr.schedule_id,
                    COALESCE(nr.deployed_department_id, nr.department_id) AS dept_id
    FROM new_rows nr
    JOIN old_rows o ON nr.id = o.id
    WHERE COALESCE(nr.deployed_department_id, nr.department_id) IS DISTINCT FROM COALESCE(o.deployed_department_id, o.department_id)
  LOOP
    IF NOT v_is_admin THEN
      -- a locked centre cannot deploy unless the Control Panel opened it
      -- (or the row is a VSS row — VSS is gated solely by its effective switch)
      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
          AND public.is_centre_locked(r.schedule_id, nr.centre)
      ) THEN
        RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
      END IF;

      IF EXISTS (
        SELECT 1 FROM new_rows nr
        WHERE nr.schedule_id = r.schedule_id
          AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
          AND NOT (
            public.is_centre_override_open(r.schedule_id, nr.centre, r.dept_id)
            OR public.is_centre_undeployed_override_open(r.schedule_id, nr.centre)
            OR nr.badge_number ILIKE 'VS%'
            OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number)
          )
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
      -- EXCLUDE AREA SECRETARY OFFICE sewadars from both counts (v35).
      SELECT count(*) INTO v_used FROM public.deployments d
      WHERE d.schedule_id = r.schedule_id
        AND COALESCE(d.deployed_department_id, d.department_id) = r.dept_id
        AND public.get_root_centre(d.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.dp_sewadars s
          WHERE s.badge_number = d.badge_number AND s.centre = d.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = d.badge_number AND vs.centre = d.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      SELECT count(*) INTO v_pre FROM old_rows o
      WHERE o.schedule_id = r.schedule_id
        AND COALESCE(o.deployed_department_id, o.department_id) = r.dept_id
        AND public.get_root_centre(o.centre) = v_root
        AND NOT EXISTS (
          SELECT 1 FROM public.dp_sewadars s
          WHERE s.badge_number = o.badge_number AND s.centre = o.centre
            AND upper(trim(s.department)) = 'AREA SECRETARY OFFICE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vss_sewadars vs
          WHERE vs.badge_number = o.badge_number AND vs.centre = o.centre
            AND upper(trim(vs.department)) = 'AREA SECRETARY OFFICE'
        );

      -- V38: quota bypass (see above).
      -- V89: VSS float count — when it is on for this root centre and every
      -- row this statement wrote to the department is a VSS row, the quota
      -- does not bind (regular sewadars stay capped).
      v_float := public.vss_float_count_for_centre(v_root)
        AND NOT EXISTS (
          SELECT 1 FROM new_rows nr
          WHERE nr.schedule_id = r.schedule_id
            AND COALESCE(nr.deployed_department_id, nr.department_id) = r.dept_id
            AND public.get_root_centre(nr.centre) = v_root
            AND NOT (nr.badge_number ILIKE 'VS%'
                     OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = nr.badge_number))
        );
      IF NOT v_quota_bypass AND NOT v_float AND v_used > v_max AND v_used > v_pre THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment_batch_upd ON public.deployments;
CREATE TRIGGER trg_check_deployment_batch_upd
  AFTER UPDATE ON public.deployments
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.check_deployment_batch_upd();

-- ------------------------------------------------------------

INSERT INTO public.portal_version (version) VALUES ('v89')
ON CONFLICT (version) DO NOTHING;

-- (inner COMMIT removed)
-- ============================================================
-- VERIFICATION
-- 1. SELECT public.vss_float_count_for_centre('<centre>');   → false by default
-- 2. As a centre_user, deploy one more VSS into a FULL department
--    → 'Department quota already exhausted'.
-- 3. UPDATE portal_settings SET vss_float_count = true; repeat 2 → succeeds.
--    The same insert for a REGULAR sewadar still raises.
-- 4. INSERT INTO centre_vss_float (centre, float_count) VALUES ('<root>', false);
--    repeat 2 → raises again (centre No beats global Yes).
-- ============================================================

-- ======== sql/v90_elderly_deployable.sql ========
-- ============================================================
-- V90: ELDERLY REGULAR SEWADARS ARE DEPLOYABLE
-- Run AFTER v89.
--
-- Why: dp_sewadars now holds Open / Permanent / Elderly + Approved + age <= 75
-- (synced from the dump). Centre admins / users must be able to give consent
-- for and deploy ELDERLY badges like any other regular sewadar.
--
-- Change: check_deployment() is v89's body with ONLY the regular-branch
-- "Elderly sewadars cannot be deployed" block removed. VSS ELDERLY stays
-- blocked. Every other gate (consent, days, stay, initiated, quota, lock,
-- deadline, switches, float count) is unchanged.
--
-- Non-destructive; re-runnable. ROLLBACK: re-run section 3 of v89.
-- ============================================================

-- (inner BEGIN removed — whole patch is one transaction)
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
  v_is_operator boolean;
  v_bypass boolean;
  v_quota_bypass boolean;
  v_dept_id uuid;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_vss_open boolean;
BEGIN
  v_role := public.get_portal_user_role();
  v_is_admin := v_role IN ('aso', 'super_admin');
  v_is_operator := (v_role = 'vss_operator');
  v_bypass := v_is_admin OR v_is_operator;
  -- V38: super_admin + vss_operator may deploy BEYOND the allocated
  -- quota (extras surface as Additional); quota still binds centre roles.
  v_quota_bypass := (v_role IN ('super_admin', 'vss_operator'));

  SELECT status, deadline INTO v_sched_status, v_deadline FROM public.deployment_schedules
  WHERE id = NEW.schedule_id;
  IF v_sched_status IS NULL THEN
    RAISE EXCEPTION 'Schedule not found';
  END IF;

  IF v_is_admin THEN
    v_override := false;
  ELSE
    -- Final-department setter: admins only. The operator lands here, so any
    -- write carrying deployed_department_id raises — operator can NEVER set
    -- the final department (v20 made aso read-only; super_admin finalizes).
    IF TG_OP = 'UPDATE' AND NEW.deployed_department_id IS DISTINCT FROM OLD.deployed_department_id THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.deployed_department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only ASO or Super Admin can set the final deployed department';
    END IF;

    -- Undeployed-only: the operator may INSERT new deployments but never
    -- UPDATE an existing deployment row (every row has department_id set,
    -- so any UPDATE touches a deployed row).
    IF v_is_operator AND TG_OP = 'UPDATE' AND OLD.department_id IS NOT NULL THEN
      RAISE EXCEPTION 'Already deployed — vss_operator may only insert new (undeployed) deployments';
    END IF;

    v_dept_id := COALESCE(NEW.deployed_department_id, NEW.department_id);
    v_override := public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept_id);
    v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
    v_open := v_override OR v_undeployed;

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

    -- VSS rows skip the generic lock + deadline gate — they are gated by the
    -- VSS-specific effective switch in the VSS branch below (which raises
    -- 'VSS deployment is closed' when the switch is off). status='done'
    -- stays terminal. The operator skips it the same way (v_bypass).
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

    IF NOT (v_open OR v_is_vss OR v_is_operator) THEN
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
      RAISE EXCEPTION 'This schedule is done — editing disabled';
    END IF;
  END IF;

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

  -- Consent-given relaxation: VSS uses VSS open, regular uses generic v_open;
  -- bypass roles (admins + operator) are exempt, mirroring the v21 override.
  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
  -- Compute VSS openness for consent check (same as in block_after_deadline)
  SELECT COALESCE(
    (SELECT o.deployment_open FROM public.centre_vss_overrides o
     WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
     ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
    public.get_vss_deployment_open()
  ) INTO v_vss_open;
  IF v_is_vss THEN
    IF NOT v_consent.consent_given AND NOT (v_vss_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  ELSE
    IF NOT v_consent.consent_given AND NOT (v_open OR v_bypass) THEN
      RAISE EXCEPTION 'Consent not given for this sewadar';
    END IF;
  END IF;

  v_is_vss := NEW.badge_number ILIKE 'VS%'
              OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);

  -- V37 OPERATOR VSS-SWITCH GATE (fail-closed, VSS rows only): unlike the
  -- v36 bypass in the branch below (NOT v_bypass, which includes the
  -- operator), the operator honors the effective VSS switch via the
  -- canonical helper. Regular-population operator rows keep the v36
  -- bypass behavior unchanged.
  IF v_is_operator AND v_is_vss AND NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
    RAISE EXCEPTION 'VSS deployment is closed';
  END IF;

  IF v_is_vss THEN
    -- VSS switch: must be open via the VSS-specific effective switch,
    -- unless a bypass role (admins + operator) is writing.
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open;
    IF NOT v_bypass AND NOT v_vss_open THEN
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
    -- Regular: generic override already checked via v_open; now check sewadar switch only if not open
    SELECT COALESCE(
      (SELECT o.deployment_open FROM public.centre_vss_overrides o
       WHERE o.centre IN (public.get_root_centre(NEW.centre), '*')
       ORDER BY CASE WHEN o.centre = '*' THEN 1 ELSE 0 END LIMIT 1),
      public.get_vss_deployment_open()
    ) INTO v_vss_open; -- dummy to avoid unused var warning
    IF NOT v_bypass AND NOT v_open
       AND NOT public.get_sewadar_deployment_open() THEN
      RAISE EXCEPTION 'Sewadar deployment is closed';
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

  IF TG_OP = 'INSERT' OR COALESCE(OLD.deployed_department_id, OLD.department_id) IS DISTINCT FROM v_dept_id THEN
    -- V38: quota bypass for super_admin + vss_operator. All other gates
    -- (consent, eligibility, lock, deadline, done, switches) are untouched.
    -- V89: a VSS row skips the quota when float count is on for its centre.
    IF NOT v_quota_bypass AND NOT (v_is_vss AND public.vss_float_count_for_centre(NEW.centre)) THEN
      v_quota := public.get_dept_quota_remaining(NEW.schedule_id, v_dept_id, NEW.centre);
      IF v_quota <= 0 THEN
        RAISE EXCEPTION 'Department quota already exhausted';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_deployment ON public.deployments;
CREATE TRIGGER trg_check_deployment
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment();

-- (inner COMMIT removed)
-- ======== sql/v91_elderly_counts_realtime.sql ========
-- V91 — run AFTER v90. Non-destructive; re-runnable.

-- ======== V91: elderly consistency + realtime publication ========
-- v90 made regular ELDERLY sewadars deployable, but three read functions still
-- treated them as ineligible: centre counts and the parent consent matrix left
-- them out, and attendance anomalies flagged their scans. Each body below is the
-- latest existing definition with ONLY the ELDERLY condition changed.
-- (inner BEGIN removed — whole patch is one transaction)
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

-- (inner COMMIT removed)
COMMIT;

-- CHECKS (read-only)
SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('vss_float_count_for_centre','find_vss_duplicates','check_deployment','get_centre_counts','attendance_anomalies') ORDER BY 1;  -- expect 5 rows
SELECT version FROM public.portal_version WHERE version IN ('v88','v89','v91') ORDER BY 1;  -- expect 3 rows
SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' ORDER BY 1;  -- expect 17 tables
