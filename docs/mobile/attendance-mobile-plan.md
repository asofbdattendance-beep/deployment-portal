# Attendance Module — Mobile-First Build Plan (A–Z)

> Status: approved for build. Dark mode OUT. Rotation ON. Matrix = scroll-grid + quick peek. Wire `LiveScannersPage` + `DeptInchargePage` into nav; keep `InchargeScannerPage` AND `DeptInchargePage`. Virtualise long lists. Add PWA via `vite-plugin-pwa` + `@tanstack/react-virtual`.

## 0. Purpose

Turn the attendance module (analytics, reports, scanner, dept-incharge) into a true mobile-first, app-like experience across every device tier and both orientations, installable as a PWA, with virtualised long lists — while keeping desktop ≥1025px behaviour unchanged.

## 1. Locked decisions

| # | Decision |
|---|---|
| D-A | **Dark mode: NOT in scope.** No `prefers-color-scheme` theme work; keep hard-coded light surfaces. (Still add a scoping comment so it can be added later without a rewrite.) |
| D-B | **Rotation allowed** for all attendance pages; manifest must not force portrait. |
| D-C | **AttendanceMatrix mobile = scroll-grid with pinned Badge column + sticky day header, PLUS a tap-row bottom-sheet "quick peek"** (fast to build, best usability). |
| D-D | **Wire `LiveScannersPage` + `DeptInchargePage` into nav.** |
| D-E | **Virtualise** long lists with `@tanstack/react-virtual` (new dep). |
| D-F | **Add PWA** via `vite-plugin-pwa` in `injectManifest` mode, extending the existing `public/sw.js` (keeps Background Sync). |

## 2. Module inventory (files this plan may touch)

- **Pages:** `AttendancePage.jsx`, `ScannerPage.jsx`, `InchargeScannerPage.jsx`, `DeptInchargePage.jsx`, `DeptInchargeDashboardPage.jsx`, `DashboardPage.jsx`, `ReportsPage.jsx`, `AnomaliesPage.jsx`, `LiveScannersPage.jsx`
- **Components:** `PrevisitView.jsx`, `PrevisitDashboard.jsx`, `AttendanceMatrix.jsx`, `scanner/{BarcodeScanner,ScanResultPopup,RecentScansTable}.jsx`, `mobile/{MobileTabBar,MoreSheet,ScanModeShell,MobileScanFeed,FilterSheet,ExportSheet}.jsx`
- **Hooks/libs:** `useMediaQuery.js`, `useScanHandler.js`, `useScannerSession.js`, `usePrevisitData.js`, `useExport.js`, `lib/{attendance,previsit,sewaMode,scannerUtils,scanDisplay,excel,mobile,offlineQueue}.js`
- **Shell/PWA/CSS:** `App.jsx`, `src/lib/pages.js`, `index.html`, `public/manifest.webmanifest`, `public/sw.js`, `vite.config.js`, `src/index.css`
- **Tests:** existing colocated `*.test.jsx`, `tests/e2e/mobile-attendance.spec.js`, `playwright.config.js`, `.github/workflows/ci.yml`

## 3. Device-tier system (the contract everything reads)

Define once in `index.css` + `useMediaQuery.js`. **No other width values allowed.**

| Tier | Width | Orientation | Chrome | Tables |
|---|---|---|---|---|
| T0 tiny | ≤359 | portrait | mobile shell | cards |
| T1 phone | 360–413 | portrait | mobile shell | cards |
| T2 large phone | 414–480 | portrait | mobile shell | cards |
| T3 phablet/fold-closed | 481–640 | portrait | mobile shell | cards |
| T4 tablet-portrait / phone-landscape-small | 641–768 | any | mobile shell | **cards (fixes D1)** |
| T5 tablet-landscape | 769–1024 | landscape | desktop nav | tables |
| T6 laptop | 1025–1440 | any | desktop nav | tables |
| T7 desktop | ≥1441 | any | desktop nav | tables |

**Laws:**

