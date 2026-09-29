# Phase B — Scanner capture-path integrity (plan)

> Scope confirmed by user 2026-09-29 ("Phase - b"). Shared-hook decision delegated to implementer: YES — extract a minimal `useScannerSession` in task 3 (see below).

Bands covered: Scanner UI / camera / pages (L-12, L-14–L-23, L-39, L-41–L-48) + scan-path remainder (L-19 residual, L-36). Reporting (L-06/10/11/24-35/38/40/45/49-56, needs `sql/v49`) is Phase C. T2 rig is Phase D.

## Task 1: camera-core — DONE (commit pending)
L-14/15/20/21/22. `enginePool.js` (extracted from `BarcodeScanner.jsx`): `armFallback` + ready-only landing; ZXing `getResultPoints` → cornerPoints. `scannerUtils.js`: `isEdgeDetection` (≥2 pts), `rgbaToGray` scratch reuse. `startScanner`: full detection-state reset + remount-tolerant video wait; `ensureEngines` re-arms watchdog clock. 16 new tests, 705 green. Dropped: "iOS 3-strike breaker" (does not exist). Reframed L-22 (Retry-dead, not the watchdog return).

## Task 2: camera-a11y — L-16/17/18
`BarcodeScanner.jsx` + `computeRoi`: tap-to-focus role/label/tabIndex/keyboard; torch keeps a subject label + aria-hidden icon; reconcile guide-box (margin 24) with ROI (0.92×0.62). Depends: 1. Verify: `BarcodeScanner.test.jsx` + manual SR pass.

## Task 3: forgot-out-parity — L-36/47/48 — DONE (core; extraction deferred, see task 5)

Hook exports `submitForgotOut` (same RPC attempt + offline enqueue as the
main OUT flow, via shared `enqueueOutFallback`); both pages route their
forgot confirm through it. Follow-up re-scan timer stored in a ref and
cleared on unmount (L-47). `queued` joins the auto-dismiss list (L-48).

Deliberate deviations: `isDecisionPopup` left UNTOUCHED — `error` exclusion
is v44 design (those paths ask for a re-scan; gating would block it) and
gating `queued` would drop rapid offline scans for 2.5s each. Extraction of
`useScannerSession` deferred to ride with task 5 (same regions, one
restructure instead of two).

## Task 4: popup-contract — L-39/12
Gate the ">12h open" pill + destructive action on the Already-IN refetch path (`useScanHandler.js:553-562`); stop `queued` rendering two identical "Done" buttons (`ScanResultPopup.jsx`). Depends: —. Verify: `useScanHandler.test.jsx`, `ScanResultPopup.test.jsx`.

## Task 5: page-state — L-41/42/43/44/46 (+ useScannerSession extraction) — DONE

New `src/hooks/useScannerSession.js` owns popup/outTime/queued/syncing,
drain subscription, scan entry points, and the camera pause/resume effect;
both pages rewired onto it (loads/lists/tabs/render stay in pages).
L-41: ScannerPage uses the event-date `or()` predicate. L-42: Incharge
polls sessions (light `refreshSessions`, never the full load) every 15s.
L-43: Incharge load sets/clears the offline pin. L-44: `refreshQueue`
raises `syncing` while rows pend. L-46: decision popups pause the decode
loop via new `pause()`/`resume()` on BarcodeScanner's imperative handle
(resume guarded against double chains + dead streams). real `setOffline(false)`; call `setSyncing(true)`; make "Camera paused" actually pause (imperative handle + ref — `BarcodeScanner` already exposes restart/stop; extend or reuse). Files: both pages. Depends: 3. Verify: new page tests.

## Task 6: page-tests — L-23 — DONE

`ScannerPage.test.jsx` (L-41 event-date predicate + render) and
`DeptInchargePage.test.jsx` (incharge gate, L-43 offline pin on/off,
L-42 15s session poll) close L-23 for the scanner pages; pause/resume
transition pins live in `useScannerSession.test.jsx`. Both L-41 and L-42
pins were mutation-checked (predicate reverted / interval removed → red).
Full-page scan-flow choreography stays covered at the hook/popup unit
level by design — the page files own queries, pins, and render only.

## Deferred
- L-19 abort-signal propagation (changes RPC call shape; own task).
- L-07 version handshake (cross-cutting; own phase).
- L-13 remainder: MAX_QUEUE_SIZE/backoff/quarantine/listeners/TTL closed in Phase A; page coverage closes in task 6.
