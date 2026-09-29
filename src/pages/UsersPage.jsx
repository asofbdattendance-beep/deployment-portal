import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, fetchAllRows, fetchCentres, ROLE_LABELS, ROLE_COLORS } from '../lib/supabase'
import { invitationErrors, INVITE_ROLES, INVITE_CENTRE_ROLES } from '../lib/logic'
import { PAGES } from '../lib/pages'
import { usePortalAuth } from '../context/PortalAuthContext'
import { useToast } from '../components/Toast'
import { Users, UserPlus, Search, Pencil, Ban, CheckCircle2, Copy, Trash2, KeyRound, Tag, RefreshCw, X, ShieldCheck, Eye, EyeOff } from 'lucide-react'

// ─── Users (v48, super_admin only) ───────────────────────────────────
// Logins, invites and custom roles. Security model, read before touching:
// - Enforcement NEVER lives here: portal_users.role always holds a BASE
//   value, so every RLS policy, trigger and client gate behaves exactly as
//   before. custom_role_id is display only and cannot widen access.
// - Suspension is server-enforced: is_active=false nulls get_portal_user_role()
//   (and centre/profile), so every policy fails closed. The UI only flips it.
// - Auth accounts are never created here (anon key cannot). Provisioning is
//   invite + claim_portal_invite: the invitee signs in, pastes the code on the
//   AccessDenied screen, the RPC validates email/role/expiry single-use.
// - audit_log rows are best-effort (console.warn), never fatal.

const SYSTEM_ROLES = ['centre_user', 'centre_admin', 'aso', 'super_admin', 'dept_incharge', 'scanner', 'vss_operator']
const CENTRE_ROLES = ['centre_user', 'centre_admin']
const BADGE_ROLES = ['dept_incharge', 'scanner']

function roleLabel(role) {
  if (role === 'super_admin') return 'ASO · admin'
  return ROLE_LABELS[role] || role
}

function newCode() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  } catch {
    return Math.random().toString(36).slice(2, 10).toUpperCase()
  }
}

// v51 dept-incharge department grant (department-scoped, per schedule). A single
// reusable field pair so the invite, direct-create and edit forms cannot drift.
// Renders nothing unless the role is dept_incharge.
function DeptAssignFields({ role, schedules, departments, schedule, deptIds, onSchedule, onDepts, labelStyle, required }) {
  if (role !== 'dept_incharge') return null
  const toggle = (id) => {
    const list = Array.isArray(deptIds) ? deptIds : []
    onDepts(list.includes(id) ? list.filter(x => x !== id) : [...list, id])
  }
  const openSchedules = schedules.filter(s => s.status !== 'done')
  return (
    <>
      <div>
        <label style={labelStyle}>Schedule{required ? ' *' : ''}</label>
        <select value={schedule || ''} onChange={e => { onSchedule(e.target.value); onDepts([]) }} className="select" style={{ width: '100%' }}>
          <option value="">— select schedule —</option>
          {openSchedules.map(s => <option key={s.id} value={s.id}>{s.name}{s.status === 'done' ? ' (done)' : ''}</option>)}
        </select>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={labelStyle}>Departments{required ? ' *' : ''} <span style={{ fontWeight: 400, color: '#94a3b8' }}>(they oversee this department across all centres)</span></label>
        {!schedule ? (
          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Pick a schedule first.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', maxHeight: 130, overflowY: 'auto', padding: '0.4rem', border: '1px solid #e2e8f0', borderRadius: 8 }}>
            {departments.map(d => {
              const on = (deptIds || []).includes(d.id)
              return (
                <button
                  type="button"
                  key={d.id}
                  onClick={() => toggle(d.id)}
                  className={`pill ${on ? 'pill-green' : 'pill-gray'}`}
                  style={{ cursor: 'pointer', border: 'none', fontSize: '0.72rem' }}
                  aria-pressed={on}
                >
                  {on ? '✓ ' : ''}{d.name}
                </button>
              )
            })}
            {departments.length === 0 && <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No departments exist yet.</div>}
          </div>
        )}
      </div>
    </>
  )
}

