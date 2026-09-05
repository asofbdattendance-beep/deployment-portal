import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fetchCentres, fetchAllRows, vssPhotoUrl } from '../lib/supabase'
import { getSubtreeCentres, computeAge, isVssAgeBlocked, vssRegistrationErrors } from '../lib/logic'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from './Toast'
import { UserPlus, Camera, Trash2, Loader2, BadgeCheck, Pencil, X, Search, Lock } from 'lucide-react'

// Resolves a stored photo (legacy full URL or bare reg/... path) to a
// time-limited signed URL — the vss-photos bucket is private (v16), so plain
// public URLs no longer load.
function VssPhoto({ value, alt = '', style, fallbackStyle }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let mounted = true
    vssPhotoUrl(value).then(u => { if (mounted) setUrl(u) }).catch(() => {})
    return () => { mounted = false }
  }, [value])
  if (!url) {
    return <span style={fallbackStyle || { color: '#cbd5e1', fontSize: '0.75rem' }}>—</span>
  }
  return <img src={url} alt={alt} style={style} />
}

const EMPTY_FORM = {
  centre: '',
  sewadar_name: '',
  father_husband_name: '',
  gender: '',
  dob: '',
  address: '',
  contact_no: '',
  emergency_contact: '',
  is_initiated: false,
  aadhar_number: '',
}

/* ─── New VSS creation form + management of created records ───
   centre_user/centre_admin: create/edit/delete for own subtree (read-only list)
   aso/super_admin: create for any centre + assign the VSFB number
   (moves the record into the vss_sewadars roster), with a duplicate
   warning when the name / Aadhar already exists.
   Creation is gated (v19): centre roles need BOTH the ASO's "Add VSS"
   master switch open AND an open deadline window. Once a registration
   is assigned its VSFB number it freezes for centres (DB-enforced). */
