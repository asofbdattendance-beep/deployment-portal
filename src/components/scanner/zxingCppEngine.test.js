/**
 * zxingCppEngine — the ZXing-C++ (WebAssembly) decoder adapter.
 *
 * The decode tests run the REAL zxing-cpp WebAssembly binary from
 * node_modules on synthetic badge frames (barcodeFixtures.js — no real badge
 * data), with the same reader options the engine pool uses.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { loadZxingCpp, toCppFormats, toDetection } from './zxingCppEngine'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS, HARD_PATH_2D_FORMATS } from '../../lib/deviceCapabilities'
import { BADGE, encodeCode39, encodeCode128B, renderAt } from '../../lib/barcodeFixtures'
import { rotateGray } from '../../lib/scannerUtils'

const require = createRequire(import.meta.url)
const WASM_PATH = require.resolve('zxing-wasm/reader/zxing_reader.wasm')

/** Gray frame → RGBA {data,width,height}, the shape surface.read() hands the pool. */
function toRgba({ gray, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < gray.length; i++) {
    data[i * 4] = gray[i]; data[i * 4 + 1] = gray[i]; data[i * 4 + 2] = gray[i]; data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

const OPTS = {
  formats: toCppFormats([...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS]),
  tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
}

describe('toCppFormats', () => {
  it('maps every format the scanner configures', () => {
    const all = [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS, ...HARD_PATH_2D_FORMATS]
    expect(toCppFormats(all)).toHaveLength(all.length)
    expect(toCppFormats(['code_39', 'ean_13', 'qr_code'])).toEqual(['Code39', 'EAN13', 'QRCode'])
  })

  it('skips unknown and empty entries instead of throwing', () => {
    expect(toCppFormats(['code_39', 'nonsense', '', null, 'CODE_39'])).toEqual(['Code39'])
    expect(toCppFormats(undefined)).toEqual([])
  })
})

describe('toDetection', () => {
  it('returns four corner points in frame pixels', () => {
    const d = toDetection({
      text: 'FB5971GA0001',
      position: { topLeft: { x: 1, y: 2 }, topRight: { x: 9, y: 2 }, bottomRight: { x: 9, y: 6 }, bottomLeft: { x: 1, y: 6 } },
    })
    expect(d.rawValue).toBe('FB5971GA0001')
    expect(d.cornerPoints).toEqual([{ x: 1, y: 2 }, { x: 9, y: 2 }, { x: 9, y: 6 }, { x: 1, y: 6 }])
  })

  it('tolerates a missing position', () => {
    expect(toDetection({ text: 'X' })).toEqual({ rawValue: 'X', cornerPoints: [] })
  })
})

describe('loadZxingCpp', () => {
  it('resolves null (never throws) when WebAssembly is unavailable', async () => {
    const real = globalThis.WebAssembly
    try {
      globalThis.WebAssembly = undefined
      expect(await loadZxingCpp()).toBeNull()
    } finally {
      globalThis.WebAssembly = real
    }
  })
})

describe('real zxing-cpp decode', () => {
  let decode
  beforeAll(async () => {
    const bytes = fs.readFileSync(WASM_PATH)
    decode = await loadZxingCpp({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  })

  it('loads from the bundled binary', () => {
    expect(typeof decode).toBe('function')
  })

  it('reads a Code 39 badge', async () => {
    const res = await decode(toRgba(renderAt(encodeCode39(BADGE), 3)), OPTS)
    expect(res.map(r => r.rawValue)).toEqual([BADGE])
    expect(res[0].cornerPoints).toHaveLength(4)
  })

  it('reads a Code 128 badge', async () => {
    const res = await decode(toRgba(renderAt(encodeCode128B(BADGE), 3)), OPTS)
    expect(res[0]?.rawValue).toBe(BADGE)
  })

  it('reads a badge turned 90° without a manual rotation pass', async () => {
    const f = renderAt(encodeCode39(BADGE), 3)
    const r = rotateGray(f.gray, f.width, f.height, 90)
    const res = await decode(toRgba(r), OPTS)
    expect(res[0]?.rawValue).toBe(BADGE)
  })

  it('returns an empty list (not a throw) for a blank frame', async () => {
    const blank = { gray: new Uint8ClampedArray(320 * 120).fill(230), width: 320, height: 120 }
    expect(await decode(toRgba(blank), OPTS)).toEqual([])
  })
})
