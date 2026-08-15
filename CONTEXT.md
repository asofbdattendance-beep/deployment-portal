# Deployment Portal — Context

## Roles & Permissions

| Role | Scope | What they can do |
|---|---|---|
| `centre_user` | Their centre subtree (own + SC_SPs) | On the single combined "Consent & Deploy" page: mark consent (Yes/No), days (1–5), stay-at-bhati, chair pass, and the deployment department — all together, auto-saved (+ Save Draft button) |
| `centre_admin` | Their centre subtree | Same as centre_user (editing power is identical in this design) |
| `aso` | All centres | Read-only dashboard + read-only deployment overview |
| `super_admin` | All centres | Creates schedules (with deadline), manages departments (+restriction rules), allocates departments to parent centres, marks schedules done; everything |

## Days

No dates. Every schedule spans the fixed 5 days: **WED, THU, FRI, SAT, SUN**. Consent records a sewadar's available **number of days** (1–5), not specific day ticks.

## Flow (redesigned — no phases, no locks, no go-ahead)

1. **Super Admin** creates a schedule (a named visit, e.g. "October 2026 Visit"). A `deadline` (date + time) may be set per schedule.
2. **Super Admin** manages departments and sets **restriction rules** per department:
   - `min_days` — minimum number of consent days (1–5) a sewadar must be available on
   - `requires_stay_at_bhati` — department needs stay-at-bhati sewadars
   - `requires_initiated` — department needs initiated sewadars (from `sewadars.is_initiated`)
3. **Super Admin** allocates departments to **CENTREs** (centres with empty `parent_centre`): pick a department, enter a `max_count` per CENTRE, save all at once. CENTRE + SC_SPs share that quota. (UI terminology: parent centre → **CENTRE**, child centre → **SC_SPs**.)
   - **Centres can lock deployment** once final: every allocated department with deployed sewadars must first have an **incharge** (set via the quota-card picker), then the centre clicks **Lock Deployment** — consent/deployment/incharges (regular + VSS) freeze for that CENTRE until an aso/super_admin unlocks it (Consent Dashboard strip). DB-enforced (v13).
4. **Consent + deployment happen together** on one page (`centre_user`/`centre_admin`): each centre manages sewadars for its **whole subtree** (own centre + SC_SPs), per sewadar setting:
   - Consent for deployment (Yes/No)
   - No. of days available (1–5)
   - Stay at bhati (Yes/No)
   - Chair pass (Yes/No)
   - **Deployment department** (from the superadmin-allocated departments only)
   Everything auto-saves (debounced ~800ms), plus an explicit **Save Draft** button on the VSS and Finalize Deployment tabs that flushes pending edits immediately. Filter + search + sort available. Bulk multi-select actions with confirmation: set consent, days, stay-at-bhati, chair pass, and assign-to-department (per-row eligibility/quota checks, skips listed with reasons).
5. **The deadline governs everything** — after the deadline (or when status = `done`), all editing is disabled in the UI **and** enforced by DB triggers. No centre locks, no superadmin go-ahead. **Exception:** ASO / super_admin may keep editing (final deployed department + optional consent fixes) after the deadline — they are exempted inside `block_after_deadline` / `check_deployment`.
6. **ASO / super_admin finalize deployment** on the extra **Finalize Deployment** tab: they see every sewadar's consent + requested department and set the **deployed (final) department** — all in a **single flat table** (centre shown per row, filterable) rather than centre-wise collapsible sections. Consent inputs are shown read-only and only become editable when *Enable editing* is ticked (explicit, never automatic).

## Rules enforced

