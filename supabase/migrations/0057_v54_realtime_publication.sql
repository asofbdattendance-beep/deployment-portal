-- ============================================================
-- V54: PUT THE REALTIME TABLES IN THE PUBLICATION (deterministically).
--       Run AFTER v53.
--
-- WHY (a latent, silent bug — not a crash):
--
--   The app subscribes to SIXTEEN tables for live updates (every
--   `table: '...'` in src/pages + src/components):
--
--     dp_attendance_sessions  deployments  sewadar_consents
--     deployment_departments  centre_allocations  centre_locks
--     centre_overrides        centre_vss_overrides  portal_settings
--     portal_users            portal_invitations   custom_roles
--     department_incharges    department_incharge_selections
--     department_incharge_assignments   sewadar_audit_log
--
--   Supabase Realtime's `postgres_changes` only streams a table that is a
--   member of the `supabase_realtime` publication. A channel still JOINS
--   successfully without it — so nothing errors — the subscription simply
--   never receives an event, and every page quietly falls back to "refresh to
--   see changes". That is the same failure shape as the v40 attendance bug:
--   correctly-shaped UI carrying entirely wrong numbers.
--
--   No migration ever configured it. v28 examined the question and explicitly
--   declined to act ("No DDL needed here"), leaving the ADD TABLE lines inside
--   a COMMENT block as an optional note for anyone who had added the pre-rename
--   table names by hand. So whether live updates work today depends on
--   something a person may or may not have clicked in the Dashboard at some
--   point — exactly the kind of invisible dependency that is a bug waiting to
--   be reported as "the live numbers don't update".
--
--   This migration makes it deterministic and IDEMPOTENT, and — importantly —
--   it REPORTS what it found, so the current state stops being a guess.
--
--   It is safe to run when the tables are already members: each ADD is guarded
--   by pg_publication_tables, so re-running is a no-op rather than the
--   "table is already member of publication" error a bare ALTER would raise.
--   Tables that do not exist in this database are skipped, not created.
--
-- NOTE — a SEPARATE issue, not fixed here:
--   The `[…] realtime CLOSED` console warning is a FALSE ALARM. Every page
--   tears its channel down in the effect cleanup via `supabase.removeChannel()`,
--   which fires the subscribe callback with status `CLOSED`, and the handlers
--   warned on `status !== 'SUBSCRIBED'`. So the warning fires on every normal
--   unmount/navigation. That is fixed in the CLIENT (the handlers now only warn
--   on CHANNEL_ERROR / TIMED_OUT, and only while still mounted) — it was never
--   a database problem.
--
-- Non-destructive; safe to re-run. Verification at the bottom.
-- ============================================================

BEGIN;

DO $do$
DECLARE
  v_pub  text := 'supabase_realtime';
  v_list text[] := ARRAY[
    'public.dp_attendance_sessions',
    'public.deployments',
    'public.sewadar_consents',
    'public.deployment_departments',
    'public.centre_allocations',
    'public.centre_locks',
    'public.centre_overrides',
    'public.centre_vss_overrides',
    'public.portal_settings',
    'public.portal_users',
    'public.portal_invitations',
    'public.custom_roles',
    'public.department_incharges',
    'public.department_incharge_selections',
    'public.department_incharge_assignments',
    'public.sewadar_audit_log'
  ];
  v_t    text;
  v_added text := '';
  v_skipped text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = v_pub) THEN
    RAISE NOTICE 'V54: publication % does not exist on this database — realtime is NOT available. Skipping.', v_pub;
    RETURN;
  END IF;

  FOREACH v_t IN ARRAY v_list LOOP
    IF to_regclass(v_t) IS NULL THEN
      v_skipped := v_skipped || v_t || ' ';
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = v_pub AND schemaname || '.' || tablename = v_t
    ) THEN
      EXECUTE format('ALTER PUBLICATION %I ADD TABLE %s', v_pub, v_t);
      v_added := v_added || v_t || ' ';
    END IF;
  END LOOP;

  RAISE NOTICE 'V54: added to %: %', v_pub, COALESCE(NULLIF(v_added, ''), '(nothing — all already members)');
  IF v_skipped <> '' THEN
    RAISE NOTICE 'V54: skipped, table absent: %', v_skipped;
  END IF;
END;
$do$;

COMMIT;

-- ============================================================
-- VERIFICATION
-- ============================================================
-- 1. The publication's contents. Every table the app subscribes to should be
--    listed; a missing one is a page that will never update live:
--      SELECT tablename FROM pg_publication_tables
--       WHERE pubname = 'supabase_realtime' ORDER BY tablename;
--
-- 2. Count check — expect AT LEAST 16 once applied. `pg_publication_tables`
--    is never emptied by this file, so a table added by hand in the Dashboard
--    (the historical state this migration exists to fix) or pre-owned by the
--    platform pushes the count ABOVE 16 and that is not a failure. Fewer than
--    16 means a table does not exist in this database. Step 3 is the
--    authoritative check — do not treat a count over 16 as drift:
--      SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
--
-- 3. The exact gap, as a single query (expect ZERO rows when done):
--      SELECT t AS missing FROM unnest(ARRAY[
--        'dp_attendance_sessions','deployments','sewadar_consents',
--        'deployment_departments','centre_allocations','centre_locks',
--        'centre_overrides','centre_vss_overrides','portal_settings',
--        'portal_users','portal_invitations','custom_roles',
--        'department_incharges','department_incharge_selections',
--        'department_incharge_assignments','sewadar_audit_log'
--      ]) AS t
--       WHERE to_regclass('public.' || t) IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
--                          WHERE pubname = 'supabase_realtime' AND tablename = t);
--
-- 4. Re-running this file must be a clean no-op — that is the idempotency
--    proof. If a bare "table is already member" error appears, a guard is
--    missing.
-- ============================================================
