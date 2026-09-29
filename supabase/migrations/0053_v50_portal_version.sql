-- ============================================================
-- V50: portal version registry — the frontend/DB handshake (L-07)
-- ============================================================
--
-- WHY: the frontend and the database evolve in separate deploys, so a
--   v-next RPC/column can land before/after its caller with no signal —
--   the app then fails (or mis-reports) with no hint that the database
--   is simply behind. This registry is the handshake's source of truth:
--   one row per applied migration version, and portal_app_version()
--   as the single choke point the frontend asks.
--
-- CONVENTION (do not drift): every future migration appends its own row
--   (INSERT ... ON CONFLICT DO NOTHING) and bumps nothing else. The
--   frontend's MIN_SUPPORTED_DB_VERSION lives in src/lib/version.js.
--
-- Run AFTER v49. Non-destructive; safe to re-run.
-- ------------------------------------------------------------

BEGIN;

-- One row per migration version. RLS enabled with NO policies: direct
-- reads are denied for everyone (even aso), and the SECURITY DEFINER
-- function below is the only read path.
CREATE TABLE IF NOT EXISTS public.portal_version (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.portal_version ENABLE ROW LEVEL SECURITY;

-- Backfill: every migration file present in this repo (v2..v50).
-- Idempotent: re-runs add nothing.
INSERT INTO public.portal_version (version) VALUES
  ('v2'),
  ('v3'),
  ('v4'),
  ('v5'),
  ('v6'),
  ('v7'),
  ('v8'),
  ('v9'),
  ('v10'),
  ('v11'),
  ('v12'),
  ('v13'),
  ('v14'),
  ('v15'),
  ('v16'),
  ('v17'),
  ('v18'),
  ('v19'),
  ('v20'),
  ('v21'),
  ('v22'),
  ('v23'),
  ('v24'),
  ('v25'),
  ('v26'),
  ('v27'),
  ('v28'),
  ('v29'),
  ('v30'),
  ('v31'),
  ('v32'),
  ('v33'),
  ('v34'),
  ('v35'),
  ('v36'),
  ('v37'),
  ('v38'),
  ('v38b'),
  ('v38c'),
  ('v39'),
  ('v40'),
  ('v41'),
  ('v42'),
  ('v43'),
  ('v44'),
  ('v45'),
  ('v46'),
  ('v47'),
  ('v48'),
  ('v49'),
  ('v50')
ON CONFLICT (version) DO NOTHING;

-- Newest version wins. Ordered by NUMERIC suffix, not text: text-max
-- would rank 'v9' above 'v50' ('9' > '5'), and the registry must survive
-- single-digit versions if they ever return.
CREATE OR REPLACE FUNCTION public.portal_app_version()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT version
    FROM public.portal_version
   ORDER BY NULLIF(regexp_replace(version, '\D', '', 'g'), '')::int DESC NULLS LAST,
            version DESC
   LIMIT 1
$$;

COMMIT;

-- ============================================================
-- VERIFICATION (read-only — run after applying, as any role)
-- ============================================================
--
-- SELECT public.portal_app_version();
--    -- Expect: 'v50' (the newest backfilled row).
--
-- -- Direct reads are denied (RLS, no policies) — expect a refusal:
-- -- SELECT * FROM public.portal_version;
-- --    -- Expect: ERROR new row violates row-level security (or 0 rows
-- --    -- for non-owners: either way, nothing leaks).
--
-- -- The choke point works for a low-privilege role too. As anon:
-- -- SELECT public.portal_app_version();
-- --    -- Expect: 'v50' (SECURITY DEFINER bypasses RLS for this call).
