import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { MIN_SUPPORTED_DB_VERSION, fetchDbVersion, dbVersionStatus } from '../lib/version'

/**
 * DbVersionBanner — the visible half of the L-07 handshake.
 *
 * Checks once per mount (the Dashboard shell mounts per login). Silent
 * when the database is current; a non-blocking, dismissible amber strip
 * when it is behind or unconfirmed. Never blocks boot, never throws —
 * fetchDbVersion already resolves null on every failure mode.
 */
export default function DbVersionBanner() {
  const [status, setStatus] = useState(null)
  const [dbVersion, setDbVersion] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true
    fetchDbVersion(supabase).then((v) => {
      if (!alive) return
      setDbVersion(v)
      const s = dbVersionStatus(v)
      if (s !== 'ok') setStatus(s)
    })
    return () => { alive = false }
  }, [])

  if (!status || dismissed) return null
  return (
    <div
      role="alert"
      style={{
        background: '#fffbeb', borderBottom: '1px solid #fcd34d',
        color: '#92400e', fontSize: '0.8rem', padding: '0.45rem 1rem',
        display: 'flex', alignItems: 'center', gap: '0.6rem',
      }}
    >
      <span style={{ flex: 1 }}>
        {status === 'stale'
          ? `Database is at ${dbVersion} — this app needs ${MIN_SUPPORTED_DB_VERSION}+. Some reports may be wrong. Ask the ASO to run the pending migration.`
          : `Couldn't confirm the database version — if reports look wrong, ask the ASO to check pending migrations.`}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="btn btn-ghost"
        style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }}
      >
        Dismiss
      </button>
    </div>
  )
}
