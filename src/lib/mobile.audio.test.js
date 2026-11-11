// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'

function fakeAudioContext(state = 'suspended') {
  const created = []
  const instances = []
  class FakeCtx {
    constructor() { instances.push(this); this.state = state; this.currentTime = 0; this.destination = {}; this.resume = vi.fn(() => { this.state = 'running'; return Promise.resolve() }) }
    createOscillator() { const o = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; created.push(o); return o }
    createGain() { return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() } }
  }
  return { FakeCtx, created, instances }
}

async function freshMobile() {
  vi.resetModules()
  return import('./mobile')
}

afterEach(() => { delete window.AudioContext; delete window.webkitAudioContext })

describe('playScanBeep', () => {
  it('is a silent no-op when Web Audio is unavailable', async () => {
    const { playScanBeep } = await freshMobile()
    expect(() => playScanBeep('success')).not.toThrow()
  })

  it('plays one tone for success and two for error', async () => {
    const { FakeCtx, created } = fakeAudioContext('running')
    window.AudioContext = FakeCtx
    const { playScanBeep } = await freshMobile()
    playScanBeep('success')
    expect(created).toHaveLength(1)
    expect(created[0].frequency.setValueAtTime).toHaveBeenCalledWith(1850, 0)
    playScanBeep('error')
    expect(created).toHaveLength(3)
  })
})

describe('installScanAudioUnlock', () => {
  it('resumes a suspended context on the first tap only', async () => {
    const { FakeCtx, instances } = fakeAudioContext('suspended')
    window.AudioContext = FakeCtx
    const { installScanAudioUnlock, playScanBeep } = await freshMobile()
    installScanAudioUnlock()
    installScanAudioUnlock()
    window.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('pointerdown'))
    expect(instances).toHaveLength(1)
    expect(instances[0].resume).toHaveBeenCalledTimes(1)
    expect(instances[0].state).toBe('running')
    // Beeps reuse the unlocked context instead of making a new, suspended one.
    playScanBeep('success')
    expect(instances).toHaveLength(1)
  })
})
