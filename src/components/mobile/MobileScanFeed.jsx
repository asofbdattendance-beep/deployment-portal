/**
 * MobileScanFeed — the "my last N scans" list as thumb-friendly cards.
 *
 * RecentScansTable deliberately avoids `.table` so the ≤640px card-collapse
 * cannot reach it — but its 480px min-width table still forces horizontal
 * scrolling inside a 260–380px box on phones. This feed is the mobile
 * counterpart: one card per sewadar, no horizontal scroll, newest first,
 * empty-Out reads as "still in" (mirrors the table's contract).
 */
import { useEffect, useRef, useState } from 'react'

const EM_DASH = '—'

export default function MobileScanFeed({ rows = [], deptNameById, limit, emptyMessage }) {
  const list = typeof limit === 'number' ? rows.slice(0, limit) : rows

  // The whole list used to sit in an aria-live region, so the 15s poll
  // re-announced every card on every tick — a screen-reader user heard the
  // same 10 names forever. Only the newest row is announced now, and only
  // when it actually changes (a poll returning identical data is silent).
  const newestId = list[0]?.id ?? list[0]?.badge_number ?? null
  const prevNewest = useRef(newestId)
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    if (newestId == null || newestId === prevNewest.current) return
    prevNewest.current = newestId
    const top = list[0]
    if (!top) return
    setAnnounce(`${top.sewadar_name || top.badge_number} marked ${top.out_time ? 'Out' : 'In'}`)
  }, [newestId, list])

  if (list.length === 0) {
    return <div className="scan-feed-empty">{emptyMessage || 'No scans yet'}</div>
  }

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      <ul className="scan-feed" aria-label="Recent attendance scans, newest first">
      {list.map((row) => {
        const deptName = row.sewadar_dept ? deptNameById?.get(row.sewadar_dept) : null
        const open = !row.out_time
        return (
          <li key={row.id ?? row.badge_number} className="scan-feed-card">
            <div className="scan-feed-top">
              <span className="scan-feed-badge">{row.badge_number}</span>
              {row.is_vss ? <span className="pill pill-amber">VSS</span> : null}
              {row.undeployed_scan ? <span className="pill pill-red">Flagged</span> : null}
              <span className={`pill ${open ? 'pill-green' : 'pill-gray'} scan-feed-status`}>
                {open ? 'In' : 'Out'}
              </span>
            </div>
            <div className="scan-feed-name">{row.sewadar_name || EM_DASH}</div>
            <div className="scan-feed-meta">
              {deptName ? <span className="pill pill-blue">{deptName}</span> : <span>{EM_DASH}</span>}
              <span className="scan-feed-times">
                {row.in_time || EM_DASH} → {row.out_time || EM_DASH}
              </span>
            </div>
          </li>
        )
      })}
      </ul>
    </>
  )
}
