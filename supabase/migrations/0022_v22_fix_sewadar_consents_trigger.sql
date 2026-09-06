-- ============================================================
-- v22_fix_sewadar_consents_trigger.sql
--
-- FIX: "record \"new\" has no field \"deployed_department_id\""
--      thrown on EVERY insert/update of sewadar_consents
--      (the "Save Draft" failure reported by centre users).
--
-- ROOT CAUSE
-- -----------
-- public.block_after_deadline() is a SINGLE trigger function shared by
-- two triggers:
--   * trg_block_after_deadline        ON sewadar_consents
--   * trg_block_after_deadline_deploy  ON deployments
--
-- sewadar_consents has NO department_id / deployed_department_id
-- columns, while deployments has both. The function body referenced
-- NEW.deployed_department_id / NEW.department_id / OLD.department_id
-- literally (inside TG_RELID-guarded branches). PL/pgSQL type-checks
-- every NEW/OLD field reference against the trigger's record type at
-- COMPILE time — even branches that are never executed. So when the
-- function runs for the sewadar_consents trigger, the literal
-- "deployed_department_id" reference fails to resolve and PostgreSQL
-- raises 42703 on every row write.
--
-- The same defect exists in block_locked_delete() (shared by
-- trg_block_locked_delete_consent ON sewadar_consents + the deploy /
-- incharge delete triggers), which references OLD.department_id
-- literally — breaking DELETE of consent rows.
--
-- FIX
-- ----
-- Resolve the department columns ONLY for the deployments table, via
-- dynamic EXECUTE so the column names live inside a string and are
-- never type-checked against the (column-less) consent record. The
-- trigger attachments are unchanged; CREATE OR REPLACE swaps the body
-- in place.
--
-- Non-destructive; safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. block_after_deadline() — consent-safe rewrite
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_deadline timestamptz;
  v_is_vss boolean;
  v_override boolean;
  v_undeployed boolean;
  v_open boolean;
  v_dept uuid := NULL;
  v_old_dept uuid := NULL;
