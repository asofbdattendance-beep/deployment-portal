-- ============================================================
-- V76: FB-ONLY RIGID BADGE FORMAT. Replaces the v28 is_valid_badge_
-- format body with the FB-only rigid regex (BH branch removed).
--
-- Purpose: mirror the frontend JS regex exactly — only FB-prefixed
-- badges (FB5971GA0001 style) and VSS badges (VS...) are valid.
-- BH-prefixed badges are no longer accepted.
--
-- Non-destructive: CREATE OR REPLACE preserves all existing grants
-- and the function signature (no DROP needed).
--
-- Rollback: re-run the v28 body verbatim:
--   SELECT p_badge ~* '^(FB(597[1-9]|59[89][0-9]|600[0-9]|601[01])(GA|LA)[0-9]{4}|BH[0-9]{4}[A-Z]{1,2}[0-9]{4}|VS[A-Z0-9]+)$'
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_valid_badge_format(p_badge text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_badge ~* '^(FB(597[1-9]|59[89][0-9]|600[0-9]|601[01])(GA|LA)[0-9]{4}|VS[A-Z0-9]+)$'
$$;

COMMIT;
