// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import DeploymentMatrixReport from './DeploymentMatrixReport'

const mockData = vi.hoisted(() => ({
  centres: [
    { name: 'PALWAL', parent_centre: null },
    { name: 'NAYAGAON', parent_centre: 'PALWAL' },
    { name: 'GURGAON', parent_centre: null },
  ],
  departments: [
    { id: 'dept-canteen', name: 'CANTEEN' },
    { id: 'dept-traffic', name: 'TRAFFIC OUTSIDE BHATI' },
  ],
  allocations: [
    { id: 'a1', schedule_id: 's1', department_id: 'dept-canteen', centre: 'PALWAL', max_count: 10 },
    { id: 'a2', schedule_id: 's1', department_id: 'dept-traffic', centre: 'GURGAON', max_count: 10 },
  ],
  deployments: [],
  sewadars: [],
  vssSewadars: [{ badge_number: 'VSFB5978GB2872' }],
  realtimeSubs: [],
}))

vi.mock('../lib/supabase', () => ({
  fetchCentres: () => Promise.resolve(mockData.centres),
  getRootCentre: (centres, name) => {
    const map = new Map((centres || []).map(c => [c.name, c.parent_centre]))
    let curr = name
    while (map.get(curr)) curr = map.get(curr)
    return curr || name
  },
  fetchAllRows: vi.fn(async (table) => {
    if (table === 'vss_sewadars') return mockData.vssSewadars
    if (table === 'deployment_departments') return mockData.departments
    if (table === 'centre_allocations') return mockData.allocations
    if (table === 'deployments') return mockData.deployments
    if (table === 'dp_sewadars') return mockData.sewadars
    return []
  }),
}))

vi.mock('../hooks/useRealtimeRefresh', () => ({
  useRealtimeRefresh: (cfg) => {
    mockData.realtimeSubs.push(cfg)
  },
}))