- `MOBILE_QUERY = '(max-width: 768px), (max-height: 500px) and (pointer: coarse)'` — catches **landscape phones** (375–430px tall) that are ≥769px wide. `useDeviceTier()` returns the tier name.
- Card collapse applies **≤768** (not 640). 769–1024 keeps tables.
- All 32 `:hover` rules get wrapped in `@media (hover: hover) and (pointer: fine)`.
- Add `@media (orientation: landscape) and (max-height: 500px)` handling.
- Motion reduced under `prefers-reduced-motion` for every new animation.

## 4. Global appearance & interaction laws

1. **Tap targets ≥44×44px** for every interactive element (not just `.btn`): `.toggle`, `.pill`-as-button, `.mobile-chip-x`, retry/queue-clear buttons, icon-only buttons, date inputs, `.previsit-control`.
2. **Text inputs ≥16px** — cover bare `<input>`/`<select>`, `email`, `password`, `tel`, `datetime-local`.
3. **Safe areas:** `safeBottom()` everywhere already; add `safeTop()` to `.app-header`.
4. **Z-index scale:** filter-sticky 20 < tabbar 40 < modal 80 < bottom-sheet 90 < toast 200 < tooltip 9999. `ScanResultPopup` = 90 (above tabbar); main bottom padding 84px + safe area.
5. **Feedback:** scan success → `vibrate()` (currently never imported); loading → skeleton; empty → icon+title+action; error → panel+retry; offline → banner.
6. **Never hover-dependent**; active state on `:active`.

## 5. Shared primitives to create

- `useDeviceTier()` / `useIsMobile()` updated (`useMediaQuery.js`)
- `Skeleton` (card, row, KPI, table variants) — `src/components/mobile/Skeleton.jsx`
- `OfflineBanner` (global, `navigator.onLine` + realtime status) — `src/components/mobile/OfflineBanner.jsx`
- `PullToRefresh` wrapper — `src/components/mobile/PullToRefresh.jsx`
- `InstallPrompt` (A2HS, dismissible, standalone-aware) — `src/components/mobile/InstallPrompt.jsx`
- `QuickPeekSheet` (matrix row detail) — `src/components/mobile/QuickPeekSheet.jsx`
- `VirtualList` wrapper (row measurement + overscan) — `src/components/mobile/VirtualList.jsx`

---

## 6. PHASES

### Phase 0 — Foundation (blocking; serialise `index.css`)

| Task | Files | Do (detail) | Verify |
|---|---|---|---|
| 0.1 Tier system | `index.css`, `hooks/useMediaQuery.js` | Replace 480/640/768/900/1100 with the §3 tiers; consolidate duplicates (`app-header` 499+1504; `stat-row` 338+1528; input 341+1516); add orientation/pointer/reduced-motion queries; wrap 32 hover rules in `(hover:hover)`. | Screenshot sweep 320/360/414/768/1024; grep = one query per tier |
| 0.2 Tap/input contract | `index.css` | Extend ≤768 rule per §4.1–4.2. | tap-target test asserts all interactive ≥44px |
| 0.3 Z-index scale | `index.css` + modal call sites | Introduce tokens; modal-overlay→80; ScanResultPopup→90 with `paddingBottom: 84px + safe`. | computed-style test; modal on phone |
| 0.4 Primitives | `hooks/useMediaQuery.js`, `lib/mobile.js`, new `components/mobile/*` | Add `useDeviceTier`, wire `safeTop` into header, build §5 components. | unit test each |

**Phase 0 gate:** all primitives unit-tested; desktop ≥1025 unchanged (visual diff); landscape phone (390×844 rotated) detected as mobile.

### Phase 1 — PWA / app shell

