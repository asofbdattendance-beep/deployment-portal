# Attendance E2E Audit — Bug Ledger (L-01…L-56)

> Task 0 output. Scope: browser-mocked backend + local PG stub. No production writes (hard constraint #4).
> Source plan: Attendance E2E Audit 2026-09-28. Prior context: MEM-013 (6 Critical bug-hunt 2026-09-28) reconciled below.
> `harness/registry.json` absent in this checkout — routing fell back to AGENTS.md dispatch doctrine.
> ID caveat: L-01…L-07 are canonical (plan table). L-08…L-56 are band-anchored from 3 parallel explore passes (file:line grounded, IDs positional where plan one-liners were absent). File:line wins over ID if they disagree.

## Assumptions (A1–A4)

- A1: No prod writes. Mock Supabase + local PG stub only.
- A2: Prod DB assumed v48. If parked at v39, L-07/L-13/L-25 fire silently — confirm via `sql/verify_test_logins.sql` + `attendance_daily_summary` non-zero present.
- A3: 7 roles have test logins (`sql/create_test_users_direct.sql`) or role E2E cannot run.
- A4: `.env` points at production — test rig must use mock base URL only.

## MEM-013 reconciliation

Bug-hunt 2026-09-28 found 6 Critical (OUT drain p_nonce mismatch; grouped PATCH first-row-values; dead consent INSERT; offline OUT queued as IN; dead scan_in ladder guard; trend counts undeployed) + 9 Important. These overlap L-08/L-13/scan-ladder/trend rows below and are folded in, not separate. No fixes applied yet.

## Verified claims (verify=yes)

- L-01/L-02 structure SUPPORTED (jev_verify p=0.61): `src/lib/offlineQueue.js:73-96` — `!db → undefined`, full → `null`, `tx.onerror → reject`.
- L-06 SUPPORTED (p=0.55): `src/lib/attendance.js:37-46` — `sessionMinutes(inTime,outTime)` parses HH:MM only, wraps modulo 24h.
- Explore pass 1 grounding verdict UNSUPPORTED (p=0.12) — its rows below are reported with file:line evidence, not asserted as proven.

## Critical + High (must fix before field use)

| ID | Sev | File | Defect | Worst case |
|----|-----|------|--------|------------|
| L-01 | CRITICAL | `src/lib/offlineQueue.js:95` + `src/hooks/useScanHandler.js:305,436,532` | `enqueueScan` rejects on IDB put failure; all 3 call sites sit inside a catch, `handleScan` has only `finally` | Storage full/private mode → silent data loss, no popup/toast |
| L-02 | HIGH | `src/lib/offlineQueue.js:75,85` | Queue-full (`null`) indistinguishable from storage-unavailable (`undefined`) | 201st scan misreports remedy and is dropped |
| L-03 | HIGH | `src/lib/offlineQueue.js:107,158,248` | `owner:null` non-failed rows never drained/listed/clearable, yet count toward cap | One `getSession()` blip → 200 orphans wedge queue, no UI remedy |
| L-04 | HIGH | `src/lib/offlineQueue.js:294-301` | 5 permanent errors (incl. Not authorized, future timestamp) fall into network branch → markFailed+backoff+break | Suspended scanner → head-of-line block ~12 min, rows behind stuck |
| L-05 | HIGH | `src/hooks/useScanHandler.js:396` + forgot-prefill both pages | Forgot-OUT prefill uses device-local `getHours()`, parsed as +05:30 | Non-IST device → OUT off by UTC offset |
| L-06 | HIGH | `src/pages/AttendancePage.jsx:68` + `src/lib/attendance.js:45` | `sessionMinutes` takes only time halves, dates discarded | Wed 09:00→Sun 16:00 reads "7h 0m" on screen + Excel |
| L-07 | HIGH | all attendance pages | No frontend↔DB version handshake; shapes defaulted | v39-parked DB fires L-07/L-13/L-25 silently |

## Scan ladder / offline queue (Medium unless noted)

| ID | File | Defect | Worst case |
|----|------|--------|------------|
| L-08 | `src/hooks/useScanHandler.js:352` + `src/lib/offlineQueue.js:283` | C4 heuristic enqueues recovery OUT with `open_id:null` → drain resolves "whatever exists" at replay | Local IN drained terminally lets unanchored OUT close another operator's session |
| L-09 | `src/hooks/useScanHandler.js` + pages | No offline toggle guard from last local queue event; double-tap <2s offline dupes | Two queued rows for one tap; lens-held badge unbounded INs |
| L-10 | `sql/v45_attendance_reports.sql:679-685` | Absent branch omits `v_depts` predicate (`:648` has it) | dept_incharge absent list over-reports for narrowest scope |
| L-11 | `sql/v45_attendance_reports.sql:687` vs `:657` | Absent `is_vss` from `ILIKE 'VS%'`, present from `bool_or(s.is_vss)` | Present/Absent workbooks disagree on same badge |
| L-13 | `src/lib/offlineQueue.test.js` (whole file) | Zero coverage for MAX_QUEUE_SIZE, backoff/break, quarantine/bad-timestamp, listeners, CACHE_TTL | L-02/L-03/L-04 regress green |
| L-19 | `src/hooks/useScanHandler.js:44-53` + `src/lib/scannerUtils.js:97-108` / `BarcodeScanner.jsx:895,927` | `withTimeout` aborts controller whose signal never reaches request; refs read in render, hint never clears | Timed-out `scan_in` still lands → dead-end Already IN; stale hint |
| L-36 | `src/pages/ScannerPage.jsx:164-176` + `DeptInchargePage.jsx:219-231` | Forgot-OUT is direct RPC with toast-only catch — only scan path with no `enqueueScan` fallback | Flaky-link forgot-OUT lost, session stays open |
| L-37 | `src/lib/offlineQueue.js:311-313,317-336` + `useScanHandler.js:400,511` | `navigator.locks` queues waiters while every tab re-arms ~7s drain; `outTimeDefault` regex-only, no range/future bound | Drain storm on release; future/pre-IN OUT credits phantom presence day (v45) |

## Scanner UI / camera / pages

| ID | File | Defect | Worst case |
|----|------|--------|------------|
| L-12 | `ScanResultPopup.jsx:237,468-486` | `primaryLabel`/`secondaryLabel` both "Done" for all non-decision statuses | Two identical buttons, AT announces dupes |
| L-14 | `BarcodeScanner.jsx:120-246` | `fallback()` can land on never-initialised engine; pool oscillates 0→1→0 per frame | Re-render storm; iOS 3-strike breaker never trips |
| L-15 | `BarcodeScanner.jsx:206` vs `376-384` | 2% edge-reject dead on ZXing path (`cornerPoints:[]`) | Browser-dependent accept/reject at frame edge |
| L-16 | `BarcodeScanner.jsx:854,914-917` vs `scannerUtils.js:228-246` | Guide box (margin 24) ≠ ROI (92%×62% band); `cover` crops frame | Operator aims at box decoder never reads |
| L-17 | `BarcodeScanner.jsx:853` | Tap-to-focus bare `<video onClick>`, no role/label/tabIndex/keyboard | Keyboard/SR unreachable |
| L-18 | `BarcodeScanner.jsx:887-892` | Torch label flips to bare "ON", icon not aria-hidden | AT "ON pressed" with no subject |
| L-20 | `BarcodeScanner.jsx:650-656` | `teardown()` skips `lastScanRef` (2s suppressor) + `lastRawRef` | Post-Retry first scan silently dropped 2s |
| L-21 | `BarcodeScanner.jsx:202,260` | Fresh `Uint8ClampedArray` per frame, no scratch reuse | GC churn stalls decode on low-end phones |
| L-22 | `BarcodeScanner.jsx:482-486,751,834` | Watchdog kills loop without `scheduleNext()`; recovery depends on commit ordering | Retry permanently dead if `videoRef` null |
| L-23 | TEST-GAP | `ScannerPage`/`DeptInchargePage` have no test file — 8 page bugs live untested | Suite green while pages regress |
| L-39 | `ScanResultPopup.jsx:387` via `useScanHandler.js:504-511` | Unconditional ">12h open" pill; Already-IN refetch path has no `hrs>12` gate | 2-min session labelled >12h, wrong destructive action |
| L-41 | `ScannerPage.jsx:43` vs `DeptInchargePage.jsx:56,164` | Scanner filters `in_date=today` only; Incharge uses v45 event-date `or()` | Overnight sessions omitted; pages disagree with Daily tab |
| L-42 | `ScannerPage.jsx:90` (polls) vs DeptIncharge (never) | Incharge refreshes only on mount/after-scan | Stale Present/Absent all day |
| L-43 | `DeptInchargePage.jsx:36,166` vs `ScannerPage.jsx:50` | `setOffline(true)` with no `setOffline(false)` on Incharge | Amber warning pinned all session |
| L-44 | Both pages `setSyncing` never called | `syncing` permanently false; spinning branch dead | Draining queue shows static WifiOff |
| L-46 | `ScannerPage.jsx:133-139` + `DeptInchargePage.jsx:188-194` | "Camera paused" comment pauses nothing — scan dropped + toast, preview live | Toast storm over modal; v44 claim not implemented |
| L-47 | `ScannerPage.jsx:175` + `DeptInchargePage.jsx:230` | Forgot follow-up `setTimeout(200ms)` never stored/cancelled | Unmount in window still writes IN, setState on unmounted |
| L-48 | `ScannerPage.jsx:96-98` + `DeptInchargePage.jsx:146-148` | `queued`/`offline` never auto-dismiss, excluded from `isDecisionPopup` | Offline confirm replaced by next scan; modal hangs |

## Attendance reporting / exports / realtime

| ID | File | Defect | Worst case |
|----|------|--------|------------|
| L-24 | `AttendancePage.jsx:317` + `LiveScannersPage.jsx:320` | Filename without `fileSlug`; pages never import `excel.js` | `Oct 2026: Visit/1` → illegal Windows filename, export throws |
| L-25 | `AttendancePage.jsx:33` + `LiveScannersPage.jsx:20` vs `excel.js:22` | Local `sheetName` triplicates regex, lacks `String()??''` + `'Sheet'` fallback | `raw.replace` throws mid-export |
| L-26 | `ReportsPage.jsx:452-482` (comment `:436-438` inverted) | Summary sheet unfiltered `dailyRaw`, list sheet filtered — one file two populations | Centre-filtered download mismatches TOTAL, trust damage |
| L-27 | `ReportsPage.jsx` exports | Not all exports via `excel.js`; names uncoerced | Same as L-24/25 on remaining sheets |
| L-28 | `excel.js` + pages | Export filter-honouring inconsistent | Filtered view → unfiltered workbook |
| L-29 | `ReportsPage.jsx` | Summary vs list population split (see L-26) | Reconciliation hour lost |
| L-30 | `ReportsPage.jsx` | Summary label does not state unfiltered scope | Operator cannot tell file self-contradictory |
| L-31 | `sql/v45:419-456` | `attendance_scanner_open` has no centre/dept scope, only caller-badge arm | dept_incharge+scanner reads OPEN outside own depts |
| L-32 | `attendance.js` rate | Missing clamp (see L-51 `pct()` vs `attendanceRate`) | >100% cells |
| L-33 | `attendance.js` + pages | Centre/dept/search filter plumbing gaps | Counts disagree across tabs |
| L-34 | 4 attendance pages | Subscribe `dp_attendance_sessions` only, never `deployments` | Finalize → numbers stale |
| L-35 | `attendance.js:499-507` vs `:602-611` | `addCounts` (present/absent) vs `buildVisitRows` (everPresent/neverPresent) vocab mismatch | Future caller gets all-zero matrix silently (latent) |
| L-38 | `ReportsPage.jsx:180-192` | `fetchCentres().catch(()=>[])` never rejects → failed list omits it | Centres failure collapses tree flat, parent filter drops children silently |
| L-40 | 5 pages subscribe with no status handler; `supabase_realtime` membership commented (`v28:1156-1160`) | Zero events, zero errors if table not published | 3-hour-old dashboard trusted |
| L-45 | `AttendancePage.jsx:228,249,324,347,364,455` | Header `stats` from `allSewadars`, tables/exports from filtered | "Scanned 412" over 40-row table |
| L-49 | `sql/v45:101-126` | Presence groups by scan-snapshot dept, agg by effective dept; NULL join arm dead | Pre-deployment scan → 100% absent always |
| L-50 | `sql/v45:314-332` | `ever_present` by session centre+snapshot, `deployed` by home centre+effective — join on both | `present 1/deployed 0`, never-present miscount |
| L-51 | `ReportsPage.jsx:61-66,602-608` | `pct()` no 100-clamp, `rateBand≥100→full` | `1/0 150%` green FULL pill |
| L-52 | `sql/v39:394` | `attendance_scanner_ops` IN-only, never updated to v45 event-date law | Daily present vs Ops `Scans In: 0` contradict |
| L-53 | `sql/v39:390-391` | `scans_out`/`last_scan_time` matched by `in_date`, OUT on N+1 counted on N | Last Scan wrong by a day |
| L-54 | `attendance.js:664-668` | `scannerStatus` rebuilds stamp on queried date, breaks on L-53 | Scanner Active 24h after leaving |
| L-55 | `sql/v45:594-595` | Global `LIMIT 1000 ORDER BY 1` (rule name) | BAD_STATUS fills all slots, 4 rules vanish |
| L-56 | `sql/v45:518-527,566-578` + `attendance.js:647` | UNDEPLOYED/STALE per-session, BAD_STATUS per-badge; counts raw rows | 1 person 6 scans = 6 anomalies |

## T2 rig (tasks 15–16) — BUILT 2026-09-29, matrix pending

Run: `npm run test:e2e` (chromium, headless). Config `playwright.config.js`:
mock on :54321 (`tests/e2e/mock-supabase.mjs`), app on `https://localhost:5173`
(TLS — repo serves certs/, so baseURL is https + ignoreHTTPSErrors), env
override points supabase-js at the mock. Single worker (mock state shared).

- Mock: in-memory auth (`/auth/v1/token` any credentials, `/auth/v1/user`),
  canned REST tables (schedules, empty deployments/sessions, one MEDICAL
  dept), RPCs (`get_portal_profile` scanner, `get_scan_state` null,
  `scan_in/out` ok with v43 display fields). CORS echoes preflighted
  headers (supabase-js sends `x-supabase-api-version` — a static list
  rotted on first contact). Realtime upgrade destroyed (client retries
  quietly; no spec depends on delivery). `POST /__test/reset|seed`,
  `GET /__test/calls` (seed supports error/hang/object per RPC).
- Specs (`tests/e2e/scanner-offline.spec.js`): UI login → scanner boot
  with live RPC path; offline manual scan → 'Queued offline' + real IDB
  row (`sewadar_offline_q`/`scan_queue`); reconnect → drain replays with
  `p_nonce` = queue id; row removed. Every spec asserts zero pageerrors
  and zero lost rows.
- Side proof: the L-07 banner fires against the mock (no
  `portal_app_version` → "Couldn't confirm") — the handshake behaves.
- Matrix (`tests/e2e/queue-matrix.spec.js`, 12 rows — the ledger's "20"
  was aspirational; this is the encodable set, the rest stays unit-owned):
  M1 full-queue distinct popup + cap intact (L-02); M2 3-tap IN→OUT→dupe
  (L-09, incl. the C4 reality that tap 2 queues OUT, not a dupe); M3/M4
  forgot-OUT offline queue + drain with open_id/ts (L-36); M5 poison
  quarantines with reason while neighbours drain (L-04); M6 bad-timestamp
  quarantine (L-04); M7 stale open_id drops, drain continues (L-08); M8
  manual flag end to end; M9 clear-failed-scans; M10 reload persistence;
  M11 connectivity pill; M12 Already-IN replay dedupes (L-04).
  E2E lesson recorded: offline tap 2 is C4-OUT by design; the busy flag
  (not the dupe guard) swallows taps landing mid-flow — matrix timing
  accounts for both.
- Limitation: mocked RPC ≠ real RLS — RLS proven separately on PG 15
  stub + `verify_test_logins.sql`. Camera absent headless (manual-entry
  path only; Enter key == button path).

## Verification (task 0 gate)

- [x] `docs/attendance-audit/ledger.md` exists, IDs L-01…L-56 present.
- [ ] `npm test` (643 + new) green — after remediation.
- [ ] `npx playwright test` against mock — matrix Expected column matches, zero unhandled rejections, zero rows lost.

## Next

Task 1 (err-taxonomy) is unblocked. Tasks 15–16 need your OK for `@playwright/test` + injectable drain/timeout seam (risk #2). L-07/L-13/L-25 need a v39-parked DB to prove red.

## Corrections (Phase B task 1, verified against source 2026-09-29)

- Every `src/components/BarcodeScanner.jsx` path in this ledger is wrong: the file lives at `src/components/scanner/BarcodeScanner.jsx` (940 lines). The engine pool has since moved to `src/components/scanner/enginePool.js`.
- L-14 "iOS 3-strike breaker": no such breaker exists in source — dropped from scope. The real defect was fallback onto the never-loaded engine (fixed: `armFallback` + ready-only landing).
- L-19 headline ("dead-end Already IN") is already mitigated (`useScanHandler.js` refetch path). Residual: orphaned sessions/lost writes — deferred to its own task.
- L-22 reframed: the watchdog return itself is correct (error screen replaces the UI); the defect was Retry dying at "Video element missing" + the stale watchdog clock re-erroring instantly (both fixed).
- L-35 REFUTED: `addCounts` (daily rows) vs `buildVisitRows` (visit RPC) use deliberately different vocabularies — not a bug.
- L-51 restated: there is no `pct()` helper. `attendanceRate` is clamped; only `buildTrendRows` is unclamped (safe today via v47, undefended against server over-count).
- ROI helper lives at `scannerUtils.js:311-312` (`computeRoi`), not `:228-246`. New: `isEdgeDetection` (edge guard shared by both engines).

## Adjudications (Phase C, verified against source 2026-09-29)

Stale = the defect as stated has no referent in current source (fixed by
an earlier rework, renamed away, or never true). Each carries its evidence
so nobody re-opens it without new facts.

- L-26 STALE: no `wrap(req)` exists anywhere; no visit-list workbook exists;
  both day workbooks (DashboardPage:405-415, ReportsPage:484-493) already
  emit full 6-column tuples for present AND absent.
- L-27 STALE: `listedPresent` exists nowhere; `buildVisitRows`
  (attendance.js:632) emits centre×dept aggregates with no badge field.
- L-28 STALE-AS-CLAIMED: DashboardPage has zero filters (nothing to
  honour); ReportsPage honours centre/dept/search on detail sheets
  (`filterBadges`, ReportsPage:428) with summary-intentionally-full as
  documented design (ReportsPage:436-438). The "year/schedule/qr/dept"
  filter set exists nowhere.
- L-29 STALE: `attendance_day_badges` RETURNS full tuples
  (v45:612-619); both workbooks map names. Fixed pre-ledger.
- L-30 STALE: no `listedPresent` dependency exists; workbooks read the
  RPC rows directly (DashboardPage:407-414).
- L-33 STALE (all three): `filterByCentre` handles UNASSIGNED explicitly
  (attendance.js:458) and subtree matching (463-465); dept+centre compose
  on the same row shape; `searchRows` (438-446) is shared, documented,
  and centre-matching is intended (find a centre's sewadars).
- L-54 CLIENT-CLEAN: `scannerStatus` documents its contract
  (attendance.js:688-689: wall-clock FOR the queried date) and honors it;
  the staleness lived server-side and is fixed by v49 (L-53).
- L-56 STALE: AnomaliesPage labels count rows/records/rules, never
  "sewadars" (AnomaliesPage:340-365); row-grain counting is by design
  (documented on `anomalyCounts`).
- L-38 NO-REFERENT for attendance: no attendance/reports surface calls
  `fetchCentres` (only VSS/consent components do); centres here resolve
  server-side. Out of Phase C scope.
- L-10 SCOPE NOTE: the missing dept gate was `attendance_day_badges'`
  absent-mode present-subtraction ONLY — `daily_summary` always had it
  (v45:112). Fixed where it was missing (v49 §3).
- L-49 SPANS TWO FUNCTIONS: the snapshot-vs-effective mismatch lived in
  `attendance_daily_summary` (v45:101-113) AND `attendance_visit_summary`
  (v45:301-319). v49 §1-2 fixes both via `badge_eff`.
- L-07 CLOSED by v50 (`portal_version` + `portal_app_version()`) and the
  client handshake (`src/lib/version.js` + `DbVersionBanner`, App shell).