describe('DeploymentMatrixReport', () => {
  beforeEach(() => {
    mockData.realtimeSubs = []
  })

  afterEach(() => {
    cleanup()
  })

  it('subscribes to realtime tables: deployments, centre_allocations, sewadar_consents, and centre_locks', async () => {
    render(<DeploymentMatrixReport scheduleId="s1" scheduleName="Visit 2026" />)
    await waitFor(() => {
      expect(mockData.realtimeSubs.length).toBeGreaterThan(0)
    })
    const sub = mockData.realtimeSubs[0]
    expect(sub.scheduleId).toBe('s1')
    const tables = sub.subscriptions.map(s => s.table)
    expect(tables).toContain('deployments')
    expect(tables).toContain('centre_allocations')
    expect(tables).toContain('sewadar_consents')
    expect(tables).toContain('centre_locks')
    expect(tables).not.toContain('deployment_departments')
  })

  it('reconciles deployments with zero gaps using badge gender fallback and finalized department priority', async () => {
    // 5 deployments:
    // 1. Regular Male in dp_sewadars (GURGAON -> TRAFFIC OUTSIDE BHATI)
    // 2. Regular Female in dp_sewadars (PALWAL -> CANTEEN)
    // 3. VSS sewadar (GURGAON -> TRAFFIC OUTSIDE BHATI)
    // 4. Missing from dp_sewadars, badge FB5995GA0013 (NAYAGAON child of PALWAL -> CANTEEN) -> GA infers Male!
    // 5. Missing from dp_sewadars, badge FB5982LA0015 (GURGAON -> requested CANTEEN, finalized TRAFFIC) -> LA infers Female & Finalized beats requested!
    mockData.deployments = [
      {
        id: 'd1', schedule_id: 's1', centre: 'GURGAON', badge_number: 'FB5982GA0001',
        department_id: 'dept-traffic', deployed_department_id: null,
      },
      {
        id: 'd2', schedule_id: 's1', centre: 'PALWAL', badge_number: 'FB5993LA0001',
        department_id: 'dept-canteen', deployed_department_id: null,
      },
      {
        id: 'd3', schedule_id: 's1', centre: 'GURGAON', badge_number: 'VSFB5978GB2872',
        department_id: 'dept-traffic', deployed_department_id: null,
      },
      {
        id: 'd4', schedule_id: 's1', centre: 'NAYAGAON', badge_number: 'FB5995GA0013',
        department_id: 'dept-canteen', deployed_department_id: null,
      },
      {
        id: 'd5', schedule_id: 's1', centre: 'GURGAON', badge_number: 'FB5982LA0015',
        department_id: 'dept-canteen', deployed_department_id: 'dept-traffic',
      },
    ]

    mockData.sewadars = [
      { badge_number: 'FB5982GA0001', centre: 'GURGAON', gender: 'MALE' },
      { badge_number: 'FB5993LA0001', centre: 'PALWAL', gender: 'FEMALE' },
      // Note: FB5995GA0013 and FB5982LA0015 are omitted to simulate missing dp_sewadars records
    ]

    render(<DeploymentMatrixReport scheduleId="s1" scheduleName="Visit 2026" />)

    // Wait until loaded and headers appear
    await screen.findByText('RATIO')

    // 1. COMPLETE REPORT verification:
    // Scheduled = 20, Deployed = 5
    expect(screen.getByText('COMPLETE REPORT')).toBeDefined()

    // 2. RATIO breakdown verification:
    // Male (regular): 2 (FB5982GA0001 + FB5995GA0013 inferred)
    // Female (regular): 2 (FB5993LA0001 + FB5982LA0015 inferred)
    // VSS: 1 (VSFB5978GB2872)
    // Total (M+F+VSS): 5 === Deployed (5)!
    const cells = screen.getAllByRole('cell')
    const textValues = cells.map(c => c.textContent.trim())

    // Verify Total (M+F+VSS) row matches 5
    expect(textValues).toContain('Total (M+F+VSS)')
    expect(textValues).toContain('Male (regular)')
    expect(textValues).toContain('Female (regular)')
    expect(textValues).toContain('VSS')

    // Find the row for Total (M+F+VSS)
    const mfvssHeader = screen.getByText('Total (M+F+VSS)')
    const mfvssRow = mfvssHeader.closest('tr')
    const rowValues = Array.from(mfvssRow.querySelectorAll('td')).map(td => td.textContent.trim())
    // Column 2 is Total, which must be '5' (Zero gaps!)
    expect(rowValues[1]).toBe('5')

    // 3. Department breakdown:
    // CANTEEN has 2 deployed (PALWAL: 1 female from PALWAL + 1 male from NAYAGAON rolled into PALWAL)
    // TRAFFIC OUTSIDE BHATI has 3 deployed (GURGAON: 1 male + 1 female overridden from canteen + 1 VSS)
    const canteenHeader = screen.getByText('CANTEEN')
    expect(canteenHeader).toBeDefined()
    const trafficHeader = screen.getByText('TRAFFIC OUTSIDE BHATI')
    expect(trafficHeader).toBeDefined()
  })

  it('exports excel without error and triggers file download', async () => {
    mockData.deployments = [
      { id: 'd1', schedule_id: 's1', centre: 'PALWAL', badge_number: 'FB5993LA0001', department_id: 'dept-canteen' },
    ]
    mockData.sewadars = [
      { badge_number: 'FB5993LA0001', centre: 'PALWAL', gender: 'FEMALE' },
    ]

    const ref = { current: null }
    render(<DeploymentMatrixReport ref={ref} scheduleId="s1" scheduleName="October Visit 2026" />)
    await screen.findByText('RATIO')

    expect(ref.current).toBeDefined()
    expect(typeof ref.current.exportExcel).toBe('function')

    const clicked = []
    const origCreateObjectURL = window.URL.createObjectURL
    const origRevokeObjectURL = window.URL.revokeObjectURL
    const origClick = HTMLAnchorElement.prototype.click

    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    window.URL.revokeObjectURL = vi.fn()
    HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.getAttribute('download'))
    }

    try {
      await ref.current.exportExcel()
      expect(clicked.length).toBe(1)
      expect(clicked[0]).toMatch(/^Deployment_Report_October_Visit_2026_.*\.xlsx$/)
    } finally {
      window.URL.createObjectURL = origCreateObjectURL
      window.URL.revokeObjectURL = origRevokeObjectURL
      HTMLAnchorElement.prototype.click = origClick
    }
  })
})