| Task | Files | Do | Verify |
|---|---|---|---|
| 1.1 Workbox SW | `vite.config.js`, `public/sw.js`, `package.json` | Add `vite-plugin-pwa` `injectManifest`; precache built assets + `index.html`; NetworkOnly for `*.supabase.co`; keep Background Sync; `cleanupOutdatedCaches`; versioned; kill-switch constant. | offline reload after first visit; SW update prompt fires |
| 1.2 Manifest/meta | `manifest.webmanifest`, `index.html` | Remove portrait lock (D-B); add `id`, `display_override`, `categories`, `screenshots`; align theme-color. | Lighthouse installability pass |
| 1.3 Install/update UX | new `InstallPrompt.jsx`, `App.jsx`, `sw.js` | A2HS banner (mobile-only, dismissible); "New version — reload" prompt. | manual iOS/Android |
| 1.4 Offline banner | `OfflineBanner.jsx`, `App.jsx` | Global banner on all attendance pages. | toggle airplane mode |

**Phase 1 gate:** app loads offline from home-screen; offline banner appears/disappears; no stale auth/API cached; rollback path documented.

### Phase 2 — Core attendance page

| Task | Files | Do | Verify |
|---|---|---|---|
| 2.1 Kill duplicate filters | `AttendancePage.jsx` | Render inline filters only when `!isMobile` (fix `:661`+`:908`). | RTL: mobile shows sheet only |
| 2.2 Cards ≤768 + full-width sheet fields | `index.css`, `AttendancePage.jsx` | `table-wrap`→cards at ≤768; search/select full-width in sheet. | screenshot 768 |
| 2.3 TOTAL summary card | `AttendancePage.jsx` | `tfoot` renders as distinct summary card, not a sewadar card. | RTL assertion |
| 2.4 Controls 44px | `AttendancePage.jsx` | date input 36→44; retry buttons 24→44; export labels ≥14px. | tap test |
| 2.5 States + pull-to-refresh | `AttendancePage.jsx` | Skeleton, empty, offline; PullToRefresh. | RTL + e2e |
| 2.6 Virtualise lists | `AttendancePage.jsx` + `VirtualList` | Sewadars + Scanner Ops rows. | 700-row perf test |

**Phase 2 gate:** 3 tabs usable at 320/360/768 portrait + landscape; no horizontal scroll; filters once; smooth at 700 rows.

### Phase 3 — ASO dashboards

| Task | Files | Do | Verify |
|---|---|---|---|
| 3.1 Sticky-column fix | `DashboardPage.jsx` | Inline `position:sticky`/`#fff` cells → class or `isMobile` guard (D5). | card render has no sticky |
| 3.2 Rail collapse | `DashboardPage.jsx` | 280–320px rail stacks below leaderboard on phones. | screenshot |
| 3.3 Row affordance | `DashboardPage.jsx` | `<tr onClick>` → real button/keyboard. | a11y test |
| 3.4 Trend strip | `DashboardPage.jsx` | `width:34/38` → responsive. | screenshot |
| 3.5 PrevisitDashboard | `PrevisitDashboard.jsx` | Add `useIsMobile`, fix `92px 1fr auto`+`minWidth:72`, skeleton, ExportSheet. | RTL + screenshot |

**Phase 3 gate:** dashboards card-mode clean; no nested scroll; keyboard reachable.

### Phase 4 — Reports / Anomalies / Previsit register

| Task | Files | Do | Verify |
|---|---|---|---|
| 4.1 FilterSheet adoption | `ReportsPage.jsx`, `AnomaliesPage.jsx` | Add `MobileFilterBar`+`FilterSheet`. | RTL |
| 4.2 nowrap/width leaks | `AnomaliesPage.jsx`, `PrevisitView.jsx` | Remove inline `nowrap`; register min-width ≤768 card; ≥769 table ok. | screenshot 768 |
| 4.3 PrevisitView Total | `PrevisitView.jsx` | Total grid → mobile cards + `data-label`; wire ExportSheet (fix iOS download). | RTL + share test |
| 4.4 Virtualise anomalies | `AnomaliesPage.jsx` + `VirtualList` | 2000 rows. | perf |
| 4.5 Phone print→share | `ReportsPage.jsx` | `window.print()` fallback → Web Share. | manual iOS |

