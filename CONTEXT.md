# Deployment Portal — Context

## Roles & Permissions

| Role | Scope | What they can do |
|---|---|---|
| `centre_user` | Their centre | Fill consent (WED–SUN availability + stay-at-bhati) and lock it; assign centre's sewadars to departments; lock deployment |
| `centre_admin` | Their centre | Same as centre_user plus review/edit deployments and approve → fixed |
| `aso` | All centres | Read-only view of everything |
| `super_admin` | All centres | Creates schedules, departments (+rules), allocates departments to parent centres; gives go-ahead; everything |

## Days

No dates. Every schedule spans the fixed 5 days: **WED, THU, FRI, SAT, SUN**. Consent records a sewadar's available **number of days** (1–5), not specific day ticks.

## Flow

1. **Super Admin** creates a schedule (a named visit, e.g. "October 2026 Visit", 3×/year).
2. **Super Admin** manages departments and sets **restriction rules** per department:
   - `min_days` — minimum number of consent days (1–5) a sewadar must be available on
   - `requires_stay_at_bhati` — department needs stay-at-bhati sewadars
   - `requires_initiated` — department needs initiated sewadars (from `sewadars.is_initiated`)
3. **Super Admin** allocates departments to **parent centres** (centres with empty `parent_centre`): pick a department, enter a `max_count` per parent centre, and save all at once. Parent + child centres share that quota.
4. **Phase I — Consent** (`centre_user`/`centre_admin`): each centre manages sewadars for its **whole subtree** (own centre + child centres), settable per sewadar:
   - **Consent for deployment** (Yes/No)
   - **No. of days** available (1–5)
   - **Stay at bhati** (Yes/No)
   Filter + search available. Centre **locks** consent (whole subtree) when done. No restrictions here.
5. **Super Admin** gives the **go-ahead** (schedule status → `deployment_open`) after consents are locked.
6. **Phase II — Deployment** (`centre_user`/`centre_admin`): centres assign their subtree's sewadars to allocated departments (filter + search available). Sewadars who have saved consent appear as **"Eligible for Deployment"**.
   - One department per sewadar.
   - Enforced: sewadar's consent days (`available_days_count`) must be at least the dept's `min_days` and satisfy `requires_stay_at_bhati` and `requires_initiated`.
   - Enforced: total assigned across the parent subtree must not exceed `max_count`.
7. Centre User **locks** → Centre Admin **approves** → deployment is final.

## Database Tables

### `deployment_schedules`
Named visit. `name`, `status` (`consent_open` → `deployment_open` → `done`), `consent_locked` (superadmin global consent lock), `deployment_locked` (superadmin global deployment lock).

### `deployment_departments`
Reference list + restriction rules (`min_days int`, `requires_stay_at_bhati bool`, `requires_initiated bool`).

### `centre_allocations`
Super-admin allocation: `(schedule, department, centre)` → `max_count`. Only parent centres.

### `sewadar_consents`
Phase I per-sewadar: `(schedule, centre, badge, consent_given, available_days_count, stay_at_bhati)`.

### `centre_consent_status`
Per-centre consent lock for a schedule (`draft`/`locked`).

### `deployments`
Phase II assignments: `(schedule, centre, badge)` → `department_id`, `status` (`pending`/`locked`/`approved`).

## Existing Tables Used

- `sewadars` — centre scope, badge_number, name, is_initiated
- `centres` — `name`, `parent_centre` (empty = parent centre); used to resolve parent/child subtree for shared quotas
- `portal_users` — auth, centre, role

## Key Rules & Helpers

- `get_root_centre(centre)` — walks `parent_centre` chain to find the parent centre.
- `get_my_subtree_centres()` — centre names under the caller's centre (itself + descendants); used by RLS so parents manage their own + child centres.
- `get_remaining_quota(schedule, department)` — remaining quota for caller's root centre counting the whole subtree (security definer).
- Deployment inserts/updates validated by trigger `check_deployment` (schedule open + eligibility + quota).
- Consent edits blocked by trigger once the centre's consent is locked.
