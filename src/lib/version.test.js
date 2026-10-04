/**
 * version.js — frontend/DB handshake pins (L-07, Phase C task C6).
 *
 * The database evolves in separate deploys (sql/vNN), so the app must not
 * assume its RPCs exist: a missing portal_app_version() (PGRST202) already
 * proves the DB predates the handshake itself.
 */
import { describe, it, expect } from 'vitest'
import {
  MIN_SUPPORTED_DB_VERSION,
  parseDbVersion,
  dbVersionStatus,
  fetchDbVersion,
} from './version'

describe('parseDbVersion', () => {
  it('parses the numeric suffix', () => {
    expect(parseDbVersion('v50')).toBe(50)
    expect(parseDbVersion('v9')).toBe(9)
    expect(parseDbVersion('v38b')).toBe(38)
  })

  it('returns null for anything it cannot order', () => {
    expect(parseDbVersion(null)).toBeNull()
    expect(parseDbVersion(undefined)).toBeNull()
    expect(parseDbVersion('')).toBeNull()
    expect(parseDbVersion('latest')).toBeNull()
  })
})

describe('dbVersionStatus', () => {
  it('is ok on and above the minimum', () => {
    expect(dbVersionStatus('v50', 'v50')).toBe('ok')
    expect(dbVersionStatus('v51', 'v50')).toBe('ok')
  })

  it('is stale below the minimum', () => {
    expect(dbVersionStatus('v49', 'v50')).toBe('stale')
    expect(dbVersionStatus('v9', 'v50')).toBe('stale')
  })

  it('is unknown when either side is unreadable', () => {
    expect(dbVersionStatus(null, 'v50')).toBe('unknown')
    expect(dbVersionStatus('v50', null)).toBe('unknown')
    expect(dbVersionStatus('garbage', 'v50')).toBe('unknown')
  })

  it('defaults the minimum to the shipped floor', () => {
    expect(MIN_SUPPORTED_DB_VERSION).toBe('v67')
    expect(dbVersionStatus('v67')).toBe('ok')
    expect(dbVersionStatus('v65')).toBe('stale')
  })
})

describe('fetchDbVersion', () => {
  const sb = (rpcImpl) => ({ rpc: rpcImpl })

  it('returns the version text on success', async () => {
    const v = await fetchDbVersion(sb(async () => ({ data: 'v50', error: null })))
    expect(v).toBe('v50')
  })

  it('returns null when the function does not exist yet (PGRST202)', async () => {
    const v = await fetchDbVersion(sb(async () => ({
      data: null,
      error: Object.assign(new Error('function portal_app_version does not exist'), { code: 'PGRST202' }),
    })))
    expect(v).toBeNull()
  })

  it('returns null on transport failure instead of throwing', async () => {
    const v = await fetchDbVersion(sb(async () => { throw new Error('Failed to fetch') }))
    expect(v).toBeNull()
  })

  it('trims whitespace the database may add', async () => {
    const v = await fetchDbVersion(sb(async () => ({ data: '  v50\n', error: null })))
    expect(v).toBe('v50')
  })
})