**Phase 4 gate:** filtered from a sheet; no 736/896px scroll ≤1024; export works on iOS.

### Phase 5 — Scanner capture shell

| Task | Files | Do | Verify |
|---|---|---|---|
| 5.1 Queue controls | `ScannerPage.jsx` | Clear failed/live/orphaned + stranded → 44px buttons in a Queue sheet. | tap test |
| 5.2 Incharge parity | `InchargeScannerPage.jsx` | Add failed/orphaned/stranded surface. | RTL |
| 5.3 Popup vs tabbar | `ScanResultPopup.jsx` | Bottom offset clears 84px tabbar; landscape max-height. | screenshot landscape |
| 5.4 Camera landscape | `BarcodeScanner.jsx` | Landscape video height; AF/torch re-check; phone-gate debug pills. | manual |
| 5.5 a11y live region | `MobileScanFeed.jsx` | Debounce announcements vs 15s poll. | a11y test |
| 5.6 Haptics | `useScanHandler.js`/pages | `vibrate()` on success (respect reduced-motion). | unit |

**Phase 5 gate:** scan works portrait+landscape; queue recoverable by touch; popup never occluded; no repeated SR announcements.

### Phase 6 — Dept-incharge surfaces

| Task | Files | Do | Verify |
|---|---|---|---|
| 6.1 Dashboard filters | `DeptInchargeDashboardPage.jsx` | MobileFilterBar/FilterSheet; day input 44px. | RTL |
| 6.2 Matrix mobile | `AttendanceMatrix.jsx` + `QuickPeekSheet` | Pinned Badge + sticky day header; tap row → peek sheet (D-C). | screenshot 320 |
| 6.3 DeptInchargePage mobile | `DeptInchargePage.jsx` | Add mobile branch incl. ScanModeShell + queue parity. **Keep `InchargeScannerPage` too** (both stay; no consolidation). | RTL |

**Phase 6 gate:** dept_incharge scans, lists, opens matrix on a phone; no dead surfaces.

### Phase 7 — Nav wiring (D-D)

| Task | Files | Do | Verify |
|---|---|---|---|
| 7.1 `deptIncharge` | `lib/pages.js`, `App.jsx` | Add `{ label:'Lists', icon:Users, roles:['dept_incharge'] }` after `inchargeDashboard`; route `DeptInchargePage`. | nav test |
| 7.2 `liveScanners` | `lib/pages.js`, `App.jsx` | Add `{ label:'Live Scanners', icon:Radio, roles:['aso','super_admin'], group:'attendance' }`; route `LiveScannersPage`; wire Dashboard deep-links. | nav test |
| 7.3 Mobile bar reachability | `MobileTabBar.jsx`, `pages.js` | Ensure attendance destinations reachable (dept_incharge: Dashboard/Lists/Reports on bar; ASO: group in More). | nav test |

**Phase 7 gate:** every attendance page reachable by its roles on mobile without ambiguity.

### Phase 8 — Coverage & docs

| Task | Files | Do | Verify |
|---|---|---|---|
| 8.1 Landscape everywhere | `index.css` | Orientation rules for scanner + dashboards. | screenshots |
| 8.2 Notch | `App.jsx`, `index.css` | `safeTop`. | device/simulator |
| 8.3 data-label gaps | `AttendanceMatrix.jsx`, `PrevisitView.jsx` | Add labels / sticky reset. | test |
| 8.4 E2E matrix | `tests/e2e/*`, `playwright.config.js` | 320/360/414/768 + landscape, chrome+safari. | CI green |
| 8.5 Docs | `CONTEXT.md` | Update mobile section. | review |

**Phase 8 gate:** CI e2e green at all tiers/orientations; docs updated.

---

## 7. Risks

1. **Service worker is sticky** — a bad SW bricks the installed app; need versioned cache + kill-switch + tested rollback.
2. **`index.css` touched by Phases 0/2/8** — serialise; one editor at a time.
3. **Two incharge scanning surfaces stay** — keep `InchargeScannerPage` + `DeptInchargePage` in sync (queue parity, shell parity).
4. **`@tanstack/react-virtual` new dep** — approved.
5. **Desktop must stay byte-identical** — every change guarded by tier/`useIsMobile`.
6. **Coverage gate** — new components need tests or CI reddens.

