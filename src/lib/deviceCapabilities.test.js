import { describe, it, expect } from 'vitest'
import {
  SCANNER_TIERS,
  SCANNER_TIER_BUDGETS,
  TIER_SIGNALS,
  BASE_1D_FORMATS,
  EXTENDED_1D_FORMATS,
  HARD_PATH_2D_FORMATS,
  scannerTierFromSignals,
  budgetForTier,
  adjacentTier,
  capabilitiesFrom,
  readCoreCount,
  readMemoryGB,
  probeRuntimeCapabilities,
  tierFromCapabilities,
} from './deviceCapabilities'

describe('scannerTierFromSignals', () => {
  it('a measured slow decode outranks strong static signals', () => {
    // Spec says: timing beats what a vendor fills in optimistically.
    expect(scannerTierFromSignals({ cores: 16, memory: 16, avgDecodeMs: 400 })).toBe('low')
  })

  it('a measured fast decode upgrades even a weak static device', () => {
    expect(scannerTierFromSignals({ cores: 2, memory: 1, avgDecodeMs: 10 })).toBe('high')
  })

  it('high = strong cores AND strong mem', () => {
    expect(scannerTierFromSignals({ cores: 8, memory: 8 })).toBe('high')
    expect(scannerTierFromSignals({ cores: 12, memory: 16 })).toBe('high')
  })

  it('low = two weak signals', () => {
    expect(scannerTierFromSignals({ cores: 4, memory: 2 })).toBe('low')
    expect(scannerTierFromSignals({ cores: 2, memory: 1 })).toBe('low')
  })

  it('one weak signal alone still lands low (the phone that drops frames)', () => {
    expect(scannerTierFromSignals({ cores: 4, memory: 6 })).toBe('low')
    expect(scannerTierFromSignals({ cores: 8, memory: 2 })).toBe('low')
  })

  it('mixed/unknown signals default to mid', () => {
    expect(scannerTierFromSignals({ cores: 6, memory: 4 })).toBe('mid')
    expect(scannerTierFromSignals({})).toBe('mid')
    expect(scannerTierFromSignals({ cores: null, memory: undefined, avgDecodeMs: NaN })).toBe('mid')
  })

  it('timing windows are respected at the boundary', () => {
    expect(scannerTierFromSignals({ avgDecodeMs: TIER_SIGNALS.FAST_DECODE_MS })).toBe('mid')
    expect(scannerTierFromSignals({ avgDecodeMs: TIER_SIGNALS.SLOW_DECODE_MS })).toBe('mid')
    expect(scannerTierFromSignals({ avgDecodeMs: TIER_SIGNALS.FAST_DECODE_MS + 1 })).toBe('mid')
    expect(scannerTierFromSignals({ avgDecodeMs: TIER_SIGNALS.SLOW_DECODE_MS + 1 })).toBe('low')
  })
})

describe('budgetForTier', () => {
  it('returns a complete budget for every tier', () => {
    for (const t of SCANNER_TIERS) {
      const b = budgetForTier(t)
      expect(b.detectMaxWidth).toBeGreaterThan(0)
      expect(b.maxAngles).toBeGreaterThanOrEqual(1)
      expect(b.stillAfterMs).toBeGreaterThan(0)
      expect(b.maxFrameMs).toBeGreaterThan(0)
      expect(Array.isArray(b.formats)).toBe(true)
      expect(b.formats.length).toBeGreaterThan(0)
    }
  })

  it('work grows monotonically with tier capability', () => {
    const [lo, mid, hi] = SCANNER_TIERS.map(budgetForTier)
    expect(lo.detectMaxWidth).toBeLessThan(mid.detectMaxWidth)
    expect(mid.detectMaxWidth).toBeLessThan(hi.detectMaxWidth)
    expect(lo.maxAngles).toBeLessThanOrEqual(mid.maxAngles)
    expect(lo.stripCount).toBeLessThanOrEqual(mid.stripCount)
    // The expensive features are tier-gated, not global.
    expect(lo.allowDeskew).toBe(false)
    expect(mid.allowDeskew).toBe(true)
    expect(hi.quadrants).toBe(true)
    expect(mid.quadrants).toBe(false)
  })

  it('an unknown tier degrades to the low budget (fail-down, never throw)', () => {
    expect(budgetForTier('flagship')).toEqual(budgetForTier('low'))
    expect(budgetForTier(undefined)).toEqual(budgetForTier('low'))
    expect(budgetForTier(null)).toEqual(budgetForTier('low'))
  })

  it('hands back a fresh copy each call (no shared mutable state)', () => {
    const a = budgetForTier('high')
    a.formats.push('mutated')
    expect(budgetForTier('high').formats).not.toContain('mutated')
  })

  it('format lists are tiered: base ⊂ mid ⊂ hardPath high', () => {
    expect(budgetForTier('low').formats).toEqual(BASE_1D_FORMATS)
    expect(budgetForTier('mid').formats).toEqual([...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS])
    // 2D is hard-path-only and only on a device that can afford it.
    expect(budgetForTier('mid').hardPathFormats).not.toContain('qr_code')
    expect(budgetForTier('high').hardPathFormats).toEqual(
      [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS, ...HARD_PATH_2D_FORMATS],
    )
  })
})