BEGIN
  -- Super Admin / ASO keep working after the deadline (aso is
  -- read-only since v20, but keep both roles exempt for safety)
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN NEW;
  END IF;

  -- Only the deployments table carries department columns. Reference them
  -- dynamically so this shared function still compiles when attached to
  -- sewadar_consents (which has neither department_id nor
  -- deployed_department_id). A static NEW.deployed_department_id reference
  -- would fail to compile for the consent trigger with
  -- "record \"new\" has no field \"deployed_department_id\"".
  IF TG_RELID = 'public.deployments'::regclass THEN
    EXECUTE 'SELECT COALESCE(($1).deployed_department_id, ($1).department_id)'
      USING NEW INTO v_dept;
    IF TG_OP <> 'INSERT' THEN
      EXECUTE 'SELECT ($1).department_id' USING OLD INTO v_old_dept;
    END IF;
  END IF;

  v_override := CASE
    WHEN TG_RELID = 'public.deployments'::regclass
      THEN public.is_centre_override_open(NEW.schedule_id, NEW.centre, v_dept)
    ELSE public.is_any_centre_override_open(NEW.schedule_id, NEW.centre)
  END;
  v_undeployed := public.is_centre_undeployed_override_open(NEW.schedule_id, NEW.centre);
  v_open := v_override OR v_undeployed;

  -- UNDEPLOYED-ONLY override: already-deployed sewadars stay frozen even
  -- while the undeployed cohort is open. "Already deployed" = a deployment
  -- row with a requested/final department. Consent edits on those rows are
  -- also blocked. A normal (non-undeployed) override takes precedence and
  -- opens everything.
  IF v_undeployed THEN
    IF TG_RELID = 'public.deployments'::regclass THEN
      IF NOT v_override THEN
        IF TG_OP = 'INSERT' THEN
          IF EXISTS (
            SELECT 1 FROM public.deployments d
            WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
              AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Already deployed — locked under this override';
          END IF;
        ELSIF v_old_dept IS NOT NULL THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      END IF;
    ELSE
      IF NOT public.is_any_normal_override_open(NEW.schedule_id, NEW.centre) THEN
        IF EXISTS (
          SELECT 1 FROM public.deployments d
          WHERE d.schedule_id = NEW.schedule_id AND d.centre = NEW.centre
            AND d.badge_number = NEW.badge_number AND d.department_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Already deployed — locked under this override';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NOT v_open THEN
    -- A locked centre cannot edit consent/deployment (regular + VSS)
    IF public.is_centre_locked(NEW.schedule_id, NEW.centre) THEN
      RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
    END IF;

    -- Master switches gate ALL centre-role consent/deploy writes
    v_is_vss := NEW.badge_number ILIKE 'VS%'
                OR EXISTS (SELECT 1 FROM public.vss_sewadars vs WHERE vs.badge_number = NEW.badge_number);
    IF v_is_vss THEN
      IF NOT public.vss_deploy_open_for_centre(NEW.centre) THEN
        RAISE EXCEPTION 'VSS deployment is closed';
      END IF;
    ELSE
      IF NOT public.get_sewadar_deployment_open() THEN
        RAISE EXCEPTION 'Sewadar deployment is closed';
      END IF;
    END IF;
  END IF;

  SELECT status, deadline INTO v_status, v_deadline FROM public.deployment_schedules WHERE id = NEW.schedule_id;
  IF v_status = 'done' THEN
    RAISE EXCEPTION 'This schedule is done — editing disabled';
  END IF;
  IF NOT v_open AND v_deadline IS NOT NULL AND now() > v_deadline THEN
    RAISE EXCEPTION 'Deadline has passed — editing disabled';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 2. block_locked_delete() — consent-safe rewrite (DELETE path)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_locked_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_override boolean;
  v_undeployed boolean;
  v_old_dept uuid := NULL;
BEGIN
  -- ASO / Super Admin may always clean up
  IF public.get_portal_user_role() IN ('aso', 'super_admin') THEN
    RETURN OLD;
  END IF;

  IF TG_RELID = 'public.deployments'::regclass THEN
    -- Reference department_id dynamically: sewadar_consents /
    -- department_incharges do not have this column, and a static
    -- OLD.department_id reference would fail to compile for those triggers.
    EXECUTE 'SELECT public.is_centre_override_open(($1).schedule_id, ($1).centre, ($1).department_id)'
      USING OLD INTO v_override;
  ELSE
    -- consents / incharges: only a centre-wide override reopens them
    v_override := public.is_centre_override_open(OLD.schedule_id, OLD.centre, NULL::uuid);
  END IF;
  v_undeployed := public.is_centre_undeployed_override_open(OLD.schedule_id, OLD.centre);

  IF NOT (v_override OR v_undeployed) AND public.is_centre_locked(OLD.schedule_id, OLD.centre) THEN
    RAISE EXCEPTION 'Deployment is locked by this centre — only ASO / Super Admin can change it';
  END IF;

  -- UNDEPLOYED-ONLY override: already-deployed deployment rows stay frozen
  -- even against a delete (the cohort that may be cleaned up is only the
  -- undeployed). Nest the check so OLD.department_id is only evaluated on
  -- the deployments table.
  IF v_undeployed AND NOT v_override AND TG_RELID = 'public.deployments'::regclass THEN
    EXECUTE 'SELECT ($1).department_id IS NOT NULL' USING OLD INTO v_old_dept;
    IF v_old_dept THEN
      RAISE EXCEPTION 'Already deployed — locked under this override';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

-- ------------------------------------------------------------
-- 3. Re-attach triggers (no-op if already correct; ensures the new
--    function bodies are bound to the existing trigger definitions).
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_block_after_deadline ON public.sewadar_consents;
CREATE TRIGGER trg_block_after_deadline
  BEFORE INSERT OR UPDATE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

DROP TRIGGER IF EXISTS trg_block_after_deadline_deploy ON public.deployments;
CREATE TRIGGER trg_block_after_deadline_deploy
  BEFORE INSERT OR UPDATE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_after_deadline();

DROP TRIGGER IF EXISTS trg_block_locked_delete_consent ON public.sewadar_consents;
CREATE TRIGGER trg_block_locked_delete_consent
  BEFORE DELETE ON public.sewadar_consents
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

DROP TRIGGER IF EXISTS trg_block_locked_delete_deploy ON public.deployments;
CREATE TRIGGER trg_block_locked_delete_deploy
  BEFORE DELETE ON public.deployments
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();

DROP TRIGGER IF EXISTS trg_block_locked_delete_incharge ON public.department_incharges;
CREATE TRIGGER trg_block_locked_delete_incharge
  BEFORE DELETE ON public.department_incharges
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_delete();
