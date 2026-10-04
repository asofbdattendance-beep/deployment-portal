// @vitest-environment jsdom
// useDeptNames — offline-first department reference data.
//
// Proves: (1) an offline reload seeds dept names from the IndexedDB snapshot
// with zero network, (2) live rows overwrite + persist, (3) an empty live
// fetch never wipes a good cache.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDeptNames, refreshDeptNames } from './useDeptNames'
import { writeDeptMap, readDeptMap } from '../lib/sewadarDirectory'

const fetchAllRows = vi.fn()
vi.mock('../lib/supabase', () => ({
  fetchAllRows: (...args) => fetchAllRows(...args),
}))

async function clearCache() {
  // sewadar_cache has no bulk clear; overwrite with an empty (refused) write
  // is a no-op, so delete via a direct IDB pass.
  await new Promise((resolve) => {
    const req = indexedDB.open('sewadar_offline_q', 2)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sewadar_cache')) { db.close(); return resolve() }
      const tx = db.transaction('sewadar_cache', 'readwrite')
      tx.objectStore('sewadar_cache').clear()
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
    }
    req.onerror = () => resolve()
  })
}

beforeEach(async () => {
  fetchAllRows.mockReset()
  // Warm the schema through the module FIRST: a raw indexedDB.open() on a
  // missing DB creates an empty v2 with NO stores (onupgradeneeded never
  // fires), which makes every later transaction throw NotFoundError.
  await writeDeptMap([{ id: '__warm__', name: 'Warm' }])
  await clearCache()
})

describe('useDeptNames', () => {
  it('seeds from the cache with no network', async () => {
    await writeDeptMap([{ id: 'd1', name: 'MEDICAL' }])
    fetchAllRows.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useDeptNames())
    // The seed effect reads IndexedDB (macrotasks) — wait for it, don't
    // assume a bare act() flushes IDB.
    await waitFor(() => expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }]))
    await act(async () => { await refreshDeptNames(result.current[1]) })
    expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }])
    expect(await readDeptMap()).toEqual([{ id: 'd1', name: 'MEDICAL' }])
  })

  it('live rows overwrite and persist', async () => {
    await writeDeptMap([{ id: 'd-old', name: 'OLD' }])
    fetchAllRows.mockResolvedValue([{ id: 'd1', name: 'MEDICAL' }, { id: 'd2', name: 'TRAFFIC' }])
    const { result } = renderHook(() => useDeptNames())
    await waitFor(() => expect(result.current[0]).toEqual([{ id: 'd-old', name: 'OLD' }]))
    let ok = false
    await act(async () => { ok = await refreshDeptNames(result.current[1]) })
    expect(ok).toBe(true)
    expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }, { id: 'd2', name: 'TRAFFIC' }])
    expect(await readDeptMap()).toEqual([{ id: 'd1', name: 'MEDICAL' }, { id: 'd2', name: 'TRAFFIC' }])
  })

  it('an empty live fetch keeps the cache', async () => {
    await writeDeptMap([{ id: 'd1', name: 'MEDICAL' }])
    fetchAllRows.mockResolvedValue([])
    const { result } = renderHook(() => useDeptNames())
    // Seed lands first from the effect.
    await waitFor(() => expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }]))
    expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }])
    let ok = true
    await act(async () => { ok = await refreshDeptNames(result.current[1]) })
    expect(ok).toBe(false)
    expect(result.current[0]).toEqual([{ id: 'd1', name: 'MEDICAL' }])
  })
})
