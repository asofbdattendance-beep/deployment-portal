#!/usr/bin/env python3
"""October Visit 2026 — Portal attendance vs ZIMS report, DEPLOYED sewadars only.

Inputs (read-only):
  PORTAL (source of truth): reports/oct-visit-2026-source-of-truth/October-Visit-2026-Source-of-Truth.xlsx
                            sheet "Attendance Truth" -> portal attendance per day.
  ZIMS                    : /Users/jai/Downloads/attendance-report-detailed-171026105800.xlsx
  DEPLOYED ROSTER (filter): /Users/jai/Documents/GitHub/Db Backups/backups/2026-10-13/portal-local/deployments.jsonl.gz

Non-deployed rows are excluded: the 59 "undeployed scan" badges and the 2
owner-added override rows are NOT part of the deployment roster.

DEPARTMENT SPLIT (owner instruction):
  TRAFFIC OUTSIDE BHATI is pulled OUT of the two main reports and given its own
  sheet, accounted over ONLY 3 days — Fri 09-Oct, Sat 10-Oct, Sun 11-Oct — which
  is that department's duty window. (Its portal presence is 59/100/431/439/441
  across Wed..Sun while ZIMS holds just 5 marks for the whole department, so a
  5-day view of it is meaningless.) "TRAFFIC INSIDE" is a different department
  and is NOT touched.
  The two main reports therefore cover the remaining sewadars over all 5 days.

DAY CELLS — plain words, no letters to decode, one shared vocabulary:
    Missing in ZIMS    portal has him, ZIMS has nothing          <- Report 1's gap
    Missing in Portal  ZIMS has him, portal has nothing          <- Report 2's gap
    Both present       both systems recorded him that day
    Both absent        neither system recorded him that day

Output: reports/oct-visit-2026-attendance-gap/October-Visit-2026-Attendance-Gap.xlsx
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
from collections import defaultdict

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, "..", ".."))
PORTAL_PATH = os.path.join(
    REPO, "reports", "oct-visit-2026-source-of-truth", "October-Visit-2026-Source-of-Truth.xlsx"
)
ZIMS_PATH = "/Users/jai/Downloads/attendance-report-detailed-171026105800.xlsx"
ROSTER_PATH = "/Users/jai/Documents/GitHub/Db Backups/backups/2026-10-13/portal-local/deployments.jsonl.gz"
OUT_PATH = os.path.join(BASE, "October-Visit-2026-Attendance-Gap.xlsx")

# (column heading, portal IN col, portal OUT col, day-of-month)
DAYS_ALL = [
    ("Wed 07-Oct", 4, 5, 7),
    ("Thu 08-Oct", 6, 7, 8),
    ("Fri 09-Oct", 8, 9, 9),
    ("Sat 10-Oct", 10, 11, 10),
    ("Sun 11-Oct", 12, 13, 11),
]
DAYS_TRAFFIC = DAYS_ALL[2:]          # Fri, Sat, Sun only
ABSENT = "Absent"

TRAFFIC_DEPT = "TRAFFIC OUTSIDE BHATI"

MZ = "Missing in ZIMS"
MP = "Missing in Portal"
BP = "Both present"
BA = "Both absent"

TITLE_1 = "Present in the Deployment portal attendance but not in the ZIMS Report"
TITLE_2 = "Present in the ZIMS REPORT but not in the SEWADAR ATTENDANCE"
TITLE_T = "TRAFFIC OUTSIDE BHATI — portal attendance vs ZIMS, Fri-Sun only"

TAB_1 = "1 Portal not in ZIMS"
TAB_2 = "2 ZIMS not in Portal"
TAB_T = "TRAFFIC OUTSIDE BHATI"

CELL_STYLE = {
    MZ: {"fill": "FCE4D6", "color": "C00000", "bold": True},
    MP: {"fill": "FFF2CC", "color": "833C00", "bold": True},
    BP: {"fill": "E2EFDA", "color": "375623", "bold": False},
    BA: {"fill": None,      "color": "808080", "bold": False},
}


def norm(v) -> str:
    return "" if v is None else str(v).strip()


def present_cell(v) -> bool:
    s = norm(v)
    return s != "" and s != ABSENT


# ----------------------------------------------------- deployed roster filter
with gzip.open(ROSTER_PATH, "rt") as fh:
    deployed = {json.loads(line)["badge_number"] for line in fh if line.strip()}
assert len(deployed) == 2587, f"expected 2587 deployed badges, got {len(deployed)}"

# ------------------------------------------------------------- portal (truth)
portal: dict[str, dict] = {}
portal_present: dict[str, set[int]] = defaultdict(set)
excluded_row = 0

wb = load_workbook(PORTAL_PATH, read_only=True, data_only=True)
ws = wb["Attendance Truth"]
prows = list(ws.iter_rows(values_only=True))
wb.close()

for r in prows[2:]:
    badge = norm(r[0])
    if not badge:
        continue
    if badge not in deployed:          # drop undeployed scans + override-added rows
        excluded_row += 1
        continue
    portal[badge] = {"name": norm(r[1]), "centre": norm(r[2]), "dept": norm(r[3])}
    for _label, ci, co, day in DAYS_ALL:
        if present_cell(r[ci]) or present_cell(r[co]):
            portal_present[badge].add(day)

# -------------------------------------------------------------------- ZIMS
zims_present: dict[str, set[int]] = defaultdict(set)

wb = load_workbook(ZIMS_PATH, read_only=True, data_only=True)
ws = wb.active
it = ws.iter_rows(values_only=True)
hdr = [norm(h) for h in next(it)]
ix = {name: i for i, name in enumerate(hdr)}
wb.close()

DAY_BY_DATE = {f"2026-10-{d:02d}": d for d in range(7, 12)}
assert set(DAY_BY_DATE) == {"2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"}

for r in it:
    if r is None or r[ix["Badge Number"]] is None:
        continue
    badge = norm(r[ix["Badge Number"]])
    if badge not in deployed:
        continue
    raw = r[ix["Duty Date"]]
    day = raw.date() if isinstance(raw, dt.datetime) else raw
    nd = DAY_BY_DATE.get(day.isoformat() if isinstance(day, dt.date) else "")
    if nd:
        zims_present[badge].add(nd)

# ------------------------------------------------------------ department split
traffic = sorted(b for b in deployed if portal.get(b, {}).get("dept", "") == TRAFFIC_DEPT)
other = sorted(b for b in deployed if portal.get(b, {}).get("dept", "") != TRAFFIC_DEPT)
assert len(traffic) == 594, f"expected 594 TRAFFIC OUTSIDE BHATI, got {len(traffic)}"
assert len(traffic) + len(other) == 2587


def cell_word(p: bool, z: bool) -> str:
    if p and z:
        return BP
    if p:
        return MZ
    if z:
        return MP
    return BA


def make_rows(badges, days):
    out = []
    for badge in badges:
        pset = portal_present.get(badge, set())
        zset = zims_present.get(badge, set())
        meta = portal.get(badge, {})
        words = [cell_word(d in pset, d in zset) for _l, _ci, _co, d in days]
        out.append([
            badge, meta.get("name", ""), meta.get("centre", ""), meta.get("dept", ""),
            sum(1 for _l, _ci, _co, d in days if d in pset),
            sum(1 for _l, _ci, _co, d in days if d in zset),
        ] + words)
    return out


r1_rows = [r for r in make_rows(other, DAYS_ALL) if MZ in r[6:]]
r2_rows = [r for r in make_rows(other, DAYS_ALL) if MP in r[6:]]
tr_rows = make_rows(traffic, DAYS_TRAFFIC)          # every traffic sewadar, gap or not

for rows in (r1_rows, r2_rows, tr_rows):
    rows.sort(key=lambda r: (r[2], r[1], r[0]))

# ------------------------------------------------------------- console proof
print(f"deployed roster badges   : {len(deployed)}")
print(f"portal rows after filter : {len(portal)}  (non-deployed rows dropped: {excluded_row})")
print(f"ZIMS badges after filter : {len(zims_present)}")
print(f"split: TRAFFIC OUTSIDE BHATI={len(traffic)}  other={len(other)}")
print()
print(f"Report 1 (other, 5 days)={len(r1_rows)} sewadars   Report 2 (other, 5 days)={len(r2_rows)} sewadars")
print(f"Traffic sheet (3 days)   ={len(tr_rows)} sewadars")
print()
print("per-day gap counts:")
for k, (lbl, _ci, _co, _d) in enumerate(DAYS_ALL):
    mz_ = sum(1 for r in r1_rows if r[6 + k] == MZ)
    mp_ = sum(1 for r in r2_rows if r[6 + k] == MP)
    print(f"  {lbl}   Missing in ZIMS={mz_:4d}   Missing in Portal={mp_:4d}")
print()
print(f"report1 'Missing in ZIMS' cells   = {sum(1 for r in r1_rows for c in r[6:] if c == MZ)}")
print(f"report2 'Missing in Portal' cells = {sum(1 for r in r2_rows for c in r[6:] if c == MP)}")
for k, (lbl, _ci, _co, _d) in enumerate(DAYS_TRAFFIC):
    mz_ = sum(1 for r in tr_rows if r[6 + k] == MZ)
    mp_ = sum(1 for r in tr_rows if r[6 + k] == MP)
    bp_ = sum(1 for r in tr_rows if r[6 + k] == BP)
    ba_ = sum(1 for r in tr_rows if r[6 + k] == BA)
    print(f"  traffic {lbl}: MissingInZIMS={mz_:4d} MissingInPortal={mp_:3d} BothPresent={bp_:4d} BothAbsent={ba_:4d}")
print(f"traffic rows with >=1 gap = {sum(1 for r in tr_rows if MZ in r[6:] or MP in r[6:])}")

# ------------------------------------------------------------------- workbook
HDR_FILL = PatternFill("solid", fgColor="1F3864")
HDR_FONT = Font(bold=True, color="FFFFFF", name="Arial", size=10)
TITLE_FONT = Font(bold=True, color="1F3864", name="Arial", size=12)
BODY_FONT = Font(name="Arial", size=10)
BOLD_FONT = Font(name="Arial", size=10, bold=True)
LBL_FONT = Font(bold=True, name="Arial", size=10, color="1F3864")
NOTE_FONT = Font(name="Arial", size=10, italic=True)


def build_report_sheet(sheet, title, subtitle, days, gap_words, rows, note=None):
    ncols = 6 + len(days) + 1
    headers = ["Badge", "Name", "Centre", "Department",
               f"Portal days (of {len(days)})", f"ZIMS days (of {len(days)})",
               *[lbl for lbl, _ci, _co, _d in days], "Gap days"]

    sheet.cell(row=1, column=1, value=title).font = TITLE_FONT
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
    sheet.cell(row=1, column=1).alignment = Alignment(vertical="center")

    sheet.cell(row=2, column=1, value=subtitle).font = LBL_FONT
    sheet.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)

    hdr_row = 3
    if note:
        sheet.cell(row=3, column=1, value=note).font = NOTE_FONT
        sheet.merge_cells(start_row=3, start_column=1, end_row=3, end_column=ncols)
        hdr_row = 4

    for c, h in enumerate(headers, start=1):
        cell = sheet.cell(row=hdr_row, column=c, value=h)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)

    first_data = hdr_row + 1
    for i, row in enumerate(rows):
        r = first_data + i
        for c, v in enumerate(row, start=1):
            sheet.cell(row=r, column=c, value=v).font = BODY_FONT
        n_gap = sum(1 for c in row[6:] if c in gap_words)
        sheet.cell(row=r, column=ncols, value=n_gap).font = BOLD_FONT
        for k in range(len(days)):
            cell = sheet.cell(row=r, column=7 + k)
            st = CELL_STYLE[cell.value]
            cell.font = Font(name="Arial", size=10, bold=st["bold"], color=st["color"])
            if st["fill"]:
                cell.fill = PatternFill("solid", fgColor=st["fill"])

    sheet.freeze_panes = f"C{first_data}"
    sheet.auto_filter.ref = f"A{hdr_row}:{get_column_letter(ncols)}{sheet.max_row}"
    widths = [15, 26, 22, 21, 11, 11] + [16] * len(days) + [13]
    for i, w in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(i)].width = w
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.page_margins.left = sheet.page_margins.right = 0.5
    sheet.print_title_rows = f"1:{hdr_row}"
    sheet.print_area = f"A1:{get_column_letter(ncols)}{sheet.max_row}"


wb = Workbook()

# ------------------------------------------------------------------- Summary
ws = wb.active
ws.title = "Summary"
ws.cell(row=1, column=1,
        value="October Visit 2026 — Portal attendance vs ZIMS report (deployed sewadars only)").font = TITLE_FONT

ws.cell(row=3, column=1, value="What is on each sheet").font = HDR_FONT
ws.cell(row=3, column=1).fill = HDR_FILL
what = [
    "1 Portal not in ZIMS   — Portal present, ZIMS missing. TRAFFIC OUTSIDE BHATI removed. All 5 days (Wed-Sun).",
    "2 ZIMS not in Portal   — ZIMS marked, portal missing. TRAFFIC OUTSIDE BHATI removed. All 5 days (Wed-Sun).",
    "TRAFFIC OUTSIDE BHATI  — that department on its own, Fri-Sat-Sun ONLY (3 days). Every sewadar of the department is listed.",
    "TRAFFIC INSIDE is a different department and is NOT touched - it stays inside sheets 1 and 2.",
    "",
    "Why TRAFFIC OUTSIDE BHATI is separate and 3 days:",
    "  Portal presence for the department is 59 / 100 / 431 / 439 / 441 across Wed..Sun, but ZIMS holds only 5 marks for",
    "  the whole department. A 5-day comparison of it is therefore meaningless - it belongs on its own Fri-Sun window.",
]
for i, t in enumerate(what):
    ws.cell(row=4 + i, column=1, value=t).font = BODY_FONT

ws.cell(row=14, column=1, value="How to read the day columns").font = HDR_FONT
ws.cell(row=14, column=1).fill = HDR_FILL
how = [
    "Missing in ZIMS    - portal says present, ZIMS has no record that day.  (sheet 1's gap)",
    "Missing in Portal  - ZIMS marked him, portal has no attendance that day. (sheet 2's gap)",
    "Both present       - both systems recorded him. Nothing to chase.",
    "Both absent        - neither system recorded him. Nothing to chase.",
    "'Gap days' counts the day-cells in that row that hold a gap word.",
    "Sheet 1 and 2 list only sewadars who have at least one day of their own gap.",
    "The TRAFFIC sheet lists the whole department, so it also contains rows with Gap days = 0.",
]
for i, t in enumerate(how):
    ws.cell(row=15 + i, column=1, value=t).font = BODY_FONT

ws.cell(row=23, column=1, value="Sources").font = HDR_FONT
ws.cell(row=23, column=1).fill = HDR_FILL
for i, (k, v) in enumerate([
    ("Deployment portal attendance", PORTAL_PATH),
    ("ZIMS report", ZIMS_PATH),
    ("Deployed roster (filter)", ROSTER_PATH),
]):
    ws.cell(row=24 + i, column=1, value=k).font = BODY_FONT
    ws.cell(row=24 + i, column=2, value=v).font = BODY_FONT

ws.cell(row=28, column=1, value="Filter").font = BODY_FONT
ws.cell(row=28, column=2,
        value="Deployed sewadars only (2,587 badges from the 2026-10-13 backup roster). "
              "Non-deployed scans and owner-added override rows are excluded. "
              "TRAFFIC OUTSIDE BHATI = 594, remaining = 1,993.").font = BODY_FONT
ws.cell(row=29, column=1, value="Note").font = BODY_FONT
ws.cell(row=29, column=2,
        value="All figures are precomputed values, not spreadsheet formulas "
              "(this build environment has no LibreOffice to recalculate formula cells).").font = BODY_FONT

ws.cell(row=31, column=1, value="Totals").font = HDR_FONT
ws.cell(row=31, column=1).fill = HDR_FILL
for c, h in enumerate(["Sheet", "Sewadars", "Gap days", "Wed 07-Oct", "Thu 08-Oct",
                       "Fri 09-Oct", "Sat 10-Oct", "Sun 11-Oct"], start=1):
    cell = ws.cell(row=31, column=c, value=h)
    cell.fill = HDR_FILL
    cell.font = HDR_FONT

tot_rows = [
    (TITLE_1, DAYS_ALL, [MZ], r1_rows),
    (TITLE_2, DAYS_ALL, [MP], r2_rows),
    (TAB_T, DAYS_TRAFFIC, [MZ, MP], tr_rows),
]
for i, (title, days, gaps, rows) in enumerate(tot_rows):
    r = 32 + i
    ws.cell(row=r, column=1, value=title).font = BODY_FONT
    ws.cell(row=r, column=2, value=len(rows)).font = BODY_FONT
    ws.cell(row=r, column=3, value=sum(1 for x in rows for c in x[6:] if c in gaps)).font = BODY_FONT
    for k, (lbl, _ci, _co, _d) in enumerate(days):
        ws.cell(row=r, column=4 + k,
                value=sum(1 for x in rows if x[6 + k] in gaps)).font = BODY_FONT
    for k in range(len(days), 5):
        ws.cell(row=r, column=4 + k, value="n/a").font = BODY_FONT

for col, w in zip("ABCDEFGH", [24, 34, 12, 12, 12, 12, 12, 12]):
    ws.column_dimensions[col].width = w
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.page_margins.left = ws.page_margins.right = 0.5
ws.print_area = f"A1:H{ws.max_row}"

ws1 = wb.create_sheet(TAB_1)
build_report_sheet(
    ws1, TITLE_1,
    'Gap shown here: "Missing in ZIMS" = portal says present, ZIMS has no record that day.',
    DAYS_ALL, [MZ], r1_rows,
)
ws2 = wb.create_sheet(TAB_2)
build_report_sheet(
    ws2, TITLE_2,
    'Gap shown here: "Missing in Portal" = ZIMS marked him, portal has no attendance that day.',
    DAYS_ALL, [MP], r2_rows,
)
ws3 = wb.create_sheet(TAB_T)
build_report_sheet(
    ws3, TITLE_T,
    'Department on its own, Fri-Sat-Sun only. Every sewadar of the department is listed.',
    DAYS_TRAFFIC, [MZ, MP], tr_rows,
    note="TRAFFIC OUTSIDE BHATI duty window is Fri-Sun; Wed/Thu are excluded on purpose. "
         "ZIMS holds only 5 marks for this entire department, so nearly every row shows 'Missing in ZIMS'.",
)

wb.save(OUT_PATH)
print()
print("WROTE:", OUT_PATH)
print(f"  {TAB_1} ({len(r1_rows)} rows), {TAB_2} ({len(r2_rows)} rows), {TAB_T} ({len(tr_rows)} rows), Summary")
