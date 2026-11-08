# Department Shift Cutoffs (Late In / Early Out) & 9 PM Auto-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement department-wise shift cutoffs (Expected IN / Expected OUT time) per schedule without blocking scanning, automatically tag attendance sessions with "Late In" and "Early Out", surface these tags across the scanner popup, recent feeds, and attendance logs, and wire an automated 21:00 IST (15:30 UTC) auto-out runner.

**Architecture:**
- **Database (v81):** Add `is_late_in` and `is_early_out` booleans to `dp_attendance_sessions`. Store department cutoffs in `schedule_department_timings` (per-schedule overrides) falling back to `deployment_departments` (global defaults). Update `scan_in` and `scan_out` RPCs to check timestamps against the cutoffs and stamp the boolean flags.
- **Automation:** Deploy a scheduled GitHub Actions workflow (`.github/workflows/attendance-auto-out.yml`) firing daily at 15:30 UTC (21:00 IST) invoking `attendance_auto_close_open_sessions()`, paired with an idempotent `pg_cron` script for in-database execution.
- **Frontend & Scanner:** Add shift cutoff inputs to `ScheduleMakerPage` under department rules. Update `useScanHandler`, `ScanResultPopup`, `RecentScansTable`, `MobileScanFeed`, and attendance log tables/exports to display "Late In" and "Early Out" chips.

**Tech Stack:** PostgreSQL (PL/pgSQL, Supabase), React 18, Vitest, React Testing Library, GitHub Actions, ExcelJS / SheetJS.

**Spec:** User request 2026-11-08: "I want the auto out on 9 pm - I want the IN Time / OUT Time (cuttoff) - this i want in the shedule - department wise - this will be like this without any constraints btu the system upon the scan marking must make a tag of 'Early Out', 'Late In'".

## Global Constraints

- Scanning must remain completely unconstrained: no scan may ever be blocked, rejected, or delayed by shift cutoffs.
- Anon key compatibility: client only SELECTs `dp_attendance_sessions`; writes go through SECURITY DEFINER RPCs (`scan_in`, `scan_out`).
- Timezone fidelity: all shift comparisons operate in Indian Standard Time (`Asia/Kolkata` / `+05:30`).
- DB migration parity: any file in `sql/` must have a byte-identical counterpart in `supabase/migrations/` (CI enforced).
- Frontend DB floor: bump `MIN_SUPPORTED_DB_VERSION` in `src/lib/version.js` to `'v81'`.

## Review Focus

1. **Scan on time boundary:** A scan exactly at the cutoff (e.g. IN at 08:00:00 when cutoff is 08:00) must be tagged on-time (`is_late_in = false`), not late.
2. **Missing cutoff handling:** If a department has no IN cutoff or no OUT cutoff configured, scans must never be flagged as late or early (`is_late_in = false`, `is_early_out = false`).
3. **Undeployed sewadar scan:** A sewadar scanned without a deployment row has no department; shift evaluation must safely treat cutoffs as NULL without throwing.
4. **Auto-out replacement:** A real OUT scan replacing an auto-closed 21:00 session must evaluate `is_early_out` using the real OUT timestamp.
5. **Offline replay:** Scans enqueued offline and synced later must evaluate `is_late_in` and `is_early_out` against the original `p_ts` (scan time), not the drain time.

---

### Task 1: Database Migration (v81) — Shift Cutoffs & Tagging RPCs

**Files:**
- Create: `sql/v81_department_shift_cutoffs.sql`
- Create: `supabase/migrations/0084_v81_department_shift_cutoffs.sql`
- Test: `tests/e2e/shift-cutoffs.spec.js`

**Interfaces:**
- Consumes: `dp_attendance_sessions`, `deployment_departments`, `deployments`, `get_open_session`
- Produces:
  - Columns `dp_attendance_sessions.is_late_in` (bool), `dp_attendance_sessions.is_early_out` (bool)
  - Columns `deployment_departments.expected_in_time` (time), `deployment_departments.expected_out_time` (time)
  - Table `schedule_department_timings` (`schedule_id uuid`, `department_id uuid`, `expected_in_time time`, `expected_out_time time`)
  - Updated `scan_in` returning `late_in` in jsonb
  - Updated `scan_out` returning `early_out` in jsonb

