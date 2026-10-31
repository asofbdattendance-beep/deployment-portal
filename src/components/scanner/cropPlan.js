/**
 * cropPlan.js — decide the 1:1 source crop for one failing frame.
 *
 * WHY: `computeRoi` downscales the band before the decoder sees it, and near
 * the ZXing cliff that downscale is what loses the read. The fix is to locate
 * the badge on the band, map its box back to video pixels, and decode that
 * region at source resolution instead. This module is the decision half of
 * that fix, split out so the exact function the scanner ships is the one the
 * tests exercise — a crop that is never called cannot be "tested" by testing
 * its helpers.
 *
 * Contract: HINT ONLY. Every failure (no locator hit, degenerate box, throw)
 * returns null and the caller decodes the full band exactly as before.
 */
import { bandBoxToVideoPx } from '../../lib/scannerUtils'
import { locateBarcode } from './barcodeLocator'

/** Below this the crop is not worth a decode pass. */
export const MIN_CROP_W = 32
export const MIN_CROP_H = 16
/** Locator confidence gate — same value the aim overlay has always used. */
export const CROP_CONFIDENCE = 0.55

/**
 * @param {Uint8ClampedArray} gray   band pixels (locator's space)
 * @param {number} width             band width in px
 * @param {number} height            band height in px
 * @param {object} roi               the computeRoi() that produced that band
 * @param {number} videoW            video.videoWidth
 * @param {number} videoH            video.videoHeight
 * @param {number} [pad]             quiet-zone padding, in BAND px
 * @returns {{x:number,y:number,w:number,h:number}|null} rect in VIDEO px
 */
export function planSourceCrop(gray, width, height, roi, videoW, videoH, pad = 8) {
  try {
    if (!gray || !width || !height) return null
    // The crop only buys pixels when computeRoi actually downscaled the band.
    // At scale 1 the band pixels ARE source pixels, so the crop can add no
    // px/module — it just pays the locator (~4.6 ms on a 994x615 band, measured)
    // on the decode thread for nothing. Fast/medium profiles cap at 1280/1080,
    // so a 1080p portrait band (994 px) is already 1:1 and never crops.
    if (roi && roi.scale != null && roi.scale >= 0.999) return null
    const box = locateBarcode(gray, width, height, { minConfidence: CROP_CONFIDENCE })
    if (!box) return null
    const rect = bandBoxToVideoPx(box, roi, videoW, videoH, pad)
    if (!rect || rect.w < MIN_CROP_W || rect.h < MIN_CROP_H) return null
    return rect
  } catch {
    return null
  }
}
