import { useEffect, useRef } from 'react'
import { X, KeyRound, LogOut, Ban, Archive, RotateCcw, Trash2, ShieldCheck } from 'lucide-react'
import { userPhaseGroup, statusOf } from '../lib/userAdmin'
import { ROLE_LABELS } from '../lib/supabase'

/**
 * UserDetailDrawer — slide-in panel showing a portal user's full identity,
 * auth metadata, department grants, and audit trail, plus admin action buttons.
 *
 * Read-only except for the action buttons, which delegate to the parent via
 * on* callbacks. The parent owns all mutation logic and passes `busy` to
 * disable actions while a request is in flight.
 *
 * @param {object} props
 * @param {object|null} props.user — the portal user row (null = closed)
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {object} [props.meta] — auth metadata (created_at, last_login, etc.)
 * @param {Array<{id:string, department_id:string, schedule_id:string}>} [props.deptGrants]
 * @param {Array<{id:string, action:string, created_at:string, detail?:string}>} [props.auditRows]
 * @param {(user:object) => void} [props.onSetPassword]
 * @param {(user:object) => void} [props.onSignOutAll]
 * @param {(user:object) => void} [props.onSuspend]
 * @param {(user:object) => void} [props.onArchive]
 * @param {(user:object) => void} [props.onRestore]
 * @param {(user:object) => void} [props.onDelete]
 * @param {boolean} [props.busy] — disables all action buttons when true
 */
export default function UserDetailDrawer({
  user,
  open,
  onClose,
  meta = {},
  deptGrants = [],
  auditRows = [],
  onSetPassword,
  onSignOutAll,
  onSuspend,
  onArchive,
  onRestore,
  onDelete,
  busy = false,
}) {
  const drawerRef = useRef(null)
  const closeRef = useRef(null)

  // Focus the close button on open; restore focus on close.
  useEffect(() => {
    if (!open) return undefined
    const prev = document.activeElement
    const t = setTimeout(() => {
      closeRef.current?.focus({ preventScroll: true })
    }, 60)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      try { prev?.focus?.({ preventScroll: true }) } catch { /* ignore */ }
    }
  }, [open, onClose])

  if (!open || !user) return null

  const status = statusOf(user)
  const phaseGroup = userPhaseGroup(user.role)
  const roleLabel = ROLE_LABELS[user.role] || user.role
  const isSuspended = status === 'suspended'
  const isArchived = status === 'archived'

  const actionBtn = 'btn'
  const actionStyle = { fontSize: '0.78rem', padding: '0.4rem 0.7rem' }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`User details for ${user.name || user.email}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="user-group-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em' }}>
              {user.name || '—'}
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {user.email || '—'}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost"
            aria-label="Close user details"
            onClick={onClose}
            style={{ padding: '0.35rem' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="drawer-body">
          {/* ── Identity ── */}
          <section aria-label="Identity">
            <div className="drawer-section-title">Identity</div>
            <dl className="drawer-grid">
              <dt>Role</dt>
              <dd>
                <span className="pill pill-blue" style={{ fontSize: '0.72rem' }}>
                  <ShieldCheck size={11} style={{ marginRight: 3, verticalAlign: '-1px' }} />
                  {roleLabel}
                </span>
              </dd>
              <dt>Badge</dt>
              <dd className="mono">{user.badge_number || '—'}</dd>
              <dt>Centre</dt>
              <dd>{user.centre || '—'}</dd>
              {user.sewadar_name && (
                <>
                  <dt>Sewadar</dt>
                  <dd>{user.sewadar_name}</dd>
                </>
              )}
            </dl>
          </section>

          {/* ── Status & Phase ── */}
          <section aria-label="Status">
            <div className="drawer-section-title">Status</div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span
                className={`pill ${isArchived ? 'pill-gray' : isSuspended ? 'pill-red' : 'pill-green'}`}
                style={{ fontSize: '0.72rem' }}
              >
                {isArchived ? 'Archived' : isSuspended ? 'Suspended' : 'Active'}
              </span>
              <span
                className={`phase-pill-${phaseGroup}`}
                style={{ fontSize: '0.72rem' }}
              >
                {phaseGroup === 'both' ? 'Deployment + Attendance' : phaseGroup === 'deployment' ? 'Deployment' : 'Attendance'}
              </span>
            </div>
          </section>

          {/* ── Auth Meta ── */}
          <section aria-label="Authentication">
            <div className="drawer-section-title">Authentication</div>
            <dl className="drawer-grid">
              <dt>Created</dt>
              <dd>{meta.created_at ? new Date(meta.created_at).toLocaleString() : '—'}</dd>
              <dt>Last login</dt>
              <dd>{meta.last_login ? new Date(meta.last_login).toLocaleString() : '—'}</dd>
              {meta.last_sign_in_at && (
                <>
                  <dt>Last sign-in</dt>
                  <dd>{new Date(meta.last_sign_in_at).toLocaleString()}</dd>
                </>
              )}
            </dl>
          </section>

          {/* ── Department Grants ── */}
          <section aria-label="Department grants">
            <div className="drawer-section-title">Department Grants</div>
            {deptGrants.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                No department grants.
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {deptGrants.map((g) => (
                  <li key={g.id || `${g.department_id}-${g.schedule_id}`} style={{ fontSize: '0.82rem' }}>
                    <span className="pill pill-grey" style={{ fontSize: '0.7rem' }}>
                      {g.department_name || g.department_id}
                    </span>
                    {g.schedule_name && (
                      <span style={{ marginLeft: '0.4rem', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                        {g.schedule_name}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Audit Trail ── */}
          <section aria-label="Audit trail">
            <div className="drawer-section-title">Audit Trail</div>
            {auditRows.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                No audit entries.
              </p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {auditRows.map((row) => (
                  <li
                    key={row.id || `${row.action}-${row.created_at}`}
                    style={{
                      fontSize: '0.78rem',
                      padding: '0.35rem 0.5rem',
                      background: 'var(--surface-secondary, #f8fafc)',
                      borderRadius: 6,
                      border: '1px solid var(--border, #e2e8f0)',
                    }}
                  >
                    <strong style={{ fontSize: '0.74rem' }}>{row.action}</strong>
                    {row.detail && (
                      <span style={{ color: 'var(--text-muted)' }}> — {row.detail}</span>
                    )}
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                      {row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Admin Actions ── */}
          <section aria-label="Admin actions">
            <div className="drawer-section-title">Admin Actions</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {onSetPassword && (
                <button
                  type="button"
                  className={actionBtn}
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onSetPassword(user)}
                >
                  <KeyRound size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Set Password
                </button>
              )}
              {onSignOutAll && (
                <button
                  type="button"
                  className={actionBtn}
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onSignOutAll(user)}
                >
                  <LogOut size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Sign Out All
                </button>
              )}
              {onSuspend && !isSuspended && !isArchived && (
                <button
                  type="button"
                  className={actionBtn}
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onSuspend(user)}
                >
                  <Ban size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Suspend
                </button>
              )}
              {onArchive && !isArchived && (
                <button
                  type="button"
                  className={actionBtn}
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onArchive(user)}
                >
                  <Archive size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Archive
                </button>
              )}
              {onRestore && (isSuspended || isArchived) && (
                <button
                  type="button"
                  className={actionBtn}
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onRestore(user)}
                >
                  <RotateCcw size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Restore
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="btn btn-danger"
                  style={actionStyle}
                  disabled={busy}
                  onClick={() => onDelete(user)}
                >
                  <Trash2 size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                  Delete
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
