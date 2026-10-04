import { PHASES } from '../lib/pages'

/**
 * PhaseSwitch — Deployment | Attendance segmented control.
 *
 * The portal's top-level IA switch (majorplan §3–§4): filters the navbar to
 * one phase's pages. Rendered only when the role sees both phases (a single
 * visible phase returns null — no dead affordance). Reuses the incumbent
 * `seg-btn` skin so it reads as portal chrome, not a new component.
 * A11y: real tablist/tab roles, aria-selected, arrow-key movement.
 */
export default function PhaseSwitch({ activePhase, availablePhases, onChange, compact = false }) {
  const phases = (availablePhases || []).filter((p) => p === 1 || p === 2)
  if (phases.length < 2) return null
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = phases.indexOf(activePhase)
    const next = e.key === 'ArrowRight'
      ? phases[(i + 1) % phases.length]
      : phases[(i - 1 + phases.length) % phases.length]
    onChange(next)
  }
  return (
    <div
      role="tablist"
      aria-label="Portal phase"
      onKeyDown={onKeyDown}
      className={`phase-switch${compact ? ' phase-switch-compact' : ''}`}
      style={{ display: 'inline-flex', gap: '0.35rem' }}
    >
      {phases.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={activePhase === p}
          onClick={() => onChange(p)}
          className={`seg-btn${activePhase === p ? ' seg-active' : ''}`}
        >
          {PHASES[p]}
        </button>
      ))}
    </div>
  )
}
