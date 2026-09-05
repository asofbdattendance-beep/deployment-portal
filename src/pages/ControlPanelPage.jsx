import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  supabase, fetchCentres, fetchAllRows, fetchPortalSettings, setPortalSetting,
  fetchCentreOverrides, setCentreOverride, removeCentreOverride,
  fetchVssOverrides, setVssOverride, getCount,
} from '../lib/supabase'
import {
  getParentCentres, getRootCentre, getSubtreeCentres,
  resolveOverride, resolveVssOverride, OVERRIDE_ALL_CENTRES,
} from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import MasterSwitch from '../components/MasterSwitch'
import DeadlinePill from '../components/DeadlinePill'
import {
  SlidersHorizontal, Globe, Star, ChevronDown, ChevronRight, Search,
  Lock, Unlock, Building2, Layers, Plus, ShieldCheck, AlertTriangle, Users,
} from 'lucide-react'

/* ─── Superadmin Control Panel (v21, phase-2 hardening) ───
   Left: centre tree (CENTREs + their SC_SPs) plus two virtual nodes —
   "All centres" (global) and "VSS". Right: permission panels that write
   `centre_overrides` (open deployment past lock/switch/deadline),
   `centre_vss_overrides` (tri-state VSS knobs) and plain
   `centre_allocations` (additional departments). DB triggers in v21 make
   every grant authoritative; ASO-finalized sewadars stay frozen no matter
   what is opened here (v15/v16). */

const DEPLOYMENT_OPEN_LABEL = 'Deployment specially opened'

// ── small building blocks ──────────────────────────────────────────────

