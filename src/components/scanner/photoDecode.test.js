/**
 * photoDecode — reading a badge from one still photo (the fallback for
 * phones whose live camera cannot read).
 *
 * Decode tests run the REAL zxing-cpp WebAssembly binary on synthetic
 * "photos": a large light frame with one or more rendered Code 39 badges
 * placed in it (barcodeFixtures.js — no real badge data).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { loadZxingCpp } from './zxingCppEngine'
import { encodeCode39, renderAt } from '../../lib/barcodeFixtures'
import {
  planPhotoPasses,
  pickBadge,
  decodeBadgePhoto,
  PHOTO_MAX_EDGE,
} from './photoDecode'

const require = createRequire(import.meta.url)
const WASM_PATH = require.resolve('zxing-wasm/reader/zxing_reader.wasm')

const BADGE_A = 'FB5978GA0013'
const BADGE_B = 'FB5990GA0001'

/** A light gray "photo" with each badge rendered at (x, y). */
function makePhoto(width, height, placements) {
  const gray = new Uint8ClampedArray(width * height).fill(235)
  for (const { text, x, y, px = 3 } of placements) {
    const code = renderAt(encodeCode39(text), px, { heightPx: 120 })
    for (let r = 0; r < code.height; r++) {
      for (let c = 0; c < code.width; c++) {
        const tx = x + c
        const ty = y + r
        if (tx < width && ty < height) gray[ty * width + tx] = code.gray[r * code.width + c]
      }
    }
  }
  return { width, height, gray }
}

