# Major plan — Phase split + UI/UX refinement

Branch: `feat/phase-split-and-uiux` from `main` (HEAD `5dfde41`). Date: 2026-10-04.
Skills in force: `impeccable` (Operate), `ui-craft` + `ui-craft-dense-dashboard`, `emil-design-eng`, `react-best-practices`, `offline-first-sync`, `web-a11y-testing`, `award-craft-verify`, `vitest-testing`, `simplify`, `verification-before-completion`. `award-craft-build-recipes` evaluated and set aside (landing-only stack; bounded-verify retained).

## 0. Locked decisions

1. Two phases behind a top segmented switch (Deployment | Attendance), registry-driven.
2. Command Center Dashboard becomes a thin launcher — tiles navigate out, no re-rendered tables.
3. Global master switches live only in Control Panel.
4. Overview + Centre Lists → Phase 1. D7/D9 deferred to a follow-up.

## 1. Goal

Split the ASO/super-admin portal into Phase 1 (Deployment) and Phase 2 (Attendance), and refine the UI to dense-dashboard craft — removing repeated content (audit D1–D10 in planning record).

## 2. Scope / non-goals

In: IA split, nav shell, de-duplication, shared primitives, token/typography/density refinement, states, a11y, tests. Out: schema/DB changes, new data sources, RBAC changes, centre-role behaviour changes, new npm deps without approval, any push/deploy.

## 3. Target IA

Phase 1 Deployment: `schedule`, `consent`, `vss`, `deployment` (Overview), `centreLists`, `control`, `users`.
Phase 2 Attendance: `dashboard` (launcher), `alloc` (Finalize), `inchargeDashboard` (label "My Department"), `scanner`, `attendance`, `reports`, `liveScanners`, `anomalies`.

Nav rules: switch shown only when the role has pages in both phases (centre roles yes; dept_incharge/scanner auto Phase 2). Segmented ARIA tablist on desktop; MobileTabBar renders active phase items (max 5, 5th = More); MoreSheet sections by phase with a phase toggle. Active phase persisted (`portal_active_phase`), landing = first visible page of the active phase; deep-link `?page=` and cross-phase `handleNavigate` honoured. Remove `group:'attendance'` (phase replaces it).

## 4. Design direction

Refinement preserves (PRODUCT.md / DESIGN.md / `.ui-craft/` are the authorities). Token deltas in `.ui-craft/tokens.md`: radius steps 6/8/10/14, 4/8/12/16/24 spacing, subdued OKLCH semantics, `.tnum` utility, one focus ring, micro-motion 150–250ms. Every control ships all states; tables load skeleton rows; empty states teach. Signature detail: the phase switch itself.

## 5. Shared primitives (contracts)

`src/lib/phase.js` (resolve/store/phasesForRole) · `PhaseSwitch.jsx` · `PageHeader.jsx` (+ViewOnlyPill) · `useExcelExport.js` + `ExportButton.jsx` (lazy xlsx, shared ExportSheet path) · `useRealtimeRefresh.js` (channel + debounce + guard + removeChannel + reportRealtimeStatus) · `DataTable.jsx` (sticky header/identity col, tnum, skeleton rows) · `EmptyState.jsx` · `FilterBar.jsx` (deferred with D9) · `KpiTile.jsx` + `Sparkline.jsx`.

## 6. Execution phases

- **Phase 0 (done)**: branch + PRODUCT.md + DESIGN.md + `.ui-craft/` + this file; verify `git status`, `npm run lint`.
- **Phase 1**: `pages.js` phase field + `pages.test.js`; `phase.js` + test; `PhaseSwitch.jsx` + test; `App.jsx` wiring + `App.test`; mobile tab bar/sheet phase-aware + tests.
- **Phase 2**: index.css token layer; primitives 2.2–2.7 each with colocated tests.
- **Phase 3** (waves ≤3 parallel agents, one page + its test per agent): 3A Attendance/Reports/Anomalies/LiveScanners; 3B ConsentDashboard/VssDashboard/DeploymentMatrixReport/DeploymentAllocation/CentreLists; 3C ScheduleMaker/ControlPanel/Users/Consent/Vss (centre paths untouched — centre e2e gate).
- **Phase 4**: Dashboard → launcher; switches out of dashboards (no other `setPortalSetting` writer of the 3 keys); distinct dashboard labels/titles.
- **Phase 5**: `npm run lint && npm test && npm run build` (quote output); a11y pass on switch + 3 pages; desktop+mobile screenshots + critique; `e2e-desktop` offline suite; per-phase acceptance.

## 7. Risks

Test churn in page tests (update in the same task); shared files sequenced never parallel; centre/vss_operator edit paths frozen; landing moves Dashboard→Schedule in Phase 1 (approved); radius sweep verified by screenshots before Phase 3; local commits only.

## 8. Definition of done

Each page lives in exactly one phase; D1–D6/D8/D10 collapsed into primitives; tokens match `.ui-craft/tokens.md`; suites + lint + build green; a11y pass; screenshots reviewed.

Verification: `npm run lint && npm test && npm run build` all green, plus `e2e-desktop`, plus a manual desktop+mobile pass confirming each phase shows only its pages and every launcher tile navigates.
