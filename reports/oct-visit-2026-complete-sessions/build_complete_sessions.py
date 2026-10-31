#!/usr/bin/env python3
"""October Visit 2026 — COMPLETE attendance session export (previsit + visit).

Reads the 2026-10-13 portal backup (JSONL.gz) and writes
October-Visit-2026-Complete-Sessions.xlsx in this folder.

One row per dp_attendance_sessions record (10,508 sessions), so a multi-day
spanning session appears once with its IN/OUT dates, and an OPEN session
appears with a blank OUT. Split into two sheets:

  * "Previsit sessions" — sessions whose IN or OUT date falls in 03-06 Oct
    (pre-window scans).
  * "Visit sessions"    — sessions whose IN or OUT date falls in 07-11 Oct
    (the Bhati visit window).

A "Summary" sheet gives counts by day and type. Nothing is aggregated or
dropped — the scan venue (centre), scanner badge/name, manual/auto-out flags
and timestamps are all carried through verbatim, so this is the audit-grade
session ledger rather than a presence matrix.

Read-only with respect to the backup: only reads JSONL.gz, writes the xlsx.
"""
import gzip
import json
import os
from collections import Counter, defaultdict
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, "..", ".."))
BACKUP = "/Users/jai/Documents/GitHub/Db Backups/backups/2026-10-13/portal-local"
OUT_XLSX = os.path.join(BASE, "October-Visit-2026-Complete-Sessions.xlsx")

PREVISIT_DAYS = {"2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"}
VISIT_DAYS = {"2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"}
DAY_LABEL = {"2026-10-03": "Sat 03-Oct", "2026-10-04": "Sun 04-Oct",
             "2026-10-05": "Mon 05-Oct", "2026-10-06": "Tue 06-Oct",
             "2026-10-07": "Wed 07-Oct", "2026-10-08": "Thu 08-Oct",
             "2026-10-09": "Fri 09-Oct", "2026-10-10": "Sat 10-Oct",
             "2026-10-11": "Sun 11-Oct"}


