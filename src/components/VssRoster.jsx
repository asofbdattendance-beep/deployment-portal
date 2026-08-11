import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase, fetchCentres } from '../lib/supabase'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import { Users, Search, Pencil, X, Save, Lock } from 'lucide-react'

const PRINT_OPTIONS = ['ReadyToPrint-VSS', 'Printed']

/* ─── VSS roster management ───
   super_admin: view + edit + deactivate/activate + print status
   aso: read-only                                    */
export default function VssRoster() {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const isSuper = profile?.role === 'super_admin'

  const [rows, setRows] = useState([])
  const [centres, setCentres] = useState([])
  const [search, setSearch] = useState('')
  const [filterCentre, setFilterCentre] = useState('all')
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('vss_sewadars').select('*').order('sewadar_name')
    if (error) { toast.error(error.message); setLoading(false); return }
    setRows(data || [])
    setLoading(false)
  }, [toast])

  useEffect(() => { load() }, [load])
  useEffect(() => { fetchCentres().then(setCentres).catch(() => {}) }, [])

  const openEdit = (row) => {
    setEditId(row.id)
    setEditForm({
      id: row.id,
      sewadar_name: row.sewadar_name || '',
      father_husband_name: row.father_husband_name || '',
      gender: row.gender || '',
      dob: row.dob || '',
      contact_no: row.contact_no || '',
      emergency_contact: row.emergency_contact || '',
      department: row.department || '',
      remarks: row.remarks || '',
      aadhar_number: row.aadhar_number || '',
      is_initiated: !!row.is_initiated,
      print_status: row.print_status || '',
    })
  }

  const saveEdit = async () => {
    if (!editForm) return
    if (!editForm.sewadar_name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    const { error } = await supabase.from('vss_sewadars').update({
      sewadar_name: editForm.sewadar_name.trim(),
      father_husband_name: editForm.father_husband_name.trim() || null,
      gender: editForm.gender || null,
      dob: editForm.dob || null,
      contact_no: editForm.contact_no.trim() || null,
      emergency_contact: editForm.emergency_contact.trim() || null,
      department: editForm.department.trim() || null,
      remarks: editForm.remarks.trim() || null,
      aadhar_number: editForm.aadhar_number.trim() || null,
      is_initiated: editForm.is_initiated,
      print_status: editForm.print_status || null,
    }).eq('id', editForm.id)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Roster updated')
    setEditId(null)
    setEditForm(null)
    load()
  }

  const doToggleActive = async () => {
    if (!confirmToggle) return
    const next = !confirmToggle.is_active
    const { error } = await supabase.from('vss_sewadars').update({ is_active: next }).eq('id', confirmToggle.id)
    if (error) { toast.error(error.message); setConfirmToggle(null); return }
    toast.success(next ? `Activated ${confirmToggle.badge_number}` : `Deactivated ${confirmToggle.badge_number} — deployment blocked`)
    setConfirmToggle(null)
    load()
  }

  const label = { display: 'block', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7280', marginBottom: '0.3rem' }
  const input = { width: '100%', padding: '0.4rem 0.55rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.82rem', background: '#fff' }

  const visible = rows.filter(r => {
    if (filterCentre !== 'all' && r.centre !== filterCentre) return false
    if (search && !`${r.sewadar_name} ${r.badge_number}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><Users size={22} /> VSS Roster</h2>
          <div className="page-sub">
            {isSuper
              ? 'View, edit, and deactivate VSS sewadars · manage print status'
              : 'Read-only VSS roster'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={filterCentre} onChange={e => setFilterCentre(e.target.value)} className="select">
            <option value="all">All centres</option>
            {centres.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <div style={{ position: 'relative', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / badge..." className="input" style={{ width: '100%', paddingLeft: 30 }} />
          </div>
        </div>
      </div>

      {!isSuper && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#92400e', marginBottom: '1rem' }}>
          <Lock size={14} /> Read-only — only super admin can edit the roster.
        </div>
      )}

      <div className="card">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '1rem' }}>
            {[...Array(5)].map((_, i) => <div key={i} className="skeleton" style={{ height: 28 }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Users size={22} /></div>
            <div className="empty-title">No VSS sewadars found</div>
            <div className="empty-text">{search ? 'Try a different name or badge.' : 'Import the roster (vss_sewadars_data.sql) and they will appear here.'}</div>
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: 'center' }}>S.No.</th>
                  <th>Badge</th>
                  <th>Name</th>
                  <th>Centre</th>
                  <th>Gender</th>
                  <th>DOB</th>
                  <th style={{ textAlign: 'center' }}>Initiated</th>
                  <th style={{ textAlign: 'center' }}>Print</th>
                  <th style={{ textAlign: 'center' }}>Active</th>
                  {isSuper && <th style={{ textAlign: 'center' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const editing = editId === r.id
                  return (
                    <Fragment key={r.id}>
                      <tr style={{ background: !r.is_active ? '#fef2f2' : undefined, opacity: !r.is_active ? 0.9 : 1 }}>
                        <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} data-label="Badge">
                          {r.badge_number}
                          {r.aadhar_number && <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Aadhar {r.aadhar_number}</div>}
                        </td>
                        <td style={{ fontWeight: 500 }} data-label="Name">{r.sewadar_name}</td>
                        <td style={{ color: '#64748b', fontSize: '0.8rem' }} data-label="Centre">{r.centre}</td>
                        <td style={{ textAlign: 'center', fontSize: '0.8rem' }} data-label="Gender">{r.gender || '—'}</td>
                        <td style={{ textAlign: 'center', fontSize: '0.78rem' }} data-label="DOB">{r.dob || '—'}</td>
                        <td style={{ textAlign: 'center' }} data-label="Initiated">
                          <span className={`pill ${r.is_initiated ? 'pill-green' : 'pill-amber'}`}>{r.is_initiated ? 'Yes' : 'No'}</span>
                        </td>
                        <td style={{ textAlign: 'center' }} data-label="Print">
                          <span className={`pill ${r.print_status === 'Printed' ? 'pill-blue' : 'pill-gray'}`} style={{ fontSize: '0.68rem' }}>{r.print_status || '—'}</span>
                        </td>
                        <td style={{ textAlign: 'center' }} data-label="Active">
                          <span className={`pill ${r.is_active ? 'pill-green' : 'pill-red'}`}>{r.is_active ? 'Active' : 'Inactive'}</span>
                        </td>
                        {isSuper && (
                          <td style={{ textAlign: 'center' }} data-label="Actions">
                            <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
                              <button onClick={() => openEdit(r)} className="btn btn-ghost" style={{ padding: '0.28rem 0.5rem', fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }} title="Edit">
                                <Pencil size={12} /> Edit
                              </button>
                              <button
                                onClick={() => setConfirmToggle(r)}
                                className="btn btn-ghost"
                                style={{ padding: '0.28rem 0.5rem', fontSize: '0.74rem', color: r.is_active ? '#dc2626' : '#10b981', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                                title={r.is_active ? 'Deactivate (blocks deployment)' : 'Activate'}
                              >
                                {r.is_active ? 'Deactivate' : 'Activate'}
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                      {editing && (
                        <tr style={{ background: '#f8fafc' }}>
                          <td colSpan={isSuper ? 10 : 9} style={{ padding: '1rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Edit — {r.badge_number}</span>
                              <button onClick={() => { setEditId(null); setEditForm(null) }} className="btn btn-ghost" style={{ padding: '0.25rem' }} aria-label="Close"><X size={16} /></button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.7rem' }}>
                              <div>
                                <div style={label}>Name *</div>
                                <input value={editForm?.sewadar_name || ''} onChange={e => setEditForm(f => ({ ...f, sewadar_name: e.target.value }))} style={input} />
                              </div>
                              <div>
                                <div style={label}>Father / Husband</div>
                                <input value={editForm?.father_husband_name || ''} onChange={e => setEditForm(f => ({ ...f, father_husband_name: e.target.value }))} style={input} />
                              </div>
                              <div>
                                <div style={label}>Gender</div>
                                <select value={editForm?.gender || ''} onChange={e => setEditForm(f => ({ ...f, gender: e.target.value }))} style={input}>
                                  <option value="">—</option>
                                  <option value="MALE">Male</option>
                                  <option value="FEMALE">Female</option>
                                </select>
                              </div>
                              <div>
                                <div style={label}>DOB</div>
                                <input type="date" value={editForm?.dob || ''} onChange={e => setEditForm(f => ({ ...f, dob: e.target.value }))} style={input} />
                              </div>
                              <div>
                                <div style={label}>Contact</div>
                                <input value={editForm?.contact_no || ''} onChange={e => setEditForm(f => ({ ...f, contact_no: e.target.value }))} style={input} inputMode="tel" />
                              </div>
                              <div>
                                <div style={label}>Emergency contact</div>
                                <input value={editForm?.emergency_contact || ''} onChange={e => setEditForm(f => ({ ...f, emergency_contact: e.target.value }))} style={input} inputMode="tel" />
                              </div>
                              <div>
                                <div style={label}>Aadhar number</div>
                                <input value={editForm?.aadhar_number || ''} onChange={e => setEditForm(f => ({ ...f, aadhar_number: e.target.value }))} style={input} inputMode="numeric" maxLength={12} />
                              </div>
                              <div>
                                <div style={label}>Department</div>
                                <input value={editForm?.department || ''} onChange={e => setEditForm(f => ({ ...f, department: e.target.value }))} style={input} />
                              </div>
                              <div>
                                <div style={label}>Print status</div>
                                <select value={editForm?.print_status || ''} onChange={e => setEditForm(f => ({ ...f, print_status: e.target.value }))} style={input}>
                                  <option value="">—</option>
                                  {PRINT_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                                </select>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <button
                                  role="switch" aria-checked={editForm?.is_initiated}
                                  onClick={() => setEditForm(f => ({ ...f, is_initiated: !f.is_initiated }))}
                                  className="toggle"
                                  title="Is initiated"
                                >
                                  <span className="toggle-knob" />
                                </button>
                                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: editForm?.is_initiated ? '#047857' : '#dc2626' }}>{editForm?.is_initiated ? 'Initiated' : 'Not initiated'}</span>
                              </div>
                              <div style={{ gridColumn: '1 / -1' }}>
                                <div style={label}>Remarks</div>
                                <input value={editForm?.remarks || ''} onChange={e => setEditForm(f => ({ ...f, remarks: e.target.value }))} style={input} />
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                              <button onClick={() => { setEditId(null); setEditForm(null) }} className="btn">Cancel</button>
                              <button onClick={saveEdit} disabled={saving} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Save size={14} /> {saving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmToggle && (
        <div className="modal-overlay" onClick={() => setConfirmToggle(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>{confirmToggle.is_active ? 'Deactivate VSS?' : 'Activate VSS?'}</h4>
            <p style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '1rem' }}>
              {confirmToggle.is_active
                ? <><b>{confirmToggle.badge_number}</b> — {confirmToggle.sewadar_name}. Deactivating blocks this sewadar from any deployment until re-activated.</>
                : <><b>{confirmToggle.badge_number}</b> — {confirmToggle.sewadar_name} will be deployable again.</>}
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmToggle(null)} className="btn">Cancel</button>
              <button onClick={doToggleActive} className="btn btn-danger">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