## 8. Per-phase completion checklist (applied at each phase end)

- [ ] `npm run lint` clean
- [ ] `npm test` green, coverage ≥ existing floors
- [ ] Screenshots at all tiers in scope + both orientations
- [ ] No horizontal scroll at 320px
- [ ] All new interactive elements ≥44px, inputs ≥16px
- [ ] Desktop ≥1025px unchanged
- [ ] Offline/loading/empty/error states present for touched surfaces
- [ ] `npm run build` succeeds; PWA still installable

## 9. Verification

Land Phase 0→8 in order; each phase's checklist is the merge gate. Final: install to home screen, rotate, airplane-mode load, full scanner flow, export via share sheet, then `npm run build`.


---

## 10. Build log (2026-10-03) — all phases shipped

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | DONE | Tier doc block in index.css; card collapse 640→768; hover gated on `(hover:hover)+(pointer:fine)` (31 rules moved); `MOBILE_QUERY` gained the landscape-phone arm; `DEVICE_TIERS`/`tierForWidth` in `lib/mobile.js` (single source, re-exported by `useMediaQuery`); z-index token scale; 6 new primitives + `useOnline`; 44px/16px contract extended to bare inputs, `.toggle`, pills, date controls. |
| 1 PWA | DONE | `vite-plugin-pwa` `injectManifest` over `src/sw.js` (precache 52 entries, NetworkOnly default, NavigationRoute→index.html, prompt updates, `SW_KILL`); manifest rotation unlocked + `id`/`display_override`/`categories`; `InstallPrompt`/`SwUpdatePrompt`; global `OfflineBanner` in `main.jsx`. |
| 2 AttendancePage | DONE | Duplicate inline filters removed on mobile; skeletons; `PullToRefresh`; virtualised Sewadars + Scanner Ops via `AttendanceCards`; TOTAL row is its own summary card; 44px date/retry/export. |
| 3 Dashboards | DONE | `DashboardPage` inline sticky columns → `table-sticky-col` (so the card reset can see them); leaderboard rows keyboard-reachable via a real button; `.dash-rail`/`.dash-leaderboard` collapse; flexible trend strip; `PrevisitDashboard` skeletons + 2-row day strip on ≤480. |
| 4 Reports/Anomalies | DONE | `FilterSheet` adopted on Reports + Anomalies (chips scroll, not a wrap wall); 36px controls → 44px; `nowrap` leak neutralised via `.nowrap-cell`; anomalies virtualised; `PrevisitView` gets the share-sheet export and a phone card list for the 736px Total tab. |
| 5 Scanner | DONE | Popup → sheet z-index 90 with an 84px tab-bar offset; queue recovery unified in `QueueRecoveryBar` (ScannerPage + InchargeScannerPage parity); stranded widget in `DeptInchargePage` deleted (45 lines of DOM-built markup); landscape camera/tab-nav rules; feed announces only the newest scan; `vibrate()` on scan result. |
| 6 Dept-incharge | DONE | Matrix toolbar → filter sheet; 44px scan-day input; `AttendanceMatrix` Badge cell is a 44px button opening a `QuickPeekSheet`; `DeptInchargePage` gains the `ScanModeShell` phone branch. |
| 7 Nav wiring | DONE | `liveScanners` + `deptIncharge` registered in `PAGES` and routed in `App.jsx`; `LiveScannersPage` given the mobile treatment it never had (filter sheet, share-sheet export, 44px search, skeleton) so wiring it did not ship a broken page. |
| 8 Coverage | DONE | `mobile-device-tiers.spec.js` + `pwa-app-shell.spec.js`; `mobile-pwa` project on `vite preview`; `pwa-shell` CI job; CONTEXT.md mobile section rewritten. |