describe('adjacentTier', () => {
  it('walks the ladder and stops at the ends', () => {
    expect(adjacentTier('low', 1)).toBe('mid')
    expect(adjacentTier('mid', 1)).toBe('high')
    expect(adjacentTier('mid', -1)).toBe('low')
    expect(adjacentTier('high', 1)).toBeNull()
    expect(adjacentTier('low', -1)).toBeNull()
  })

  it('clamps an invalid tier instead of exploding', () => {
    expect(adjacentTier('nonsense', 1)).toBe('mid')
    expect(adjacentTier(null, -1)).toBeNull()
  })
})

describe('capabilitiesFrom', () => {
  it('derives focus booleans from the raw focusMode list', () => {
    const c = capabilitiesFrom({ focusModes: ['continuous'] })
    expect(c.continuousFocus).toBe(true)
    expect(c.manualFocus).toBe(false)
  })

  it('defaults everything to false/empty when given nothing', () => {
    const c = capabilitiesFrom()
    expect(c.barcodeDetector).toBe(false)
    expect(c.supportedFormats).toEqual([])
    expect(c.imageCapture).toBe(false)
    expect(c.torch).toBe(false)
    expect(c.cores).toBeNull()
  })

  it('copies the formats array so callers cannot mutate ours', () => {
    const input = ['code_128']
    const c = capabilitiesFrom({ supportedFormats: input })
    input.push('evil')
    expect(c.supportedFormats).toEqual(['code_128'])
  })

  it('coerces non-finite cores/memory to null (Safari behaviour)', () => {
    const c = capabilitiesFrom({ cores: undefined, memory: NaN })
    expect(c.cores).toBeNull()
    expect(c.memory).toBeNull()
  })
})

describe('readCoreCount / readMemoryGB', () => {
  it('reads valid values', () => {
    expect(readCoreCount({ hardwareConcurrency: 8 })).toBe(8)
    expect(readMemoryGB({ deviceMemory: 4 })).toBe(4)
  })

  it('never throws and returns null for junk or a missing navigator', () => {
    expect(readCoreCount(null)).toBeNull()
    expect(readMemoryGB(null)).toBeNull()
    expect(readCoreCount({ hardwareConcurrency: -1 })).toBeNull()
    expect(readMemoryGB({ deviceMemory: 0 })).toBeNull()
    expect(readCoreCount({
      get hardwareConcurrency() { throw new Error('blocked') },
    })).toBeNull()
  })
})

describe('probeRuntimeCapabilities', () => {
  it('probes a browser exposing BarcodeDetector without leaking exceptions', async () => {
    const prev = globalThis.window
    globalThis.window = {
      BarcodeDetector: { getSupportedFormats: async () => ['code_39', 'qr_code'] },
    }
    try {
      const caps = await probeRuntimeCapabilities({ track: null })
      expect(caps.barcodeDetector).toBe(true)
      expect(caps.supportedFormats).toEqual(['code_39', 'qr_code'])
    } finally {
      globalThis.window = prev
    }
  })

  it('survives a hostile getSupportedFormats and a track that throws on getCapabilities', async () => {
    const prev = globalThis.window
    globalThis.window = {
      BarcodeDetector: { getSupportedFormats: async () => { throw new Error('nope') } },
    }
    const track = { getCapabilities() { throw new Error('nope') } }
    try {
      const caps = await probeRuntimeCapabilities({ track })
      expect(caps.supportedFormats).toEqual([])
      expect(caps.focusModes).toBeUndefined()
      expect(caps.continuousFocus).toBe(false)
      expect(caps.torch).toBe(false)
    } finally {
      globalThis.window = prev
    }
  })

  it('reads focus/zoom/torch off a real capability bag', async () => {
    const track = {
      getCapabilities: () => ({
        focusMode: ['continuous', 'manual'],
        zoom: { min: 1, max: 4 },
        torch: true,
        pointsOfInterest: ['region'],
      }),
    }
    const caps = await probeRuntimeCapabilities({ track, withFormats: false })
    expect(caps.continuousFocus).toBe(true)
    expect(caps.manualFocus).toBe(true)
    expect(caps.zoom).toBe(true)
    expect(caps.torch).toBe(true)
    expect(caps.pointsOfInterest).toBe(true)
  })
})

describe('tierFromCapabilities', () => {
  it('uses static signals from a snapshot', () => {
    expect(tierFromCapabilities(capabilitiesFrom({ cores: 8, memory: 8 }))).toBe('high')
    expect(tierFromCapabilities(capabilitiesFrom({ cores: 4, memory: 2 }))).toBe('low')
  })

  it('degrades to mid when given nothing at all', () => {
    expect(tierFromCapabilities(null)).toBe('mid')
    expect(tierFromCapabilities(undefined)).toBe('mid')
  })
})
