import { useState, useEffect, useCallback, Fragment, forwardRef, useImperativeHandle } from 'react'
import { supabase, fetchCentres, getRootCentre } from '../lib/supabase'
import { Users } from 'lucide-react'

/* ─── centre-wise deployment matrix report ───
   Rendered as a section inside the Overview tab. One block per department,
   one column per CENTRE (counts rolled up to the root CENTRE incl. SC_SPs).
   Sections: COMPLETE REPORT (Scheduled = allocated quota, Deployed =
   finalized, Difference), RATIO (Male/Female/Total + M:F), per-department
   blocks (Scheduled / Deployed / Difference / Male / Female, plus a VSS
   line for TRAFFIC OUTSIDE BHATI only). Zeros render blank. No
   open-vs-permanent distinction anywhere. */

const isMale = g => /^M/i.test(String(g || ''))

const ratioStr = (a, b) => {
  if (!a && !b) return ''
  if (!a) return `0:${b}`
  if (!b) return `${a}:0`
  const mp = Math.round((a / (a + b)) * 100)
  return `${mp}:${100 - mp}`
}

const VSS_LINE_DEPT = 'TRAFFIC OUTSIDE BHATI'

const DeploymentMatrixReport = forwardRef(function DeploymentMatrixReport({ scheduleId, scheduleName, onLoadingChange }, ref) {
  const [rows, setRows] = useState([])
  const [allocations, setAllocations] = useState([])
  const [centres, setCentres] = useState([])
  const [deptNameById, setDeptNameById] = useState({})
  const [sewadars, setSewadars] = useState([])      // gender for deployed badges
  const [vssBadges, setVssBadges] = useState(new Set())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchCentres().then(setCentres).catch(() => {})
    supabase.from('vss_sewadars').select('badge_number').then(({ data, error }) => {
      if (!error) setVssBadges(new Set((data || []).map(v => v.badge_number)))
    }).catch(() => {})
  }, [])

  const load = useCallback(async (scheduleId) => {
    const [dRes, aRes, depRes] = await Promise.all([
      supabase.from('deployments').select('*').eq('schedule_id', scheduleId).order('centre'),
      supabase.from('centre_allocations').select('*').eq('schedule_id', scheduleId),
      supabase.from('deployment_departments').select('id, name'),
    ])
    const deptNameById = {}
    ;(depRes.data || []).forEach(d => { deptNameById[d.id] = d.name })
    setDeptNameById(deptNameById)
    const rowsData = (dRes.data || []).map(r => ({
      ...r,
      final_dept_name: deptNameById[r.deployed_department_id] || '—',
    }))
    setRows(rowsData)
    setAllocations(aRes.data || [])

    // gender for deployed badges (regular sewadars only; VSS handled via vssBadges)
    const badges = [...new Set(rowsData.map(r => r.badge_number))]
    if (badges.length) {
      const { data } = await supabase
        .from('sewadars')
        .select('badge_number, gender')
        .in('badge_number', badges)
      setSewadars(data || [])
    } else {
      setSewadars([])
    }
  }, [])

  useEffect(() => {
    if (!scheduleId) return
    setLoading(true)
    let mounted = true
    load(scheduleId)
      .then(() => { if (mounted) setLoading(false) })
      .catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [scheduleId, load])

  // realtime: refresh live while centres edit. Coalesced (400ms).
  useEffect(() => {
    if (!scheduleId) return
    let mounted = true
    let reloadTimer = null
    const scheduleReload = () => {
      if (!mounted) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => { if (mounted) load(scheduleId).catch(() => {}) }, 400)
    }
    const channel = supabase
      .channel(`deploy-overview-${scheduleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `schedule_id=eq.${scheduleId}` }, scheduleReload)
      .subscribe()
    return () => { mounted = false; if (reloadTimer) clearTimeout(reloadTimer); supabase.removeChannel(channel) }
  }, [scheduleId, load])

  // ── build the report ─────────────────────────────────────────────
  const rootOf = (centre) => getRootCentre(centres, centre) || centre
  const rootSet = new Set()
  ;(centres || []).filter(c => !c.parent_centre).forEach(c => rootSet.add(c.name))
  rows.forEach(r => rootSet.add(rootOf(r.centre)))
  allocations.forEach(a => rootSet.add(rootOf(a.centre)))
  const rootCentres = [...rootSet].sort()

  const swByBadge = {}
  sewadars.forEach(s => { swByBadge[s.badge_number] = s })

  // quota: root → dept → max_count (Scheduled)
  const quota = {}
  allocations.forEach(a => {
    const root = rootOf(a.centre)
    const n = deptNameById[a.department_id]
    if (!n) return
    quota[root] = quota[root] || {}
    quota[root][n] = (quota[root][n] || 0) + (a.max_count || 0)
  })

  // deployed breakdown: root → dept → { deployed, male, female, vss, noGender }
  const dep = {}
  rows.forEach(r => {
    const root = rootOf(r.centre)
    const dept = r.final_dept_name
    if (!dept || dept === '—') return
    dep[root] = dep[root] || {}
    const d = (dep[root][dept] = dep[root][dept] || { deployed: 0, male: 0, female: 0, vss: 0, noGender: 0 })
    d.deployed++
    if (vssBadges.has(r.badge_number)) { d.vss++; return }
    const sw = swByBadge[r.badge_number]
    if (!sw?.gender) { d.noGender++; return }
    if (isMale(sw.gender)) d.male++; else d.female++
  })

  const deptSet = new Set()
  Object.keys(quota).forEach(root => Object.keys(quota[root]).forEach(n => deptSet.add(n)))
  Object.keys(dep).forEach(root => Object.keys(dep[root]).forEach(n => deptSet.add(n)))
  const departments = [...deptSet].sort()
  const isVssDept = n => n.toUpperCase() === VSS_LINE_DEPT

  const cellNum = v => (v === undefined || v === null || v === 0 ? '' : String(v))
  const diffCls = v => (v < 0 ? 'matrix-neg' : v > 0 ? 'matrix-pos' : '')
  const rowTotal = (map, dept, key) =>
    rootCentres.reduce((s, c) => s + (map[c]?.[dept]?.[key] || 0), 0)

  const schedTotal = (root, dept) => quota[root]?.[dept] || 0
  const schedGrand = dept => rootCentres.reduce((s, c) => s + schedTotal(c, dept), 0)

  // grand totals — ALL departments
  const grandScheduled = departments.reduce((s, d) => s + schedGrand(d), 0)
  const grandDeployed = departments.reduce((s, d) => s + rowTotal(dep, d, 'deployed'), 0)
  const grandM = departments.reduce((s, d) => s + rowTotal(dep, d, 'male'), 0)
  const grandF = departments.reduce((s, d) => s + rowTotal(dep, d, 'female'), 0)

  // per-centre sums across all departments
  const centreAll = {}
  rootCentres.forEach(c => {
    centreAll[c] = { scheduled: 0, deployed: 0, male: 0, female: 0 }
    departments.forEach(dept => {
      centreAll[c].scheduled += schedTotal(c, dept)
      const d = dep[c]?.[dept]
      if (!d) return
      centreAll[c].deployed += d.deployed
      centreAll[c].male += d.male
      centreAll[c].female += d.female
    })
  })

  const blockRows = dept => (isVssDept(dept) ? 6 : 5)

  // ── Excel export — formatted, mirrors the on-screen matrix ────────
  const exportExcel = async () => {
    const ExcelJS = await import('exceljs') // lazy — keeps exceljs out of the main bundle

    // theme colours — hex values straight from index.css :root / matrix rules
    const DANGER = 'FFEF4444'     // --danger
    const SUCCESS = 'FF10B981'    // --success
    const LABEL = {
      sched: 'FF4F46E5',          // --primary-dark (.matrix-sched)
      deploy: 'FF047857',         // .matrix-deploy
      male: 'FF0284C7',           // .matrix-male
      female: 'FFDB2777',         // .matrix-female
      vss: 'FF7C3AED',            // .matrix-vss
    }
    const FILL_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }   // .matrix-report-head bg
    const FILL_ODD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }    // --surface-2 (.matrix-group-odd)
    const BORDER = { style: 'thin', color: { argb: 'FFE2E8F0' } }                            // --border
    const THICK = { style: 'thick', color: { argb: 'FF64748B' } }                            // --text-sec (block box outline)

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Deployment Report')

    const nCols = 3 + rootCentres.length
    const centreW = Math.max(12, ...rootCentres.map(c => c.length + 2))

    // title row — merged across all columns, bold, centred
    ws.mergeCells(1, 1, 1, nCols)
    const title = ws.getCell(1, 1)
    title.value = `DETAILED ANALYSIS OF SEWADAR DEPLOYMENT CENTRE WISE — ${scheduleName || ''}`
    title.font = { bold: true, size: 13 }
    title.alignment = { horizontal: 'center', vertical: 'middle' }
    ws.getRow(1).height = 26

    // header row
    const headCells = ['DETAILS', 'CENTRES', 'Total', ...rootCentres]
    headCells.forEach((h, i) => {
      const cell = ws.getCell(2, i + 1)
      cell.value = h
      cell.font = { bold: true }
      cell.fill = FILL_HEAD
      cell.alignment = { horizontal: i < 3 ? 'left' : 'center', vertical: 'middle' }
      cell.border = { bottom: BORDER, left: i > 0 ? BORDER : undefined }
    })

    const cellNum = v => (v === undefined || v === null || v === 0 ? null : v)

    // write a vertically-merged block: label rows share one DETAILS cell
    let row = 2
    const blocks = []
    const writeBlock = (blockName, labelRows, fill) => {
      const start = row + 1
      labelRows.forEach(lr => {
        row++
        const labelCell = ws.getCell(row, 2)
        labelCell.value = lr.label
        labelCell.font = { bold: true, color: { argb: lr.color || 'FF0F172A' } }
        labelCell.alignment = { horizontal: 'left', vertical: 'middle' }
        const totalCell = ws.getCell(row, 3)
        totalCell.value = cellNum(lr.total)
        totalCell.font = { bold: true, color: { argb: lr.diffColor || 'FF0F172A' } }
        totalCell.alignment = { horizontal: 'center', vertical: 'middle' }
        rootCentres.forEach((c, ci) => {
          const cell = ws.getCell(row, 4 + ci)
          cell.value = cellNum(lr.centres[ci])
          if (lr.centresDiff) cell.font = { color: { argb: diffCol(lr.centres[ci]) || 'FF0F172A' } }
          cell.alignment = { horizontal: 'center', vertical: 'middle' }
        })
        if (fill) {
          for (let i = 1; i <= nCols; i++) ws.getCell(row, i).fill = fill
        }
      })
      ws.mergeCells(start, 1, row, 1)
      const nameCell = ws.getCell(start, 1)
      nameCell.value = blockName
      nameCell.font = { bold: true }
      nameCell.alignment = { horizontal: 'left', vertical: 'middle' }
      nameCell.border = { top: BORDER, bottom: BORDER, left: BORDER }
      blocks.push({ start, end: row })
    }

    // thick box outline around a block: top on the first row, bottom on the
    // last row, left on the merged DETAILS master (spans the block height),
    // right on the last data column for every row
    const applyBlockBorder = (worksheet, startRow, endRow, startCol, endCol) => {
      for (let c = startCol; c <= endCol; c++) {
        worksheet.getCell(startRow, c).border = { ...worksheet.getCell(startRow, c).border, top: THICK }
      }
      for (let c = startCol + 1; c <= endCol; c++) {
        worksheet.getCell(endRow, c).border = { ...worksheet.getCell(endRow, c).border, bottom: THICK }
      }
      const master = worksheet.getCell(startRow, startCol)
      master.border = { ...master.border, bottom: THICK, left: THICK }
      for (let r = startRow; r <= endRow; r++) {
        worksheet.getCell(r, endCol).border = { ...worksheet.getCell(r, endCol).border, right: THICK }
      }
    }

    const diffCol = v => (v < 0 ? DANGER : v > 0 ? SUCCESS : undefined)

    // COMPLETE REPORT block
    writeBlock('COMPLETE REPORT', [
      { label: 'Scheduled', color: LABEL.sched, total: grandScheduled, centres: rootCentres.map(c => centreAll[c].scheduled) },
      { label: 'Deployed', color: LABEL.deploy, total: grandDeployed, centres: rootCentres.map(c => centreAll[c].deployed) },
      { label: 'Difference', total: grandDeployed - grandScheduled, diffColor: diffCol(grandDeployed - grandScheduled), centresDiff: true, centres: rootCentres.map(c => centreAll[c].deployed - centreAll[c].scheduled) },
    ], FILL_HEAD)

    // RATIO block
    writeBlock('RATIO', [
      { label: 'Male', color: LABEL.male, total: grandM, centres: rootCentres.map(c => centreAll[c].male) },
      { label: 'Female', color: LABEL.female, total: grandF, centres: rootCentres.map(c => centreAll[c].female) },
      { label: 'Total', total: grandM + grandF, centres: rootCentres.map(c => centreAll[c].male + centreAll[c].female) },
      { label: 'Ratio (M:F)', total: ratioStr(grandM, grandF), centres: rootCentres.map(c => ratioStr(centreAll[c].male, centreAll[c].female)) },
    ], FILL_HEAD)

    // per-department blocks — same row order as the table; VSS only for TRAFFIC OUTSIDE BHATI
    departments.forEach((dept, i) => {
      const vss = isVssDept(dept)
      const rowsSpec = [
        { label: 'Scheduled', color: LABEL.sched, total: schedGrand(dept), centres: rootCentres.map(c => schedTotal(c, dept)) },
        { label: 'Deployed', color: LABEL.deploy, total: rowTotal(dep, dept, 'deployed'), centres: rootCentres.map(c => (dep[c]?.[dept]?.deployed || 0)) },
        { label: 'Difference', total: rowTotal(dep, dept, 'deployed') - schedGrand(dept), diffColor: diffCol(rowTotal(dep, dept, 'deployed') - schedGrand(dept)), centresDiff: true, centres: rootCentres.map(c => (dep[c]?.[dept]?.deployed || 0) - schedTotal(c, dept)) },
        { label: 'Male', color: LABEL.male, total: rowTotal(dep, dept, 'male'), centres: rootCentres.map(c => (dep[c]?.[dept]?.male || 0)) },
        { label: 'Female', color: LABEL.female, total: rowTotal(dep, dept, 'female'), centres: rootCentres.map(c => (dep[c]?.[dept]?.female || 0)) },
      ]
      if (vss) {
        rowsSpec.push({ label: 'VSS', color: LABEL.vss, total: rowTotal(dep, dept, 'vss'), centres: rootCentres.map(c => (dep[c]?.[dept]?.vss || 0)) })
      }
      writeBlock(dept, rowsSpec, i % 2 === 1 ? FILL_ODD : undefined)
    })

    // column widths + borders + freeze panes
    ws.columns = [
      { width: 34 }, { width: 15 }, { width: 10 },
      ...rootCentres.map(() => ({ width: centreW })),
    ]
    // thin internal grid borders (cols 2..nCols; col 1 is the merged DETAILS
    // cell whose borders come from its master)
    for (let r = 2; r <= row; r++) {
      for (let i = 2; i <= nCols; i++) {
        const cell = ws.getCell(r, i)
        cell.border = {
          top: BORDER,
          left: BORDER,
          right: i === nCols ? BORDER : undefined,
          bottom: r === row ? BORDER : undefined,
        }
      }
    }
    // thick box outline per block — runs after the thin grid so it wins
    blocks.forEach(({ start, end }) => applyBlockBorder(ws, start, end, 1, nCols))
    // freeze the header row + the first 3 columns (DETAILS/CENTRES/Total)
    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 2 }]

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const date = new Date().toISOString().slice(0, 10)
    const name = (scheduleName || 'schedule').replace(/[^a-z0-9]+/gi, '_')
    a.href = url
    a.download = `Deployment_Report_${name}_${date}.xlsx`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  useImperativeHandle(ref, () => ({ exportExcel }))

  // surface loading state up so the page can disable the export button
  useEffect(() => { onLoadingChange?.(loading) }, [loading, onLoadingChange])

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
      </div>
    )
  }

  if (departments.length === 0 || rootCentres.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <div className="empty-icon"><Users size={22} /></div>
          <div className="empty-title">No allocations yet</div>
          <div className="empty-text">Centres will appear here once departments are allocated for this schedule.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
<div className="deploy-matrix-legend">
            <span className="legend-group">
              <span className="legend-item"><i className="legend-dot legend-sched" /> Scheduled (allocated quota)</span>
              <span className="legend-item"><i className="legend-dot legend-deploy" /> Deployed (finalized)</span>
            </span>
            <span className="legend-group">
              <span className="legend-item"><i className="legend-dot legend-male" /> Male</span>
              <span className="legend-item"><i className="legend-dot legend-female" /> Female</span>
            </span>
            <span className="legend-group">
              <span className="legend-item"><i className="legend-dot legend-vss" /> VSS</span>
            </span>
            <span className="legend-group">
              <span className="legend-item"><i className="legend-dot legend-deficit" /> Deficit (deployed &lt; scheduled)</span>
              <span className="legend-item"><i className="legend-dot legend-excess" /> Excess (deployed &gt; scheduled)</span>
            </span>
          </div>
      <div className="table-wrap table-wrap-sticky" style={{ border: 'none', borderRadius: 0 }}>
        <table className="table table-sticky deploy-matrix">
          <thead>
            <tr>
              <th className="table-sticky-col">DETAILS</th>
              <th className="table-sticky-col-2">CENTRES</th>
              <th className="table-sticky-col-3">Total</th>
              {rootCentres.map(c => <th key={c} className="matrix-centre">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {/* COMPLETE REPORT */}
            <tr className="matrix-report-head matrix-block-start">
              <td rowSpan={3} className="table-sticky-col matrix-dept" data-label="DETAILS">COMPLETE REPORT</td>
              <td className="table-sticky-col-2 matrix-label matrix-sched">Scheduled</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{cellNum(grandScheduled)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(centreAll[c].scheduled)}</td>)}
            </tr>
            <tr className="matrix-report-head">
              <td className="table-sticky-col-2 matrix-label matrix-deploy">Deployed</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{cellNum(grandDeployed)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(centreAll[c].deployed)}</td>)}
            </tr>
            <tr className="matrix-report-head matrix-block-end">
              <td className="table-sticky-col-2 matrix-label">Difference</td>
              <td className={`table-sticky-col-3 matrix-num matrix-total ${diffCls(grandDeployed - grandScheduled)}`}>{cellNum(grandDeployed - grandScheduled)}</td>
              {rootCentres.map(c => {
                const v = centreAll[c].deployed - centreAll[c].scheduled
                return <td key={c} className={`matrix-num matrix-centre ${diffCls(v)}`} data-label={c}>{cellNum(v)}</td>
              })}
            </tr>

            {/* RATIO */}
            <tr className="matrix-report-head matrix-block-start">
              <td rowSpan={4} className="table-sticky-col matrix-dept" data-label="DETAILS">RATIO</td>
              <td className="table-sticky-col-2 matrix-label matrix-male">Male</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{cellNum(grandM)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(centreAll[c].male)}</td>)}
            </tr>
            <tr className="matrix-report-head">
              <td className="table-sticky-col-2 matrix-label matrix-female">Female</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{cellNum(grandF)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(centreAll[c].female)}</td>)}
            </tr>
            <tr className="matrix-report-head">
              <td className="table-sticky-col-2 matrix-label">Total</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{cellNum(grandM + grandF)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(centreAll[c].male + centreAll[c].female)}</td>)}
            </tr>
            <tr className="matrix-report-head matrix-block-end">
              <td className="table-sticky-col-2 matrix-label">Ratio (M:F)</td>
              <td className="table-sticky-col-3 matrix-num matrix-total">{ratioStr(grandM, grandF)}</td>
              {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre matrix-ratio" data-label={c}>{ratioStr(centreAll[c].male, centreAll[c].female)}</td>)}
            </tr>

            {/* per-department blocks */}
                {departments.map((dept, i) => {
                  const odd = i % 2 === 1
                  const rowsSpan = blockRows(dept)
                  const mTotal = rowTotal(dep, dept, 'male')
                  const fTotal = rowTotal(dep, dept, 'female')
                  const rowCls = odd ? 'matrix-group-odd' : 'matrix-group-even'
                  const vss = isVssDept(dept)
                  const Label = ({ cls, children }) => <td className={`table-sticky-col-2 matrix-label ${cls || ''}`}>{children}</td>
                  const TotalCell = ({ v, diff }) => <td className={`table-sticky-col-3 matrix-num matrix-total ${diff ? diffCls(v) : ''}`}>{cellNum(v)}</td>
                  return (
                    <Fragment key={dept}>
                      <tr className={`${rowCls} matrix-block-start`}>
                    <td rowSpan={rowsSpan} className="table-sticky-col matrix-dept" data-label="DETAILS">{dept}</td>
                    <Label cls="matrix-sched">Scheduled</Label>
                    <TotalCell v={schedGrand(dept)} />
                    {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(schedTotal(c, dept))}</td>)}
                  </tr>
                  <tr className={rowCls}>
                    <Label cls="matrix-deploy">Deployed</Label>
                    <TotalCell v={rowTotal(dep, dept, 'deployed')} />
                    {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(dep[c]?.[dept]?.deployed)}</td>)}
                  </tr>
                      <tr className={rowCls}>
                        <Label>Difference</Label>
                        <TotalCell v={rowTotal(dep, dept, 'deployed') - schedGrand(dept)} diff />
                        {rootCentres.map(c => {
                          const v = (dep[c]?.[dept]?.deployed || 0) - schedTotal(c, dept)
                          return <td key={c} className={`matrix-num matrix-centre ${diffCls(v)}`} data-label={c}>{cellNum(v)}</td>
                        })}
                      </tr>
                  <tr className={rowCls}>
                    <Label cls="matrix-male">Male</Label>
                    <TotalCell v={mTotal} />
                    {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(dep[c]?.[dept]?.male)}</td>)}
                  </tr>
                  <tr className={`${rowCls} ${vss ? '' : 'matrix-block-end'}`}>
                    <Label cls="matrix-female">Female</Label>
                    <TotalCell v={fTotal} />
                    {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(dep[c]?.[dept]?.female)}</td>)}
                  </tr>
                  {vss && (
                    <tr className={`${rowCls} matrix-block-end`}>
                      <Label cls="matrix-vss">VSS</Label>
                      <TotalCell v={rowTotal(dep, dept, 'vss')} />
                      {rootCentres.map(c => <td key={c} className="matrix-num matrix-centre" data-label={c}>{cellNum(dep[c]?.[dept]?.vss)}</td>)}
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
})

export default DeploymentMatrixReport