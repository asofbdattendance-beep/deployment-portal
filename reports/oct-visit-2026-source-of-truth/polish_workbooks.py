#!/usr/bin/env python3
"""Polish pass over the three October-Visit report workbooks (in place).

- Shortens day-cell + Remarks vocabulary (same meaning, fewer words).
- Professional theme: two-tone headers, banded rows, kept signal fills.
- Fixes: the 2 zero-scan override badges no longer carry 'Undeployed scan';
  Summary's Forgot-OUT COUNTIF is repointed at the short wording.

Run from this folder:  python3 polish_workbooks.py
Safe to re-run (all replacements are idempotent).
"""
import re
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

HERE = Path(__file__).parent
FILES = ["October-Visit-2026-Source-of-Truth.xlsx",
         "October-Visit-2026-Present-Reports.xlsx",
         "October-Visit-2026-Absent-Reports.xlsx"]

NAVY = PatternFill("solid", fgColor="1F4E79")
NAVY_LT = PatternFill("solid", fgColor="2F5597")
BAND = PatternFill("solid", fgColor="F2F7FB")
HDR_FONT = Font(name="Arial", size=11, bold=True, color="FFFFFF")
HDR_FONT_SM = Font(name="Arial", size=10, bold=True, color="FFFFFF")
BODY_FONT = Font(name="Arial", size=10)
KEY_FONT = Font(name="Arial", size=10, bold=True)
thin = Side(style="thin", color="B0B0B0")
GRID = Border(left=thin, right=thin, top=thin, bottom=thin)
HDR_BORDER = Border(left=thin, right=thin, top=thin,
                    bottom=Side(style="medium", color="1F4E79"))
WRAP = Alignment(vertical="center", wrap_text=True)
CENTER = Alignment(vertical="center", horizontal="center", wrap_text=True)
DEFAULT_FILL = PatternFill()


def short_text(v):
    """Shorten one cell value. Returns (new_value, changed)."""
    if not isinstance(v, str) or not v:
        return v, False
    o = v
    v = re.sub(r" \((\d+) sessions\)", r" (×\1)", v)
    v = re.sub(r"NO OUT \(Forgot OUT, OUT on ([^);]+)(; Still OPEN - forgot OUT)?\)",
               lambda m: "NO OUT (OUT %s%s)" % (m.group(1), "; still open" if m.group(2) else ""), v)
    v = v.replace("NO OUT (Still OPEN - forgot OUT)", "NO OUT (still open)")
    v = re.sub(r"NO IN \(IN was ([^;]+); forgot OUT( that day)?\)", r"NO IN (IN \1)", v)
    v = v.replace("Never reported (deployed, zero scans)", "Never reported — no scans")
    v = v.replace("Undeployed scan (scanned, not in deployments)", "Undeployed scan — not in roster")
    v = re.sub(r"Forgot OUT: IN (\S+) -> OUT (\S+)", r"Forgot OUT \1→\2", v)
    v = re.sub(r"Still OPEN since (\S+) \(never OUT\)", r"Still OPEN — IN \1, no OUT", v)
    v = re.sub(r"Manual entries: (\d+)/(\d+) sessions", r"Manual ×\1/\2", v)
    v = v.replace("All scans manual entry", "All manual")
    v = v.replace("Only pre-window scans (03-06 Oct); absent all window days",
                  "Only pre-window scans (03–06 Oct)")
    v = v.replace("Final dept assigned", "Finalised")
    v = re.sub(r"MANUAL OVERRIDE 13-Oct-2026: marked present all 5 days per owner "
               r"instruction - no scan times shown\. Original scan record: present "
               r"(\d+)/5 days per scans\.",
               r"Marked present 5/5 by owner 13-Oct — no scan times. Scans showed \1/5.", v)
    v = v.replace(" Badge NOT in deployments roster - row added per owner.",
                  " Not in roster — row added by owner.")
    # legend / cover prose
    v = v.replace("tagged '(N sessions)'", "tagged '(×N)'")
    v = v.replace("NO OUT (Forgot OUT ...)", "NO OUT (OUT …)")
    v = v.replace("NO IN ... (IN was DD-Mon)", "NO IN (IN …)")
    v = v.replace("else 'Still OPEN'", "else 'still open'")
    return v, v != o


