/**
 * The centre × sewa-day heatmap must FIT a phone.
 *
 * Why a browser test and not a unit test: this is pure CSS geometry — how wide
 * the pinned Centre pane is allowed to get, whether the day columns hug their
 * `12/15` glyphs instead of stretching to fill the card, and whether the
 * `.att-table { min-width: 46rem }` floor still forces a horizontal scroll.
 * jsdom does no layout, so a unit test can only assert that the markup exists
 * while the grid stays unusable. Computed + measured geometry is the only
 * honest proof.
 *
 * The two regressions pinned here, both real and both shipped:
 *   1. `white-space: nowrap` let "AREA SECRETARY OFFICE" size the pinned pane
 *      to 271.9px of a 310px scroll box at 375px — half a day column of data
 *      visible, and a NEGATIVE remainder at 320px. The intended `.att-name`
 *      ellipsis guard was inert (max-width/text-overflow do not apply to an
 *      inline <span> inside a <th>).
 *   2. `width: 100%` + `min-width: 46rem` stretched every day column across
 *      the card and forced a 736px minimum regardless of column count, so the
 *      user had to scroll to read `12/15`.
 *
 * `.att-centre-sub` ("15 sewas") is asserted ABSENT — it was a second line of
 * identity in every row that bought nothing the Total column did not say.
 */
import { test, expect } from '@playwright/test'

/** Worst-case content: long centre names, a full 5-day visit, ratios up to 40/60. */
const DAYS = [
  ['Oct', '5'],
  ['Oct', '6'],
  ['Oct', '7'],
  ['Oct', '8'],
  ['Oct', '9'],
]
const CENTRES = ['AREA SECRETARY OFFICE', 'SECTOR-15-A', 'SECTOR-21-B']

async function mountFixture(page) {
  await page.goto('/')
  await page.evaluate(
    ({ days, centres }) => {
      const host = document.createElement('div')
      host.id = 'css-fixture'
      host.innerHTML = `
        <div class="page">
        <div class="card">
          <div class="att-matrix">
            <div class="att-scroll" tabindex="0" role="region" aria-label="Scrollable centre attendance grid">
              <!-- min-width mirrors the component's inline floor:
                   Math.max(300, columns.length * 62) for a 5-day visit = 310px.
                   Without it the spec would test the CSS while skipping the
                   component's own sizing — the fixture must not be more
                   forgiving than production. -->
              <table class="att-table att-table-centre" style="min-width: 310px">
                <caption>Present by centre and sewa day</caption>
                <thead><tr>
                  <th class="att-col-badge" scope="col">Centre</th>
                  ${days
                    .map(
                      ([mon, num]) =>
                        `<th class="att-day" scope="col"><span class="att-day-wd">${mon}</span><span class="att-day-num">${num}</span></th>`,
                    )
                    .join('')}
                  <th class="att-days" scope="col">Total</th>
                </tr></thead>
                <tbody>
                  ${centres
                    .map(
                      (c) => `
                  <tr>
                    <th class="att-col-badge" scope="row"><span class="att-name">${c}</span></th>
                    ${days
                      .map(
                        () =>
                          '<td class="att-cell att-partial"><span class="att-mark">10/12</span><span class="sr-only">10 of 12 present</span></td>',
                      )
                      .join('')}
                    <td class="att-days">40/60</td>
                  </tr>`,
                    )
                    .join('')}
                  <tr class="att-total-row">
                    <th class="att-col-badge" scope="row">All centres</th>
                    ${days.map(() => '<td class="att-cell"><span class="att-mark">30/36</span></td>').join('')}
                    <td class="att-days">120/180</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </div>
      `
      document.body.appendChild(host)
    },
    { days: DAYS, centres: CENTRES },
  )
}

