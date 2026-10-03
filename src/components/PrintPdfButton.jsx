import { Printer } from 'lucide-react'

/**
 * PrintPdfButton — the "Export PDF" half of every export row.
 *
 * Deliberately uses the BROWSER's Print-to-PDF rather than a JS PDF engine:
 * no new dependency, works offline, and it reuses the page's own layout so the
 * PDF matches what the user is looking at (the `@media print` block in
 * index.css is what turns a phone's stacked cards into a real table and strips
 * the chrome). On iOS/Android the print sheet's destination is literally
 * "Save to Files / PDF", so one tap gets a file.
 *
 * `onBeforePrint` runs before the print dialog opens — an open bottom sheet
 * must unmount first, or the overlay prints instead of the report.
 */
export default function PrintPdfButton({
  onBeforePrint,
  label = 'Export PDF',
  className = 'btn',
  style,
  ariaLabel,
}) {
  const run = () => {
    if (!onBeforePrint) {
      // nothing to dismiss — print now, so the action is immediate and
      // observable (a deferred print is invisible to tests and to anyone
      // who tapped the button).
      window.print()
      return
    }
    // An overlay must unmount first, or the overlay is what lands in the PDF.
    // Two frames: let React finish tearing the sheet down before the dialog
    // snapshots the document.
    onBeforePrint()
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }
  return (
    <button
      type="button"
      onClick={run}
      className={className}
      style={style}
      aria-label={ariaLabel || label}
    >
      <Printer size={13} /> {label}
    </button>
  )
}