### Defects the new tests caught (and fixed)

1. **Landscape phones got the desktop app.** The `@media (min-width: 769px)` "belt & braces" guard hid `.mobile-tabbar` — contradicting the new `MOBILE_QUERY`. Now `and (min-height: 501px)`, plus an `orientation: landscape and (max-height: 500px)` block that hides `.tab-nav`.
2. **64px horizontal page scroll at 320px.** `.app-header` lead row had inline `flexShrink: 0` and no `min-width`, so the schedule select refused to compress, widened the document, and (under mobile emulation) dragged the fixed tab bar out with it. Replaced by `.app-header-lead` (`flex: 1 1 auto; min-width: 0`).
3. **The offline banner was missing on the screens that need it most.** It lived inside the authenticated shell, so it never appeared on the login or profile-failure screens. Moved to `main.jsx`.

### Verification actually run

- `npm run lint` → 0 errors (6 pre-existing `react-refresh` warnings).
- `npm test` → **47 files, 1162 tests, all passing** (new: `AttendanceCards`, `QueueRecoveryBar`, `AttendanceMatrix`, `primitives`, `interactions`, `SwUpdatePrompt`, plus tier/coverage additions to `useMediaQuery`/`mobile`).
- `npm run build` → succeeds; `dist/sw.js` emitted with the precache manifest.
- `npx playwright test --project=mobile-chrome --project=mobile-safari` → **14 passed**.
- `npx playwright test --project=mobile-pwa` → **4 passed** (against a production `vite preview` build).


---

## 11. Follow-up changes (2026-10-03, after the A–Z build)

Requested directly by the user, on top of Phases 0–8.

| Change | What shipped |
|---|---|
| Reports cards → tables | New `.rows-on-phone` + `.table-wrap-rows` in `index.css` (≤768 only): real `table`/`table-row`/`table-cell`, pinned Badge column, pinned header, compact nowrap `tabular-nums` cells. Applied to `ReportsPage` (both tables) and `PrevisitView` (Attention sections + Present register). Added `scope="col"` and `sr-only` captions throughout. |
| Previsit Total tab | The `isMobile ? <VirtualList cards> : <table>` branch was **deleted** — phones render the same `.att-scroll`/`.att-table` grid as the laptop. `VirtualList` import dropped. |
| Export PDF | `src/components/PrintPdfButton.jsx` (browser Print-to-PDF, zero deps) beside every Export Excel on the 7 attendance/report pages, plus a button inside `ExportSheet` for all 8 mobile consumers. Label unified to **"Export PDF"**; `@media print` block added (chrome stripped, tables forced with `!important`, sticky reset, `break-inside: avoid`). |
| Dept Lists page | Removed from the nav only: `src/lib/pages.js` entry + `src/App.jsx` branch (+ unused `UserCheck` import). Page file and tests kept. |

### Defects caught while building

1. **An `aria-label` on the PDF button silently overrode the accessible name**, so `getByRole('button', { name: /Export PDF/ })` could not find it — and the component deferred `window.print()` behind two `requestAnimationFrame`s, which made it unassertable in tests and unobservably late for the user. Fixed: no redundant `aria-label` (the visible text is the name), and print is synchronous unless there is an overlay to dismiss first.
2. **The negative control in the new e2e caught my own wrong expectation**: collapsed cells are `flex`, not `block` (`.table tbody td` in the collapse rule is a label/value flex row), not `block`.

### Verification

- `npm run lint` → 0 errors. `npm test` → 47 files / **1168 passing**. `npm run test:coverage` → 0 threshold errors. `npm run build` → OK.
- `npx playwright test` → **32 passed, 4 failed** — the 4 are the documented pre-existing `queue-matrix` M1/M7/M9/M12 rot (M1 seeds 200 rows against `MAX_QUEUE_SIZE = 2000`; `git diff` shows `offlineQueue.js` only gained two additive predicate exports).
- New `tests/e2e/mobile-report-table.spec.js` → **4 passed** (Chromium + WebKit).
