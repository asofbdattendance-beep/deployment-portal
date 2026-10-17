-- ============================================================
-- OPS: wire the 21:00 IST auto-out sweep to a timer.
--
-- NOT a migration, and NOT checked by CI's migration-parity job (that job
-- only inspects sql/v[0-9]*_*.sql). Apply sql/v79_attendance_auto_out.sql
-- FIRST and verify it — this file only installs the timer that calls the
-- function v79 created.
--
-- Renaming does not lose the file: unsafe to auto-apply on a project with
-- no pg_cron, so it is kept separate from the migration and is guarded.
-- ============================================================

-- ------------------------------------------------------------
-- READ THIS FIRST — THE HONEST STATE OF THIS REPO
-- ------------------------------------------------------------
-- There is NO recurring-job infrastructure anywhere in this project today:
-- no pg_cron extension created by any migration, no `crons` key in
-- vercel.json (it holds `headers` only), no `schedule:` in .github/workflows,
-- no scheduled Edge Function in supabase/functions/ (only create-login,
-- manage-login, resolve-login), no scheduled task in package.json.
--
-- So the 21:00 sweep needs a timer that does not exist yet. This file
-- installs the one that costs nothing, keeps the sweep inside the database,
-- and needs no HTTP hop: **pg_cron**.
--
-- WHETHER pg_cron IS INSTALLED ON THE LIVE PROJECT IS UNVERIFIED — this
-- repo cannot query the live database, and nothing in the repo ever creates
-- the extension. That is exactly why this file checks `pg_extension` first
-- instead of assuming. If it is missing, you get a NOTICE and the fallback
-- list below — never a broken migration.
--
-- On Supabase, pg_cron is enabled from Dashboard -> Database -> Extensions
-- ("pg_cron"). It then lives in the `postgres` database, which is where the
-- app's tables are, so a job scheduled here reaches them. On self-hosted
-- Postgres it must be in shared_preload_libraries and requires a restart.
--
-- ------------------------------------------------------------
-- THE SCHEDULE ARITHMETIC (do not "fix" this to 21:00)
-- ------------------------------------------------------------
-- pg_cron times are UTC. India is UTC+5:30 year-round (no DST, ever).
--   15:30 UTC == 21:00 IST.
-- The bootstrap below is written `30 15 * * *` and every run sweeps *the
-- IST day it is running in*, computed inside the function from its own
-- p_ts — so the timer only has to land on 21:00 IST and the day handling
-- stays correct. India's 30-minute offset is why the minute field is 30
-- and not 0.
--
-- ------------------------------------------------------------
-- FALLBACKS, IN ORDER OF PREFERENCE, IF pg_cron IS ABSENT
-- ------------------------------------------------------------
-- 1. Supabase scheduled Edge Function (Dashboard -> Edge Functions ->
--    Schedules) that POSTs to /rest/v1/rpc/attendance_auto_close_open_sessions
--    with the service_role key in an `apikey`/`Authorization` header. This
--    is why v79 grants EXECUTE to service_role. Never put that key in a
--    client bundle.
-- 2. Vercel cron — add a `crons` key to vercel.json (currently headers
--    only; 31 lines) hitting a serverless route that calls the same RPC
--    with the service_role key. Check the plan's cron limits first.
-- 3. GitHub Actions `schedule:` — the repo has .github/workflows/ci.yml
--    with no `schedule:` yet. Actions cron is BEST-EFFORT and routinely
--    late by minutes to over an hour, so it is a poor fit for a fixed
--    21:00 cutoff. Accept the drift or prefer 1/2.
-- 4. Do NOT close sessions from the browser. A client-side sweep only runs
--    while some device happens to be open and foregrounded; it cannot
--    guarantee 21:00 and it would have to impersonate a scanning role to
--    call scan_out. The sweep must be server-side.
--
-- Every fallback calls the same function, so the closure semantics (IST day,
-- out_date = in_date, out_time = 21:00, is_auto_out = true, out_scanner_*
-- NULL) stay identical no matter which timer you end up with.
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1 — check what you have before scheduling anything.
-- ------------------------------------------------------------
-- Expect exactly one row ('pg_cron') if the extension is installed:
SELECT extname, extversion
  FROM pg_extension
 WHERE extname IN ('pg_cron', 'pg_net');

