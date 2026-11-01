// @vitest-environment jsdom
// LoginPage dual login (email OR badge) — email path makes zero edge calls
// (byte-identical signIn behaviour); badge path resolves via resolve-login.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import LoginPage from './LoginPage'

const signInMock = vi.fn()
const invokeMock = vi.fn()

vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({
    signIn: (...args) => signInMock(...args),
    recoveryLinkError: null,
  }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { resetPasswordForEmail: vi.fn(() => Promise.resolve({ error: null })) },
    functions: { invoke: (...args) => invokeMock(...args) },
  },
}))

// Retry backoff collapses to 0 ms so the 429 retry tests run instantly.
vi.mock('../lib/jitter', () => ({ jitter: () => 0 }))

beforeEach(() => {
  signInMock.mockReset()
  invokeMock.mockReset()
})

afterEach(() => cleanup())

async function submitWith(identifier, password = 'secret123') {
  render(<LoginPage />)
  fireEvent.change(screen.getByPlaceholderText('Email or badge number'), {
    target: { value: identifier },
  })
  fireEvent.change(screen.getByPlaceholderText('Enter password'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('LoginPage dual login', () => {
  it('renders the Email-or-badge field', () => {
    render(<LoginPage />)
    expect(screen.getByText('Email or badge number')).toBeTruthy()
    expect(screen.getByPlaceholderText('Email or badge number')).toBeTruthy()
  })

  it('email path calls signIn directly with zero edge calls', async () => {
    signInMock.mockResolvedValue()
    await submitWith('aso@example.com')
    await waitFor(() => expect(signInMock).toHaveBeenCalledWith('aso@example.com', 'secret123'))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('badge path resolves via resolve-login then signs in with the email', async () => {
    signInMock.mockResolvedValue()
    invokeMock.mockResolvedValue({ data: { email: 'scanner@example.com' }, error: null })
    await submitWith('FB5990GA0001')
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('resolve-login', {
      body: { badge: 'FB5990GA0001' },
    }))
    await waitFor(() => expect(signInMock).toHaveBeenCalledWith('scanner@example.com', 'secret123'))
  })

  it('unknown badge shows a generic error and never calls signIn', async () => {
    invokeMock.mockResolvedValue({ data: null, error: { status: 404, message: 'not found' } })
    await submitWith('ZZ9')
    await waitFor(() => expect(screen.getByText('No account found for that badge number')).toBeTruthy())
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('rate-limited badge shows the retry message and never calls signIn', async () => {
    invokeMock.mockResolvedValue({ data: null, error: { status: 429, message: 'too many' } })
    await submitWith('FB1')
    await waitFor(() => expect(screen.getByText('Too many attempts — try again in 15 minutes')).toBeTruthy())
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('auth 429 is retried automatically and the sign-in then succeeds', async () => {
    signInMock
      .mockRejectedValueOnce({ status: 429, message: 'Request rate limit reached' })
      .mockRejectedValueOnce({ status: 429, message: 'Request rate limit reached' })
      .mockResolvedValue()
    await submitWith('aso@example.com')
    await waitFor(() => expect(signInMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i }).disabled).toBe(false))
    expect(screen.queryByText(/Too many sign-in attempts/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('auth 429 gives up after the last retry with a readable message', async () => {
    signInMock.mockRejectedValue({ status: 429, message: 'Request rate limit reached' })
    await submitWith('aso@example.com')
    await waitFor(() => expect(screen.getByText('Too many sign-in attempts right now — wait a few minutes and try again')).toBeTruthy())
    // first try + 4 retries
    expect(signInMock).toHaveBeenCalledTimes(5)
  })

  it('a wrong password is not retried', async () => {
    signInMock.mockRejectedValue({ status: 400, message: 'Invalid login credentials' })
    await submitWith('aso@example.com')
    await waitFor(() => expect(screen.getByText('Invalid login credentials')).toBeTruthy())
    expect(signInMock).toHaveBeenCalledTimes(1)
  })
})
