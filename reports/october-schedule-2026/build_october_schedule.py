#!/usr/bin/env python3
"""October Visit 2026 — centre x department scheduled-count workbook.

Reads the LIVE portal DB (read-only, service role) and writes
October-2026-Schedule.xlsx next to this script.

SCHEDULED COUNT = one deployments row (one badge) for the schedule, counted
against its REQUESTED department (deployments.department_id). Final
(deployed_department_id) is shown separately on the Detail sheet only.

Sheets
  Centre x Department  41 centres x departments, COUNTIFS over Detail
  Parent x Department  18 parent centres (quota roots) x 13, + allocation
  Centre Summary       per-centre totals
  Detail               every scheduled sewadar (2587 rows)
  Notes                source, definitions, caveats

Env: PORTAL_SUPABASE_URL + PORTAL_SERVICE_ROLE_KEY, else read from
/Users/jai/Documents/GitHub/Db Backups/.env
"""
import json
import os
import subprocess
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SCHEDULE_ID = "b1f448a4-e5b3-4aa3-a915-ca2ee82cdd53"
OUT = Path(__file__).parent / "October-2026-Schedule.xlsx"
FALLBACK_ENV = Path("/Users/jai/Documents/GitHub/Db Backups/.env")

FONT = "Arial"
HDR_FILL = PatternFill("solid", fgColor="1F3864")
HDR_FONT = Font(name=FONT, size=10, bold=True, color="FFFFFF")
SUB_FILL = PatternFill("solid", fgColor="D9E2F3")
BAND_FILL = PatternFill("solid", fgColor="F2F5FA")
TOTAL_FILL = PatternFill("solid", fgColor="E2EFDA")
FLAG_FILL = PatternFill("solid", fgColor="FFF2CC")
THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def env():
    url = os.environ.get("PORTAL_SUPABASE_URL")
    key = os.environ.get("PORTAL_SERVICE_ROLE_KEY")
    if url and key:
        return url, key
    vals = {}
    for line in FALLBACK_ENV.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals["PORTAL_SUPABASE_URL"], vals["PORTAL_SERVICE_ROLE_KEY"]


URL, KEY = env()


def fetch(table, params):
    out, off, page = [], 0, 1000
    while True:
        q = f"{table}?" + urllib.parse.urlencode(params) + f"&limit={page}&offset={off}"
        r = subprocess.run(
            ["curl", "-sS", f"{URL}/rest/v1/{q}",
             "-H", f"apikey: {KEY}", "-H", f"Authorization: Bearer {KEY}"],
            capture_output=True, text=True, check=True,
        )
        d = json.loads(r.stdout)
        if isinstance(d, dict):
            raise SystemExit(f"{table}: {d}")
        out += d
        if len(d) < page:
            return out
        off += page


def style_header(ws, row, ncols, height=30):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.border = BOX
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = height


def root_of(name, parent):
    seen = set()
    while parent.get(name) and name not in seen:
        seen.add(name)
        name = parent[name]
    return name


