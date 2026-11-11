import { Lock, Unlock, CheckCircle2, Circle } from 'lucide-react'
import { lockReadiness, lockedByLine } from '../lib/lockReadiness'

/**
 * Consent & Deploy status panel (v86): tells centre users they can change
 * anything — including deployed sewadars — until they lock, shows the three
 * things to finish first, and owns the Lock CTA. Once locked it becomes the
 * read-only notice with who locked and when.
 *
 * @param {{
 *   locked: boolean,
 *   lockInfo?: { locked_by?: string | null, locked_at?: string | null } | null,
 *   counts: Parameters<typeof lockReadiness>[0],
 *   canLockHere: boolean,   // false for an SC_SP account (its CENTRE locks)
 *   lockBusy?: boolean,
 *   onLock: () => void,
 * }} props
 */
export default function LockReadinessPanel({ locked, lockInfo = null, counts, canLockHere, lockBusy = false, onLock }) {
  if (locked) {
    const by = lockedByLine(lockInfo)
    return (
      <section className="lock-panel lock-panel--locked" aria-label="Deployment status">
        <div className="lock-panel__icon" aria-hidden="true"><Lock size={18} /></div>
        <div className="lock-panel__body">
          <h3 className="lock-panel__title">Deployment locked</h3>
          <p className="lock-panel__text">
            {by ? `${by}. ` : ''}Consent, departments and incharges are now read-only. Ask the ASO to unlock if something needs to change.
          </p>
        </div>
      </section>
    )
  }

  const { items, canLock, blocker } = lockReadiness(counts)
  return (
    <section className="lock-panel" aria-label="Deployment status">
      <div className="lock-panel__icon" aria-hidden="true"><Unlock size={18} /></div>
      <div className="lock-panel__body">
        <h3 className="lock-panel__title">Editing is open until you lock</h3>
        <p className="lock-panel__text">
          Change consent, department, stay at Bhati or chair pass for anyone — including sewadars already deployed. Changes save automatically.
        </p>
        <ul className="lock-panel__steps">
          {items.map(it => (
            <li key={it.id} className={`lock-step lock-step--${it.tone}`}>
              {it.tone === 'done'
                ? <CheckCircle2 size={15} className="lock-step__glyph" aria-hidden="true" />
                : <Circle size={15} className="lock-step__glyph" aria-hidden="true" />}
              <span className="lock-step__label">{it.label}</span>
              <span className="lock-step__value">{it.value}</span>
              <span className="lock-step__hint">{it.hint}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="lock-panel__action">
        {canLockHere ? (
          <>
            <button type="button" className="btn lock-panel__btn" onClick={onLock} disabled={lockBusy}>
              <Lock size={14} aria-hidden="true" /> {lockBusy ? 'Locking…' : 'Lock deployment'}
            </button>
            <span className={canLock ? 'lock-panel__note' : 'lock-panel__note lock-panel__note--warn'}>{blocker || 'Final step — makes everything read-only'}</span>
          </>
        ) : (
          <span className="lock-panel__note">Your CENTRE account locks this deployment for your SC_SP too.</span>
        )}
      </div>
    </section>
  )
}
