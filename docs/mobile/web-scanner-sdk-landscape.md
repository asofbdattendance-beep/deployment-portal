# Web barcode scanner SDK landscape: architecture, from primary sources

Research date: 2026-11-10. Scope: browser-based (web) barcode scanning SDKs and libraries, compared against our React PWA scanner, which reads dense Code 39 staff badges such as `FB5978GA0013` with a narrow bar of about 0.2 mm.

## How to read this document

- **Sources.** Only primary sources were used: vendor documentation, API references, official READMEs and changelogs, the vendors' own shipped npm package code, W3C/WICG specs, and Chromium or WebKit source and bug trackers. Every factual claim has an inline link.
- **"Observed in shipped package code".** Several commercial SDKs document very little of their internals. For those, I downloaded the vendor's published npm package (the exact version is named) and read its JavaScript, which is usually minified. This is primary evidence of what that version does, but it is not a documented contract and can change in any release. The wording "observed in `<package>@<version>`" marks these claims.
- **"Not publicly documented".** I use this when I found neither docs nor shipped code that settles a question. It means "not found", not "does not exist".
- **WebKit flags.** Values come from WebKit's `main` branch, which is not necessarily the shipping Safari. `main` was at commit `5f21a57` when I read it.

---

## 1. Summary table

Legend: Y = yes, N = no, P = partial or conditional, ? = not publicly documented.

