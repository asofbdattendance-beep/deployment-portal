#!/usr/bin/env python3
"""October Visit 2026 — single source-of-truth attendance workbook.

Reads the 2026-10-13 portal backup (JSONL.gz) and writes
October-Visit-2026-Source-of-Truth.xlsx in this folder.

PRESENCE LAW (strict event-date, = portal v45 attendance_reports):
  Present(badge, D)  <=>  badge has a session with in_date == D OR out_date == D.
  A silent day is Absent even with an OPEN session hanging. No carry-over.

Day-cell rule (First IN - Latest OUT, per unique date):
  in on D + out on D  -> "HH:MM - HH:MM"            (First IN - Latest OUT)
  in on D, no out D   -> "HH:MM - NO OUT (Forgot OUT ...)" / "(Still OPEN ...)"
  out on D, no in D   -> "NO IN - HH:MM (IN was DD-Mon ...)"
  neither             -> "Absent"
Multiple sessions touching D merge: earliest IN, latest OUT, "(N sessions)".
"""
import gzip
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BACKUP = Path("/Users/jai/Documents/GitHub/Db Backups/backups/2026-10-13/portal-local")
OUT_XLSX = Path(__file__).parent / "October-Visit-2026-Source-of-Truth.xlsx"

WINDOW = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]
# MANUAL OVERRIDE (owner instruction, 13-Oct-2026): these badges are marked
# present all 5 window days with NO times shown. They render as
# 'Present (marked)' on a blue fill, with the original scan record kept
# (as day-COUNTS only, no times) in Remarks. Never silently merged.
MANUAL_OVERRIDE = {"FB5978GA0015", "FB5978GA0003", "FB5978GA0005", "FB5978GA0004",
                   "FB5978GA0001", "FB5978GA0088", "FB5978GA0027"}
MANUAL_NAMES = {"FB5978GA0027": "Deepak Agnihotri"}  # name provided by owner; not in backup
MANUAL_TEXT = "Present (marked)"
OVERRIDE_DATE = "13-Oct-2026"
DAY_LABEL = {"2026-10-07": "Wed 07-Oct", "2026-10-08": "Thu 08-Oct",
             "2026-10-09": "Fri 09-Oct", "2026-10-10": "Sat 10-Oct",
             "2026-10-11": "Sun 11-Oct"}
WEEKDAY = {"2026-10-03": "Sat", "2026-10-04": "Sun", "2026-10-05": "Mon",
           "2026-10-06": "Tue", "2026-10-07": "Wed", "2026-10-08": "Thu",
           "2026-10-09": "Fri", "2026-10-10": "Sat", "2026-10-11": "Sun"}

MAIN_SHEET = "Attendance Truth"


