"""The Salary Slip page's rows, Generate and Hold (see the package docstring). Saves only this module's own tables."""

from __future__ import annotations

from datetime import date

from django.db import transaction
from django.utils import timezone

from ..compensation_shared import parse_join_date
from ..models import Department, Designation, Employee, StandaloneSalaryHold, StandaloneSalarySlip
from ..unit_labels import unit_label
from . import engine

MAX_PER_CALL = 50
REASON_MAX = 300


def employees_qs(base):
    """Every employee of the caller's scope (active AND inactive), with what the rows need."""
    return (
        base.select_related("department", "designation", "branch")
        .defer("photo_url", "password_hash", "address")
        .order_by("employee_code")
    )


def is_new_joiner(emp: Employee, month: int, year: int) -> bool:
    joined = parse_join_date(emp.join_date)
    return bool(joined and joined.year == year and joined.month == month)


def slip_summary(slip: StandaloneSalarySlip) -> dict:
    figures = slip.figures or {}
    return {
        "slipNumber": slip.slip_number,
        "generatedAt": timezone.localtime(slip.generated_at).isoformat() if slip.generated_at else None,
        "generatedBy": slip.generated_by_name or "",
        "gross": float(slip.gross),
        "deductions": float(slip.deductions),
        "net": float(slip.net),
        "paidDays": figures.get("paidDays"),
        "options": slip.options or {},
        "countedTo": slip.counted_to.isoformat() if slip.counted_to else None,
    }


def hold_json(emp_id: int, hold: StandaloneSalaryHold | None) -> dict:
    return {
        "id": emp_id,
        "onHold": hold is not None,
        "holdReason": hold.reason if hold else "",
        "heldAt": timezone.localtime(hold.held_at).isoformat() if hold and hold.held_at else None,
        "heldBy": hold.held_by_name if hold else None,
    }


def page_rows(employees, month: int, year: int) -> list[dict]:
    employees = list(employees)
    ids = [e.id for e in employees]
    slips = {s.employee_id: s for s in StandaloneSalarySlip.objects.filter(employee_id__in=ids, month=month, year=year)}
    holds = {h.employee_id: h for h in StandaloneSalaryHold.objects.filter(employee_id__in=ids, month=month, year=year)}
    rows = []
    for emp in employees:
        kind = engine.kind_of(emp)
        joined = parse_join_date(emp.join_date)
        hold = holds.get(emp.id)
        slip = slips.get(emp.id)
        rows.append(
            {
                "id": emp.id,
                "code": emp.employee_code,
                "name": engine.full_name(emp),
                "category": kind,
                "status": (emp.status or "active").lower(),
                "departmentId": emp.department_id,
                "department": emp.department.name if emp.department_id and emp.department else "",
                "designationId": emp.designation_id,
                "designation": emp.designation.title if emp.designation_id and emp.designation else "",
                "branchId": emp.branch_id,
                "unit": (unit_label(emp.branch) or emp.branch.name) if emp.branch_id and emp.branch else "",
                "joinDate": joined.isoformat() if joined else None,
                "isNewJoiner": is_new_joiner(emp, month, year),
                **{k: v for k, v in hold_json(emp.id, hold).items() if k != "id"},
                "monthlySalary": float(emp.salary_amount) if kind == engine.KIND_STAFF and emp.salary_amount else None,
                "salaryPerShift": (
                    float(emp.salary_per_shift) if kind == engine.KIND_PRODUCTION and emp.salary_per_shift else None
                ),
                "payIssue": engine.pay_issue(emp),
                "bankAccountMasked": engine.mask_account(emp.bank_account),
                "bankIssue": engine.bank_issue(emp),
                "slip": slip_summary(slip) if slip else None,
            }
        )
    return rows


def filter_options(employees) -> dict:
    employees = list(employees)
    dept_ids = {e.department_id for e in employees if e.department_id}
    desig_ids = {e.designation_id for e in employees if e.designation_id}
    units = {}
    for e in employees:
        if e.branch_id and e.branch and e.branch_id not in units:
            units[e.branch_id] = unit_label(e.branch) or e.branch.name
    return {
        "departments": [
            {"id": d.id, "name": d.name, "category": d.category}
            for d in Department.objects.filter(id__in=dept_ids).order_by("name")
        ],
        "designations": [
            {"id": d.id, "title": d.title, "category": d.category}
            for d in Designation.objects.filter(id__in=desig_ids).order_by("title")
        ],
        "units": [{"id": k, "name": v} for k, v in sorted(units.items(), key=lambda kv: kv[1])],
    }


def save_slip(emp: Employee, result: dict, month: int, year: int, actor, actor_name: str) -> StandaloneSalarySlip:
    """Save (or replace) the month's slip of one employee."""
    counted = result.get("period", {}).get("countedTo")
    slip, _ = StandaloneSalarySlip.objects.update_or_create(
        employee=emp,
        month=month,
        year=year,
        defaults={
            "kind": result["kind"],
            "slip_number": result["slipNumber"],
            "figures": result,
            "gross": result["grossTotal"],
            "deductions": result["deductionsTotal"],
            "net": result["net"],
            "options": result.get("options") or {},
            "counted_to": date.fromisoformat(counted) if counted else None,
            "generated_by": actor,
            "generated_by_name": actor_name,
        },
    )
    return slip


def generate(employees, month: int, year: int, options: dict, actor, actor_name: str) -> dict:
    """Work out and save every given employee's slip; the ones that cannot be worked out are listed with the reason."""
    generated, skipped = [], []
    for emp in employees:
        try:
            result = engine.calculate(emp, month, year, options)
        except engine.CannotCalculate as exc:
            skipped.append(
                {"employeeId": emp.id, "code": emp.employee_code, "name": engine.full_name(emp), "reason": str(exc)}
            )
            continue
        with transaction.atomic():
            slip = save_slip(emp, result, month, year, actor, actor_name)
        generated.append({"employeeId": emp.id, "slip": slip_summary(slip)})
    return {"generated": generated, "skipped": skipped}


def set_hold(employees, month: int, year: int, hold: bool, reason: str, actor, actor_name: str) -> list[dict]:
    out = []
    with transaction.atomic():
        for emp in employees:
            if hold:
                row, _ = StandaloneSalaryHold.objects.update_or_create(
                    employee=emp,
                    month=month,
                    year=year,
                    defaults={"reason": reason, "held_by": actor, "held_by_name": actor_name},
                )
                out.append(hold_json(emp.id, row))
            else:
                StandaloneSalaryHold.objects.filter(employee=emp, month=month, year=year).delete()
                out.append(hold_json(emp.id, None))
    return out


def saved_slips(employee_ids, month: int, year: int) -> dict[int, StandaloneSalarySlip]:
    rows = StandaloneSalarySlip.objects.filter(
        employee_id__in=list(employee_ids), month=month, year=year
    ).select_related("employee", "employee__department", "employee__designation", "employee__branch")
    return {s.employee_id: s for s in rows}


def held_ids(employee_ids, month: int, year: int) -> set[int]:
    return set(
        StandaloneSalaryHold.objects.filter(employee_id__in=list(employee_ids), month=month, year=year).values_list(
            "employee_id", flat=True
        )
    )


def remarks_for(emp: Employee, month: int, year: int, held: bool) -> str:
    parts = []
    if held:
        parts.append("HOLD")
    if is_new_joiner(emp, month, year):
        parts.append("NEW JOINER")
    if (emp.status or "").lower() != "active":
        parts.append("INACTIVE")
    return ", ".join(parts)
