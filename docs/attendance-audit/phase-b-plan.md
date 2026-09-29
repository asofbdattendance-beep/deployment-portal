# Phase B — Scanner capture-path integrity (plan)

> Scope confirmed by user 2026-09-29 ("Phase - b"). Shared-hook decision delegated to implementer: YES — extract a minimal `useScannerSession` in task 3 (see below).

Bands covered: Scanner UI / camera / pages (L-12, L-14–L-23, L-39, L-41–L-48) + scan-path remainder (L-19 residual, L-36). Reporting (L-06/10/11/24-35/38/40/45/49-56, needs `sql/v49`) is Phase C. T2 rig is Phase D.

## Task 1: camera-core — DONE (commit pending)
L-14/15/20/21/22. `enginePool.js` (extracted from `BarcodeScanner.jsx`): `armFallback` + ready-only landing; ZXing `getResultPoints` → cornerPoints. `scannerUtils.js`: `isEdgeDetection` (≥2 pts), `rgbaToGray` scratch reuse. `startScanner`: full detection-state reset + remount-tolerant video wait; `ensureEngines` re-arms watchdog clock. 16 new tests, 705 green. Dropped: "iOS 3-strike breaker" (does not exist). Reframed L-22 (Retry-dead, not the watchdog return).

## Task 2: camera-a11y — L-16/17/18
`BarcodeScanner.jsx` + `computeRoi`: tap-to-focus role/label/tabIndex/keyboard; torch keeps a subject label + aria-hidden icon; reconcile guide-box (margin 24) with ROI (0.92×0.62). Depends: 1. Verify: `BarcodeScanner.test.jsx` + manual SR pass.

## Task 3: forgot-out-parity — L-36/47/48
Route both pages' forgot-OUT through `handleScan` (offline enqueue); store+cancel the 200ms follow-up timer; auto-dismiss queued/error; add queued+error to `isDecisionPopup`. **Extract `useScannerSession`** (popup state, auto-dismiss, offline flags, drain progress) shared by `ScannerPage`/`DeptInchargePage` — minimal: session/popup/queue state only, not page layout. Rationale: 8 defects hit both pages; they already drifted once (`in_date` vs event-date `or()`). Depends: 1, 2. Verify: `scannerUtils.test.js`, `useScanHandler.test.jsx`, new hook tests.

## Task 4: popup-contract — L-39/12
Gate the ">12h open" pill + destructive action on the Already-IN refetch path (`useScanHandler.js:553-562`); stop `queued` rendering two identical "Done" buttons (`ScanResultPopup.jsx`). Depends: —. Verify: `useScanHandler.test.jsx`, `ScanResultPopup.test.jsx`.

## Task 5: page-state — L-41/42/43/44/46
Overnight filter parity (event-date `or()` both pages); poll on Incharge; real `setOffline(false)`; call `setSyncing(true)`; make "Camera paused" actually pause (imperative handle + ref — `BarcodeScanner` already exposes restart/stop; extend or reuse). Files: both pages. Depends: 3. Verify: new page tests.

## Task 6: page-tests — L-23
`ScannerPage.test.jsx` + `DeptInchargePage.test.jsx` pinning tasks 3–5. Depends: 3, 4, 5.

## Deferred
- L-19 abort-signal propagation (changes RPC call shape; own task).
- L-07 version handshake (cross-cutting; own phase).
- L-13 remainder: MAX_QUEUE_SIZE/backoff/quarantine/listeners/TTL closed in Phase A; page coverage closes in task 6.
