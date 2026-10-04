# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **ASO staff** (`aso` read-only everywhere; `super_admin` sole writer, always labelled "ASO" in UI): run deployment oversight (schedules, departments/rules, allocations, finalize, Control Panel) and attendance oversight (dashboard, reports, scanners, anomalies).
- **Centre staff** (`centre_user`, `centre_admin`, centre-subtree scope): "Consent & Deploy" — consent Yes/No, days (1–5), stay/chair, department per sewadar, autosave + Save Draft.
- **Specialist roles**: `vss_operator` (VSS deployment writes), `dept_incharge` (scoped dashboard + scanner), `scanner` (scan-only).

## Product Purpose

Coordinate sewadar deployment across centres and departments for a visit window (fixed days WED–SUN — consent is a day count, not ticks), then track attendance by scanning and report present/absent/anomalies. Success means every allocated department is filled with an eligible, consented sewadar, and every deployed sewadar is attendance-marked daily.

## Positioning

One portal binding consent + deployment + finalize + scanning + reporting with DB-enforced rules (quota, eligibility, deadline, deployed-freeze) — neighbouring tools track only one leg of that pipeline.

## Operating Context

Visit windows with an optional deadline; centre hierarchy (root CENTRE parents, SC_SP children sharing quota); departments with `min_days` / `requires_stay_at_bhati` / `requires_initiated` rules; OE ESCORTS fixed at 3 days; phone-based scanning with an offline-first queue and PWA shell; ASO Excel/PDF exports; audit log for consent/lock actions.

## Capabilities and Constraints

Capabilities: schedules + deadlines; departments + restriction rules; centre allocations; consent + deployment together (autosave ~800ms, bulk with confirmation); VSS deploy/add/roster; finalize (`deployed_department_id`); Control Panel overrides (centre, department, VSS tri-state); attendance scanning (offline queue, background sync); day/visit reports; anomaly feed; live scanner ops.

Constraints: anon Supabase key only (reads fine; the user runs migrations); no auto push/deploy/delete; after deadline or `status = done`, editing is disabled in UI *and* DB except aso/super_admin; one department per sewadar; elderly (`badge_status = 'ELDERLY'`) excluded; every deployed sewadar must have a consent row.

Terminology: CENTRE / SC_SP, DEPLOYED and FINAL pills, VSS tri-state (Auto/Open/Closed), centre lock, "Add VSS" gate.

Landing rule (approved 2026-10-04): the portal is split into Phase 1 Deployment and Phase 2 Attendance; landing = first visible page of the active phase.

## Brand Commitments

The words "Super Admin" never appear in the UI (`ROLE_LABELS.super_admin` displays as "ASO"). Visual identity: indigo `#6366f1` primary, Inter type, Lucide icons, layered subtle shadows. No logo, voice guide, or other brand assets on record.

## Evidence on Hand

Page registry `src/lib/pages.js`; nav shell `src/App.jsx`; token source `src/index.css` (`:root`); conventions `docs/context/ui-conventions.md`; schema `docs/context/schema.md`; tooling `docs/context/tooling.md`. Colocated `*.test.jsx` suites; CI runs mobile e2e, PWA shell, migration parity, and the desktop offline suite.

## Product Principles

1. Rules live in the database; the UI explains them (quota bars and eligibility reasons mirror the triggers).
2. Read-only by default for oversight roles; writes are explicit, confirmed, and audited.
3. One screen, one job — no page re-renders another page's table.
4. Offline is a first-class state, not an error (queue counts, pills, skeletons).
5. Earned familiarity over novelty — a dense operator tool with visible shortcuts, not a showcase.

## Accessibility & Inclusion

Tap targets ≥44px, text inputs at 16px (no iOS zoom), keyboard-operable nav and dialogs, hover never the only signal, `prefers-reduced-motion` honoured, print/PDF parity for reports. Working standard only — no formal WCAG certification on record (inferred, not certified).