export default function AddVssForm({ creationOpen = false, windowOpen = false, creationOverride = null }) {
  const { profile } = usePortalAuth()
  const toast = useToast()
  // phase-2 hardening (v20): aso accounts are read-only everywhere —
  // creation, edits, deletes and VSFB assignment are super_admin actions now.
  const isAso = profile?.role === 'aso'
  const isSuperAdmin = profile?.role === 'super_admin'
  const readOnlyAdmin = isAso
  const isAllCentres = isAso || isSuperAdmin
  const canAssign = isSuperAdmin
  // centres are gated by switch + deadline; super_admin bypasses both;
  // aso never gets the form (view-only). creationOpen already equals
  // override ?? (global && window), so the double `|| !windowOpen` would
  // defeat a per-centre force-open after deadline (override=true should
  // allow creation even when window=false). Edit gating mirrors the DB
  // guard: COALESCE(override, window) for UPDATE/DELETE.
  const centreGated = readOnlyAdmin || (!isAllCentres && !creationOpen)
  const editGated = readOnlyAdmin || (!isAllCentres && !(creationOverride != null ? creationOverride : windowOpen))

  const [centres, setCentres] = useState([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [photo, setPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [registrations, setRegistrations] = useState([])
  const [statusFilter, setStatusFilter] = useState('all')
  const [centreFilter, setCentreFilter] = useState('all')
  const [searchReg, setSearchReg] = useState('')
  const [assignVals, setAssignVals] = useState({})
  const [assigningId, setAssigningId] = useState(null)
  const [dupCheck, setDupCheck] = useState(null)
  // edit / delete
  const [editReg, setEditReg] = useState(null)
  const [editForm, setEditForm] = useState(EMPTY_FORM)
  const [editErrors, setEditErrors] = useState({})
  const [editPhoto, setEditPhoto] = useState(null)
  const [editPhotoPreview, setEditPhotoPreview] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [deleteReg, setDeleteReg] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef(null)
  const editFileRef = useRef(null)

  // revoke preview object URLs so repeated photo picks don't leak memory
  const revokePreview = useCallback(() => setPhotoPreview(prev => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); return '' }), [])
  const revokeEditPreview = useCallback(() => setEditPhotoPreview(prev => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); return '' }), [])
  useEffect(() => () => { revokePreview(); revokeEditPreview() }, [revokePreview, revokeEditPreview])

  const loadRegistrations = useCallback(async () => {
    const { data } = await supabase.from('vss_registrations').select('*').order('created_at', { ascending: false }).limit(200)
    if (data) setRegistrations(data)
  }, [])

  useEffect(() => {
    fetchCentres().then(allCentres => {
      const scoped = isAllCentres
        ? allCentres
        : allCentres.filter(c => getSubtreeCentres(allCentres, profile?.centre).includes(c.name))
      setCentres(scoped)
      if (!isAllCentres && profile?.centre && scoped.some(c => c.name === profile.centre)) {
        setForm(f => ({ ...f, centre: profile.centre }))
      }
    }).catch(() => {})
  }, [isAllCentres, profile?.centre])
  useEffect(() => { loadRegistrations() }, [loadRegistrations])

  const uploadPhoto = async (file) => {
    const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '')
    const path = `reg/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage.from('vss-photos').upload(path, file)
    if (error) throw error
    // store the bare path — the bucket is private (v16), full public URLs
    // would stop working; VssPhoto resolves the path to a signed URL
    return path
  }

  /* ─── create ─── */
  const set = (key) => (e) => {
    setForm(f => ({ ...f, [key]: e.target.value }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
  }

  const onPhoto = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image file (JPG/PNG etc.)'); clearPhoto(); return }
    setPhoto(file)
    revokePreview()
    setPhotoPreview(URL.createObjectURL(file))
    setErrors(prev => ({ ...prev, photo: undefined }))
  }

  const clearPhoto = () => {
    setPhoto(null)
    revokePreview()
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    // belt-and-braces: the DB guard (v19) is authoritative, this keeps the UX clean
    if (centreGated) {
      if (readOnlyAdmin) {
        toast.error('View-only access — ASO accounts cannot create VSS records')
      } else if (creationOverride === false) {
        toast.error('Adding VSS is currently closed for your centre by the ASO')
      } else if (!windowOpen) {
        toast.error('The deadline has passed — adding VSS is disabled')
      } else {
        toast.error('Adding VSS is currently closed by the ASO')
      }
      return
    }
    const e2 = vssRegistrationErrors(form, { hasPhoto: !!photo, photoSize: photo?.size || 0 })
    setErrors(e2)
    if (Object.keys(e2).some(k => e2[k])) { toast.error('Please fix the highlighted fields'); return }
    setSubmitting(true)
    let uploadedPath = null
    try {
      const photo_url = await uploadPhoto(photo)
      uploadedPath = photo_url
      const { error } = await supabase.from('vss_registrations').insert({
        centre: form.centre,
        sewadar_name: form.sewadar_name.trim(),
        father_husband_name: form.father_husband_name.trim(),
        gender: form.gender,
        dob: form.dob,
        address: form.address.trim(),
        contact_no: form.contact_no.trim(),
        emergency_contact: form.emergency_contact.trim(),
        is_initiated: form.is_initiated,
        aadhar_number: form.aadhar_number.trim(),
        photo_url,
        created_by: profile?.name || null,
      })
      if (error) throw error
      toast.success('VSS record created with a temporary ID')
      setForm(EMPTY_FORM)
      setErrors({})
      clearPhoto()
      loadRegistrations()
    } catch (err) {
      // the photo was already uploaded — remove it so a failed insert doesn't
      // leave an orphaned file in storage
      if (uploadedPath) await supabase.storage.from('vss-photos').remove([uploadedPath]).catch(() => {})
      toast.error(err.message || 'Could not create record')
    } finally { setSubmitting(false) }
  }

  /* ─── edit ─── */
  const openEdit = (reg) => {
    // frozen once the ASO allocated a VSFB number (v9 RLS blocks it server-side too)
    if (reg?.status === 'assigned') return
    setEditReg(reg)
    setEditForm({
      centre: reg.centre,
      sewadar_name: reg.sewadar_name,
      father_husband_name: reg.father_husband_name || '',
      gender: reg.gender || '',
      dob: reg.dob || '',
      address: reg.address || '',
      contact_no: reg.contact_no || '',
      emergency_contact: reg.emergency_contact || '',
      is_initiated: !!reg.is_initiated,
      aadhar_number: reg.aadhar_number || '',
    })
    setEditErrors({})
    setEditPhoto(null)
    revokeEditPreview()
  }
  const setEdit = (key) => (e) => {
    setEditForm(f => ({ ...f, [key]: e.target.value }))
    setEditErrors(prev => ({ ...prev, [key]: undefined }))
  }
  const onEditPhoto = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image file (JPG/PNG etc.)'); if (editFileRef.current) editFileRef.current.value = ''; return }
    setEditPhoto(file)
    revokeEditPreview()
    setEditPhotoPreview(URL.createObjectURL(file))
  }
  const saveEdit = async () => {
    if (!editReg || editReg.status === 'assigned') return
    if (editGated && !isSuperAdmin) {
      if (readOnlyAdmin) toast.error('View-only access — ASO accounts cannot edit VSS records')
      else if (creationOverride === false) toast.error('Editing VSS is currently closed for your centre by the ASO')
      else toast.error('The deadline has passed — VSS records can no longer be edited')
      return
    }
    const e2 = vssRegistrationErrors(editForm, { hasPhoto: true, photoSize: editPhoto ? editPhoto.size : 0 })
    setEditErrors(e2)
    if (Object.keys(e2).some(k => e2[k])) { toast.error('Please fix the highlighted fields'); return }
    setEditSaving(true)
    let uploadedEditPath = null
    try {
      let photo_url = editReg.photo_url
      if (editPhoto) {
        photo_url = await uploadPhoto(editPhoto)
        uploadedEditPath = photo_url
      }
      const { error } = await supabase.from('vss_registrations').update({
        centre: editForm.centre,
        sewadar_name: editForm.sewadar_name.trim(),
        father_husband_name: editForm.father_husband_name.trim(),
        gender: editForm.gender,
        dob: editForm.dob,
        address: editForm.address.trim(),
        contact_no: editForm.contact_no.trim(),
        emergency_contact: editForm.emergency_contact.trim(),
        is_initiated: editForm.is_initiated,
        aadhar_number: editForm.aadhar_number.trim(),
        photo_url,
      }).eq('id', editReg.id)
      if (error) throw error
      toast.success('Registration updated')
      setEditReg(null)
      loadRegistrations()
    } catch (err) {
      // a freshly uploaded replacement photo would be orphaned if the row
      // update failed — remove it to keep storage clean
      if (uploadedEditPath) await supabase.storage.from('vss-photos').remove([uploadedEditPath]).catch(() => {})
      toast.error(err.message || 'Could not update record')
    } finally { setEditSaving(false) }
  }

  /* ─── delete ─── */
  const doDelete = async () => {
    if (!deleteReg) return
    if (editGated && !isSuperAdmin) {
      if (readOnlyAdmin) toast.error('View-only access — ASO accounts cannot delete VSS records')
      else if (creationOverride === false) toast.error('Deleting VSS is currently closed for your centre by the ASO')
      else toast.error('The deadline has passed — VSS records can no longer be deleted')
      return
    }
    setDeleting(true)
    try {
      if (deleteReg.photo_url) {
        const path = deleteReg.photo_url.split('/vss-photos/')[1] || deleteReg.photo_url
        if (path && path.startsWith('reg/')) await supabase.storage.from('vss-photos').remove([path]).catch(() => {})
      }
      const { error } = await supabase.from('vss_registrations').delete().eq('id', deleteReg.id)
      if (error) throw error
      toast.success('Registration deleted')
      setDeleteReg(null)
      loadRegistrations()
    } catch (err) {
      toast.error(err.message || 'Could not delete record')
    } finally { setDeleting(false) }
  }

  /* ─── assign (with duplicate guard) ─── */
  const findDuplicates = async (reg) => {
    const name = reg.sewadar_name.trim().toLowerCase()
    const aadhar = reg.aadhar_number ? reg.aadhar_number.replace(/\s/g, '') : ''
    const [rosterAll, regAll] = await Promise.all([
      fetchAllRows('vss_sewadars', 'badge_number, sewadar_name, aadhar_number', null),
      fetchAllRows('vss_registrations', 'id, temp_vss_id, sewadar_name, aadhar_number, status', (q) => q.neq('id', reg.id)),
    ])
    const dups = []
    ;(rosterAll || []).forEach(r => {
      const reasons = []
      if (r.sewadar_name && r.sewadar_name.toLowerCase() === name) reasons.push('same name')
      if (aadhar && r.aadhar_number && r.aadhar_number.replace(/\s/g, '') === aadhar) reasons.push('same Aadhar')
      if (reasons.length) dups.push({ where: 'roster', ref: r.badge_number, reasons })
    })
    ;(regAll || []).forEach(r => {
      const reasons = []
      if (r.sewadar_name && r.sewadar_name.toLowerCase() === name) reasons.push('same name')
      if (aadhar && r.aadhar_number && r.aadhar_number.replace(/\s/g, '') === aadhar) reasons.push('same Aadhar')
      if (reasons.length) dups.push({ where: 'registration', ref: r.temp_vss_id || 'registration', reasons })
    })
    return dups
  }

  const doAssign = async (reg, val) => {
    setAssigningId(reg.id)
    try {
      const { error } = await supabase.rpc('assign_vss_registration', { p_reg: reg.id, p_vsfb: val, p_by: profile?.name || null })
      if (error) throw error
      toast.success(`Assigned ${val} — moved to the VSS roster`)
      setAssignVals(a => ({ ...a, [reg.id]: '' }))
      loadRegistrations()
    } catch (err) {
      toast.error(err.message || 'Could not assign VSS number')
    } finally { setAssigningId(null) }
  }

  const handleAssign = async (reg) => {
    const raw = (assignVals[reg.id] || '').trim()
    const val = raw.toUpperCase()
    if (!/^VS/.test(val)) { toast.error('VSS number must start with VS'); return }
    const dups = await findDuplicates(reg)
    if (dups.length) { setDupCheck({ reg, val, dups }); return }
    await doAssign(reg, val)
  }

  /* ─── shared field rendering ─── */
  const label = { display: 'block', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7280', marginBottom: '0.3rem' }
  const input = { width: '100%', padding: '0.45rem 0.6rem', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: '0.85rem', background: '#fff' }
  const inputErr = { ...input, border: '1px solid #ef4444' }

  const renderField = (errs, key, node, opts = {}) => (
    <div style={opts.grid ? { gridColumn: '1 / -1' } : undefined} className={opts.cls || undefined}>
      <label style={label}>{opts.required && <span style={{ color: '#dc2626' }}>* </span>}{opts.text}</label>
      {node}
      {errs[key] && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errs[key]}</div>}
    </div>
  )

  const renderFields = (f, errs, onSet) => (
    <div className="vss-reg-grid">
      {renderField(errs, 'centre',
        <select value={f.centre} onChange={onSet('centre')} style={errs.centre ? inputErr : input} required>
          <option value="">Select centre…</option>
          {centres.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>, { text: 'Centre', required: true })}
      {renderField(errs, 'sewadar_name',
        <input value={f.sewadar_name} onChange={onSet('sewadar_name')} style={errs.sewadar_name ? inputErr : input} required placeholder="Full name" />,
        { text: 'Sewadar name', required: true })}
      {renderField(errs, 'father_husband_name',
        <input value={f.father_husband_name} onChange={onSet('father_husband_name')} style={errs.father_husband_name ? inputErr : input} required placeholder="Father / Husband name" />,
        { text: 'Father / Husband name', required: true })}
      {renderField(errs, 'gender',
        <select value={f.gender} onChange={onSet('gender')} style={errs.gender ? inputErr : input} required>
          <option value="">Select…</option>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
        </select>, { text: 'Gender', required: true })}
      {renderField(errs, 'dob',
        <input type="date" value={f.dob} onChange={onSet('dob')} style={errs.dob ? inputErr : input} required />,
        { text: 'Date of birth', required: true })}
      {renderField(errs, 'contact_no',
        <input value={f.contact_no} onChange={onSet('contact_no')} style={errs.contact_no ? inputErr : input} inputMode="tel" required placeholder="Phone number" />,
        { text: 'Contact no.', required: true })}
      {renderField(errs, 'emergency_contact',
        <input value={f.emergency_contact} onChange={onSet('emergency_contact')} style={errs.emergency_contact ? inputErr : input} inputMode="tel" required placeholder="Phone number" />,
        { text: 'Emergency contact', required: true })}
      {renderField(errs, 'aadhar_number',
        <input value={f.aadhar_number} onChange={onSet('aadhar_number')} style={errs.aadhar_number ? inputErr : input} inputMode="numeric" maxLength={12} required placeholder="12-digit Aadhar" />,
        { text: 'Aadhar number', required: true })}
      {renderField(errs, 'address',
        <textarea value={f.address} onChange={onSet('address')} rows={2} style={{ ...(errs.address ? inputErr : input), resize: 'vertical' }} required />,
        { text: 'Address', required: true, cls: 'addr' })}
    </div>
  )

  const renderInitiated = (f, onToggle, errs) => {
    const blocked = isVssAgeBlocked(f.dob, f.is_initiated)
    const age = computeAge(f.dob)
    return (
      <div style={{ margin: '0.9rem 0' }}>
        <div style={label}><span style={{ color: '#dc2626' }}>* </span>Is initiated</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', padding: '0.45rem 0.7rem', border: '1px solid #e5e7eb', borderRadius: 10, background: '#f8fafc' }}>
          <button type="button" role="switch" aria-checked={f.is_initiated} aria-label="Is initiated"
            onClick={() => { onToggle(); setErrors(prev => ({ ...prev, age: undefined })); setEditErrors(prev => ({ ...prev, age: undefined })) }}
            className="toggle" title={f.is_initiated ? 'Initiated — click to unmark' : 'Not initiated — click to mark initiated'}>
            <span className="toggle-knob" />
          </button>
          <span style={{ fontWeight: 800, fontSize: '0.85rem', color: f.is_initiated ? '#047857' : '#dc2626' }}>
            {f.is_initiated ? 'YES — INITIATED' : 'NO — NOT INITIATED'}
          </span>
        </div>
        {blocked && (            <div style={{ marginTop: '0.45rem', padding: '0.5rem 0.7rem', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '0.8rem', fontWeight: 600 }}>
              {'Age >= 29, not initiated — cannot add VSS (age '}{age}{')'}
            </div>
        )}
        {errs.age && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errs.age}</div>}
      </div>
    )
  }

  const regCentres = [...new Set(registrations.map(r => r.centre).filter(Boolean))].sort()
  const regQuery = searchReg.trim().toLowerCase()
  const filteredRegs = registrations.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (centreFilter !== 'all' && r.centre !== centreFilter) return false
    if (regQuery) {
      const hay = `${r.sewadar_name} ${r.temp_vss_id || ''} ${r.assigned_badge_number || ''} ${r.centre} ${r.aadhar_number || ''} ${r.contact_no || ''}`.toLowerCase()
      if (!hay.includes(regQuery)) return false
    }
    return true
  })

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><UserPlus size={22} /> Add / Manage VSS</h2>
          <div className="page-sub">
            {isAllCentres
              ? 'Create new VSS records for any centre — the ASO assigns the final VSFB number'
              : `Create new VSS records for ${profile?.centre} and its SC_SPs`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* ── creation gate (v19): ASO switch + deadline window ── */}
      {centreGated && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#b91c1c', marginBottom: '1rem' }}>
          <Lock size={16} />
          {readOnlyAdmin
            ? <>View-only access — ASO accounts cannot create, edit or assign VSS records.</>
            : creationOverride === false
              ? <>Adding VSS is currently <strong>CLOSED for your centre by the ASO</strong> — you cannot create VSS records until it is opened.</>
            : !windowOpen
              ? <>The deadline has passed — adding and editing VSS is disabled.</>
              : <>Adding VSS is currently <strong>CLOSED by the ASO</strong> — you cannot create VSS records until it is opened.</>}
        </div>
      )}

      {/* ── creation form (hidden for view-only aso accounts) ── */}
      {!readOnlyAdmin && (
      <form className="card" style={{ padding: '1.25rem' }} onSubmit={handleSubmit} noValidate>
        <fieldset disabled={centreGated} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, opacity: centreGated ? 0.55 : 1 }}>
          <div className="section-header" style={{ marginBottom: '1rem' }}>
            <div className="section-title">New VSS record</div>
          </div>

          {renderFields(form, errors, set)}

          {/* second line: initiated · photo · create button */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.5rem', flexWrap: 'wrap', marginTop: '1.1rem' }}>
            {renderInitiated(form, () => setForm(f => ({ ...f, is_initiated: !f.is_initiated })), errors)}

            {/* photo upload (required) */}
            <div>
              <div style={label}><span style={{ color: '#dc2626' }}>* </span>Photo</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                <div style={{ width: 84, height: 84, borderRadius: 12, border: errors.photo ? '1px solid #ef4444' : '1px dashed #cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#f8fafc', flexShrink: 0 }}>
                  {photoPreview ? <img src={photoPreview} alt="VSS preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={26} style={{ color: '#94a3b8' }} />}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input ref={fileRef} type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} id="vss-photo-input" />
                  <label htmlFor="vss-photo-input" style={{ padding: '0.45rem 0.9rem', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.4rem', width: 'fit-content' }}>
                    <Camera size={14} /> {photo ? 'Change photo' : 'Upload photo'}
                  </label>
                  {photo && (
                    <button type="button" onClick={clearPhoto} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem', width: 'fit-content', padding: 0 }}>
                      <Trash2 size={13} /> Remove photo
                    </button>
                  )}
                </div>
              </div>
              {errors.photo && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errors.photo}</div>}
            </div>

            <div style={{ flex: 1 }} />

            <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '0.6rem 1.3rem', fontSize: '0.88rem', display: 'inline-flex', alignItems: 'center', gap: '0.45rem', marginTop: '1.4rem' }}>
              {submitting ? <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> : <UserPlus size={16} />}
              {submitting ? 'Creating…' : 'Create VSS record'}
            </button>
          </div>
        </fieldset>
      </form>
      )}

        {/* ── created records list ── */}
        <div className="card" style={{ padding: '1.25rem' }}>
          <div className="section-header" style={{ marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.6rem' }}>
            <div className="section-title">Created records ({filteredRegs.length})</div>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', minWidth: 200, flex: '1 1 220px', maxWidth: 320 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              <input
                value={searchReg}
                onChange={e => setSearchReg(e.target.value)}
                placeholder="Search name / temp ID / badge / Aadhar…"
                className="input"
                style={{ width: '100%', paddingLeft: 30, paddingRight: 26, paddingTop: '0.35rem', paddingBottom: '0.35rem', fontSize: '0.8rem' }}
              />
              {searchReg && (
                <button
                  onClick={() => setSearchReg('')}
                  aria-label="Clear search"
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 2, display: 'flex' }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <select value={centreFilter} onChange={e => setCentreFilter(e.target.value)} className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', maxWidth: 180 }}>
              <option value="all">All centres</option>
              {regCentres.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="select" style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem' }}>
              <option value="all">All status</option>
              <option value="registered">Pending</option>
              <option value="assigned">Assigned</option>
            </select>
          </div>
          {filteredRegs.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', padding: '1rem' }}>No records yet. Fill the form to create the first VSS.</p>
          ) : (
            <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 40, textAlign: 'center' }}>S.No.</th>
                    <th>Temp ID</th>
                    <th>Status</th>
                    <th>Photo</th>
                    <th>Name</th>
                    <th>Centre</th>
                    <th>Gender</th>
                    <th>DOB</th>
                    <th>Contact</th>
                    <th>Initiated</th>
                    <th>Aadhar</th>
                    <th style={{ textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRegs.map((r, i) => {
                    const assigned = r.status === 'assigned'
                    return (
                      <tr key={r.id} style={{ background: assigned ? '#f0fdf4' : undefined }}>
                        <td style={{ textAlign: 'center', color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }} data-label="S.No.">{i + 1}</td>
                        <td data-label="Temp ID" style={{ fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 700, color: assigned ? '#94a3b8' : '#4f46e5' }}>
                          {r.temp_vss_id || '—'}
                          {assigned && r.assigned_badge_number && <div style={{ fontSize: '0.72rem', color: '#047857', fontWeight: 600 }}>{r.assigned_badge_number}</div>}
                        </td>
                        <td data-label="Status">
                          <span className={`pill ${assigned ? 'pill-green' : 'pill-amber'}`}>{assigned ? 'Assigned' : 'Pending'}</span>
                        </td>
                        <td data-label="Photo" style={{ textAlign: 'center' }}>
                          {r.photo_url ? <VssPhoto value={r.photo_url} alt={r.sewadar_name} style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', border: '1px solid #e2e8f0' }} /> : <span style={{ color: '#cbd5e1', fontSize: '0.75rem' }}>—</span>}
                        </td>
                        <td data-label="Name" style={{ fontWeight: 600 }}>{r.sewadar_name}</td>
                        <td data-label="Centre" style={{ color: '#64748b', fontSize: '0.8rem' }}>{r.centre}</td>
                        <td data-label="Gender" style={{ textAlign: 'center' }}>{r.gender || '—'}</td>
                        <td data-label="DOB" style={{ textAlign: 'center', fontSize: '0.78rem' }}>{r.dob || '—'}</td>
                        <td data-label="Contact" style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{r.contact_no || '—'}</td>
                        <td data-label="Initiated" style={{ textAlign: 'center' }}>
                          <span className={`pill ${r.is_initiated ? 'pill-green' : 'pill-amber'}`}>{r.is_initiated ? 'Yes' : 'No'}</span>
                        </td>
                        <td data-label="Aadhar" style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{r.aadhar_number || '—'}</td>
                        <td data-label="Actions" style={{ textAlign: 'center' }}>
                          {assigned ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8' }} title="VSFB allocated — this record is locked and can no longer be edited or deleted">
                              <Lock size={11} /> Locked{r.assigned_by ? ` · by ${r.assigned_by}` : ''}
                            </span>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'center' }}>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                <button
                                  onClick={() => openEdit(r)}
                                  disabled={editGated}
                                  className="btn btn-ghost"
                                  style={{ padding: '0.28rem 0.5rem', fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                                  title={readOnlyAdmin ? 'View-only access (v20)' : editGated ? 'The deadline has passed — editing is disabled' : 'Edit registration'}
                                >
                                  <Pencil size={12} /> Edit
                                </button>
                                <button
                                  onClick={() => setDeleteReg(r)}
                                  disabled={editGated}
                                  className="btn btn-ghost"
                                  style={{ padding: '0.28rem 0.5rem', fontSize: '0.74rem', color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                                  title={readOnlyAdmin ? 'View-only access (v20)' : editGated ? 'The deadline has passed — deleting is disabled' : 'Delete registration'}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                              {canAssign && (
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <input
                                    value={assignVals[r.id] || ''}
                                    onChange={e => setAssignVals(a => ({ ...a, [r.id]: e.target.value }))}
                                    placeholder="VSFB…"
                                    style={{ width: 84, padding: '0.28rem 0.4rem', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.72rem', fontFamily: 'monospace' }}
                                  />
                                  <button
                                    onClick={() => handleAssign(r)}
                                    disabled={assigningId === r.id}
                                    className="btn btn-primary"
                                    style={{ padding: '0.28rem 0.55rem', fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                                    title="Assign the final VSFB number — moves this record into the VSS roster"
                                  >
                                    {assigningId === r.id ? <Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} /> : <BadgeCheck size={12} />}
                                    Assign
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── edit modal ── */}
      {editReg && (
        <div className="modal-overlay" onClick={() => setEditReg(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Edit VSS registration — {editReg.temp_vss_id}</h4>
              <button onClick={() => setEditReg(null)} className="btn btn-ghost" style={{ padding: '0.25rem' }} aria-label="Close"><X size={16} /></button>
            </div>
            {renderFields(editForm, editErrors, setEdit)}
            {renderInitiated(editForm, () => setEditForm(f => ({ ...f, is_initiated: !f.is_initiated })), editErrors)}

            <div>
              <div style={label}>Photo (optional — keep current if unchanged)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
                <div style={{ width: 84, height: 84, borderRadius: 12, border: '1px dashed #cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#f8fafc', flexShrink: 0 }}>
                  {editPhotoPreview ? <img src={editPhotoPreview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : editReg.photo_url ? <VssPhoto value={editReg.photo_url} alt={editReg.sewadar_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} fallbackStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cbd5e1', fontSize: '0.7rem' }} />
                    : <Camera size={26} style={{ color: '#94a3b8' }} />}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input ref={editFileRef} type="file" accept="image/*" onChange={onEditPhoto} style={{ display: 'none' }} id="vss-edit-photo-input" />
                  <label htmlFor="vss-edit-photo-input" style={{ padding: '0.45rem 0.9rem', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.4rem', width: 'fit-content' }}>
                    <Camera size={14} /> {editPhoto ? 'Change photo' : 'Replace photo'}
                  </label>
                  {editPhoto && (
                    <button type="button" onClick={() => { setEditPhoto(null); revokeEditPreview(); if (editFileRef.current) editFileRef.current.value = '' }}
                      style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem', width: 'fit-content', padding: 0 }}>
                      <Trash2 size={13} /> Keep original
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1.1rem' }}>
              <button onClick={() => setEditReg(null)} className="btn" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>Cancel</button>
              <button onClick={saveEdit} disabled={editSaving} className="btn btn-primary" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                {editSaving ? <Loader2 size={15} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Pencil size={14} />}
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── delete confirm ── */}
      {deleteReg && (
        <div className="modal-overlay" onClick={() => setDeleteReg(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Delete VSS registration?</h4>
            <p style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '1rem' }}>
              This will permanently delete <b>{deleteReg.sewadar_name}</b> ({deleteReg.temp_vss_id || 'no temp id'}) and its photo. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteReg(null)} className="btn">Cancel</button>
              <button onClick={doDelete} disabled={deleting} className="btn btn-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                {deleting ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Trash2 size={14} />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── duplicate warning on assign ── */}
      {dupCheck && (
        <div className="modal-overlay" onClick={() => setDupCheck(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>Possible duplicate found</h4>
            <p style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '0.75rem' }}>
              Assigning <b>{dupCheck.val}</b> to <b>{dupCheck.reg.sewadar_name}</b> — {dupCheck.dups.length} match{dupCheck.dups.length > 1 ? 'es' : ''} with the same name / Aadhar:
            </p>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: '0.6rem 0.75rem', marginBottom: '0.75rem' }}>
              {dupCheck.dups.map((d, i) => (
                <div key={i} style={{ fontSize: '0.8rem', color: '#92400e', padding: '0.2rem 0' }}>
                  <b>{d.where === 'roster' ? `Roster · ${d.ref}` : `Registration · ${d.ref}`}</b> — {d.reasons.join(', ')}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setDupCheck(null)} className="btn" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>Cancel</button>
              <button onClick={() => { const { reg, val } = dupCheck; setDupCheck(null); doAssign(reg, val) }} className="btn btn-warning" style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem', fontWeight: 700 }}>
                Assign anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
