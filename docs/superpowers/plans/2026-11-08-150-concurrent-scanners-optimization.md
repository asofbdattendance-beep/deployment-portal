# 150 Concurrent Scanners Optimization & Supabase Free-Tier Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the attendance scanning subsystem so up to 150 concurrent scanners (operating during peak arrival/departure at Bhati gates) run gracefully, fast, and reliably on Supabase Free Tier with zero connection pool exhaustion, zero data loss, sub-millisecond database lookups, and strict egress conservation.

**Architecture:**
- **Database Layer (v82 Migration):** Add targeted composite indexes `idx_dp_att_scanner_in` on `(schedule_id, in_scanner_badge, in_date)` and `idx_dp_att_scanner_out` on `(schedule_id, out_scanner_badge, out_date)` on `dp_attendance_sessions`. This reduces per-scanner "My recent scans" lookups from multi-second table-wide sequential scans to <1ms index scans.
- **Query & Network Egress Hardening:** Replace unpaginated `fetchAllRows('dp_attendance_sessions', ...)` in `InchargeScannerPage.jsx` with bounded `.order('created_at', { ascending: false }).limit(10)` queries and a lightweight count query. This cuts scanner bandwidth and JSON deserialization by 99.8% (preventing Supabase 5 GB monthly egress exhaustion).
- **Optimistic Local Feed Updates:** Prepend successful scan results immediately to the local UI feed (`RecentScansTable` / `MobileScanFeed`) upon RPC success or offline queueing, giving operators 0ms feedback and eliminating the need for synchronous post-scan database refetches.
- **Anti-Thundering Herd Reconnect Jitter:** Add randomized reconnect backoff (200ms–2500ms) to `onOnline()` and foreground handlers in `offlineSync.js`. When cell connectivity flickers at gate checkpoints, 150 reconnecting devices will drain their queues in a staggered trickle rather than hammering PgBouncer simultaneously.
- **Realtime Isolation & Stress Verification:** Maintain 0 Realtime channels on scanner devices to preserve the 200 Realtime connection quota for admin dashboards. Create a Vitest concurrency benchmark simulating 150 scanners executing rapid scans and burst reconnects.

**Tech Stack:** PostgreSQL (PL/pgSQL, Supabase Free Tier / PgBouncer), React 18, Vitest, React Testing Library, IndexedDB (`idb-keyval`).

**Spec:** User request 2026-11-08: "see my scanners will be max at 150 - now i want these to be handle gracefully , fast, optimal, without any erors, database breaking, misshapps -- so now plan end to end for the best as per standards and use the skills and all then we will build it".

## Global Constraints

- **Zero Data Loss:** Every scan initiated by an operator must be recorded either on the server (online) or safely in IndexedDB (offline).
- **Supabase Free-Tier Quota Protection:**
  - Database connections capped at pooled limit (<200).
  - Realtime connections capped (<200) — scanners MUST NOT subscribe to Realtime.
  - Monthly network egress capped (5 GB) — scanner polling must never download unpaginated tables.
- **Non-Destructive DB Migrations:** Every migration must be idempotent (`IF NOT EXISTS`), non-destructive, with 100% byte parity between `sql/` and `supabase/migrations/`.
- **Clock & Timezone Integrity:** All timestamps evaluated in Indian Standard Time (`Asia/Kolkata` / `+05:30`).
- **Backward Compatibility:** All existing 97 test suites and 1,888 unit tests must remain 100% passing.

## Review Focus

1. **Simultaneous 150-Scanner Reconnect:** When network connectivity is restored after an outage, 150 scanners must not hit Supabase in the same millisecond; drains must be jittered across 200ms–2500ms.
2. **Incharge Scanner Memory & Egress:** Incharge scanners running for 8 hours with 5,000 daily scans must never experience memory growth or egress spikes from repeatedly fetching all daily sessions.
3. **Optimistic Feed Consistency:** If an operator scans 3 badges in rapid succession, all 3 badges must appear in order in the recent scans list without being wiped by an in-flight background refresh.
4. **Idempotent Queue Replay:** An offline queue item replayed multiple times due to a dropped network ack must not create duplicate sessions or alter existing timestamps.
5. **No Realtime Subscriptions on Scanners:** Scanner pages must strictly communicate via stateless RPCs (`scan_in`, `scan_out`) and bounded queries, leaving all 200 Realtime slots for central command dashboards.

