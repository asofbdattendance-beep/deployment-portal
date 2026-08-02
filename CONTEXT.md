# Deployment Portal — Context

## Roles & Permissions

| Role | Scope | What they can do |
|---|---|---|
| `centre_user` | Their centre subtree (own + children) | On the single combined "Consent & Deploy" page: mark consent (Yes/No), days (1–5), stay-at-bhati, chair pass, and the requested deployment department — all together, auto-saved |
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
3. **Super Admin** allocates departments to **parent centres** (centres with empty `parent_centre`): pick a department, enter a `max_count` per parent centre, save all at once. Parent + child centres share that quota.
4. **Consent + deployment happen together** on one page (`centre_user`/`centre_admin`): each centre manages sewadars for its **whole subtree** (own centre + children), per sewadar setting:
   - Consent for deployment (Yes/No)
   - No. of days available (1–5)
   - Stay at bhati (Yes/No)
   - Chair pass (Yes/No)
   - **Requested deployment department** (from the superadmin-allocated departments only)
   Everything auto-saves (debounced ~800ms). Filter + search + sort available. Bulk multi-select actions with confirmation: set consent, days, stay-at-bhati, chair pass, and assign-to-department (per-row eligibility/quota checks, skips listed with reasons).
5. **The deadline governs everything** — after the deadline (or when status = `done`), all editing is disabled in the UI **and** enforced by DB triggers. No centre locks, no superadmin go-ahead.

## Rules enforced

- One department per sewadar (requested_dept).
- Sewadar must be eligible: consent days >= dept `min_days`, satisfies `requires_stay_at_bhati`, `requires_initiated`.
- Total assigned across the parent subtree must not exceed `max_count` (enforced in UI quota bars + DB trigger).
- Elderly sewadars (`sewadars.badge_status = 'ELDERLY'`) are excluded from the UI lists and blocked by the DB trigger.
- A sewadar with no prev-year row shows "Were not deployed in last session". Low prev attendance (0,1 always; 2 except TRAFFIC OUTSIDE BHATI) is highlighted; TRAFFIC OUTSIDE BHATI attendance is out of 3, all others out of 5.

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
Assignments: `(schedule, centre, badge)` → `department_id`, `status` (`requested`). Unique `(schedule_id, centre, badge_number)`.

### `prev_year_deployments`
Reference data from the previous visit, matched by `badge_number` (PK): `prev_department`, `attendance_reported`. Imported from Excel (`sql/prev_year_deployments_data.sql`, 2415 rows).

### `audit_log`
Soft-audit for destructive actions: schedule/`centre_allocation`/department deletes + `REMOVE_ALL`. Insert policy is `super_admin` via `get_portal_user_role()` (NOT the raw JWT `role` claim).

## Existing Tables Used

- `sewadars` — centre scope, badge_number, name, is_initiated, badge_status (ELDERLY excluded)
- `centres` — `name`, `parent_centre` (empty = parent centre); used to resolve parent/child subtree for shared quotas
- `portal_users` — auth, centre, role

## Key Rules & Helpers

- `get_root_centre(centre)` — walks `parent_centre` chain to find the parent centre (SQL + JS copy in `src/lib/logic.js`).
- `get_my_subtree_centres()` — centre names under the caller's centre (itself + descendants); used by RLS so parents manage their own + child centres.
- `get_remaining_quota(schedule, department)` — remaining quota for caller's root centre counting the whole subtree (security definer).
- Deployment inserts/updates validated by trigger `check_deployment` (schedule open, deadline not passed, consent exists + given, not elderly, eligibility, quota). Multi-row inserts additionally guarded by statement-level `check_deployment_batch` (quota bypass protection).
- Consent/deployment edits blocked by `block_after_deadline` trigger once the schedule deadline has passed or status is `done`. A NULL deadline does NOT block (deadline optional).

## Frontend structure

- `src/pages/ConsentPage.jsx` — combined Consent & Deploy table for centre roles (auto-save, quota bars, bulk actions, prev-year columns, custom dept dropdown).
- `src/components/ConsentDashboard.jsx` — read-only superadmin/ASO dashboard (stats, day/centre distribution, prev-year comparison, **Export Excel** via `xlsx`, realtime refresh).
- `src/pages/DeploymentPage.jsx` — read-only overview for superadmin/ASO, rolls child-centre requests up to their root centre and compares against allocations (realtime refresh).
- `src/pages/ScheduleMakerPage.jsx` — schedules + deadline, departments/rules, allocations panel, requested-deployment summary.
- `src/components/DeptDropdown.jsx` — custom fixed-position dropdown listing allocated depts with per-option eligibility reasons; unallocated depts appear greyed with "Not allocated to your centre".
- `src/components/DeadlinePill.jsx` — live countdown (`Xd Yh Zm Zs`), amber <24h, red when passed.
- `src/lib/logic.js` — pure domain logic (quota math, eligibility, elderly filter, tree helpers, attendance) shared with tests.
- `src/lib/logic.test.js` — Vitest unit tests (16). Run with `npm test`.
- `src/App.jsx` — dedicated sticky tab navbar: **Schedule** (aso/super_admin), **Consent & Deploy** (all roles), **Overview** (aso/super_admin).

## SQL migrations (run in order in Supabase)

1. `sql/portal_setup.sql` — base tables, RLS, helpers.
2. `sql/v2_deployment_redesign.sql` — deadline design, restriction rules, `chair_pass`, `prev_year_deployments`, triggers, RLS. **Non-destructive; safe to re-run.**
3. `sql/v3_data_safety.sql` — unique schedule-name index + `audit_log` table (with correct super_admin insert policy).
4. `sql/prev_year_deployments_data.sql` — upserts 2415 prev-year badge rows (run after the tables exist).

## Env / deploy

- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon key only, never service_role). `.env` is gitignored.
- Vercel: set both vars in Project Settings → Environment Variables, then redeploy.
- Git: this repo is separate from `sewadar-attendance`; remote `asofbdattendance-beep/deployment-portal.git`, branch `feature_deployment_portal_02082026`.
