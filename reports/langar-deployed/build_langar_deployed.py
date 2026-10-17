#!/usr/bin/env python3
"""LANGAR deployed sewadars — Wed..Sun presence report.

Roster: deployments where requested department = LANGAR (301 rows) from the
2026-10-13 portal backup. Each badge gets one row.

Presence law (strict event-date, = portal attendance_reports):
  Present(badge, D) <=> badge has a session with in_date == D OR out_date == D.
  A silent day is Absent. No carry-over.

Output: Badge | Name | Centre | Deployed Dept | Wed 07-Oct | Thu 08-Oct |
        Fri 09-Oct | Sat 10-Oct | Sun 11-Oct
Day cells: "P" on a green fill if present, "A" on a red fill if absent.
"""
import gzip
import json
from collections import defaultdict
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BACKUP = Path("/Users/jai/Documents/GitHub/Db Backups/backups/2026-10-13/portal-local")
OUT = Path(__file__).parent / "Langar-Deployed-Wed-Sun.xlsx"

LANGAR = "1303df35-ccbe-480a-9ab1-1f8d8222d5e9"
WINDOW = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]
DAY_LABEL = ["Wed 07-Oct", "Thu 08-Oct", "Fri 09-Oct", "Sat 10-Oct", "Sun 11-Oct"]

HDR_FILL = PatternFill("solid", fgColor="1F4E79")
HDR_FONT = Font(name="Arial", size=11, bold=True, color="FFFFFF")
BODY_FONT = Font(name="Arial", size=10)
GREEN_FILL = PatternFill("solid", fgColor="C6EFCE")
GREEN_FONT = Font(name="Arial", size=11, bold=True, color="006100")
RED_FILL = PatternFill("solid", fgColor="FFC7CE")
RED_FONT = Font(name="Arial", size=11, bold=True, color="9C0006")
thin = Side(style="thin", color="B0B0B0")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
CENTER = Alignment(vertical="center", horizontal="center")
LEFT = Alignment(vertical="center", horizontal="left")


def load(table):
    with gzip.open(BACKUP / f"{table}.jsonl.gz", "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    dep = load("deployments")
    att = load("attendance_sessions")

    langar = [d for d in dep if d.get("department_id") == LANGAR]
    badges = {d["badge_number"] for d in langar}
    assert len(langar) == 301 and len(badges) == 301, (len(langar), len(badges))

    by_badge = defaultdict(list)
    for a in att:
        by_badge[a["badge_number"]].append(a)

    rows = []
    for d in langar:
        b = d["badge_number"]
        ss = by_badge.get(b, [])
        marks = [
            "P" if any(s.get("in_date") == D or s.get("out_date") == D for s in ss) else "A"
            for D in WINDOW
        ]
        rows.append([b, d.get("sewadar_name") or "", d.get("centre") or "", "LANGAR"] + marks)
    rows.sort(key=lambda r: ((r[2] or ""), (r[1] or ""), r[0]))

    wb = Workbook()
    ws = wb.active
    ws.title = "LANGAR Deployed"
    headers = ["Badge", "Name", "Centre", "Deployed Dept"] + DAY_LABEL
    ws.append(headers)
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, HDR_FONT, BORDER, CENTER

    for r in rows:
        ws.append(r)
        i = ws.max_row
        for c in range(1, 5):
            cell = ws.cell(row=i, column=c)
            cell.font, cell.border, cell.alignment = BODY_FONT, BORDER, LEFT
        for c in range(5, 10):
            cell = ws.cell(row=i, column=c)
            cell.border, cell.alignment = BORDER, CENTER
            if cell.value == "P":
                cell.fill, cell.font = GREEN_FILL, GREEN_FONT
            else:
                cell.fill, cell.font = RED_FILL, RED_FONT

    for c, w in enumerate([16, 26, 22, 14, 13, 13, 13, 13, 13], start=1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:I{ws.max_row}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:1"

    wb.save(OUT)

    per_day = [sum(1 for r in rows if r[4 + k] == "P") for k in range(5)]
    print(f"rows={len(rows)}")
    print(f"present per day {dict(zip(DAY_LABEL, per_day))}")
    print(f"file={OUT} ({OUT.stat().st_size} bytes)")

    # readback
    from openpyxl import load_workbook
    chk = load_workbook(OUT)
    w2 = chk["LANGAR Deployed"]
    assert w2.max_row == 302 and w2.max_column == 9, w2.dimensions
    assert w2.cell(row=2, column=5).value in ("P", "A")
    assert w2.cell(row=2, column=5).fill.fgColor.rgb.endswith(("C6EFCE", "FFC7CE"))
    print(f"readback_ok {w2.dimensions} freeze={w2.freeze_panes}")
    print("ALL GATES PASSED")


if __name__ == "__main__":
    main()