- [ ] **Step 1: Write migration `sql/v81_department_shift_cutoffs.sql`**

Include:
1. `ALTER TABLE public.dp_attendance_sessions ADD COLUMN IF NOT EXISTS is_late_in boolean NOT NULL DEFAULT false;`
2. `ALTER TABLE public.dp_attendance_sessions ADD COLUMN IF NOT EXISTS is_early_out boolean NOT NULL DEFAULT false;`
3. `ALTER TABLE public.deployment_departments ADD COLUMN IF NOT EXISTS expected_in_time time DEFAULT '08:00';`
4. `ALTER TABLE public.deployment_departments ADD COLUMN IF NOT EXISTS expected_out_time time DEFAULT '17:00';`
5. `CREATE TABLE IF NOT EXISTS public.schedule_department_timings (`
   `schedule_id uuid NOT NULL REFERENCES public.deployment_schedules(id) ON DELETE CASCADE,`
   `department_id uuid NOT NULL REFERENCES public.deployment_departments(id) ON DELETE CASCADE,`
   `expected_in_time time,`
   `expected_out_time time,`
   `PRIMARY KEY (schedule_id, department_id)`
   `);`
6. `CREATE OR REPLACE FUNCTION public.scan_in(...)`:
   Lookup `expected_in_time` via:
   ```sql
   SELECT COALESCE(sdt.expected_in_time, d.expected_in_time) INTO v_expected_in
     FROM public.deployment_departments d
     LEFT JOIN public.schedule_department_timings sdt
       ON sdt.department_id = d.id AND sdt.schedule_id = p_schedule
    WHERE d.id = v_dept;
   v_is_late_in := (v_expected_in IS NOT NULL AND v_in_time > v_expected_in);
   ```
   Insert `is_late_in = v_is_late_in` into `dp_attendance_sessions`.
   Return `'late_in', v_is_late_in` in jsonb.
7. `CREATE OR REPLACE FUNCTION public.scan_out(...)`:
   Lookup `expected_out_time` via:
   ```sql
   SELECT COALESCE(sdt.expected_out_time, d.expected_out_time) INTO v_expected_out
     FROM public.deployment_departments d
     LEFT JOIN public.schedule_department_timings sdt
       ON sdt.department_id = d.id AND sdt.schedule_id = p_schedule
    WHERE d.id = v_open.sewadar_dept;
   v_is_early_out := (v_expected_out IS NOT NULL AND v_out_time < v_expected_out);
   ```
   Update `is_early_out = v_is_early_out` on `dp_attendance_sessions`.
   Return `'early_out', v_is_early_out` in jsonb.
8. Append `INSERT INTO public.portal_version (version) VALUES ('v81') ON CONFLICT DO NOTHING;`

- [ ] **Step 2: Mirror to `supabase/migrations/0084_v81_department_shift_cutoffs.sql`**

Verify exact byte parity between `sql/v81_department_shift_cutoffs.sql` and `supabase/migrations/0084_v81_department_shift_cutoffs.sql`.

- [ ] **Step 3: Update `mock-supabase.mjs` for e2e tests**

In `tests/e2e/mock-supabase.mjs`:
- Add `is_late_in` and `is_early_out` fields to session state.
- Update mocked `scan_in` and `scan_out` RPC handlers to return `late_in` and `early_out`.

- [ ] **Step 4: Commit migration**

```bash
git add sql/v81_department_shift_cutoffs.sql supabase/migrations/0084_v81_department_shift_cutoffs.sql tests/e2e/mock-supabase.mjs
git commit -m "feat(db): [v81] department shift cutoffs and timing tags"
```

---

### Task 2: 9:00 PM Auto-Out Automation (Cron Setup)

**Files:**
- Create: `.github/workflows/attendance-auto-out.yml`
- Modify: `sql/ops_attendance_auto_close_cron.sql`
- Test: `tests/e2e/auto-out.test.js`

