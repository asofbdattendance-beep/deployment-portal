# ADR 0001: Reusable `vss_operator` Role

- Status: Accepted
- Date: 2026-09-12
- Scope: DB + docs third of the `vss_operator` feature (`sql/v36_vss_operator.sql`)

## Context

Deployment work stalls when only the super_admin can act past a closed
switch, a passed deadline, or a centre lock: undeployed sewadars pile up
across centres and VSS registrations wait for VSFB assignment, while
centre users are frozen out and the super_admin becomes a bottleneck.
Per-person exceptions (hardcoded emails, ad-hoc Control Panel overrides)
do not scale and leave no reusable pattern.

## Problem

We need a staff role that can, for ANY centre, deploy still-undeployed
sewadars (requested department only) and run the VSS pipeline
(create + assign VSFB) — past deadline/lock/switch — without ever
touching final decisions, quotas, rules, or admin configuration.

## Decision

Introduce one reusable role, `vss_operator` (a value in
`portal_users.role`, no hardcoded email/name), enforced in
`sql/v36_vss_operator.sql`:

- All-centre read: consents, deployments, sewadars, vss_sewadars,
  vss_registrations.
- Scoped all-centre write: consent rows, INSERT-only deployments with
  requested `department_id`, VSS create + `assign_vss_registration`.
- Bypass (like super_admin): deadline, centre lock, master/VSS switches,
  VSS creation gate, consent-given.
- Never: `deployed_department_id`, Finalize tab data, `done` schedules,
  quota, restriction/VSS rules, ELDERLY, phantom badges, v15/v16
  finalized rows, v32 DEPLOYED freeze, schedules/departments/
  allocations/overrides/users/audit writes.

## Alternatives

1. Hardcoded operator emails in RLS/functions — rejected: every staff
   change needs a migration; no audit-friendly identity.
2. Per-centre Control Panel overrides (`centre_overrides`) opened by the
   super_admin on demand — rejected: manual per-case work, expires
   semantics unclear, still centre-scoped; the bottleneck remains.
3. Second super_admin account — rejected: grants Finalize, Control
   Panel, schedule/department deletes, and audit writes; far too broad.
4. Widen centre roles past deadline/lock — rejected: breaks the
   lock/deadline model for every centre user at once.

## Reasons

- Least privilege: the operator gets exactly the deployment/VSS write
  surface and nothing administrative.
- Reusable: provisioning is one `UPDATE portal_users SET
  role='vss_operator'` by the super_admin; deprovisioning is the reverse.
- DB-first: every boundary (undeployed-only, no-final, quota, rules,
  freeze) is a trigger/RLS guarantee, not UI convention — a hostile or
  buggy client cannot exceed it.
- Consistent with hardening history: aso stays read-only (v20); the
  operator takes over only the VSS-assign duty aso loses, plus
  undeployed requested-department deployment.

## Trade-offs

- Operator UPDATE/DELETE on `deployments` is effectively dead: RLS
  allows it but `check_deployment` (v36) rejects UPDATEs of existing
  rows and `block_locked_delete` (v36) rejects DELETEs of them. A wrong
  requested department can only be fixed by the super_admin. Accepted:
  "undeployed-only" must be airtight over convenience.
- Operator bypasses consent-given (like super_admin / an open
  override). The Consent page writes consent first, so this rarely
  matters; documented so reviewers are not surprised.
- `get_my_effective_gates` still reports `admin:false` for the
  operator — the frontend must gate on `role === 'vss_operator'`
  explicitly (see design doc), not on the `admin` flag.
- `assign_vss_registration` moves the aso arm to the operator
  (`NOT IN ('super_admin','vss_operator')`). Aso loses VSFB assignment —
  intended under v20 read-only, but a behaviour change to note.

## Consequences

- New migration `sql/v36_vss_operator.sql` (run after v34/v35,
  idempotent, re-runnable, no data writes).
- Frontend third (separate change): gate Consent/VSS pages for the new
  role; keep Finalize/Control Panel/Schedule hidden.
- Provisioning/deprovisioning is a manual super_admin SQL step (below);
  never baked into a migration.

## Migration / Rollback

Apply (Supabase SQL editor, after v34 + v35):

```sql
-- run the full contents of sql/v36_vss_operator.sql, then verify with
-- the commented SELECTs at its footer.
```

Provision one operator (manual super_admin step, NOT in the migration):

```sql
UPDATE public.portal_users SET role = 'vss_operator'
WHERE email = '<operator email>';
```

Rollback:

```sql
UPDATE public.portal_users SET role = 'centre_user'
WHERE role = 'vss_operator';
```

then revert the frontend role gating. Optionally re-run
v20/v34/v35 to strip the operator arms; harmless to leave them once no
user holds the role.