function StatusChip({ ok, children, title }) {
  return (
    <span
      className={`pill ${ok ? 'pill-green' : 'pill-red'}`}
      title={title}
      style={{ fontSize: '0.7rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
    >
      {ok ? <Unlock size={11} /> : <Lock size={11} />}{children}
    </span>
  )
}

function TriState({ value, onChange, labels = ['Auto', 'Open', 'Closed'] }) {
  // value: null (inherit) | true | false
  const opts = [[null, labels[0]], [true, labels[1]], [false, labels[2]]]
  return (
    <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
      {opts.map(([v, label]) => {
        const active = value === v || (v === null && value == null)
        return (
          <button
            key={label}
            onClick={() => onChange(v)}
            style={{
              padding: '0.28rem 0.55rem', fontSize: '0.72rem', fontWeight: active ? 800 : 500,
              border: 'none', cursor: 'pointer',
              background: active ? (v === true ? '#dcfce7' : v === false ? '#fee2e2' : '#eef2ff') : '#fff',
              color: active ? (v === true ? '#047857' : v === false ? '#b91c1c' : '#4f46e5') : '#64748b',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function PanelCard({ icon: Icon, title, sub, children }) {
  return (
    <section className="card">
      <div className="section-header" style={{ padding: '1.1rem 1.25rem 0' }}>
        <div>
          <div className="section-title"><Icon size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> {title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </div>
      <div style={{ padding: '1rem 1.25rem 1.25rem' }}>{children}</div>
    </section>
  )
}

export default function ControlPanelPage({ schedules, scheduleId }) {
  const toast = useToast()
  const { profile } = usePortalAuth()
  const selectedScheduleId = scheduleId
  const schedule = schedules.find(s => s.id === selectedScheduleId)

  const [centres, setCentres] = useState([])
  const [depts, setDepts] = useState([])
  const [allocations, setAllocations] = useState([])
  const [deployRows, setDeployRows] = useState([])
  const [overrides, setOverrides] = useState([])
  const [vssOverrides, setVssOverrides] = useState([])
  const [locks, setLocks] = useState([])
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)

  const [selected, setSelected] = useState('all') // 'all' | 'vss' | CENTRE name
  const [expanded, setExpanded] = useState({})
  const [treeSearch, setTreeSearch] = useState('')
  const [busy, setBusy] = useState(false)

  // additional-department form state, per panel
  const [globalExtraDept, setGlobalExtraDept] = useState({ dept: '', max: 5, alsoOpen: false })
  const [centreExtraDept, setCentreExtraDept] = useState({ dept: '', max: 5, alsoOpen: false })

  const roots = useMemo(() => getParentCentres(centres), [centres])
  const childrenOf = useCallback(name => getSubtreeCentres(centres, name).filter(c => c !== name), [centres])

  // ── data loading ─────────────────────────────────────────────────────
  const loadStatic = useCallback(async () => {
    const [c, d] = await Promise.all([
      fetchCentres(),
      fetchAllRows('deployment_departments', 'id, name, is_active', (q) => q.eq('is_active', true).order('name')),
    ])
    setCentres(c)
    setDepts(d || [])
  }, [])

  // DB-side pure counts (head:true) — do NOT download rows just to count
  // Used for header badges where per-row detail is already fetched for the
  // quota table; demonstrates DB-side counting for future count-only views.
  const [DBCounts, setDbCounts] = useState({ allocations: null, deployments: null })
  const loadScheduleData = useCallback(async (sid) => {
    if (!sid) {
      setAllocations([]); setDeployRows([]); setOverrides([]); setLocks([]); setVssOverrides([])
      setDbCounts({ allocations: 0, deployments: 0 })
      return
    }
    const [allocAll, deployAll, ovRes, lockAll, vssOvRes, allocCount, deployCount] = await Promise.all([
      fetchAllRows('centre_allocations', 'id, department_id, centre, max_count', (q) => q.eq('schedule_id', sid)),
      fetchAllRows('deployments', 'centre, badge_number, department_id, deployed_department_id', (q) => q.eq('schedule_id', sid)),
      fetchCentreOverrides(sid),
      fetchAllRows('centre_locks', '*', (q) => q.eq('schedule_id', sid)),
      fetchVssOverrides(),
      // Pure counts via head:true — no rows downloaded, useful for header stats
      // where the per-row detail is already fetched above for the quota table,
      // but demonstrates DB-side counting for future count-only views.
      getCount('centre_allocations', (q) => q.eq('schedule_id', sid)).catch(() => null),
      getCount('deployments', (q) => q.eq('schedule_id', sid)).catch(() => null),
    ])
    setAllocations(allocAll || [])
    setDeployRows(deployAll || [])
    setOverrides(ovRes)
    setLocks(lockAll || [])
    setVssOverrides(vssOvRes)
    if (allocCount != null || deployCount != null) setDbCounts({ allocations: allocCount, deployments: deployCount })
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadStatic(), loadScheduleData(selectedScheduleId), fetchPortalSettings().then(setSettings)])
      .catch(err => toast.error(err?.message || 'Failed to load control-panel data'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScheduleId, loadStatic, loadScheduleData])

  // realtime: overrides / switches / locks change live
  useEffect(() => {
    // schedule-scoped subscriptions only get a filter key when a schedule is
    // selected — an explicit `filter: undefined` has bitten client builds
    const schedFilter = selectedScheduleId ? { filter: `schedule_id=eq.${selectedScheduleId}` } : {}
    const channel = supabase
      .channel(`control-panel-${selectedScheduleId || 'none'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_settings' }, () => {
        fetchPortalSettings().then(setSettings).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_vss_overrides' }, () => {
        fetchVssOverrides().then(setVssOverrides).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_locks', ...schedFilter }, () => {
        if (!selectedScheduleId) return
        fetchAllRows('centre_locks', '*', (q) => q.eq('schedule_id', selectedScheduleId)).then((data) => setLocks(data || [])).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'centre_overrides', ...schedFilter }, () => {
        if (!selectedScheduleId) return
        fetchCentreOverrides(selectedScheduleId).then(setOverrides).catch(() => {})
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedScheduleId])

  // Header totals prefer DB-side counts (head:true) when available; fallback to
  // JS counts from rows already fetched for the quota table (no extra download).
  const totalAllocHeader = DBCounts.allocations ?? allocations.length
  const totalDeployHeader = DBCounts.deployments ?? deployRows.length
  void totalAllocHeader; void totalDeployHeader // used in panel subtitles below

  // ── derived quota/usage per ROOT centre × department ────────────────
  const quotaByRoot = useMemo(() => {
    const alloc = {}
    ;(allocations || []).forEach(a => {
      const root = getRootCentre(centres, a.centre) || a.centre
      alloc[root] = alloc[root] || {}
      alloc[root][a.department_id] = (alloc[root][a.department_id] || 0) + (a.max_count || 0)
    })
    const used = {}
    ;(deployRows || []).forEach(d => {
      const eff = d.deployed_department_id || d.department_id
      if (!eff) return
      const root = getRootCentre(centres, d.centre) || d.centre
      used[root] = used[root] || {}
      used[root][eff] = (used[root][eff] || 0) + 1
    })
    return { alloc, used }
  }, [allocations, deployRows, centres])

  const deadlinePassed = !!(schedule?.deadline && new Date(schedule.deadline) <= new Date())

  // ── actions ──────────────────────────────────────────────────────────
  const audit = useCallback(async (action, payload) => {
    try {
      const { error } = await supabase.from('audit_log').insert({
        action,
        table_name: 'control_panel',
        schedule_id: selectedScheduleId || null,
        payload,
        acted_by: profile?.name || null,
      })
      if (error) console.warn('audit_log write failed:', error.message)
    } catch (e) {
      console.warn('audit_log write failed:', e?.message)
    }
  }, [selectedScheduleId, profile?.name])

  const toggleSetting = (key, label) => async () => {
    setBusy(true)
    const next = !(key === 'sewadar_deployment_open' ? settings.sewadar_deployment_open !== false : settings[key] === true)
    try {
      await setPortalSetting(key, next, profile?.name || null)
      setSettings(s => ({ ...s, [key]: next }))
      toast.success(`${label} is now ${next ? 'OPEN' : 'CLOSED'}`)
    } catch (err) {
      toast.error(err.message || 'Could not update setting')
    } finally { setBusy(false) }
  }

  const hasOverrideRow = (centre, departmentId) =>
    overrides.some(o => o.centre === centre && (o.department_id || null) === (departmentId || null))
  const hasUndeployedRow = (centre) =>
    overrides.some(o => o.centre === centre && (o.department_id || null) === null && o.undeployed_only)

  const setOpenOverride = async (centre, departmentId, open, label) => {
    setBusy(true)
    try {
      if (open) {
        await setCentreOverride({ scheduleId: selectedScheduleId, centre, departmentId, createdBy: profile?.name || null })
      } else {
        // Close only this exact scope so a coexisting undeployed-only override
        // (a different row) is not accidentally removed.
        await removeCentreOverride({ scheduleId: selectedScheduleId, centre, departmentId, undeployedOnly: false })
      }
      const fresh = await fetchCentreOverrides(selectedScheduleId)
      setOverrides(fresh)
      audit(open ? 'override_open' : 'override_close', { centre, department_id: departmentId })
      toast.success(open ? `${DEPLOYMENT_OPEN_LABEL} — ${label}` : `Override closed — ${label}`)
    } catch (err) {
      toast.error(err.message || 'Could not update the override')
    } finally { setBusy(false) }
  }

  // UNDEPLOYED-ONLY override: opens deployment for the undeployed cohort
  // (consent=No OR yes-not-deployed) to any department within quota; already-
  // deployed sewadars stay frozen (enforced at the DB too).
  const setUndeployedOverride = async (centre, open, label) => {
    setBusy(true)
    try {
      if (open) {
        await setCentreOverride({ scheduleId: selectedScheduleId, centre, departmentId: null, undeployedOnly: true, createdBy: profile?.name || null })
      } else {
        await removeCentreOverride({ scheduleId: selectedScheduleId, centre, departmentId: null, undeployedOnly: true })
      }
      const fresh = await fetchCentreOverrides(selectedScheduleId)
      setOverrides(fresh)
      audit(open ? 'override_open' : 'override_close', { centre, undeployed_only: true })
      toast.success(open ? `Opened for undeployed sewadars — ${label}` : `Undeployed override closed — ${label}`)
    } catch (err) {
      toast.error(err.message || 'Could not update the override')
    } finally { setBusy(false) }
  }

  const confirmOpen = (centre, departmentId, label, extraScopeNote) => {
    const lines = [
      `Open deployment editing for ${label}?`,
      '',
      '• The centre can edit consent & deployment even though the switch is off / deadline passed / centre locked.',
      '• Sewadars the ASO already FINALIZED stay frozen (cannot be changed).',
      '• Quota and department rules still apply.',
    ]
    if (extraScopeNote) lines.push('', extraScopeNote)
    return window.confirm(lines.join('\n'))
  }

  const unlockCentre = async (lock) => {
    if (!window.confirm(`Reopen ${lock.centre}'s deployment? The centre will be able to edit consent, deployment and incharges again.`)) return
    const { error } = await supabase.from('centre_locks').delete().eq('id', lock.id)
    if (error) { toast.error(error.message); return }
    setLocks(prev => prev.filter(l => l.id !== lock.id))
    audit('unlock_centre', { centre: lock.centre })
    toast.success('Deployment reopened — the centre can edit again')
  }

  const allocateAdditional = async ({ scopeCentre, deptId, maxCount, alsoOpen, allRootNames }) => {
    if (!deptId) { toast.error('Pick a department first'); return }
    const n = parseInt(maxCount, 10)
    if (!Number.isInteger(n) || n <= 0) { toast.error('Enter a valid seat count'); return }
    const targets = allRootNames || [scopeCentre]
    const deptName = depts.find(d => d.id === deptId)?.name || 'department'
    if (!window.confirm(
      `Allocate ${n} seat(s) of "${deptName}" to ${allRootNames ? `ALL ${targets.length} CENTREs` : targets[0]}?\n\nExisting allocations of this department are overwritten where they already exist.` +
      (alsoOpen ? '\n\nDeployment will ALSO be opened immediately for this department.' : '')
    )) return
    setBusy(true)
    try {
      const rows = targets.map(centre => ({ schedule_id: selectedScheduleId, department_id: deptId, centre, max_count: n }))
      const { error } = await supabase
        .from('centre_allocations')
        .upsert(rows, { onConflict: 'schedule_id,department_id,centre' })
      if (error) throw error
      if (alsoOpen) {
        await setCentreOverride({
          scheduleId: selectedScheduleId,
          centre: allRootNames ? OVERRIDE_ALL_CENTRES : scopeCentre,
          departmentId: deptId,
          createdBy: profile?.name || null,
        })
        setOverrides(await fetchCentreOverrides(selectedScheduleId))
      }
      const freshAlloc = await fetchAllRows('centre_allocations', 'id, department_id, centre, max_count', (q) => q.eq('schedule_id', selectedScheduleId))
      setAllocations(freshAlloc || [])
      audit('allocate_additional', { department_id: deptId, max_count: n, centres: allRootNames ? '*' : scopeCentre, also_open: !!alsoOpen })
      toast.success(`Allocated ${n} × ${deptName}${alsoOpen ? ' and opened it' : ''}`)
    } catch (err) {
      toast.error(err.message || 'Allocation failed')
    } finally { setBusy(false) }
  }

  const setVssKnob = async (centre, key, value) => {
    // send ONLY the knobs — spreading the stored row would re-send id/timestamps
    const current = vssOverrides.find(o => o.centre === centre) || {}
    setBusy(true)
    try {
      await setVssOverride(centre, {
        creation_open: current.creation_open ?? null,
        deployment_open: current.deployment_open ?? null,
        [key]: value,
      }, profile?.name || null)
      setVssOverrides(await fetchVssOverrides())
      audit('vss_override', { centre, [key]: value })
      toast.success(`VSS ${key.replace('_open', '').replace('_', ' ')} ${value === null ? 'reset to inherit' : value ? 'forced OPEN' : 'forced CLOSED'} — ${centre === OVERRIDE_ALL_CENTRES ? 'all centres' : centre}`)
    } catch (err) {
      toast.error(err.message || 'Could not update VSS override')
    } finally { setBusy(false) }
  }

  // ── tree helpers ─────────────────────────────────────────────────────
  const visibleRoots = roots.filter(r => r.name.toLowerCase().includes(treeSearch.toLowerCase()))
  const toggleExpand = name => setExpanded(e => ({ ...e, [name]: !e[name] }))

  // locks are stored against the ROOT centre — an SC_SP selection must
  // resolve to it or the locked strip / status chip silently disappear
  const selectedRoot = selected !== 'all' && selected !== 'vss'
    ? (getRootCentre(centres, selected) || selected)
    : null
  const selectedLocks = locks.filter(l => selected === 'all' || l.centre === selectedRoot)
  const selectedIsLocked = !!selectedRoot && locks.some(l => l.centre === selectedRoot)

  const centreWideOpen = (centreName) =>
    resolveOverride(overrides, { rootCentre: getRootCentre(centres, centreName), departmentId: null })

  // ═════════════════════════ RENDER ════════════════════════════════════
  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <h2 className="page-title"><SlidersHorizontal size={22} /> Control Panel</h2>
          <div className="page-sub">Per-centre permissions · overrides beat the switch, the deadline and centre locks — never quotas, rules, finalized sewadars or a done schedule</div>
        </div>
        {schedule && <DeadlinePill deadline={schedule.deadline} small />}
      </div>

      {!selectedScheduleId ? (
        <div className="card"><div className="empty"><div className="empty-icon"><AlertTriangle size={22} /></div><div className="empty-title">No schedule selected</div><div className="empty-text">Create a schedule first.</div></div></div>
      ) : loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 10 }} />)}
        </div>
      ) : (
        <div className="control-layout">
          {/* ── left: centre tree ── */}
          <aside className="card control-tree">
            <div style={{ padding: '0.9rem 0.9rem 0.4rem' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                <input
                  value={treeSearch}
                  onChange={e => setTreeSearch(e.target.value)}
                  placeholder="Search centres…"
                  className="select"
                  style={{ width: '100%', paddingLeft: 30, fontSize: '0.85rem' }}
                />
              </div>
            </div>
            <div style={{ padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button className={`control-tree-item ${selected === 'all' ? 'control-tree-active' : ''}`} onClick={() => setSelected('all')}>
                <Globe size={15} /> <span>All Centres</span>
                {hasOverrideRow(OVERRIDE_ALL_CENTRES, null) && <span className="pill pill-green" style={{ marginLeft: 'auto', fontSize: '0.58rem' }}>OPEN</span>}
              </button>
              <button className={`control-tree-item ${selected === 'vss' ? 'control-tree-active' : ''}`} onClick={() => setSelected('vss')}>
                <Star size={15} /> <span>VSS</span>
                <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: '#94a3b8' }}>special</span>
              </button>
              <div style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8', padding: '0.6rem 0.5rem 0.25rem' }}>CENTREs</div>
              {visibleRoots.map(r => {
                const kids = childrenOf(r.name)
                const open = expanded[r.name]
                const isOpen = hasOverrideRow(r.name, null)
                return (
                  <div key={r.name}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <button className={`control-tree-item ${selected === r.name ? 'control-tree-active' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => setSelected(r.name)}>
                        {kids.length > 0 ? (
                          <span role="button" tabIndex={0} onClick={e => { e.stopPropagation(); toggleExpand(r.name) }} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); toggleExpand(r.name) } }} style={{ display: 'inline-flex', padding: 2 }}>
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        ) : <span style={{ width: 18 }} />}
                        <Building2 size={14} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                        {kids.length > 0 && <span style={{ fontSize: '0.62rem', color: '#94a3b8' }}>+{kids.length}</span>}
                        {isOpen && <span className="pill pill-green" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.58rem' }}>OPEN</span>}
                      </button>
                    </div>
                    {open && kids.map(k => (
                      <button key={k} className={`control-tree-item control-tree-child ${selected === k ? 'control-tree-active' : ''}`} onClick={() => setSelected(k)}>
                        ↳ <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </aside>

          {/* ── right: panels ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', minWidth: 0 }}>
            {selectedLocks.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e' }}>
                <span style={{ fontWeight: 700 }}><Lock size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />Locked:</span>
                {selectedLocks.map(l => (
                  <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: '#fff', border: '1px solid #fde68a', borderRadius: 999, padding: '0.2rem 0.5rem 0.2rem 0.7rem' }}>
                    <strong>{l.centre}</strong>
                    {l.locked_by && <span style={{ color: '#b45309', fontSize: '0.72rem' }}>{l.locked_by}</span>}
                    <button onClick={() => unlockCentre(l)} className="btn btn-ghost" style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem', color: '#b91c1c' }}>Unlock</button>
                  </span>
                ))}
              </div>
            )}

            {selected === 'all' && (
              <>
                <PanelCard icon={Globe} title="Global switches" sub="Master controls — these apply everywhere unless a centre below carries its own override">
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <MasterSwitch label="Sewadar Deployment" open={settings.sewadar_deployment_open !== false} onToggle={toggleSetting('sewadar_deployment_open', 'Sewadar deployment')} busy={busy} />
                    <MasterSwitch label="VSS Deployment" open={settings.vss_deployment_open === true} onToggle={toggleSetting('vss_deployment_open', 'VSS deployment')} busy={busy} />
                    <MasterSwitch label="Add VSS" open={settings.vss_creation_open === true} onToggle={toggleSetting('vss_creation_open', 'Add VSS')} busy={busy} />
                  </div>
                </PanelCard>

                <PanelCard icon={ShieldCheck} title="Open deployment — EVERY centre" sub="A single wildcard override that reopens consent + deployment for all centres at once">
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={`pill ${hasOverrideRow(OVERRIDE_ALL_CENTRES, null) ? 'pill-green' : 'pill-gray'}`} style={{ fontSize: '0.75rem', fontWeight: 700 }}>
                      {hasOverrideRow(OVERRIDE_ALL_CENTRES, null) ? `${DEPLOYMENT_OPEN_LABEL.toUpperCase()} — ALL CENTRES` : 'No global override'}
                    </span>
                    {!hasOverrideRow(OVERRIDE_ALL_CENTRES, null) ? (
                      <button
                        className="btn btn-primary"
                        disabled={busy || schedule?.status !== 'open'}
                        onClick={() => { if (confirmOpen(OVERRIDE_ALL_CENTRES, null, 'ALL CENTRES')) setOpenOverride(OVERRIDE_ALL_CENTRES, null, true, 'all centres') }}
                      >
                        <Unlock size={13} /> Open for all centres
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => setOpenOverride(OVERRIDE_ALL_CENTRES, null, false, 'all centres')}
                      >
                        <Lock size={13} /> Close global override
                      </button>
                    )}
                    {!hasUndeployedRow(OVERRIDE_ALL_CENTRES) ? (
                      <button
                        className="btn"
                        disabled={busy || schedule?.status !== 'open'}
                        onClick={() => {
                          if (window.confirm(
                            'Open deployment for UNDEPLOYED sewadars across ALL centres?\n\n' +
                            '• Consent=No OR consent=Yes-but-not-deployed sewadars can be deployed to any department within quota.\n' +
                            '• Sewadars who are ALREADY deployed stay locked.\n' +
                            '• Quota and department rules still apply.'
                          )) setUndeployedOverride(OVERRIDE_ALL_CENTRES, true, 'all centres')
                        }}
                      >
                        <Users size={13} /> Open for undeployed (all centres)
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => setUndeployedOverride(OVERRIDE_ALL_CENTRES, false, 'all centres')}
                      >
                        <Lock size={13} /> Close undeployed (all centres)
                      </button>
                    )}
                  </div>
                </PanelCard>

                <PanelCard icon={Layers} title="Additional department — every CENTRE" sub="Allocate seats of any department to all CENTREs in one shot (quota appears instantly in centre dropdowns)">
                  <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', fontWeight: 600 }}>
                      Department
                      <select className="select" style={{ minWidth: 200 }} value={globalExtraDept.dept} onChange={e => setGlobalExtraDept(s => ({ ...s, dept: e.target.value }))}>
                        <option value="">Select…</option>
                        {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', fontWeight: 600 }}>
                      Seats per CENTRE
                      <input type="number" min="1" className="select" style={{ width: 100 }} value={globalExtraDept.max} onChange={e => setGlobalExtraDept(s => ({ ...s, max: e.target.value }))} />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600, paddingBottom: '0.45rem' }}>
                      <input type="checkbox" checked={globalExtraDept.alsoOpen} onChange={e => setGlobalExtraDept(s => ({ ...s, alsoOpen: e.target.checked }))} style={{ accentColor: '#6366f1' }} />
                      Also open it right away
                    </label>
                    <button className="btn btn-primary" disabled={busy} onClick={() => allocateAdditional({
                      deptId: globalExtraDept.dept, maxCount: globalExtraDept.max, alsoOpen: globalExtraDept.alsoOpen,
                      allRootNames: roots.map(r => r.name),
                    })}>
                      <Plus size={13} /> Allocate to all
                    </button>
                  </div>
                </PanelCard>
              </>
            )}

            {(selected !== 'all' && selected !== 'vss') && (() => {
              const rootName = getRootCentre(centres, selected) || selected
              const isRoot = rootName === selected
              const alloc = quotaByRoot.alloc[rootName] || {}
              const used = quotaByRoot.used[rootName] || {}
              const allocatedDeptIds = Object.keys(alloc)
              const unallocated = depts.filter(d => d.is_active && !allocatedDeptIds.includes(d.id))
              const centreOpen = centreWideOpen(rootName)
              // is the open coming from this CENTRE's own row, or inherited
              // from the All-Centres wildcard? Closing only works on own rows.
              const hasOwnCentreRow = hasOverrideRow(rootName, null)
              return (
                <>
                  <PanelCard
                    icon={Building2}
                    title={`${selected}${isRoot ? '' : ` (SC_SP of ${rootName})`}`}
                    sub={`Permissions apply to the whole ${rootName} subtree${isRoot ? '' : ' — manage them at CENTRE level'}. Overrides beat lock · switch · deadline — not quotas, rules, finalized sewadars or a done schedule.`}
                  >
                    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.9rem' }}>
                      <StatusChip ok={!selectedIsLocked} title={selectedIsLocked ? 'This CENTRE has locked its deployment' : 'Not locked'}>
                        {selectedIsLocked ? 'LOCKED' : 'NOT LOCKED'}
                      </StatusChip>
                      <StatusChip ok={settings.sewadar_deployment_open !== false} title="Sewadar Deployment master switch">
                        SWITCH {settings.sewadar_deployment_open !== false ? 'OPEN' : 'CLOSED'}
                      </StatusChip>
                      {deadlinePassed && <span className="pill pill-red" style={{ fontSize: '0.7rem', fontWeight: 700 }}>DEADLINE PASSED</span>}
                      {schedule?.status !== 'open' && <span className="pill pill-red" style={{ fontSize: '0.7rem', fontWeight: 700 }}>SCHEDULE {String(schedule?.status || '').toUpperCase()} — reopen it first</span>}
                      {centreOpen && <span className="pill pill-green" style={{ fontSize: '0.7rem', fontWeight: 800 }}>{DEPLOYMENT_OPEN_LABEL.toUpperCase()}</span>}
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      {!centreOpen ? (
                        <button
                          className="btn btn-primary"
                          disabled={busy || schedule?.status !== 'open'}
                          onClick={() => { if (confirmOpen(rootName, null, rootName)) setOpenOverride(rootName, null, true, rootName) }}
                          title="Reopens consent + deployment editing for this CENTRE and its SC_SPs"
                        >
                          <Unlock size={13} /> Open deployment for this CENTRE
                        </button>
                      ) : hasOwnCentreRow ? (
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => setOpenOverride(rootName, null, false, rootName)}
                        >
                          <Lock size={13} /> Close this override
                        </button>
                      ) : (
                        <span className="pill pill-green" style={{ fontSize: '0.75rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <Globe size={12} /> Inherited from the All-Centres override — close it there
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      {!hasUndeployedRow(rootName) ? (
                        <button
                          className="btn"
                          disabled={busy || schedule?.status !== 'open'}
                          onClick={() => {
                            if (window.confirm(
                              `Open deployment for UNDEPLOYED sewadars ONLY for ${rootName}?\n\n` +
                              '• Consent=No OR consent=Yes-but-not-deployed sewadars can be deployed to any department within quota.\n' +
                              '• Sewadars who are ALREADY deployed stay locked.\n' +
                              '• Quota and department rules still apply.'
                            )) setUndeployedOverride(rootName, true, rootName)
                          }}
                          title="Opens deployment for the UNDEPLOYED cohort (consent No or yes-not-deployed) only"
                        >
                          <Users size={13} /> Open for undeployed sewadars only
                        </button>
                      ) : (
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => setUndeployedOverride(rootName, false, rootName)}
                        >
                          <Lock size={13} /> Close undeployed override
                        </button>
                      )}
                      {hasUndeployedRow(rootName) && (
                        <span className="pill pill-amber" style={{ fontSize: '0.7rem', fontWeight: 800 }}>
                          UNDEPLOYED-ONLY OPEN
                        </span>
                      )}
                    </div>
                  </PanelCard>

                  <PanelCard
                    icon={Layers}
                    title="Departments"
                    sub="Per-department overrides work even when the whole centre stays closed — useful for topping up one department"
                  >
                    {isRoot && (
                      <div style={{ marginBottom: '1rem', paddingBottom: '0.9rem', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', fontWeight: 600 }}>
                          Additional department
                          {unallocated.length > 0 ? (
                            <select className="select" style={{ minWidth: 190 }} value={centreExtraDept.dept} onChange={e => setCentreExtraDept(s => ({ ...s, dept: e.target.value }))}>
                              <option value="">Select…</option>
                              {unallocated.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                          ) : (
                            <span style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 500, padding: '0.3rem 0' }}>
                              {depts.length === 0
                                ? 'No active departments found'
                                : 'Every active department is already allotted to this CENTRE'}
                            </span>
                          )}
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', fontWeight: 600 }}>
                          Seats
                          <input type="number" min="1" className="select" style={{ width: 90 }} value={centreExtraDept.max} onChange={e => setCentreExtraDept(s => ({ ...s, max: e.target.value }))} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600, paddingBottom: '0.45rem' }}>
                          <input type="checkbox" checked={centreExtraDept.alsoOpen} onChange={e => setCentreExtraDept(s => ({ ...s, alsoOpen: e.target.checked }))} style={{ accentColor: '#6366f1' }} />
                          Also open it
                        </label>
                        <button
                          className="btn btn-primary"
                          disabled={busy || unallocated.length === 0 || !centreExtraDept.dept}
                          onClick={() => allocateAdditional({
                            scopeCentre: rootName, deptId: centreExtraDept.dept, maxCount: centreExtraDept.max, alsoOpen: centreExtraDept.alsoOpen,
                          })}
                        >
                          <Plus size={13} /> Allocate{centreExtraDept.alsoOpen ? ' + open' : ''}
                        </button>
                      </div>
                    )}

                    {allocatedDeptIds.length === 0 ? (
                      <div style={{ color: '#64748b', fontSize: '0.85rem' }}>No departments allocated to this CENTRE yet.</div>
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Department</th>
                              <th style={{ textAlign: 'center' }}>Quota (incl. SC_SPs)</th>
                              <th style={{ textAlign: 'center' }}>Deployed</th>
                              <th style={{ textAlign: 'center' }}>State</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allocatedDeptIds.sort((a, b) => (depts.find(d => d.id === a)?.name || '').localeCompare(depts.find(d => d.id === b)?.name || '')).map(id => {
                              const deptName = depts.find(d => d.id === id)?.name || '—'
                              const max = alloc[id] || 0
                              const usedCount = used[id] || 0
                              const own = hasOverrideRow(rootName, id)
                              const effective = resolveOverride(overrides, { rootCentre: rootName, departmentId: id })
                              // where does an inherited open come from? the
                              // label must say, or "Close" looks missing
                              const viaWildcard = overrides.some(o => o.centre === OVERRIDE_ALL_CENTRES && (o.department_id == null || o.department_id === id))
                              const viaCentre = !own && overrides.some(o => o.centre === rootName && (o.department_id == null || o.department_id === id))
                              return (
                                <tr key={id}>
                                  <td style={{ fontWeight: 600 }}>{deptName}</td>
                                  <td style={{ textAlign: 'center' }}>{max}</td>
                                  <td style={{ textAlign: 'center', color: usedCount > max ? '#b91c1c' : undefined, fontWeight: 700 }}>
                                    {usedCount}{usedCount > max ? ' ⚠' : ''}
                                  </td>
                                  <td style={{ textAlign: 'center' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                                      <span className={`pill ${(effective || centreOpen) ? 'pill-green' : 'pill-gray'}`} style={{ fontSize: '0.66rem', fontWeight: 700 }}>
                                        {(effective || centreOpen) ? 'OPEN' : 'CLOSED'}
                                      </span>
                                      {!effective || own ? (
                                        <button
                                          className={`btn ${own ? '' : 'btn-primary'}`}
                                          disabled={busy}
                                          style={{ padding: '0.25rem 0.55rem', fontSize: '0.72rem' }}
                                          onClick={() => {
                                            if (own) { setOpenOverride(rootName, id, false, `${deptName} @ ${rootName}`); return }
                                            if (confirmOpen(rootName, id, `${deptName} @ ${rootName}`, 'This opens ONLY this department — consent rows stay closed unless the whole centre is opened.')) setOpenOverride(rootName, id, true, `${deptName} @ ${rootName}`)
                                          }}
                                        >
                                          {own ? <><Lock size={11} /> Close</> : <><Unlock size={11} /> Open</>}
                                        </button>
                                      ) : (
                                        <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                                          {viaWildcard ? 'inherited from All-Centres' : viaCentre ? 'opened via centre' : 'opened'}
                                        </span>
                                      )}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </PanelCard>
                </>
              )})()}

            {selected === 'vss' && (() => {
              const vssRoots = [{ name: OVERRIDE_ALL_CENTRES, label: '🌐 All centres' }, ...roots.map(r => ({ name: r.name, label: r.name }))]
              return (
                <PanelCard
                  icon={Star}
                  title="VSS special controls"
                  sub="Tri-state knobs per centre: Auto = follow the global switches & deadline window · Open/Closed = force for that centre (centre wins over All-centres)"
                >
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                    <MasterSwitch label="VSS Deployment" open={settings.vss_deployment_open === true} onToggle={toggleSetting('vss_deployment_open', 'VSS deployment')} busy={busy} />
                    <MasterSwitch label="Add VSS" open={settings.vss_creation_open === true} onToggle={toggleSetting('vss_creation_open', 'Add VSS')} busy={busy} />
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Centre</th>
                          <th>VSS creation (Add-VSS gate)</th>
                          <th>VSS deployment marking</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vssRoots.map(({ name, label }) => {
                          const creation = resolveVssOverride(vssOverrides, { rootCentre: name, key: 'creation_open' })
                          const deployment = resolveVssOverride(vssOverrides, { rootCentre: name, key: 'deployment_open' })
                          return (
                            <tr key={name}>
                              <td style={{ fontWeight: name === OVERRIDE_ALL_CENTRES ? 800 : 600 }}>{label}{name !== OVERRIDE_ALL_CENTRES && ` (+${childrenOf(name).length})`}</td>
                              <td><TriState value={creation} onChange={v => setVssKnob(name, 'creation_open', v)} /></td>
                              <td><TriState value={deployment} onChange={v => setVssKnob(name, 'deployment_open', v)} /></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#64748b' }}>
                    Creation “Auto” = Add-VSS switch {settings.vss_creation_open ? 'OPEN' : 'closed'} ∧ deadline window. Deployment “Auto” = VSS Deployment switch ({settings.vss_deployment_open ? 'OPEN' : 'closed'}).
                    {' '}The DB trigger <code>trg_a_guard_vss_registration</code> and the consent/deploy gates are authoritative.
                  </div>
                </PanelCard>
              )
            })(            )}
          </div>
        </div>
      )}
    </div>
  )
}
