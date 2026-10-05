-- v73: login rate-limit storage (additive only).
--
-- Supports badge→email resolution (supabase/functions/resolve-login) and
-- throttling on create-login / manage-login at 150 concurrent users.
-- ADDITIVE ONLY: one new table + one helper function + one index. No existing
-- table is altered; no UPDATE / DELETE / DROP of any existing row.
-- The table is append-only counters pruned by the function itself.
-- RLS is enabled (public schema default); the helper is SECURITY DEFINER so
-- edge functions via service_role work, and anon/authenticated have no direct
-- access (no policies = deny by default).
--
-- Apply after v72.
BEGIN;

CREATE TABLE IF NOT EXISTS public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip text NOT NULL,
  identity text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_identity_at
  ON public.login_attempts (ip, identity, attempted_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_login_rate(
  p_ip text, p_identity text, p_max int, p_window_secs int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM public.login_attempts
    WHERE attempted_at < now() - (p_window_secs || ' seconds')::interval;
  SELECT count(*) INTO v_count
    FROM public.login_attempts
    WHERE ip = p_ip AND identity = p_identity
      AND attempted_at >= now() - (p_window_secs || ' seconds')::interval;
  IF v_count >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.login_attempts (ip, identity) VALUES (p_ip, p_identity);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_rate(text, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text, int, int) TO anon, authenticated, service_role;

COMMIT;

-- ── Verification (run as super_admin after applying) ──
-- SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='login_attempts';  -- expect 1 row
-- SELECT public.check_login_rate('127.0.0.1', 'probe', 10, 900);  -- expect true (first call)
-- SELECT count(*) FROM public.login_attempts WHERE identity='probe';  -- expect >= 1
-- -- Re-run safety: execute this whole file a second time. Expect no error.