/** Test stand-in for the canvas reader: crop + nearest-neighbour scale to RGBA. */
async function readFrame(photo, pass) {
  const { sx, sy, sw, sh, dw, dh } = pass
  const data = new Uint8ClampedArray(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const srcY = sy + Math.min(sh - 1, Math.floor((y * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const srcX = sx + Math.min(sw - 1, Math.floor((x * sw) / dw))
      const v = photo.gray[srcY * photo.width + srcX]
      const i = (y * dw + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { data, width: dw, height: dh }
}

describe('planPhotoPasses', () => {
  it('scales a large photo to the max edge, then adds a centre crop at full detail', () => {
    const passes = planPhotoPasses(4000, 3000)
    expect(passes.map(p => p.name)).toEqual(['full', 'centre'])
    expect(passes[0]).toMatchObject({ sx: 0, sy: 0, sw: 4000, sh: 3000, dw: PHOTO_MAX_EDGE, dh: 1920 })
    expect(passes[1]).toMatchObject({ sw: 2400, sh: 1800, dw: 2400, dh: 1800, sx: 800, sy: 600 })
  })

  it('uses one pass when the photo already fits', () => {
    const passes = planPhotoPasses(1600, 1200)
    expect(passes).toHaveLength(1)
    expect(passes[0]).toMatchObject({ dw: 1600, dh: 1200 })
  })

  it('handles portrait photos and refuses empty ones', () => {
    expect(planPhotoPasses(3000, 4000)[0]).toMatchObject({ dw: 1920, dh: PHOTO_MAX_EDGE })
    expect(planPhotoPasses(0, 100)).toEqual([])
    expect(planPhotoPasses(NaN, NaN)).toEqual([])
  })
})

describe('pickBadge', () => {
  it('accepts exactly one valid badge, even if read more than once', () => {
    expect(pickBadge([BADGE_A])).toEqual({ status: 'ok', badge: BADGE_A, badges: [BADGE_A] })
    expect(pickBadge([BADGE_A, `*${BADGE_A}*`, BADGE_A.toLowerCase()])).toMatchObject({ status: 'ok', badge: BADGE_A })
  })

  it('refuses a photo with two different badges', () => {
    expect(pickBadge([BADGE_A, BADGE_B])).toEqual({ status: 'multiple', badge: null, badges: [BADGE_A, BADGE_B] })
  })

  it('ignores reads that are not badges', () => {
    expect(pickBadge(['FB597808Z AE', 'HELLO', '', null])).toEqual({ status: 'none', badge: null, badges: [] })
    expect(pickBadge(['FB597808Z AE', BADGE_A])).toMatchObject({ status: 'ok', badge: BADGE_A })
  })
})

describe('decodeBadgePhoto (decoder wiring)', () => {
  const photo = { width: 1200, height: 900 }

  it('returns the native read without running the software decoder', async () => {
    const zxingDecode = vi.fn()
    const res = await decodeBadgePhoto(photo, {
      readFrame: vi.fn(),
      nativeDetect: vi.fn().mockResolvedValue([BADGE_A]),
      zxingDecode,
    })
    expect(res).toMatchObject({ status: 'ok', badge: BADGE_A, engine: 'Native' })
    expect(zxingDecode).not.toHaveBeenCalled()
  })

  it('falls back to the software decoder when native finds nothing or fails', async () => {
    const zxingDecode = vi.fn().mockResolvedValue([{ rawValue: BADGE_A }])
    for (const nativeDetect of [vi.fn().mockResolvedValue([]), vi.fn().mockRejectedValue(new Error('boom'))]) {
      const res = await decodeBadgePhoto(photo, { readFrame: vi.fn().mockResolvedValue({}), nativeDetect, zxingDecode })
      expect(res).toMatchObject({ status: 'ok', badge: BADGE_A, engine: 'ZXingCpp', pass: 'full' })
    }
  })

  it('stops at the first pass that decides, including a two-badge photo', async () => {
    const zxingDecode = vi.fn().mockResolvedValue([{ rawValue: BADGE_A }, { rawValue: BADGE_B }])
    const res = await decodeBadgePhoto({ width: 4000, height: 3000 }, { readFrame: vi.fn().mockResolvedValue({}), nativeDetect: null, zxingDecode })
    expect(res.status).toBe('multiple')
    expect(zxingDecode).toHaveBeenCalledTimes(1)
  })

  it('loads the software decoder only when native does not settle the photo', async () => {
    const loadZxing = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue([{ rawValue: BADGE_A }]))
    const viaNative = await decodeBadgePhoto(photo, { readFrame: vi.fn().mockResolvedValue({}), nativeDetect: vi.fn().mockResolvedValue([BADGE_A]), loadZxing })
    expect(viaNative.engine).toBe('Native')
    expect(loadZxing).not.toHaveBeenCalled()
    const viaZxing = await decodeBadgePhoto(photo, { readFrame: vi.fn().mockResolvedValue({}), nativeDetect: vi.fn().mockResolvedValue([]), loadZxing })
    expect(viaZxing).toMatchObject({ status: 'ok', engine: 'ZXingCpp' })
    expect(loadZxing).toHaveBeenCalledTimes(1)
  })

  it('reports no_engine when the software decoder cannot load and there is no native one', async () => {
    const res = await decodeBadgePhoto(photo, { readFrame: vi.fn(), nativeDetect: null, loadZxing: vi.fn().mockResolvedValue(null) })
    expect(res.status).toBe('no_engine')
    const withNative = await decodeBadgePhoto(photo, { readFrame: vi.fn(), nativeDetect: vi.fn().mockResolvedValue([]), loadZxing: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(withNative.status).toBe('none')
  })

  it('reports no_engine when neither decoder is available', async () => {
    const res = await decodeBadgePhoto(photo, { readFrame: vi.fn(), nativeDetect: null, zxingDecode: null })
    expect(res.status).toBe('no_engine')
  })

  it('reports unreadable_image when no frame can be read', async () => {
    const res = await decodeBadgePhoto(photo, {
      readFrame: vi.fn().mockRejectedValue(new Error('canvas')),
      nativeDetect: null,
      zxingDecode: vi.fn(),
    })
    expect(res.status).toBe('unreadable_image')
  })

  it('reports none and the raw texts it saw when nothing is a badge', async () => {
    const res = await decodeBadgePhoto(photo, {
      readFrame: vi.fn().mockResolvedValue({}),
      nativeDetect: null,
      zxingDecode: vi.fn().mockResolvedValue([{ rawValue: 'FB597808Z AE' }]),
    })
    expect(res).toMatchObject({ status: 'none', badge: null, rawCount: 1 })
  })

  it('gives up on a native detector that hangs', async () => {
    vi.useFakeTimers()
    try {
      const pending = decodeBadgePhoto(photo, {
        readFrame: vi.fn().mockResolvedValue({}),
        nativeDetect: () => new Promise(() => {}),
        zxingDecode: vi.fn().mockResolvedValue([{ rawValue: BADGE_A }]),
      })
      await vi.advanceTimersByTimeAsync(5000)
      await expect(pending).resolves.toMatchObject({ status: 'ok', engine: 'ZXingCpp' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('decodeBadgePhoto (real zxing-cpp)', () => {
  let zxingDecode
  beforeAll(async () => {
    const bytes = fs.readFileSync(WASM_PATH)
    zxingDecode = await loadZxingCpp({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  })

  it('reads one badge anywhere in a large photo', async () => {
    const photo = makePhoto(3000, 2000, [{ text: BADGE_A, x: 1700, y: 1300 }])
    const res = await decodeBadgePhoto(photo, { readFrame, nativeDetect: null, zxingDecode })
    expect(res).toMatchObject({ status: 'ok', badge: BADGE_A, engine: 'ZXingCpp' })
  })

  it('reads a small badge in the centre that the downscaled pass loses', async () => {
    // 2.5 px/module at full size drops to 1.6 after scaling 4000 -> 2560,
    // below what zxing-cpp reads; the full-detail centre crop still reads it.
    const photo = makePhoto(4000, 3000, [{ text: BADGE_A, x: 1700, y: 1400, px: 2.5 }])
    const res = await decodeBadgePhoto(photo, { readFrame, nativeDetect: null, zxingDecode })
    expect(res).toMatchObject({ status: 'ok', badge: BADGE_A, pass: 'centre' })
  })

  it('refuses a photo holding two different badges', async () => {
    const photo = makePhoto(2400, 1800, [
      { text: BADGE_A, x: 200, y: 300 },
      { text: BADGE_B, x: 200, y: 1200 },
    ])
    const res = await decodeBadgePhoto(photo, { readFrame, nativeDetect: null, zxingDecode })
    expect(res.status).toBe('multiple')
    expect(res.badges.sort()).toEqual([BADGE_A, BADGE_B].sort())
  })

  it('reports none for a photo with no barcode', async () => {
    const photo = makePhoto(1600, 1200, [])
    const res = await decodeBadgePhoto(photo, { readFrame, nativeDetect: null, zxingDecode })
    expect(res.status).toBe('none')
  })
})