function PanelCard({ title, icon: Icon, sub, children, action }) {
  return (
    <section className="card">
      <div className="section-header" style={{ padding: '1.1rem 1.25rem 0', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <div className="section-title"><Icon size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} /> {title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
      </div>
      <div style={{ padding: '1rem 1.25rem 1.25rem' }}>{children}</div>
    </section>
  )
}

const inputStyle = { padding: '0.45rem 0.6rem', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.85rem', width: '100%' }
const labelStyle = { display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#475569', marginBottom: '0.3rem' }
const smallBtn = { padding: '0.25rem 0.55rem', fontSize: '0.72rem' }

// Highlight the matched slice inside a dropdown row (tries the typed query,
// then its spaceless uppercase form, then gives up to plain text).
function hi(text, q) {
  const t = String(text || '')
  const needles = [q.trim().replace(/[%_]/g, '')]
  const compact = needles[0].toUpperCase().replace(/[\s-]+/g, '')
  if (compact && compact !== needles[0]) needles.push(compact)
  const lower = t.toLowerCase()
  for (const n of needles) {
    if (!n) continue
    const i = lower.indexOf(n.toLowerCase())
    if (i >= 0) {
      return (<span><span>{t.slice(0, i)}</span><span style={{ background: '#fef08a', borderRadius: 3, padding: '0 1px' }}>{t.slice(i, i + n.length)}</span><span>{t.slice(i + n.length)}</span></span>)
    }
  }
  return t
}

export default function UsersPage() {
  const { profile } = usePortalAuth()
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [customRoles, setCustomRoles] = useState([])
  const [invites, setInvites] = useState([])
  const [centres, setCentres] = useState([])
  // v51 dept-incharge department grant — the reference lists the picker needs
  // and the assignments already written, so the edit form can show the current
  // grant and diff it.
  const [schedules, setSchedules] = useState([])
  const [departments, setDepartments] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const [editUser, setEditUser] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null) // { title, body, confirmLabel, danger, onConfirm }

  const [inviteForm, setInviteForm] = useState({ name: '', email: '', role: 'centre_user', customId: '', centre: '', badge: '', deptSchedule: '', deptIds: [], days: '7', code: newCode() })
  const [creating, setCreating] = useState(false)
  // Direct provisioning: search a badge from the database, pick the sewadar,
  // set role + password, create. Name/centre/badge come from the picked
  // record — never typed — so the login always matches the sewadar domain.
  const [badgeQ, setBadgeQ] = useState('')
  const [badgeHits, setBadgeHits] = useState([])
  const [badgeSearching, setBadgeSearching] = useState(false)
  const [picked, setPicked] = useState(null) // { badge_number, sewadar_name, centre, is_vss }
  const [directForm, setDirectForm] = useState({ email: '', role: 'centre_user', customId: '', password: '', showPw: false, deptSchedule: '', deptIds: [] })
  const [directBusy, setDirectBusy] = useState(false)
  const [createdCred, setCreatedCred] = useState(null) // { email, tempPassword } — shown once

  // Sewadar search across regular + VSS tables (debounced; RLS-scoped reads).
  // Matches badge number OR name, tolerating spaces/dashes/case differences
  // between what the operator types and how the master stores it.
  const [activeIdx, setActiveIdx] = useState(-1)
  const [dropOpen, setDropOpen] = useState(false)
  useEffect(() => {
    // A picked badge showing in the box is not a query — don't re-search it.
    if (picked && badgeQ.trim() === picked.badge_number) { setBadgeHits([]); setBadgeSearching(false); return }
    const raw = badgeQ.trim().replace(/[,()"']/g, '').replace(/[%_]/g, '')
    if (raw.length < 2) { setBadgeHits([]); setBadgeSearching(false); setActiveIdx(-1); return }
    setBadgeSearching(true)
    let alive = true
    const t = setTimeout(async () => {
      try {
        const ors = [`badge_number.ilike.%${raw}%`, `sewadar_name.ilike.%${raw}%`]
        const compact = raw.toUpperCase().replace(/[\s-]+/g, '')
        if (compact && compact !== raw) ors.push(`badge_number.ilike.%${compact}%`)
        const filter = ors.join(',')
        const [reg, vss] = await Promise.all([
          supabase.from('dp_sewadars').select('badge_number, sewadar_name, centre').or(filter).limit(12),
          supabase.from('vss_sewadars').select('badge_number, sewadar_name, centre').or(filter).limit(12),
        ])
        if (!alive) return
        setBadgeHits([
          ...((reg.data || []).map(r => ({ badge_number: r.badge_number, sewadar_name: r.sewadar_name, centre: r.centre, is_vss: false }))),
          ...((vss.data || []).map(r => ({ badge_number: r.badge_number, sewadar_name: r.sewadar_name, centre: r.centre, is_vss: true }))),
        ].slice(0, 12))
        setActiveIdx(-1)
      } catch {
        if (alive) setBadgeHits([])
      } finally {
        if (alive) setBadgeSearching(false)
      }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [badgeQ, picked])

  const pickSewadar = (hit) => {
    setPicked(hit)
    setBadgeHits([])
    setBadgeQ(hit.badge_number)
    setDropOpen(false)
    setActiveIdx(-1)
  }
  const clearPicked = () => {
    setPicked(null)
    setBadgeQ('')
    setBadgeHits([])
    setDropOpen(false)
    setActiveIdx(-1)
  }

  const genPassword = () => {
    try {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
      const bytes = crypto.getRandomValues(new Uint8Array(12))
      return [...bytes].map(b => alphabet[b % alphabet.length]).join('')
    } catch {
      return Math.random().toString(36).slice(2, 10) + 'A1'
    }
  }
  const [roleForm, setRoleForm] = useState({ id: null, name: '', base: 'centre_user', description: '' })
  const [roleSaving, setRoleSaving] = useState(false)

  const audit = useCallback(async (action, tableName, recordId, payload) => {
    try {
      const { error } = await supabase.from('audit_log').insert({
        action, table_name: tableName, record_id: recordId || null,
        schedule_id: null, payload: payload || {}, acted_by: profile?.name || null,
      })
      if (error) console.warn('audit_log write failed:', error.message)
    } catch (e) { console.warn('audit_log write failed:', e?.message) }
  }, [profile?.name])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [u, r, inv, c, scheds, depts, assigns] = await Promise.all([
        fetchAllRows('portal_users', '*', null, 'id'),
        fetchAllRows('custom_roles', '*', null, 'id'),
        fetchAllRows('portal_invitations', '*', null, 'id'),
        fetchCentres().catch(() => []),
        // v51: a dept_incharge is scoped by department for a schedule, so the
        // Users page needs both reference lists to render the picker.
        fetchAllRows('deployment_schedules', 'id, name, status', null, 'created_at').catch(() => []),
        fetchAllRows('deployment_departments', 'id, name', null, 'name').catch(() => []),
        fetchAllRows('department_incharge_assignments', '*', null, 'created_at').catch(() => []),
      ])
      setUsers(u || [])
      setCustomRoles(r || [])
      setInvites((inv || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
      setCentres((c || []).map(x => x.name || x).filter(Boolean).sort())
      setSchedules(scheds || [])
      setDepartments(depts || [])
      setAssignments(assigns || [])
    } catch (e) {
      setLoadError(e?.message || 'Could not load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime: an invite claimed (or a login touched) elsewhere refreshes us.
  useEffect(() => {
    const channel = supabase
      .channel('users-admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_users' }, () => load().catch(() => {}))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'custom_roles' }, () => load().catch(() => {}))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_invitations' }, () => load().catch(() => {}))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'department_incharge_assignments' }, () => load().catch(() => {}))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const customById = useMemo(() => {
    const m = {}
    customRoles.forEach(r => { m[r.id] = r })
    return m
  }, [customRoles])
  const roleName = useCallback((u) => {
    const custom = u.custom_role_id ? customById[u.custom_role_id] : null
    return custom ? custom.name : roleLabel(u.role)
  }, [customById])

  // v51: department id → name for the picker and the read-only summary.
  const deptName = useCallback((id) => departments.find(d => d.id === id)?.name || id || '—', [departments])

  // The departments a badge currently holds for a schedule — the existing grant
  // a create/edit form is editing, so the picker opens on the truth.
  const deptsForBadge = useCallback((badge, schedule) => {
    if (!badge || !schedule) return []
    return assignments.filter(a => a.badge_number === badge && a.schedule_id === schedule).map(a => a.department_id)
  }, [assignments])

  // Replace a badge's whole department grant for one schedule. Written as a
  // delete-then-insert rather than an upsert so REMOVING a department actually
  // sticks — the point of the picker is to be able to take one away.
  const saveAssignments = useCallback(async (schedule, badge, deptIds) => {
    const list = Array.isArray(deptIds) ? deptIds.filter(Boolean) : []
    if (!schedule || !badge) return
    const del = await supabase.from('department_incharge_assignments')
      .delete().eq('schedule_id', schedule).eq('badge_number', badge)
    if (del.error) throw del.error
    if (list.length === 0) return
    const { error } = await supabase.from('department_incharge_assignments').upsert(
      list.map(department_id => ({ schedule_id: schedule, department_id, badge_number: badge, assigned_by: 'users-page' })),
      { onConflict: 'schedule_id,department_id,badge_number' }
    )
    if (error) throw error
  }, [])
  const activeSupers = useMemo(
    () => users.filter(u => u.role === 'super_admin' && u.is_active !== false),
    [users]
  )
  const isSelf = useCallback((u) => {
    if (!u) return false
    if (profile?.auth_id && u.auth_id) return profile.auth_id === u.auth_id
    return String(profile?.email || '').toLowerCase() === String(u.email || '').toLowerCase()
  }, [profile?.auth_id, profile?.email])

  const stats = useMemo(() => {
    const active = users.filter(u => u.is_active !== false).length
    const now = Date.now()
    const pending = invites.filter(i => !i.claimed_at && new Date(i.expires_at).getTime() > now).length
    return { active, suspended: users.length - active, pending, roles: customRoles.length }
  }, [users, invites, customRoles])

  const filteredUsers = useMemo(() => {
    const term = q.trim().toLowerCase()
    return users
      .filter(u => roleFilter === 'all' || u.role === roleFilter)
      .filter(u => statusFilter === 'all' || (statusFilter === 'active' ? u.is_active !== false : u.is_active === false))
      .filter(u => !term || [u.name, u.email, u.badge_number, u.centre, roleName(u)].some(v => String(v || '').toLowerCase().includes(term)))
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  }, [users, q, roleFilter, statusFilter, roleName])

  const openEdit = (u) => {
    setEditUser(u)
    // v51: seed the department grant from what is actually written, so the
    // picker opens on the truth and removing a department is possible. Badge is
    // the join key, so a change of badge must NOT keep the old departments.
    const badge = u.badge_number || ''
    const seeded = u.role === 'dept_incharge' && badge
      ? deptsForBadge(badge, schedules[0]?.id)
      : []
    setEditForm({
      name: u.name || '',
      role: u.role,
      customId: u.custom_role_id || '',
      centre: u.centre || '',
      badge,
      deptSchedule: u.role === 'dept_incharge' ? (assignments.find(a => a.badge_number === badge)?.schedule_id || schedules[0]?.id || '') : '',
      deptIds: seeded,
    })
  }

  const saveUser = async () => {
    if (!editUser || !editForm || saving) return
    const name = editForm.name.trim()
    if (!name) { toast.error('Enter a name'); return }
    if (!SYSTEM_ROLES.includes(editForm.role)) { toast.error('Pick a valid role'); return }
    if (CENTRE_ROLES.includes(editForm.role) && !editForm.centre.trim()) { toast.error('Pick a centre for this role'); return }
    if (BADGE_ROLES.includes(editForm.role) && !editForm.badge.trim()) { toast.error('Enter a badge number for this role'); return }
    // v51: a dept_incharge with no department grant comes up with an empty
    // dashboard and an empty scan list, which reads as a broken app.
    if (editForm.role === 'dept_incharge') {
      if (!editForm.deptSchedule) { toast.error('Pick the schedule this department applies to'); return }
      if (!editForm.deptIds.length) { toast.error('Pick at least one department for this role'); return }
    }
    const custom = editForm.customId ? customById[editForm.customId] : null
    if (editForm.customId && (!custom || custom.base_role !== editForm.role)) { toast.error('That custom role belongs to a different base role'); return }
    // Last-super-admin guard: no change may leave zero active super_admins,
    // and you cannot demote/deactivate yourself into a lockout by accident.
    const demoting = editForm.role !== 'super_admin'
    const self = isSelf(editUser)
    if (editUser.role === 'super_admin' && demoting && activeSupers.length <= 1) {
      toast.error('Blocked: this is the last active admin login — promote someone else first')
      return
    }
    if (self && demoting) {
      setConfirm({
        title: 'Demote your own login?',
        body: `You will lose super-admin access immediately (server-enforced on every policy). ${activeSupers.length - 1} other admin login(s) will remain. Continue?`,
        confirmLabel: 'Demote me',
        danger: true,
        onConfirm: () => doSaveUser({ name, custom }),
      })
      return
    }
    doSaveUser({ name, custom })
  }

  const doSaveUser = async ({ name, custom }) => {
    setConfirm(null)
    setSaving(true)
    try {
      const payload = {
        name,
        role: editForm.role,
        custom_role_id: custom ? custom.id : null,
        centre: editForm.centre.trim() || null,
        badge_number: editForm.badge.trim() || null,
      }
      const { error } = await supabase.from('portal_users').update(payload).eq('id', editUser.id)
      if (error) { toast.error(error.message); return }
      // v51: replace the department grant for this badge + schedule. A role
      // change away from dept_incharge clears the grant entirely, otherwise a
      // promoted-to-something-else login would keep inheriting a dashboard.
      if (payload.role === 'dept_incharge' && editForm.deptSchedule && payload.badge_number) {
        await saveAssignments(editForm.deptSchedule, payload.badge_number, editForm.deptIds)
      } else if (editUser.role === 'dept_incharge' && editUser.badge_number) {
        // Leaving the role: drop the grant for every schedule it held.
        for (const s of schedules) {
          await saveAssignments(s.id, editUser.badge_number, [])
        }
      }
      await audit('UPDATE_USER', 'portal_users', editUser.id, { email: editUser.email, ...payload })
      toast.success('Login updated')
      setEditUser(null)
      setEditForm(null)
      load().catch(() => {})
    } finally {
      setSaving(false)
    }
  }

  const askToggleActive = (u, toActive) => {
    if (!toActive && u.role === 'super_admin' && activeSupers.length <= 1) {
      toast.error('Blocked: this is the last active admin login')
      return
    }
    if (isSelf(u) && !toActive) {
      setConfirm({
        title: 'Suspend your own login?',
        body: 'You will be locked out immediately on every policy (server-enforced). Continue?',
        confirmLabel: 'Suspend me',
        danger: true,
        onConfirm: () => doToggleActive(u, false),
      })
      return
    }
    setConfirm({
      title: toActive ? `Reinstate ${u.name || u.email}?` : `Suspend ${u.name || u.email}?`,
      body: toActive
        ? 'The login regains its role immediately on next request.'
        : 'Suspended logins fail every permission check server-side at once. Their data is kept.',
      confirmLabel: toActive ? 'Reinstate' : 'Suspend',
      danger: !toActive,
      onConfirm: () => doToggleActive(u, toActive),
    })
  }

  const doToggleActive = async (u, toActive) => {
    setConfirm(null)
    const { error } = await supabase.from('portal_users').update({ is_active: toActive }).eq('id', u.id)
    if (error) { toast.error(error.message); return }
    await audit(toActive ? 'REINSTATE_USER' : 'SUSPEND_USER', 'portal_users', u.id, { email: u.email, role: u.role })
    toast.success(toActive ? 'Login reinstated' : 'Login suspended')
    load().catch(() => {})
  }

  const sendReset = async (u) => {
    if (!u.email) { toast.error('No email on this login'); return }
    const { error } = await supabase.auth.resetPasswordForEmail(u.email.trim(), { redirectTo: window.location.origin })
    if (error) { toast.error(error.message); return }
    await audit('SEND_RESET_LINK', 'portal_users', u.id, { email: u.email })
    toast.success(`If an account exists for ${u.email}, a reset link is on its way`)
  }

  const createInvite = async () => {
    if (creating) return
    const form = {
      email: inviteForm.email.trim(),
      name: inviteForm.name.trim(),
      role: inviteForm.role,
      centre: inviteForm.centre.trim(),
      badge: inviteForm.badge.trim(),
      deptIds: inviteForm.deptIds,
    }
    const errs = invitationErrors(form)
    if (errs.length > 0) { toast.error(errs[0]); return }
    // v51: the department grant is per-schedule, so an invite for a dept_incharge
    // must also name WHICH schedule it is for — otherwise the claim trigger has
    // no schedule to write the assignment against.
    if (form.role === 'dept_incharge' && !inviteForm.deptSchedule) {
      toast.error('Pick the schedule this department applies to'); return
    }
    const custom = inviteForm.customId ? customById[inviteForm.customId] : null
    if (inviteForm.customId && (!custom || custom.base_role !== form.role)) { toast.error('That custom role belongs to a different base role'); return }
    if (invites.some(i => !i.claimed_at && String(i.email || '').toLowerCase() === form.email.toLowerCase())) {
      toast.error('An open invite already exists for this email — revoke it first')
      return
    }
    setCreating(true)
    try {
      const days = Math.max(1, Math.min(30, Number(inviteForm.days) || 7))
      const payload = {
        email: form.email,
        name: form.name,
        role: form.role,
        custom_role_id: custom ? custom.id : null,
        centre: form.centre || null,
        badge_number: form.badge || null,
        // v51: the grant travels WITH the invite; trg_grant_incharge_on_claim
        // turns it into department_incharge_assignments rows at claim time.
        schedule_id: form.role === 'dept_incharge' ? (inviteForm.deptSchedule || null) : null,
        dept_ids: form.role === 'dept_incharge' ? (form.deptIds.length ? form.deptIds : null) : null,
        code: inviteForm.code.trim().toUpperCase(),
        expires_at: new Date(Date.now() + days * 86400000).toISOString(),
        created_by: profile?.name || null,
      }
      let { error } = await supabase.from('portal_invitations').insert(payload)
      if (error && error.code === '23505') {
        // code collision (or a raced duplicate email) — mint a fresh code once
        payload.code = newCode()
        setInviteForm(f => ({ ...f, code: payload.code }))
        const retry = await supabase.from('portal_invitations').insert(payload)
        error = retry.error
      }
      if (error) { toast.error(error.message); return }
      await audit('CREATE_INVITE', 'portal_invitations', null, { email: payload.email, role: payload.role, centre: payload.centre })
      toast.success(`Invite created — share the code ${payload.code} with ${payload.name}`)
      setInviteForm({ name: '', email: '', role: 'centre_user', customId: '', centre: '', badge: '', deptSchedule: '', deptIds: [], days: '7', code: newCode() })
      load().catch(() => {})
    } finally {
      setCreating(false)
    }
  }

  const revokeInvite = (inv) => {
    setConfirm({
      title: 'Revoke this invite?',
      body: `${inv.email} will no longer be able to claim access with code ${inv.code}.`,
      confirmLabel: 'Revoke invite',
      danger: true,
      onConfirm: async () => {
        setConfirm(null)
        const { error } = await supabase.from('portal_invitations').delete().eq('id', inv.id)
        if (error) { toast.error(error.message); return }
        await audit('REVOKE_INVITE', 'portal_invitations', inv.id, { email: inv.email, role: inv.role })
        toast.success('Invite revoked')
        load().catch(() => {})
      },
    })
  }

  const copyText = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error('Copy failed — select and copy manually')
    }
  }

  // One-click create via the create-login Edge Function (deploy it once).
  // The auth account + portal login are created together; the password you
  // set here is final — share it with the person over a trusted channel.
  const createLoginDirect = async () => {
    if (directBusy) return
    if (!picked) { toast.error('Search a badge number above and pick the sewadar first'); return }
    const email = directForm.email.trim()
    const password = directForm.password
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error('Enter a valid email address'); return }
    if (!password || password.length < 8) { toast.error('Set a password of at least 8 characters'); return }
    if (!INVITE_ROLES.includes(directForm.role)) { toast.error('Pick a valid role'); return }
    const custom = directForm.customId ? customById[directForm.customId] : null
    if (directForm.customId && (!custom || custom.base_role !== directForm.role)) { toast.error('That custom role belongs to a different base role'); return }
    if (users.some(u => String(u.email || '').toLowerCase() === email.toLowerCase() && u.is_active !== false)) {
      toast.error('An active login already exists for this email'); return
    }
    // v51: a dept_incharge needs a department grant, or the login comes up
    // with an empty dashboard and an empty scan list. The Edge Function writes
    // the assignment rows (it holds the service role, which RLS requires).
    if (directForm.role === 'dept_incharge') {
      if (!directForm.deptSchedule) { toast.error('Pick the schedule this department applies to'); return }
      if (!directForm.deptIds.length) { toast.error('Pick at least one department for this role'); return }
    }
    setDirectBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('create-login', {
        body: {
          email,
          name: picked.sewadar_name,
          role: directForm.role,
          custom_role_id: custom ? custom.id : null,
          centre: INVITE_CENTRE_ROLES.includes(directForm.role) ? picked.centre : null,
          badge_number: picked.badge_number,
          password,
          // v51: the department grant, applied by the function in one
          // privileged transaction. The OLD deployed function ignores these two
          // fields, so the same write is ALSO attempted client-side below and
          // verified — a redeploy must never be a silent prerequisite.
          dept_schedule_id: directForm.role === 'dept_incharge' ? (directForm.deptSchedule || null) : null,
          dept_ids: directForm.role === 'dept_incharge' ? (directForm.deptIds.length ? directForm.deptIds : null) : null,
        },
      })
      if (error) {
        const msg = String(error.message || '')
        if (/not found|Failed to fetch|404|TypeError/i.test(msg)) {
          toast.error('Cannot reach the login service — check it is deployed AND its JWT verification is off (details in supabase/functions/create-login/index.ts)')
        } else {
          toast.error(msg || 'Could not create login')
        }
        return
      }
      if (data?.error) { toast.error(data.error); return }
      // v51: the grant must exist, whichever function build is deployed. Write it
      // here too (a super_admin session passes the RLS write policy) and then
      // VERIFY, because an undeployed-or-older function silently ignores the
      // field and would otherwise leave a dept_incharge with an empty dashboard
      // and an empty scan list that reads as a broken app.
      let grantOk = true
      if (directForm.role === 'dept_incharge') {
        try {
          await saveAssignments(directForm.deptSchedule, picked.badge_number, directForm.deptIds)
          const { data: check, error: checkErr } = await supabase
            .from('department_incharge_assignments')
            .select('department_id')
            .eq('schedule_id', directForm.deptSchedule)
            .eq('badge_number', picked.badge_number)
          if (checkErr) throw new Error(checkErr.message)
          grantOk = Array.isArray(check) && check.length > 0
        } catch (e) {
          console.warn('[create-login] department grant failed:', e?.message)
          grantOk = false
        }
      }
      await audit('CREATE_LOGIN', 'portal_users', null, { email, role: directForm.role, badge: picked.badge_number })
      if (!grantOk) {
        // The login EXISTS — do not imply otherwise. Say exactly what is broken.
        toast.error(
          'Login created, but the department grant did not apply — that login will see an empty dashboard. Check that sql/v51_dept_incharge_department_scope.sql has been run, then re-apply the department from this page’s Edit dialog.'
        )
      } else if (data?.tempPassword) {
        // Older deployed function that ignored our password and generated one.
        setCreatedCred({ email, tempPassword: data.tempPassword })
      } else {
        toast.success(`Login created for ${picked.sewadar_name} — they can sign in now`)
      }
      clearPicked()
      setDirectForm({ email: '', role: 'centre_user', customId: '', password: '', showPw: false, deptSchedule: '', deptIds: [] })
      load().catch(() => {})
    } catch (e) {
      toast.error(e?.message || 'Could not create login')
    } finally {
      setDirectBusy(false)
    }
  }

  const saveRole = async () => {
    if (roleSaving) return
    const name = roleForm.name.trim()
    if (name.length < 3) { toast.error('Role name needs at least 3 characters'); return }
    if (!SYSTEM_ROLES.includes(roleForm.base)) { toast.error('Pick a valid base role'); return }
    const dupe = customRoles.some(r => r.id !== roleForm.id && String(r.name || '').toLowerCase() === name.toLowerCase())
    if (dupe) { toast.error('A role with this name already exists'); return }
    setRoleSaving(true)
    try {
      const payload = { name, base_role: roleForm.base, description: roleForm.description.trim(), created_by: profile?.name || null }
      let error, rowId = roleForm.id
      if (roleForm.id) {
        const res = await supabase.from('custom_roles').update(payload).eq('id', roleForm.id)
        error = res.error
      } else {
        const res = await supabase.from('custom_roles').insert(payload).select('id').single()
        error = res.error
        rowId = res.data?.id || null
      }
      if (error) { toast.error(error.message); return }
      await audit(roleForm.id ? 'UPDATE_ROLE' : 'CREATE_ROLE', 'custom_roles', rowId, { name, base: payload.base_role })
      toast.success(roleForm.id ? 'Role updated — enforcement follows the base role at once' : 'Role created')
      setRoleForm({ id: null, name: '', base: 'centre_user', description: '' })
      load().catch(() => {})
    } finally {
      setRoleSaving(false)
    }
  }

  const deleteRole = (r) => {
    const inUse = users.filter(u => u.custom_role_id === r.id).length
    if (inUse > 0) {
      toast.error(`Blocked: ${inUse} login(s) still use this role — reassign them first`)
      return
    }
    setConfirm({
      title: `Delete role “${r.name}”?`,
      body: 'The base permissions disappear with it. This cannot be undone.',
      confirmLabel: 'Delete role',
      danger: true,
      onConfirm: async () => {
        setConfirm(null)
        const { error } = await supabase.from('custom_roles').delete().eq('id', r.id)
        if (error) { toast.error(error.message); return }
        await audit('DELETE_ROLE', 'custom_roles', r.id, { name: r.name, base: r.base_role })
        toast.success('Role deleted')
        if (roleForm.id === r.id) setRoleForm({ id: null, name: '', base: 'centre_user', description: '' })
        load().catch(() => {})
      },
    })
  }

  const now = Date.now()
  const pendingInvites = invites.filter(i => !i.claimed_at && new Date(i.expires_at).getTime() > now)
  const expiredInvites = invites.filter(i => !i.claimed_at && new Date(i.expires_at).getTime() <= now)
  const claimedInvites = invites.filter(i => i.claimed_at)

  if (loading) {
    return (
      <div className="page"><div className="card"><div className="skeleton" style={{ height: 56, borderRadius: 10 }} /><div className="skeleton" style={{ height: 120, borderRadius: 10, marginTop: '0.6rem' }} /></div></div>
    )
  }
  if (loadError) {
    return (
      <div className="page"><div className="card"><div className="empty">
        <div className="empty-title">Could not load users</div>
        <div className="empty-text">{loadError}</div>
        <button onClick={() => { setLoading(true); load() }} className="btn btn-primary" style={{ marginTop: '0.75rem' }}><RefreshCw size={14} /> Retry</button>
      </div></div></div>
    )
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title"><Users size={22} /> Users</h2>
          <div className="page-sub">Logins, invites and roles. Enforcement always follows the base role server-side — this page only assigns it.</div>
        </div>
      </div>

      <div className="stat-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="stat"><div className="stat-label">Active logins</div><div className="stat-value">{stats.active}</div><div className="stat-sub">can sign in now</div></div>
        <div className="stat"><div className="stat-label">Suspended</div><div className="stat-value" style={{ color: stats.suspended ? '#b91c1c' : undefined }}>{stats.suspended}</div><div className="stat-sub">locked out server-side</div></div>
        <div className="stat"><div className="stat-label">Pending invites</div><div className="stat-value">{stats.pending}</div><div className="stat-sub">unclaimed + unexpired</div></div>
        <div className="stat"><div className="stat-label">Custom roles</div><div className="stat-value">{stats.roles}</div><div className="stat-sub">named base-role aliases</div></div>
      </div>

      {/* ── Logins ── */}
      <PanelCard
        title="Logins"
        icon={Users}
        sub="Edit role, centre, badge and name. Suspend locks out at once on every policy; nothing is ever deleted."
        action={(
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '0.55rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name / email / badge…" aria-label="Search logins" style={{ ...inputStyle, paddingLeft: '1.9rem', width: 230 }} />
            </div>
            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="select" aria-label="Filter by role" style={{ fontSize: '0.8rem' }}>
              <option value="all">All roles</option>
              {SYSTEM_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="select" aria-label="Filter by status" style={{ fontSize: '0.8rem' }}>
              <option value="all">Active + suspended</option>
              <option value="active">Active only</option>
              <option value="suspended">Suspended only</option>
            </select>
          </div>
        )}
      >
        {filteredUsers.length === 0 ? (
          <div className="empty"><div className="empty-text">No logins match these filters.</div></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Name</th>
                  <th>Email</th>
                  <th style={{ textAlign: 'center' }}>Role</th>
                  <th>Centre</th>
                  <th style={{ textAlign: 'center' }}>Badge</th>
                  <th>Departments (v51)</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map(u => {
                  const active = u.is_active !== false
                  const custom = u.custom_role_id ? customById[u.custom_role_id] : null
                  const self = isSelf(u)
                  return (
                    <tr key={u.id} style={!active ? { opacity: 0.65 } : undefined}>
                      <td data-label="Name" style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1, fontWeight: 600 }}>
                        {u.name || '—'}{self && <span className="pill pill-blue" style={{ marginLeft: '0.4rem', fontSize: '0.62rem' }}>you</span>}
                      </td>
                      <td data-label="Email" style={{ fontSize: '0.8rem', color: '#475569' }}>{u.email || '—'}</td>
                      <td data-label="Role" style={{ textAlign: 'center' }}>
                        <span className="pill" style={{ background: ROLE_COLORS[u.role] ? `${ROLE_COLORS[u.role]}1a` : '#f1f5f9', color: ROLE_COLORS[u.role] || '#64748b', fontWeight: 700 }}>
                          {custom ? custom.name : roleLabel(u.role)}
                        </span>
                        {custom && <div style={{ fontSize: '0.65rem', color: '#94a3b8', marginTop: '0.15rem' }}>{roleLabel(custom.base_role)}</div>}
                        {u.role === 'super_admin' && <span className="pill pill-red" style={{ marginLeft: '0.35rem', fontSize: '0.6rem' }}>ADMIN</span>}
                      </td>
                      <td data-label="Centre">{u.centre || '—'}</td>
                      <td data-label="Badge" style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: '0.8rem' }}>{u.badge_number || '—'}</td>
                      <td data-label="Departments" style={{ fontSize: '0.75rem' }}>
                        {u.role === 'dept_incharge'
                          ? (() => {
                              const held = assignments.filter(a => a.badge_number === u.badge_number)
                              if (!held.length) return <span style={{ color: '#b45309', fontWeight: 600 }}>none assigned</span>
                              return held.map(a => (
                                <span key={a.id} className="pill pill-indigo" style={{ marginRight: '0.25rem', fontSize: '0.66rem' }}>
                                  {deptName(a.department_id)}
                                </span>
                              ))
                            })()
                          : <span style={{ color: '#94a3b8' }}>—</span>}
                      </td>
                      <td data-label="Status" style={{ textAlign: 'center' }}>
                        <span className={`pill ${active ? 'pill-green' : 'pill-red'}`}>{active ? 'Active' : 'Suspended'}</span>
                      </td>
                      <td data-label="Actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => openEdit(u)} className="btn btn-ghost" style={smallBtn} title="Edit login"><Pencil size={13} /> Edit</button>{' '}
                        <button onClick={() => sendReset(u)} className="btn btn-ghost" style={smallBtn} title="Email a password-reset link"><KeyRound size={13} /> Reset PW</button>{' '}
                        {active
                          ? <button onClick={() => askToggleActive(u, false)} className="btn btn-ghost" style={{ ...smallBtn, color: '#b91c1c' }} title="Suspend login"><Ban size={13} /> Suspend</button>
                          : <button onClick={() => askToggleActive(u, true)} className="btn btn-ghost" style={{ ...smallBtn, color: '#15803d' }} title="Reinstate login"><CheckCircle2 size={13} /> Reinstate</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>

      {/* ── Create login directly (no invite round-trip) ── */}
      <PanelCard
        title="Create login"
        icon={KeyRound}
        sub="Search by badge number or name, pick the sewadar, set the role and the password — the login is created at once. Needs the login service deployed once (see bottom)."
      >
        <div style={{ maxWidth: 460, position: 'relative' }}>
          <label style={labelStyle}>Search badge number or name</label>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input
              value={badgeQ}
              onChange={e => { const v = e.target.value; setBadgeQ(v); setDropOpen(true); if (picked && v !== picked.badge_number) setPicked(null); setActiveIdx(-1) }}
              onKeyDown={e => {
                if (e.key === 'Escape') { setBadgeHits([]); setActiveIdx(-1); setDropOpen(false) }
                else if (e.key === 'ArrowDown' && badgeHits.length > 0) { e.preventDefault(); setActiveIdx(i => (i + 1) % badgeHits.length) }
                else if (e.key === 'ArrowUp' && badgeHits.length > 0) { e.preventDefault(); setActiveIdx(i => (i <= 0 ? badgeHits.length - 1 : i - 1)) }
                else if (e.key === 'Enter' && badgeHits.length > 0) { e.preventDefault(); pickSewadar(badgeHits[activeIdx >= 0 ? activeIdx : 0]) }
              }}
              placeholder="Badge or name, at least 2 characters…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search sewadar by badge number or name"
              aria-expanded={badgeHits.length > 0}
              aria-controls="badge-results"
              aria-activedescendant={activeIdx >= 0 && badgeHits[activeIdx] ? `badge-opt-${activeIdx}` : undefined}
              role="combobox"
              aria-autocomplete="list"
              style={{ ...inputStyle, paddingLeft: '2rem' }}
            />
          </div>
          {(badgeSearching || badgeHits.length > 0 || (dropOpen && badgeQ.trim().length >= 2 && !badgeSearching)) && (
            <div id="badge-results" role="listbox" aria-label="Matching sewadars" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.14)', zIndex: 30, overflow: 'hidden', maxHeight: 320, overflowY: 'auto' }}>
              {badgeSearching && <div style={{ padding: '0.6rem 0.8rem', fontSize: '0.8rem', color: '#94a3b8' }}>Searching…</div>}
              {!badgeSearching && badgeHits.length === 0 && (
                <div style={{ padding: '0.75rem 0.9rem' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>No sewadar found for “{badgeQ.trim()}”.</div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.2rem' }}>Check the spelling — logins can only be created for sewadars already in the master. New sewadars join via the Consent &amp; Deploy page first.</div>
                </div>
              )}
              {!badgeSearching && badgeHits.map((h, i) => (
                <button
                  key={`${h.is_vss ? 'V' : 'R'}|${h.centre}|${h.badge_number}`}
                  id={`badge-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  onClick={() => pickSewadar(h)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', width: '100%', padding: '0.55rem 0.8rem', border: 0, background: i === activeIdx ? '#eef2ff' : 'none', cursor: 'pointer', textAlign: 'left', fontSize: '0.85rem' }}
                >
                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{hi(h.badge_number, badgeQ)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hi(h.sewadar_name, badgeQ)}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#64748b', flexShrink: 0 }}>{h.centre}</span>
                  {h.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {picked && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.55rem', marginTop: '0.75rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '0.5rem 0.6rem 0.5rem 0.75rem', fontSize: '0.85rem' }}>
            <CheckCircle2 size={16} style={{ color: '#15803d', flexShrink: 0 }} />
            <span style={{ fontWeight: 800 }}>{picked.sewadar_name}</span>
            <span style={{ fontFamily: 'monospace', color: '#475569' }}>{picked.badge_number}</span>
            <span style={{ color: '#64748b', fontSize: '0.78rem' }}>{picked.centre}</span>
            {picked.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
            <button onClick={clearPicked} className="btn btn-ghost" style={{ ...smallBtn, marginLeft: "0.25rem" }}>Change</button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.6rem', marginTop: '0.75rem' }}>
          <div><label style={labelStyle}>Login email</label><input value={directForm.email} onChange={e => setDirectForm(f => ({ ...f, email: e.target.value }))} placeholder="login@example.com" autoComplete="off" style={inputStyle} /></div>
          <div><label style={labelStyle}>Role (permissions)</label>
            <select value={directForm.role} onChange={e => setDirectForm(f => ({ ...f, role: e.target.value, customId: '', deptSchedule: '', deptIds: [] }))} className="select" style={{ width: '100%' }}>
              {INVITE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>
          <DeptAssignFields
            role={directForm.role} schedules={schedules} departments={departments}
            schedule={directForm.deptSchedule} deptIds={directForm.deptIds}
            onSchedule={v => setDirectForm(f => ({ ...f, deptSchedule: v }))}
            onDepts={v => setDirectForm(f => ({ ...f, deptIds: v }))}
            required
          />
          <div><label style={labelStyle}>Custom role (optional)</label>
            <select value={directForm.customId} onChange={e => setDirectForm(f => ({ ...f, customId: e.target.value }))} className="select" style={{ width: '100%' }}>
              <option value="">— system role as-is —</option>
              {customRoles.filter(r => r.base_role === directForm.role).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Password (min 8 characters)</label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input
                type={directForm.showPw ? 'text' : 'password'}
                value={directForm.password}
                onChange={e => setDirectForm(f => ({ ...f, password: e.target.value }))}
                placeholder="Set a password"
                autoComplete="new-password"
                style={{ ...inputStyle, fontFamily: directForm.showPw ? 'monospace' : undefined }}
              />
              <button onClick={() => setDirectForm(f => ({ ...f, showPw: !f.showPw }))} className="btn btn-ghost" style={smallBtn} title={directForm.showPw ? 'Hide password' : 'Show password'} aria-label={directForm.showPw ? 'Hide password' : 'Show password'}>
                {directForm.showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button onClick={() => setDirectForm(f => ({ ...f, password: genPassword(), showPw: true }))} className="btn btn-ghost" style={smallBtn} title="Generate a strong password">Generate</button>
            </div>
          </div>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <button onClick={createLoginDirect} disabled={directBusy} className="btn btn-primary"><UserPlus size={14} /> {directBusy ? 'Creating…' : 'Create login'}</button>
        </div>
      </PanelCard>

      {/* ── Invitations ── */}
      <PanelCard
        title="Invitations"
        icon={UserPlus}
        sub="Issue a code; the invitee signs in, pastes it on the denied screen, and the server links the login. Codes are single-use and bound to the invited email."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginBottom: '1rem' }}>
          <div><label style={labelStyle}>Name</label><input value={inviteForm.name} onChange={e => setInviteForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name" style={inputStyle} /></div>
          <div><label style={labelStyle}>Email</label><input value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))} placeholder="name@example.com" autoComplete="off" style={inputStyle} /></div>
          <div><label style={labelStyle}>Role (permissions)</label>
            <select value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value, customId: '' }))} className="select" style={{ width: '100%' }}>
              {INVITE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Custom role (optional)</label>
            <select value={inviteForm.customId} onChange={e => setInviteForm(f => ({ ...f, customId: e.target.value }))} className="select" style={{ width: '100%' }}>
              <option value="">— system role as-is —</option>
              {customRoles.filter(r => r.base_role === inviteForm.role).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Centre{['centre_user', 'centre_admin'].includes(inviteForm.role) ? ' *' : ''}</label>
            <select value={inviteForm.centre} onChange={e => setInviteForm(f => ({ ...f, centre: e.target.value }))} className="select" style={{ width: '100%' }}>
              <option value="">—</option>
              {centres.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Badge{['dept_incharge', 'scanner'].includes(inviteForm.role) ? ' *' : ''}</label><input value={inviteForm.badge} onChange={e => setInviteForm(f => ({ ...f, badge: e.target.value }))} placeholder="FB… / SC…" style={{ ...inputStyle, fontFamily: 'monospace' }} /></div>
          <DeptAssignFields
            role={inviteForm.role} schedules={schedules} departments={departments}
            schedule={inviteForm.deptSchedule} deptIds={inviteForm.deptIds}
            onSchedule={v => setInviteForm(f => ({ ...f, deptSchedule: v }))}
            onDepts={v => setInviteForm(f => ({ ...f, deptIds: v }))}
            required
          />
          <div><label style={labelStyle}>Valid for</label>
            <select value={inviteForm.days} onChange={e => setInviteForm(f => ({ ...f, days: e.target.value }))} className="select" style={{ width: '100%' }}>
              {[['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Code</label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input value={inviteForm.code} onChange={e => setInviteForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} style={{ ...inputStyle, fontFamily: 'monospace' }} maxLength={16} />
              <button onClick={() => setInviteForm(f => ({ ...f, code: newCode() }))} className="btn btn-ghost" style={smallBtn} title="Generate a fresh code"><RefreshCw size={13} /></button>
            </div>
          </div>
        </div>
        <button onClick={createInvite} disabled={creating} className="btn btn-primary"><UserPlus size={14} /> {creating ? 'Creating…' : 'Create invite'}</button>

        <div className="section-title" style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.85rem' }}>Open invites ({pendingInvites.length})</div>
        {pendingInvites.length === 0 ? (
          <div className="empty"><div className="empty-text">No open invites.</div></div>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Email</th><th style={{ textAlign: 'center' }}>Role</th><th style={{ textAlign: 'center' }}>Code</th><th style={{ textAlign: 'center' }}>Expires</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {pendingInvites.map(inv => {
                const custom = inv.custom_role_id ? customById[inv.custom_role_id] : null
                const daysLeft = Math.max(0, Math.ceil((new Date(inv.expires_at).getTime() - now) / 86400000))
                return (
                  <tr key={inv.id}>
                    <td data-label="Name" style={{ fontWeight: 600 }}>{inv.name || '—'}</td>
                    <td data-label="Email" style={{ fontSize: '0.8rem', color: '#475569' }}>{inv.email}</td>
                    <td data-label="Role" style={{ textAlign: 'center' }}>{custom ? custom.name : roleLabel(inv.role)}</td>
                    <td data-label="Code" style={{ textAlign: 'center', fontFamily: 'monospace', fontWeight: 700 }}>{inv.code}</td>
                    <td data-label="Expires" style={{ textAlign: 'center', fontSize: '0.8rem' }}>{daysLeft}d left</td>
                    <td data-label="Actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => copyText(inv.code, 'Invite code')} className="btn btn-ghost" style={smallBtn}><Copy size={13} /> Copy</button>{' '}
                      <button onClick={() => revokeInvite(inv)} className="btn btn-ghost" style={{ ...smallBtn, color: '#b91c1c' }}><Trash2 size={13} /> Revoke</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
        {expiredInvites.length > 0 && (
          <>
            <div className="section-title" style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.85rem' }}>Expired ({expiredInvites.length})</div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Email</th><th style={{ textAlign: 'center' }}>Role</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {expiredInvites.map(inv => (
                  <tr key={inv.id} style={{ opacity: 0.65 }}>
                    <td data-label="Name" style={{ fontWeight: 600 }}>{inv.name || '—'}</td>
                    <td data-label="Email" style={{ fontSize: '0.8rem', color: '#475569' }}>{inv.email}</td>
                    <td data-label="Role" style={{ textAlign: 'center' }}>{inv.custom_role_id && customById[inv.custom_role_id] ? customById[inv.custom_role_id].name : roleLabel(inv.role)}</td>
                    <td data-label="Actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => revokeInvite(inv)} className="btn btn-ghost" style={{ ...smallBtn, color: '#b91c1c' }}><Trash2 size={13} /> Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
        {claimedInvites.length > 0 && (
          <>
            <div className="section-title" style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.85rem' }}>Recently joined ({claimedInvites.length})</div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Email</th><th style={{ textAlign: 'center' }}>Role</th><th style={{ textAlign: 'center' }}>Joined</th></tr></thead>
              <tbody>
                {claimedInvites.slice(0, 25).map(inv => (
                  <tr key={inv.id}>
                    <td data-label="Name" style={{ fontWeight: 600 }}>{inv.name || '—'}</td>
                    <td data-label="Email" style={{ fontSize: '0.8rem', color: '#475569' }}>{inv.email}</td>
                    <td data-label="Role" style={{ textAlign: 'center' }}>{inv.custom_role_id && customById[inv.custom_role_id] ? customById[inv.custom_role_id].name : roleLabel(inv.role)}</td>
                    <td data-label="Joined" style={{ textAlign: 'center', fontSize: '0.8rem' }}>{inv.claimed_at ? new Date(inv.claimed_at).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </PanelCard>

      {/* ── Custom roles ── */}
      <PanelCard
        title="Custom roles"
        icon={Tag}
        sub="Named aliases onto a base role. Enforcement follows the base everywhere — a custom role can label access, never widen it."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginBottom: '0.75rem' }}>
          <div><label style={labelStyle}>Role name</label><input value={roleForm.name} onChange={e => setRoleForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Night Scanner" style={inputStyle} /></div>
          <div><label style={labelStyle}>Base role (permissions)</label>
            <select value={roleForm.base} onChange={e => setRoleForm(f => ({ ...f, base: e.target.value }))} className="select" style={{ width: '100%' }}>
              {SYSTEM_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Description</label><input value={roleForm.description} onChange={e => setRoleForm(f => ({ ...f, description: e.target.value }))} placeholder="What is this role for?" style={inputStyle} /></div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={saveRole} disabled={roleSaving} className="btn btn-primary">{roleForm.id ? 'Save role' : 'Create role'}</button>
          {roleForm.id && <button onClick={() => setRoleForm({ id: null, name: '', base: 'centre_user', description: '' })} className="btn btn-ghost"><X size={13} /> Cancel</button>}
        </div>
        {customRoles.length > 0 && (
          <div className="table-wrap" style={{ marginTop: '0.75rem' }}><table className="table">
            <thead><tr><th>Name</th><th style={{ textAlign: 'center' }}>Base role</th><th>Description</th><th style={{ textAlign: 'center' }}>In use</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {customRoles.map(r => {
                const inUse = users.filter(u => u.custom_role_id === r.id).length
                return (
                  <tr key={r.id}>
                    <td data-label="Name" style={{ fontWeight: 700 }}>{r.name}</td>
                    <td data-label="Base role" style={{ textAlign: 'center' }}><span className="pill pill-blue">{roleLabel(r.base_role)}</span></td>
                    <td data-label="Description" style={{ fontSize: '0.8rem', color: '#475569' }}>{r.description || '—'}</td>
                    <td data-label="In use" style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{inUse}</td>
                    <td data-label="Actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => setRoleForm({ id: r.id, name: r.name, base: r.base_role, description: r.description || '' })} className="btn btn-ghost" style={smallBtn}><Pencil size={13} /> Edit</button>{' '}
                      <button onClick={() => deleteRole(r)} className="btn btn-ghost" style={{ ...smallBtn, color: '#b91c1c' }}><Trash2 size={13} /> Delete</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </PanelCard>

      {/* ── Permission matrix ── */}
      <PanelCard
        title="What each role can open"
        icon={ShieldCheck}
        sub="Derived live from the app's page registry — the same list that draws the navbar. Server enforcement (RLS) mirrors it; custom roles inherit their base row."
      >
        <div className="table-wrap"><table className="table">
          <thead><tr><th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Role</th>{Object.entries(PAGES).map(([pk, p]) => <th key={pk} style={{ textAlign: 'center', fontSize: '0.68rem' }}>{p.label}</th>)}</tr></thead>
          <tbody>
            {SYSTEM_ROLES.map(r => (
              <tr key={r}>
                <td data-label="Role" style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1, fontWeight: 700, fontSize: '0.8rem' }}>{roleLabel(r)}</td>
                {/* Keyed by the page KEY, not its label: v51 added a second page
                    labelled "Dashboard" (the dept_incharge landing), and two
                    PAGES sharing a label collided as React children. */}
                {Object.entries(PAGES).map(([pk, p]) => (
                  <td key={pk} data-label={p.label} style={{ textAlign: 'center', color: p.roles.includes(r) ? '#15803d' : '#e2e8f0', fontWeight: 700 }}>
                    {p.roles.includes(r) ? '●' : '·'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table></div>
      </PanelCard>

      {/* ── Temporary credentials (shown once — never stored) ── */}
      {createdCred && (
        <div className="modal-overlay" onClick={() => setCreatedCred(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h4 style={{ margin: '0 0 0.5rem' }}>Login created</h4>
            <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
              Share this password with <strong>{createdCred.email}</strong> once, over a trusted channel —
              it is never shown again. Ask them to change it via Forgot password after first sign-in.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
              <code style={{ flex: 1, padding: '0.6rem 0.75rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.95rem', letterSpacing: '0.03em' }}>{createdCred.tempPassword}</code>
              <button onClick={() => copyText(createdCred.tempPassword, 'Temporary password')} className="btn btn-ghost" style={smallBtn}><Copy size={13} /> Copy</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button onClick={() => setCreatedCred(null)} className="btn btn-primary">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit modal ── */}
      {editUser && editForm && (
        <div className="modal-overlay" onClick={() => { setEditUser(null); setEditForm(null) }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h4 style={{ margin: '0 0 0.25rem' }}>Edit login</h4>
            <p style={{ color: '#64748b', fontSize: '0.82rem', margin: '0 0 1rem' }}>{editUser.email || '—'}</p>
            <div style={{ display: 'grid', gap: '0.7rem' }}>
              <div><label style={labelStyle}>Name</label><input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} /></div>
              <div><label style={labelStyle}>Role (permissions)</label>
                <select value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value, customId: '' }))} className="select" style={{ width: '100%' }}>
                  {SYSTEM_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>
              <div><label style={labelStyle}>Custom role (optional)</label>
                <select value={editForm.customId} onChange={e => setEditForm(f => ({ ...f, customId: e.target.value }))} className="select" style={{ width: '100%' }}>
                  <option value="">— system role as-is —</option>
                  {customRoles.filter(r => r.base_role === editForm.role).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <div><label style={labelStyle}>Centre</label>
                  <select value={editForm.centre} onChange={e => setEditForm(f => ({ ...f, centre: e.target.value }))} className="select" style={{ width: '100%' }}>
                    <option value="">—</option>
                    {centres.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div><label style={labelStyle}>Badge</label><input value={editForm.badge} onChange={e => setEditForm(f => ({ ...f, badge: e.target.value, deptIds: [] }))} style={{ ...inputStyle, fontFamily: 'monospace' }} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.7rem' }}>
                <DeptAssignFields
                  role={editForm.role} schedules={schedules} departments={departments}
                  schedule={editForm.deptSchedule} deptIds={editForm.deptIds}
                  onSchedule={v => setEditForm(f => ({ ...f, deptSchedule: v, deptIds: [] }))}
                  onDepts={v => setEditForm(f => ({ ...f, deptIds: v }))}
                  required
                />
                {editForm.role === 'dept_incharge' && editUser?.badge_number && (
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    Currently held: {(() => {
                      const held = assignments.filter(a => a.badge_number === editUser.badge_number)
                      if (!held.length) return <em>none</em>
                      return held.map(a => (
                        <span key={a.id} style={{ marginRight: '0.4rem' }}>
                          {schedules.find(s => s.id === a.schedule_id)?.name || a.schedule_id} → <strong>{deptName(a.department_id)}</strong>
                        </span>
                      ))
                    })()}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button onClick={() => { setEditUser(null); setEditForm(null) }} className="btn">Cancel</button>
              <button onClick={saveUser} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save login'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm modal ── */}
      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h4 style={{ margin: '0 0 0.5rem' }}>{confirm.title}</h4>
            <p style={{ color: '#64748b', fontSize: '0.85rem' }}>{confirm.body}</p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button onClick={() => setConfirm(null)} className="btn">Cancel</button>
              <button onClick={confirm.onConfirm} className="btn btn-primary" style={confirm.danger ? { background: '#b91c1c' } : undefined}>{confirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
