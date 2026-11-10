/**
 * scanTuning.js — pure rules for the scan loop's speed profile and for
 * confirming a read. No React, no DOM, so each rule is unit-tested directly.
 */

// Decode time (ms) thresholds between profiles.
const FAST_BELOW_MS = 30
const MEDIUM_BELOW_MS = 120

/**
 * Speed profile for a measured decode time.
 *
 * A missing or nonsense measurement maps to 'medium', never 'slow': 'slow'
 * throttles the loop to ~3 fps, which on the portal's dense badges means
 * reads too sporadic to confirm (field case: Galaxy A35).
 *
 * @param {number} ms
 * @returns {'fast'|'medium'|'slow'}
 */
export function profileForDetectMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'medium'
  if (ms < FAST_BELOW_MS) return 'fast'
  if (ms < MEDIUM_BELOW_MS) return 'medium'
  return 'slow'
}

/**
 * Profile from startup timing samples, ignoring the first one.
 *
 * The first decode after an engine loads pays one-off cost (native ML model
 * load, WebAssembly/JIT warm-up), often several hundred ms. Averaging it in
 * tagged mid-range phones 'slow' for the whole session.
 *
 * @param {number[]|null|undefined} samples decode times in ms, in order
 * @returns {'fast'|'medium'|'slow'|null} null when fewer than 2 warm samples
 */
export function profileFromSamples(samples) {
  if (!Array.isArray(samples)) return null
  const warm = samples.slice(1).filter(Number.isFinite)
  if (warm.length < 2) return null
  const avg = warm.reduce((a, b) => a + b, 0) / warm.length
  return profileForDetectMs(avg)
}

/**
 * How far apart two identical reads may be and still confirm each other.
 * 5 s (was 3 s): on a slow frame rate a hard badge reads only every few
 * frames, and two reads 3–5 s apart are still the same badge in front of the
 * same operator.
 */
export const CONFIRM_WINDOW_MS = 5000

/**
 * Record one read and say whether the badge is now confirmed.
 *
 * Keeps the reads from the last CONFIRM_WINDOW_MS, at most cfg.confirmWindow
 * of them, and confirms when cfg.confirmThreshold (default 2) of those are
 * this badge. Pure: returns a new entries array.
 *
 * @param {Array<{badge: string, time: number}>} entries
 * @param {string} badge
 * @param {number} now epoch ms
 * @param {{confirmWindow: number, confirmThreshold?: number}} cfg
 * @returns {{entries: Array<{badge: string, time: number}>, confirmed: boolean, count: number}}
 */
export function pushConfirmRead(entries, badge, now, cfg) {
  let next = [...(entries || []), { badge, time: now }]
    .filter(e => e.time > now - CONFIRM_WINDOW_MS)
  if (next.length > cfg.confirmWindow) next = next.slice(-cfg.confirmWindow)
  const count = next.filter(e => e.badge === badge).length
  const threshold = Number.isFinite(cfg?.confirmThreshold) ? cfg.confirmThreshold : DEFAULT_CONFIRM_THRESHOLD
  return { entries: next, confirmed: count >= threshold, count }
}

/** Reads a software decoder needs before a badge counts (see confirmThresholdFor). */
export const DEFAULT_CONFIRM_THRESHOLD = 2

/** Engines whose single read is trusted outright. */
const SINGLE_READ_ENGINES = new Set(['Native'])

/**
 * How many identical reads confirm a badge for the engine that produced it.
 *
 * BADGE_REGEX checks a read's SHAPE, not that it is the right person: a
 * one-digit Code 39 substitution (FB5978GA0013 -> FB5978GA0018) is still a
 * valid badge, just another sewadar's. The native BarcodeDetector (ML Kit on
 * Android) is reliable enough to lock on one frame. The software decoders
 * (ZXingCpp, ZXing) and the inverted/rotated hard pass misread soft-focus
 * frames more often, so they keep the profile's threshold. Misses never enter
 * the confirm window, so a shaky frame between two reads costs nothing; the
 * second read only adds one decode interval (~50-150 ms).
 *
 * @param {string} [engine]
 * @param {{confirmThreshold?: number}} [cfg]
 * @returns {number}
 */
export function confirmThresholdFor(engine, cfg) {
  if (SINGLE_READ_ENGINES.has(engine)) return 1
  return Number.isFinite(cfg?.confirmThreshold) ? cfg.confirmThreshold : DEFAULT_CONFIRM_THRESHOLD
}