def load(table):
    with gzip.open(os.path.join(BACKUP, f"{table}.jsonl.gz"), "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def hhmm(t):
    if not t:
        return ""
    for fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(t, fmt).strftime("%H:%M:%S")
        except ValueError:
            continue
    return str(t)


def minutes_between(in_date, in_time, out_date, out_time):
    if not (in_date and in_time and out_date and out_time):
        return None
    try:
        a = datetime.strptime(f"{in_date} {in_time[:8]}", "%Y-%m-%d %H:%M:%S")
        b = datetime.strptime(f"{out_date} {out_time[:8]}", "%Y-%m-%d %H:%M:%S")
        m = int((b - a).total_seconds() // 60)
        return m if m >= 0 else None
    except ValueError:
        return None


def fmt_dur(m):
    if m is None:
        return ""
    h, r = divmod(m, 60)
    return f"{h}h {r:02d}m" if h else f"{r}m"


def classify(r):
    dates = {r.get("in_date"), r.get("out_date")} - {None}
    if dates & PREVISIT_DAYS and not (dates & VISIT_DAYS):
        return "Previsit"
    if dates & VISIT_DAYS and not (dates & PREVISIT_DAYS):
        return "Visit"
    if dates & PREVISIT_DAYS and dates & VISIT_DAYS:
        return "Spanning (previsit->visit)"
    return "Other"


def dept_name_map():
    out = {}
    for d in load("deployment_departments"):
        out[d["id"]] = d.get("name") or d.get("department_name") or ""
    return out


def centre_name_map():
    # centres table may use 'name' or 'centre_name'
    out = {}
    for c in load("centres"):
        out[c.get("id")] = c.get("name") or c.get("centre_name") or ""
    return out


def session_row(r, dept_map):
    in_d = r.get("in_date") or ""
    out_d = r.get("out_date") or ""
    mins = minutes_between(in_d, r.get("in_time"), out_d, r.get("out_time"))
    spanning = bool(in_d and out_d and in_d != out_d)
    return [
        r.get("schedule_id") or "",
        r.get("badge_number") or "",
        r.get("sewadar_name") or "",
        r.get("sewadar_centre") or "",
        r.get("centre") or "",            # scan venue
        dept_map.get(r.get("sewadar_dept"), r.get("sewadar_dept") or ""),
        "VSS" if r.get("is_vss") else "Regular",
        "yes" if r.get("is_manual") else "no",
        "yes" if r.get("undeployed_scan") else "no",
        r.get("status") or "",
        in_d,
        DAY_LABEL.get(in_d, in_d),
        hhmm(r.get("in_time")),
        out_d if out_d else "OPEN",
        DAY_LABEL.get(out_d, out_d) if out_d else "OPEN",
        hhmm(r.get("out_time")) if r.get("out_time") else ("open" if r.get("status") == "OPEN" else ""),
        "yes" if spanning else "no",
        fmt_dur(mins) if mins is not None else ("still IN" if r.get("status") == "OPEN" else ""),
        mins if mins is not None else "",
        r.get("in_scanner_badge") or "",
        r.get("in_scanner_name") or "",
        r.get("in_scanner_centre") or "",
        r.get("out_scanner_badge") or "",
        r.get("out_scanner_name") or "",
        r.get("out_scanner_centre") or "",
        r.get("is_auto_out") if "is_auto_out" in r else "",
        r.get("created_at") or "",
        r.get("updated_at") or "",
        r.get("id") or "",
    ]


HEADERS = [
    "Schedule id", "Badge", "Name", "Home centre", "Scan venue (centre)", "Department",
    "Type (VSS/Regular)", "Manual", "Undeployed", "Status",
    "IN date", "IN day", "IN time",
    "OUT date", "OUT day", "OUT time",
    "Spanning (IN≠OUT)", "Duration", "Duration (min)",
    "IN scanner badge", "IN scanner name", "IN scanner centre",
    "OUT scanner badge", "OUT scanner name", "OUT scanner centre",
    "Auto out", "Created at", "Updated at", "Session id",
]


def style_header(ws, ncols, row=1):
    fill = PatternFill("solid", fgColor="1F3864")
    font = Font(bold=True, color="FFFFFF", name="Arial", size=10)
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = fill
        cell.font = font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 30


def write_sheet(wb, title, rows):
    ws = wb.create_sheet(title)
    ws.append(HEADERS)
    style_header(ws, len(HEADERS))
    for r in rows:
        ws.append(r)
    # widths
    widths = [36, 12, 22, 18, 20, 20, 10, 7, 10, 9, 11, 11, 9, 11, 11, 9, 11, 11, 10,
              12, 18, 14, 12, 18, 14, 8, 22, 22, 36]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{ws.max_row}"
    # zebra
    fill_alt = PatternFill("solid", fgColor="F2F2F2")
    for rr in range(2, ws.max_row + 1):
        if rr % 2 == 0:
            for c in range(1, len(HEADERS) + 1):
                ws.cell(row=rr, column=c).fill = fill_alt
    return ws


def main():
    dept_map = dept_name_map()
    sessions = load("dp_attendance_sessions")
    print("total sessions:", len(sessions))

    previsit_rows = []
    visit_rows = []
    other_rows = []
    for r in sessions:
        cls = classify(r)
        row = session_row(r, dept_map)
        if cls == "Previsit":
            previsit_rows.append(row)
        elif cls == "Visit":
            visit_rows.append(row)
        elif cls == "Spanning (previsit->visit)":
            # a session that starts previsit and ends in visit — list on BOTH
            # sheets so neither ledger loses it; mark spanning.
            previsit_rows.append(row)
            visit_rows.append(row)
        else:
            other_rows.append(row)

    # sort by IN date then IN time then badge
    def key(r):
        return (r[9], r[11], r[0])
    previsit_rows.sort(key=key)
    visit_rows.sort(key=key)
    other_rows.sort(key=key)

    wb = Workbook()
    # remove default sheet
    wb.remove(wb.active)

    # Summary sheet first
    ws = wb.create_sheet("Summary")
    ws.append(["October Visit 2026 — Complete Attendance Sessions"])
    ws.cell(row=1, column=1).font = Font(bold=True, size=14, color="1F3864")
    ws.append([])
    ws.append(["Metric", "Count"])
    for c in range(1, 3):
        ws.cell(row=3, column=c).fill = PatternFill("solid", fgColor="1F3864")
        ws.cell(row=3, column=c).font = Font(bold=True, color="FFFFFF")
    metrics = [
        ("Total sessions (dp_attendance_sessions)", len(sessions)),
        ("Previsit sessions (IN/OUT in 03-06 Oct)", len(previsit_rows)),
        ("Visit sessions (IN/OUT in 07-11 Oct)", len(visit_rows)),
        ("Spanning previsit->visit (counted on both sheets)", sum(1 for r in sessions if classify(r) == "Spanning (previsit->visit)")),
        ("Other / undated", len(other_rows)),
        ("OPEN sessions (no OUT)", sum(1 for r in sessions if not r.get("out_date"))),
        ("Manual scans", sum(1 for r in sessions if r.get("is_manual"))),
        ("Undeployed scans", sum(1 for r in sessions if r.get("undeployed_scan"))),
        ("VSS rows", sum(1 for r in sessions if r.get("is_vss"))),
    ]
    r = 4
    for k, v in metrics:
        ws.cell(row=r, column=1, value=k)
        ws.cell(row=r, column=2, value=v)
        r += 1
    ws.append([])
    r += 1
    ws.cell(row=r, column=1, value="Sessions by IN date").font = Font(bold=True, color="1F3864")
    r += 1
    ws.cell(row=r, column=1, value="IN date").fill = PatternFill("solid", fgColor="1F3864")
    ws.cell(row=r, column=1).font = Font(bold=True, color="FFFFFF")
    ws.cell(row=r, column=2, value="Count").fill = PatternFill("solid", fgColor="1F3864")
    ws.cell(row=r, column=2).font = Font(bold=True, color="FFFFFF")
    r += 1
    by_day = Counter(s.get("in_date") for s in sessions)
    for d in sorted(by_day):
        ws.cell(row=r, column=1, value=f"{DAY_LABEL.get(d, d)} ({d})")
        ws.cell(row=r, column=2, value=by_day[d])
        r += 1
    ws.column_dimensions["A"].width = 52
    ws.column_dimensions["B"].width = 14

    write_sheet(wb, "Previsit sessions", previsit_rows)
    write_sheet(wb, "Visit sessions", visit_rows)
    if other_rows:
        write_sheet(wb, "Other sessions", other_rows)

    wb.save(OUT_XLSX)
    print("previsit rows:", len(previsit_rows))
    print("visit rows:", len(visit_rows))
    print("other rows:", len(other_rows))
    print("file:", OUT_XLSX, os.path.getsize(OUT_XLSX), "bytes")


if __name__ == "__main__":
    main()