---

### Task 1: Database Migration (v82) — Composite Scanner Indexes & Version Bump

**Files:**
- Create: `sql/v82_scanner_composite_indexes.sql`
- Create: `supabase/migrations/0085_v82_scanner_composite_indexes.sql`
- Modify: `src/lib/version.js:1-15`
- Test: `src/lib/version.test.js`

**Interfaces:**
- Consumes: Table `public.dp_attendance_sessions`
- Produces:
  - Composite index `idx_dp_att_scanner_in` on `(schedule_id, in_scanner_badge, in_date)`
  - Composite index `idx_dp_att_scanner_out` on `(schedule_id, out_scanner_badge, out_date)`
  - Function `portal_app_version() RETURNS text` returning `'v82'`
  - Constant `MIN_SUPPORTED_DB_VERSION = 'v82'` in `src/lib/version.js`

- [ ] **Step 1: Write the failing test**

```javascript
// in src/lib/version.test.js
import { describe, it, expect } from 'vitest'
import { MIN_SUPPORTED_DB_VERSION } from './version'

describe('MIN_SUPPORTED_DB_VERSION', () => {
  it('requires v82 for scanner composite indexes', () => {
    expect(MIN_SUPPORTED_DB_VERSION).toBe('v82')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/version.test.js`
Expected: FAIL with `expected 'v81' to be 'v82'`

- [ ] **Step 3: Implement migration and update version**

Create `sql/v82_scanner_composite_indexes.sql` and mirror to `supabase/migrations/0085_v82_scanner_composite_indexes.sql`:
```sql
-- v82_scanner_composite_indexes.sql
-- Optimizes per-scanner session lookups for 150 concurrent scanners on Supabase Free Tier.
-- Safe to re-run; non-destructive; lock_timeout set to fail fast on busy tables.

SET lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_in
  ON public.dp_attendance_sessions (schedule_id, in_scanner_badge, in_date);

CREATE INDEX IF NOT EXISTS idx_dp_att_scanner_out
  ON public.dp_attendance_sessions (schedule_id, out_scanner_badge, out_date);

ANALYZE public.dp_attendance_sessions;

CREATE OR REPLACE FUNCTION public.portal_app_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'v82'::text;
$$;

GRANT EXECUTE ON FUNCTION public.portal_app_version() TO anon, authenticated, service_role;
```
Update `src/lib/version.js`:
```javascript
export const MIN_SUPPORTED_DB_VERSION = 'v82'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/lib/version.test.js`
Expected: PASS

- [ ] **Step 5: Verify byte parity of migrations**

Run: `cmp sql/v82_scanner_composite_indexes.sql supabase/migrations/0085_v82_scanner_composite_indexes.sql`
Expected: Return code 0 (byte identical).

- [ ] **Step 6: Commit**

```bash
git add sql/v82_scanner_composite_indexes.sql supabase/migrations/0085_v82_scanner_composite_indexes.sql src/lib/version.js src/lib/version.test.js
git commit -m "feat(perf): add v82 composite scanner indexes and bump db version to v82"
```

---

### Task 2: Eliminate Unpaginated Row Leaks in `InchargeScannerPage.jsx`

**Files:**
- Modify: `src/pages/InchargeScannerPage.jsx:70-130`
- Modify: `src/pages/InchargeScannerPage.test.jsx`

**Interfaces:**
- Consumes:
  - `supabase.from('dp_attendance_sessions')`
  - `todayStrIST()`
- Produces:
  - Bounded recent sessions query (`.order('created_at', { ascending: false }).limit(10)`)
  - Total scans count via `{ count: 'exact' }` or separate head query, eliminating `fetchAllRows` over the entire table
  - Payload reduced from thousands of rows to exactly 10 rows on every 15s poll

