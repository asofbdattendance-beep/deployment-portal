# Design decisions

- **2026-10-04**: Verdict is refinement, not redesign (impeccable Operate). Identity preserved: Inter, indigo `#6366f1`, Lucide, hairline shadows. Recorded in DESIGN.md (scan mode) and PRODUCT.md (`impeccable:product-schema 1`).
- **2026-10-04**: Portal split into Phase 1 Deployment (schedule, consent, vss, overview, centreLists, control, users) and Phase 2 Attendance (dashboard launcher, alloc, inchargeDashboard, scanner, attendance, reports, liveScanners, anomalies). Top segmented switch, registry-driven (`PAGES[].phase`); existing `group:'attendance'` to be removed to avoid two grouping systems.
- **2026-10-04**: Command Center Dashboard becomes a thin launcher (tiles navigate out). Master switches live only in Control Panel. Overview + Centre Lists assigned to Phase 1. D7 (consent/deployment single source) and D9 (shared FilterBar) deferred to a follow-up.
- **2026-10-04**: `award-craft-build-recipes` evaluated and set aside — fixed landing stack (Next.js/Tailwind/GSAP/Lenis) conflicts with this repo's React+Vite+vanilla-CSS Operate app. Bounded-verify principle retained for Phase 5.
