-- ============================================================
-- OPS: attendance reconciliation readout — find who the outage left behind
--
-- Run in the SQL editor (any role). PURE READS: nothing is written.
-- Edit the two parameters at the top, run section by section, paste
-- output back if you want help interpreting it.
--
-- Background: the 2026-10-10/11 outage logs contain NO scanned-sewadar
-- badge numbers (postgres log rows have empty query text; the PostgREST
-- log records RPC paths but never POST bodies). So the failed badges
-- cannot be listed from the logs — but the SESSIONS TABLE can, because
-- every scan that reached the DB left a row. This file reads that truth.
-- ============================================================

-- PARAMETERS (edit these two lines only):
-- Schedule UUID seen in the outage logs:
--   b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53
-- Incident date (the day people scanned and failed):
--   2026-10-11

-- 0. Discover the closed-row convention FIRST.
--    The close-out file needs the exact status value a normal scan_out
--    writes. Expect two rows (e.g. OPEN + CLOSED); note the non-OPEN one.
SELECT status, count(*) AS n
  FROM public.dp_attendance_sessions
 WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
 GROUP BY status;

-- 0b. Sample one normally-closed row: shows exactly which columns
--     scan_out fills (out_time? out_date? status?) so the close-out
--     UPDATE copies the convention instead of guessing it.
SELECT id, badge_number, sewadar_name, in_date, in_time,
       out_date, out_time, status, in_scanner_badge, created_at
  FROM public.dp_attendance_sessions
 WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND status <> 'OPEN'
 ORDER BY created_at DESC
 LIMIT 2;

-- 1. STUCK SESSIONS: IN recorded, OUT never landed (the "Already IN"
--    people and anyone whose OUT timed out). These badges HAVE attendance
--    for the day — they just look un-closed. Close them via rescan or via
--    ops_attendance_close_stuck_sessions.sql (for people already gone).
SELECT badge_number, sewadar_name, sewadar_centre, sewadar_dept,
       in_date, in_time, in_scanner_badge, is_vss, created_at
  FROM public.dp_attendance_sessions
 WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND status = 'OPEN'
   AND (in_date = DATE '2026-10-11' OR out_date = DATE '2026-10-11')
 ORDER BY in_time;

-- 2. CANDIDATE MISSING INs: deployed for this schedule but NO session row
--    at all on the incident date. Over-lists by design (not every deployed
--    sewadar attends daily) — cross-check with incharges before treating
--    any row here as a real gap. Anyone here whose scan sat in a device
--    offline queue will appear on their own once the device goes online.
SELECT d.badge_number, d.sewadar_name, d.centre
  FROM public.deployments d
 WHERE d.schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND NOT EXISTS (
     SELECT 1 FROM public.dp_attendance_sessions s
      WHERE s.schedule_id = d.schedule_id
        AND s.badge_number = d.badge_number
        AND (s.in_date = DATE '2026-10-11' OR s.out_date = DATE '2026-10-11')
   )
 ORDER BY d.badge_number;

-- 3. Incident-day totals (sanity: compare against the incharge headcount).
SELECT count(*) AS sessions,
       count(*) FILTER (WHERE status = 'OPEN') AS still_open,
       count(*) FILTER (WHERE status <> 'OPEN') AS closed
  FROM public.dp_attendance_sessions
 WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND (in_date = DATE '2026-10-11' OR out_date = DATE '2026-10-11');