def main():
    depts = fetch("deployment_departments",
                  {"select": "id,name,is_active,min_days", "order": "name"})
    centres = fetch("centres", {"select": "id,name,parent_centre,is_active", "order": "name"})
    allocs = fetch("centre_allocations",
                   {"select": "centre,department_id,max_count", "schedule_id": f"eq.{SCHEDULE_ID}"})
    deps = fetch("deployments",
                 {"select": "centre,department_id,deployed_department_id,badge_number,"
                            "sewadar_name,status",
                  "schedule_id": f"eq.{SCHEDULE_ID}", "order": "centre"})

    dept_name = {d["id"]: d["name"] for d in depts}
    dept_min = {d["id"]: d["min_days"] for d in depts}
    parent = {c["name"]: c["parent_centre"] for c in centres}
    centre_names = sorted(parent)
    dept_names = sorted(dept_name.values())

    # ---- Detail rows -------------------------------------------------------
    detail = []
    for d in deps:
        detail.append({
            "centre": d["centre"],
            "root": root_of(d["centre"], parent),
            "badge": d["badge_number"],
            "name": d["sewadar_name"] or "",
            "dept": dept_name.get(d["department_id"], "?"),
            "final": dept_name.get(d["deployed_department_id"], "") if d["deployed_department_id"] else "",
            "status": d["status"],
        })
    detail.sort(key=lambda r: (r["root"], r["centre"], r["dept"], r["name"]))
    n_detail = len(detail)
    detail_first, detail_last = 2, n_detail + 1

    wb = Workbook()

    # ======================= Sheet 1: Centre x Department ==================
    ws = wb.active
    ws.title = "Centre x Department"
    ws["A1"] = "October Visit 2026 — scheduled count by centre and department"
    ws["A1"].font = Font(name=FONT, size=14, bold=True, color="1F3864")
    ws["A2"] = (f"One row per centre, one column per department. Value = sewadars scheduled to that "
                f"centre in that (requested) department. Source: live portal DB, schedule "
                f"'October Visit 2026'. Snapshot {datetime.now(timezone.utc).strftime('%d-%b-%Y %H:%M UTC')}.")
    ws["A2"].font = Font(name=FONT, size=9, italic=True, color="595959")
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(dept_names) + 3)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(dept_names) + 3)
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[2].height = 28

    hdr = 4
    heads = ["Parent Centre", "Centre"] + dept_names + ["Total Scheduled", "Departments"]
    for i, h in enumerate(heads, start=1):
        ws.cell(row=hdr, column=i, value=h)
    style_header(ws, hdr, len(heads), height=42)

    for r, cname in enumerate(centre_names, start=hdr + 1):
        ws.cell(row=r, column=1, value=root_of(cname, parent))
        ws.cell(row=r, column=2, value=cname)
        for j, dname in enumerate(dept_names, start=3):
            col = get_column_letter(j)
            ws.cell(row=r, column=j,
                    value=f'=COUNTIFS(Detail!$B${detail_first}:$B${detail_last},$B{r},'
                          f'Detail!$E${detail_first}:$E${detail_last},{col}${hdr})')
        tot_col = len(dept_names) + 3
        ws.cell(row=r, column=tot_col,
                value=f"=SUM({get_column_letter(3)}{r}:{get_column_letter(len(dept_names)+2)}{r})")
        ws.cell(row=r, column=tot_col + 1,
                value=f"=COUNTIF({get_column_letter(3)}{r}:{get_column_letter(len(dept_names)+2)}{r},\">0\")")

    last = hdr + len(centre_names)
    tot_row = last + 1
    ws.cell(row=tot_row, column=1, value="ALL CENTRES")
    ws.cell(row=tot_row, column=2, value="")
    for j in range(3, len(heads) + 1):
        col = get_column_letter(j)
        ws.cell(row=tot_row, column=j, value=f"=SUM({col}{hdr+1}:{col}{last})")

    for r in range(hdr + 1, tot_row + 1):
        for c in range(1, len(heads) + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = BOX
            cell.font = Font(name=FONT, size=10, bold=(r == tot_row))
            if c >= 3:
                cell.number_format = "#,##0;-#,##0;-"
                cell.alignment = Alignment(horizontal="center")
            if r == tot_row:
                cell.fill = TOTAL_FILL
            elif r % 2 == 0:
                cell.fill = BAND_FILL
    ws.freeze_panes = "C5"
    ws.column_dimensions["A"].width = 20
    ws.column_dimensions["B"].width = 20
    for j in range(3, len(dept_names) + 3):
        ws.column_dimensions[get_column_letter(j)].width = 11
    ws.column_dimensions[get_column_letter(len(dept_names) + 3)].width = 12
    ws.column_dimensions[get_column_letter(len(dept_names) + 4)].width = 12

    # ======================= Sheet 2: Parent x Department ==================
    ws2 = wb.create_sheet("Parent x Department")
    ws2["A1"] = "October Visit 2026 — parent centre (quota root) x department"
    ws2["A1"].font = Font(name=FONT, size=14, bold=True, color="1F3864")
    ws2["A2"] = ("Parent centres hold the quota; a parent and its sub-centres (SC_SPs) share it. "
                 "Scheduled = sum of all sub-centre rows. Allocated = centre_allocations.max_count. "
                 "Balance = Allocated - Scheduled (negative = over quota).")
    ws2["A2"].font = Font(name=FONT, size=9, italic=True, color="595959")
    ws2.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(dept_names) + 3)
    ws2.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(dept_names) + 3)
    ws2.row_dimensions[2].height = 28
    ws2["A2"].alignment = Alignment(wrap_text=True, vertical="top")

    roots = sorted({root_of(c, parent) for c in centre_names})

    h2 = 4
    heads2 = ["Parent Centre"] + dept_names + ["Total Scheduled", "Total Allocated", "Balance"]
    for i, h in enumerate(heads2, start=1):
        ws2.cell(row=h2, column=i, value=h)
    style_header(ws2, h2, len(heads2), height=42)

    r = h2 + 1
    for rt in roots:
        ws2.cell(row=r, column=1, value=rt)
        for j, dname in enumerate(dept_names, start=2):
            ws2.cell(row=r, column=j,
                     value=f'=COUNTIFS(Detail!$A${detail_first}:$A${detail_last},$A{r},'
                           f'Detail!$E${detail_first}:$E${detail_last},{get_column_letter(j)}${h2})')
        tot = len(dept_names) + 2
        ws2.cell(row=r, column=tot,
                 value=f"=SUM({get_column_letter(2)}{r}:{get_column_letter(len(dept_names)+1)}{r})")
        ws2.cell(row=r, column=tot + 1,
                 value=f"=SUMIFS(Allocations!$C$5:$C${4+len(allocs)},"
                       f"Allocations!$A$5:$A${4+len(allocs)},$A{r})")
        ws2.cell(row=r, column=tot + 2,
                 value=f"={get_column_letter(tot+1)}{r}-{get_column_letter(tot)}{r}")
        r += 1

    last2 = r - 1
    tr2 = r
    ws2.cell(row=tr2, column=1, value="ALL PARENTS")
    for j in range(2, len(heads2) + 1):
        col = get_column_letter(j)
        ws2.cell(row=tr2, column=j, value=f"=SUM({col}{h2+1}:{col}{last2})")

    for rr in range(h2 + 1, tr2 + 1):
        for c in range(1, len(heads2) + 1):
            cell = ws2.cell(row=rr, column=c)
            cell.border = BOX
            cell.font = Font(name=FONT, size=10, bold=(rr == tr2))
            if c >= 2:
                cell.number_format = "#,##0;-#,##0;-"
                cell.alignment = Alignment(horizontal="center")
            if rr == tr2:
                cell.fill = TOTAL_FILL
            elif rr % 2 == 0:
                cell.fill = BAND_FILL
    # flag negative balances
    for rr in range(h2 + 1, last2 + 1):
        cell = ws2.cell(row=rr, column=len(heads2))
        cell.fill = FLAG_FILL
    ws2.freeze_panes = "B5"
    ws2.column_dimensions["A"].width = 22
    for j in range(2, len(dept_names) + 2):
        ws2.column_dimensions[get_column_letter(j)].width = 11
    for j in range(len(dept_names) + 2, len(heads2) + 1):
        ws2.column_dimensions[get_column_letter(j)].width = 13

    # ======================= Sheet 3: Centre Summary =======================
    ws3 = wb.create_sheet("Centre Summary")
    ws3["A1"] = "October Visit 2026 — scheduled count per centre"
    ws3["A1"].font = Font(name=FONT, size=14, bold=True, color="1F3864")
    h3 = 3
    heads3 = ["Parent Centre", "Centre", "Scheduled Sewadars", "Departments Used"]
    for i, h in enumerate(heads3, start=1):
        ws3.cell(row=h3, column=i, value=h)
    style_header(ws3, h3, len(heads3), height=32)
    src = "'Centre x Department'"
    for i, cname in enumerate(centre_names):
        rr = h3 + 1 + i
        srow = hdr + 1 + i
        ws3.cell(row=rr, column=1, value=root_of(cname, parent))
        ws3.cell(row=rr, column=2, value=cname)
        ws3.cell(row=rr, column=3,
                 value=f"={src}!{get_column_letter(len(dept_names)+3)}{srow}")
        ws3.cell(row=rr, column=4,
                 value=f"={src}!{get_column_letter(len(dept_names)+4)}{srow}")
    last3 = h3 + len(centre_names)
    tr3 = last3 + 1
    ws3.cell(row=tr3, column=1, value="TOTAL")
    for c in (3, 4):
        col = get_column_letter(c)
        ws3.cell(row=tr3, column=c, value=f"=SUM({col}{h3+1}:{col}{last3})")
    for rr in range(h3 + 1, tr3 + 1):
        for c in range(1, 5):
            cell = ws3.cell(row=rr, column=c)
            cell.border = BOX
            cell.font = Font(name=FONT, size=10, bold=(rr == tr3))
            if c >= 3:
                cell.number_format = "#,##0"
                cell.alignment = Alignment(horizontal="center")
            if rr == tr3:
                cell.fill = TOTAL_FILL
            elif rr % 2 == 0:
                cell.fill = BAND_FILL
    ws3.freeze_panes = "A4"
    ws3.column_dimensions["A"].width = 22
    ws3.column_dimensions["B"].width = 22
    ws3.column_dimensions["C"].width = 18
    ws3.column_dimensions["D"].width = 17

    # ======================= Sheet 4: Detail ===============================
    wsd = wb.create_sheet("Detail")
    headsd = ["Parent Centre", "Centre", "Badge", "Sewadar Name",
              "Requested Department", "Final Department", "Status"]
    for i, h in enumerate(headsd, start=1):
        wsd.cell(row=1, column=i, value=h)
    style_header(wsd, 1, len(headsd), height=32)
    for i, row in enumerate(detail, start=2):
        vals = [row["root"], row["centre"], row["badge"], row["name"],
                row["dept"], row["final"], row["status"]]
        for c, v in enumerate(vals, start=1):
            cell = wsd.cell(row=i, column=c, value=v)
            cell.font = Font(name=FONT, size=10)
            cell.border = BOX
            if i % 2 == 0:
                cell.fill = BAND_FILL
    wsd.freeze_panes = "A2"
    wsd.auto_filter.ref = f"A1:G{detail_last}"
    for col, w in zip("ABCDEFG", (20, 20, 15, 30, 22, 22, 12)):
        wsd.column_dimensions[col].width = w

    # ======================= Sheet: Allocations (source) ===================
    wsa = wb.create_sheet("Allocations")
    wsa["A1"] = "Quota source — centre_allocations (parent centre x department)"
    wsa["A1"].font = Font(name=FONT, size=14, bold=True, color="1F3864")
    wsa["A2"] = ("Each row is the quota the ASO allocated for one parent centre and one department. "
                 "A parent and its sub-centres (SC_SPs) share the quota. Used by the "
                 "'Parent x Department' sheet via SUMIFS.")
    wsa["A2"].font = Font(name=FONT, size=9, italic=True, color="595959")
    wsa.merge_cells(start_row=1, start_column=1, end_row=1, end_column=3)
    wsa.merge_cells(start_row=2, start_column=1, end_row=2, end_column=3)
    wsa["A2"].alignment = Alignment(wrap_text=True, vertical="top")
    wsa.row_dimensions[2].height = 30
    for i, h in enumerate(["Parent Centre", "Department", "Allocated (max_count)"], start=1):
        wsa.cell(row=4, column=i, value=h)
    style_header(wsa, 4, 3, height=32)
    alloc_rows = sorted((a["centre"], dept_name.get(a["department_id"], "?"), a["max_count"])
                        for a in allocs)
    for i, (cname, dname, mx) in enumerate(alloc_rows, start=5):
        wsa.cell(row=i, column=1, value=cname)
        wsa.cell(row=i, column=2, value=dname)
        wsa.cell(row=i, column=3, value=mx)
        for c in range(1, 4):
            cell = wsa.cell(row=i, column=c)
            cell.font = Font(name=FONT, size=10)
            cell.border = BOX
            if c == 3:
                cell.number_format = "#,##0"
                cell.alignment = Alignment(horizontal="center")
            if i % 2 == 0:
                cell.fill = BAND_FILL
    tot_a = 5 + len(alloc_rows)
    wsa.cell(row=tot_a, column=1, value="TOTAL")
    wsa.cell(row=tot_a, column=3, value=f"=SUM(C5:C{tot_a-1})")
    for c in range(1, 4):
        cell = wsa.cell(row=tot_a, column=c)
        cell.font = Font(name=FONT, size=10, bold=True)
        cell.fill = TOTAL_FILL
        cell.border = BOX
        if c == 3:
            cell.number_format = "#,##0"
    wsa.freeze_panes = "A5"
    wsa.column_dimensions["A"].width = 24
    wsa.column_dimensions["B"].width = 24
    wsa.column_dimensions["C"].width = 20

    # ======================= Sheet 5: Notes ================================
    wsn = wb.create_sheet("Notes")
    wsn["A1"] = "Definitions, source and caveats"
    wsn["A1"].font = Font(name=FONT, size=14, bold=True, color="1F3864")
    notes = [
        ("Schedule", "October Visit 2026 — visit window Wed 07-Oct-2026 to Sun 11-Oct-2026; "
                     "status open; deployment deadline 07-Sep-2026 18:25 UTC."),
        ("Source", "Live portal Supabase DB (read-only service-role SELECT). "
                   "deployments 2587 rows, centre_allocations 140 rows, "
                   "deployment_departments 14 rows, centres 41 rows."),
        ("Scheduled count", "Number of deployments rows = number of sewadars scheduled. One badge "
                            "can hold only one row per schedule, so counts are per sewadar, not per day."),
        ("Department", "Counts use the REQUESTED department (deployments.department_id). "
                       "The final ASO-set department (deployed_department_id) is on the Detail sheet; "
                       "only 91 rows have a final department so far."),
        ("Parent vs centre", "A parent centre (quota root) owns the allocation; its sub-centres "
                             "(SC_SPs) share that quota. 'Parent x Department' rolls sub-centres up."),
        ("Allocation", "Allocated = centre_allocations.max_count for that parent centre x department. "
                       "Balance negative (yellow) = scheduled exceeds the allocated quota."),
        ("Known data facts", "All 2587 scheduled sewadars have consent_given = true. "
                             "All 2587 rows are status 'requested'. 13 of 14 departments carry "
                             "deployments; SANITATION has no allocation rows and no deployments."),
        ("Recalculation", "All matrix cells are COUNTIFS/SUM formulas over the Detail and "
                          "Allocations sheets, so editing Detail recalculates every summary."),
        ("Sheets", "Centre x Department (41 centres), Parent x Department (18 quota roots), "
                   "Centre Summary, Detail (2587 rows, filterable), Allocations (140 source rows), "
                   "Notes."),
    ]
    r = 3
    for label, text in notes:
        wsn.cell(row=r, column=1, value=label).font = Font(name=FONT, size=10, bold=True)
        c = wsn.cell(row=r, column=2, value=text)
        c.font = Font(name=FONT, size=10)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        wsn.row_dimensions[r].height = 46
        r += 1
    wsn.column_dimensions["A"].width = 22
    wsn.column_dimensions["B"].width = 110

    # ---- print setup on every sheet --------------------------------------
    for sheet in wb.worksheets:
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.orientation = "landscape"
        sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
        sheet.page_margins.left = sheet.page_margins.right = 0.4
        sheet.page_margins.top = sheet.page_margins.bottom = 0.5
    ws.print_area = f"A1:{get_column_letter(len(heads))}{tot_row}"
    ws.print_title_rows = f"{hdr}:{hdr}"
    ws2.print_area = f"A1:{get_column_letter(len(heads2))}{tr2}"
    ws2.print_title_rows = f"{h2}:{h2}"
    wsd.print_title_rows = "1:1"
    wsd.print_area = f"A1:G{detail_last}"
    ws3.print_area = f"A1:D{tr3}"
    ws3.print_title_rows = f"{h3}:{h3}"
    wsa.print_area = f"A1:C{tot_a}"
    wsa.print_title_rows = "4:4"
    wsn.print_area = f"A1:B{r-1}"

    wb.save(OUT)
    print(f"wrote {OUT}  detail_rows={n_detail} centres={len(centre_names)} "
          f"departments={len(dept_names)} parents={len(roots)}")


if __name__ == "__main__":
    main()
