#!/usr/bin/env python3
"""Day-wise present/absent + never-reported + late/early reports.

Reads the EDITED source-of-truth workbook (owner changes carry through) and
writes October-Visit-2026-Daywise-Reports.xlsx in this folder.

Thresholds (documented on the Cover sheet; change here and rebuild):
  LATE_AFTER   = 10:00  -> IN strictly after 10:00 counts as late arrival
  EARLY_BEFORE = 13:00  -> same-day OUT strictly before 13:00 counts as early departure
Only plain HH:MM times qualify. 'Present (marked)' rows have no times and are
excluded from late/early; Absent / NO OUT / NO IN cells never qualify.
"""
import re
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HERE = Path(__file__).parent
SRC = HERE / "October-Visit-2026-Source-of-Truth.xlsx"
OUT_PRESENT = HERE / "October-Visit-2026-Present-Reports.xlsx"
OUT_ABSENT = HERE / "October-Visit-2026-Absent-Reports.xlsx"

WINDOW = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]
DAY_LABEL = {"2026-10-07": "Wed 07-Oct", "2026-10-08": "Thu 08-Oct",
             "2026-10-09": "Fri 09-Oct", "2026-10-10": "Sat 10-Oct",
             "2026-10-11": "Sun 11-Oct"}
IN_COLS = [5, 7, 9, 11, 13]  # E,G,I,K,M in the source sheet (1-indexed)

LATE_AFTER = (10, 0)
EARLY_BEFORE = (13, 0)

# Owner instruction: TRAFFIC OUTSIDE BHATI duty had no Wed/Thu shift, so its
# Wed/Thu ABSENT rows are not absenteeism - drop them from those two Absent
# tabs only. Present tabs are never touched.
ABSENT_EXCLUDE = {"2026-10-07": {"TRAFFIC OUTSIDE BHATI"},
                  "2026-10-08": {"TRAFFIC OUTSIDE BHATI"}}

HDR_FILL = PatternFill("solid", fgColor="1F4E79")
HDR_FONT = Font(name="Arial", size=11, bold=True, color="FFFFFF")
BODY_FONT = Font(name="Arial", size=10)
thin = Side(style="thin", color="B0B0B0")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
WRAP = Alignment(vertical="center", wrap_text=True)
CENTER = Alignment(vertical="center", horizontal="center", wrap_text=True)


def hhmm_tuple(x):
    m = re.fullmatch(r"(\d{2}):(\d{2})( \(×\d+\)| \(\d+ sessions\))?", (x or "").strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def style_sheet(ws, widths, ncols):
    for c, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ncols)}{ws.max_row}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:1"


def add_tab(wb, title, headers, rows, widths):
    ws = wb.create_sheet(title)
    ws.append(headers)
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, HDR_FONT, BORDER, CENTER
    for r in rows:
        ws.append(r)
        for c in range(1, len(headers) + 1):
            cell = ws.cell(row=ws.max_row, column=c)
            cell.font, cell.border = BODY_FONT, BORDER
            cell.alignment = WRAP
    style_sheet(ws, widths, len(headers))
    return ws


def make_cover(wb, tabs_desc):
    cover = wb.active
    assert cover is not None
    cover.title = "Cover"
    cover["A1"] = "Day-wise attendance reports - October Visit 2026 (Wed 07-Oct to Sun 11-Oct)"
    cover["A1"].font = Font(name="Arial", size=12, bold=True)
    cover_lines = [
        ("Source", "October-Visit-2026-Source-of-Truth.xlsx (Attendance Truth sheet, owner-edited). "
                    "Present on day D = that day's IN cell is not 'Absent'."),
        ("Tabs", tabs_desc),
        ("Late arrival", f"First-IN strictly after {LATE_AFTER[0]:02d}:{LATE_AFTER[1]:02d}. "
                         "Only plain HH:MM times count; 'Present (marked)' (no times), Absent, "
                         "NO OUT and NO IN cells are excluded."),
        ("Early departure", f"Latest-OUT strictly before {EARLY_BEFORE[0]:02d}:{EARLY_BEFORE[1]:02d}. "
                            "Same exclusions as late arrival."),
        ("Manually marked", "'Present (marked)' rows (7 badges, owner order 13-Oct-2026) appear in the "
                            "Present tabs with that text and are never in Late/Early tabs."),
        ("Absent-tab exclusion", "TRAFFIC OUTSIDE BHATI rows are dropped from Absent Wed 07-Oct and Absent "
                                 "Thu 08-Oct only (no Wed/Thu shift for that dept) - owner instruction. "
                                 "Present tabs untouched."),
    ]
    for k, v in cover_lines:
        cover.append([k, v])
        cover.cell(row=cover.max_row, column=1).font = Font(name="Arial", size=10, bold=True)
        cover.cell(row=cover.max_row, column=2).font = BODY_FONT
        cover.cell(row=cover.max_row, column=2).alignment = WRAP
    cover.column_dimensions["A"].width = 18
    cover.column_dimensions["B"].width = 130


