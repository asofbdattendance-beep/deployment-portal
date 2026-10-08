# Deployment Portal — Context (slim)

**Retrieval map — read the relevant file BEFORE working in that area:**
- Pages/components/lib inventory, per-page behaviour → `docs/context/frontend.md`
- UI conventions, mobile tiers/PWA, print/PDF, nav, exports → `docs/context/ui-conventions.md`
- Full DB schema, columns, helpers, triggers detail → `docs/context/schema.md`
- CI/tests/env/deploy detail → `docs/context/tooling.md`
- DB migration history (v1–v66, rationale, run-order) → `docs/context/migrations.md`

## Roles & Permissions

| Role | Scope | Can do |
|---|---|---|
| `centre_user` | centre subtree (own + SC_SPs) | "Consent & Deploy": consent Yes/No, days (read-only), stay/chair, department — autosave + Save Draft |
| `centre_admin` | centre subtree | identical editing power to centre_user |
| `aso` | all centres | **read-only everywhere (v20)** — all tabs + Excel exports, zero writes |
| `vss_operator` | all centres | undeployed requested-department deploys + VSS create/assign past lock/deadline/switch (v37: VSS rows fail-closed to effective VSS switch; regular rows keep bypass); may deploy consent-No VSS; never final `deployed_department_id`, Finalize, Control Panel, Schedule, overrides, users, audit |
| `super_admin` | all centres | sole writer: schedules, departments + restriction rules, allocations, finalize, Control Panel. UI label **"ASO"** — "Super Admin" never appears in UI |

## Days
No dates: fixed **WED, THU, FRI, SAT, SUN**; consent = number of days (1–5), not ticks.
**Days are NOT user-editable**: 5 days auto except **OE ESCORTS = 3 fixed** (`daysForDept` in `src/lib/logic.js`; applied on load, forced at save, eligibility judged against post-switch days). DB-enforced (`sql/v10_oe_escorts_fixed_days.sql`): `min_days = vss_min_days = 3` (`trg_guard_oe_escorts_min_days`), consents backfilled to 3, `trg_a_clamp_oe_escorts_days` forces consent=3 on any OE ESCORTS deployment write.

## Flow (no phases, no locks, no go-ahead)
1. super_admin creates a schedule (+ optional deadline).
2. Restriction rules per department: `min_days`, `requires_stay_at_bhati`, `requires_initiated` (from `sewadars.is_initiated`).
3. Allocations: parent CENTRE × department → `max_count`; CENTRE + SC_SPs share quota. Centre locks when every filled dept has an incharge (v13 `check_centre_lock`); aso/super_admin unlock.
4. Consent + deployment together, centre roles, one page: autosave (~800ms debounce) + Save Draft; bulk with confirmation (per-row eligibility/quota, skips listed).
5. **Deadline governs all**: after deadline or `status = done`, editing disabled in UI *and* DB (`block_after_deadline`) — aso/super_admin exempt; NULL deadline blocks nothing; master switches `sewadar_deployment_open`/`vss_deployment_open` also block.
6. aso/super_admin set final `deployments.deployed_department_id` on the Finalize tab (flat table, grouped CENTRE→SC_SP→name); consent read-only until *Enable editing* (super_admin only, v20).
7. **Control Panel (v21, super_admin)**: open ALL/one CENTRE (subtree), unlock one dept, VSS tri-state Auto/Open/Closed, allocate extra depts. Override beats centre lock, master switches, deadline — **never quotas, rules, `done`, or ASO-finalized rows (v15/v16)**; under open override consent-No rows may deploy (no final dept).

## Rules enforced
- One department per sewadar (`requested_dept`); eligibility = days ≥ `min_days` + `requires_stay_at_bhati` + `requires_initiated`.
- Quota: total across parent subtree ≤ `max_count` (UI bars + `check_deployment` + batch `check_deployment_batch`).
- Elderly (`sewadars.badge_status = 'ELDERLY'`) excluded from UI, blocked by trigger.
- Prev-year (`prev_year_deployments`): no row → "Were not deployed in last session"; low attendance (0,1 always; 2 except TRAFFIC OUTSIDE BHATI) highlighted; TRAFFIC OUTSIDE BHATI out of 3, others out of 5.
- **v32 deployed freeze (before any lock/deadline)**: centre-role UPDATE/DELETE on a deployed regular sewadar's `deployments`/`sewadar_consents` row raises (`freeze_deployed_rows()`, `trg_a_freeze_deployed_deploy`/`trg_a_freeze_consent_of_deployed`, `sql/v32_freeze_deployed_sewadars.sql`). Exempt: aso/super_admin; a normal `is_centre_override_open` (row's dept for deployments, `NULL` centre-wide for consents); undeployed-only overrides never bypass; VSS exempt; new INSERTs allowed. UI: read-only `DEPLOYED` pill; ASO-finalized rows show `FINAL` (v15), frozen under any override.
- Parallel sessions safe: baseline rows PATCH only `changedConsentFields` (grouped field-sets, quoted PostgREST `or()`), new rows chunked INSERT, removals batched per centre; realtime peer writes coalesce 600ms, self-echo skipped (`lastWriteAtRef`); pending edits flush on unmount/tab switch/schedule change.
- **Every deployed sewadar gets a consent row**: DB raises "No consent recorded for this sewadar"; persist guarantees existence (INSERT with `ignoreDuplicates: true`, chunked, `consentExistsRef` from the load fetch) before any deployment write; an override relaxes consent=No only, never a missing row.

