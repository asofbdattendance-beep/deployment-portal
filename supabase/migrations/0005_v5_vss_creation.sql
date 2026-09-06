-- ============================================================
-- V5: NEW VSS CREATION
-- Adds:
--   1) vss_registrations table — one row per newly-created VSS
--      (all fields compulsory + temp_vss_id + assignment status)
--   2) temp VSS ID (VSS-TMP-00001 sequence) + age>=29-not-initiated
--      rule, both enforced by triggers
--   3) assign_vss_registration() RPC — superadmin/ASO assigns the
--      VSFB number → moves the record into vss_sewadars (roster)
--      and records the temp↔VSFB mapping on the registration row
--   4) public storage bucket "vss-photos" + RLS policies
-- IDEMPOTENT — safe to re-run (applies NOT NULL, adds missing
-- columns, recreates triggers/policies). Run AFTER v4_vss.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. vss_registrations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vss_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre text NOT NULL,
  sewadar_name text NOT NULL,
  father_husband_name text NOT NULL,
  gender text NOT NULL CHECK (gender IN ('MALE', 'FEMALE')),
  dob text NOT NULL,
  address text NOT NULL,
  contact_no text NOT NULL,
  emergency_contact text NOT NULL,
  is_initiated boolean NOT NULL DEFAULT false,
  aadhar_number text NOT NULL,
  photo_url text NOT NULL,
  temp_vss_id text,
  status text NOT NULL DEFAULT 'registered',
  assigned_badge_number text,
  assigned_by text,
  assigned_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);

-- idempotent: add columns that may be missing if an older v5 was run
ALTER TABLE public.vss_registrations
  ADD COLUMN IF NOT EXISTS temp_vss_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS assigned_badge_number text,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- idempotent: enforce NOT NULL on all compulsory fields (backfill first)
DO $$
BEGIN
  UPDATE public.vss_registrations SET
    centre = COALESCE(centre, ''),
    sewadar_name = COALESCE(sewadar_name, ''),
    father_husband_name = COALESCE(father_husband_name, ''),
    gender = COALESCE(gender, ''),
    dob = COALESCE(dob, ''),
    address = COALESCE(address, ''),
    contact_no = COALESCE(contact_no, ''),
    emergency_contact = COALESCE(emergency_contact, ''),
    is_initiated = COALESCE(is_initiated, false),
    aadhar_number = COALESCE(aadhar_number, ''),
    photo_url = COALESCE(photo_url, '');

  ALTER TABLE public.vss_registrations
    ALTER COLUMN centre SET NOT NULL,
    ALTER COLUMN sewadar_name SET NOT NULL,
    ALTER COLUMN father_husband_name SET NOT NULL,
    ALTER COLUMN gender SET NOT NULL,
    ALTER COLUMN dob SET NOT NULL,
    ALTER COLUMN address SET NOT NULL,
    ALTER COLUMN contact_no SET NOT NULL,
    ALTER COLUMN emergency_contact SET NOT NULL,
    ALTER COLUMN is_initiated SET NOT NULL,
    ALTER COLUMN aadhar_number SET NOT NULL,
    ALTER COLUMN photo_url SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_vss_reg_centre ON public.vss_registrations(centre);