- One department per sewadar (requested_dept).
- Sewadar must be eligible: consent days >= dept `min_days`, satisfies `requires_stay_at_bhati`, `requires_initiated`.
- Total assigned across the parent subtree must not exceed `max_count` (enforced in UI quota bars + DB trigger).
- Elderly sewadars (`sewadars.badge_status = 'ELDERLY'`) are excluded from the UI lists and blocked by the DB trigger.
- A sewadar with no prev-year row shows "Were not deployed in last session". Low prev attendance (0,1 always; 2 except TRAFFIC OUTSIDE BHATI) is highlighted; TRAFFIC OUTSIDE BHATI attendance is out of 3, all others out of 5.
- **Available days are NOT user-editable.** Every sewadar (regular + VSS) gets **5 days automatically** for every department, except **OE ESCORTS** which is **fixed at 3 days** — the days column is a read-only pill everywhere (Consent & Deploy, VSS, Finalize Deployment), the value is auto-set whenever the department changes (`daysForDept` in `src/lib/logic.js`), re-applied on load (normalizing legacy rows) and forced at save time, and dropdown/bulk-assign eligibility is judged against the days a row WOULD have after switching — so a row on OE ESCORTS (3 days) can always move to a 5-day department. **DB-enforced too** (`sql/v10_oe_escorts_fixed_days.sql`): OE ESCORTS departments store `min_days = vss_min_days = 3` (enforced on insert/rename by `trg_guard_oe_escorts_min_days`), existing consents for OE ESCORTS rows are backfilled to 3, and a BEFORE trigger (`trg_a_clamp_oe_escorts_days`) forces the consent row to 3 days whenever a deployment is written with an OE ESCORTS requested/final department — so the DB trigger `check_deployment` can never again reject a valid 3-day write.

## Database Tables

### `deployment_schedules`
Named visit. `name`, `status` (`open` → `done`), `deadline timestamptz`, `created_by`. Old `consent_locked`/`deployment_locked`/`consent_open`/`deployment_open` are gone (migrated in `v2_deployment_redesign.sql`). Unique index on `lower(name)`.

### `deployment_departments`
Reference list + restriction rules (`min_days int`, `requires_stay_at_bhati bool`, `requires_initiated bool`, `is_active bool`).

### `centre_allocations`
Super-admin allocation: `(schedule, department, centre)` → `max_count`. Only parent centres.

### `sewadar_consents`
Per-sewadar: `(schedule, centre, badge, consent_given, available_days_count, stay_at_bhati, chair_pass)`. Unique `(schedule_id, centre, badge_number)`.

