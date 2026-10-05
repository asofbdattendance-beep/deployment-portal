// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useManageLogin } from './useManageLogin'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: (...a) => mocks.invoke(...a),
    },
  },
}))

beforeEach(() => {
  mocks.invoke.mockReset()
})

describe('useManageLogin', () => {
  it('exposes all expected methods', () => {
    const { result } = renderHook(() => useManageLogin())
    expect(typeof result.current.deleteUser).toBe('function')
    expect(typeof result.current.setPassword).toBe('function')
    expect(typeof result.current.signOutAll).toBe('function')
    expect(typeof result.current.loadMeta).toBe('function')
    expect(typeof result.current.bulkCreate).toBe('function')
    expect(typeof result.current.sendInvite).toBe('function')
    expect(result.current.busy).toBe(false)
  })

  it('deleteUser invokes manage-login with action delete_user', async () => {
    mocks.invoke.mockResolvedValue({ data: { ok: true }, error: null })
    const { result } = renderHook(() => useManageLogin())
    let res
    await act(async () => {
      res = await result.current.deleteUser('user-123')
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'delete_user', user_id: 'user-123' },
    })
    expect(res).toEqual({ data: { ok: true }, error: null })
  })

  it('setPassword invokes manage-login with action set_password', async () => {
    mocks.invoke.mockResolvedValue({ data: { ok: true }, error: null })
    const { result } = renderHook(() => useManageLogin())
    await act(async () => {
      await result.current.setPassword('user-1', 'newpass123')
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'set_password', user_id: 'user-1', password: 'newpass123' },
    })
  })

  it('signOutAll invokes manage-login with action sign_out_all', async () => {
    mocks.invoke.mockResolvedValue({ data: { ok: true }, error: null })
    const { result } = renderHook(() => useManageLogin())
    await act(async () => {
      await result.current.signOutAll('user-9')
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'sign_out_all', user_id: 'user-9' },
    })
  })

  it('loadMeta invokes manage-login with action load_meta', async () => {
    mocks.invoke.mockResolvedValue({ data: { roles: [] }, error: null })
    const { result } = renderHook(() => useManageLogin())
    await act(async () => {
      await result.current.loadMeta()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'load_meta' },
    })
  })

  it('bulkCreate invokes manage-login with action bulk_create', async () => {
    mocks.invoke.mockResolvedValue({ data: { created: 2 }, error: null })
    const { result } = renderHook(() => useManageLogin())
    const users = [
      { name: 'A', email: 'a@x.com', role: 'aso' },
      { name: 'B', email: 'b@x.com', role: 'centre_user' },
    ]
    await act(async () => {
      await result.current.bulkCreate(users)
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'bulk_create', users },
    })
  })

  it('sendInvite invokes manage-login with action send_invite', async () => {
    mocks.invoke.mockResolvedValue({ data: { sent: true }, error: null })
    const { result } = renderHook(() => useManageLogin())
    await act(async () => {
      await result.current.sendInvite('new@example.com', 'aso')
    })
    expect(mocks.invoke).toHaveBeenCalledWith('manage-login', {
      body: { action: 'send_invite', email: 'new@example.com', role: 'aso' },
    })
  })

  it('sets busy true during invocation and false after', async () => {
    let resolveInvoke
    mocks.invoke.mockReturnValue(new Promise((r) => { resolveInvoke = r }))
    const { result } = renderHook(() => useManageLogin())
    let promise
    act(() => {
      promise = result.current.loadMeta()
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
      resolveInvoke({ data: {}, error: null })
      await promise
    })
    expect(result.current.busy).toBe(false)
  })

  it('parses error.context.json for the real error message', async () => {
    const fakeError = {
      message: 'FunctionsHttpError',
      context: {
        json: async () => ({ error: 'User not found' }),
        status: 404,
      },
    }
    mocks.invoke.mockResolvedValue({ data: null, error: fakeError })
    const { result } = renderHook(() => useManageLogin())
    let res
    await act(async () => {
      res = await result.current.deleteUser('missing')
    })
    expect(res.error).toBe('User not found')
  })

  it('falls back to error.message when context.json is unavailable', async () => {
    const fakeError = {
      message: 'Network failure',
      context: null,
    }
    mocks.invoke.mockResolvedValue({ data: null, error: fakeError })
    const { result } = renderHook(() => useManageLogin())
    let res
    await act(async () => {
      res = await result.current.loadMeta()
    })
    expect(res.error).toBe('Network failure')
  })

  it('returns error when data.error is set', async () => {
    mocks.invoke.mockResolvedValue({ data: { error: 'Rate limited' }, error: null })
    const { result } = renderHook(() => useManageLogin())
    let res
    await act(async () => {
      res = await result.current.loadMeta()
    })
    expect(res.error).toBe('Rate limited')
  })
})
