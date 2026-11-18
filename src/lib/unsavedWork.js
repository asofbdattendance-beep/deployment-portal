/**
 * Unsaved-work registry — lets the auto-update (SwUpdatePrompt) reload the
 * portal ONLY when that cannot lose anything the user typed or is saving.
 *
 * Autosave pages register a check (dirty || saving). On top of that the DOM
 * is checked conservatively: an open modal/sheet/drawer, a focused field,
 * any filled-in form field, or a live camera all count as "busy".
 */
const checks = new Set()

/** Register `fn` (returns true while work is unsaved). Returns unregister. */
export function registerUnsavedWork(fn) {
  checks.add(fn)
  return () => { checks.delete(fn) }
}

export function hasUnsavedWork(doc = typeof document !== 'undefined' ? document : null) {
  for (const fn of checks) {
    try { if (fn()) return true } catch { return true }
  }
  if (!doc) return false
  if (doc.querySelector('.modal-overlay, .mobile-sheet-overlay, .drawer-overlay, [role="dialog"], [role="alertdialog"], dialog[open]')) return true
  const a = doc.activeElement
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return true
  for (const el of doc.querySelectorAll('form input, form textarea')) {
    const t = (el.type || '').toLowerCase()
    if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'search'].includes(t)) continue
    if (String(el.value || '').trim() !== '') return true
  }
  for (const v of doc.querySelectorAll('video')) {
    if (v.srcObject && !v.paused) return true
  }
  return false
}
