-- ============================================================
-- V6: VSS ROSTER MANAGEMENT SUPPORT
-- Adds:
--   1) vss_sewadars.aadhar_number (nullable, copied over on assign)
--   2) updated assign_vss_registration(): copies aadhar into the
--      roster row and writes an audit_log entry (ASSIGN_VSS)
-- IDEMPOTENT — safe to re-run. Run AFTER v5_vss_creation.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. vss_sewadars: optional aadhar_number for roster rows
-- ------------------------------------------------------------
ALTER TABLE public.vss_sewadars ADD COLUMN IF NOT EXISTS aadhar_number text;

-- ------------------------------------------------------------
-- 2. assign_vss_registration() v2 — copies aadhar + audits
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
  v_roster_id uuid;
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
    print_status, form_status, is_active, remarks, aadhar_number
  ) VALUES (
    p_vsfb, v_reg.sewadar_name, v_reg.father_husband_name, v_reg.dob, v_reg.gender,
    'VSS', v_reg.centre, 'SANGAT', v_reg.contact_no, v_reg.emergency_contact,
    v_reg.is_initiated, 'ReadyToPrint-VSS', 'Approved', true, NULL, v_reg.aadhar_number
  )
  RETURNING id INTO v_roster_id;

  UPDATE public.vss_registrations
  SET status = 'assigned',
      assigned_badge_number = p_vsfb,
      assigned_by = p_by,
      assigned_at = now()
  WHERE id = p_reg;

  INSERT INTO public.audit_log (action, table_name, record_id, schedule_id, payload, acted_by)
  VALUES ('ASSIGN_VSS', 'vss_sewadars', v_roster_id, NULL,
    jsonb_build_object(
      'registration_id', p_reg,
      'temp_vss_id', v_reg.temp_vss_id,
      'badge_number', p_vsfb,
      'centre', v_reg.centre,
      'name', v_reg.sewadar_name
    ),
    p_by);

  RETURN p_vsfb;
END;
$$;