-- ------------------------------------------------------------
-- STEP 2 — install the job. Idempotent: re-running replaces the job
--          rather than stacking a second copy of it.
--
-- `cron.schedule(job_name, schedule, command)` (3-arg, named) needs
-- pg_cron >= 1.4; the 2-arg form is older. If this block reports
-- "function cron.schedule(...) does not exist", use the 2-arg form shown
-- in the note at the bottom of this file.
--
-- The command is a single statement; pg_cron runs it in the `postgres`
-- database as the job owner (the role that scheduled it), so the function's
-- EXECUTE grant is irrelevant to it.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is NOT installed — no job scheduled. Enable it (Dashboard -> Database -> Extensions), then re-run this file. Otherwise use a fallback from the list at the top of this file (Edge Function schedule / Vercel cron). Do NOT close sessions from the browser.';
    RETURN;
  END IF;

  -- Replace any previous copy of this job so re-running never stacks duplicates.
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'attendance-auto-out-2100-ist';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
    RAISE NOTICE 'Replaced existing pg_cron job % (jobid %).', 'attendance-auto-out-2100-ist', v_jobid;
  END IF;

  PERFORM cron.schedule(
    'attendance-auto-out-2100-ist',
    '30 15 * * *',                                   -- 15:30 UTC == 21:00 IST daily
    $cron$ SELECT public.attendance_auto_close_open_sessions(); $cron$
  );

  RAISE NOTICE 'Scheduled attendance-auto-out-2100-ist: daily 30 15 * * * (21:00 IST) -> attendance_auto_close_open_sessions().';
END $$;

-- ------------------------------------------------------------
-- STEP 3 — VERIFICATION (read-only, run AFTER step 2)
-- ------------------------------------------------------------
-- 3a. The job exists, is active, and carries the expected command.
--     Expect one row: schedule '30 15 * * *', active true, and the command
--     calling attendance_auto_close_open_sessions.
-- SELECT jobid, jobname, schedule, command, active, username
--   FROM cron.job
--  WHERE jobname = 'attendance-auto-out-2100-ist';
--
-- 3b. Watch the first runs. Rows appear only after the job has fired once.
--     Expect status 'succeeded', and note the actual start_time, which
--     should sit at ~15:30 UTC. A non-null `return_message` of '0' means it
--     ran and found nothing to close — correct on a quiet evening.
-- SELECT j.jobname, r.status, r.start_time, r.end_time, r.return_message
--   FROM cron.job_run_details r
--   JOIN cron.job j ON j.jobid = r.jobid
--  WHERE j.jobname = 'attendance-auto-out-2100-ist'
--  ORDER BY r.start_time DESC
--  LIMIT 10;
--
-- 3c. The job actually closed something, tagged, with no scanner identity.
--     The first real rows should appear the morning after the first 21:00.
-- SELECT badge_number, in_date, in_time, out_date, out_time, out_scanner_badge, is_auto_out
--   FROM public.dp_attendance_sessions
--  WHERE is_auto_out
--  ORDER BY updated_at DESC
--  LIMIT 20;
--
-- 3d. Nothing left behind: every auto-closed row is well-formed. Expect 0.
-- SELECT count(*) AS broken
--   FROM public.dp_attendance_sessions
--  WHERE is_auto_out
--    AND (status <> 'CLOSED' OR out_date <> in_date OR out_time <= in_time);
--
-- ------------------------------------------------------------
-- REMOVING THE JOB (if you move to a different timer)
-- ------------------------------------------------------------
-- SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'attendance-auto-out-2100-ist';
--
-- ------------------------------------------------------------
-- NOTE — older pg_cron (no named 3-arg schedule): use the 2-arg form and
-- look the job up by command instead of by name.
--
--   SELECT cron.schedule('30 15 * * *',
--     'SELECT public.attendance_auto_close_open_sessions();');
--
--   SELECT jobid, schedule, command FROM cron.job;
-- ============================================================