| Product (version inspected) | Engine / runtime | Decode off main thread | WASM SIMD / threads | GPU preprocessing | ML localization / deblur | Default resolution | iOS multi-camera choice | Frame loop | Photo / native-camera fallback | Multi-frame confirm (1D) |
|---|---|---|---|---|---|---|---|---|---|---|
| **Scandit Web SDK** 8.7.0 (v6/v7 lineage) | Proprietary C++ to WASM, about 8.4 MB per variant ([pkg](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/)) | Y, Web Worker ([req](https://docs.scandit.com/sdks/web/system-requirements/)) | Y: 4 builds (plain / simd / pthreads / simd-pthreads); threads only when cross-origin isolated ([pkg](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/), [compat](https://docs.scandit.com/data-capture-sdk/web/core/api/web/browser-compatibility.html)) | Y: WebGL grayscale shader, then `readPixels` ([code](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/FrameReaders/GrayScaleFrameReader.js)) | Y: ships `.model` files for barcode localization and 1D scanline reconstruction ([pkg](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/resources/models/)) | `HD` 1280x720 ([docs](https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html)) | Prefers "Back Dual Wide Camera", then "Back Camera"; localized label tables ([code](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraAccess.js)) | rVFC, falling back to rAF ([code](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)) | Y: Single Image Mode / uploader ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)) | Y: `ScanIntention.Smart` ([docs](https://docs.scandit.com/data-capture-sdk/web/barcode-capture/api/barcode-capture-settings.html)) |
| **Dynamsoft DBR JS** 11.6.5000 + **DCE** 4.1.1 | Proprietary to WASM, 5.1 to 8.6 MB per variant ([pkg](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/)) | Y, Web Worker ([sysreq](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html), [code](https://unpkg.com/dynamsoft-barcode-reader-bundle@11.6.5000/dist/dbr.bundle.worker.js)) | Y: `baseline` / `ml-simd` / `ml-simd-pthread`; pthread only when `crossOriginIsolated` ([code](https://unpkg.com/dynamsoft-barcode-reader-bundle@11.6.5000/dist/dbr.bundle.worker.js)) | Y: optional WebGL draw path ([code](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)) | Y: `OneDLocalization`, `OneDDeblur`, `Code39ITFDecoder` models ([pkg](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/models/)) | ? | Prefers Dual-Wide (localized), else "back camera" ([code](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)) | ? | Y: `takePhoto()` uses `<input type=file capture>` ([code](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)) | Y: `enableResultCrossVerification` ([guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)) |
| **STRICH** 1.18.0 | Proprietary to WASM, inlined in a 542 KB JS file ([pkg](https://unpkg.com/browse/@pixelverse/strichjs-sdk@1.18.0/dist/)) | **N**: no Worker in the bundle ([code](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)) | SIMD "planned", not shipped ([changelog](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)) | Y: **WebGL2 is required** for the GPU locator, with async PBO readback ([d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts), [changelog](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)) | GPU locator; ML not documented | 720p `hd` ([d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)) | "Back Dual Wide Camera" (localized) ([changelog](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md), [code](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)) | rVFC, falling back to rAF ([code](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)) | `ImageScanner` for stills ([changelog](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)) | Y: `hysteresisMinCount` 2 in 350 ms ([d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)) |
| **Scanbot Web SDK** 10.0.0 | Proprietary to WASM, 10.5 to 11.1 MB (barcode) ([pkg](https://unpkg.com/browse/scanbot-web-sdk@10.0.0/bundle/bin/barcode-scanner/)) | Y, Web Worker ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | Y: plain / simd / simd-threads; warns when not cross-origin isolated ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | WebGL frame reader present ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | ? | 1920x1080 ideal ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | Ranks by torch support and max pixels; special-cases "Back Triple Camera" ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | ? | `ImageCapture.takePhoto` path (opt-in) ([code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)) | ? |
| **Cognex cmbWEB** 1.5.5 (published 2024-06-13) | Manatee/Cognex decoder to WASM, inlined in a 1.8 MB JS file ([pkg](https://unpkg.com/browse/cmbsdk-cmbweb@1.5.5/)) | **N**: no Worker observed ([code](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)) | ? | ? | ? | 1280x720 ideal (min 640x480, max 1920x1080) ([code](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)) | "USE_BEST_CAMERA" option; heuristic undocumented ([config](https://unpkg.com/cmbsdk-cmbweb@1.5.5/MWBConfig_wa.js)) | ? | `scanImage()` ([config](https://unpkg.com/cmbsdk-cmbweb@1.5.5/MWBConfig_wa.js)) | ? |
| **Anyline Web SDK** 56.6.0 | Proprietary to WASM + `.data` models ([pkg](https://unpkg.com/browse/@anyline/anyline-js@56.6.0/anylinejs/)) | Y, Web Worker ([code](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)) | Ships a `_simd` build ([pkg](https://unpkg.com/browse/@anyline/anyline-js@56.6.0/anylinejs/)) | ? | Model data files (`data_barcode.data`) ([pkg](https://unpkg.com/browse/@anyline/anyline-js@56.6.0/anylinejs/)) | 1920x1080 ideal ([code](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)) | Localized "back camera" labels; Android `camera2? N, facing back` regex ([code](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)) | ? | ? | ? |
| **zxing-wasm** (Sec-ant) v3.1.x | zxing-cpp to WASM, reader about 1.04 MiB ([README](https://github.com/Sec-ant/zxing-wasm)) | You decide (works anywhere WASM runs) | Not mentioned in the README ([README](https://github.com/Sec-ant/zxing-wasm)) | N | N | n/a (decoder only) | n/a | n/a | n/a | `minLineCount` 2 within a frame ([src](https://github.com/Sec-ant/zxing-wasm/blob/main/src/bindings/readerOptions.ts)) |
| **@zxing/library + @zxing/browser** | Pure TypeScript port of Java ZXing; **maintenance mode** ([README](https://github.com/zxing-js/library)) | N | n/a | N | N | `facingMode: environment`, no resolution set ([src](https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts)) | n/a | `setTimeout`, 500 ms between attempts ([src](https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts)) | `decodeFromImage*` ([README](https://github.com/zxing-js/browser)) | N |
| **html5-qrcode** | Wraps zxing-js; experimental native BarcodeDetector path; **maintenance mode** ([README](https://github.com/mebjas/html5-qrcode)) | N | n/a | N | N | ? | n/a | `fps` (default 2) ([README](https://github.com/mebjas/html5-qrcode)) | Y: file scan ([README](https://github.com/mebjas/html5-qrcode)) | N |
| **quagga2** | Pure JS; 1D-only locator + readers ([README](https://github.com/ericblade/quagga2)) | Unclear (README mentions `numOfWorkers`) | n/a | N | Classic CV locator (patches/skeleton) | set via `constraints` | n/a | `frequency` cap ([README](https://github.com/ericblade/quagga2)) | `decodeSingle` ([README](https://github.com/ericblade/quagga2)) | N; README advises app-level validation |
| **zbar-wasm** (undecaf) | ZBar C to WASM, about 330 kB ([README](https://github.com/undecaf/zbar-wasm)) | Can run in workers ([README](https://github.com/undecaf/zbar-wasm)) | ? | N | N | n/a | n/a | n/a | n/a | N |
| **BarcodeDetector** (native) | Android: GMS Vision; macOS: Apple Vision; Chrome-branded Win/Linux/ChromeOS: internal "Barhopper" library ([service.cc](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/shape_detection_service.cc)) | Exposed in Workers ([spec](https://wicg.github.io/shape-detection-api/)) | n/a | OS-dependent | OS-dependent | n/a | n/a | n/a | n/a | N |
| **barcode-detector** polyfill (Sec-ant) | zxing-wasm behind the BarcodeDetector API ([README](https://github.com/Sec-ant/barcode-detector)) | You decide | as zxing-wasm | N | N | n/a | n/a | n/a | n/a | N |

---

## 2. Commercial SDKs

### 2.1 Scandit Web SDK (v6, v7, and current v8.7)

**Versions and packaging**
- The current stable documentation covers Web SDK **8.7.0** ([system requirements](https://docs.scandit.com/sdks/web/system-requirements/)). v6/v7 belong to the same `scandit-web-datacapture-*` lineage. The last 6.x build of the unscoped core package is `6.28.11` (npm `scandit-web-datacapture-core`), and the scoped `@scandit/web-datacapture-core` is at `8.7.0` (npm registry, checked 2026-11-10).
- The older **v5** package (`scandit-sdk`) is marked superseded and has more readable source, so it is cited below for legacy behavior ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)).

**Camera handling**
- **Resolution.** `CameraSettings.preferredResolution` defaults to `HD` (1280x720). The other values are `FullHd` and `Uhd4k`, and 4K is license-gated ([CameraSettings](https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html)).
- **Constraint ladder.** Observed in `@scandit/web-datacapture-core@8.7.0`, the ladder runs from UHD through FHD and HD to SD. Each step uses `min`/`ideal`/`max` windows (for example FHD width `{min:1440, ideal:1920 (1440 for 4:3), max:2160}`), plus `resizeMode: 'none'` and `frameRate: {ideal: 30}` ([CameraAccess.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraAccess.js)). On failure the next lower step is tried ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)). v5 used the same ladder ([v5 cameraAccess.js](https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/cameraAccess.js)).
- **Camera choice.** `Camera.pickBestGuess()` and `pickBestGuessForPosition()` "employ heuristics", and the docs warn that "web cameras do not always have meaningful metadata" ([Camera API](https://docs.scandit.com/data-capture-sdk/web/core/api/camera.html)). The code (8.7.0) does the following ([CameraAccess.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraAccess.js)):
  - It keeps **localized label sets** for iOS "Back Dual Wide Camera", "Back Ultra Wide Camera", "Back Camera" and the front camera, in about 30 languages.
  - On iOS the main rear camera is the **Dual Wide** if present, else the plain "Back Camera".
  - If no labels are available, it assumes front-to-back order and takes the **last** device as the main rear camera.
  - On Android with labels, it sorts by `localeCompare` and takes the first.
  - v5 had the same logic, including a camera field-of-view switcher for iOS wide/ultra-wide ([v5 cameraManager.js](https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/barcodePicker/cameraManager.js)).
- **Recovery.** It listens for track `ended`, `mute` and `unmute` and shows a "camera recovery" UI on mute ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)).

**Focus, zoom and torch**
- **Tap-to-focus** (8.7.0): if `focusMode` capabilities include `continuous` and `manual`, it applies `manual` with a `focusDistance` mapped from 0 to 1 onto the capability range. It then returns to `continuous` after 5 s (`manualToAutofocusResumeTimeoutMs=5e3`; `manualFocusWaitTimeoutMs=400`). On single-shot-only cameras it re-triggers `single-shot` every 1.5 s (`autofocusIntervalMs=1500`) ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)).
- **FocusGestureStrategy** values are `None`, `Manual`, `ManualUntilCapture` and `AutoOnLocation` ([CameraSettings](https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html)).
- **Zoom.** `zoomFactor` defaults to 1.0, and `zoomLevels` defaults to `[1, 2]`, filtered by hardware ([CameraSettings](https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html)).
- **Torch.** The docs say `isTorchAvailable()` is "available only on Chrome Android" ([Camera API](https://docs.scandit.com/data-capture-sdk/web/core/api/camera.html)). Compare §4.1: WebKit now exposes `torch`.
- **Legacy note.** The v5 README said Chrome was "the only browser to support manual camera focus operations" ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)).

**Frame pipeline**
- **Loop.** It is driven by `requestVideoFrameCallback` when available, otherwise rAF ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)).
- **GPU grayscale.** The `GrayScaleFrameReader` uploads the `<video>` as a WebGL texture, converts it to **grayscale on the GPU**, and `readPixels` the result, which is 1/4 of the bytes of RGBA. It falls back to RGBA when the video width is not divisible by 4 ([GrayScaleFrameReader.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/FrameReaders/GrayScaleFrameReader.js)).
- **Fallback.** Without WebGL it uses a 2D canvas plus `getImageData` ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)).
- **Shared memory.** A `SharedFrameMemAddressSlotPool` uses SharedArrayBuffer for frames when available ([package file](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/SharedFrameMemAddressSlotPool.js)).
- **WebGL sanity check.** v5 checked WebGL output for a bad alpha channel and fell back to canvas, logging "Detected incorrect GPU accelerated WebGL image processing" ([v5 gui.js](https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/barcodePicker/gui.js)).

**Threading and runtime**
- **Required APIs:** Blob, WebAssembly, `URL.createObjectURL`, **Web Workers**.
- **Optional APIs:** OffscreenCanvas ("GPU acceleration in a Web Worker"), WebGL, WASM SIMD.
- **SharedArrayBuffer** is "required for simultaneous multiple barcode tracking" ([system requirements](https://docs.scandit.com/sdks/web/system-requirements/)).
- **`BrowserHelper.checkMultithreadingSupport()`** checks SharedArrayBuffer, cross-origin isolation and nested workers ([browser compatibility](https://docs.scandit.com/data-capture-sdk/web/core/api/web/browser-compatibility.html)).
- **Engine builds.** The `sdc-lib` folder ships `scandit-datacapture-sdk-barcode{,-simd,-pthreads,-simd-pthreads}.wasm`, each about **8.4 to 8.5 MB** uncompressed. It also ships many neural-net `.model` files, for example `barcode_localization_default`, `barcode_1d_scanlines_reconstruction`, `barcode_localization_clutter_aware` and `barcode_label_localization_mslc_model_smartphone` ([sdc-lib](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/), [models](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/resources/models/)).
- **Hosting and caching.** Self-host `sdc-lib`, serve `.wasm` as `application/wasm`, send `Content-Length`, and for PWAs use Workbox NetworkFirst caching with a 30-day max age ([add SDK](https://docs.scandit.com/sdks/web/add-sdk/)).
- **v5 detail.** v5 picked the SIMD engine with a `WebAssembly.validate` probe and verified the wasm by SHA-256 hash ([v5 dataCaptureWorker.js](https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/workers/dataCaptureWorker.js)).

**Accuracy and robustness**
- **Code 39** (Scandit symbology table):
  - No mandatory checksum; optional `mod43`.
  - Default active symbol count 6 to 40, including 2 guards; supported range 3 to 50.
  - Colour-inverted reading is supported but off by default.
  - Extensions: `full_ascii`; `relaxed_sharp_quiet_zone_check` ("may increase false positives"); and `strict` ("reduce false positives on blurry or damaged codes, at the cost of scan performance") ([symbologies](https://docs.scandit.com/preview/c_api/symbologies.html)).
  - The web docs say enforcing the optional checksum reduces false positives, and that `full_ascii` is off by default because "it can lead to false reads" ([configure symbologies](https://docs.scandit.com/sdks/web/barcode-capture/configure-barcode-symbologies/)).
  - Our badge `FB5978GA0013` is 12 data symbols plus 2 guards = 14, inside the default range.
- **Duplicates and confirmation.** `codeDuplicateFilter` defaults to `-2`, which means 1.5 s with Manual intention or the Smart Duplicate Filter with Smart intention. `ScanIntention.Smart` requires a code to be "observed across several frames" before it is returned ([BarcodeCaptureSettings](https://docs.scandit.com/data-capture-sdk/web/barcode-capture/api/barcode-capture-settings.html)).
- **Minimum module size and scanning distance:** not publicly documented in the web docs I read.

**Platform support (8.7)**
- Minimums: Chrome / Edge / Chrome Android 85+; Firefox / Firefox Android 105+; Safari 15.2+ (threads) / 14.6+ (single thread); Safari iOS and Chrome iOS 16.4+ (threads) / 14.6+; Samsung Internet 15+ / 7+.
- **Android WebView: no threads**, single-thread "Yes".
- From 8.8, Safari 16.4+ is required ([system requirements](https://docs.scandit.com/sdks/web/system-requirements/)).
- **WebView guidance.**
  - Android WebView needs a native `onPermissionRequest` grant and has **no multithreading** (no cross-origin isolation or SAB), so MatrixScan runs "significantly slower".
  - WKWebView needs `NSCameraUsageDescription` plus `WKUIDelegate` media-capture handling ([WebView guide](https://docs.scandit.com/sdks/web/webview/)).
- **In-app browsers** (WhatsApp, Instagram, Facebook): not publicly documented.
- **Legacy iOS bug.** v5 documented a WebAssembly crash on iOS 11.2.2 to 11.2.6, and said "iOS 13.4+ / 14.3+ [are] required for camera video streaming in PWAs / Chrome, Firefox or webviews" ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)).

**UX**
- `BarcodeCaptureOverlay` highlights results ([get started](https://docs.scandit.com/sdks/web/barcode-capture/get-started/)).
- Sound uses Web Audio through an internal Howler copy, and vibration uses `navigator.vibrate` (files `customHowler/*`, `Vibration.js` in [core 8.7.0](https://unpkg.com/browse/@scandit/web-datacapture-core@8.7.0/build/js/)).
- v5 offered Single Image Mode as a fallback "when video streaming is blocked" ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)).
- Keyboard-wedge hardware scanners: not publicly documented.

**Benchmarks:** none with a methodology found in the primary docs I read.

### 2.2 Dynamsoft Barcode Reader JS (11.6.5000) + Dynamsoft Camera Enhancer (4.1.1)

**Architecture**
- `CaptureVisionRouter` takes frames from an image source (`CameraEnhancer`), runs a template, and sends results to receivers and filters ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
- Engine files (`*.worker.js`, `*.wasm.js`, `*.wasm`) load from `engineResourcePaths.rootDirectory`, the CDN by default. Self-hosting needs `application/wasm`. `CoreModule.loadWasm()` preloads ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
- **Required:** WebAssembly, Blob, `URL.createObjectURL`, **Web Workers**, and getUserMedia for video ([system requirements](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html)).
- **Engine builds** (`dist/`): `dynamsoft-barcode-reader-bundle.wasm` (baseline, 5.1 MB), `-ml-simd.wasm` (6.7 MB), `-ml-simd-pthread.wasm` (6.7 MB), plus `-with-pdf` variants ([dist](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/)).
- **Variant choice.** The worker validates SIMD with a `WebAssembly.validate` probe and only picks `-ml-simd-pthread` when it is requested **and** `crossOriginIsolated` is true. Otherwise the default is `-ml-simd` ([dbr.bundle.worker.js](https://unpkg.com/dynamsoft-barcode-reader-bundle@11.6.5000/dist/dbr.bundle.worker.js)).
- **Neural models** in `dist/models/`: `OneDLocalization.data` (1.1 MB), `OneDDeblur.data` (1.8 MB), **`Code39ITFDecoder.data` (1.3 MB)**, `Code128Decoder.data`, `EAN13Decoder.data`, plus 2D localization and deblur ([models](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/models/)). This is a dedicated ML decoder for Code 39 / ITF, which is directly relevant to our badges.

**Camera handling** (observed in [`dce.esm.js` 4.1.1](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js))
- **`findBestRearCamera`:**
  - On iOS/iPadOS/macOS it looks for a **Dual-Wide** camera through a localized keyword list ("dual wide", "dual-weitwinkel", "doble", and so on), else a localized "back camera".
  - On Android/HarmonyOS it picks a back-labelled camera whose label matches `/\b0\b/`, so "camera 0, facing back", else the **last** device.
- **Resolution probing.** It walks a list of `detectedResolutions` with `applyConstraints({width:{ideal}, height:{ideal}})` and records what the track actually delivers.
- **Persistence.** It remembers the last-used camera in localStorage (`ifSaveLastUsedCamera`).

**Focus, zoom and torch** (same file)
- **`setFocus({mode, ...})`** validates against `getCapabilities().focusMode` and `focusDistance`.
- **Focus parameters:** `maxTimeout:400`, `minTimeout:300`, `focusBackToContinousTime:5e3`, `defaultFocusAreaSizeRatio:6`, `tapFocusMin/MaxDistance`. The timeout is scaled by inverse focus distance, which suggests a manual focus-distance sweep scored on a focus area.
- **Enhanced features** (`enableEnhancedFeatures`, license-gated):
  - `enhancedFocus`, `autoZoom` and `tapToFocus` exist in code.
  - Auto-zoom constants include `autoZoomDetectionArea:.5`, `autoZoomTargetBorder:.9` and `autoZoomInMaxTimes:5`.
  - Dynamsoft describes enhanced focus as "Dynamsoft powered auto-focus control", useful on low-end devices without auto-focus, and auto-zoom as zooming in when the code is far away ([enhanced features enum](https://www.dynamsoft.com/camera-enhancer/docs/core/enums/enhanced-features.html), [RN API](https://dynamsoft.com/camera-enhancer/docs/mobile/programming/react-native/api-reference/camera-enhancer.html)).
- **Frame rate.** `setFrameRate()` applies `frameRate` via `applyConstraints`.

**Frame pipeline**
- `setScanRegion()` crops in percentages **before** processing ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
- Frames are drawn either by 2D canvas `drawImage` with `willReadFrequently:true` or by a WebGL path with a `readPixels` alpha sanity check ("WebGL error: incorrect drawing") ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)).
- `setImageFetchInterval()` throttles the frame fetch ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)).
- rVFC / VideoFrame / MediaStreamTrackProcessor: none observed in DCE.

**Accuracy and robustness**
- **Templates:** `ReadSingleBarcode`, `ReadBarcodes_SpeedFirst`, `ReadBarcodes_ReadRateFirst`, `ReadDenseBarcodes`, `ReadDistantBarcodes`, and others.
- **Cross-frame verification.** `enableResultCrossVerification` is described as most important for "low-redundancy codes such as 1D barcodes".
- **Deduplication.** `enableResultDeduplication` defaults to a 3 s window ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
- Minimum module size and scanning distance: not publicly documented on the pages read.

**Fallback and UX**
- `takePhoto()` creates an `<input type=file accept=".jpg,..." capture>`, which opens the **native camera app**.
- `singleFrameMode` has the values `"disabled"`, `"image"` and `"camera"` ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)).
- `Feedback.beep()` is available ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).

**Platform:** Chrome 78+, Firefox 68+, Edge 79+, Safari 14.5+; iOS 14.3+ for streaming in Chrome, Firefox and WebViews; secure context required ([system requirements](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html)). In-app browsers: not publicly documented.

**Benchmark** ([Dynamsoft benchmark article](https://www.dynamsoft.com/codepool/dynamsoft-barcode-reader-benchmark-web-android-desktop.html))
- **Data:** "Dynamsoft Challenging Images", 68 images and 514 ground-truth barcodes, with the same template on all platforms.
- **Detection rate:** web 81.5%, Android 80.2%, desktop 81.5%.
- **Time per image:** 302 ms web, 116 ms Android, 86 ms desktop.
- **Not stated:** hardware and browser versions.
- This is vendor-run and on stills, not live video.

### 2.3 STRICH (strich.io), 1.18.0

**Engine and runtime**
- The WASM is **inlined base64 in a 542 KB JS bundle**, and **no Worker is used**, so decoding runs on the main thread ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)).
- The barcode **locator runs on the GPU via WebGL2**. WebGL1 support was removed in 1.5, and WebGPU is a possible future option ([strich.d.ts `LocatorConfiguration.impl`](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)).
- WebGL2 is used "to decrease the load on the main thread" through **asynchronous reads**, which are disabled on iOS because of older-Safari issues ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)). The code uses `fenceSync` plus `getBufferSubData` PBO readback ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)).
- It uses OffscreenCanvas+WebGL when available ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **SIMD:** "Removed an unnecessary check for WebAssembly SIMD support. SIMD support is planned for the next major release" ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **iOS memory.** STRICH requests a smaller WASM initial memory (32 MB) because of the iOS out-of-memory issue in [WebKit bug 222097](https://bugs.webkit.org/show_bug.cgi?id=222097) ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **CSP:** `wasm-unsafe-eval` ([deployment guide](https://docs.strich.io/deployment-guide.html)).

**Camera**
- **Default resolution** is 720p (`hd`), described as "usually enough"; `full-hd` is for "very fine or degraded codes" ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)).
- **Default constraints** are `facingMode: {ideal: 'environment'}` ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)).
- **iPhone default camera.** The default on iPhones with multiple back cameras is the **"Back Dual Wide Camera"**. "Previously, the *Back Camera* was selected, which resulted in bad scanning performance due to the camera being out of focus" ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)). The selection uses a localized label table ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)). A French-locale three-camera iPhone bug was fixed later ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **Remembered camera.** `rememberCameraDeviceId` notes that "Samsung Internet even change[s] [device IDs] on every page load", so it falls back to the label ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts), [CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- A `cameraSelector` callback allows custom selection ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)).
- **Quirks handled** ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)):
  - Firefox Android lacks `getCapabilities()`.
  - Camera switching on Firefox Android raised an error.
  - Safari 17.4 spuriously loses the stream.
  - Track muting on SPA navigation ([WebKit 269846](https://bugs.webkit.org/show_bug.cgi?id=269846)).
  - iOS PWAs lose the camera when unfocused.
  - The iOS 18 torch could not be switched off.
  - Web Audio stays silent in iOS PWAs, so it falls back to `<audio>`.

**Focus, zoom and torch**
- **Tap-to-focus** applies `{focusMode:'manual', focusDistance:0.3}`, then `continuous` after 250 ms, only if `focusDistance` is a capability ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)). `focusOnTap` defaults to true ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **Zoom** is available through an overlay control or double-tap ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **Torch** has been "available on iOS, as newer versions of Safari apparently support it" ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).

**Frame pipeline**
- The loop uses `requestVideoFrameCallback` when supported, else rAF ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)).
- **ROI:** if none is given, "an appropriate one will automatically be selected" ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)). Guidance is a narrow horizontal strip for 1D (left/right 0.05, top/bottom 0.4) ([best practices](https://docs.strich.io/best-practices-for-scanning-apps.html)).

**Accuracy**
- **`minScanlinesNeeded`** defaults to 2.
- **`invertedCodes`** defaults to false.
- **`duplicateInterval`** defaults to 750 ms.
- **Hysteresis** for "1D barcodes with weak checksums": `hysteresisMinCount` 2 within `hysteresisInterval` 350 ms ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)). The defaults were changed because older ones made "EAN/UPC codes … unreadable on low-end Android devices" ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **Code 39:** optional Mod 43 via `checksumMode` (1 = validate and strip, 2 = validate and transmit) ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md), [strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)). `minLen`/`maxLen` are recommended ([best practices](https://docs.strich.io/best-practices-for-scanning-apps.html)).

**UX**
- Audio uses a Web Audio "cash register" beep with the AudioSession `transient` type, and vibration is available ([strich.d.ts](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts)).
- A manual-entry fallback is "always recommended" ([best practices](https://docs.strich.io/best-practices-for-scanning-apps.html)).

**Platform matrix and in-app browsers:** not publicly documented beyond the secure-context and CSP notes ([deployment guide](https://docs.strich.io/deployment-guide.html)).

### 2.4 Scanbot Web SDK (10.0.0)

**Runtime**
- **Engine builds.** Under `bin/barcode-scanner/` it ships `ScanbotSDK.Asm.wasm` (10.5 MB), `-simd.wasm` (11.1 MB) and `-simd-threads.wasm` (11.0 MB) plus a pthread worker. The `complete` bundle is about 27 MB ([package listing](https://unpkg.com/browse/scanbot-web-sdk@10.0.0/bundle/bin/barcode-scanner/)).
- **Worker.** The core runs in a Web Worker (`new Worker(... ScanbotSDK.Core*.js)`).
- **Threads.** With `allowThreads`, it warns that "The site is not cross-origin isolated. This prevents multithreading… set the 'Cross-Origin-Opener-Policy' and 'Cross-Origin-Embedder-Policy'…" ([ScanbotSDK.min.js](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)).

**Camera** (same file)
- **Default constraints:** `{width:{ideal:1920}, height:{ideal:1080}, facingMode:"environment", resizeMode:"none", experimental:{focusMode:"continous", focusDistance:0}}`. "continous" is misspelled in the shipped code, so that hint likely matches no real mode.
- A 4K option exists (`enable4kStream`) ([Scanbot docs, barcode scanner UI](https://docs.scanbot.io/barcode-scanner-sdk/web/barcode-scanner/barcode-scanner-ui/)).
- **Main camera ranking** (from the comparator):
  - It references iOS "Back Triple Camera" (localized).
  - Cameras that support torch control are preferred.
  - Then higher `maxNumPixels`, then label order.
  - Torch support and max pixel count are capability-based signals that work even when labels carry no lens type.
- **Torch:** "On Android devices, only Chrome supports torch control" ([Scanbot docs](https://docs.scanbot.io/barcode-scanner-sdk/web/barcode-scanner/barcode-scanner-ui/)).
- **`preferredCamera`** accepts a label or device ID ([API docs](https://api-docs.scanbot.io/web/interfaces/IBarcodeScannerHandle.html)).

**Frames**
- A WebGL reader uses `getContext('webgl', {willReadFrequently:true})`.
- `fpsLimit` is a config option.
- An opt-in `useImageCaptureAPI` captures with `ImageCapture.takePhoto()` and crops to the finder ([ScanbotSDK.min.js](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)).

**Platform:** Edge 16+, Firefox 53+, Chrome 57+, Safari 11+ (barcode docs) ([introduction](https://docs.scanbot.io/barcode-scanner-sdk/web/introduction)). In-app browsers, ML models, Code 39 specifics and benchmarks: not publicly documented in what I read.

### 2.5 Cognex Mobile Barcode SDK for Web (cmbWEB, formerly Manatee Works)

**Status and runtime**
- The latest npm `cmbsdk-cmbweb` is **1.5.5, published 2024-06-13** (npm registry).
- Cognex describes it as WebAssembly decoding "directly in the browser from a camera video feed" with a "small footprint" ([cmbWEB page](https://cmbdn.cognex.com/web-barcode-scanner)).
- The WASM is inlined (base64) in the 1.8 MB `cmbweb.js`, and no Worker was observed ([cmbweb.js](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)).

**Camera**
- Constraints are `frameWidth {min:640, ideal:1280, max:1920}`, `frameHeight {min:480, ideal:720, max:1080}`, `frameRate:30`, and a top-level `focusMode:"continuous"` ([cmbweb.js](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)).
- On the first session it closes and restarts the scanner, apparently so device labels are available after permission. It probes `ImageCapture.getPhotoCapabilities()` before reading capabilities ([cmbweb.js](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)).
- **Config surface** ([sample config](https://unpkg.com/cmbsdk-cmbweb@1.5.5/MWBConfig_wa.js)):
  - `MWBenableHiRes` (SD 480p / HD 720p / FHD 1080p).
  - `MWBsetZoomLevel` ("supported only by chrome").
  - `MWBsetCameraSwitcherOptions` incl. `CAMERA_SWITCHER_USE_BEST_CAMERA`; the heuristic is not publicly documented.
  - `MWBsetDpsLimit` (decodes per second, 1 to 30; the sample uses 2).
  - Per-symbology `MWBsetScanningRect` (ROI); `MWBsetLevel` ("3 will try to scan harder than the default which is 2").
  - `MWBsetDecoderTimeout`.
  - `scanImage()` for stills.

**Platform:** "all major web browsers support WebAssembly", with a separate list ([cmbWEB page](https://cmbdn.cognex.com/web-barcode-scanner)). The detailed matrix was not retrieved, so it is not stated here.

### 2.6 Anyline Web SDK (56.6.0)

**Runtime**
- Ships `anylinejs.gz` (3.7 MB) and **`anylinejs_simd.gz`** (4.2 MB) engines, plus per-use-case model data, for example `data_barcode.data` at 122 KB ([package listing](https://unpkg.com/browse/@anyline/anyline-js@56.6.0/anylinejs/)).
- Uses a Web Worker ([anyline.js](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)).
- **Caching** (since 53.4.0) uses Cache Storage, invalidated on SDK version or `anylinePath` change. "Advanced barcode engine assets are not cached" because they are encrypted and delivered dynamically. `preload()` is available ([performance notes](https://documentation.anyline.com/web-sdk-component/latest/performance_notes.html)).

**Camera** ([anyline.js](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js))
- Constraints are `{width:{min:640, ideal:1920, max:1920}, height:{min:480, ideal:1080, max:1080}}` with `facingMode:{ideal:'environment'}`.
- It keeps localized "back camera" labels and an Android label regex `/^camera2? (\d+), facing back$/`.
- `refocus()` applies `focusMode:'manual'`, waits 700 ms, then `continuous`. `setFocusDistance()` defaults to 0.3.
- `refocusAndroidCamera()` refocuses automatically on Android.
- `nextCameraStream()` cycles through cameras.

**Requirements:** devices "released after 2017 (iOS 10+, Android 7+)", latest Chrome on Android or Safari on iOS, camera 1080p recommended and 720p minimum ([getting started](https://documentation.anyline.com/web-sdk-component/latest/getting_started.html)).

---

## 3. Open-source libraries

### 3.1 zxing-wasm (Sec-ant/zxing-wasm)

**Packaging and loading**
- zxing-cpp is compiled with Emscripten. The build variants are `full` (about 1.46 MiB), `reader` (about 1.04 MiB) and `writer` ([README](https://github.com/Sec-ant/zxing-wasm)).
- `readBarcodes` accepts `Blob`, `File`, `ArrayBuffer`, `Uint8Array` and `ImageData`. Any duck-typed `{data,width,height}` works ([README](https://github.com/Sec-ant/zxing-wasm)).
- **Loading:** lazy on first call; jsDelivr is the default via `locateFile`. `prepareZXingModule({overrides, fireImmediately})` sets self-hosting and eager load. `overrides` is atomic, so overriding other fields may require resupplying `locateFile`. `ZXING_WASM_SHA256` and `ZXING_CPP_COMMIT` are exported ([README](https://github.com/Sec-ant/zxing-wasm)).
- **Not documented in the README:** SIMD, threads and Worker usage ([README](https://github.com/Sec-ant/zxing-wasm)).

**Reader option defaults** ([readerOptions.ts](https://github.com/Sec-ant/zxing-wasm/blob/main/src/bindings/readerOptions.ts), mirroring zxing-cpp [ReaderOptions.h](https://github.com/zxing-cpp/zxing-cpp/blob/master/core/src/ReaderOptions.h))
- `tryHarder: true`, `tryRotate: true`, `tryInvert: true`, `tryDownscale: true` (from `min(w,h) >= 500`, factor 3).
- `tryDenoise: false` (2D only), `binarizer: "LocalAverage"`, `isPure: false`.
- **`minLineCount: 2`** (scan lines that must agree for a linear code).
- **`validateOptionalChecksum: false`** (Code 39 Mod 43). `tryCode39ExtendedMode` is deprecated in favour of the formats `Code39Ext` / `Code39Std`.
- `returnErrors: false`, `textMode: "HRI"`.

**Releases:** v3.1.x in 2026 track recent zxing-cpp commits, for example v3.1.3 tracks `a17fd9dc`. v3.1.6 notes "faster `ImageData` decoding" ([releases](https://github.com/Sec-ant/zxing-wasm/releases)).

### 3.2 @zxing/library and @zxing/browser (zxing-js)

- **@zxing/library** is "in maintenance mode, meaning, changes are driven by contributed patches". It is a TypeScript port of Java ZXing. On iOS below 14.3, camera access worked only in Safari ([README](https://github.com/zxing-js/library)).
- **@zxing/browser** frame capture ([BrowserCodeReader.ts](https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts)):
  - It creates a canvas with `getContext('2d', {willReadFrequently:true})`, `drawImage(video,0,0)` (full frame, no ROI), wraps it in `HTMLCanvasElementLuminanceSource` and runs `HybridBinarizer`.
  - The loop uses `setTimeout` with **`delayBetweenScanAttempts: 500`** and `delayBetweenScanSuccess: 500`.
  - Default constraints are `{facingMode:'environment'}`.
  - Torch is applied through `applyConstraints({advanced:[{fillLightMode, torch}]})` and marked `@experimental`.
  - No Worker is used ([README](https://github.com/zxing-js/browser)).

### 3.3 html5-qrcode

- **"In maintenance mode until further notice"**: no bug fixes or merged PRs ([README](https://github.com/mebjas/html5-qrcode)).
- Decoding uses ZXing-js, with an experimental native BarcodeDetector integration that excludes MAXICODE and RSS ([README](https://github.com/mebjas/html5-qrcode)).
- **Config:** `fps` defaults to 2; `qrbox` sets the ROI (whole video if unset); `aspectRatio`; `disableFlip`; `rememberLastUsedCamera`. **File scanning** works locally. A torch button appears if supported. iOS needs 15.1+ ([README](https://github.com/mebjas/html5-qrcode)).

### 3.4 quagga2 (@ericblade/quagga2)

- **1D-only.** Its locator returns a rotated bounding box "regardless of scale or rotation" ([README](https://github.com/ericblade/quagga2)).
- **Locator tuning:** `halfSample` (default `true`; turn it off for very small barcodes) and `patchSize` (`x-small` to `x-large`; smaller for distant or small barcodes) ([README](https://github.com/ericblade/quagga2)).
- **Inputs and readers:** `inputStream.area` sets the ROI as percentages, and `frequency` caps the rate. Readers include `code_39_reader` and `code_39_vin_reader`, tried in order, first match wins ([README](https://github.com/ericblade/quagga2)).
- **False positives:** the README warns they "can occur" and recommends using the reader's error values and check-digit validation, not repeated reads ([README](https://github.com/ericblade/quagga2)).
- **Torch** does not work on iOS 16.4 and earlier ([README](https://github.com/ericblade/quagga2)).

### 3.5 zbar-wasm (@undecaf/zbar-wasm)

- ZBar compiled with Emscripten, about **330 kB**. It scans `ImageData` and RGB or grayscale `ArrayBuffer`s, including Code 39. It "runs in modern browsers, in Node.js and also in workers" ([README](https://github.com/undecaf/zbar-wasm)).
- It "outperforms pure JavaScript barcode scanners", but **no benchmark is given**. It is LGPL-2.1 ([README](https://github.com/undecaf/zbar-wasm)).

### 3.6 W3C Shape Detection API: BarcodeDetector

**Spec**
- A WICG **Draft Community Group Report**, "not a W3C Standard nor is it on the W3C Standards Track" ([spec](https://wicg.github.io/shape-detection-api/)).
- It is exposed to Window **and Worker** and requires a secure context.
- `getSupportedFormats()` resolves to `[]` when unsupported. `detect(ImageBitmapSource)` returns `boundingBox`, `cornerPoints`, `format` and `rawValue`.
- Limiting `formats` "is likely to provide better performance" ([spec](https://wicg.github.io/shape-detection-api/)).

**Chromium backends** ([shape_detection_service.cc](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/shape_detection_service.cc))
- **Android:** Java `BarcodeDetectionImpl` "using Google Play Services vision package" (`com.google.android.gms.vision.barcode.BarcodeDetector`).
  - If `isOperational()` is false, for example while the vision module is still downloading, it logs "BarcodeDetector is not operational" and returns **an empty result, not an error** ([BarcodeDetectionImpl.java](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/android/java/src/org/chromium/shape_detection/BarcodeDetectionImpl.java)).
  - Chrome's docs: "Google Play Services are required on Android" ([Chrome docs](https://developer.chrome.com/docs/capabilities/shape-detection)).
  - On devices without GMS (for example Huawei HMS-only phones), expect empty detections. This is an inference from the code path, not a documented statement.
- **macOS:** Apple Vision `VNDetectBarcodesRequest`. Code39, Code39Checksum, Code39FullASCII and Code39FullASCIIChecksum all map to `code_39`. **Codabar and UPC-A are not requested** ([barcode_detection_impl_mac_vision.mm](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/barcode_detection_impl_mac_vision.mm)).
- **Google Chrome-branded builds on ChromeOS, Windows and Linux:** `BarcodeDetectionProviderChrome`, which loads an internal `shape_detection_internal` shared library (2025 code). It takes a **grayscale** image and lists Code 39 among its formats ([shape_detection_library_holder.cc](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/shape_detection_library_holder.cc), [chrome_shape_detection_api.h](https://chromium.googlesource.com/chromium/src/+/HEAD/services/shape_detection/chrome_shape_detection_api.h), [features.gni](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/features.gni)). A flag `kBarhopperAztecRefineTransformFallback` suggests the library is "Barhopper" ([features.cc](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/features.cc)).
  - Which stable Chrome version enabled this on Windows/Linux is **not established by these sources**. Detect at runtime with `getSupportedFormats()`.
- **All other builds**, for example non-branded Chromium: a stub that logs "Platform not supported" and returns no formats ([barcode_detection_provider_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/barcode_detection_provider_impl.cc)).
- Shipped in Chrome 83 ([Chrome docs](https://developer.chrome.com/docs/capabilities/shape-detection)).

**Other engines**
- **Safari / WebKit:** the `ShapeDetection` preference is `status: testable`, `defaultValue: false` on WebKit main ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)). The WebKit bug notes it was available behind a flag in STP 176, and that it appeared unusable in a Worker ([WebKit 198174](https://bugs.webkit.org/show_bug.cgi?id=198174)). So **iOS has no BarcodeDetector by default**, in any browser, because all iOS browsers use WebKit ([Scandit requirements](https://docs.scandit.com/sdks/web/system-requirements/)).
- **Firefox:** Mozilla's position is **"defer"** ([standards-positions #21](https://github.com/mozilla/standards-positions/issues/21)).

### 3.7 barcode-detector polyfill (Sec-ant/barcode-detector)

- Implements the BarcodeDetector API on zxing-wasm. The **polyfill registers only if no global exists** and does not check whether an existing one is native. The **ponyfill** (`barcode-detector/ponyfill`) can replace the native implementation explicitly ([README](https://github.com/Sec-ant/barcode-detector)).
- The `.wasm` is fetched from jsDelivr by default. `prepareZXingModule` changes the path for CSP or offline use ([README](https://github.com/Sec-ant/barcode-detector)).

---

## 4. Cross-cutting platform facts

### 4.1 What camera controls each engine exposes

**Chrome on Android (Camera2)** ([VideoCaptureCamera2.java](https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java))
- **`pointsOfInterest`** becomes `CONTROL_AF_REGIONS`, `CONTROL_AE_REGIONS` and `CONTROL_AWB_REGIONS`.
- **`focusDistance`** maps to `LENS_FOCUS_DISTANCE` (converted from diopters).
- **`focusMode`** reports `continuous` from `AF_MODE_CONTINUOUS_PICTURE/VIDEO`.
- **`torch`** maps to `FLASH_MODE_TORCH`.
- **`zoom` is implemented as `SCALER_CROP_REGION`**, a crop of the sensor's active array before scaling to the stream size.
- **Device labels** are built as `"camera " + index + ", facing " + back|front|external` (`", infrared"` if NIR).
- **Enumeration** is `CameraManager.getCameraIdList()`, so it only shows the camera IDs the OEM exposes.

**WebKit (Safari, all iOS browsers)** ([MediaTrackCapabilities.idl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackCapabilities.idl))
- **Exposed:** `focusDistance`, `whiteBalanceMode`, `zoom` and `torch`.
- **Not exposed:** `focusMode`, `exposureMode` and the others carry `FIXME` comments. `pointsOfInterest` is absent.
- So **tap-to-focus by `focusMode` / `pointsOfInterest` is not available on iOS**.
- **What helps on iOS instead:**
  - Picking the "Back Dual Wide Camera" virtual device. Apple says it supports "automatic switching from one camera to another when zoom factor, light level, and focus position allow" ([Apple: builtInDualWideCamera](https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtindualwidecamera)).
  - That matches STRICH's finding that "Back Camera" was out of focus at close range ([STRICH CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).

**Firefox Android** lacks `MediaStreamTrack.getCapabilities()` ([STRICH CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).

**Image Capture spec** ([Image Capture spec](https://w3c.github.io/mediacapture-image/))
- Defines `takePhoto()` (encoded Blob, often full sensor resolution), `grabFrame()`, and the constrainable properties `focusMode` (`none|manual|single-shot|continuous`), `pointsOfInterest` (normalized), `focusDistance` (metres), `zoom` and `torch`.
- It is an Editor's Draft.
- WebKit main has `ImageCaptureEnabled` set to true on Cocoa ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)). Which Safari release ships it was not verified.

### 4.2 Frame-access APIs

- **`MediaStreamTrackProcessor`** (Breakout Box / insertable streams for MediaStreamTrack) has been supported since **Chrome 94** ([Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing)). On WebKit main it is `status: mature`, default true on Cocoa ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)).
- **WebCodecs Video, `requestVideoFrameCallback` and OffscreenCanvas** are all enabled by default on Cocoa in WebKit main ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)).
- **None of the six commercial SDKs inspected use `MediaStreamTrackProcessor` or `VideoFrame`** in their shipped code. Scandit, STRICH, Scanbot, Dynamsoft, Cognex and Anyline all draw the `<video>` element into WebGL or a 2D canvas (sources in §2). So this "modern" path is not what the market leaders rely on.

### 4.3 WebViews and in-app browsers

- **Android WebView:** "If this method [`onPermissionRequest`] isn't overridden, the permission is denied." So the camera works only if the host app opted in. Likewise, `onShowFileChooser` defaults to cancelling all file requests ([Android WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest))). Neither can be fixed from the web page.
- **Threads in Android WebView:** no cross-origin isolation or SAB, so no WASM threads ([Scandit WebView guide](https://docs.scandit.com/sdks/web/webview/), [Scandit requirements](https://docs.scandit.com/sdks/web/system-requirements/)).
- **iOS WKWebView / third-party browsers:** camera streaming needs iOS 14.3+ ([Dynamsoft requirements](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html), [zxing-js README](https://github.com/zxing-js/library)). The host app must also declare `NSCameraUsageDescription` and handle the `WKUIDelegate` media-capture permission ([Scandit WebView guide](https://docs.scandit.com/sdks/web/webview/)).
- **WhatsApp, Instagram and Facebook in-app browsers:** none of the vendors document specific behaviour (**not publicly documented**). No user-agent detection for `FBAN`, `Instagram` or similar appeared in any inspected SDK bundle (grep of the shipped JS in §2).

---

## 5. Where a web scanner like ours is behind

**Baseline: what our scanner does.** This combines the coordinator's description, corrected on 2026-11-10, with a quick read of `src/components/scanner/cameraManager.js` and `enginePool.js`.
- **Camera:** getUserMedia ladder from 1920x1080 down to 480x360, re-asks for the capability-max resolution, label-ranked rear camera, remembered lens.
- **Focus and zoom:** continuous AF; miss-driven focus hunt with `focusDistance` nudges; **`pointsOfInterest` used when available**; 1.25x zoom on open, miss-driven ramp to 1.75x, manual 1x/1.6x toggle; torch.
- **Frame loop:** `requestVideoFrameCallback` (rAF fallback) draws a central-band ROI into a canvas with `willReadFrequently: true`. It widens after 25 misses and caps width at 1080 to 1280.
- **Decode, all on the main thread:** native BarcodeDetector first, gated by `getSupportedFormats()` with a timeout; then zxing-wasm, loaded through `prepareZXingModule` with a `locateFile` override; then @zxing/library. Every N misses a "hard pass" tries inverted and rotated frames.
- **Validation and feedback:** strict regex; 1 read to confirm on native, 2 identical reads within 5 s on software engines; edge-hugging hits rejected; 2 s duplicate suppression; Web Audio beep plus vibrate; typed manual entry.

**Ranking.** The gaps below are ordered by likely impact on the goal "works on 10/10 phones, any OS, any browser". Each says whether it is **fixable on the web** or an **inherent browser or platform limit**.

### 5.1 Ranked gaps

**1. No still-photo / native-camera fallback. Fixable on the web (partly). Highest impact.**
- **What the others do:**
  - Dynamsoft DCE's `takePhoto()` opens `<input type=file capture>`, which hands off to the OS camera app ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)).
  - Scandit has Single Image Mode "when video streaming is blocked" ([v5 README](https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md)).
  - Scanbot can capture via `ImageCapture.takePhoto()` ([ScanbotSDK.min.js](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)).
  - html5-qrcode and STRICH scan local files ([html5-qrcode](https://github.com/mebjas/html5-qrcode), [STRICH CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- **Why it matters for a 0.2 mm Code 39:**
  - A native photo is usually far higher resolution and properly autofocused (the OS camera app has full focus control). That covers iOS, where WebKit exposes no `focusMode` ([IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackCapabilities.idl)).
  - It is also the only path in some in-app browsers that block getUserMedia.
- **Limits:**
  - In Android WebViews whose host app never overrode `onShowFileChooser`, the file input is cancelled too, which is inherent ([Android](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest))).
  - Feed the resulting image to zxing-wasm with `tryHarder` and full resolution, not the live-ROI path.

**2. No in-app-browser / WebView detection and escape hatch. Detection is fixable; the blocking is inherent.**
- An Android WebView denies the camera unless the host app overrides `onPermissionRequest` ([Android](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest))). iOS needs 14.3+ for WKWebView streaming ([Dynamsoft](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html)).
- No vendor documents WhatsApp, Instagram or Facebook handling (not publicly documented), so **we would not be behind a vendor here, but every vendor fails the same way**.
- **Fix:** user-agent heuristics, plus a "getUserMedia rejected or hung" detector that shows "Open in Chrome/Safari" with a copy-link button, followed by the photo fallback (gap 1).
- This is probably the single most common reason a phone counts as "0/10 phones" in the field, even though it is not an engine problem.

**3. Engine robustness on blurry or low-resolution dense 1D (no ML localization or deblur). Inherent to the open-source engines; fixable only by buying a commercial engine.**
- Scandit ships neural models including `barcode_1d_scanlines_reconstruction` and several localization models ([models](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/resources/models/)).
- Dynamsoft ships `OneDLocalization`, `OneDDeblur` and a dedicated **`Code39ITFDecoder`** model ([models](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/models/)).
- zxing-cpp is a classical decoder that needs `minLineCount` (2) clean scan lines ([readerOptions.ts](https://github.com/Sec-ant/zxing-wasm/blob/main/src/bindings/readerOptions.ts)).
- For 0.2 mm bars at 15 to 25 cm on a mid-range phone, blur is the dominant failure mode. A deblur network is exactly what is missing.
- **Cost:** 6 to 9 MB of WASM plus about 1 to 2 MB per model, and a license.
- **Partial web-side mitigation:** more pixels per module, through optical crop zoom (gap 8) and still-photo capture (gap 1).

**4. Decode on the main thread (no Worker). Fixable on the web. Medium impact.**
- Scandit, Dynamsoft, Scanbot and Anyline decode in a Web Worker ([Scandit](https://docs.scandit.com/sdks/web/system-requirements/), [Dynamsoft](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html), [Scanbot code](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js), [Anyline code](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)).
- **Honest counterpoint:** STRICH and Cognex, both commercial, also run the decoder on the main thread ([STRICH code](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js), [cmbweb.js](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)). Main-thread decoding is therefore not disqualifying.
- **The real risks:**
  - On low-end Android, a long zxing-wasm hard pass (rotations plus inversion) blocks rVFC callbacks, touch handlers and the beep.
  - A hung native `detect()` still costs the frame budget.
- **Fix:**
  - Move zxing-wasm into a module Worker and transfer the `ImageData.data.buffer`, or `createImageBitmap(video)`, then use OffscreenCanvas in the Worker.
  - Keep `BarcodeDetector` on whichever side works: the spec exposes it in Workers ([spec](https://wicg.github.io/shape-detection-api/)), but WebKit reports it unusable in a Worker ([WebKit 198174](https://bugs.webkit.org/show_bug.cgi?id=198174)).
  - zxing-wasm's `prepareZXingModule` + `locateFile` setup works unchanged inside a Worker ([README](https://github.com/Sec-ant/zxing-wasm)).

**5. Camera ranking relies on labels that Chrome on Android never provides. Fixable on the web. Medium impact.**
- Chrome on Android labels every camera only `"camera N, facing back"` ([VideoCaptureCamera2.java](https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java)). So our ultra-wide, macro, depth and tele penalties and our "main/1x/wide" boosts **cannot fire in Chrome on Android**. Only index order and the `camera 0` boost apply. That matches Dynamsoft (prefer `\b0\b`) and Anyline, so it is equal to the vendors, not behind them ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js), [anyline.js](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js)).
- Scanbot instead ranks by **capabilities**: torch support, then max pixel count ([ScanbotSDK.min.js](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)). Torch is usually wired only to the main module. That is a better signal than labels and available after one `getCapabilities()` per camera.
- **Fix:** probe each rear device once after permission and cache `{torch, width.max, focusDistance.min, zoom.max}`. Prefer torch plus the largest `width.max` plus a supported `continuous` focus mode. Keep the "lens that read a badge" memory.
- **iOS:** our English regex scores "Back Dual Wide Camera" +30 (it contains "wide" but not "ultra"), so on English-locale iPhones we already pick what STRICH, Scandit and Dynamsoft pick ([STRICH CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md), [Scandit CameraAccess.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraAccess.js)).
  - **Behind on non-English iOS locales.** Scandit, STRICH and Dynamsoft carry localized label tables, for example Hindi "बैक ड्युअल वाइड कैमरा" or German "Rückseitige Dual-Weitwinkelkamera". Ours would score the Dual Wide like any other lens on, say, a Hindi-locale iPhone. Fixable by copying the label sets.

**6. No event-driven track `mute` / `ended` recovery. Fixable on the web. Medium-low impact.**
- Scandit listens to `ended`, `mute` and `unmute` and shows camera recovery ([CameraManager.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)).
- STRICH handles Safari 17.4 stream loss, SPA-navigation muting ([WebKit 269846](https://bugs.webkit.org/show_bug.cgi?id=269846)) and iOS PWA unfocus ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).
- From a quick read we check `track.readyState` and `visibilitychange`, but no `mute`/`ended` listeners were found.
- **Fix:** subscribe to `track.onmute` and `onended` and re-acquire the stream.

**7. No `resizeMode: 'none'` and no `min`/`max` windows. Fixable; low to medium impact, unverified for our devices.**
- Scandit 8.7 and Scanbot request `resizeMode: 'none'`, and Scandit adds `min`/`max` resolution windows per step ([Scandit CameraAccess.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraAccess.js), [ScanbotSDK.min.js](https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js)). This asks the browser not to crop or rescale and to deliver a native sensor mode.
- Our ladder uses `ideal` only, and that is the case where firmware silently returns 640x480, which our capability-max re-ask then patches.
- Adding `resizeMode:'none'` and `min` bounds on the first rungs is cheap. Whether it helps on our fleet is unverified.

**8. Zoom: we may under-use optical-crop zoom. Fixable; medium impact for dense codes.**
- On Chrome Android, `zoom` is applied as `SCALER_CROP_REGION` on the sensor's active array, then scaled to the stream size ([VideoCaptureCamera2.java](https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java)). When the sensor (say 4000 px wide) is larger than our 1920 px stream, 2x zoom gives **real extra pixels per module**, which our canvas ROI crop cannot.
- Our 1.25x to 1.75x ramp is already in line with Dynamsoft's auto-zoom concept ([dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)). A slightly higher ceiling (2 to 2.5x) for the hard-pass state may be worth testing, weighed against the user needing to hold the badge further away.
- On iOS, WebKit exposes `zoom` ([IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackCapabilities.idl)). On the Dual Wide virtual device, zoom also drives automatic lens switching ([Apple](https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtindualwidecamera)).

**9. RGBA `getImageData` on the CPU instead of GPU grayscale readback. Fixable; low to medium impact.**
- Scandit converts to grayscale in a WebGL shader and reads back 1/4 of the bytes ([GrayScaleFrameReader.js](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/FrameReaders/GrayScaleFrameReader.js)).
- STRICH uses WebGL2 with async PBO readback (`fenceSync`), so the main thread does not stall ([strich.js](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js)).
- Both also sanity-check WebGL output and fall back to canvas.
- Our 2D canvas with `willReadFrequently: true` keeps the canvas on the CPU, which is what zxing-js and Dynamsoft's 2D path also do ([BrowserCodeReader.ts](https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts), [dce.esm.js](https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js)). That is acceptable at about 1080x300 ROI sizes. It matters mainly on the slowest devices, together with gap 4.

**10. No SIMD / threads engine selection. Partly fixable; low impact for our setup.**
- Scandit, Dynamsoft and Scanbot ship SIMD and pthread builds and choose them at runtime with a `WebAssembly.validate` probe and `crossOriginIsolated` ([Dynamsoft worker](https://unpkg.com/dynamsoft-barcode-reader-bundle@11.6.5000/dist/dbr.bundle.worker.js), [Scandit sdc-lib](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/)).
- zxing-wasm's README documents no SIMD or threads build ([README](https://github.com/Sec-ant/zxing-wasm)).
- Threads require COOP/COEP and never work in Android WebView ([Scandit](https://docs.scandit.com/sdks/web/system-requirements/)). That is inherent there, and COEP can break third-party embeds in a PWA. A single ROI decode gains little from threads.

**11. No per-device telemetry. Fixable; indirect but high leverage.**
- Vendors advertise "device coverage" without published per-device methodology. Dynamsoft's only benchmark is stills on unstated hardware ([benchmark](https://www.dynamsoft.com/codepool/dynamsoft-barcode-reader-benchmark-web-android-desktop.html)). Scandit and STRICH device claims are not publicly documented with methodology.
- To claim "10/10 phones" we need our own numbers. Log anonymous per-scan records: UA, the camera label and capabilities chosen, granted resolution, engine that read, time to first read, misses before read, and fallbacks used.
- This also tells us whether gaps 3 to 10 matter on our actual fleet.

**12. No keyboard-wedge hardware scanner support. Fixable; niche.**
- None of the SDK docs I read document wedge support (not publicly documented). A hidden focused input that collects characters ending in `Enter` within a short inter-key interval, then runs the same regex, gives Bluetooth or USB scanners a 100% path at desks.

### 5.2 Where we are already equal or ahead

- **`pointsOfInterest` plus manual `focusDistance` nudges.** Chromium maps `pointsOfInterest` to Camera2 AF/AE/AWB regions ([VideoCaptureCamera2.java](https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java)). **None of the inspected commercial SDKs use `pointsOfInterest`** (grep of the Scandit, Dynamsoft, STRICH, Scanbot, Cognex and Anyline bundles). Their tap-to-focus is `manual`/`focusDistance` then back to `continuous` (STRICH 250 ms, Anyline 700 ms, Scandit 5 s) ([STRICH](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js), [Anyline](https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js), [Scandit](https://unpkg.com/@scandit/web-datacapture-core@8.7.0/build/js/private/CameraManager.js)). Our miss-driven focus hunt is closest to Dynamsoft's license-gated "enhanced focus".
- **Default resolution.** We start at 1080p and re-ask for capability-max. Scandit, STRICH and Cognex default to 720p ([Scandit](https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html), [STRICH](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts), [Cognex](https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js)). For 0.2 mm bars, higher is right, and STRICH's own docs say so for "very fine" codes.
- **Frame loop.** rVFC with rAF fallback is exactly what Scandit 8.7 and STRICH do. It beats zxing-js's 500 ms `setTimeout` and html5-qrcode's default 2 fps ([BrowserCodeReader.ts](https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts), [html5-qrcode](https://github.com/mebjas/html5-qrcode)).
- **ROI band for 1D.** This matches STRICH's guidance of a narrow horizontal strip ([best practices](https://docs.strich.io/best-practices-for-scanning-apps.html)) and Dynamsoft's crop-before-process `setScanRegion` ([user guide](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
- **Multi-frame confirmation and duplicate suppression.** These are conceptually the same as STRICH hysteresis (2 reads in 350 ms), Scandit Smart intention and Dynamsoft cross-verification ([STRICH](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts), [Scandit](https://docs.scandit.com/data-capture-sdk/web/barcode-capture/api/barcode-capture-settings.html), [Dynamsoft](https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html)).
  - Our 5 s window is far looser than STRICH's 350 ms. That favours read rate over strictness.
  - Our strict badge regex is a stronger guard than a generic checksum, because Code 39 without Mod 43 has no check digit (Scandit table: no mandatory checksum; [symbologies](https://docs.scandit.com/preview/c_api/symbologies.html)).
- **Native BarcodeDetector first, with `getSupportedFormats()` gating and timeouts.** This handles the GMS "not operational" empty-result path ([BarcodeDetectionImpl.java](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/android/java/src/org/chromium/shape_detection/BarcodeDetectionImpl.java)) and iOS absence ([WebKit prefs](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)). No commercial SDK uses the OS detector. This is a real free accuracy and speed win on Android with GMS and on macOS. Caveat: macOS Vision does not request Codabar or UPC-A ([mac_vision.mm](https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/barcode_detection_impl_mac_vision.mm)). This is irrelevant for Code 39.
- **Engine fallback chain with inverted and rotated hard passes.** zxing-cpp already defaults `tryInvert`, `tryRotate` and `tryHarder` to true ([readerOptions.ts](https://github.com/Sec-ant/zxing-wasm/blob/main/src/bindings/readerOptions.ts)), so the zxing-wasm leg of the hard pass partly duplicates built-in work. Check that we are not paying twice.
- **Engine size.** zxing-wasm reader at about 1 MiB versus 5 to 11 MB for the commercial engines ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm), [Scandit](https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/), [Dynamsoft](https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/), [Scanbot](https://unpkg.com/browse/scanbot-web-sdk@10.0.0/bundle/bin/barcode-scanner/)). This loads far faster on poor networks.
- **Beep, vibrate and manual entry.** This is on par with STRICH's recommended UX ([best practices](https://docs.strich.io/best-practices-for-scanning-apps.html)). STRICH notes that Web Audio can stay silent in iOS PWAs and falls back to `<audio>` ([CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)). Worth copying.

### 5.3 Inherent limits no web SDK escapes

- **No `focusMode` or `pointsOfInterest` on iOS.** Only `focusDistance`, `zoom` and `torch` exist ([WebKit IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackCapabilities.idl)).
- **No BarcodeDetector on iOS or Firefox** ([WebKit prefs](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml), [Mozilla](https://github.com/mozilla/standards-positions/issues/21)). On Android it depends on GMS ([Chrome docs](https://developer.chrome.com/docs/capabilities/shape-detection)).
- **Android WebView camera and file access depend entirely on the host app** ([Android](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest))). WASM threads are unavailable there ([Scandit](https://docs.scandit.com/sdks/web/webview/)).
- **Chrome on Android exposes only the camera IDs the OEM publishes, with no lens-type labels** ([VideoCaptureCamera2.java](https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java)). Physical sub-lenses hidden behind a logical camera cannot be chosen.
- **Firefox Android has no `getCapabilities()`,** so there is no torch, zoom or focus control ([STRICH CHANGELOG](https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md)).

---

## 6. Sources

**Specs, browser source and platform docs**
- WICG Shape Detection API: https://wicg.github.io/shape-detection-api/
- W3C MediaStream Image Capture (ED): https://w3c.github.io/mediacapture-image/
- Chrome Shape Detection article: https://developer.chrome.com/docs/capabilities/shape-detection
- Chrome Insertable Streams for MediaStreamTrack: https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing
- Chromium `shape_detection_service.cc`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/shape_detection_service.cc
- Chromium `BarcodeDetectionImpl.java`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/android/java/src/org/chromium/shape_detection/BarcodeDetectionImpl.java
- Chromium `barcode_detection_impl_mac_vision.mm`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/barcode_detection_impl_mac_vision.mm
- Chromium `chrome_shape_detection_api.h`: https://chromium.googlesource.com/chromium/src/+/HEAD/services/shape_detection/chrome_shape_detection_api.h
- Chromium `shape_detection_library_holder.cc`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/shape_detection_library_holder.cc
- Chromium `features.gni` / `features.cc`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/features.gni , https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/features.cc
- Chromium `barcode_detection_provider_impl.cc`: https://chromium.googlesource.com/chromium/src/+/main/services/shape_detection/barcode_detection_provider_impl.cc
- Chromium `VideoCaptureCamera2.java`: https://chromium.googlesource.com/chromium/src/+/main/media/capture/video/android/java/src/org/chromium/media/VideoCaptureCamera2.java
- WebKit `UnifiedWebPreferences.yaml`: https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
- WebKit `MediaTrackCapabilities.idl`: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackCapabilities.idl
- WebKit bugs: https://bugs.webkit.org/show_bug.cgi?id=198174 , https://bugs.webkit.org/show_bug.cgi?id=222097 , https://bugs.webkit.org/show_bug.cgi?id=269846
- Mozilla standards-positions #21: https://github.com/mozilla/standards-positions/issues/21
- Android `WebChromeClient`: https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest)
- Apple `builtInDualWideCamera`: https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtindualwidecamera

**Scandit**
- System requirements: https://docs.scandit.com/sdks/web/system-requirements/
- Add SDK / self-hosting: https://docs.scandit.com/sdks/web/add-sdk/
- WebView guide: https://docs.scandit.com/sdks/web/webview/
- Camera API: https://docs.scandit.com/data-capture-sdk/web/core/api/camera.html
- CameraSettings: https://docs.scandit.com/data-capture-sdk/web/core/api/camera-settings.html
- Browser compatibility: https://docs.scandit.com/data-capture-sdk/web/core/api/web/browser-compatibility.html
- BarcodeCaptureSettings: https://docs.scandit.com/data-capture-sdk/web/barcode-capture/api/barcode-capture-settings.html
- Configure symbologies (web): https://docs.scandit.com/sdks/web/barcode-capture/configure-barcode-symbologies/
- Symbology table (C API): https://docs.scandit.com/preview/c_api/symbologies.html
- Get started: https://docs.scandit.com/sdks/web/barcode-capture/get-started/
- Shipped code 8.7.0: https://unpkg.com/browse/@scandit/web-datacapture-core@8.7.0/build/js/ , https://unpkg.com/browse/@scandit/web-datacapture-barcode@8.7.0/sdc-lib/
- Legacy v5 README and code: https://cdn.jsdelivr.net/npm/scandit-sdk@5.15.0/README.md , https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/cameraAccess.js , https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/barcodePicker/cameraManager.js , https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/barcodePicker/gui.js , https://unpkg.com/scandit-sdk@5.15.0/build/module/lib/workers/dataCaptureWorker.js

**Dynamsoft**
- User guide: https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/user-guide/index.html
- Introduction: https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/
- System requirements: https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/system-requirement.html
- Benchmark: https://www.dynamsoft.com/codepool/dynamsoft-barcode-reader-benchmark-web-android-desktop.html
- Enhanced features enum: https://www.dynamsoft.com/camera-enhancer/docs/core/enums/enhanced-features.html ; RN API: https://dynamsoft.com/camera-enhancer/docs/mobile/programming/react-native/api-reference/camera-enhancer.html
- Shipped code: https://unpkg.com/dynamsoft-camera-enhancer@4.1.1/dist/dce.esm.js , https://unpkg.com/browse/dynamsoft-barcode-reader-bundle@11.6.5000/dist/ , https://unpkg.com/dynamsoft-barcode-reader-bundle@11.6.5000/dist/dbr.bundle.worker.js

**STRICH**
- Best practices: https://docs.strich.io/best-practices-for-scanning-apps.html
- Deployment guide: https://docs.strich.io/deployment-guide.html
- Shipped code, types and changelog: https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.js , https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/dist/strich.d.ts , https://unpkg.com/@pixelverse/strichjs-sdk@1.18.0/CHANGELOG.md

**Scanbot**
- Barcode scanner UI docs: https://docs.scanbot.io/barcode-scanner-sdk/web/barcode-scanner/barcode-scanner-ui/
- Introduction: https://docs.scanbot.io/barcode-scanner-sdk/web/introduction
- API docs: https://api-docs.scanbot.io/web/interfaces/IBarcodeScannerHandle.html
- Shipped code: https://unpkg.com/scanbot-web-sdk@10.0.0/bundle/ScanbotSDK.min.js , https://unpkg.com/browse/scanbot-web-sdk@10.0.0/bundle/bin/barcode-scanner/

**Cognex**
- cmbWEB overview: https://cmbdn.cognex.com/web-barcode-scanner
- Shipped code: https://unpkg.com/cmbsdk-cmbweb@1.5.5/cmbweb.js , https://unpkg.com/cmbsdk-cmbweb@1.5.5/MWBConfig_wa.js

**Anyline**
- Docs: https://documentation.anyline.com/web-sdk-component/latest/index.html , https://documentation.anyline.com/web-sdk-component/latest/getting_started.html , https://documentation.anyline.com/web-sdk-component/latest/performance_notes.html
- Shipped code: https://unpkg.com/@anyline/anyline-js@56.6.0/anyline.js , https://unpkg.com/browse/@anyline/anyline-js@56.6.0/anylinejs/

**Open source**
- zxing-wasm: https://github.com/Sec-ant/zxing-wasm , https://github.com/Sec-ant/zxing-wasm/blob/main/src/bindings/readerOptions.ts , https://github.com/Sec-ant/zxing-wasm/releases
- zxing-cpp `ReaderOptions.h`: https://github.com/zxing-cpp/zxing-cpp/blob/master/core/src/ReaderOptions.h
- barcode-detector: https://github.com/Sec-ant/barcode-detector
- zxing-js: https://github.com/zxing-js/library , https://github.com/zxing-js/browser , https://github.com/zxing-js/browser/blob/master/src/readers/BrowserCodeReader.ts
- html5-qrcode: https://github.com/mebjas/html5-qrcode
- quagga2: https://github.com/ericblade/quagga2
- zbar-wasm: https://github.com/undecaf/zbar-wasm
