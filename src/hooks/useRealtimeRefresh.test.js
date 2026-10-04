// @vitest-environment jsdom
// useRealtimeRefresh — the extracted AttendancePage scan-landing effect.
// The mock setup mirrors src/pages/AttendancePage.test.jsx: a chainable
// no-op channel satisfying .on(...).subscribe() + removeChannel, with pg
// handlers captured so tests can fire reloads on demand.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRealtimeRefresh } from './useRealtimeRefresh'

const pgHandlers = []
const onCalls = []
const removeChannel = vi.fn()
const subscribeCb = { current: null }
const noopChannel = () => {
  const ch = {
    on: (event, filter, cb) => { onCalls.push([event, filter]); if (typeof cb === 'function') pgHandlers.push(cb); return ch },
    subscribe: (cb) => { subscribeCb.current = cb; return ch },
    unsubscribe: () => ch,
  }
  return ch
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    channel: (name) => { onCalls.push(['__channel', name]); return noopChannel() },
    removeChannel: (...args) => removeChannel(...args),
  },
}))

const SUBS = [
  { table: 'dp_attendance_sessions', filter: 'schedule_id=eq.s1' },
  { table: 'deployments', filter: 'schedule_id=eq.s1' },
]

function setup(overrides = {}) {
  const onReload = vi.fn(async () => {})
  const props = {
    scheduleId: 's1',
    channelName: 'attendance-s1',
    subscriptions: SUBS,
    onReload,
    label: 'attendance',
    ...overrides,
  }
  let hook
  act(() => { hook = renderHook(({ p }) => useRealtimeRefresh(p), { initialProps: { p: props } }) })
  return { hook, onReload }
}

beforeEach(() => {
  vi.useFakeTimers()
  pgHandlers.length = 0
  onCalls.length = 0
  removeChannel.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useRealtimeRefresh', () => {
  it('does not subscribe without a scheduleId', () => {
    setup({ scheduleId: null })
    expect(onCalls).toEqual([])
  })

  it('subscribes once with the channel name and one binding per subscription', () => {
    setup()
    expect(onCalls[0]).toEqual(['__channel', 'attendance-s1'])
    const bindings = onCalls.filter(([e]) => e === 'postgres_changes')
    expect(bindings).toHaveLength(2)
    expect(bindings[0][1]).toMatchObject({ event: '*', schema: 'public', table: 'dp_attendance_sessions', filter: 'schedule_id=eq.s1' })
    expect(bindings[1][1]).toMatchObject({ table: 'deployments' })
  })

  it('coalesces a burst into one trailing reload', async () => {
    const { onReload } = setup()
    expect(pgHandlers).toHaveLength(2)
    await act(async () => { pgHandlers[0](); pgHandlers[0](); pgHandlers[1]() })
    expect(onReload).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('fires immediately when the last reload is older than maxWaitMs', async () => {
    const { onReload } = setup({ maxWaitMs: 2000 })
    await act(async () => { vi.advanceTimersByTime(2500) })
    await act(async () => { pgHandlers[0]() })
    await act(async () => {})
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('removes the channel on unmount and never reloads after', async () => {
    const { hook, onReload } = setup()
    expect(removeChannel).not.toHaveBeenCalled()
    const fire = pgHandlers[0]
    act(() => { hook.unmount() })
    expect(removeChannel).toHaveBeenCalledTimes(1)
    await act(async () => { fire(); vi.advanceTimersByTime(1000) })
    expect(onReload).not.toHaveBeenCalled()
  })

  it('a throwing onReload never breaks the channel', async () => {
    const bad = vi.fn(async () => { throw new Error('boom') })
    setup({ onReload: bad })
    await act(async () => { pgHandlers[0]() })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(bad).toHaveBeenCalledTimes(1)
  })
})
