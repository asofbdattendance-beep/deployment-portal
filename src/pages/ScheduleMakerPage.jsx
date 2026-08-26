import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchCentres, getParentCentres } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import { Plus, Trash2, Edit3, Calendar, Lock, Unlock, ChevronRight, X } from 'lucide-react'

const SCHEDULE_STATUS_LABELS = {
  open: 'Open',
  done: 'Done',
}

// datetime-local inputs emit PARTIAL values while typing ("2026-08",
// "2026-08-20T1:") and some browsers append seconds ("T10:30:00") — only
// complete values are ever sent to the DB.
const COMPLETE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

const pad2 = n => String(n).padStart(2, '0')
const toLocalInput = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/* A datetime-local field that keeps its own draft while typing. The naive
   version derived value straight from the saved deadline and ignored
   incomplete changes — every re-render (toast, refresh) snapped the field
   back mid-edit, making deadlines nearly uneditable by keyboard. */
function DeadlineDraftInput({ iso, onCommit, style, title }) {
  const [draft, setDraft] = useState(() => toLocalInput(iso))
  // resync when the saved value actually changes (commit / clear / reload)
  const savedRef = useRef(iso)
  useEffect(() => {
    if (iso !== savedRef.current) {
      savedRef.current = iso
      setDraft(toLocalInput(iso))
    }
  }, [iso])
  return (
    <input
      type="datetime-local"
      value={draft}
      onChange={e => { setDraft(e.target.value); onCommit(e.target.value) }}
      style={style}
      title={title}
    />
  )
}

/* Temporary "30 → 40" chip shown under a count input while its draft differs
   from the persisted value. Disappears the moment the numbers match again or
   a save refreshes the baseline — purely an edit-time affordance. */
function CountChangeChip({ saved, draft }) {
  const n = parseInt(draft, 10)
  if (!Number.isInteger(n) || n === saved) return null
  return (
    <span className="pill pill-amber" style={{ fontSize: '0.56rem', padding: '0.05rem 0.35rem', whiteSpace: 'nowrap' }} title={`Currently saved: ${saved}`}>
      {saved} → {n}
    </span>
  )
}

export default function ScheduleMakerPage({ refreshSchedules }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const isSuper = profile?.role === 'super_admin'

  const [schedules, setSchedules] = useState([])
  const [selectedScheduleId, setSelectedScheduleId] = useState('')

  const loadSchedules = useCallback(async () => {
    const { data, error } = await supabase.from('deployment_schedules').select('*').order('created_at', { ascending: false })
    if (error) { toast.error(error.message); return }
    setSchedules(data || [])
    setSelectedScheduleId(prev => (prev && (data || []).some(s => s.id === prev)) ? prev : (data?.[0]?.id || ''))
  }, [toast])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  const selectedSchedule = schedules.find(s => s.id === selectedScheduleId)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title"><Calendar size={22} /> Schedule Maker</h2>
          <div className="page-sub">Create schedules, departments, rules, and centre allocations · WED – SUN</div>
        </div>
      </div>

      <SchedulesPanel
        schedules={schedules}
        selectedScheduleId={selectedScheduleId}
        setSelectedScheduleId={setSelectedScheduleId}
        loadSchedules={loadSchedules}
        refreshSchedules={refreshSchedules}
        isSuper={isSuper}
        toast={toast}
      />

      {selectedSchedule && (
        <>
          <DepartmentsPanel isSuper={isSuper} toast={toast} />
          {/* key remounts the panel per schedule — stale form/expanded-editor
              counts from schedule A must never be saved under schedule B */}
          <AllocationsPanel key={selectedSchedule?.id || 'none'} schedule={selectedSchedule} isSuper={isSuper} toast={toast} />
          <ReadOnlySummary schedule={selectedSchedule} />
        </>
      )}
    </div>
  )
}

