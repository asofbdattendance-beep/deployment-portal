// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import {
  toDirectoryEntry,
  toVssEntry,
  buildDirectoryMap,
  directoryLookup,
  writeDirectory,
  readDirectory,
} from './sewadarDirectory'

/* ─── toDirectoryEntry ─── */
describe('toDirectoryEntry', () => {
  it('normalizes a deployments row, deployed beats requested', () => {
    expect(toDirectoryEntry({
      badge_number: 'fb5971ga0001',
      sewadar_name: ' Asha ',
      centre: 'DELHI-7',
      department_id: 'd-req',
      deployed_department_id: 'd-final',
    })).toEqual({ badge: 'FB5971GA0001', name: 'Asha', centre: 'DELHI-7', deptId: 'd-final', deptName: null })
  })

  it('falls back to the requested dept when nothing finalized', () => {
    expect(toDirectoryEntry({ badge_number: 'B1', department_id: 'd-req', deployed_department_id: null }).deptId).toBe('d-req')
  })

  it('yields null deptId when undeployed, nulls for blanks', () => {
    expect(toDirectoryEntry({ badge_number: 'B1', sewadar_name: '  ', centre: null })).toEqual(
      { badge: 'B1', name: null, centre: null, deptId: null, deptName: null })
  })

  it('returns null for missing badge or non-rows', () => {
    expect(toDirectoryEntry({ sewadar_name: 'NoBadge' })).toBeNull()
    expect(toDirectoryEntry(null)).toBeNull()
    expect(toDirectoryEntry('nonsense')).toBeNull()
  })
})

/* ─── toVssEntry ─── */
describe('toVssEntry', () => {
  it('normalizes a roster row, department stays a NAME', () => {
    expect(toVssEntry({ badge_number: 'vs0007', sewadar_name: 'VSS A', centre: 'C1', department: 'LANGAR' }))
      .toEqual({ badge: 'VS0007', name: 'VSS A', centre: 'C1', deptId: null, deptName: 'LANGAR' })
  })

  it('returns null for missing badge', () => {
    expect(toVssEntry({ sewadar_name: 'NoBadge' })).toBeNull()
  })
})

/* ─── buildDirectoryMap ─── */
describe('buildDirectoryMap', () => {
  it('keys by UPPER badge and prefers the finalized row', () => {
    const m = buildDirectoryMap([
      { badge_number: 'fb1', sewadar_name: 'A', department_id: 'd-req', deployed_department_id: null },
      { badge_number: 'FB1', sewadar_name: 'A', department_id: 'd-req', deployed_department_id: 'd-final' },
    ])
    expect(m.size).toBe(1)
    expect(m.get('FB1').deptId).toBe('d-final')
  })

  it('keeps the first row when neither is finalized, skips bad rows', () => {
    const m = buildDirectoryMap([
      null,
      { badge_number: 'B1', sewadar_name: 'First' },
      { badge_number: 'B1', sewadar_name: 'Second' },
    ])
    expect(m.get('B1').name).toBe('First')
  })

  it('fills VSS badges with no deployment row, never overwrites deployments', () => {
    const m = buildDirectoryMap(
      [{ badge_number: 'FB1', sewadar_name: 'Asha' }],
      [
        { badge_number: 'FB1', sewadar_name: 'Roster Override', department: 'X' },
        { badge_number: 'VS7', sewadar_name: 'VSS Seven', centre: 'C9', department: 'LANGAR' },
      ],
    )
    expect(m.get('FB1').name).toBe('Asha')
    expect(m.get('VS7')).toEqual({ badge: 'VS7', name: 'VSS Seven', centre: 'C9', deptId: null, deptName: 'LANGAR' })
  })
})

/* ─── directoryLookup ─── */
describe('directoryLookup', () => {
  it('finds case-insensitively, null on miss or bad input', () => {
    const m = buildDirectoryMap([{ badge_number: 'FB1', sewadar_name: 'Asha' }])
    expect(directoryLookup(m, 'fb1').name).toBe('Asha')
    expect(directoryLookup(m, 'NOPE')).toBeNull()
    expect(directoryLookup(null, 'FB1')).toBeNull()
    expect(directoryLookup(m, '')).toBeNull()
  })
})

/* ─── write/read round trip (real IndexedDB via fake-indexeddb) ─── */
describe('writeDirectory / readDirectory', () => {
  it('round-trips rows and reports fresh', async () => {
    const rows = [{ badge_number: 'FB1', sewadar_name: 'Asha', centre: 'D7', department_id: 'd1', deployed_department_id: null }]
    expect(await writeDirectory('sched-dir-1', rows)).toBe(true)
    const { map, stale, count } = await readDirectory('sched-dir-1')
    expect(stale).toBe(false)
    expect(count).toBe(1)
    expect(map.get('FB1')).toEqual({ badge: 'FB1', name: 'Asha', centre: 'D7', deptId: 'd1', deptName: null })
  })

  it('round-trips the v2 {rows, vss} shape', async () => {
    await writeDirectory('sched-v2', [{ badge_number: 'FB1', sewadar_name: 'A' }], [{ badge_number: 'VS7', sewadar_name: 'V' }])
    const v2 = await readDirectory('sched-v2')
    expect(v2.stale).toBe(false)
    expect(v2.map.get('FB1').name).toBe('A')
    expect(v2.map.get('VS7').name).toBe('V')
  })

  it('reports stale (not an error) when nothing cached', async () => {
    const { map, stale, count } = await readDirectory('sched-never-cached')
    expect(stale).toBe(true)
    expect(count).toBe(0)
    expect(map.size).toBe(0)
  })

  it('refuses bad input without throwing', async () => {
    expect(await writeDirectory(null, [])).toBe(false)
    expect(await writeDirectory('s', null)).toBe(false)
  })
})
