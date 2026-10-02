# Mobile-first attendance — design spec (2026-10-02)

Mode: **Operate** (task completion on phones). Desktop ≥769px is byte-identical;
every mobile behaviour below activates at ≤768px only.

## 1. Breakpoint contract

- One hook owns all structural swaps: `useIsMobile()` (`src/hooks/useMediaQuery.js`,
  SSR-safe, `false` when `matchMedia` is missing). New constant `MOBILE_QUERY`.
- CSS uses `@media (max-width: 768px)` for shell/capture/filter/export chrome and
  keeps the existing `@media (max-width: 640px)` card-collapse for tables.
- `PAGES` (`src/lib/pages.js`) stays the single source for navbar, bottom bar,
  `document.title`, and the Users matrix — the bar flattens the same
  `visiblePages`, never a fork.

## 2. Shell: bottom tab bar + More sheet

- `MobileTabBar`: 5 primary destinations per role + `More` (first 4 + More when
  overflowing; no More affordance when everything fits). 56px targets, safe-area
  bottom inset, `aria-current="page"`, More announces its count and highlights
  when an overflow page is active.
- `MoreSheet`: focus-trapped bottom sheet, ESC/backdrop/drag-close, scroll lock,
  focus restore, 150ms slide-up (none under `prefers-reduced-motion`).
- `App.jsx` renders both only when `useIsMobile()`; `main` gets bottom padding
  for the fixed bar. `.tab-nav` hides at ≤768px via CSS.
- Shared dialog discipline extracted as `useBottomSheet()` (FilterSheet,
  ExportSheet); MoreSheet predates it and keeps its inline copy.

## 3. Capture: immersive scan shell

- `ScanModeShell`: 100dvh column (header → camera → 56px Mark action → manual
  entry → feed), safe-area, Wake Lock while mounted (re-acquired on visible).
  Takes the pages' existing nodes as slots — the IN/OUT state machine,
  offline queue, and popup wiring are untouched and shared with desktop.
- `MobileScanFeed`: one card per sewadar (badge/name/dept/IN→OUT, In/Out pill,
  VSS/Flagged pills), `aria-live`, no horizontal scroll. `RecentScansTable`
  keeps its `.table` opt-out for desktop.
- `BarcodeScanner`: releases the camera on tab-hide (privacy LED + battery;
  visible branch re-acquires), `46dvh` viewfinder on phones, wrapped guidance,
  44px torch, init spinner. Desktop viewfinder/overlay unchanged.
- `ScanResultPopup`: bottom sheet + drag handle + 44px close on phones; centred
  modal with the same focus trap on desktop.
- Manual inputs carry `inputMode/enterKeyHint/autoComplete off/autoCapitalize/
  spellCheck off` + `aria-label`; 16px type on phones kills iOS zoom-on-focus.

## 4. Reports: labelled cards + filter sheet

- Every attendance `<td>` carries `data-label` (Attendance 3 tables, incharge
  roster, both Dashboard tfoots, previsit dept table) — inert on desktop,
  labelled cards at ≤640px.
- Card-mode hardening: sticky panes go static, `previsit-table` min-width
  cleared, 44px in-card buttons.
- `MobileFilterBar` (sticky; Filters button with active-count badge, scrollable
  clearable chips, result count) + `FilterSheet` hosting the page's EXISTING
  filter JSX unchanged — one state, two layouts. Adopted in AttendancePage;
  previsit-toolbar pages (Reports/Anomalies) were already mobile-adequate.
- KPI tiles render 2-col on phones via a scoped `!important` that beats the
  pages' inline `gridTemplateColumns` (the old ≤480px rule was dead).

## 5. Export: gesture-safe share sheet

- `exportWorkbookBlob` / `workbookToBlob` / `saveBlob` (`excel.js`) and
  `buildAttendanceBlob` (`attendanceExcel.js`): builders return Blobs, never
  trigger downloads. Desktop `exportWorkbook`/`exportAttendanceWorkbook`
  behaviour is unchanged (verified by the rewritten C2 specs).
- `useExport`: `prepare(buildFn)` on the Export tap (opens the sheet),
  `deliver()` on the explicit Share/Save tap — the Web Share call always
  carries a fresh user gesture (an awaited build would lose it on iOS).
  Empty workbooks surface as "Nothing to export", never an empty file.
- `ExportSheet`: building → file (name/size) → Share (when `canShare`) /
  Save / Print-to-PDF → delivered confirmation / error + retry.
- Dashboard snapshot combines Present + Absent into one 4-sheet workbook on
  phones (one share instead of two downloads); per-list buttons share singly.

## 6. PWA + offline

- `viewport-fit=cover` (activates all safe-area insets), standalone-capable
  meta, light/dark `theme-color`, `manifest.webmanifest` + PNG icons
  (192/512/maskable via sips from `favicon.svg`, apple-touch-icon 180).
- `sw.js` deliberately stays cache-free (install/activate/sync only) — a bad
  service worker is sticky for users; precaching hashed Vite assets without a
  build-time manifest is a follow-up, not this change.

## 7. Verification

- `npm run lint` (0 errors), `npm test` (42 files / 1110 tests),
  `npm run test:coverage` (gates pass; ScannerPage branches 63% vs 58% floor
  via the new mobile-shell render pin), `npm run build`.
- Playwright: `mobile-chrome` (Pixel 5) + `mobile-safari` (iPhone 13) projects,
  `testMatch: mobile-*.spec.js`; chromium ignores mobile specs. WebKit runs
  against plain-HTTP vite on 5174 (`DISABLE_TLS=1` in `vite.config.js`) because
  WebKit blocks the plain-HTTP mock API from HTTPS pages (mixed content).
- Desktop e2e locators hardened (dialog-scoped exact `Mark IN/OUT`) — the bare
  matcher also matched the pages' own "Mark In/Out" action.
- `e2e-mobile` CI job (chromium + webkit install, both mobile projects).
- Known pre-existing rot: M1/M7/M9/M12 fail identically on pristine main
  (verified via worktree); e2e was never in CI.