/** Measured geometry — no CSSOM guessing. */
const measure = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('.att-scroll')
    const table = document.querySelector('table.att-table-centre')
    const b = box.getBoundingClientRect()
    const dayHeaders = [...table.querySelectorAll('thead th.att-day')]
    let visibleDays = 0
    for (const th of dayHeaders) {
      const r = th.getBoundingClientRect()
      if (r.left >= b.left - 1 && r.right <= b.right + 1) visibleDays += 1
    }
    // A ratio like `12/15` is one unbreakable token. Under table-layout:fixed
    // a too-narrow day column makes it WRAP to two lines (or clip) rather than
    // widen the table — the quiet failure mode of this technique, invisible
    // unless you measure it. .att-mark has line-height:1, so >1.5em tall = 2 lines.
    const marks = [...table.querySelectorAll('.att-mark')]
    let wrappedMarks = 0
    for (const m of marks) {
      const fs = parseFloat(getComputedStyle(m).fontSize) || 12
      if (m.getBoundingClientRect().height > fs * 1.5) wrappedMarks += 1
    }
    const firstDay = table.querySelector('td.att-cell')
    const dayCellW = firstDay ? Math.round(firstDay.getBoundingClientRect().width) : 0
    // Headroom: is the widest ratio narrower than its cell's content box?
    // wrappedMarks only proves the text did not break; this says how much
    // slack is left before it would, which is what decides whether the day
    // type can be raised to a readable size.
    let markW = 0
    let cellInnerW = 0
    if (firstDay) {
      const cs = getComputedStyle(firstDay)
      cellInnerW = Math.round(
        firstDay.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      )
      const mk = firstDay.querySelector('.att-mark')
      if (mk) markW = Math.round(mk.getBoundingClientRect().width)
    }

    const name = table.querySelector('tbody th.att-col-badge .att-name')
    const nameCs = getComputedStyle(name)
    const badge = table.querySelector('tbody th.att-col-badge')
    return {
      viewport: window.innerWidth,
      pageScroll: document.documentElement.scrollWidth,
      tableScroll: table.scrollWidth,
      boxW: box.clientWidth,
      totalDays: dayHeaders.length,
      visibleDays,
      badgeW: Math.round(badge.getBoundingClientRect().width),
      hasSubLine: !!table.querySelector('.att-centre-sub'),
      nameWhiteSpace: nameCs.whiteSpace,
      nameClipped: name.scrollWidth > name.clientWidth + 1,
      // no ratio cell may wrap or clip — the numbers must stay readable
      wrappedMarks,
      dayCellW,
      markW,
      cellInnerW,
      // the whole table must be inside the box — no horizontal scroll at all
      fitsWithoutScroll: table.scrollWidth <= box.clientWidth + 1,
    }
  })

test.describe('centre × day heatmap on phones', () => {
  for (const width of [320, 360, 375, 414]) {
    test(`fits at ${width}px — day columns visible, no horizontal scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await mountFixture(page)
      const m = await measure(page)
      // geometry, printed so a failure shows real numbers rather than a boolean
      console.log(`  [${width}px] ${JSON.stringify(m)}`)

      // the document itself never scrolls sideways (sr-only labels stay clipped)
      expect(m.pageScroll, `page overflows at ${width}px`).toBeLessThanOrEqual(m.viewport + 1)
      // the identity sub-line is gone
      expect(m.hasSubLine).toBe(false)
      // the centre name wraps rather than truncating
      expect(m.nameWhiteSpace).toBe('normal')
      expect(m.nameClipped).toBe(false)
      expect(m.wrappedMarks, `${m.wrappedMarks} ratio cells wrapped at ${width}px`).toBe(0)
      // the pinned pane stays a minority of the scroll box
      expect(m.badgeW, `pinned pane too wide at ${width}px`).toBeLessThanOrEqual(
        Math.round(m.boxW * 0.4),
      )
      // the day columns are the point — at least 2 must be fully readable
      expect(m.visibleDays, `only ${m.visibleDays} day columns visible at ${width}px`).toBeGreaterThanOrEqual(2)
      // at every normal phone width the grid fits outright: no scrolling
      if (width >= 360) {
        expect(m.fitsWithoutScroll, `still scrolls at ${width}px (${m.tableScroll} > ${m.boxW})`).toBe(true)
      }
    })
  }

  test('control: without the opt-in class the same markup still forces the 46rem scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/')
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'css-fixture'
      host.innerHTML = `
        <div class="card">
          <div class="att-scroll">
            <table class="att-table">
              <thead><tr><th class="att-col-badge" scope="col">Centre</th><th class="att-day" scope="col">Oct<br>5</th></tr></thead>
              <tbody><tr><th class="att-col-badge" scope="row"><span class="att-name">AREA SECRETARY OFFICE</span></th><td class="att-cell"><span class="att-mark">10/12</span></td></tr></tbody>
            </table>
          </div>
        </div>
      `
      document.body.appendChild(host)
    })
    const scroll = await page.evaluate(() => {
      const box = document.querySelector('.att-scroll')
      const table = box.querySelector('table')
      return { tableScroll: table.scrollWidth, boxW: box.clientWidth }
    })
    // proves the opt-in is doing the work rather than a stray global rule
    expect(scroll.tableScroll).toBeGreaterThan(scroll.boxW)
  })
})