## Database Tables (full columns in `docs/context/schema.md`)
`deployment_schedules` (open→done, `deadline timestamptz`, unique `lower(name)`) · `deployment_departments` (`min_days`, `requires_*`, `is_active`) · `centre_allocations` (schedule×dept×centre→`max_count`, parents only) · `sewadar_consents` (unique schedule+centre+badge: `consent_given`, `available_days_count`, `stay_at_bhati`, `chair_pass`) · `deployments` (→`department_id` requested, `deployed_department_id` final, `status`) — **row exists ⇒ deployed (v32)** · `prev_year_deployments` (badge PK) · `audit_log` (insert RLS `super_admin` via `get_portal_user_role()`, not raw JWT) · `centre_overrides` (v21: `centre` `*`=ALL or root CENTRE, `department_id` NULL=all) · `centre_vss_overrides` (tri-state NULL=inherit, `get_my_effective_gates`) · existing: `sewadars`, `centres` (`parent_centre` empty=parent), `portal_users`, `department_incharges` (v12).

## Key Rules & Helpers
- Tree/quota: `get_root_centre`, `get_my_subtree_centres`, `get_remaining_quota` (SQL + JS copies in `src/lib/logic.js`).
- **`fetchAllRpc` + `RPC_PAGE_SPECS`** (`src/lib/supabase.js`): every per-badge row RPC must be registered there (paged, count-exact, fail-closed — `db-max-rows` 1000 silently truncates SETOF). Registered: `attendance_sewadar_summary`, `attendance_day_badges`, `previsit_sewadars`, `previsit_deployed`; `previsit_summary` + `attendance_centre_daily` (v74, centre × visit-date, grouped) single-shot.
- Triggers: `check_deployment` (+`_batch`), `block_after_deadline`, `trg_check_incharge`, `check_centre_lock`, SC_SP insert block (v16 M6), v32 freeze, `trg_a_guard_vss_registration` (v37: vss_operator fail-closed on VSS rows).
- Scan identity: `get_scan_state` returns `sewadar` (v65 `sql/v65_scan_identity.sql`); popup stamps `todayStrIST`/`hmsIST`.
- **Offline sync is app-level** (`src/lib/offlineSync.js`, installed once in `main.jsx`): ONE drain loop for the whole portal — it survives page navigation (the old per-scanner-page drainer died on unmount), kicks a drain on boot/enqueue/reconnect/SYNC_QUEUED, and registers the `sewadar-sync` Background Sync tag. Queue mutations broadcast `portal-queue-changed` (`src/lib/offlineQueue.js`); scanner hooks + the global `OfflineSyncStatus` pill subscribe to `{ queued }` snapshots. Dedup/drop removals report progress success; poison rows quarantine with reason.
- **Offline popup identity** (`src/lib/sewadarDirectory.js` + `src/hooks/useDeptNames.js` + `useSewadarDirectory`): per-schedule badge→name/centre/dept snapshot AND the global department id→name map both persist in IndexedDB — an offline reload still names name/centre/Dept in the scan popup on every viewport (directory is fallback-only, live data always wins). Scanner pages seed dept state from cache and write through on live fetch; empty live results never poison the cache.
- **Sewa mode is Bhati-first (cutover supersedes the old fail-to-previsit law).** Previsit is open only while today is strictly before `visit_start − 1 day` (`previsitCutoff`/`isPrevisitAvailable`, `src/lib/sewaMode.js`); from the cutoff day onward — and after `visit_end` — every role renders Bhati Visit and the mode toggle disappears (test logins only ever saw it while previsit was open). One shared register `src/components/SewaView.jsx` (Total/Present/Attention tabs, never Absent) serves both modes — previsit over `previsit_*` RPCs, Bhati Visit over `attendance_day_badges` pairs normalized by `src/lib/sewaView.js`, columns EXACTLY the visit window; the ASO/super_admin Home (`src/pages/DashboardPage.jsx`) carries the centre × day heatmap + visit-day strip + centre × dept matrix over v74 `attendance_centre_daily`. `MIN_SUPPORTED_DB_VERSION` is `v75`.

## Quality tooling
`npm test` (58 files, 1476 passed | 8 skipped) · `test:coverage` per-file gates incl. `src/lib/offlineSync.js` (84/78/71/88) · `lint` · `build`. CI runs mobile e2e, PWA shell, migration parity AND the desktop chromium offline suite (`e2e-desktop`: queue-matrix + scanner-offline + offline-sync + offline-ladder basics→advanced) on every push (`docs/context/tooling.md` has full detail).

## SQL migrations
`ls sql/` numeric order; `sql/` ↔ `supabase/migrations/` byte-identical (CI-enforced); per-version detail in `docs/context/migrations.md`. Non-destructive is the norm; `sql/reset_deployments.sql` is preview-only.

## Env / deploy
`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (anon only) · Vercel · git remote `asofbdattendance-beep/deployment-portal.git`, branch `feature_deployment_portal_02082026`.
