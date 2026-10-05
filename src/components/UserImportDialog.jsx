import { useState, useEffect, useRef } from 'react'
import { loadXlsx, newWorkbook, addSheet, workbookToBlob, saveBlob, readWorkbookRows } from '../lib/excel'
import { passwordErrors } from '../lib/userAdmin'
import { INVITE_ROLES } from '../lib/logic'
import { Download, Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'

/**
 * UserImportDialog — bulk-create portal users from an .xlsx file.
 *
 * Flow: download a template (headers + one example row) → pick a file →
 * readWorkbookRows → parseImportRows → preview valid/rejected → Confirm calls
 * onBulkCreate(validRows) → per-row results {email, status, error}.
 *
 * Passwords are imported but NEVER rendered or logged: the preview table and
 * the results list omit the password column entirely.
 *
 * Props contract (exact): { open, onClose, onBulkCreate, busy }
 */

// Template column order — the only columns the import reads.
export const TEMPLATE_HEADERS = ['email', 'badge', 'password', 'name', 'role', 'centre', 'location']

// One example row shipped in the template. The password is a placeholder the
// user replaces — it is written to the file, never logged.
export const TEMPLATE_EXAMPLE_ROW = {
  email: 'example@bhati.org',
  badge: 'FB0001',
  password: 'ExamplePass123',
  name: 'Example Sewadar',
  role: 'centre_user',
  centre: 'Bhati',
  location: 'Bhati Gate 2',
}

const EMAIL_RE = /^\S+@\S+\.\S+$/

/**
 * Parse raw sheet rows (from readWorkbookRows) into valid user objects.
 * Reuses passwordErrors from userAdmin so the min-6 rule stays in sync.
 * Returns { valid, errors }; valid rows carry all seven template columns
 * (location is optional free text — no validation beyond trimming).
 * Errors are { row, message } with row = 1-indexed spreadsheet row (header = 1).
 */
export function parseImportRows(rows) {
  const valid = []
  const errors = []
  ;(rows || []).forEach((row, i) => {
    const rowNum = i + 2 // 1-indexed + header row
    const name = String(row.name || '').trim()
    const email = String(row.email || '').trim()
    const role = String(row.role || '').trim()
    const badge = String(row.badge || '').trim()
    const centre = String(row.centre || '').trim()
    const password = String(row.password || '').trim()
    const location = String(row.location || '').trim()

    if (!name) {
      errors.push({ row: rowNum, message: 'Missing name' })
      return
    }
    if (!email) {
      errors.push({ row: rowNum, message: 'Missing email' })
      return
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ row: rowNum, message: 'Invalid email' })
      return
    }
    if (!role) {
      errors.push({ row: rowNum, message: 'Missing role' })
      return
    }
    if (!INVITE_ROLES.includes(role)) {
      errors.push({ row: rowNum, message: `Unknown role "${role}"` })
      return
    }
    const pwErrs = passwordErrors(password)
    if (pwErrs.length) {
      errors.push({ row: rowNum, message: pwErrs[0] })
      return
    }
    valid.push({ name, email, role, badge, centre, password, location })
  })
  return { valid, errors }
}