### `deployments`
Assignments: `(schedule, centre, badge)` → `department_id` (the sewadar's **requested** department), `deployed_department_id` (the **final** department set by ASO/super_admin, nullable), `status` (`requested`). Unique `(schedule_id, centre, badge_number)`.

### `prev_year_deployments`
Reference data from the previous visit, matched by `badge_number` (PK): `prev_department`, `attendance_reported`. Imported from Excel (`sql/prev_year_deployments_data.sql`, 2415 rows).

### `audit_log`
Soft-audit for destructive actions: schedule/`centre_allocation`/department deletes + `REMOVE_ALL`. Insert policy is `super_admin` via `get_portal_user_role()` (NOT the raw JWT `role` claim).

## Existing Tables Used

- `sewadars` — centre scope, badge_number, sewadar_name, is_initiated, badge_status (ELDERLY excluded)
- `centres` — `name`, `parent_centre` (empty = parent centre); used to resolve parent/child subtree for shared quotas
- `portal_users` — auth, centre, role

## Key Rules & Helpers

- `get_root_centre(centre)` — walks `parent_centre` chain to find the parent centre (SQL + JS copy in `src/lib/logic.js`).
- `get_my_subtree_centres()` — centre names under the caller's centre (itself + descendants); used by RLS so CENTREs manage their own + SC_SPs.
- `get_remaining_quota(schedule, department)` — remaining quota for caller's root centre counting the whole subtree (security definer).
- Deployment inserts/updates validated by trigger `check_deployment` (schedule open, deadline not passed, consent exists + given, not elderly, eligibility, quota). Multi-row inserts additionally guarded by statement-level `check_deployment_batch` (quota bypass protection).
- Consent/deployment edits blocked by `block_after_deadline` trigger once the schedule deadline has passed, status is `done`, or the relevant master switch (`sewadar_deployment_open` / `vss_deployment_open`) is closed. A NULL deadline does NOT block (deadline optional). Centre roles cannot set `deployments.deployed_department_id` — only aso/super_admin can (v9).

## Frontend structure

- `src/pages/ConsentPage.jsx` — combined Consent & Deploy table for centre roles (debounced auto-save, quota bars with a **department incharge picker** — one incharge per CENTRE × department, chosen from sewadars assigned to that department, saved via `department_incharges` (v12), bulk actions, prev-year columns, custom dept dropdown). Only *changed* rows are upserted per save (signature diffing), removals are batched per centre, and pending edits are flushed on unmount / tab switch / schedule change instead of being dropped. **Rows the ASO has finalized** (Finalize Deployment) are loaded with a `finalized` flag and locked: consent/dept/bhati/chair controls are disabled (with a `FINAL` pill), bulk actions skip them, and `toRemove` never deletes them (DB backstop: v15).
- `src/components/ConsentDashboard.jsx` — read-only superadmin/ASO dashboard (CENTRE consent + department matrices, **Export Excel** — `xlsx` is lazy-imported, realtime refresh); balanced page header (title/sub + master switch + schedule select + export in a left column, countdown timer right).
- `src/pages/DeploymentPage.jsx` — read-only overview for superadmin/ASO, rolls child-centre requests up to their root centre and compares against allocations (realtime refresh).
- `src/pages/DeploymentAllocationPage.jsx` — ASO/super_admin **Finalize Deployment** page: every sewadar's consent + **Deployment** request with a **Finalized Deployment** dropdown (from `deployments.deployed_department_id`); a single flat table (centre column per row, centre filter) instead of centre-wise accordions — rows are **grouped by centre hierarchy** (CENTREs A–Z, then each CENTRE's SC_SPs A–Z via `getRootCentre`, then name within centre); balanced page header (title/sub/actions left column, countdown timer right); edits locked until *Enable editing* is ticked; auto-save with unmount-flush + **Save Draft** button; **Export Excel** (lazy `xlsx`).
- `src/pages/ScheduleMakerPage.jsx` — schedules + deadline, departments/rules, allocations panel, requested-deployment summary.
- `src/components/DeptDropdown.jsx` — custom fixed-position dropdown listing **only departments with an allocated quota (`max_count > 0`)**; zero-quota / unallocated departments are hidden entirely, with per-option eligibility reasons shown inline.
- `src/components/DeadlinePill.jsx` — box-style live countdown: four boxes (Days / Hours / Minutes / Seconds) with zero-padded red numbers and a green check badge (`small` variant for schedule rows); a red "Deadline passed" pill once elapsed; plain date when `showCountdown` is false. The <1-day amber warning is the self-contained `DeadlineWarning` component (reuses the same boxes) so pages don't re-render every second.
- `src/components/ErrorBoundary.jsx` — app-wide render-error boundary (friendly fallback, reload), wired in `main.jsx`.
- `src/lib/logic.js` — pure domain logic (quota math, eligibility, elderly filter, tree helpers, attendance, consent-row signature diffing for dirty-only saves) shared with tests.
- `src/lib/logic.test.js` — Vitest unit tests (85, **100% statement/branch/function/line coverage** of `logic.js`). Run with `npm test`.
- `src/App.jsx` — dedicated sticky tab navbar: **Schedule** (aso/super_admin), **Consent & Deploy** (all roles), **VSS** (all roles), **Finalize Deployment** (aso/super_admin), **Overview** (aso/super_admin). Pages are `React.lazy` code-split; a profile-load failure shows a friendly retry screen instead of cryptic access-denied.
- `src/pages/LoginPage.jsx` — login + **forgot-password** (Supabase `resetPasswordForEmail`) flow.
- `src/pages/ResetPasswordPage.jsx` — new-password screen shown when the user arrives via the recovery link (`PASSWORD_RECOVERY` session, tracked via a `portal_recovery_pending` sessionStorage flag in `PortalAuthContext`); calls `updateUser({ password })` then re-signs-in to normalize the session.

