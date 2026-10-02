// @vitest-environment jsdom
/**
 * DbVersionBanner — the visible half of the L-07 handshake.
 * Silent when the DB is current; a non-blocking, dismissible warning
 * when it is behind or unconfirmed. Never blocks boot, never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import DbVersionBanner from './DbVersionBanner'

const mocks = vi.hoisted(() => ({ fetchDbVersion: vi.fn() }))

vi.mock('../lib/version', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchDbVersion: (...a) => mocks.fetchDbVersion(...a) }
})
vi.mock('../lib/supabase', () => ({ supabase: {} }))

beforeEach(() => {
  mocks.fetchDbVersion.mockReset()
})

afterEach(() => { cleanup() })

describe('DbVersionBanner', () => {
  it('renders nothing when the database is current', async () => {
    mocks.fetchDbVersion.mockResolvedValue('v64')
    const { container } = render(<DbVersionBanner />)
    await waitFor(() => expect(mocks.fetchDbVersion).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('names both versions when the database is behind', async () => {
    mocks.fetchDbVersion.mockResolvedValue('v45')
    render(<DbVersionBanner />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    const text = screen.getByRole('alert').textContent
    expect(text).toContain('v45')
    expect(text).toContain('v64')
  })

  it('warns generically when the version cannot be confirmed', async () => {
    mocks.fetchDbVersion.mockResolvedValue(null)
    render(<DbVersionBanner />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t confirm/i)
  })

  it('dismisses for the session without hiding future checks', async () => {
    mocks.fetchDbVersion.mockResolvedValue('v45')
    render(<DbVersionBanner />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
