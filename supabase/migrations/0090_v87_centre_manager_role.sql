-- ============================================================
-- v87: Centre Manager role & attendance portal delegation
--
-- 1. Adds 'centre_manager' to the allowed portal_users & portal_invitations role checks.
-- 2. Adds `is_centre_manager` boolean flag to portal_users & portal_invitations
--    so existing roles (e.g. centre_admin) can be granted Centre Manager capability
--    via a tickbox/add-in.
-- 3. Updates `public.attendance_scope_centres(schedule)` so that any user with
--    role='centre_manager' OR is_centre_manager=true resolves their centre subtree
--    (their centre + all subcentres via public.get_my_subtree_centres()).
-- 4. Updates `public.claim_portal_invite` to carry is_centre_manager forward.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Add is_centre_manager column
-- ------------------------------------------------------------
ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS is_centre_manager boolean NOT NULL DEFAULT false;

ALTER TABLE public.portal_invitations
  ADD COLUMN IF NOT EXISTS is_centre_manager boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. Update role CHECK constraint to include 'centre_manager'
-- ------------------------------------------------------------
ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE public.portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('centre_user','centre_admin','centre_manager','aso','super_admin','dept_incharge','scanner','vss_operator'));

ALTER TABLE public.portal_invitations DROP CONSTRAINT IF EXISTS portal_invitations_role_check;
ALTER TABLE public.portal_invitations ADD CONSTRAINT portal_invitations_role_check
  CHECK (role IN ('centre_user','centre_admin','centre_manager','aso','super_admin','dept_incharge','scanner','vss_operator'));

-- ------------------------------------------------------------
-- 3. Update attendance_scope_centres to recognize centre_manager & is_centre_manager
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_scope_centres(p_schedule uuid DEFAULT NULL)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text;
  v_centre text;
  v_depts  uuid[];
  v_is_cm  boolean;
BEGIN
  v_role   := public.get_portal_user_role();
  v_centre := public.get_portal_user_centre();

  -- Admins see every centre.
  IF v_role IN ('aso', 'super_admin') THEN
    RETURN COALESCE((SELECT array_agg(name) FROM public.dp_centres), ARRAY[]::text[]);
  END IF;

  -- Check if user is centre_manager (role or is_centre_manager flag)
  SELECT COALESCE(is_centre_manager, false) INTO v_is_cm
  FROM public.portal_users
  WHERE auth_id = auth.uid() AND is_active = true AND archived_at IS NULL;

  -- Centre roles / managers see their own subtree (self + SC_SPs)
  IF v_role IN ('centre_user', 'centre_admin', 'centre_manager') OR COALESCE(v_is_cm, false) THEN
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
-- 4. Update claim_portal_invite to carry is_centre_manager
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_portal_invite(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inv public.portal_invitations;
  v_uid uuid;
  v_email text;
  v_base text;
  v_exists boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  v_uid := auth.uid();
  v_email := lower(auth.jwt()->>'email');
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'Enter an invite code';
  END IF;

  IF btrim(p_token) ~ '^[0-9a-fA-F-]{36}$' THEN
    SELECT * INTO v_inv FROM public.portal_invitations
     WHERE token = btrim(p_token)::uuid;
  ELSE
    SELECT * INTO v_inv FROM public.portal_invitations
     WHERE code = btrim(p_token);
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite code not recognized';
  END IF;
  IF v_inv.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invite has already been used';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'This invite has expired — ask the ASO office for a new one';
  END IF;
  IF v_email IS NULL OR lower(v_inv.email) <> v_email THEN
    RAISE EXCEPTION 'This invite was issued to a different email address';
  END IF;

  IF v_inv.role IN ('centre_user','centre_admin','centre_manager')
     AND (v_inv.centre IS NULL OR btrim(v_inv.centre) = '') THEN
    RAISE EXCEPTION 'This invite is missing its centre — ask the ASO office to re-issue it';
  END IF;
  IF v_inv.role IN ('dept_incharge','scanner')
     AND (v_inv.badge_number IS NULL OR btrim(v_inv.badge_number) = '') THEN
    RAISE EXCEPTION 'This invite is missing its badge number — ask the ASO office to re-issue it';
  END IF;

  IF v_inv.custom_role_id IS NOT NULL THEN
    SELECT base_role INTO v_base FROM public.custom_roles
     WHERE id = v_inv.custom_role_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This invite names a role that no longer exists — ask the ASO office to re-issue it';
    END IF;
    IF v_base <> v_inv.role THEN
      RAISE EXCEPTION 'This invite is inconsistent — ask the ASO office to re-issue it';
    END IF;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.portal_users
     WHERE auth_id = v_uid AND is_active IS NOT FALSE
  ) INTO v_exists;
  IF v_exists THEN
    RAISE EXCEPTION 'This login is already active — ask the ASO office to update it instead';
  END IF;

  INSERT INTO public.portal_users
    (auth_id, email, name, role, custom_role_id, centre, badge_number, is_centre_manager, is_active)
  VALUES
    (v_uid, v_inv.email, NULLIF(btrim(v_inv.name), ''), v_inv.role,
     v_inv.custom_role_id, NULLIF(btrim(v_inv.centre), ''),
     NULLIF(btrim(v_inv.badge_number), ''),
     COALESCE(v_inv.is_centre_manager, false) OR (v_inv.role = 'centre_manager'),
     true)
  ON CONFLICT (auth_id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    custom_role_id = EXCLUDED.custom_role_id,
    centre = EXCLUDED.centre,
    badge_number = EXCLUDED.badge_number,
    is_centre_manager = EXCLUDED.is_centre_manager,
    is_active = true;

  UPDATE public.portal_invitations
     SET claimed_at = now(), claimed_by = v_uid
   WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'role', v_inv.role);
END;
$$;

COMMIT;