/* ─── Schedules: create + deadline ─── */
function SchedulesPanel({ schedules, selectedScheduleId, setSelectedScheduleId, loadSchedules, refreshSchedules, isSuper, toast }) {
  const [newName, setNewName] = useState('')
  const [newDeadline, setNewDeadline] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmClearDeadline, setConfirmClearDeadline] = useState(null)
  const { profile } = usePortalAuth()

  // datetime-local inputs emit PARTIAL values while typing ("2026-08",
  // "2026-08-20T1:") — committing those throws on toISOString() or parses
  // as UTC midnight. Only complete values are ever sent to the DB
  // (COMPLETE_DATETIME at module scope).

  const createSchedule = async () => {
    if (!newName.trim()) return
    const name = newName.trim()
    if (schedules.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      toast.error('A schedule with this name already exists')
      return
    }
    const payload = { name, created_by: profile?.name }
    if (newDeadline) {
      if (!COMPLETE_DATETIME.test(newDeadline)) { toast.error('Pick a complete deadline (date + time)'); return }
      const d = new Date(newDeadline)
      if (isNaN(d.getTime())) { toast.error('Invalid deadline date/time'); return }
      payload.deadline = d.toISOString()
    }
    const { error } = await supabase.from('deployment_schedules').insert(payload)
    if (error) { toast.error(error.message); return }
    setNewName('')
    setNewDeadline('')
    loadSchedules()
    refreshSchedules?.()
    toast.success('Schedule created')
  }

  const setStatus = async (id, status) => {
    // marking done silently freezes EVERY centre portal-wide — worth a beat
    if (status === 'done' && !window.confirm('Mark this schedule DONE? All consent/deployment editing across every centre will be frozen (Control Panel overrides included).')) return
    const { error } = await supabase.from('deployment_schedules').update({ status }).eq('id', id)
    if (error) { toast.error(error.message); return }
    loadSchedules()
    refreshSchedules?.()
    toast.success(status === 'done' ? 'Schedule marked done — editing disabled' : 'Schedule reopened')
  }

  const setDeadline = async (id, value) => {
    // ignore transient/partial input — only a complete value commits here;
    // clearing goes through the explicit confirm flow below
    if (!COMPLETE_DATETIME.test(value)) return
    const d = new Date(value)
    if (isNaN(d.getTime())) { toast.error('Invalid deadline date/time'); return }
    const { error } = await supabase.from('deployment_schedules').update({ deadline: d.toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    loadSchedules()
    refreshSchedules?.()
    toast.success('Deadline set')
  }

  const clearDeadline = async (id) => {
    const { error } = await supabase.from('deployment_schedules').update({ deadline: null }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setConfirmClearDeadline(null)
    loadSchedules()
    refreshSchedules?.()
    toast.success('Deadline cleared')
  }

  const deleteSchedule = async (id) => {
    const sched = schedules.find(s => s.id === id)
    const { error } = await supabase.from('deployment_schedules').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    // audit AFTER a successful delete — a failed delete must not leave a phantom log
    {
      const { error: auditErr } = await supabase.from('audit_log').insert({
        action: 'DELETE',
        table_name: 'deployment_schedules',
        record_id: id,
        schedule_id: id,
        payload: sched || {},
        acted_by: profile?.name || profile?.email || null,
      })
      if (auditErr) console.warn('audit_log insert failed:', auditErr.message) // best-effort
    }
    setConfirmDelete(null)
    if (selectedScheduleId === id) setSelectedScheduleId('')
    loadSchedules()
    refreshSchedules?.()
    toast.success('Schedule deleted')
  }

  return (
    <section className="card" style={{ padding: "1.25rem", marginBottom: "1.25rem" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div className="section-header">
          <div className="section-title">Schedules (WED – SUN)</div>
        </div>
        {isSuper && (
          <div style={{ display: 'flex', gap: '0.35rem', flex: '1 1 auto', maxWidth: 360, flexWrap: 'wrap' }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. October 2026 Visit"
              style={{ flex: 1, minWidth: 140, padding: '0.35rem 0.6rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.85rem' }}
              onKeyDown={e => e.key === 'Enter' && createSchedule()}
            />
            <input
              type="datetime-local"
              value={newDeadline}
              onChange={e => setNewDeadline(e.target.value)}
              style={{ flex: '0 0 auto', padding: '0.35rem 0.6rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.8rem' }}
              title="Deadline (date + time) — after this, all editing is disabled"
            />
            <button onClick={createSchedule} disabled={!newName.trim()} style={{ padding: '0.35rem 0.7rem', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', opacity: newName.trim() ? 1 : 0.5 }}>
              <Plus size={15} />
            </button>
          </div>
        )}
      </div>

      {schedules.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>No schedules yet. Create one above.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {schedules.map(s => {
            const active = s.id === selectedScheduleId
            const deadlinePassed = s.deadline ? new Date(s.deadline) < new Date() : false
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem 0.75rem', padding: '0.6rem 0.75rem', borderRadius: 8, border: active ? '2px solid #2563eb' : '1px solid #e5e7eb', background: active ? '#eff6ff' : '#fff', cursor: 'pointer' }} onClick={() => setSelectedScheduleId(s.id)}>
                <ChevronRight size={15} style={{ color: active ? '#2563eb' : '#cbd5e1', flexShrink: 0 }} />
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.name}</div>
                  <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Created {new Date(s.created_at).toLocaleDateString('en-IN')}{s.created_by ? ` · ${s.created_by}` : ''}</div>
                </div>
                <span className={`pill ${s.status === "done" ? "pill-gray" : "pill-green"}`}>
                  {SCHEDULE_STATUS_LABELS[s.status] || s.status}
                </span>
                {isSuper && (
                  <>
                    <div className="cluster" onClick={e => e.stopPropagation()} style={{ gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: deadlinePassed ? '#b91c1c' : '#64748b' }}>Deadline</span>
                      <DeadlineDraftInput
                        iso={s.deadline}
                        onCommit={value => setDeadline(s.id, value)}
                        style={{ padding: '0.25rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.75rem' }}
                        title="Set/edit deadline — after this, all editing is disabled"
                      />
                      {s.deadline && (
                        <button onClick={() => setConfirmClearDeadline(s)} className="btn btn-ghost" style={{ padding: '0.2rem 0.35rem', fontSize: '0.7rem', color: '#b91c1c' }} title="Clear the deadline">
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <div className="cluster" onClick={e => e.stopPropagation()}>
                      {s.status === 'open' && (
                        <button onClick={() => setStatus(s.id, 'done')} className="btn btn-warning" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                          <Lock size={12} /> Mark Done
                        </button>
                      )}
                      {s.status === 'done' && (
                        <button onClick={() => setStatus(s.id, 'open')} className="btn" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                          <Unlock size={12} /> Reopen
                        </button>
                      )}
                      <button onClick={() => setConfirmDelete(s)} className="btn btn-danger" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} title="Delete schedule">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Delete schedule?</h4>
            <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem' }}>
              This will permanently delete <b>{confirmDelete.name}</b> along with all its allocations, consents, and deployments. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)} className="btn">Cancel</button>
              <button onClick={() => deleteSchedule(confirmDelete.id)} className="btn btn-danger">Delete</button>
            </div>
          </div>
        </div>
      )}

      {confirmClearDeadline && (
        <div className="modal-overlay" onClick={() => setConfirmClearDeadline(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Clear the deadline?</h4>
            <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem' }}>
              <b>{confirmClearDeadline.name}</b> will no longer have a deadline — deadline-based editing blocks are lifted for this schedule (the master switches and centre locks still apply).
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmClearDeadline(null)} className="btn">Cancel</button>
              <button onClick={() => clearDeadline(confirmClearDeadline.id)} className="btn btn-warning">Clear deadline</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ─── Departments + restriction rules ─── */
function DepartmentsPanel({ isSuper, toast }) {
  const { profile } = usePortalAuth()
  const [depts, setDepts] = useState([])
  const [newDeptName, setNewDeptName] = useState('')
  const [editDeptId, setEditDeptId] = useState(null)
  const [editDeptName, setEditDeptName] = useState('')
  const [rulesDeptId, setRulesDeptId] = useState(null)
  const [rules, setRules] = useState({
    min_days: 1, requires_stay_at_bhati: false, requires_initiated: false,
    include_vss: false, vss_min_days: 1, vss_requires_stay_at_bhati: false,
    vss_requires_initiated: false, vss_requires_gender: '',
  })

  const loadDepts = useCallback(async () => {
    const { data, error } = await supabase.from('deployment_departments').select('*').order('name')
    if (error) { toast.error(`Could not load departments: ${error.message}`); return }
    setDepts(data || [])
  }, [toast])

  useEffect(() => { loadDepts() }, [loadDepts])

  const addDept = async () => {
    if (!newDeptName.trim()) return
    const { error } = await supabase.from('deployment_departments').insert({ name: newDeptName.trim().toUpperCase() })
    if (error) { toast.error(error.message); return }
    setNewDeptName('')
    loadDepts()
    toast.success('Department added')
  }

  const renameDept = async (id) => {
    if (!editDeptName.trim()) return
    const { error } = await supabase.from('deployment_departments').update({ name: editDeptName.trim().toUpperCase() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setEditDeptId(null)
    loadDepts()
  }

  const toggleDept = async (dept) => {
    const { error } = await supabase.from('deployment_departments').update({ is_active: !dept.is_active }).eq('id', dept.id)
    if (error) { toast.error(error.message); return }
    loadDepts()
    toast.success(dept.is_active ? `${dept.name} disabled` : `${dept.name} enabled`)
  }

  const [confirmDeleteDept, setConfirmDeleteDept] = useState(null)

  const deleteDept = async (id) => {
    const { error } = await supabase.from('deployment_departments').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    // audit AFTER a successful delete — a failed delete must not leave a phantom log
    {
      const { error: auditErr } = await supabase.from('audit_log').insert({
        action: 'DELETE',
        table_name: 'deployment_departments',
        record_id: id,
        payload: { department: depts.find(d => d.id === id) || {} },
        acted_by: profile?.name || profile?.email || null,
      })
      if (auditErr) console.warn('audit_log insert failed:', auditErr.message) // best-effort
    }
    setConfirmDeleteDept(null)
    loadDepts()
    toast.success('Department deleted')
  }

  const resetRules = async (deptId) => {
    const { error } = await supabase.from('deployment_departments')
      .update({
        min_days: 1, requires_stay_at_bhati: false, requires_initiated: false,
        include_vss: false, vss_min_days: 1, vss_requires_stay_at_bhati: false,
        vss_requires_initiated: false, vss_requires_gender: null,
      })
      .eq('id', deptId)
    if (error) { toast.error(error.message); return }
    setRulesDeptId(null)
    loadDepts()
    toast.success('Rules reset to defaults')
  }

  const openRules = (dept) => {
    setRulesDeptId(dept.id)
    setRules({
      min_days: dept.min_days ?? 1, requires_stay_at_bhati: !!dept.requires_stay_at_bhati, requires_initiated: !!dept.requires_initiated,
      include_vss: !!dept.include_vss, vss_min_days: dept.vss_min_days ?? 1,
      vss_requires_stay_at_bhati: !!dept.vss_requires_stay_at_bhati, vss_requires_initiated: !!dept.vss_requires_initiated,
      vss_requires_gender: dept.vss_requires_gender || '',
    })
  }

  const saveRules = async (deptId) => {
    const minDays = parseInt(rules.min_days)
    if (!minDays || minDays < 1 || minDays > 5) { toast.error('Minimum days must be between 1 and 5'); return }
    const vssMinDays = parseInt(rules.vss_min_days)
    if (rules.include_vss && (!vssMinDays || vssMinDays < 1 || vssMinDays > 5)) {
      toast.error('VSS minimum days must be between 1 and 5'); return
    }
    const { error } = await supabase.from('deployment_departments')
      .update({
        min_days: minDays, requires_stay_at_bhati: rules.requires_stay_at_bhati, requires_initiated: rules.requires_initiated,
        include_vss: rules.include_vss,
        // NaN serializes to null and the DB rejects it — when VSS is unchecked
        // (or the hidden input was cleared) fall back to a safe default instead
        vss_min_days: (vssMinDays >= 1 && vssMinDays <= 5) ? vssMinDays : 1,
        vss_requires_stay_at_bhati: rules.vss_requires_stay_at_bhati, vss_requires_initiated: rules.vss_requires_initiated,
        vss_requires_gender: rules.vss_requires_gender || null,
      })
      .eq('id', deptId)
    if (error) { toast.error(error.message); return }
    setRulesDeptId(null)
    loadDepts()
    toast.success('Department rules saved')
  }

  return (
    <section className="card" style={{ padding: "1.25rem", marginBottom: "1.25rem" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div className="section-header">
          <div className="section-title">Departments & Rules</div>
        </div>
        {isSuper && (
          <div style={{ display: 'flex', gap: '0.35rem', flex: '1 1 auto', maxWidth: 260 }}>
            <input value={newDeptName} onChange={e => setNewDeptName(e.target.value)} placeholder="New department" style={{ flex: 1, minWidth: 0, padding: '0.35rem 0.6rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.85rem' }} onKeyDown={e => e.key === 'Enter' && addDept()} />
            <button onClick={addDept} disabled={!newDeptName.trim()} style={{ padding: '0.35rem 0.7rem', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', opacity: newDeptName.trim() ? 1 : 0.5 }}>
              <Plus size={15} />
            </button>
          </div>
        )}
      </div>

      {depts.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>No departments yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {depts.map(d => (
            <div key={d.id} style={{ border: '1px solid #eef2f7', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
              <div className="cluster" style={{ gap: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.88rem', color: d.is_active ? '#111827' : '#9ca3af' }}>{d.name}</span>
                <span className="pill pill-blue">MIN {d.min_days ?? 1} DAY{d.min_days > 1 ? 'S' : ''}</span>
                {d.requires_stay_at_bhati && <span className="pill pill-red">STAY AT BHATI</span>}
                {d.requires_initiated && <span className="pill pill-amber">INITIATED</span>}
                {d.include_vss && <span className="pill pill-green">VSS</span>}
                <div style={{ flex: 1 }} />
                {editDeptId === d.id ? (
                  <>
                    <input value={editDeptName} onChange={e => setEditDeptName(e.target.value)} style={{ width: 120, padding: '0.2rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: '0.8rem' }} autoFocus onKeyDown={e => e.key === 'Enter' && renameDept(d.id)} />
                    <button onClick={() => renameDept(d.id)} style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, padding: '0.2rem 0.45rem', cursor: 'pointer', fontSize: '0.75rem' }}>OK</button>
                    <button onClick={() => setEditDeptId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '0.75rem' }}>✕</button>
                  </>
                ) : (
                  <>
                    {isSuper && (
                      <>
                        <button onClick={() => { setEditDeptId(d.id); setEditDeptName(d.name) }} className="btn btn-ghost" style={{ padding: '0.2rem' }} title="Rename"><Edit3 size={13} /></button>
                        <button onClick={() => { openRules(d); }} className="btn btn-ghost" style={{ padding: '0.2rem', fontSize: '0.75rem', fontWeight: 600, color: '#6366f1' }} title="Set rules">Rules</button>
                        <button onClick={() => toggleDept(d)} className="btn btn-ghost" style={{ padding: '0.2rem', fontSize: '0.8rem', color: d.is_active ? '#f87171' : '#10b981' }} title={d.is_active ? 'Disable' : 'Enable'}>
                          {d.is_active ? '✕' : '+'}
                        </button>
                        <button onClick={() => setConfirmDeleteDept(d)} className="btn btn-ghost" style={{ padding: '0.2rem', color: '#dc2626' }} title="Delete department"><Trash2 size={13} /></button>
                      </>
                    )}
                  </>
                )}
              </div>
              {rulesDeptId === d.id && (
                <div style={{ marginTop: '0.5rem', padding: '0.6rem 0.75rem', background: '#f9fafb', borderRadius: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', fontWeight: 600, color: '#6b7280' }}>
                      Minimum consent days:
                      <input type="number" min="1" max="5" value={rules.min_days} onChange={e => setRules(r => ({ ...r, min_days: e.target.value }))} style={{ width: 60, padding: '0.25rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: '0.8rem', textAlign: 'center' }} />
                      <span style={{ color: '#9ca3af', fontWeight: 400 }}>/5</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                      <input type="checkbox" checked={rules.requires_stay_at_bhati} onChange={e => setRules(r => ({ ...r, requires_stay_at_bhati: e.target.checked }))} />
                      Requires stay at bhati
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                      <input type="checkbox" checked={rules.requires_initiated} onChange={e => setRules(r => ({ ...r, requires_initiated: e.target.checked }))} />
                      Requires initiated
                    </label>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => saveRules(d.id)} style={{ padding: '0.3rem 0.7rem', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>Save Rules</button>
                    <button onClick={() => resetRules(d.id)} className="btn btn-ghost" style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', color: '#b45309' }}>Reset Rules</button>
                    <button onClick={() => setRulesDeptId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '0.8rem' }}>Cancel</button>
                  </div>

                  <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px dashed #e5e7eb' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>
                      <input type="checkbox" checked={rules.include_vss} onChange={e => setRules(r => ({ ...r, include_vss: e.target.checked }))} />
                      Include VSS <span style={{ fontWeight: 500, color: '#6b7280' }}>— opens this department for VSS sewadars</span>
                    </label>
                    {rules.include_vss && (
                      <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '0.5rem 0.75rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', fontWeight: 600, color: '#166534' }}>
                          VSS minimum days:
                          <input type="number" min="1" max="5" value={rules.vss_min_days} onChange={e => setRules(r => ({ ...r, vss_min_days: e.target.value }))} style={{ width: 60, padding: '0.25rem 0.4rem', border: '1px solid #d1fae5', borderRadius: 4, fontSize: '0.8rem', textAlign: 'center' }} />
                          <span style={{ color: '#6b7280', fontWeight: 400 }}>/5</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                          <input type="checkbox" checked={rules.vss_requires_stay_at_bhati} onChange={e => setRules(r => ({ ...r, vss_requires_stay_at_bhati: e.target.checked }))} />
                          VSS requires stay at bhati
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                          <input type="checkbox" checked={rules.vss_requires_initiated} onChange={e => setRules(r => ({ ...r, vss_requires_initiated: e.target.checked }))} />
                          VSS requires initiated
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', fontWeight: 600, color: '#166534' }}>
                          VSS gender:
                          <select value={rules.vss_requires_gender} onChange={e => setRules(r => ({ ...r, vss_requires_gender: e.target.value }))} style={{ padding: '0.25rem 0.4rem', border: '1px solid #d1fae5', borderRadius: 4, fontSize: '0.8rem' }}>
                            <option value="">Any</option>
                            <option value="MALE">Male</option>
                            <option value="FEMALE">Female</option>
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmDeleteDept && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteDept(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Delete department?</h4>
            <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem' }}>
              This will permanently delete <b>{confirmDeleteDept.name}</b> and its rules, remove it from all schedule allocations, and delete its deployment records. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteDept(null)} className="btn">Cancel</button>
              <button onClick={() => deleteDept(confirmDeleteDept.id)} className="btn btn-danger">Delete</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ─── Allocations: pick dept, set count per parent centre, save all at once ─── */
function AllocationsPanel({ schedule, isSuper, toast }) {
  const { profile } = usePortalAuth()
  const [allocations, setAllocations] = useState([])
  const [depts, setDepts] = useState([])
  const [centres, setCentres] = useState([])
  const [formDeptId, setFormDeptId] = useState('')
  const [formCounts, setFormCounts] = useState({})
  const [expandedDept, setExpandedDept] = useState(null)
  const [editCounts, setEditCounts] = useState({})
  // a centre picked from the "Add centre" picker in the expanded editor —
  // staged until Save commits it as an insert (never a second row: the
  // picker only lists centres without an allocation for this department)
  const [stagedNewCentre, setStagedNewCentre] = useState(null)

  const load = useCallback(async () => {
    const [aRes, dRes] = await Promise.all([
      supabase.from('centre_allocations').select('*, deployment_departments(name)').eq('schedule_id', schedule.id).order('created_at'),
      supabase.from('deployment_departments').select('*').order('name'),
    ])
    const failed = [aRes, dRes].find(r => r?.error)
    if (failed) { toast.error(failed.error.message); return }
    setAllocations(aRes.data || [])
    setDepts(dRes.data || [])
    // fetchCentres() resolves straight to the row array and THROWS on error
    // (unlike the raw supabase calls above) — surface the failure instead of
    // silently rendering an editor with no centres to edit or add
    try {
      setCentres(getParentCentres(await fetchCentres()))
    } catch (err) {
      toast.error(`Could not load centres: ${err?.message || 'unknown error'}`)
    }
  }, [schedule.id, toast])

  useEffect(() => { load() }, [load])

  const deptAlloc = (deptId) => allocations.filter(a => a.department_id === deptId)

  const buildCounts = (deptId) => {
    const counts = {}
    centres.forEach(c => { counts[c.name] = '' })
    deptAlloc(deptId).forEach(a => { counts[a.centre] = String(a.max_count) })
    return counts
  }

  const selectDept = (deptId) => {
    setFormDeptId(deptId)
    setFormCounts(buildCounts(deptId))
  }

  const setFormCount = (centre, value) => setFormCounts(f => ({ ...f, [centre]: value }))

  // source: which editor the Save came from — 'form' (top picker) or 'editor'
  // (expanded department row). When BOTH target the same department they hold
  // independent count drafts; keying off `formDeptId === deptId` alone made an
  // expanded-editor Save silently apply the top form's numbers instead.
  const buildPlan = (deptId, source = 'auto') => {
    const counts = source === 'form' ? formCounts
      : source === 'editor' ? editCounts
      : (formDeptId === deptId ? formCounts : editCounts)
    // Number() not parseInt: type=number inputs accept "1e3" which parseInt
    // silently truncates to 1
    const entries = centres.map(c => ({ centre: c.name, count: Number(String(counts[c.name]).trim()) })).filter(e => Number.isInteger(e.count) && e.count > 0)
    const existing = deptAlloc(deptId)
    const existingMap = {}
    existing.forEach(a => { existingMap[a.centre] = a })

    const toInsert = entries.filter(e => !existingMap[e.centre]).map(e => ({
      schedule_id: schedule.id,
      department_id: deptId,
      centre: e.centre,
      max_count: e.count,
    }))
    const toUpdate = entries.filter(e => existingMap[e.centre] && existingMap[e.centre].max_count !== e.count).map(e => ({
      id: existingMap[e.centre].id,
      centre: e.centre,
      old: existingMap[e.centre].max_count,
      max_count: e.count,
    }))
    const toDelete = existing.filter(a => !entries.some(e => e.centre === a.centre)).map(a => ({
      id: a.id,
      centre: a.centre,
    }))
    return { entries, toInsert, toUpdate, toDelete }
  }

  const [confirmPlan, setConfirmPlan] = useState(null)
  const [confirmRemoveDept, setConfirmRemoveDept] = useState(null)

  const saveAll = async (deptId, confirmed = false, source = 'auto') => {
    const plan = buildPlan(deptId, source)
    if (plan.entries.length === 0) { toast.error('Enter at least one centre count'); return }

    // If this department already has allocations and we're changing them, ask first
    if (!confirmed && (plan.toUpdate.length > 0 || plan.toDelete.length > 0)) {
      setConfirmPlan({ deptId, source, ...plan })
      return
    }

    const ops = []
    if (plan.toInsert.length) ops.push(supabase.from('centre_allocations').upsert(plan.toInsert, { onConflict: 'schedule_id,department_id,centre' }))
    for (const u of plan.toUpdate) ops.push(supabase.from('centre_allocations').update({ max_count: u.max_count }).eq('id', u.id))
    for (const d of plan.toDelete) ops.push(supabase.from('centre_allocations').delete().eq('id', d.id))

    const results = await Promise.all(ops)
    const failures = results.filter(r => r?.error)
    // always reset UI to PERSISTED state — inserts are upserted, so a retry
    // from the reloaded data is safe even after a partial failure
    setConfirmPlan(null)
    setFormDeptId('')
    setFormCounts({})
    setStagedNewCentre(null)
    await load()
    if (expandedDept) setEditCounts(buildCounts(expandedDept))
    if (failures.length > 0) {
      console.warn('allocation save failures:', failures.map(f => f.error?.message))
      toast.error(`${failures.length} allocation operation${failures.length === 1 ? '' : 's'} failed — the list has been refreshed with what actually saved`)
      return
    }
    toast.success('Allocations saved')
  }

  const removeAllocation = async (alloc) => {
    const deptName = depts.find(d => d.id === alloc.department_id)?.name || 'this department'
    if (!window.confirm(`Remove the ${alloc.centre} allocation for ${deptName}? The centre loses that quota immediately.`)) return
    const { error } = await supabase.from('centre_allocations').delete().eq('id', alloc.id)
    if (error) { toast.error(error.message); return }
    // audit AFTER a successful delete — a failed delete must not leave a phantom log
    {
      const { error: auditErr } = await supabase.from('audit_log').insert({
        action: 'DELETE',
        table_name: 'centre_allocations',
        record_id: alloc.id,
        schedule_id: schedule.id,
        payload: { allocation_id: alloc.id, centre: alloc.centre, max_count: alloc.max_count, department_id: alloc.department_id },
        acted_by: profile?.name || profile?.email || null,
      })
      if (auditErr) console.warn('audit_log insert failed:', auditErr.message) // best-effort
    }
    await load()
    if (expandedDept) setEditCounts(buildCounts(expandedDept))
  }

  const removeDeptAll = async (deptId) => {
    // capture rows BEFORE the delete so the audit payload records what was removed
    const existing = await supabase.from('centre_allocations').select('*').eq('schedule_id', schedule.id).eq('department_id', deptId)
    const { error } = await supabase.from('centre_allocations').delete().eq('schedule_id', schedule.id).eq('department_id', deptId)
    if (error) { toast.error(error.message); return }
    // audit AFTER a successful delete — a failed delete must not leave a phantom log
    {
      const { error: auditErr } = await supabase.from('audit_log').insert({
        action: 'REMOVE_ALL',
        table_name: 'centre_allocations',
        schedule_id: schedule.id,
        payload: { department_id: deptId, allocations: existing.data || [] },
        acted_by: profile?.name || profile?.email || null,
      })
      if (auditErr) console.warn('audit_log insert failed:', auditErr.message) // best-effort
    }
    setConfirmRemoveDept(null)
    setExpandedDept(null)
    setStagedNewCentre(null)
    load()
    toast.success('Department allocations removed')
  }

  const expandDept = (deptId) => {
    const next = expandedDept === deptId ? null : deptId
    setExpandedDept(next)
    setStagedNewCentre(null)
    if (next) setEditCounts(buildCounts(deptId))
  }

  const setEditCount = (centre, value) => setEditCounts(c => ({ ...c, [centre]: value }))

  // centres/allocations can land AFTER selectDept/expandDept snapshotted their
  // counts (fetchCentres failures used to be swallowed upstream) — without this
  // rebuild, untouched inputs read '' and an untouched Save would plan
  // spurious "Remove" rows for allocations that actually exist.
  // Deliberately keyed on the DATA, not on the count states, so typing is
  // never clobbered mid-edit — except an in-progress count on the STAGED new
  // centre, which is preserved across data refreshes.
  useEffect(() => {
    if (formDeptId) setFormCounts(buildCounts(formDeptId))
    if (expandedDept) {
      setEditCounts(prev => {
        const fresh = buildCounts(expandedDept)
        if (stagedNewCentre && prev[stagedNewCentre] != null && prev[stagedNewCentre] !== '') {
          fresh[stagedNewCentre] = prev[stagedNewCentre]
        }
        return fresh
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centres, allocations, formDeptId, expandedDept])

  const groupedDeptIds = [...new Set(allocations.map(a => a.department_id))]
  const centreNames = centres.map(c => c.name)

  return (
    <section className="card" style={{ padding: "1.25rem", marginBottom: "1.25rem" }}>
      <div className="section-header">
        <div className="section-title">Centre Allocations — {schedule.name}</div>
      </div>

      {isSuper && (
        <div style={{ marginBottom: '1rem', border: '1px solid #eef2f7', borderRadius: 8, padding: '0.75rem' }}>
          <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 600, color: '#6b7280', marginBottom: '0.25rem', textTransform: 'uppercase' }}>Department</label>
          <select value={formDeptId} onChange={e => selectDept(e.target.value)} style={{ padding: '0.4rem 0.6rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.85rem', width: '100%', maxWidth: 360 }}>
            <option value="">Select department to allocate...</option>
            {/* inactive departments are invisible to every centre page (they
                fetch active-only) — never offer them for new allocations */}
            {depts.filter(d => d.is_active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>

          {formDeptId && (
            <div style={{ marginTop: '0.75rem' }}>
              <p style={{ fontSize: '0.78rem', color: '#6b7280', marginBottom: '0.5rem' }}>
                Max count per CENTRE — centres already allotted show their current count (edit it to increase/decrease); blank centres are skipped:
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem' }}>
                {centres.map(c => {
                  const savedCount = deptAlloc(formDeptId).find(a => a.centre === c.name)?.max_count
                  return (
                    <label key={c.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0.6rem', border: '1px solid #eef2f7', borderRadius: 6, fontSize: '0.8rem', fontWeight: 500 }}>
                      <span>{c.name}{savedCount != null ? <span style={{ display: 'block', fontSize: '0.62rem', color: '#94a3b8', fontWeight: 400 }}>allotted</span> : null}</span>
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <input type="number" min="1" value={formCounts[c.name] || ''} onChange={e => setFormCount(c.name, e.target.value)} placeholder="0" style={{ width: 64, padding: '0.25rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: '0.8rem', textAlign: 'center' }} />
                        {savedCount != null && <CountChangeChip saved={savedCount} draft={formCounts[c.name]} />}
                      </span>
                    </label>
                  )
                })}
              </div>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => saveAll(formDeptId, false, 'form')} style={{ padding: '0.4rem 0.9rem', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <Plus size={14} /> Save Allocations
                </button>
                <button onClick={() => { setFormDeptId(''); setFormCounts({}) }} style={{ padding: '0.4rem 0.9rem', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: '0.85rem', color: '#6b7280' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {groupedDeptIds.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>No allocations for this schedule.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {groupedDeptIds.map(deptId => {
            const dept = depts.find(d => d.id === deptId) || allocations.find(a => a.department_id === deptId)?.deployment_departments
            const list = deptAlloc(deptId)
            const total = list.reduce((sum, a) => sum + a.max_count, 0)
            const expanded = expandedDept === deptId
            return (
              <div key={deptId} style={{ border: '1px solid #eef2f7', borderRadius: 8, overflow: 'hidden' }}>
                <div
                  onClick={() => isSuper && expandDept(deptId)}
                  style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', padding: '0.5rem 0.75rem', cursor: isSuper ? 'pointer' : 'default', background: expanded ? '#f8fafc' : '#fff' }}
                >
                  <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>{expanded ? '▾' : '▸'}</span>
                  <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{dept?.name || '—'}</span>
                  <span style={{ padding: '0.15rem 0.45rem', borderRadius: 99, fontSize: '0.7rem', fontWeight: 600, background: '#eff6ff', color: '#1d4ed8' }}>{list.length} centre{list.length > 1 ? 's' : ''} · {total} total</span>
                  {isSuper && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => setConfirmRemoveDept(deptId)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', fontWeight: 600 }} title="Remove department's allocations">
                        <Trash2 size={13} /> Remove
                      </button>
                    </div>
                  )}
                </div>
                {expanded && (() => {
                  // Edit view: ONLY the centres already allotted (increase /
                  // decrease / remove) plus an explicit "Add centre" picker
                  // listing centres WITHOUT an allotment for this department
                  // in this schedule. One row per centre, ever — the DB unique
                  // constraint is the backstop.
                  // Allotted rows come from `allocations` and carry their own
                  // names, so they render even if the centres list failed to
                  // load — only the ADD picker needs the centres table.
                  const stagedHere = expandedDept === deptId ? stagedNewCentre : null
                  const allocatedNames = list.map(a => a.centre)
                  const addable = centreNames.filter(n => !allocatedNames.includes(n) && n !== stagedHere)
                  const inputStyle = { width: 56, padding: '0.2rem 0.3rem', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: '0.8rem', textAlign: 'center' }
                  return (
                    <div style={{ padding: '0.5rem 0.75rem', borderTop: '1px solid #eef2f7' }}>
                      {list.length === 0 && centreNames.length === 0 ? (
                        <p style={{ fontSize: '0.8rem', color: '#9ca3af' }}>No CENTREs found.</p>
                      ) : (
                        <>
                          {list.length > 0 || stagedHere ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem' }}>
                              {list.map(a => (
                                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.6rem', border: '1px solid #eef2f7', borderRadius: 6, fontSize: '0.8rem' }}>
                                  <span style={{ flex: 1, fontWeight: 500, color: '#111827' }}>{a.centre}</span>
                                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                    <input type="number" min="1" value={editCounts[a.centre] ?? ''} onChange={e => setEditCount(a.centre, e.target.value)} title={`Change ${a.centre}'s count (currently ${a.max_count})`} style={inputStyle} />
                                    <CountChangeChip saved={a.max_count} draft={editCounts[a.centre]} />
                                  </span>
                                  <button onClick={() => removeAllocation(a)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.2rem' }} title="Remove"><Trash2 size={13} /></button>
                                </div>
                              ))}
                              {stagedHere && (
                                <div key="__staged__" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.6rem', border: '1px dashed #93c5fd', background: '#eff6ff', borderRadius: 6, fontSize: '0.8rem' }}>
                                  <span style={{ flex: 1, fontWeight: 500 }}>
                                    {stagedHere}
                                    <span className="pill pill-blue" style={{ fontSize: '0.58rem', marginLeft: '0.35rem' }}>NEW</span>
                                  </span>
                                  <input type="number" min="1" autoFocus value={editCounts[stagedHere] || ''} onChange={e => setEditCount(stagedHere, e.target.value)} placeholder="count" style={inputStyle} />
                                  <button onClick={() => { setEditCount(stagedHere, ''); setStagedNewCentre(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '0.2rem' }} title="Cancel adding">✕</button>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p style={{ fontSize: '0.8rem', color: '#9ca3af', margin: 0 }}>No centres allotted yet — add one below.</p>
                          )}

                          {centreNames.length > 0 && (
                            <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              {addable.length > 0 ? (
                                <>
                                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b7280' }}>Add centre:</span>
                                  <select
                                    value=""
                                    onChange={e => {
                                      const name = e.target.value
                                      if (!name) return
                                      setStagedNewCentre(name)
                                      setEditCount(name, '')
                                    }}
                                    style={{ padding: '0.25rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.78rem' }}
                                    title="Only centres without an allotment for this department are listed"
                                  >
                                    <option value="">Select a CENTRE to add…</option>
                                    {addable.map(name => <option key={name} value={name}>{name}</option>)}
                                  </select>
                                  <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>then set its count and Save</span>
                                </>
                              ) : list.length + (stagedHere ? 1 : 0) > 0 ? (
                                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>All CENTREs already have an allotment for this department.</span>
                              ) : null}
                            </div>
                          )}

                          {isSuper && (
                            <button onClick={() => saveAll(deptId, false, 'editor')} style={{ marginTop: '0.6rem', padding: '0.35rem 0.8rem', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
                              Save
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}

      {confirmPlan && (
        <div className="modal-overlay" onClick={() => setConfirmPlan(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Update allocations?</h4>
            <p style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '0.75rem' }}>
              This department already has allocations. Confirm the changes:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
              {confirmPlan.toUpdate.map(u => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.45rem 0.6rem', background: '#fffbeb', borderRadius: 6 }}>
                  <span style={{ fontWeight: 600 }}>{u.centre}</span>
                  <span>{u.old} → <b>{u.max_count}</b></span>
                </div>
              ))}
              {confirmPlan.toDelete.map(d => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.45rem 0.6rem', background: '#fef2f2', borderRadius: 6 }}>
                  <span style={{ fontWeight: 600 }}>{d.centre}</span>
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>Remove</span>
                </div>
              ))}
              {confirmPlan.toUpdate.length === 0 && confirmPlan.toDelete.length === 0 && (
                <p style={{ color: '#9ca3af', fontSize: '0.8rem' }}>No changes.</p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmPlan(null)} style={{ padding: '0.45rem 0.9rem', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: '0.85rem', color: '#6b7280', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={() => saveAll(confirmPlan.deptId, true, confirmPlan.source)} style={{ padding: '0.45rem 0.9rem', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                Confirm Update
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemoveDept && (
        <div className="modal-overlay" onClick={() => setConfirmRemoveDept(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Remove department allocations?</h4>
            <p style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '1rem' }}>
              This will delete all centre allocations for <b>{depts.find(d => d.id === confirmRemoveDept)?.name || 'this department'}</b> in this schedule. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmRemoveDept(null)} style={{ padding: '0.45rem 0.9rem', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: '0.85rem', color: '#6b7280', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={() => removeDeptAll(confirmRemoveDept)} style={{ padding: '0.45rem 0.9rem', border: 'none', borderRadius: 6, background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                Remove All
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
function ReadOnlySummary({ schedule }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(null)
      try {
        // fetch department names separately instead of relying on a hard-coded
        // FK constraint name in the select hint (that name can differ between DBs)
        const [dRes, depRes] = await Promise.all([
          supabase.from('deployments').select('centre, department_id, deployed_department_id').eq('schedule_id', schedule.id),
          supabase.from('deployment_departments').select('id, name'),
        ])
        const failed = [dRes, depRes].find(r => r?.error)
        if (failed) throw failed.error
        if (mounted) {
          const deptNameById = {}
          ;(depRes.data || []).forEach(d => { deptNameById[d.id] = d.name })
          // count by the EFFECTIVE department (ASO's final when set, else
          // requested) — same semantics as every dashboard and the DB quota math
          setRows((dRes.data || []).map(r => ({
            ...r,
            dept_name: deptNameById[r.deployed_department_id || r.department_id] || '—',
            overridden: !!r.deployed_department_id && r.deployed_department_id !== r.department_id,
          })))
        }
      } catch (err) {
        console.warn('summary load failed:', err?.message)
        if (mounted) setLoadError(err?.message || 'unknown error')
      } finally { if (mounted) setLoading(false) }
    })()
    return () => { mounted = false }
  }, [schedule.id])

  const byCentre = {}
  rows.forEach(r => {
    if (!byCentre[r.centre]) byCentre[r.centre] = {}
    if (!byCentre[r.centre][r.dept_name]) byCentre[r.centre][r.dept_name] = 0
    byCentre[r.centre][r.dept_name]++
  })

  const centres = Object.keys(byCentre)

  if (loading) return <section className="card" style={{ padding: '1.25rem' }}><p style={{ color: '#9ca3af', fontSize: '0.85rem' }}>Loading summary...</p></section>

  if (loadError) {
    return (
      <section className="card" style={{ padding: '1.25rem' }}>
        <div className="section-header"><div className="section-title">Deployment Summary — {schedule.name}</div></div>
        <p style={{ color: '#dc2626', fontSize: '0.85rem' }}>Could not load the deployment summary: {loadError}</p>
      </section>
    )
  }

  return (
    <section className="card" style={{ padding: '1.25rem' }}>
      <div className="section-header">
        <div className="section-title">Deployment Summary — {schedule.name}</div>
      </div>
      {centres.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>No deployments yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {centres.map(c => (
            <div key={c} style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: '0.5rem 0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{c}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                {Object.entries(byCentre[c]).map(([dept, count]) => (
                  <span key={dept} className="pill pill-blue">{dept}: {count}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
