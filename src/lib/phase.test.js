import { describe, it, expect } from 'vitest'
import {
  PHASE_STORAGE_KEY,
  visiblePagesForRole,
  phasesForRole,
  defaultPhaseForRole,
  resolveActivePhase,
  pagesForRolePhase,
  readStoredPhase,
  storeActivePhase,
} from './phase'

describe('phase helpers', () => {
  it('exposes the storage key', () => {
    expect(PHASE_STORAGE_KEY).toBe('portal_active_phase')
  })

  it('lists phases per role', () => {
    expect(phasesForRole('aso')).toEqual([1, 2])
    expect(phasesForRole('super_admin')).toEqual([1, 2])
    expect(phasesForRole('centre_user')).toEqual([1, 2])
    expect(phasesForRole('vss_operator')).toEqual([1])
    expect(phasesForRole('dept_incharge')).toEqual([2])
    expect(phasesForRole('scanner')).toEqual([2])
    expect(phasesForRole('nobody')).toEqual([])
  })

  it('defaults to the first visible phase', () => {
    expect(defaultPhaseForRole('aso')).toBe(1)
    expect(defaultPhaseForRole('dept_incharge')).toBe(2)
    expect(defaultPhaseForRole('scanner')).toBe(2)
    expect(defaultPhaseForRole('nobody')).toBe(1)
  })

  it('honours a stored phase only when visible to the role', () => {
    expect(resolveActivePhase('aso', '2')).toBe(2)
    expect(resolveActivePhase('aso', '1')).toBe(1)
    expect(resolveActivePhase('dept_incharge', '1')).toBe(2)
    expect(resolveActivePhase('scanner', '1')).toBe(2)
    expect(resolveActivePhase('aso', 'nope')).toBe(1)
    expect(resolveActivePhase('aso', null)).toBe(1)
    expect(resolveActivePhase('aso', undefined)).toBe(1)
  })

  it('filters pages by role and phase in registry order', () => {
    expect(pagesForRolePhase('aso', 1).map(([k]) => k)).toEqual(
      ['schedule', 'consent', 'vss', 'deployment', 'centreLists']
    )
    expect(pagesForRolePhase('dept_incharge', 1)).toEqual([])
    expect(visiblePagesForRole('scanner').map(([k]) => k)).toEqual(['scanner'])
  })

  it('storage helpers never throw without localStorage', () => {
    expect(() => storeActivePhase(2)).not.toThrow()
    expect(readStoredPhase()).toBeNull()
  })
})
