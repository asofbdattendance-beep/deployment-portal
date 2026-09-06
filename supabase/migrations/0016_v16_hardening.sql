-- ============================================================
-- V16: HARDENING — RLS cleanup, view removal, photo privacy,
--      finalized-row protection, safe OE ESCORTS backfill
--
-- Fixes (from the hardening review):
--   H1  aso kept FULL write on deployment_schedules /
--       deployment_departments via surviving v1 policies
--       (portal_setup.sql's sched_write / dept_depts_write) —
--       v2 added super_admin-only policies but never dropped
--       the v1 ones, and Postgres ORs permissive policies.
--       Also drops the obsolete v1 deployments policies
--       (deploy_read/insert/update/delete — superseded by the
--       stricter subtree-scoped deploy_v2_* ones).
--   H2  owner-owned views vw_my_centre_sewadars /
--       vw_all_deployments bypass RLS entirely (the view owner
--       is bypassrls, so ANY authenticated user could read ALL
--       sewadars / deployments through them). They are unused
--       by the app — dropped.
--   H3  vss-photos bucket was created public = true, so every
--       registration photo is fetchable by URL with no auth at
--       all. The bucket is flipped private and the read policy
--       is scoped to owner / admins / the registration's own
--       centre subtree.
--   H4  the v10 OE ESCORTS consent backfill aborts when any
--       schedule is done / past its deadline, because running
--       the SQL editor yields no portal role (not aso/admin) and
--       trg_block_after_deadline raises. Re-run the backfill
--       here with the blocking trigger disabled.
--   M5  centre roles could flip a finalized sewadar's consent
--       (or edit/delete their consent row) — the app locks the
--       row but the DB had no backstop. Also blocks centre
--       changes to the requested department of a finalized row.
--   M4  deployments could be written for badge numbers that do
--       not exist in sewadars / vss_sewadars (no FK, the
--       ELDERLY check was the only sewadars lookup) — phantom
--       rows now rejected.
--   M6  centre_locks INSERT allowed ANY user in the CENTRE's
--       subtree to lock the whole CENTRE (a child SC_SP user
--       could lock the parent). Locking is now restricted to
--       the root-centre user of their OWN centre.
--
-- NON-DESTRUCTIVE — safe to re-run. Run AFTER v15 in Supabase.
-- ============================================================

-- ------------------------------------------------------------
-- A. H1: drop the surviving v1 policies that widen access
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sched_write ON public.deployment_schedules;
DROP POLICY IF EXISTS sched_read ON public.deployment_schedules;
DROP POLICY IF EXISTS dept_depts_write ON public.deployment_departments;
DROP POLICY IF EXISTS dept_depts_read ON public.deployment_departments;
DROP POLICY IF EXISTS deploy_read ON public.deployments;
DROP POLICY IF EXISTS deploy_insert ON public.deployments;
DROP POLICY IF EXISTS deploy_update ON public.deployments;
DROP POLICY IF EXISTS deploy_delete ON public.deployments;

-- ------------------------------------------------------------
-- B. H2: drop the owner-owned RLS-bypassing views (unused)
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_my_centre_sewadars;
DROP VIEW IF EXISTS public.vw_all_deployments;

-- ------------------------------------------------------------
-- C. M6: centre roles may lock ONLY their own root CENTRE.
--    Previously any subtree user could write a lock row for the
--    CENTRE (get_root_centre matched), freezing the whole
--    subtree — a child SC_SP user could lock its parent CENTRE.
--    The UI only ever locks myRoot for root-centre users, so
--    this matches the app exactly.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS centre_locks_insert ON public.centre_locks;
CREATE POLICY centre_locks_insert ON public.centre_locks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_portal_user_role() = 'super_admin'
    OR (
      centre = public.get_portal_user_centre()
      AND public.get_root_centre(centre) = centre
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- ------------------------------------------------------------
-- D. H4: re-run the OE ESCORTS rule + backfill with the
--    deadline/lock/master-switch trigger disabled (the SQL
--    editor has no portal role, so trg_block_after_deadline
--    would reject the backfill for done/past-deadline
--    schedules). Only the consent backfill needs the disable;
--    the department min_days UPDATE is untouched by triggers.
-- ------------------------------------------------------------
UPDATE public.deployment_departments
SET min_days = 3, vss_min_days = 3
WHERE name ILIKE 'OE ESCORTS%'
  AND (min_days <> 3 OR vss_min_days <> 3);

-- Disable every consent-write trigger that could reject the backfill (the SQL
-- editor has no portal role). Guarded so the script also re-runs cleanly on a
-- DB that already has the v16 triggers (e.g. trg_block_finalized_consent).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents DISABLE TRIGGER trg_block_after_deadline;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_consent' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents DISABLE TRIGGER trg_block_finalized_consent;
  END IF;
END $$;

UPDATE public.sewadar_consents sc
SET available_days_count = 3
WHERE sc.available_days_count IS DISTINCT FROM 3
  AND EXISTS (
    SELECT 1 FROM public.deployments d
    LEFT JOIN public.deployment_departments req ON req.id = d.department_id
    LEFT JOIN public.deployment_departments fin ON fin.id = d.deployed_department_id
    WHERE d.schedule_id = sc.schedule_id
      AND d.centre = sc.centre
      AND d.badge_number = sc.badge_number
      AND (req.name ILIKE 'OE ESCORTS%' OR fin.name ILIKE 'OE ESCORTS%')
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_after_deadline' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents ENABLE TRIGGER trg_block_after_deadline;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_block_finalized_consent' AND tgrelid = 'public.sewadar_consents'::regclass) THEN
    ALTER TABLE public.sewadar_consents ENABLE TRIGGER trg_block_finalized_consent;
  END IF;
END $$;

-- ------------------------------------------------------------
-- E. M5: ASO-finalized rows are untouchable by centre roles.
--    A deployment with deployed_department_id set carries the
--    ASO's final decision — a centre flipping consent to No (or
--    deleting the consent row, or re-requesting a different
--    department) would silently contradict it. The app already
--    locks these rows (FINAL pill); this is the DB backstop.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_finalized_consent_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- ASO / Super Admin manage finalized rows freely
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.deployments d
    WHERE d.schedule_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.schedule_id ELSE NEW.schedule_id END
      AND d.centre = CASE WHEN TG_OP = 'DELETE' THEN OLD.centre ELSE NEW.centre END
      AND d.badge_number = CASE WHEN TG_OP = 'DELETE' THEN OLD.badge_number ELSE NEW.badge_number END
      AND d.deployed_department_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This sewadar''s deployment is finalized by the ASO — contact an admin to change it';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_finalized_consent ON public.sewadar_consents;
CREATE TRIGGER trg_block_finalized_consent
  BEFORE UPDATE OR DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_finalized_consent_edit();

-- Centre roles may not re-request a different department (or badge/centre)
-- on a row the ASO already finalized. v15 already blocks DELETE of such rows.
CREATE OR REPLACE FUNCTION public.block_finalized_deploy_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  IF OLD.deployed_department_id IS NOT NULL
     AND (NEW.department_id IS DISTINCT FROM OLD.department_id
          OR NEW.badge_number IS DISTINCT FROM OLD.badge_number
          OR NEW.centre IS DISTINCT FROM OLD.centre) THEN
    RAISE EXCEPTION 'This deployment is finalized by the ASO — contact an admin to change it';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_finalized_deploy_edit ON public.deployments;
CREATE TRIGGER trg_block_finalized_deploy_edit
  BEFORE UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_finalized_deploy_edit();

-- ------------------------------------------------------------
-- F. M4: deployments must reference a real sewadar (regular
--    table for non-VS badges, vss_sewadars for VSS). Closes the
--    phantom-badge hole (no FK exists because deployments
--    serves BOTH populations).
-- ------------------------------------------------------------
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
      SELECT 1 FROM public.sewadars s
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

-- ------------------------------------------------------------
-- G+. audit_log: production carried a v3-era policy that checked
--    the raw JWT role claim (auth.jwt() ->> 'role' = 'super_admin'),
--    which NEVER matches (Supabase tokens carry role =
--    'authenticated') — so super_admin could never insert audit
--    rows. Replace it with get_portal_user_role() (as v3
--    intended) and scope reads to aso/super_admin (the audit
--    trail contains destructive-action payloads).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS audit_log_insert ON public.audit_log;
CREATE POLICY audit_log_insert ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.get_portal_user_role() = 'super_admin');

DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.get_portal_user_role() IN ('aso', 'super_admin'));

-- ------------------------------------------------------------
-- G. H3: vss-photos becomes a PRIVATE bucket with scoped reads.
--    The bucket was public = true, so every photo (VSS
--    registration identity photos — PII) was world-readable by
--    URL. After this, reads require auth AND ownership of the
--    registration: owner, aso/super_admin, or a centre role
--    whose subtree contains the registration's centre.
--    photo_url is stored either as the legacy full public URL
--    or (new writes) as the bare path reg/... — both match.
-- ------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'vss-photos';

DROP POLICY IF EXISTS vss_photos_read ON storage.objects;
CREATE POLICY vss_photos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'vss-photos'
    AND (
      owner_id::text = auth.uid()::text
      OR public.get_portal_user_role() IN ('aso', 'super_admin')
      OR (
        public.get_portal_user_role() IN ('centre_user', 'centre_admin')
        AND EXISTS (
          SELECT 1 FROM public.vss_registrations r
          WHERE (r.photo_url = name OR r.photo_url LIKE '%/vss-photos/' || name)
            AND r.centre = ANY (public.get_my_subtree_centres())
        )
      )
    )
  );

-- ------------------------------------------------------------
-- VERIFY (run after executing the above)
-- ------------------------------------------------------------
-- -- No aso-writable policies should remain on schedules/departments:
-- SELECT tablename, policyname, cmd, pg_get_expr(qual, tablename::regclass) AS using_expr
-- FROM pg_policies
-- WHERE tablename IN ('deployment_schedules', 'deployment_departments')
-- ORDER BY tablename, policyname;
--
-- -- vss-photos must be private:
-- SELECT id, public FROM storage.buckets WHERE id = 'vss-photos';
--
-- -- OE ESCORTS depts keep 3 days and no consent row is left behind:
-- SELECT id, name, min_days, vss_min_days FROM public.deployment_departments
-- WHERE name ILIKE 'OE ESCORTS%';
-- SELECT count(*) AS unbackfilled FROM public.sewadar_consents sc
-- WHERE sc.available_days_count <> 3 AND EXISTS (
--   SELECT 1 FROM public.deployments d
--   LEFT JOIN public.deployment_departments req ON req.id = d.department_id
--   LEFT JOIN public.deployment_departments fin ON fin.id = d.deployed_department_id
--   WHERE d.schedule_id = sc.schedule_id AND d.centre = sc.centre
--     AND d.badge_number = sc.badge_number
--     AND (req.name ILIKE 'OE ESCORTS%' OR fin.name ILIKE 'OE ESCORTS%')
-- );