CREATE INDEX IF NOT EXISTS idx_vss_reg_created_at ON public.vss_registrations(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS vss_reg_temp_id_key ON public.vss_registrations(temp_vss_id);

-- ------------------------------------------------------------
-- 2. Temp VSS ID (VSS-TMP-00001 sequence)
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.vss_reg_temp_seq;

CREATE OR REPLACE FUNCTION public.vss_reg_assign_temp_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.temp_vss_id IS NULL OR NEW.temp_vss_id = '' THEN
    NEW.temp_vss_id := 'VSS-TMP-' || lpad(nextval('public.vss_reg_temp_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vss_reg_temp_id ON public.vss_registrations;
CREATE TRIGGER trg_vss_reg_temp_id
  BEFORE INSERT ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.vss_reg_assign_temp_id();

-- ------------------------------------------------------------
-- 3. Age rule: Age >= 29 and not initiated → cannot add VSS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vss_reg_validate_age()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_age integer;
BEGIN
  IF NEW.dob IS NOT NULL AND NEW.dob <> '' THEN
    BEGIN
      v_age := EXTRACT(YEAR FROM age(CURRENT_DATE, to_date(NEW.dob, 'YYYY-MM-DD')))::int;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      BEGIN
        v_age := EXTRACT(YEAR FROM age(CURRENT_DATE, to_date(NEW.dob, 'DD/MM/YYYY')))::int;
      EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
        v_age := NULL;
      END;
    END;
    IF v_age IS NOT NULL AND v_age >= 29 AND NOT NEW.is_initiated THEN
      RAISE EXCEPTION 'Age >= 29, not initiated — cannot add VSS';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vss_reg_validate_age ON public.vss_registrations;
CREATE TRIGGER trg_vss_reg_validate_age
  BEFORE INSERT ON public.vss_registrations
  FOR EACH ROW EXECUTE FUNCTION public.vss_reg_validate_age();

-- ------------------------------------------------------------
-- 4. assign_vss_registration(): superadmin/ASO assigns the VSFB
--    number, moving the record into the vss_sewadars roster and
--    recording the temp↔VSFB mapping on the registration row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_vss_registration(p_reg uuid, p_vsfb text, p_by text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reg public.vss_registrations%ROWTYPE;
  v_role text;
BEGIN
  v_role := public.get_portal_user_role();
  IF v_role NOT IN ('super_admin', 'aso') THEN
    RAISE EXCEPTION 'Only super admin or ASO can assign VSS numbers';
  END IF;

  IF p_vsfb IS NULL OR btrim(p_vsfb) = '' THEN
    RAISE EXCEPTION 'VSS number is required';
  END IF;
  IF p_vsfb !~ '^VS' THEN
    RAISE EXCEPTION 'VSS number must start with VS';
  END IF;

  SELECT * INTO v_reg FROM public.vss_registrations WHERE id = p_reg;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Registration not found';
  END IF;
  IF v_reg.status = 'assigned' THEN
    RAISE EXCEPTION 'This registration already has an assigned VSS number';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vss_sewadars WHERE badge_number = p_vsfb) THEN
    RAISE EXCEPTION 'This VSS number is already in use';
  END IF;

  INSERT INTO public.vss_sewadars (
    badge_number, sewadar_name, father_husband_name, dob, gender, badge_status,
    centre, department, contact_no, emergency_contact, is_initiated,
    print_status, form_status, is_active, remarks
  ) VALUES (
    p_vsfb, v_reg.sewadar_name, v_reg.father_husband_name, v_reg.dob, v_reg.gender,
    'VSS', v_reg.centre, 'SANGAT', v_reg.contact_no, v_reg.emergency_contact,
    v_reg.is_initiated, 'ReadyToPrint-VSS', 'Approved', true, NULL
  );

  UPDATE public.vss_registrations
  SET status = 'assigned',
      assigned_badge_number = p_vsfb,
      assigned_by = p_by,
      assigned_at = now()
  WHERE id = p_reg;

  RETURN p_vsfb;
END;
$$;

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
ALTER TABLE public.vss_registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vss_registrations_read ON public.vss_registrations;
DROP POLICY IF EXISTS vss_registrations_write ON public.vss_registrations;
CREATE POLICY vss_registrations_read ON public.vss_registrations
  FOR SELECT TO authenticated
  USING (
    public.get_portal_user_role() IN ('aso', 'super_admin')
    OR centre = ANY (public.get_my_subtree_centres())
  );
CREATE POLICY vss_registrations_write ON public.vss_registrations
  FOR ALL TO authenticated
  USING (
    public.get_portal_user_role() IN ('super_admin', 'aso')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  )
  WITH CHECK (
    public.get_portal_user_role() IN ('super_admin', 'aso')
    OR (
      centre = ANY (public.get_my_subtree_centres())
      AND public.get_portal_user_role() IN ('centre_user', 'centre_admin')
    )
  );

-- ------------------------------------------------------------
-- 6. Storage: vss-photos bucket (public read, authed upload)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('vss-photos', 'vss-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS vss_photos_read ON storage.objects;
DROP POLICY IF EXISTS vss_photos_insert ON storage.objects;
DROP POLICY IF EXISTS vss_photos_update ON storage.objects;
DROP POLICY IF EXISTS vss_photos_delete ON storage.objects;
CREATE POLICY vss_photos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'vss-photos');
CREATE POLICY vss_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vss-photos');
CREATE POLICY vss_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'vss-photos')
  WITH CHECK (bucket_id = 'vss-photos');
CREATE POLICY vss_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'vss-photos');
