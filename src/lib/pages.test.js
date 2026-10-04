import { describe, it, expect } from 'vitest'
import { PAGES, PHASES } from './pages'

describe('PAGES phase registry', () => {
  it('labels the two phases Deployment and Attendance', () => {
    expect(PHASES).toEqual({ 1: 'Deployment', 2: 'Attendance' })
  })

  it('gives every page exactly one valid phase and no legacy group', () => {
    for (const [key, cfg] of Object.entries(PAGES)) {
      expect([1, 2], `${key} phase`).toContain(cfg.phase)
      expect(cfg, `${key} group`).not.toHaveProperty('group')
    }
  })

  it('keeps key/label/roles/icon shape intact for every entry', () => {
    for (const [key, cfg] of Object.entries(PAGES)) {
      expect(typeof cfg.label, `${key} label`).toBe('string')
      expect(Array.isArray(cfg.roles), `${key} roles`).toBe(true)
      expect(cfg.icon, `${key} icon`).toBeTruthy()
    }
  })

  it('assigns the agreed Phase 1 (deployment) set', () => {
    const phase1 = Object.entries(PAGES).filter(([, c]) => c.phase === 1).map(([k]) => k)
    expect(phase1).toEqual(['schedule', 'consent', 'vss', 'deployment', 'centreLists', 'control', 'users'])
  })

  it('assigns the agreed Phase 2 (attendance) set', () => {
    const phase2 = Object.entries(PAGES).filter(([, c]) => c.phase === 2).map(([k]) => k)
    expect(phase2).toEqual(['dashboard', 'alloc', 'inchargeDashboard', 'scanner', 'attendance', 'reports', 'liveScanners', 'anomalies'])
  })

  it('gives aso 5 + 7, super_admin 7 + 7 pages across the phases', () => {
    const forRolePhase = (role, phase) =>
      Object.entries(PAGES).filter(([, c]) => c.roles.includes(role) && c.phase === phase).map(([k]) => k)
    expect(forRolePhase('aso', 1)).toEqual(['schedule', 'consent', 'vss', 'deployment', 'centreLists'])
    expect(forRolePhase('aso', 2)).toEqual(['dashboard', 'alloc', 'scanner', 'attendance', 'reports', 'liveScanners', 'anomalies'])
    expect(forRolePhase('super_admin', 1)).toEqual(['schedule', 'consent', 'vss', 'deployment', 'centreLists', 'control', 'users'])
    expect(forRolePhase('super_admin', 2)).toEqual(['dashboard', 'alloc', 'scanner', 'attendance', 'reports', 'liveScanners', 'anomalies'])
  })

  it('gives single-phase roles the right landing phase', () => {
    const firstPhase = (role) => Object.entries(PAGES).find(([, c]) => c.roles.includes(role))?.[1].phase
    expect(firstPhase('centre_user')).toBe(1)
    expect(firstPhase('vss_operator')).toBe(1)
    expect(firstPhase('dept_incharge')).toBe(2)
    expect(firstPhase('scanner')).toBe(2)
  })
})
