import { Clock, AlertTriangle } from 'lucide-react'
import {
  UNASSIGNED_CENTRE,
  hasExpectedDays,
  sessionDuration,
  shortDayLabel,
} from '../lib/attendance'

// Rate band → pill colour. Mirrors AttendancePage's BAND_PILL so the phone
// card and the desktop table pill always agree.
const BAND_PILL = { full: 'pill-green', partial: 'pill-blue', low: 'pill-amber', none: 'pill-gray' }
const bandPill = (band) => BAND_PILL[band] || BAND_PILL.none

/**
 * AttendanceCards — phone-first card renderers for the virtualised
 * attendance lists. Each card mirrors its table row cell-for-cell (same
 * fields, same pills, same fallbacks) so the mobile list and the desktop
 * table can never disagree. Rendered through VirtualList on mobile only;
 * desktop keeps the <table>.
 */

/** Compact pill row for Open/Undeployed flags (mirrors the Flags td). */
function FlagPills({ r }) {
  return (
    <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      {r.open_sessions > 0 && <span className="pill pill-amber" title="Scanned IN, not yet OUT"><Clock size={11} /> Open</span>}
      {r.undeployed_scan && <span className="pill pill-red" title="Scanned at the gate but not deployed to any department"><AlertTriangle size={11} /> Undeployed</span>}
      {!r.open_sessions && !r.undeployed_scan && <span className="pill pill-gray">—</span>}
    </span>
  )
}

function daysLabel(r) {
  if (!hasExpectedDays(r)) {
    if (r.days_present > 0) return `${r.days_present} (no dept)`
    return '—'
  }
  return `${r.days_present}/${r.expected_days}`
}

export function SewadarCard({ r }) {
  return (
    <div className="att-card">
      <div className="att-card-top">
        <span className="att-card-name">{r.sewadar_name}</span>
        <span className="att-card-badge">{r.badge_number}</span>
        {r.is_vss && <span className="pill pill-amber" style={{ fontSize: '0.6rem' }}>VSS</span>}
      </div>
      <div className="att-card-meta">
        <span>{r.sewadar_centre || UNASSIGNED_CENTRE}</span>
        <span aria-hidden="true">·</span>
        <span>{r.dept_name || '—'}</span>
      </div>
      <div className="att-card-stats">
        <span className="att-card-stat">
          <span className="att-card-k">Days</span>
          <span className="att-card-v">{daysLabel(r)}</span>
        </span>
        <span className="att-card-stat">
          <span className="att-card-k">Rate</span>
          {hasExpectedDays(r)
            ? <span className={`pill ${bandPill(r.band)}`}>{r.rate}%</span>
            : <span className="pill pill-gray" title="No department, so there is no expected-days denominator">—</span>}
        </span>
        <span className="att-card-stat">
          <span className="att-card-k">Duration</span>
          <span className="att-card-v">{sessionDuration(r)}</span>
        </span>
      </div>
      <div className="att-card-foot">
        <span className="att-card-times">
          {r.first_in_date ? `${shortDayLabel(r.first_in_date)} ${(r.first_in_time || '').slice(0, 5)}` : '—'}
          {' → '}
          {r.last_out_date
            ? `${shortDayLabel(r.last_out_date)} ${(r.last_out_time || '').slice(0, 5)}`
            : r.still_open ? 'still IN' : '—'}
        </span>
        <FlagPills r={r} />
      </div>
    </div>
  )
}

export function ScannerCard({ r }) {
  return (
    <div className="att-card">
      <div className="att-card-top">
        <span className="att-card-name">{r.scanner_name || '—'}</span>
        <span className="att-card-badge">{r.scanner_badge}</span>
      </div>
      <div className="att-card-meta">
        <span>{r.scanner_centre || UNASSIGNED_CENTRE}</span>
      </div>
      <div className="att-card-stats">
        <span className="att-card-stat">
          <span className="att-card-k">In</span>
          <span className="att-card-v">{r.scans_in}</span>
        </span>
        <span className="att-card-stat">
          <span className="att-card-k">Out</span>
          <span className="att-card-v">{r.scans_out}</span>
        </span>
        <span className="att-card-stat">
          <span className="att-card-k">Open</span>
          <span className="att-card-v" style={r.open_now ? { color: '#b45309' } : undefined}>{r.open_now}</span>
        </span>
        <span className="att-card-stat">
          <span className="att-card-k">Manual</span>
          <span className="att-card-v">{r.manual_scans}</span>
        </span>
      </div>
      <div className="att-card-foot">
        <span className="att-card-times">
          {(r.first_in_time || '').slice(0, 5) || '—'}
          {' → '}
          {(r.last_scan_time || '').slice(0, 5) || '—'}
        </span>
      </div>
    </div>
  )
}
