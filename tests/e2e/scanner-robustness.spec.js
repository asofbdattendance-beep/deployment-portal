/**
 * scanner-robustness.spec.js — the camera → frame → decode → badge pipeline.
 *
 * WHY THIS EXISTS: every other scanner e2e (scanner-offline, queue-matrix,
 * mobile-attendance) drives the MANUAL text input. Nothing in e2e exercises
 * the real camera decode path — getUserMedia → <video> → ROI crop → detector
 * → badge. This spec closes that gap with a FAKE CAMERA: an addInitScript
 * replaces navigator.mediaDevices.getUserMedia with a canvas.captureStream()
 * that paints a synthetic Code 39 barcode rendered by src/lib/barcodeFixtures.js
 * (the same encoder the unit suites use). The decoder under test is always
 * the real production path (Native BarcodeDetector → ZXing fallback).
 *
 * Technique notes:
 * - A FRESH stream per getUserMedia call: React StrictMode double-mounts the
 *   scanner and teardown stops the first mount's tracks — a shared stream
 *   would hand the second mount a dead track and the preview would freeze.
 * - The video canvas is 800×480 so the 633px-wide barcode sits comfortably
 *   inside the scanner's centred ROI band (92% × 62%, see computeRoi). A
 *   640-wide canvas would clip the stop guard; 800 leaves margin for the
 *   12° tilt case too.
 * - captureStream(30) + a requestFrame pump: the canvas is static, and the
 *   pump guarantees the track keeps presenting frames like a real camera.
 *
 * Invariants (mirrors scanner-offline.spec.js): zero pageerrors via
 * collectPageErrors + guard.assertEmpty(); resetMock in beforeEach.
 */
import { test, expect, devices } from '@playwright/test'
import { resetMock, collectPageErrors, loginAsScanner } from './helpers.mjs'
import { encodeCode39, render1D, BADGE } from '../../src/lib/barcodeFixtures'

/**
 * Install the fake camera BEFORE the app boots. The barcode frame is rendered
 * in Node by the shared fixture encoder; only the raw grayscale pixels cross
 * into the page, where the init script paints them onto the video canvas.
 */
async function installFakeCamera(context, { badge, tiltDeg = 0 }) {
  const { gray, width, height } = render1D(encodeCode39(badge))
  await context.addInitScript(
    ({ gray, width, height, tiltDeg }) => {
      function makeStream() {
        // Grayscale → RGBA on an offscreen canvas. putImageData ignores the
        // current transform, so the tilt is applied on the video canvas below
        // via drawImage (which DOES respect the CTM).
        const off = document.createElement('canvas')
        off.width = width
        off.height = height
        const offCtx = off.getContext('2d')
        const img = offCtx.createImageData(width, height)
        for (let i = 0; i < gray.length; i += 1) {
          img.data[i * 4] = gray[i]
          img.data[i * 4 + 1] = gray[i]
          img.data[i * 4 + 2] = gray[i]
          img.data[i * 4 + 3] = 255
        }
        offCtx.putImageData(img, 0, 0)

        const CW = 800
        const CH = 480
        const canvas = document.createElement('canvas')
        canvas.width = CW
        canvas.height = CH
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, CW, CH)
        ctx.save()
        ctx.translate(CW / 2, CH / 2)
        ctx.rotate((tiltDeg * Math.PI) / 180)
        ctx.drawImage(off, -width / 2, -height / 2)
        ctx.restore()

        const stream = canvas.captureStream(30)
        const track = stream.getVideoTracks()[0]
        // The canvas is static — pump requestFrame so the track keeps
        // presenting frames at ~30fps like a real camera would.
        const pump = setInterval(() => {
          try {
            if (track.readyState === 'live' && typeof track.requestFrame === 'function') track.requestFrame()
          } catch { /* a dying track must not kill the pump */ }
        }, 33)
        const nativeStop = track.stop.bind(track)
        track.stop = () => { clearInterval(pump); nativeStop() }
        return stream
      }

      const fakeDevices = {
        getUserMedia: async () => makeStream(),
        enumerateDevices: async () => [],
      }
      Object.defineProperty(navigator, 'mediaDevices', { value: fakeDevices, configurable: true })
      // Legacy prefixes some old webviews still hit — same factory.
      navigator.getUserMedia = fakeDevices.getUserMedia
      navigator.webkitGetUserMedia = fakeDevices.getUserMedia

      // Headless Chromium never fires requestVideoFrameCallback for a
      // captureStream-backed video (measured: rvfcCalls=1, rvfcFired=0,
      // currentTime stuck at 0) — the production loop is rvfc-driven after
      // the first pass, so it would stall after ONE decode and the confirm
      // window could never fill. Delete the prototype methods so the loop
      // takes its rAF fallback — the same path older browsers use. The
      // camera → frame → decode pipeline under test is unchanged.
      try { delete HTMLVideoElement.prototype.requestVideoFrameCallback } catch { /* already absent */ }
      try { delete HTMLVideoElement.prototype.cancelVideoFrameCallback } catch { /* already absent */ }
    },
    { gray: Array.from(gray), width, height, tiltDeg },
  )
}

