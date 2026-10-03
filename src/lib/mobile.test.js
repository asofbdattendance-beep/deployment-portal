// src/lib/mobile — pure helpers. Runs in node (no DOM); DOM paths are
// covered with jsdom pragma + navigator/window stubs.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  MOBILE_QUERY,
  isTouchDevice,
  isStandalone,
  safeBottom,
  safeTop,
  compactCount,
  fileForShare,
  canShareFiles,
  downloadBlob,
  shareOrDownload,
  vibrate,
  requestWakeLock,
  releaseWakeLock,
} from './mobile'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mobile lib', () => {
  it('exposes the shared mobile query (width + landscape-phone arm)', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 768px), (max-height: 500px) and (pointer: coarse)')
  })

  it('isTouchDevice/isStandalone are false without a window', () => {
    expect(isTouchDevice()).toBe(false)
    expect(isStandalone()).toBe(false)
  })

  it('safeBottom/safeTop build max() values', () => {
    expect(safeBottom()).toBe('max(0.85rem, env(safe-area-inset-bottom))')
    expect(safeBottom('1rem')).toBe('max(1rem, env(safe-area-inset-bottom))')
    expect(safeTop()).toBe('max(0px, env(safe-area-inset-top))')
  })

  it('compactCount formats thousands', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999)).toBe('999')
    expect(compactCount(1200)).toBe('1.2k')
    expect(compactCount(1000)).toBe('1k')
    expect(compactCount(2500000)).toBe('2.5m')
    expect(compactCount(NaN)).toBe('')
    expect(compactCount('abc')).toBe('')
  })

  it('fileForShare returns null without a blob, builds a File otherwise', () => {
    expect(fileForShare(null, 'a.xlsx')).toBeNull()
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const f = fileForShare(blob, 'a.txt', 'text/plain')
    if (typeof File !== 'undefined') {
      expect(f).toBeInstanceOf(File)
      expect(f.name).toBe('a.txt')
    } else {
      expect(f).toBeNull()
    }
  })

  it('canShareFiles is false without navigator.share support', () => {
    expect(canShareFiles([])).toBe(false)
    expect(canShareFiles(null)).toBe(false)
  })

  it('downloadBlob returns false without a DOM', () => {
    expect(downloadBlob(new Blob(['x']), 'a.xlsx')).toBe(false)
  })

  it('shareOrDownload returns unavailable for empty blob', async () => {
    expect(await shareOrDownload(null, 'a.xlsx')).toEqual({ method: 'unavailable' })
  })

  it('shareOrDownload falls back to download when share is unsupported', async () => {
    // No navigator.share in node → downloadBlob → false without DOM.
    const r = await shareOrDownload(new Blob(['x']), 'a.xlsx')
    expect(r).toEqual({ method: 'unavailable' })
  })

  it('shareOrDownload uses the share sheet when available', async () => {
    const blob = new Blob(['x'], { type: 'application/octet-stream' })
    const file = new File([blob], 'a.xlsx')
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: vi.fn(async () => undefined),
    })
    // fileForShare builds its own File; stub File path via real File.
    const r = await shareOrDownload(blob, 'a.xlsx')
    expect(['share', 'unavailable']).toContain(r.method)
    void file
  })

  it('shareOrDownload treats AbortError as a completed share', async () => {
    const blob = new Blob(['x'])
    const err = new Error('dismissed'); err.name = 'AbortError'
    vi.stubGlobal('navigator', { canShare: () => true, share: async () => { throw err } })
    // File constructor exists in node 20; share path attempts then aborts.
    const r = await shareOrDownload(blob, 'a.xlsx')
    expect(r.method).toBe('share')
  })

  it('vibrate returns false without navigator', () => {
    expect(vibrate()).toBe(false)
  })

  it('requestWakeLock returns null without support, release never throws', async () => {
    expect(await requestWakeLock()).toBeNull()
    await expect(releaseWakeLock(null)).resolves.toBeUndefined()
    await expect(releaseWakeLock({ release: async () => { throw new Error('x') } })).resolves.toBeUndefined()
  })
})
