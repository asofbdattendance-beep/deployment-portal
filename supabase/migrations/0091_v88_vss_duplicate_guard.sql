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

BEGIN;

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

COMMIT;

-- ============================================================
-- VERIFICATION
-- 1. SELECT * FROM public.find_vss_duplicates('abhay  singh', NULL, '2007-09-06');
--    → the roster row VSFB5971GB4629 (similar name + same date of birth)
-- 2. SELECT * FROM public.find_vss_duplicates('Singh Abhay', 'Kamaljit Singh');
--    → same row (same name + same father/husband name)
-- 3. INSERT a vss_registrations row for that person → raises
--    'This VSS record already exists: VSFB5971GB4629 (ABHAY SINGH, DLF CITY GURGAON)'
-- ============================================================
