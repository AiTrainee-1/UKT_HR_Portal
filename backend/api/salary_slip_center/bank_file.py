"""The bank transfer file of the standalone slips, in the SAME bank template as the payroll bank file
(frontend/src/lib/payrollExcelExport.ts): header row + the M / O row, then one row per employee paid.

Who is paid: a selected employee with a saved slip, not on this page's Hold, with a bank account number and an IFSC code,
and a NET above zero. Everyone else is listed by check() with the reason, so the page can show it before the download.
The amount is the slip's NET, already a whole rupee (engine.py rounds it up like payroll).
"""

from __future__ import annotations

import io
from decimal import Decimal

from ..models import Employee, StandaloneSalarySlip
from . import engine

HEADERS = [
    "TXN TYPE\nRTGS-R\nNEFT-N\nHDFC TRF-I\nIMPS - M(1)",
    'BENEFICIARY CODE\n(MANDATORY ONLY FOR\nTXN TYPE "I")\n(13)',
    "EMPLOYEE CODE",
    "BENE A/C NO\n(25)",
    "AMOUNT\n(20)",
    "BENEFICIARY NAME\n(35)",
    "IFSC CODE\n(11)",
    "BENE BANK NAME\n(40)",
    "BENE BANK BRANCH NAME\n(40)",
    "BENE EMAIL ID\n(100)",
]
INDICATORS = ["M", "M / O", "", "M", "M", "M", "M", "M", "O", "M"]
WIDTHS = [18, 22, 16, 24, 14, 32, 16, 30, 30, 32]
AMOUNT_COLUMN = 5


def check(employees: list[Employee], slips: dict[int, StandaloneSalarySlip], held: set[int]) -> dict:
    included, left_out = [], []
    total = Decimal("0")
    for emp in employees:
        base = {"employeeId": emp.id, "code": emp.employee_code, "name": engine.full_name(emp)}
        slip = slips.get(emp.id)
        if slip is None:
            reason = "Not generated yet"
        elif emp.id in held:
            reason = "On hold"
        elif engine.bank_issue(emp):
            reason = engine.bank_issue(emp)
        elif slip.net <= 0:
            reason = "Net pay is zero"
        else:
            reason = None
        if reason:
            left_out.append({**base, "reason": reason})
            continue
        total += slip.net
        included.append({**base, "amount": float(slip.net)})
    return {"included": included, "total": float(total), "leftOut": left_out}


def build_xlsx(employees: list[Employee], slips: dict[int, StandaloneSalarySlip], held: set[int], sheet: str) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    result = check(employees, slips, held)
    paid = {row["employeeId"] for row in result["included"]}
    wb = Workbook()
    ws = wb.active
    ws.title = sheet[:31]
    for i, width in enumerate(WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    green = PatternFill("solid", fgColor="5B8C00")

    def header(cell, amount=False):
        cell.fill = green
        cell.font = Font(bold=True, color="FF0000" if amount else "FFFFFF")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for i, text in enumerate(HEADERS, start=1):
        header(ws.cell(row=1, column=i, value=text), amount=i == AMOUNT_COLUMN)
    ws.row_dimensions[1].height = 72
    for i, text in enumerate(INDICATORS, start=1):
        header(ws.cell(row=2, column=i, value=text or None))
    ws.row_dimensions[2].height = 18

    r = 2
    for emp in employees:
        if emp.id not in paid:
            continue
        r += 1
        values = [
            "",
            "",
            emp.employee_code or "",
            (emp.bank_account or "").strip().upper(),
            float(slips[emp.id].net),
            engine.full_name(emp).upper(),
            (emp.bank_ifsc or "").strip().upper(),
            (emp.bank_name or "").strip().upper(),
            "",
            "",
        ]
        for i, value in enumerate(values, start=1):
            c = ws.cell(row=r, column=i, value=value)
            c.alignment = Alignment(horizontal="center", vertical="center")
            if i in (3, 4):
                c.number_format = "@"  # as text: an account number or a code like 0123 keeps its zeros
            if i == AMOUNT_COLUMN:
                c.number_format = "#,##0.00"
        ws.row_dimensions[r].height = 16
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
