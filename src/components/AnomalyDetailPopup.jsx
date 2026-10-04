import { useEffect, useMemo } from 'react'
import { useBottomSheet } from './mobile/useBottomSheet'
import { useAnomalyDetail } from '../hooks/useAnomalyDetail'
import { useDeptNames, refreshDeptNames } from '../hooks/useDeptNames'
import { deptNameMap } from '../lib/scanDisplay'
import { sessionMinutes, formatDuration, shortTime } from '../lib/attendance'

/**
 * AnomalyDetailPopup — the "info trail" behind an anomaly row.
 *
 * Opened by clicking ANY anomaly row (all five rules). Three blocks:
 *   1. This anomaly — rule pill + what it means + the row's detail text.
 *   2. Scan trail — every IN/OUT session for this badge × schedule,
 *      chronological, each on one compact line: IN time + IN-by, OUT time
 *      + OUT-by, duration, venue, manual/undeployed marks.
 *   3. Related info — deployment (requested → final department), consent
 *      (given/days/stay/chair), plus the badge's OTHER anomaly rows.
 *
 * Read-only: mounts no writes. Desktop renders the shared `.modal`
 * dialog; on phones the same node behaves as a bottom sheet via
 * useBottomSheet (focus trap, Escape-close, body-scroll lock).
 */
function byWhom(name, badge) {
  return name || badge || '—'
}

function sessionLine(s) {
  const mins = sessionMinutes(s.in_time, s.out_time, s.in_date, s.out_date)
  const dur = mins == null ? (s.status === 'OPEN' ? 'still IN' : '—') : formatDuration(mins)
  return { dur }
}

export default function AnomalyDetailPopup({ row, scheduleId, related = [], ruleMeta = {}, onClose }) {
  const badge = row?.badge_number
  const { detail, loading, error } = useAnomalyDetail(scheduleId, badge)
  const [depts, syncDepts] = useDeptNames()
  const sheetRef = useBottomSheet(true, onClose || (() => {}))

  useEffect(() => { refreshDeptNames(syncDepts) }, [syncDepts])
  const names = useMemo(() => deptNameMap(depts), [depts])
  const dn = (id) => (id ? names.get(id) || id : '—')

  const meta = (ruleMeta && row && ruleMeta[row.rule]) || {}
  const pillClass = meta.pillClass || meta.pill || null
  const others = (related || []).filter((r) => r !== row)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={badge ? `Anomaly details for ${badge}` : 'Anomaly details'}
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(680px, 94vw)', maxHeight: '86vh', overflowY: 'auto' }}
      >
        <div className="trail-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, position: 'sticky', top: 0, padding: '0.25rem 0 0.6rem', background: 'var(--modal-bg, #fff)', zIndex: 1, borderBottom: '1px solid var(--border, #e2e8f0)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>
              <span style={{ fontFamily: 'monospace' }}>{badge || '—'}</span>
              {row?.sewadar_name ? ` · ${row.sewadar_name}` : ''}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {[row?.sewadar_centre, row?.dept_name].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          {pillClass && <span className={`pill ${pillClass}`}>{meta.label || row?.rule}</span>}
          <button type="button" className="btn" aria-label="Close anomaly details" onClick={onClose}>✕</button>
        </div>

        <h3 className="trail-h">This anomaly</h3>
        <p style={{ margin: 0 }}>
          <strong>{meta.label || row?.rule}</strong>
          {meta.text ? ` — ${meta.text}` : ''}
        </p>
        {row?.detail && <p style={{ margin: '0.3rem 0 0' }}>{row.detail}</p>}
        {row?.event_date && (
          <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Event date: {row.event_date}
          </p>
        )}

        <h3 className="trail-h">
          Scan trail{detail ? ` (${detail.sessions.length})` : ''}
        </h3>
        {loading && <p role="status">Loading trail…</p>}
        {!loading && error && (
          <p role="alert">Could not load the scan trail — the sessions read failed.</p>
        )}
        {!loading && !error && detail && detail.sessions.length === 0 && (
          <p>No sessions recorded for this badge in this schedule.</p>
        )}
        {!loading && !error && detail && detail.sessions.length > 0 && (
          <ul className="trail-card" style={{ listStyle: 'none', margin: '0.4rem 0 0', padding: 0 }}>
            {detail.sessions.map((s) => (
              <li
                key={s.id || `${s.in_date}-${s.in_time}`}
                className="log-line trail-row"
              >
                <span className="log-side"><strong>IN</strong> {shortTime(s.in_time)} <span className="log-by">by {byWhom(s.in_scanner_name, s.in_scanner_badge)}</span></span>
                <span className="log-side"><strong>OUT</strong> {s.out_time ? shortTime(s.out_time) : (s.status === 'OPEN' ? 'open' : '—')} <span className="log-by">by {s.out_time ? byWhom(s.out_scanner_name, s.out_scanner_badge) : '—'}</span></span>
                <span className="log-side">{sessionLine(s).dur}</span>
                <span className="log-side" style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                  {[s.in_date, s.centre].filter(Boolean).join(' · ')}
                </span>
                {s.is_manual && <span className="pill pill-grey">manual</span>}
                {s.undeployed_scan && <span className="pill pill-red">undeployed</span>}
                {s.status === 'OPEN' && <span className="pill pill-amber">OPEN</span>}
              </li>
            ))}
          </ul>
        )}

        {!loading && !error && detail && (
          <>
            <h3 className="trail-h">Deployment</h3>
            {detail.deployment ? (
              <p style={{ margin: 0 }}>
                Requested: <strong>{dn(detail.deployment.department_id)}</strong>
                {' → '}Final: <strong>{dn(detail.deployment.deployed_department_id)}</strong>
              </p>
            ) : (
              <p style={{ margin: 0 }}>Not deployed in this schedule.</p>
            )}

            <h3 className="trail-h">Consent</h3>
            {detail.consent ? (
              <p style={{ margin: 0 }}>
                {[
                  detail.consent.consent_given ? 'Yes' : 'No',
                  detail.consent.available_days_count != null
                    ? `${detail.consent.available_days_count} day(s)`
                    : null,
                  detail.consent.stay_at_bhati ? 'stays at Bhati' : null,
                  detail.consent.chair_pass ? 'chair pass' : null,
                ].filter(Boolean).join(' · ')}
              </p>
            ) : (
              <p style={{ margin: 0 }}>No consent recorded for this sewadar.</p>
            )}
          </>
        )}

        <h3 className="trail-h">Related anomalies ({others.length})</h3>
        {others.length === 0 ? (
          <p style={{ margin: 0 }}>None — this is the only one for the badge.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {others.map((r, i) => {
              const m = ruleMeta[r.rule] || {}
              const pc = m.pillClass || m.pill || null
              const label = m.label || r.rule || 'Related entry'
              const extra = [r.detail, r.event_date ? `(${r.event_date})` : null]
                .filter(Boolean).join(' ')
              // Skip rows that would render as an empty pill + date paren.
              if (!r.detail && !r.rule && !m.label) return null
              return (
                <li key={i}>
                  {pc
                    ? <span className={`pill ${pc}`}>{label}</span>
                    : <strong>{label}</strong>}{' '}
                  {extra}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
