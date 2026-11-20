"""Pieces every Customise data source shares: the employee fields, the scope filters, the join-date reading and the
employee ordering. Nothing here registers anything."""

from __future__ import annotations

from datetime import date

from django.db.models import F

from .. import filters as Fl
from ..formatting import full_name
from ..types import TEXT, FilterSpec
from ..definitions.employees_master_base import code_key, join_date_of
from .fields import Field

# The employee's own record needs one of these to be read at all (the same modules that open an employee list elsewhere).
EMPLOYEE_MODULES = ("employees",)
UNASSIGNED = "Unassigned"
NO_BRANCH = "No branch"

# Never loaded with a report row: a base64 photo (~43 KB) and a password hash (README rule 9)
EMP_DEFER = ("photo_url", "password_hash")
REL_DEFER = tuple(f"employee__{c}" for c in EMP_DEFER)
REL_RELATED = ("employee", "employee__department", "employee__designation", "employee__branch")


# ── filters ─────────────────────────────────────────────────────────────────


def scope_filters(*, designation: bool = True, status: str = "active") -> tuple[FilterSpec, ...]:
    """Branch, department, (designation), employee type, employee and employee status: the builder's standard scope."""
    out: list[FilterSpec] = [Fl.branches(), Fl.departments()]
    if designation:
        out.append(Fl.designations())
    out += [Fl.employment_type(), Fl.employees(), Fl.employee_status(status)]
    return tuple(out)


# ── the employee fields ─────────────────────────────────────────────────────


def employee_fields(section: str = "employee") -> tuple[Field, ...]:
    """Who the row is about: code, name, department, designation, unit, type and status."""
    return (
        Field("emp.code", "Emp code", TEXT, section, "emp", width=1.0),
        Field("emp.name", "Employee name", TEXT, section, "emp", width=2.2),
        Field("emp.department", "Department", TEXT, section, "emp", width=1.5),
        Field("emp.designation", "Designation", TEXT, section, "emp", width=1.5),
        Field("emp.branch", "Unit / branch", TEXT, section, "emp", width=1.1),
        Field("emp.type", "Employee type", TEXT, section, "emp", "Staff or Production", width=0.9),
        Field("emp.status", "Employee status", TEXT, section, "emp", "Active or Inactive (left)", width=0.9),
    )


def type_text(emp) -> str | None:
    kind = (emp.employment_type or "").strip().lower()
    return "Production" if kind == "production" else "Staff" if kind == "staff" else (kind.title() or None)


def status_text(emp) -> str:
    return "Active" if (emp.status or "") == "active" else "Inactive"


def employee_cells(emp) -> dict:
    """The emp.* cells of EMPLOYEE fields. ``emp`` must come with department, designation and branch joined."""
    return {
        "emp.code": emp.employee_code,
        "emp.name": full_name(emp),
        "emp.department": emp.department.name if emp.department_id else UNASSIGNED,
        "emp.designation": emp.designation.title if emp.designation_id else None,
        "emp.branch": emp.branch.name if emp.branch_id else NO_BRANCH,
        "emp.type": type_text(emp),
        "emp.status": status_text(emp),
    }


# ── employees ───────────────────────────────────────────────────────────────


def scoped_employees(ctx, *, only_ids=None) -> list:
    """The report's employees (its scope filters + branch isolation), department then natural code order, with the
    department / designation / branch joined and never the photo or password hash."""
    from api.models import Employee

    qs = (
        Employee.objects.select_related("department", "designation", "branch")
        .defer(*EMP_DEFER)
        .filter(ctx.emp_q())
        .order_by(F("department__name").asc(nulls_last=True), "employee_code")
    )
    if only_ids is not None:
        qs = qs.filter(id__in=list(only_ids))
    return sorted(qs, key=employee_order)


def employee_order(emp) -> tuple:
    """Department name (unassigned last), then the natural employee-code order ('E2' before 'E10')."""
    return (
        0 if emp.department_id else 1,
        (emp.department.name or "").lower() if emp.department_id else "",
        code_key(emp.employee_code),
    )


def related(qs):
    """A queryset of rows that FK to Employee, with the employee's department / designation / branch joined and the
    photo / password hash left out (one query, however many rows)."""
    return qs.select_related(*REL_RELATED).defer(*REL_DEFER)


# ── join dates ──────────────────────────────────────────────────────────────


def join_date(emp) -> date | None:
    """The employee's joining date, or None when unknown (the employee then counts as employed). The shared reading
    (employees_master_base.join_date_of) with the spreadsheet serial decoded: the production workers imported from a
    sheet carry '01-01-45640' (an Excel day number where the year should be), which a plain date parser takes for the
    year 4564 and which would make every day "before joining"."""
    return join_date_of(emp, decode_serial=True)[0]