def main():
    src = load_workbook(SRC)
    ws = src["Attendance Truth"]
    people = []  # dicts: badge,name,centre,dept,ins[5],outs[5],days_present,remarks
    for i in range(3, ws.max_row + 1):
        g = lambda c: ws.cell(row=i, column=c).value  # noqa: E731
        people.append({
            "badge": g(1), "name": g(2), "centre": g(3), "dept": g(4),
            "ins": [g(c) for c in IN_COLS],
            "outs": [g(c + 1) for c in IN_COLS],
            "remarks": g(16) or "",
        })
    assert len(people) == 2648, len(people)
    for p in people:
        p["days_present"] = sum(1 for x in p["ins"] if x != "Absent")

    # ---- two workbooks: present-side and absent-side ----
    wb_p, wb_a = Workbook(), Workbook()
    make_cover(wb_p, "Present Wed..Sun (5 tabs), Late Arrivals, Early Departures.")
    make_cover(wb_a, "Absent Wed..Sun (5 tabs), Never Reported. "
                     "TRAFFIC OUTSIDE BHATI dropped from Absent Wed/Thu (no shift those days).")

    # ---- present / absent tabs per day ----
    PW = [16, 24, 22, 22, 12, 30, 13, 50]
    AW = [16, 24, 22, 22, 13, 60]
    for k, d in enumerate(WINDOW):
        label = DAY_LABEL[d]
        excluded_depts = ABSENT_EXCLUDE.get(d, set())
        prows, arows = [], []
        nexcl = 0
        for p in people:
            base = [p["badge"], p["name"], p["centre"], p["dept"]]
            if p["ins"][k] != "Absent":
                note = "Manually marked (no scan time)" if p["ins"][k] == "Present (marked)" else ""
                prows.append(base + [p["ins"][k], p["outs"][k], p["days_present"], note])
            elif p["dept"] in excluded_depts:
                nexcl += 1  # not absenteeism for this dept on this day
            else:
                arows.append(base + [p["days_present"], p["remarks"]])
        prows.sort(key=lambda r: ((r[2] or ""), (r[1] or ""), r[0]))
        arows.sort(key=lambda r: ((r[2] or ""), (r[1] or ""), r[0]))
        assert len(prows) + len(arows) + nexcl == 2648, (label, len(prows), len(arows), nexcl)
        add_tab(wb_p, f"Present {label}",
                ["Badge", "Name", "Centre", "Deployed Dept", "IN", "OUT", "Days Present", "Note"],
                prows, PW)
        add_tab(wb_a, f"Absent {label}",
                ["Badge", "Name", "Centre", "Deployed Dept", "Days Present", "Remarks"],
                arows, AW)
        print(f"{label}: present={len(prows)} absent={len(arows)} excluded={nexcl}")

    # ---- never reported ----
    nr = [[p["badge"], p["name"], p["centre"], p["dept"], p["remarks"]]
          for p in people if "Never reported" in p["remarks"]]
    nr.sort(key=lambda r: ((r[2] or ""), (r[1] or ""), r[0]))
    assert len(nr) == 312, len(nr)
    add_tab(wb_a, "Never Reported",
            ["Badge", "Name", "Centre", "Deployed Dept", "Remarks"],
            nr, [16, 24, 22, 22, 70])
    print(f"never_reported={len(nr)}")

    # ---- late arrivals / early departures ----
    late, early = [], []
    for p in people:
        base = [p["badge"], p["name"], p["centre"], p["dept"]]
        for k, d in enumerate(WINDOW):
            t_in, t_out = hhmm_tuple(p["ins"][k]), hhmm_tuple(p["outs"][k])
            if t_in and t_in > LATE_AFTER:
                late.append(base + [DAY_LABEL[d], p["ins"][k], p["days_present"]])
            if t_out and t_out < EARLY_BEFORE:
                early.append(base + [DAY_LABEL[d], p["outs"][k], p["days_present"]])
    late.sort(key=lambda r: (r[4], (r[2] or ""), (r[1] or "")))
    early.sort(key=lambda r: (r[4], (r[2] or ""), (r[1] or "")))
    add_tab(wb_p, "Late Arrivals",
            ["Badge", "Name", "Centre", "Deployed Dept", "Day", "First IN", "Days Present"],
            late, [16, 24, 22, 22, 12, 14, 13])
    add_tab(wb_p, "Early Departures",
            ["Badge", "Name", "Centre", "Deployed Dept", "Day", "Latest OUT", "Days Present"],
            early, [16, 24, 22, 22, 12, 14, 13])
    print(f"late={len(late)} early={len(early)}")

    wb_p.save(OUT_PRESENT)
    wb_a.save(OUT_ABSENT)
    print(f"present_file={OUT_PRESENT} ({OUT_PRESENT.stat().st_size} bytes) sheets={wb_p.sheetnames}")
    print(f"absent_file={OUT_ABSENT} ({OUT_ABSENT.stat().st_size} bytes) sheets={wb_a.sheetnames}")
    print("ALL GATES PASSED")


if __name__ == "__main__":
    main()
