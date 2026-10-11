-- ============================================================
-- OPS: close stuck OPEN sessions left by the 2026-10-10/11 outage
--
-- Run in the SQL editor. THIS FILE WRITES — follow the order strictly:
--   Step A (readout file q0/q0b) FIRST: copy the exact closed-status
--     value into <CLOSED_STATUS> below. Do NOT guess it — a wrong value
--     keeps the row OPEN and blocks the sewadar's next IN (unique index
--     uq_dp_one_open_per_badge_schedule allows only one OPEN per badge).
--   Step B: PREVIEW select, check the rows are the people already gone.
--   Step C: the UPDATE, then re-run the preview (expect zero rows).
--
-- PREFERRED alternative: if the person is still on site, just rescan
-- their OUT in the app now that the system is healthy — no SQL needed.
-- Use this file only for people who already left.
--
-- Out-times here are YOUR stated closing time (e.g. the visit-end hour),
-- not the exact minute anyone scanned — the logs never recorded per-badge
-- scan times, so exact backfill is impossible. OUT must be after IN or
-- the row's guard trigger rejects it.
--
-- If an UPDATE raises a deadline error (block_after_deadline), that row
-- needs the aso/super_admin path instead — do not force it.
-- ============================================================

-- PARAMETERS (edit all three):
--   <CLOSED_STATUS> : exact value from readout q0, e.g. 'CLOSED'
--   <OUT_TIME>      : stated closing time, e.g. TIME '18:00:00'
--   <BADGE, ...>    : badges from readout q1 who already left

-- Step B — PREVIEW (read-only). Must show exactly the people you intend
-- to close, each with in_time earlier than your stated OUT time.
SELECT badge_number, sewadar_name, in_date, in_time, status
  FROM public.dp_attendance_sessions
 WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
   AND status = 'OPEN'
   AND in_date = DATE '2026-10-11'
   AND badge_number IN ('<BADGE>', '<BADGE2>');
-- DELETE the dummy badges above and list real ones. If any in_time is
-- LATER than your <OUT_TIME>, remove that badge from the list (its OUT
-- needs its own later time) — otherwise the guard trigger rejects the
-- whole statement.

-- Step C — CLOSE (writes). Check "rows affected" equals the preview count,
-- then re-run Step B and expect zero rows.
-- UPDATE public.dp_attendance_sessions
--    SET out_time = TIME '<OUT_TIME>',
--        out_date = DATE '2026-10-11',
--        status   = '<CLOSED_STATUS>'
--  WHERE schedule_id = 'b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53'
--    AND status = 'OPEN'
--    AND in_date = DATE '2026-10-11'
--    AND badge_number IN ('<BADGE>', '<BADGE2>');