const videoDims = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video.scanner-video')
    return v
      ? { w: v.videoWidth, h: v.videoHeight, live: !!(v.srcObject && v.srcObject.active) }
      : { w: 0, h: 0, live: false }
  })

/** The camera half of the pipeline: stream granted, video live, preview up. */
async function assertCameraLive(page) {
  const video = page.locator('video.scanner-video')
  await expect(video).toBeVisible()
  // The scanner sizes its crop from video.videoWidth — a zero dimension means
  // the stream never produced metadata and no decode could ever run.
  await expect.poll(() => videoDims(page).then((d) => d.w), { timeout: 15000 }).toBeGreaterThan(0)
  await expect.poll(() => videoDims(page).then((d) => d.h), { timeout: 15000 }).toBeGreaterThan(0)
  await expect.poll(() => videoDims(page).then((d) => d.live), { timeout: 15000 }).toBe(true)
  // The "Starting camera…" overlay is gone — openCamera + play() succeeded.
  await expect(page.getByText('Starting camera…')).toBeHidden()
  // The decode ROI guide is on screen.
  await expect(page.getByTestId('roi-guide')).toBeVisible()
}

/** The decode half: the badge reaches the UI, then the full pipeline fires. */
async function assertBadgeDecoded(page) {
  // The lastRaw pill is set the instant ANY decoder returns the badge —
  // before the confirm window, before the RPC. Pure decode proof.
  await expect(page.locator('span.pill', { hasText: BADGE })).toBeVisible({ timeout: 30000 })
  // Full pipeline: decode → onScan → scan_in RPC → the mock's success body
  // → the choice dialog. Proves the decoded badge reached the app.
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Mark IN', exact: true })).toBeVisible({ timeout: 15000 })
  await expect(dialog).toContainText(BADGE)
}

test.describe('scanner camera decode (fake camera)', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request)
  })

  test('upright barcode decodes through the real camera pipeline', async ({ page, context }) => {
    test.setTimeout(120000)
    const guard = collectPageErrors(page)
    await installFakeCamera(context, { badge: BADGE, tiltDeg: 0 })
    await loginAsScanner(page)

    await assertCameraLive(page)
    await assertBadgeDecoded(page)

    guard.assertEmpty()
  })

  test('tilted barcode (~12°) decodes through the real camera pipeline', async ({ page, context }) => {
    test.setTimeout(120000)
    const guard = collectPageErrors(page)
    await installFakeCamera(context, { badge: BADGE, tiltDeg: 12 })
    await loginAsScanner(page)

    await assertCameraLive(page)
    await assertBadgeDecoded(page)

    guard.assertEmpty()
  })

  // Phone viewport — mirrors the mobile-chrome project's Pixel 5 device.
  // (defaultBrowserType is dropped: test.use forbids it inside a describe;
  // viewport/UA/touch are the properties that matter here.)
  test.describe('phone viewport (Pixel 5)', () => {
    const { defaultBrowserType: _ignored, ...pixel5 } = devices['Pixel 5']
    test.use(pixel5)

    test('upright barcode decodes at phone viewport', async ({ page, context }) => {
      test.setTimeout(120000)
      const guard = collectPageErrors(page)
      await installFakeCamera(context, { badge: BADGE, tiltDeg: 0 })
      await loginAsScanner(page)

      // The mobile layout is actually mounted (not the desktop shell).
      await expect(page.locator('.scan-shell')).toBeVisible()
      await assertCameraLive(page)
      await assertBadgeDecoded(page)

      guard.assertEmpty()
    })
  })
})