**Interfaces:**
- Consumes: Supabase RPC `attendance_auto_close_open_sessions`
- Produces: Daily automated execution at 15:30 UTC (21:00 IST)

- [ ] **Step 1: Write `.github/workflows/attendance-auto-out.yml`**

```yaml
name: Attendance 21:00 IST Auto-Out Sweep

on:
  schedule:
    # 15:30 UTC == 21:00 IST every day
    - cron: '30 15 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Trigger attendance_auto_close_open_sessions
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: |
          if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
            echo "::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets required."
            exit 1
          fi
          res=$(curl -sS --fail-with-body -X POST "$SUPABASE_URL/rest/v1/rpc/attendance_auto_close_open_sessions" \
            -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
            -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
            -H "Content-Type: application/json" \
            -d '{}')
          echo "Auto-out closed sessions count: $res"
```

- [ ] **Step 2: Commit workflow**

```bash
git add .github/workflows/attendance-auto-out.yml
git commit -m "feat(ops): add daily 21:00 IST auto-out GitHub Actions sweep"
```

---

### Task 3: Schedule Maker UI — Department Shift Cutoffs Configuration

**Files:**
- Modify: `src/pages/ScheduleMakerPage.jsx`
- Modify: `src/pages/ScheduleMakerPage.test.jsx`

**Interfaces:**
- Consumes: `schedule_department_timings`, `deployment_departments`
- Produces: Time inputs for Expected IN and Expected OUT per department in the Departments & Rules panel.

- [ ] **Step 1: Write test for shift cutoffs in `ScheduleMakerPage.test.jsx`**

Test that opening Rules for a department displays "Expected IN Time (Cutoff)" and "Expected OUT Time (Cutoff)" inputs, and saving calls the update with these values.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/pages/ScheduleMakerPage.test.jsx`
Expected: FAIL (inputs not found).

- [ ] **Step 3: Implement shift cutoff inputs in `ScheduleMakerPage.jsx`**

In `DepartmentsPanel` inside `ScheduleMakerPage.jsx`:
1. Add `expected_in_time` and `expected_out_time` state to `rules`.
2. Render `<input type="time" value={rules.expected_in_time} onChange={...} />` and `<input type="time" value={rules.expected_out_time} onChange={...} />`.
3. In `saveRules`, save both `expected_in_time` and `expected_out_time`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/pages/ScheduleMakerPage.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ScheduleMakerPage.jsx src/pages/ScheduleMakerPage.test.jsx
git commit -m "feat(schedule): add department shift cutoffs to Schedule Maker"
```

---

### Task 4: Scanner UI & Handler — "Late In" & "Early Out" Tagging

**Files:**
- Modify: `src/hooks/useScanHandler.js`
- Modify: `src/hooks/useScanHandler.test.jsx`
- Modify: `src/components/scanner/ScanResultPopup.jsx`
- Modify: `src/components/scanner/ScanResultPopup.test.jsx`
- Modify: `src/components/scanner/RecentScansTable.jsx`
- Modify: `src/components/scanner/RecentScansTable.test.jsx`

**Interfaces:**
- Consumes: `res.late_in`, `res.early_out` from `scan_in` and `scan_out`
- Produces:
  - Popup payload with `is_late_in: boolean`, `is_early_out: boolean`
  - Visual pills `"Late In"` and `"Early Out"` on the scan popup and recent scans list

- [ ] **Step 1: Write unit tests in `useScanHandler.test.jsx` and `ScanResultPopup.test.jsx`**

