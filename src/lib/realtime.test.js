import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reportRealtimeStatus } from './realtime'

/**
 * The bug this pins: every page tore its channel down in the effect cleanup
 * with `supabase.removeChannel(channel)`. That fires the subscribe callback one
 * last time with status `CLOSED`, and the handlers warned on
 * `status !== 'SUBSCRIBED'` — so EVERY page navigation logged a realtime
 * "failure" that was simply the teardown working. It trained everyone to
 * ignore the console, and a real CHANNEL_ERROR became indistinguishable from
 * switching tabs.
 */
describe('reportRealtimeStatus', () => {
  let warn

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { warn.mockRestore() })

  it('says nothing on a normal teardown (CLOSED after cleanup)', () => {
    reportRealtimeStatus('attendance', 'CLOSED', false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('says nothing once the effect is torn down, whatever the status', () => {
    // A teardown must never be reported, even if the status looks alarming —
    // the channel is being closed on purpose.
    for (const s of ['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT']) {
      reportRealtimeStatus('attendance', s, false)
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet on a healthy subscribe', () => {
    reportRealtimeStatus('attendance', 'SUBSCRIBED', true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns on a genuine CHANNEL_ERROR while still mounted', () => {
    reportRealtimeStatus('attendance', 'CHANNEL_ERROR', true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/live updates are OFF/i)
  })

  it('warns on a genuine TIMED_OUT while still mounted', () => {
    reportRealtimeStatus('dashboard', 'TIMED_OUT', true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('includes the label so the page is identifiable', () => {
    reportRealtimeStatus('incharge-dashboard', 'CHANNEL_ERROR', true)
    expect(warn.mock.calls[0][0]).toContain('[incharge-dashboard]')
  })
})