## Quality tooling

- `npm test` — Vitest unit tests (`src/lib/logic.test.js`).
- `npm run test:coverage` — Vitest + v8 coverage on `src/lib/logic.js` (thresholds: ≥95% stmts, ≥90% branch, ≥95% funcs/lines — currently 100% everywhere).
- `npm run lint` — ESLint (flat config `eslint.config.js`; react-hooks + react-refresh rules; `coverage/` and `dist/` ignored).
- `npm run build` — Vite production build (code-split; `xlsx` loads on demand).
- `.github/workflows/ci.yml` — GitHub Actions runs lint + tests + coverage + build on every push/PR.

## SQL migrations (run in order in Supabase)

1. `sql/portal_setup.sql` — base tables, RLS, helpers. Schedules/deployments use the **final (v2+) shapes** so a fresh install is correct from the start.
2. `sql/v2_deployment_redesign.sql` — deadline design, restriction rules, `chair_pass`, `prev_year_deployments`, triggers, RLS. **Non-destructive; safe to re-run** — also repairs DBs created from an older `portal_setup.sql` (adds `name`/`status`/`department_id` columns, swaps the old status CHECK).
3. `sql/v3_data_safety.sql` — unique schedule-name index + `audit_log` table (with correct super_admin insert policy).
4. `sql/v4_vss.sql`, `sql/v5_vss_creation.sql`, `sql/v6_vss_roster.sql` — VSS tables, registration, rosters.
5. `sql/v7_consent_matrix_rpc.sql` — consent-matrix RPC for the dashboard.
6. `sql/v8_deployed_department.sql` — `deployments.deployed_department_id` (final dept set by ASO/super_admin late), admin exemption in `block_after_deadline`/`check_deployment`, RLS for aso/super_admin write. **Non-destructive; safe to re-run.**
7. `sql/v9_production_hardening.sql` — **restores** the master-switch + full VSS eligibility checks in `block_after_deadline`/`check_deployment` (regression from v8, which dropped them), blocks centre roles from writing `deployed_department_id`, scopes `vss_sewadars` reads to the caller's subtree (PII), prevents centre roles from modifying `assigned` registrations, restricts `vss-photos` storage to `reg/` + owner/admin, adds a `sewadars` read policy, indexes `deployments(schedule_id, department_id)`, unique-Aadhar index (created only if no dupes), and an `updated_at` trigger on `portal_users`. **Non-destructive; safe to re-run.**
8. `sql/v10_oe_escorts_fixed_days.sql` — **fixes the OE ESCORTS rule mismatch**: sets `min_days`/`vss_min_days = 3` for every OE ESCORTS department (they previously kept the v2 default of 5, so `check_deployment` rejected the app-enforced 3-day writes with *"must have at least 5 consent days"*), backfills existing consents for OE ESCORTS requested/final rows to 3 days, adds a guard trigger on `deployment_departments` (`trg_guard_oe_escorts_min_days`) forcing 3 days for any OE ESCORTS dept created/renamed later, and a BEFORE trigger on `deployments` (`trg_a_clamp_oe_escorts_days`, named to run before `trg_check_deployment`) that forces the matching consent to 3 days at write time. **Non-destructive; safe to re-run.**
9. `sql/v11_schema_consistency.sql` — **repairs a drifted production schema** (where `sewadar_consents` / `deployments` / `centre_allocations` pre-existed, so v2's `CREATE TABLE IF NOT EXISTS` silently skipped the inline UNIQUE constraints and CASCADE FKs): adds the missing `UNIQUE (schedule_id, centre, badge_number)` (and `(schedule_id, department_id, centre)`) constraints that the app's `onConflict` upserts require — deduping first (oldest row per key) and **skipping if a unique index on the exact columns already exists** (a second one would break `ON CONFLICT` inference) — rebuilds the six schedule/dept FKs with the intended `ON DELETE CASCADE` / `SET NULL` actions (single-DELETE schedule/dept cleanup relies on these), and adds the missing supporting indexes. **Non-destructive; safe to re-run.** Verification queries at the bottom of the file.
10. `sql/v12_department_incharges.sql` — **department incharges**: each CENTRE nominates **one incharge per allocated department** (`department_incharges` table, `UNIQUE (schedule_id, centre, department_id)`). Centre roles pick from sewadars of their subtree who consented AND were assigned (requested) to that department — enforced by a guard trigger (`trg_check_incharge`); the incharge must be a consented sewadar deployed to that department and the schedule must still be open. RLS: read for aso/super_admin + same-CENTRE users, write for centre roles on their own CENTRE's departments. **Non-destructive; safe to re-run.**
11. `sql/v13_centre_deployment_lock.sql` — **centre deployment lock**: a CENTRE can **lock deployment** on the Consent & Deploy page — locking is **compulsorily blocked until every allocated department that has deployed regular sewadars has an incharge** (DB-enforced by `trg_check_centre_lock`; the UI lists exactly which departments are missing). While locked, centre-role writes to `sewadar_consents` / `deployments` / `department_incharges` are rejected (regular **and** VSS) by `is_centre_locked` checks added to `block_after_deadline`, `check_deployment`, `check_deployment_batch` and `check_department_incharge`. Only **aso/super_admin can unlock** (DELETE via the Consent Dashboard's "Locked deployments" strip). **Non-destructive; safe to re-run.**
12. `sql/v14_aso_finalize_insert_delete.sql` — **ASO/super_admin full deployment lifecycle on Finalize Deployment**: v8 widened `deploy_v2_update` + `consent_write` for `aso`, but the v2-era `deploy_v2_insert`/`deploy_v2_delete` policies still excluded `aso`, so finalizers could not **assign an awaiting sewadar** (consented, no deployment row yet — needs an INSERT) or **remove a deployment when consent flips to No** (needs a DELETE). This migration widens both policies to `aso` + `super_admin` (centre roles unchanged); the v13 centre-lock delete trigger already exempts admins. **Non-destructive; safe to re-run.**
13. `sql/prev_year_deployments_data.sql` — loads 2415 prev-year badge rows (plain INSERT — run ONCE after the tables exist, do not re-run; PK conflicts on a second run).
14. `sql/v15_protect_finalized_deployments.sql` — **protects ASO-finalized deployments**: a BEFORE DELETE trigger (`trg_block_finalized_delete_deploy`) stops centre roles from deleting any deployment row with `deployed_department_id` set — a centre clearing a department request (or flipping consent to No) on a sewadar the ASO already finalized used to DELETE the whole row, silently destroying the ASO's final decision. aso/super_admin are exempt. The centre pages (Consent & Deploy + VSS) now load the finalized flag: those rows are locked (consent/dept/bhati/chair controls disabled, a `FINAL` pill shown, bulk actions skip them) and `toRemove` never deletes them. **Non-destructive; safe to re-run.**
15. `sql/v16_hardening.sql` — **hardening** (from the security/QA review): **H1** drops the surviving v1 RLS policies (`sched_write`/`dept_depts_write` — which still granted `aso` FULL write on schedules/departments since Postgres ORs permissive policies — plus the obsolete v1 `deploy_*` policies) leaving only the v2+ subtree-scoped policies; **H2** drops the unused owner-owned views `vw_my_centre_sewadars` / `vw_all_deployments` (view-owner = bypassrls → any authenticated user could read ALL sewadars/deployments through them); **H3** flips the `vss-photos` bucket to **private** and scopes the storage read policy to owner / aso/super_admin / the registration's centre subtree (photos are PII; the app now stores the bare `reg/...` path and renders via signed URLs — `vssPhotoUrl` in `src/lib/supabase.js`, `VssPhoto` in `AddVssForm`); **H4** re-runs the OE ESCORTS consent backfill with `trg_block_after_deadline` disabled (running the SQL editor yields no portal role, so v10's backfill aborts on any done/past-deadline schedule); **M5** adds DB backstops so centre roles cannot flip consent (or edit/delete the consent row, or re-request a different department) on an ASO-finalized sewadar — `trg_block_finalized_consent` on `sewadar_consents` + `trg_block_finalized_deploy_edit` on `deployments`; **M4** rejects phantom-badge deployments (`trg_require_sewadar_exists` — badge must exist in `sewadars` or `vss_sewadars`); **M6** restricts `centre_locks` INSERT to a root-centre user locking their OWN centre (an SC_SP user could previously lock the whole CENTRE); **G+** repairs `audit_log` policies — production carried a v3-era `audit_log_insert` that checked the raw JWT `role` claim (never matches — Supabase tokens say `authenticated`), so super_admin could never write audit rows; now uses `get_portal_user_role()`, and `audit_log_select` is scoped to aso/super_admin instead of all authenticated users. **Non-destructive; safe to re-run.** Verification queries at the bottom of the file.
16. `sql/v17_rules_audit.sql` — **rules + quota for EVERYONE, plus a per-sewadar audit trail**. Fixes two production bugs: (1) `check_deployment`/`check_deployment_batch` short-circuited for aso/super_admin, so the ASO could assign past a CENTRE's allocated quota (50 → 53 on Finalize Deployment) and out of a department's restriction rules — now admins keep their DESIGNED exemptions (deadline/done/master-switch/centre-lock) but pass the same eligibility + quota gates as centre roles; (2) no record of who changed what on which sewadar — adds `sewadar_audit_log` + SECURITY DEFINER triggers (`trg_audit_deployment`/`trg_audit_consent`/`trg_audit_lock`) logging MAJOR events only (admin deployment writes, anything touching the final deployed department, admin consent fixes, centre lock/unlock — centre-role routine writes are NOT logged). Quota semantics: a sewadar consumes quota from its **effective** department (`COALESCE(deployed_department_id, department_id)`), evaluated per the ROW's centre root via the new `get_dept_quota_remaining(schedule, dept, centre)` helper (not the caller's centre), and multi-row statements are re-checked AFTER the write — `check_deployment_batch` (INSERT, `new_rows` only) and the new `check_deployment_batch_upd` (UPDATE, via `trg_check_deployment_batch_upd`; `OLD TABLE` is only legal on UPDATE/DELETE triggers, so UPDATE got its own function) — raising only on a NET increase past quota (`post > max AND post > pre` from `old_rows`), so a whole chunk can't slip past per-row checks while corrective moves OUT of a legacy over-quota department stay possible. RLS: `sewadar_audit_log` read = aso/super_admin; writes flow through the triggers (function owner bypasses RLS). **Non-destructive; safe to re-run.** Verification queries at the bottom of the file.

**Utility (NOT a migration — do not run by accident):** `sql/reset_deployments.sql` — preview + delete commands to clear the `deployments` table for one schedule or all schedules (covers regular + VSS, which share that table), with optional consent and VSS-registration resets. Every destructive statement is commented out; uncomment only what you intend to run.

## Env / deploy

- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon key only, never service_role). `.env` is gitignored.
- Vercel: set both vars in Project Settings → Environment Variables, then redeploy.
- Git: this repo is separate from `sewadar-attendance`; remote `asofbdattendance-beep/deployment-portal.git`, branch `feature_deployment_portal_02082026`.