- In `useScanHandler.test.jsx`: Assert that when `scan_in` returns `{ ok: true, late_in: true }`, `showPopup` is invoked with `is_late_in: true`.
- In `ScanResultPopup.test.jsx`: Assert that rendering with `{ status: 'in', is_late_in: true }` displays the "Late In" pill.
- In `ScanResultPopup.test.jsx`: Assert that rendering with `{ status: 'out', is_early_out: true }` displays the "Early Out" pill.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test src/hooks/useScanHandler.test.jsx src/components/scanner/ScanResultPopup.test.jsx`
Expected: FAIL (pill not found / props not passed).

- [ ] **Step 3: Implement tag handling in `useScanHandler.js`**

1. In `handleScan` / `doScanIn`:
   Read `res.late_in` and pass `is_late_in: !!res.late_in` into `showPopup`.
2. In `handleScan` / `doScanOut`:
   Read `res.early_out` and pass `is_early_out: !!res.early_out` into `showPopup`.

- [ ] **Step 4: Implement pill rendering in `ScanResultPopup.jsx`, `RecentScansTable.jsx`**

1. In `ScanResultPopup.jsx`:
   If `popup.is_late_in`, render `<span className="pill pill-amber" style={{ fontWeight: 700 }}><Clock size={11} /> Late In</span>`.
   If `popup.is_early_out`, render `<span className="pill pill-amber" style={{ fontWeight: 700 }}><Clock size={11} /> Early Out</span>`.
2. In `RecentScansTable.jsx`:
   Show a `Late In` / `Early Out` indicator alongside session times.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test src/hooks/useScanHandler.test.jsx src/components/scanner/ScanResultPopup.test.jsx src/components/scanner/RecentScansTable.test.jsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useScanHandler.js src/hooks/useScanHandler.test.jsx src/components/scanner/ScanResultPopup.jsx src/components/scanner/ScanResultPopup.test.jsx src/components/scanner/RecentScansTable.jsx src/components/scanner/RecentScansTable.test.jsx
git commit -m "feat(scanner): display Late In and Early Out tags on popup and recent scans"
```

---

### Task 5: Attendance Logs, Registers & Excel Exports

**Files:**
- Modify: `src/lib/attendance.js`
- Modify: `src/lib/attendance.test.js`
- Modify: `src/lib/attendanceExcel.js`
- Modify: `src/components/PrevisitView.jsx`
- Modify: `src/pages/AttendancePage.jsx`

**Interfaces:**
- Consumes: `is_late_in`, `is_early_out` from `dp_attendance_sessions`
- Produces:
  - Updated `SCAN_LOG_SESSION_COLS`
  - Updated `buildLogRows` mapping `is_late_in` and `is_early_out` to badges
  - Export columns "Late In" and "Early Out" in Excel workbooks

- [ ] **Step 1: Write test for log formatting in `attendance.test.js`**

Assert that `buildLogRows` sets `is_late_in: true` and `is_early_out: true` when present on session rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/attendance.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `src/lib/attendance.js` and `attendanceExcel.js`**

1. In `src/lib/attendance.js`:
   Add `is_late_in,is_early_out` to `SCAN_LOG_SESSION_COLS`.
   In `buildLogRows`, map `is_late_in: Boolean(r.is_late_in)` and `is_early_out: Boolean(r.is_early_out)`.
2. In `src/lib/attendanceExcel.js`:
   Add "Timing Exception" column to attendance log export ("Late In", "Early Out", or "—").
3. In `PrevisitView.jsx` and `AttendancePage.jsx`:
   Render `Late In` / `Early Out` badges in the Logs table row.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/lib/attendance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attendance.js src/lib/attendance.test.js src/lib/attendanceExcel.js src/components/PrevisitView.jsx src/pages/AttendancePage.jsx
git commit -m "feat(reports): add Late In and Early Out to attendance logs and Excel exports"
```

---

### Task 6: Version Handshake & Full Verification

**Files:**
- Modify: `src/lib/version.js`
- Modify: `src/lib/version.test.js`

- [ ] **Step 1: Update `MIN_SUPPORTED_DB_VERSION` to `'v81'`**

In `src/lib/version.js`:
Set `export const MIN_SUPPORTED_DB_VERSION = 'v81'`.

- [ ] **Step 2: Run tests in `src/lib/version.test.js`**

Run: `npm test src/lib/version.test.js`
Expected: PASS.

- [ ] **Step 3: Run full verification suite**

```bash
npm run lint && npm test && npm run build
```
Verify:
1. ESLint: 0 errors
2. Vitest: 100% tests passing
3. Vite build: Successful build with service worker precache

- [ ] **Step 4: Commit**

```bash
git add src/lib/version.js src/lib/version.test.js
git commit -m "chore(version): bump MIN_SUPPORTED_DB_VERSION to v81"
```
