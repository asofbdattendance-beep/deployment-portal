/**
 * Reports on phones must be a ROW/COLUMN table, not stacked cards.
 *
 * Why a browser test and not a unit test: `.rows-on-phone` has to OUTRANK a
 * pile of `.table tbody td` collapse rules that all live inside the same
 * `@media (max-width: 768px)` block. That is pure CSS specificity/order, and
 * it fails silently — the report still renders, it just renders as the very
 * cards the user complained about. Computed style is the only honest proof.
 *
 * Also pins the `@media print` half of "Export PDF": a phone's print page box
 * can be narrow enough for the collapse to match, so the print rules must force
 * a table back and strip the phone chrome out of the PDF.
 */
import { test, expect } from '@playwright/test'

/** Build a fixture with BOTH an opted-in and a plain report table. */
async function mountFixture(page) {
  await page.goto('/')
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'css-fixture'
    host.innerHTML = `
      <div class="table-wrap table-wrap-sticky table-wrap-rows">
        <table class="table table-sticky rows-on-phone">
          <thead><tr><th scope="col">Badge</th><th scope="col">Name</th></tr></thead>
          <tbody><tr><td data-label="Badge">FB0001</td><td data-label="Name">RAM</td></tr></tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Badge</th></tr></thead>
          <tbody><tr><td data-label="Badge">FB0002</td></tr></tbody>
        </table>
      </div>
      <div class="mobile-tabbar" style="height:56px">tabbar</div>
      <div class="page-header"><button class="btn btn-primary">Export PDF</button></div>
    `
    document.body.appendChild(host)
  })
}

/** Computed-style snapshot of the fixture. */
const readStyles = (page) =>
  page.evaluate(() => {
    const one = (sel) => getComputedStyle(document.querySelector(sel))
    const pseudo = (sel, which) => getComputedStyle(document.querySelector(sel), which)
    const doc = document.documentElement
    return {
      gridTable: one('table.rows-on-phone').display,
      gridHead: one('table.rows-on-phone thead').display,
      gridRow: one('table.rows-on-phone tbody tr').display,
      gridCell: one('table.rows-on-phone tbody td').display,
      // the card label prefix — must be gone in grid mode
      label: pseudo('table.rows-on-phone tbody td', '::before').content,
      pinnedCell: one('table.rows-on-phone tbody td').position,
      pinnedHeader: one('table.rows-on-phone thead th').position,
      wrapperOverflow: one('.table-wrap-rows').overflow,
      // NEGATIVE CONTROL: the same markup without the opt-out stays collapsed
      plainTable: one('.table-wrap:not(.table-wrap-rows) .table').display,
      plainCell: one('.table-wrap:not(.table-wrap-rows) tbody td').display,
      noHorizScroll: doc.scrollWidth <= window.innerWidth + 1,
      // print state
      printTable: one('table.rows-on-phone').display,
      printTabbar: one('.mobile-tabbar').display,
      printButton: one('.page-header .btn').display,
      printSticky: one('table.rows-on-phone tbody td').position,
    }
  })

test.describe('report tables on phones', () => {
  test('stays a real row/column grid — the card collapse is opted out', async ({ page }) => {
    await mountFixture(page)
    const s = await readStyles(page)

    // the opted-in table keeps table semantics…
    expect(s.gridTable).toBe('table')
    expect(s.gridHead).toBe('table-header-group')
    expect(s.gridRow).toBe('table-row')
    expect(s.gridCell).toBe('table-cell')
    // …and every cell label prefix (the thing that made cards so tall) is gone
    expect(s.label).toBe('none')

    // control: WITHOUT the class the very same markup collapses to cards,
    // which proves the opt-out is doing the work rather than a stray rule.
    expect(s.plainTable).toBe('block')
    // the collapsed row is `flex` — it is one label/value line pair per cell
    expect(s.plainCell).toBe('flex')

    // pinned Badge column + pinned header inside a scroll box
    expect(s.pinnedCell).toBe('sticky')
    expect(s.pinnedHeader).toBe('sticky')
    expect(s.wrapperOverflow).not.toBe('visible')

    // a wide grid must scroll inside its wrapper, never widen the document
    expect(s.noHorizScroll).toBe(true)
  })

  test('Print-to-PDF emits a table and strips the phone chrome', async ({ page }) => {
    await mountFixture(page)
    // a phone's print page box can be narrow enough for the ≤768px card
    // collapse to match — the print rules have to win regardless.
    await page.emulateMedia({ media: 'print' })
    const s = await readStyles(page)

    expect(s.printTable).toBe('table')
    expect(s.printTabbar).toBe('none')       // no nav in the PDF
    expect(s.printButton).toBe('none')       // no controls in the PDF
    expect(s.printSticky).toBe('static')     // sticky columns clip on a page edge
  })
})