export default function UserImportDialog({ open, onClose, onBulkCreate, busy }) {
  const [step, setStep] = useState('pick') // pick | preview | results
  const [fileName, setFileName] = useState('')
  const [parse, setParse] = useState(null) // { valid, errors }
  const [results, setResults] = useState(null) // [{ email, status, error }]
  const [dragOver, setDragOver] = useState(false)
  const [localError, setLocalError] = useState(null)
  const fileRef = useRef(null)
  const dialogRef = useRef(null)

  // Reset to a clean state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setStep('pick')
      setFileName('')
      setParse(null)
      setResults(null)
      setLocalError(null)
      setDragOver(false)
    }
  }, [open])

  // Escape closes; focus the dialog so keyboard users land inside it.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function downloadTemplate() {
    const XLSX = await loadXlsx()
    const wb = newWorkbook(XLSX)
    addSheet(XLSX, wb, 'Users', [TEMPLATE_EXAMPLE_ROW])
    const blob = workbookToBlob(XLSX, wb)
    saveBlob(blob, 'user_import_template.xlsx')
  }

  async function ingestFile(file) {
    setLocalError(null)
    setFileName(file.name)
    try {
      const rows = await readWorkbookRows(file)
      if (!rows.length) {
        setLocalError('No data rows found in that file.')
        return
      }
      setParse(parseImportRows(rows))
      setStep('preview')
    } catch (err) {
      setLocalError(err?.message || 'Could not read that file.')
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (file) ingestFile(file)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) ingestFile(file)
  }

  async function handleConfirm() {
    if (!parse?.valid?.length || busy) return
    let res
    try {
      res = await onBulkCreate(parse.valid)
    } catch (e) {
      res = parse.valid.map((r) => ({ email: r.email, status: 'error', error: e?.message || 'Import failed' }))
    }
    // Trust the caller's per-row results when present; otherwise derive.
    const rows = Array.isArray(res) && res.length
      ? res
      : parse.valid.map((r) => ({ email: r.email, status: 'created', error: null }))
    setResults(rows)
    setStep('results')
  }

  const created = (results || []).filter((r) => r.status === 'created').length
  const failed = (results || []).length - created

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Bulk import users"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(600px, 94vw)', maxWidth: 600, maxHeight: '86vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
          <FileSpreadsheet size={18} style={{ color: 'var(--accent, #4f46e5)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em' }}>Bulk import users</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Upload an .xlsx to create many users at once</div>
          </div>
          <button type="button" className="btn btn-ghost" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        {localError && (
          <div className="pill pill-red" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.75rem', padding: '0.5rem 0.75rem' }}>
            <AlertTriangle size={14} /> {localError}
          </div>
        )}

        {/* ── Step 1: template + file pick ── */}
        {step === 'pick' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div>
              <button type="button" className="btn btn-primary" onClick={downloadTemplate} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Download size={15} /> Download template
              </button>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
                .xlsx with columns: {TEMPLATE_HEADERS.join(', ')}. One example row is included — replace it with real data.
              </div>
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              style={{ border: `2px dashed ${dragOver ? 'var(--accent, #4f46e5)' : 'var(--border)'}`, borderRadius: 12, padding: '1.25rem', textAlign: 'center', background: dragOver ? '#eef2ff' : 'transparent' }}
            >
              <Upload size={22} style={{ color: 'var(--text-muted)' }} />
              <div style={{ fontWeight: 600, marginTop: 4 }}>Drop your .xlsx here, or</div>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()} style={{ marginTop: 8 }}>
                Choose file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                style={{ display: 'none' }}
                aria-label="Choose an .xlsx file to import"
              />
            </div>

            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Passwords must be at least 6 characters. They are imported but never shown or logged.
            </div>
          </div>
        )}

        {/* ── Step 2: preview valid / rejected ── */}
        {step === 'preview' && parse && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="pill pill-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={12} /> {parse.valid.length} valid
              </span>
              <span className="pill pill-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <XCircle size={12} /> {parse.errors.length} rejected
              </span>
              <span className="pill pill-gray" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{fileName}</span>
            </div>

            {parse.valid.length > 0 && (
              <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
                <table className="table" style={{ width: '100%', fontSize: '0.8rem' }}>
                  <thead>
                    <tr>{['Name', 'Email', 'Role', 'Badge', 'Centre', 'Location'].map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parse.valid.map((r, i) => (
                      <tr key={i}>
                        <td>{r.name}</td>
                        <td>{r.email}</td>
                        <td>{r.role}</td>
                        <td>{r.badge || '—'}</td>
                        <td>{r.centre || '—'}</td>
                        <td>{r.location || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {parse.errors.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto' }}>
                {parse.errors.map((e, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: '#b91c1c', padding: '2px 0' }}>Row {e.row}: {e.message}</div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: '0.25rem' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setStep('pick')} disabled={busy}>Back</button>
              <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={busy || !parse.valid.length}>
                {busy ? 'Importing…' : `Import ${parse.valid.length} user${parse.valid.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: per-row results ── */}
        {step === 'results' && results && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="pill pill-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={12} /> {created} created
              </span>
              <span className="pill pill-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <XCircle size={12} /> {failed} failed
              </span>
            </div>

            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table className="table" style={{ width: '100%', fontSize: '0.8rem' }}>
                <thead>
                  <tr>{['Email', 'Status', 'Detail'].map((h) => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td>{r.email}</td>
                      <td><span className={`pill ${r.status === 'created' ? 'pill-green' : 'pill-red'}`}>{r.status}</span></td>
                      <td style={{ color: 'var(--text-muted)' }}>{r.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
