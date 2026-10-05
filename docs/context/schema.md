# Database schema & helpers (extracted from CONTEXT.md 2026-10-04)

> Extracted to shrink the always-on CONTEXT.md (slim copy lives there in one-liners). Read this before touching schema, tables, quotas or helpers.

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
- `portal_users` — auth, centre, role, `is_active`, `archived_at`/`archived_by` (v69), `force_logout_at` (v70)

## Key Rules & Helpers

- `get_root_centre(centre)` — walks `parent_centre` chain to find the parent centre (SQL + JS copy in `src/lib/logic.js`).
- `get_my_subtree_centres()` — centre names under the caller's centre (itself + descendants); used by RLS so CENTREs manage their own + SC_SPs.
- `get_remaining_quota(schedule, department)` — remaining quota for caller's root centre counting the whole subtree (security definer).
- Deployment inserts/updates validated by trigger `check_deployment` (schedule open, deadline not passed, consent exists + given, not elderly, eligibility, quota). Multi-row inserts additionally guarded by statement-level `check_deployment_batch` (quota bypass protection).
- Consent/deployment edits blocked by `block_after_deadline` trigger once the schedule deadline has passed, status is `done`, or the relevant master switch (`sewadar_deployment_open` / `vss_deployment_open`) is closed. A NULL deadline does NOT block (deadline optional). Centre roles cannot set `deployments.deployed_department_id` — only super_admin can (aso lost that with v20). A v21 Control Panel override (`is_centre_override_open`) bypasses the lock/switch/deadline for its scope — never `done`.
- **v32 deployed-sewadar freeze** (`sql/v32_freeze_deployed_sewadars.sql`): centre-role UPDATE/DELETE on a deployed regular sewadar's `deployments` or `sewadar_consents` row raises (`freeze_deployed_rows()`, triggers `trg_a_freeze_deployed_deploy`/`trg_a_freeze_consent_of_deployed`). Exemptions: aso/super_admin; a normal `is_centre_override_open(schedule, centre, dept)` — passed the ROW's department for `deployments`, `NULL::uuid` (centre-wide only) for consents; VSS badges. Undeployed-only override rows never bypass. INSERT of a brand-new deployment unaffected.
- **`fetchAllRpc` + `RPC_PAGE_SPECS`** (`src/lib/supabase.js`, release 2026-10-03): PostgREST's `db-max-rows` (1000) truncates SETOF RPC results too, so every per-badge attendance/previsit feed pages through `fetchAllRpc` with `count:'exact'` (retry once, then throw on count mismatch; an unknown spec throws — fail-closed) and KPIs, expected denominators, workbook sheets and previsit totals stay complete. Registered: `attendance_sewadar_summary`, `attendance_day_badges`, `previsit_sewadars`, `previsit_deployed`; `previsit_summary` stays single-shot (server-aggregated). A new RPC returning per-badge rows MUST be added to `RPC_PAGE_SPECS` or its caller fails loudly instead of silently rendering a 1000-row prefix.
- **v69 archive + v70 force-logout enforcement** (`sql/v69_user_lifecycle.sql`, `sql/v70_force_logout.sql`): `portal_users.archived_at`/`archived_by` (v69) soft-delete a login — `get_portal_user_role`/`get_portal_user_centre`/`get_portal_profile` all add `AND archived_at IS NULL`, so an archived login resolves to NULL role/centre/profile → every RLS policy and helper denies it (fail-closed). `claim_portal_invite` refuses archived logins ("archived — restore from Users page"); a legit re-provision clears the stamp. `portal_users.force_logout_at` (v70) is a per-user kill switch: the three helpers add `AND (force_logout_at IS NULL OR COALESCE((auth.jwt()->>'iat')::bigint,0) >= EXTRACT(EPOCH FROM force_logout_at)::bigint)` — any JWT issued before that instant stops working everywhere; the user simply re-signs for a fresh token. Both migrations are non-destructive, safe to re-run, and additive (NULL = live).

## Database Tables (Control Panel, v21)

### `centre_overrides`
Presence of a row = deployment writing OPEN for that scope: `schedule_id`, `centre` (`'*'` = ALL centres, else the root CENTRE — SC_SPs inherit), `department_id` (NULL = all departments), `note`, `created_by`. Unique index on `(schedule_id, centre, COALESCE(department_id, sentinel-uuid))`. Resolved by `is_centre_override_open(schedule, centre, dept)`: a department-scoped row opens only deployments into that department; consent rows reopen only through a centre-wide (NULL dept) override. RLS: read = aso/super_admin; write = super_admin.

### `centre_vss_overrides`
Tri-state VSS knobs per centre: `centre UNIQUE` (`'*'` = all), `creation_open boolean NULL`, `deployment_open boolean NULL` — NULL = inherit the global switch/window. Consumed by `guard_vss_registration_write` (creation gate) and `vss_deploy_open_for_centre` (deployment marking). Client RPC `get_my_effective_gates(schedule)` returns the effective booleans for the caller's centre.
