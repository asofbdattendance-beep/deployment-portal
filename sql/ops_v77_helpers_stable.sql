-- ============================================================
-- OPS: v77 part 1 of 2 — identity helpers VOLATILE -> STABLE
--
-- Exact excerpt of supabase/migrations/0080_v77 (lines 92-140), minus the
-- transaction wrapper. Run this FIRST, via the normal path (Supabase SQL
-- editor is fine here): CREATE OR REPLACE FUNCTION takes only a brief lock
-- on the FUNCTION itself, never on any table, so it is safe at any hour.
--
-- What it does: adds the STABLE keyword to get_portal_user_role() and
-- get_portal_user_centre(). Bodies are byte-identical to live v70 — only
-- the volatility changes, so behaviour is unchanged; the planner simply
-- evaluates each once per statement instead of once per candidate row
-- (up to 5 evaluations per row today via att_read / deploy_v2_read).
--
-- Non-destructive: no table, column, policy, trigger, role or data change.
-- Grants and signatures preserved. Safe to re-run.
--
-- AFTER this, run ops_v77_out_date_index_concurrently.sql (part 2, psql
-- ONLY), then ops_v77_verify.sql. Rollback: re-run the v70 bodies verbatim
-- (drop the STABLE keyword).
-- ============================================================

-- --------------------------------------------------------------------
-- 1a. get_portal_user_role(): VOLATILE -> STABLE. Body unchanged.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_portal_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.portal_users
  WHERE auth_id = auth.uid()
    AND is_active = true
    AND archived_at IS NULL
    AND (force_logout_at IS NULL
         OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
             >= EXTRACT(EPOCH FROM force_logout_at)::bigint);
  IF v_role IS NULL THEN RETURN NULL; END IF;
  RETURN v_role;
END;
$$;

-- --------------------------------------------------------------------
-- 1b. get_portal_user_centre(): VOLATILE -> STABLE. Body unchanged.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_portal_user_centre()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_centre text;
BEGIN
  SELECT centre INTO v_centre FROM public.portal_users
  WHERE auth_id = auth.uid()
    AND is_active = true
    AND archived_at IS NULL
    AND (force_logout_at IS NULL
         OR COALESCE((auth.jwt()->>'iat')::bigint, 0)
             >= EXTRACT(EPOCH FROM force_logout_at)::bigint);
  IF v_centre IS NULL THEN RETURN NULL; END IF;
  RETURN v_centre;
END;
$$;