def load(table):
    with gzip.open(BACKUP / f"{table}.jsonl.gz", "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def dlabel(d):
    """'2026-10-09' -> '09-Oct' (weekday only shown for window days via header)."""
    dt = datetime.strptime(d, "%Y-%m-%d")
    return dt.strftime("%d-") + dt.strftime("%b")


def hhmm(t):
    """'09:35:52.284' -> '09:35'. None -> None."""
    if not t:
        return None
    for fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(t, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return t  # pragma: no cover - unexpected shape, keep raw


def main():
    dep = load("deployments")
    att = load("attendance_sessions")
    dept_rows = load("deployment_departments")
    dept_name = {d["id"]: d.get("name") for d in dept_rows}

    sched = load("deployment_schedules")[0]
    assert sched["visit_start_date"] == "2026-10-07" and sched["visit_end_date"] == "2026-10-11", sched

    dep_badges = {d["badge_number"] for d in dep}
    scan_badges = {a["badge_number"] for a in att}

    # ---- hard reconciliation gates (evidence-grade accuracy) ----
    assert len(dep) == 2587 and len(dep_badges) == 2587, (len(dep), len(dep_badges))
    assert len(att) == 10508 and len(scan_badges) == 2334, (len(att), len(scan_badges))
    assert len(dep_badges & scan_badges) == 2275
    assert len(dep_badges - scan_badges) == 312          # never reported
    assert len(scan_badges - dep_badges) == 59          # undeployed scans
    assert sum(1 for a in att if a.get("in_date") and a.get("out_date")
               and a["in_date"] != a["out_date"]) == 2203  # spanning sessions
    assert sum(1 for a in att if not a.get("out_date")) == 850  # OPEN rows

    by_badge = defaultdict(list)
    for a in att:
        by_badge[a["badge_number"]].append(a)

    # deployment truth per badge
    dep_info = {}
    for d in dep:
        eff = d.get("deployed_department_id") or d.get("department_id")
        dep_info[d["badge_number"]] = {
            "name": d.get("sewadar_name") or "",
            "centre": d.get("centre") or "",
            "dept": dept_name.get(eff, "—") if eff else "—",
            "finalized": bool(d.get("deployed_department_id")),
        }

    def day_cells(sessions, badge, day):
        """Return (in_text, out_text, is_present) for one badge-day.

        IN col  = First IN on D, or 'Absent', or 'NO IN (IN was DD-Mon; forgot OUT)'.
        OUT col = Latest OUT on D, or 'Absent', or 'NO OUT (Forgot OUT [, OUT on DD-Mon] [; Still OPEN])'.
        Multiple sessions touching D merge to earliest IN / latest OUT, tagged '(N sessions)'.
        """
        ins, outs, touching = [], [], []
        span_closed_later, span_open, in_came_from = [], [], []
        for s in sessions:
            i, o = s.get("in_date"), s.get("out_date")
            if i == day or o == day:
                touching.append(s)
            if i == day and s.get("in_time"):
                ins.append(s["in_time"])
            if o == day and s.get("out_time"):
                outs.append(s["out_time"])
            if i == day and o != day:
                if s.get("status") == "OPEN" or not o:
                    span_open.append(s)
                else:
                    span_closed_later.append(o)
            if o == day and i != day and i:
                in_came_from.append(i)
        if not ins and not outs:
            return "Absent", "Absent", False
        n = f" (×{len(touching)})" if len(touching) > 1 else ""
        if ins and outs:
            return hhmm(min(ins)), f"{hhmm(max(outs))}{n}", True
        if ins:
            extra = []
            if span_closed_later:
                ds = ", ".join(dlabel(x) for x in sorted(set(span_closed_later)))
                extra.append(f"OUT {ds}")
            if span_open:
                extra.append("still open")
            note = "; ".join(extra) if extra else "Forgot OUT"
            return hhmm(min(ins)), f"NO OUT ({note}){n}", True
        # outs only: the IN happened on an earlier day (forgot OUT that day)
        ds = ", ".join(dlabel(x) for x in sorted(set(in_came_from)))
        return f"NO IN (IN {ds}){n}", hhmm(max(outs)), True

    def remarks(badge, sessions, deployed):
        parts = []
        if deployed and not sessions:
            parts.append("Never reported — no scans")
        elif not deployed and sessions:
            parts.append("Undeployed scan — not in roster")
        pairs = sorted({(s["in_date"], s.get("out_date")) for s in sessions
                        if s.get("in_date") and s.get("out_date") and s["in_date"] != s["out_date"]})
        for i, o in pairs:
            parts.append(f"Forgot OUT {dlabel(i)}→{dlabel(o)}")
        opens = sorted({s["in_date"] for s in sessions
                        if (s.get("status") == "OPEN" or not s.get("out_date")) and s.get("in_date")})
        for i in opens:
            parts.append(f"Still OPEN — IN {dlabel(i)}, no OUT")
        if sessions and not any(s.get("in_date") in WINDOW or s.get("out_date") in WINDOW for s in sessions):
            parts.append("Only pre-window scans (03–06 Oct)")
        man = sum(1 for s in sessions if s.get("is_manual"))
        if man and man == len(sessions) and sessions:
            parts.append("All manual")
        if man:
            parts.append(f"Manual ×{man}/{len(sessions)}")
        if any(s.get("is_vss") for s in sessions):
            parts.append("VSS")
        info = dep_info.get(badge)
        if info and info["finalized"]:
            parts.append("Finalised")
        if deployed and sessions and not any(
                s.get("in_date") in WINDOW or s.get("out_date") in WINDOW for s in sessions):
            pass  # already covered by the pre-window note
        elif deployed and sessions and all(
                not (s.get("in_date") == d or s.get("out_date") == d)
                for s in sessions for d in WINDOW):
            parts.append("Absent all 5 window days")
        return "; ".join(parts)

    roster = sorted(dep_badges | scan_badges | MANUAL_OVERRIDE)
    rows = []
    for b in roster:
        sessions = by_badge.get(b, [])
        deployed = b in dep_badges
        manual = b in MANUAL_OVERRIDE
        if deployed:
            info = dep_info[b]
            name, centre, dept = info["name"], info["centre"], info["dept"]
        elif sessions:
            name = Counter(s.get("sewadar_name") for s in sessions).most_common(1)[0][0] or ""
            centre = Counter(s.get("sewadar_centre") for s in sessions).most_common(1)[0][0] or ""
            snap = [s["sewadar_dept"] for s in sorted(
                sessions, key=lambda s: (s.get("in_date") or "", s.get("in_time") or ""),
                reverse=True) if s.get("sewadar_dept")]
            dept = dept_name.get(snap[0], "—") if snap else "—"
        else:
            # override-added badge: exists in neither deployments nor scans
            name = MANUAL_NAMES.get(b, "— (name not in backup)")
            centre, dept = "—", "—"
        orig_days = [D for D in WINDOW if any(
            s.get("in_date") == D or s.get("out_date") == D for s in sessions)]
        if manual:
            cells_in, cells_out, present = [MANUAL_TEXT] * 5, [MANUAL_TEXT] * 5, 5
        else:
            cells_in, cells_out, present = [], [], 0
            for d in WINDOW:
                in_t, out_t, is_p = day_cells(sessions, b, d)
                cells_in.append(in_t)
                cells_out.append(out_t)
                present += 1 if is_p else 0
        rm = remarks(b, sessions, deployed)
        if manual:
            note = (f"Marked present 5/5 by owner {OVERRIDE_DATE} — no scan times. "
                    f"Scans showed {len(orig_days)}/5.")
            if not deployed:
                note += " Not in roster — row added by owner."
            if b in MANUAL_NAMES:
                note += " Name provided by owner."
            rm = note + ("; " + rm if rm else "")
        rows.append({"badge": b, "name": name, "centre": centre, "dept": dept,
                     "ins": cells_in, "outs": cells_out, "present": present,
                     "remarks": rm, "manual": manual})
    rows.sort(key=lambda r: ((r["centre"] or ""), (r["name"] or ""), r["badge"]))

    # python-side truth for verification + for checking the sheet formulas
    # deployed-only present counts, keyed by day
    order = [r["badge"] for r in rows]
    idx = {b: i for i, b in enumerate(order)}
    expect_present = {}
    for d, k in zip(WINDOW, range(5)):
        n = sum(1 for b in dep_badges if rows[idx[b]]["ins"][k] != "Absent")
        expect_present[d] = n
    assert expect_present == {"2026-10-07": 1324, "2026-10-08": 1485,
                              "2026-10-09": 2129, "2026-10-10": 2141,
                              "2026-10-11": 2132}, expect_present
    assert sum(1 for r in rows if r["badge"] in dep_badges and r["present"] == 0) == 317
    assert sum(1 for r in rows if "Never reported" in r["remarks"]) == 312
    assert len(rows) == 2648, len(rows)  # 2587 deployed + 59 scanned-only + 2 override-added
    # override integrity: all 7 marked, 5/5, NO times anywhere in their day cells
    ov = [r for r in rows if r["badge"] in MANUAL_OVERRIDE]
    assert len(ov) == 7 and all(r["present"] == 5 and r["manual"] for r in ov)
    assert all(":" not in t for r in ov for t in r["ins"] + r["outs"])
    assert all(t == MANUAL_TEXT for r in ov for t in r["ins"] + r["outs"])

    # ---------------- workbook ----------------
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = MAIN_SHEET
    HDR_FILL = PatternFill("solid", fgColor="1F4E79")
    HDR_FONT = Font(name="Arial", size=11, bold=True, color="FFFFFF")
    SUB_FONT = Font(name="Arial", size=10, bold=True, color="FFFFFF")
    BODY_FONT = Font(name="Arial", size=10)
    ABSENT_FONT = Font(name="Arial", size=10, italic=True, color="808080")
    NOOUT_FILL = PatternFill("solid", fgColor="FCE4CC")
    MANUAL_FILL = PatternFill("solid", fgColor="DCE6F1")  # manual override: blue, never a time
    thin = Side(style="thin", color="B0B0B0")
    BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
    wrap = Alignment(vertical="center", wrap_text=True)
    center = Alignment(vertical="center", horizontal="center", wrap_text=True)

    # Row 1: merged day bands (each spans its IN|OUT pair). Row 2: sub-headers.
    # Columns: A Badge, B Name, C Centre, D Dept, E..N = 5 x (IN, OUT),
    #          O Days Present, P Remarks.
    IN_COLS = [5 + 2 * k for k in range(5)]  # E,G,I,K,M
    for k, d in enumerate(WINDOW):
        ws.merge_cells(start_row=1, start_column=IN_COLS[k],
                       end_row=1, end_column=IN_COLS[k] + 1)
        band = ws.cell(row=1, column=IN_COLS[k], value=DAY_LABEL[d])
        band.fill, band.font, band.border, band.alignment = HDR_FILL, HDR_FONT, BORDER, center
        ws.cell(row=1, column=IN_COLS[k] + 1).border = BORDER
    for c in [1, 2, 3, 4, 15, 16]:
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = HDR_FILL, HDR_FONT, BORDER
    subheads = (["Badge", "Name", "Centre", "Deployed Dept"]
                + ["IN", "OUT"] * 5 + ["Days Present", "Remarks"])
    for c, h in enumerate(subheads, start=1):
        cell = ws.cell(row=2, column=c, value=h)
        cell.fill, cell.font, cell.border, cell.alignment = HDR_FILL, SUB_FONT, BORDER, center

    first, last = 3, 2 + len(rows)
    for i, r in enumerate(rows, start=3):
        vals = ([r["badge"], r["name"], r["centre"], r["dept"]]
                + [v for pair in zip(r["ins"], r["outs"]) for v in pair]
                + [None, r["remarks"]])
        for c, v in enumerate(vals, start=1):
            cell = ws.cell(row=i, column=c, value=v)
            cell.font, cell.border, cell.alignment = BODY_FONT, BORDER, (
                center if c <= 4 or c == 15 else wrap)
        for k in range(5):
            ci, co = IN_COLS[k], IN_COLS[k] + 1
            ti, to = r["ins"][k], r["outs"][k]
            if r.get("manual"):
                ws.cell(row=i, column=ci).fill = MANUAL_FILL
                ws.cell(row=i, column=co).fill = MANUAL_FILL
            elif ti == "Absent":
                ws.cell(row=i, column=ci).font = ABSENT_FONT
                ws.cell(row=i, column=co).font = ABSENT_FONT
            else:
                if ti.startswith("NO IN"):
                    ws.cell(row=i, column=ci).fill = NOOUT_FILL
                if to.startswith("NO OUT"):
                    ws.cell(row=i, column=co).fill = NOOUT_FILL
        j = ws.cell(row=i, column=15)
        # Days Present: count of day-IN cols not 'Absent' (absent <=> both cols 'Absent')
        j.value = "=" + "+".join(f'({get_column_letter(c)}{i}<>"Absent")' for c in IN_COLS)
        j.font, j.border, j.alignment = BODY_FONT, BORDER, center

    widths = [16, 24, 22, 22,
              24, 34, 24, 34, 24, 34, 24, 34, 24, 34,
              13, 60]
    for c, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = "E3"
    ws.auto_filter.ref = f"A2:P{last}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:2"
    ws.print_area = f"A1:P{last}"

    # ---------------- Summary (formula-driven) ----------------
    sm = wb.create_sheet("Summary")
    assert sm is not None
    sm.append(["October Visit 2026 - source-of-truth summary (all counts recalculate from Attendance Truth)"])
    sm.append(["Metric", "Value", "Definition / source"])
    sm["A1"].font = Font(name="Arial", size=12, bold=True)
    for c in ("A2", "B2", "C2"):
        sm[c].fill, sm[c].font = HDR_FILL, HDR_FONT
    day_col = {d: get_column_letter(c) for d, c in zip(WINDOW, IN_COLS)}
    rng = lambda c: f"{c}{first}:{c}{last}"  # full-column range, e.g. A3:A2648
    lines = [
        ("Badges in sheet (deployed + scanned-only)", f"=COUNTA('{MAIN_SHEET}'!{rng('A')})",
         "2587 deployed + 59 scanned-only + 2 override-added = 2648"),
        ("Deployed badges", "2587", "deployments.jsonl.gz distinct badge_number (backup truth)"),
        ("Scanned badges", "2334", "attendance_sessions.jsonl.gz distinct badge_number"),
        ("Never reported (deployed, zero scans)", f"=COUNTIF('{MAIN_SHEET}'!{rng('P')},\"*Never reported*\")",
         "deployed badge with no session at all = 312"),
        ("Badges never OUT (Still OPEN)", f"=COUNTIF('{MAIN_SHEET}'!{rng('P')},\"*Still OPEN*\")",
         "every session OPEN; 56 badges"),
        ("Badges with a Forgot-OUT span", f"=COUNTIF('{MAIN_SHEET}'!{rng('P')},\"*Forgot OUT*\")",
         "CLOSED session with out_date > in_date"),
        ("Absent all 5 window days (deployed)", f"=COUNTIF('{MAIN_SHEET}'!{rng('O')},0)-0",
         "Days Present = 0; deployed share = 317 (includes 312 never-reported + 5 pre-window-only)"),
        ("Present 5/5 (deployed share incl.)", f"=COUNTIF('{MAIN_SHEET}'!{rng('O')},5)",
         "deployed share = 1062"),
    ]
    for d in WINDOW:
        col = day_col[d]
        lines.append((f"Present {DAY_LABEL[d]}",
                      f"=COUNTIF('{MAIN_SHEET}'!{rng(col)},\"<>Absent\")",
                      f"IN or OUT on {d}; deployed share = {expect_present[d]}"))
        lines.append((f"Absent {DAY_LABEL[d]} (all badges)",
                      f"=COUNTIF('{MAIN_SHEET}'!{rng(col)},\"Absent\")", "no IN and no OUT that day"))
    for m, v, s in lines:
        sm.append([m, v, s])
        for c in range(1, 4):
            cell = sm.cell(row=sm.max_row, column=c)
            cell.font, cell.border = BODY_FONT, BORDER
            cell.alignment = wrap
    sm.column_dimensions["A"].width = 42
    sm.column_dimensions["B"].width = 16
    sm.column_dimensions["C"].width = 70
    sm.freeze_panes = "A3"
    sm.sheet_properties.pageSetUpPr.fitToPage = True
    sm.page_setup.orientation = "landscape"
    sm.page_setup.paperSize = sm.PAPERSIZE_A4
    sm.page_setup.fitToWidth = 1
    sm.page_setup.fitToHeight = 0
    sm.print_title_rows = "2:2"

    # ---------------- Legend ----------------
    lg = wb.create_sheet("Legend & Definitions")
    assert lg is not None
    lg["A1"] = "Single source of truth - October Visit 2026 attendance (backup 2026-10-13)"
    lg["A1"].font = Font(name="Arial", size=12, bold=True)
    legend = [
        ("Source", "Db Backups/backups/2026-10-13/portal-local (attendance_sessions 10508 rows, "
                    "deployments 2587, sewadar_consents 3485). Mirrors dp_* / vw_* deduped, never double-counted."),
        ("Window", "Wed 07-Oct-2026 to Sun 11-Oct-2026 (visit_start -> visit_end). Pre-window scans "
                    "(03-06 Oct) never create columns; they appear only inside Remarks / NO IN notes."),
        ("Presence law", "Strict event-date (= portal v45): Present(badge, D) iff IN or OUT on D. "
                          "A silent day is Absent - nothing carries over, even with an OPEN session."),
        ("Day columns", "Each day is one merged band split into IN | OUT. IN = First IN on that date; "
                        "OUT = Latest OUT on that date. Multiple sessions merge to earliest IN / latest OUT, "
                        "tagged '(×N)'."),
        ("NO OUT (OUT …)", "IN exists on D but no OUT on D (OUT cell). Names the later OUT date when the "
                            "session closed afterwards, else 'still open'."),
        ("NO IN (IN …)", "OUT on D whose IN was an earlier day (IN cell) - the forgotten-OUT case "
                          "surfacing late."),
        ("Absent", "No IN and no OUT on that date (both cells). 'Never reported' = Absent all 5 AND zero scans anywhere."),
        ("Deployed Dept", "Final dept if finalized (deployed_department_id), else requested department. "
                           "Only 91/2587 rows finalized at backup time."),
        ("Days Present", "Formula: (IN<>\"Absent\") summed over the 5 day-IN cols - recalculates live; 0-5."),
        ("Identity", "Badge number only. Names repeat (1851 names vs 2334 badges); never key on name."),
        ("Manual marking (blue)", "'Present (marked)' with NO time = owner-ordered attendance "
                                  "(13-Oct-2026), not a scan. Original scan day-count is kept in Remarks. "
                                  "7 badges: FB5978GA0015/0003/0005/0004/0001/0088/0027."),
        ("Colours", "Grey italic = Absent. Orange = needs action (NO OUT / NO IN forgot-OUT). "
                     "Blue = manually marked present (no scan time)."),
    ]
    for k, v in legend:
        lg.append([k, v])
        lg.cell(row=lg.max_row, column=1).font = Font(name="Arial", size=10, bold=True)
        lg.cell(row=lg.max_row, column=2).font = BODY_FONT
        lg.cell(row=lg.max_row, column=2).alignment = wrap
    lg.column_dimensions["A"].width = 20
    lg.column_dimensions["B"].width = 130

    wb.save(OUT_XLSX)
    print(f"rows_written={len(rows)}")
    print(f"expect_present={expect_present}")
    print(f"file={OUT_XLSX} ({OUT_XLSX.stat().st_size} bytes)")

    # readback check: print setup + a formula sample (values need Excel/LibreOffice to calculate)
    from openpyxl import load_workbook as _lb
    chk = _lb(OUT_XLSX)
    ws2 = chk[MAIN_SHEET]
    assert ws2.freeze_panes == "E3" and ws2.auto_filter.ref == f"A2:P{last}", "sheet setup"
    assert str(ws2.cell(row=3, column=15).value).startswith("=("), "Days Present formula"
    assert ws2.merged_cells is not None and len(list(ws2.merged_cells.ranges)) == 5, "day bands"
    print(f"readback_ok sheet_setup={ws2.dimensions} autofilter={ws2.auto_filter.ref}")
    print("ALL GATES PASSED")


if __name__ == "__main__":
    sys.exit(main())
