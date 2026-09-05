-- ============================================================
-- V27: FARIDABAD helper + flag for scanner scope
-- Scanners: allow FB/BH/VS badges from dump; flag undeployed.
-- Optional centres.is_faridabad flag for UI.
-- NON-DESTRUCTIVE — safe to re-run.
-- ============================================================

ALTER TABLE public.centres ADD COLUMN IF NOT EXISTS is_faridabad boolean DEFAULT false;

-- mark Faridabad centres if naming convention contains FB / FARIDABAD (adjust manually in prod)
-- UPDATE public.centres SET is_faridabad = true WHERE name ILIKE '%FARIDABAD%' OR name ILIKE 'FB%';

CREATE OR REPLACE FUNCTION public.is_faridabad_centre(p_centre text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT is_faridabad FROM public.centres WHERE name = p_centre LIMIT 1), false)
        OR public.get_root_centre(p_centre) IN (SELECT name FROM public.centres WHERE is_faridabad = true)
$$;

CREATE OR REPLACE FUNCTION public.is_faridabad_badge(p_badge text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_valid_badge_format(p_badge)
$$;

-- VERIFY
-- SELECT public.is_valid_badge_format('FB5971GA0001'), public.is_valid_badge_format('VS123'), public.is_faridabad_badge('BH1234AB0001');