def style_header_row(ws, row, font=HDR_FONT):
    for c in range(1, ws.max_column + 1):
        cell = ws.cell(row=row, column=c)
        if cell.value is None and row > 1:
            continue
        cell.fill = NAVY
        cell.font = font
        cell.border = HDR_BORDER
        cell.alignment = CENTER


def band_rows(ws, first, last, ncols):
    for i in range(first, last + 1):
        if i % 2 == 0:
            for c in range(1, ncols + 1):
                cell = ws.cell(row=i, column=c)
                if cell.fill == DEFAULT_FILL:
                    cell.fill = BAND
                if not cell.font or cell.font == Font():
                    cell.font = BODY_FONT
                cell.border = GRID
                if cell.alignment is None or cell.alignment.vertical is None:
                    cell.alignment = WRAP


def style_keyvalue(ws):
    for i in range(1, ws.max_row + 1):
        a, b = ws.cell(row=i, column=1), ws.cell(row=i, column=2)
        if a.value:
            a.font = KEY_FONT
            a.alignment = WRAP
        if b.value:
            if not b.font or b.font == Font():
                b.font = BODY_FONT
            b.alignment = WRAP
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 130


def polish_data_sheet(ws, remark_col, first=3, subhead=False):
    ncols = ws.max_column
    style_header_row(ws, 1)
    if subhead:
        for c in range(1, ncols + 1):
            cell = ws.cell(row=2, column=c)
            if cell.value is not None:
                cell.fill = NAVY_LT
                cell.font = HDR_FONT_SM
                cell.border = HDR_BORDER
                cell.alignment = CENTER
    band_rows(ws, first, ws.max_row, ncols)
    ws.freeze_panes = "A2" if not subhead else ws.freeze_panes


def main():
    changed_total = 0
    for f in FILES:
        path = HERE / f
        wb = load_workbook(path)
        changed = 0
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for cell in row:
                    v = cell.value
                    if isinstance(v, str) and v.startswith("="):
                        if "*Forgot OUT: IN*" in v:
                            cell.value = v.replace("*Forgot OUT: IN*", "*Forgot OUT*")
                            changed += 1
                        continue
                    nv, ch = short_text(v)
                    if ch:
                        cell.value = nv
                        changed += 1
        # zero-scan override badges must not say 'Undeployed scan'
        for ws in wb.worksheets:
            if ws.max_column < 1:
                continue
            for i in range(1, ws.max_row + 1):
                if ws.cell(row=i, column=1).value in ("FB5978GA0003", "FB5978GA0027"):
                    for c in range(1, ws.max_column + 1):
                        cell = ws.cell(row=i, column=c)
                        if isinstance(cell.value, str) and "Undeployed scan" in cell.value:
                            cell.value = cell.value.replace(
                                "; Undeployed scan — not in roster", "").replace(
                                "Undeployed scan — not in roster; ", "").replace(
                                "Undeployed scan — not in roster", "—")
                            changed += 1
        # styling per sheet
        for ws in wb.worksheets:
            title = ws.title
            if title == "Attendance Truth":
                polish_data_sheet(ws, 16, subhead=True)
            elif title.startswith(("Present ", "Absent ", "Late ", "Early ", "Never ")):
                polish_data_sheet(ws, 99)
            elif title in ("Cover", "Legend & Definitions", "Summary"):
                style_keyvalue(ws)
        wb.save(path)
        print(f"{f}: text_changes={changed}")
        changed_total += changed
    print(f"TOTAL text changes: {changed_total}")


if __name__ == "__main__":
    main()
