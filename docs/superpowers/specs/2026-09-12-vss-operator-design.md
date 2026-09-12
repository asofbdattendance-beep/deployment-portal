# VSS Operator — Design (DB + docs third)

Date: 2026-09-12 · Migration: `sql/v36_vss_operator.sql` ·
ADR: `docs/adr/0001-vss-operator-role.md`

## 1. Goal

Add a reusable `vss_operator` role that unblocks deployment operations:
deploy still-undeployed sewadars (requested department only) and run the
VSS pipeline (create + assign VSFB) for ANY centre, past deadline, lock,
and switches — without touching anything final or administrative.

## 2. Locked scope (do not renegotiate)

- Only requested `department_id` + VSS deploy via the Consent/VSS
  pages. NEVER `deployed_department_id` (final). No Finalize tab.
- Bypasses deadline + centre lock (+ switches) like super_admin.
  `done`, quota, min_days / stay / initiated / VSS rules, ELDERLY,
  phantom-badge, FINAL (v15/v16), DEPLOYED freeze (v32) always bind.
- VSS: create + assign-VSFB for ANY centre (picker); undeployed-only =
  INSERT new deployments only, never UPDATE/DELETE existing deployed rows.
- Reusable role `vss_operator`; no hardcoded email/name.

## 3. DB changes (`sql/v36_vss_operator.sql`, run after v34/v35)

- `portal_users_role_check`: adds `vss_operator`, keeps all existing
  values (`centre_user`, `centre_admin`, `aso`, `super_admin`,
  `dept_incharge`, `scanner`).
- Reads (+ operator arm): `consent_read`, `deploy_v2_read`,
  `vss_sewadars_read`, `vss_registrations_read`, `sewadars_portal_read`.
  Centres/schedules/departments/allocations reads are already
  `USING (true)` — unchanged.
- Writes (+ blanket operator arm, narrowed by triggers): `consent_write`,
  `deploy_v2_insert` / `deploy_v2_update` / `deploy_v2_delete`,
  `vss_registrations_write` (v9 body + arm).
- `assign_vss_registration`: allow-list becomes
  `('super_admin','vss_operator')` — aso loses VSFB assignment (v20
  read-only consequence). SECURITY DEFINER, so no `vss_sewadars_write`
  grant needed (stays super_admin-only).
- `guard_vss_registration_write` (v21 body): operator bypasses the
  creation gate + deadline window.
- `block_after_deadline` (v34 body): operator bypasses lock/switch/
  deadline; `done` still terminal.
- `check_deployment` (v34 body): `v_bypass = admin OR operator` in the
  four openness gates (lock/deadline, consent-given, VSS switch,
  sewadar switch); final-department setter still raises for the
  operator; new undeployed-only raise blocks UPDATEs of existing rows
  (covers upsert-into-existing); quota/eligibility/ELDERLY unchanged.
- `check_deployment_batch` / `_upd` (v35 bodies verbatim incl. the
  AREA SECRETARY OFFICE exclusion): only the bypass line gains the
  operator; quota + `done` re-checks bind everyone.
- `block_locked_delete` (v34 body + operator branch): lock bypass, but
  DELETE of an existing deployment row raises.
- Explicitly untouched: schedule/department/allocation/override/
  portal_users/audit writes, `get_my_effective_gates` (`admin` stays
  false for the operator), v15/v16 finalized guards, v32 freeze,
  `require_sewadar_exists`, lock/incharge triggers.

## 4. Frontend contract (for the UI third — not implemented here)

- Treat `role === 'vss_operator'` as deployment-capable on the Consent
  & Deploy and VSS pages for every centre: centre picker (any CENTRE +
  SC_SPs), quota bars, eligibility reasons, and persist paths behave as
  for super_admin; deadline/lock/closed-switch banners must NOT block.
- Do NOT check `get_my_effective_gates.admin` for the operator (it is
  false); gate on the role string directly.
- Hide: Finalize Deployment tab, Control Panel, Schedule pages, master
  switches, lock/unlock buttons, incharge editing beyond centre scope.
- Never send `deployed_department_id`; disable edit/delete affordances
  on FINAL / DEPLOYED rows (the DB rejects them anyway — surface the
  error text).
- Provisioning display: role label "VSS Operator" (never "Super Admin").

## 5. Security

- Least privilege: no override/schedule/user/audit writes, so the
  operator cannot widen itself or reconfigure the portal.
- Undeployed-only is enforced at three independent layers (RLS +
  BEFORE row trigger + BEFORE delete trigger) plus the pre-existing
  v32/v15/v16 freezes the operator is NOT exempt from.
- `done` is terminal in all four gate functions; quota and restriction
  rules evaluate identically for every role.
- Provisioning is a manual super_admin `UPDATE portal_users`
  (in the ADR); the migration itself writes zero data rows.

## 6. Verification

1. Run `sql/v36_vss_operator.sql` in staging after v34/v35; re-run to
   prove idempotence (must succeed, zero data change).
2. Run the four footer verification SELECTs: CHECK values, policy
   list + spot-check expressions, 7 functions mention `vss_operator`,
   5 guard functions do NOT.
3. As an operator test user: INSERT requested deployment past deadline
   on a locked centre (succeeds); repeat at quota (fails `quota
   exhausted`); UPDATE the row (fails `Already deployed`); set
   `deployed_department_id` (fails `Only ASO or Super Admin`);
   assign a VSFB (succeeds); write to `centre_overrides` (denied).
4. `npm test && npm run lint && npm run build` stay green (no app code
   touched in this third).
