/**
 * Lock readiness for the Consent & Deploy page (v86).
 *
 * Centre roles edit everything — including already-deployed sewadars — until
 * the CENTRE locks. This module turns the page's counts into the three
 * checklist items the readiness panel shows, plus whether Lock can proceed.
 */

/**
 * @typedef {'done' | 'todo' | 'info'} ReadinessTone
 * @typedef {{ id: string, label: string, value: string, hint: string, tone: ReadinessTone }} ReadinessItem
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * @param {{
 *   total: number,            // sewadars in scope
 *   consented: number,        // consent = Yes
 *   deployed: number,         // sewadars with a department
 *   seats: number,            // seats the ASO allocated (sum of max_count)
 *   inchargesNeeded: number,  // departments that need an incharge
 *   inchargesMissing: number, // of those, how many have none yet
 * }} counts
 * @returns {{ items: ReadinessItem[], canLock: boolean, blocker: string | null }}
 */
export function lockReadiness(counts) {
  const total = Math.max(0, counts.total || 0)
  const consented = Math.max(0, counts.consented || 0)
  const deployed = Math.max(0, counts.deployed || 0)
  const seats = Math.max(0, counts.seats || 0)
  const needed = Math.max(0, counts.inchargesNeeded || 0)
  const missing = Math.min(needed, Math.max(0, counts.inchargesMissing || 0))
  const inchargesSet = needed - missing
  const seatsLeft = Math.max(0, seats - deployed)

  const items = [
    {
      id: 'consent',
      label: 'Consent',
      value: `${consented}/${total}`,
      hint: `${plural(consented, 'sewadar')} said Yes`,
      tone: 'info',
    },
    {
      id: 'seats',
      label: 'Seats filled',
      value: seats > 0 ? `${deployed}/${seats}` : String(deployed),
      hint: seats === 0
        ? 'No seats allocated yet'
        : seatsLeft === 0 ? 'All allocated seats filled' : `${plural(seatsLeft, 'seat')} still open`,
      tone: seats > 0 && seatsLeft === 0 ? 'done' : 'todo',
    },
    {
      id: 'incharges',
      label: 'Incharges',
      value: `${inchargesSet}/${needed}`,
      hint: needed === 0
        ? 'Assign sewadars first'
        : missing === 0 ? 'Every department has one' : `${plural(missing, 'department')} without an incharge`,
      tone: needed > 0 && missing === 0 ? 'done' : 'todo',
    },
  ]

  const blocker = missing > 0
    ? `Add ${missing === 1 ? 'the missing incharge' : `${missing} missing incharges`} to lock`
    : null

  return { items, canLock: missing === 0, blocker }
}

/**
 * "Locked by Asha · 10 Nov, 4:12 pm" — tolerant of a missing name or time.
 * @param {{ locked_by?: string | null, locked_at?: string | null } | null} lock
 * @returns {string}
 */
export function lockedByLine(lock) {
  if (!lock) return ''
  const parts = []
  if (lock.locked_by) parts.push(`Locked by ${lock.locked_by}`)
  if (lock.locked_at) {
    const d = new Date(lock.locked_at)
    if (!Number.isNaN(d.getTime())) {
      const when = d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      parts.push(parts.length ? when : `Locked ${when}`)
    }
  }
  return parts.join(' · ')
}