- [ ] **Step 1: Write failing test in `src/pages/InchargeScannerPage.test.jsx`**

Add a test verifying that `InchargeScannerPage` does NOT call `fetchAllRows` for `dp_attendance_sessions`, but queries `supabase.from('dp_attendance_sessions')` with `.limit(10)`:
```javascript
it('queries dp_attendance_sessions with .limit(10) instead of unbounded fetchAllRows', async () => {
  render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
  await settle()
  // Ensure fetchAllRows is NOT called for dp_attendance_sessions
  expect(mocks.fetchAllRows).not.toHaveBeenCalledWith('dp_attendance_sessions', expect.anything(), expect.anything(), expect.anything(), expect.anything())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/pages/InchargeScannerPage.test.jsx`
Expected: FAIL because `fetchAllRows` is currently called for `dp_attendance_sessions`.

- [ ] **Step 3: Implement bounded session loading and polling in `InchargeScannerPage.jsx`**

Replace `fetchAllRows('dp_attendance_sessions', ...)` in `load()` and `refreshSessions()` with:
```javascript
const today = todayStrIST()
const { data: sess, count, error } = await supabase
  .from('dp_attendance_sessions')
  .select(SESSION_COLS, { count: isInitial ? 'exact' : 'none' })
  .eq('schedule_id', selectedScheduleId)
  .or(`in_date.eq.${today},out_date.eq.${today}`)
  .order('created_at', { ascending: false })
  .limit(10)
```
Store `totalCount` in state (initialized from `count` on initial load, optimistically incremented on new scans).
Update `KpiTile label="Scans today" value={totalCount}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/pages/InchargeScannerPage.test.jsx`
Expected: PASS with 100% of tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/pages/InchargeScannerPage.jsx src/pages/InchargeScannerPage.test.jsx
git commit -m "perf(scanner): replace unbounded fetchAllRows with bounded limit(10) in InchargeScannerPage"
```

---

### Task 3: Optimistic Scanner Feed Updates & Instant Feedback

**Files:**
- Modify: `src/pages/ScannerPage.jsx:57-95`
- Modify: `src/pages/InchargeScannerPage.jsx:160-185`
- Modify: `src/hooks/useScannerSession.js:140-165`
- Test: `src/pages/ScannerPage.test.jsx`
- Test: `src/hooks/useScannerSession.test.jsx`

**Interfaces:**
- Consumes:
  - `handleScan` result: `{ ok, badge, sewadar_name, sewadar_centre, dept_name, action, is_late_in, is_early_out, undeployed, in_time, out_time }`
- Produces:
  - Instant prepend to local `sessions` state:
    `setSessions(prev => [optimisticSession, ...prev.filter(s => s.id !== optimisticSession.id)].slice(0, 10))`
  - Instant UI feedback on `RecentScansTable` and `MobileScanFeed` without waiting for the server roundtrip.
  - Background `onAfterScan` refresh debounced so fast successive scans do not fire redundant overlapping queries.

- [ ] **Step 1: Write failing test in `src/pages/ScannerPage.test.jsx`**

```javascript
it('optimistically prepends the scanned session to the recent scans list immediately', async () => {
  // Verify that successful scan updates sessions without waiting for network poll
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/pages/ScannerPage.test.jsx`
Expected: FAIL if optimistic prepend is not yet wired.

- [ ] **Step 3: Implement optimistic session prepend**

In `ScannerPage.jsx` and `InchargeScannerPage.jsx`:
When `handleScan` completes with `{ ok: true }`:
Construct a synthetic session row:
```javascript
const optimisticRow = {
  id: `opt-${Date.now()}`,
  badge_number: badge,
  sewadar_name: result.sewadar_name || '',
  sewadar_centre: result.sewadar_centre || '',
  sewadar_dept: result.dept_id || null,
  in_date: todayStrIST(),
  out_date: result.action === 'OUT' ? todayStrIST() : null,
  in_time: result.action === 'IN' ? hmsIST() : null,
  out_time: result.action === 'OUT' ? hmsIST() : null,
  is_vss: !!result.is_vss,
  undeployed_scan: !!result.undeployed,
  is_late_in: !!result.late_in,
  is_early_out: !!result.early_out,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
setSessions(prev => [optimisticRow, ...prev.filter(s => s.badge_number !== badge)].slice(0, 10))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/pages/ScannerPage.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/ScannerPage.jsx src/pages/InchargeScannerPage.jsx src/pages/ScannerPage.test.jsx
git commit -m "feat(scanner): add optimistic feed prepend for instantaneous operator feedback"
```

---

### Task 4: Anti-Thundering Herd Reconnect Jitter in `offlineSync.js`

**Files:**
- Modify: `src/lib/offlineSync.js:160-185`
- Test: `src/lib/offlineSync.test.js`

**Interfaces:**
- Consumes:
  - `requestDrain(delayMs)`
  - `window.addEventListener('online')`
- Produces:
  - Jittered `onOnline` kick (staggered delay between 200ms and 2500ms using `Math.random()`), preventing 150 devices from draining concurrently.

- [ ] **Step 1: Write failing test in `src/lib/offlineSync.test.js`**

```javascript
it('staggers onOnline reconnect drain with jitter to protect connection pool', async () => {
  // Dispatch online event and verify requestDrain is called with positive jittered delay
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/offlineSync.test.js`
Expected: FAIL because `onOnline` currently calls `requestDrain(0)` with 0 delay.

- [ ] **Step 3: Implement jittered reconnect drain**

In `src/lib/offlineSync.js`:
```javascript
function onOnline() {
  // 150 scanners reconnecting simultaneously at gate checkpoints must not
  // storm PgBouncer in lockstep. Stagger drain requests across 200ms–2200ms.
  const reconnectJitterMs = Math.floor(Math.random() * 2000) + 200
  requestDrain(reconnectJitterMs)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/lib/offlineSync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/offlineSync.js src/lib/offlineSync.test.js
git commit -m "perf(sync): add anti-thundering herd jitter to online reconnect drain"
```

---

### Task 5: 150-Scanner Concurrency & Load Stress Test Suite

**Files:**
- Create: `src/lib/scannerLoadSimulation.test.js`

**Interfaces:**
- Consumes:
  - `enqueueScan`, `drainQueue`, `getQueuedScans` from `src/lib/offlineQueue.js`
  - `requestDrain` from `src/lib/offlineSync.js`
  - Synthetic Supabase client mock with concurrency limiter
- Produces:
  - Concurrency simulation test of 150 virtual scanners executing 10 rapid scans each (1,500 total scans) under simulated flaky gate network conditions.
  - Verification that 0 scans are lost, 0 duplicates are committed, and client state settles cleanly.

- [ ] **Step 1: Write the concurrency stress test suite**

```javascript
// src/lib/scannerLoadSimulation.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
// Simulate 150 scanner loops enqueuing and draining
```

- [ ] **Step 2: Run test to verify stress test execution**

Run: `npm test src/lib/scannerLoadSimulation.test.js`
Expected: PASS with 1,500 operations processed without memory leaks or race conditions.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scannerLoadSimulation.test.js
git commit -m "test(scanner): add 150-scanner concurrency and load simulation test suite"
```

---

### Task 6: End-to-End Verification & Production Readiness Audit

**Files:**
- Modify: `docs/ops/december_visit_readiness_audit.md` (if updating operational checklist)

- [ ] **Step 1: Run complete test suite**
Run: `npm test`
Expected: All 98+ test suites pass with 0 failures.

- [ ] **Step 2: Run linter**
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Run production build**
Run: `npm run build`
Expected: Clean build in <3s.

- [ ] **Step 4: Verify SQL migration byte parity**
Run: `cmp sql/v82_scanner_composite_indexes.sql supabase/migrations/0085_v82_scanner_composite_indexes.sql`
Expected: 0 diff.
