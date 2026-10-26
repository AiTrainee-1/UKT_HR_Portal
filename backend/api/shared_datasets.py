"""Endpoint Sharing: the catalog of datasets that may be shared with other applications.

This file is the WHITELIST. A shared endpoint (SharedEndpoint) names a dataset and a list of field keys; nothing outside
what is declared here can ever leave the system:

* a field is a definition here (a key, a label, a type, a sensitivity and a getter over the columns it declares), never
  a model attribute named by a client: unknown keys are refused when an endpoint is saved and ignored when one is served;
* the row query loads ONLY the columns of the selected fields (`.only()` over the declared `columns`), so a column that
  is not shared (a password hash, a bank account) is not even read from the database for the page;
* filters are declared per dataset with a type, an allowed range and (for enums) the allowed values; every value is
  parsed by a strict ASCII reader and reaches the database as a query parameter, never as SQL text;
* every dataset has a maximum page size, and the date-range datasets REQUIRE a range of at most N days.

The catalog is verified when this module is imported: a field or column whose name contains a hard-excluded word
(password, token, otp, aadhaar, pan, bank, uan, pf, esi, photo, secret ...) is a start-up error, not a silent leak.
Adding a dataset = adding one `Dataset(...)` to `DATASETS` (and a test in tests_shared_datasets.py).

Units: money is rupees as a JSON number with two decimals, dates ISO `YYYY-MM-DD`, times `HH:MM:SS`, datetimes ISO 8601
with the +05:30 offset. A column that does not exist in this schema is not offered (see the notes on each dataset).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

from django.db.models import QuerySet

from .clock import FACTORY_TZ, ist_today

BASIC = "basic"
PERSONAL = "personal"
FINANCIAL = "financial"
SENSITIVITIES = (BASIC, PERSONAL, FINANCIAL)
#: the levels that need `acknowledgeSensitive: true` when an endpoint newly selects such a field
SENSITIVE_LEVELS = (PERSONAL, FINANCIAL)

FIELD_TYPES = ("string", "integer", "number", "boolean", "date", "datetime", "time")
FILTER_TYPES = ("enum", "integer", "string", "date", "month", "year", "boolean")
#: a boolean filter is written as these two words (in the URL and as a locked value); anything else is a 400
BOOLEAN_VALUES = ("true", "false")

#: Shown in the Settings tab as plain text: what no endpoint can ever share.
HARD_EXCLUDED = (
    "Password hashes, login tokens, one-time passwords (OTPs), device secrets and API keys.",
    "Aadhaar and PAN numbers and any other government ID number.",
    "Bank names, account numbers and IFSC codes.",
    "PF, ESI and UAN numbers.",
    "Photographs and any other image data.",
    "Biometric ids, attendance-device ids and device serial numbers.",
    "HR user accounts, roles, permissions, sessions and login history.",
    "Every column that is not listed in this catalog.",
)

#: Whole words that may not appear in any shared field key or column name (checked when this module loads and by the
#: catalog test). Words, not substrings: "company" is fine, "pan" is not.
EXCLUDED_WORDS = frozenset(
    {
        "password",
        "passwd",
        "hash",
        "token",
        "otp",
        "secret",
        "aadhaar",
        "aadhar",
        "pan",
        "bank",
        "ifsc",
        "uan",
        "pf",
        "esi",
        "photo",
        "image",
        "biometric",
        "device",
        "serial",
        "emergency",
        "credential",
        "apikey",
    }
)

#: the most one call may ask to skip (page * pageSize): a deep OFFSET is slow for the database
MAX_OFFSET = 200_000
MAX_PAGE = 1_000_000


# ── value formatters (every getter returns plain JSON types) ────────────────


def _text(value) -> str | None:
    return None if value is None else str(value)


def _date(value) -> str | None:
    return value.isoformat() if isinstance(value, date) else None


def _time(value) -> str | None:
    return value.strftime("%H:%M:%S") if isinstance(value, time) else None


def _datetime(value) -> str | None:
    if not isinstance(value, datetime):
        return None
    return value.astimezone(FACTORY_TZ).isoformat(timespec="seconds")


def _money(value) -> float | None:
    return None if value is None else float(Decimal(value).quantize(Decimal("0.01")))


def _decimal1(value) -> float | None:
    return None if value is None else float(Decimal(value).quantize(Decimal("0.1")))


_ISO_DATE_PREFIX = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)


def _text_date(value) -> str | None:
    """A date stored as text (Employee.join_date, LeaveRequest.start_date): the ISO date, or None if it is not one."""
    if not isinstance(value, str):
        return None
    head = value.strip()[:10]
    if _ISO_DATE_PREFIX.fullmatch(head) is None:
        return None
    try:
        date.fromisoformat(head)
    except ValueError:
        return None
    return head


def _walk(obj, path: tuple[str, ...]):
    """obj.a.b.c with None short-circuiting (a nullable relation that is not set reads as None)."""
    for name in path:
        if obj is None:
            return None
        obj = getattr(obj, name, None)
    return obj


def _full_name(first, last) -> str:
    return f"{first or ''} {last or ''}".strip()


def _source_category(source) -> str:
    """AttendanceLog.source is e.g. 'biometric:adms:<device serial>': only the kind of source is shared, never the
    device identifier."""
    value = (source or "").lower()
    for kind in ("biometric", "geo", "on_duty", "missing_punch", "manual"):
        if value.startswith(kind):
            return kind
    return "other"


# ── definitions ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: str
    sensitivity: str
    description: str
    #: ORM column paths the getter reads (relations with "__"); the row query loads exactly these
    columns: tuple[str, ...]
    get: Callable[[Any], Any]
    #: an example value for the integration guide
    sample: Any = None


@dataclass(frozen=True)
class Filter:
    key: str
    label: str
    type: str
    description: str
    required: bool = False
    values: tuple[str, ...] = ()
    default: str | None = None
    apply: Callable[[QuerySet, Any], QuerySet] | None = None


@dataclass(frozen=True)
class Dataset:
    key: str
    label: str
    description: str
    base: Callable[[], QuerySet]
    fields: tuple[Field, ...]
    filters: tuple[Filter, ...]
    ordering: tuple[str, ...]
    max_page_size: int
    #: (from filter key, to filter key, longest allowed range in days, inclusive)
    date_range: tuple[str, str, int] | None = None


def _f(key, label, type_, sensitivity, description, columns, get, sample=None) -> Field:
    return Field(key, label, type_, sensitivity, description, tuple(columns), get, sample)


def _attr(column: str, fmt=_text) -> Callable[[Any], Any]:
    return lambda obj: fmt(getattr(obj, column))


def _rel(path: str, fmt=_text) -> Callable[[Any], Any]:
    parts = tuple(path.split("."))
    return lambda obj: fmt(_walk(obj, parts))


def _simple(key, label, type_, sensitivity, description, column, fmt=_text, sample=None) -> Field:
    return _f(key, label, type_, sensitivity, description, (column,), _attr(column, fmt), sample)


def _related(key, label, type_, sensitivity, description, path, fmt=_text, sample=None) -> Field:
    return _f(
        key,
        label,
        type_,
        sensitivity,
        description,
        ("__".join(path.split(".")[:-1]) + "__" + path.split(".")[-1],),
        _rel(path, fmt),
        sample,
    )


def _int(value) -> int | None:
    return None if value is None else int(value)


def _models():
    from . import models

    return models


# fmt: off
# employees ----------------------------------------------------------------
EMPLOYEE_STATUS_VALUES = ("active", "inactive", "all")
EMPLOYMENT_TYPE_VALUES = ("staff", "production")


def _employee_status(qs: QuerySet, value: str) -> QuerySet:
    if value == "active":
        return qs.filter(status="active")
    if value == "inactive":
        return qs.exclude(status="active")
    return qs


def _visible_to_external(qs: QuerySet, value: bool) -> QuerySet:
    """"Visible to an external application" = the employees the company portal sees (Co Emp ones, and TDS ones: they stay
    visible there, pf_esi.COPORTAL_Q). Used ONLY to narrow: the flags are never shared fields."""
    from .pf_esi import COPORTAL_Q

    return qs.filter(COPORTAL_Q) if value else qs


EMPLOYEES = Dataset(
    key="employees",
    label="Employees",
    description=(
        "The employee master list: identity, organisation unit and (when selected) contact and salary details. "
        "Every employee that matches the filters is shared, including those not marked as visible to external "
        "applications: lock the filter visibleToExternal to true to share only those."
    ),
    base=lambda: _models().Employee.objects.all(),
    fields=(
        _simple("employeeCode", "Employee code", "string", BASIC, "The employee's code.", "employee_code", sample="UK0123"),
        _simple("firstName", "First name", "string", BASIC, "First name.", "first_name", sample="Asha"),
        _simple("lastName", "Last name", "string", BASIC, "Last name.", "last_name", sample="Kumar"),
        _f("fullName", "Full name", "string", BASIC, "First and last name together.", ("first_name", "last_name"),
           lambda o: _full_name(o.first_name, o.last_name), "Asha Kumar"),
        _simple("status", "Status", "string", BASIC, "active or inactive.", "status", sample="active"),
        _simple("employmentType", "Employment type", "string", BASIC, "staff or production.", "employment_type", sample="staff"),
        _related("department", "Department", "string", BASIC, "Department name.", "department.name", sample="Stitching"),
        _related("designation", "Designation", "string", BASIC, "Designation title.", "designation.title", sample="Supervisor"),
        _related("branch", "Branch", "string", BASIC, "Branch (unit) name.", "branch.name", sample="Head Office"),
        _f("joinDate", "Join date", "date", BASIC, "Date of joining (YYYY-MM-DD); empty when not recorded.", ("join_date",),
           lambda o: _text_date(o.join_date), "2024-06-03"),
        _simple("phone", "Phone", "string", PERSONAL, "Personal phone number.", "phone", sample="+91 98765 43210"),
        _simple("email", "Email", "string", PERSONAL, "Email address.", "email", sample="asha@example.com"),
        _simple("gender", "Gender", "string", PERSONAL, "male, female or other.", "gender", sample="female"),
        _simple("dateOfBirth", "Date of birth", "date", PERSONAL, "Date of birth (YYYY-MM-DD).", "date_of_birth", _date, "1994-02-11"),
        _simple("address", "Address", "string", PERSONAL, "Home address as recorded.", "address", sample="12 Mill Road, Tiruppur"),
        _simple("salaryAmount", "Salary amount", "number", FINANCIAL, "Monthly salary in rupees (two decimals).", "salary_amount", _money, 25000.0),
        _simple("salaryPerShift", "Salary per shift", "number", FINANCIAL, "Production pay per shift in rupees.", "salary_per_shift", _money, 650.0),
        _simple("salaryType", "Salary type", "string", FINANCIAL, "How the salary is paid (for example monthly).", "salary_type", sample="monthly"),
    ),
    filters=(
        Filter("status", "Status", "enum", "Which employees: active (the default), inactive or all.", values=EMPLOYEE_STATUS_VALUES, default="active", apply=_employee_status),
        Filter("employmentType", "Employment type", "enum", "staff or production.", values=EMPLOYMENT_TYPE_VALUES, apply=lambda q, v: q.filter(employment_type=v)),
        Filter("departmentId", "Department id", "integer", "Only employees of this department (see the departments dataset).", apply=lambda q, v: q.filter(department_id=v)),
        Filter("branchId", "Branch id", "integer", "Only employees of this branch (see the branches dataset).", apply=lambda q, v: q.filter(branch_id=v)),
        Filter("employeeCode", "Employee code", "string", "Exactly this employee code.", apply=lambda q, v: q.filter(employee_code=v)),
        Filter("visibleToExternal", "Visible to external apps", "boolean", "true: only employees HR marked as visible to external applications. Not sent (or false): every employee that matches the other filters.", values=BOOLEAN_VALUES, apply=_visible_to_external),
    ),
    ordering=("employee_code", "id"),
    max_page_size=500,
)

DEPARTMENTS = Dataset(
    key="departments",
    label="Departments",
    description="The departments of the company and the branch each belongs to.",
    base=lambda: _models().Department.objects.all(),
    fields=(
        _simple("id", "Id", "integer", BASIC, "Department id (use it as departmentId in other datasets).", "id", _int, 4),
        _simple("name", "Name", "string", BASIC, "Department name.", "name", sample="Stitching"),
        _related("branch", "Branch", "string", BASIC, "Branch name.", "branch.name", sample="Head Office"),
    ),
    filters=(),
    ordering=("name", "id"),
    max_page_size=500,
)

BRANCHES = Dataset(
    key="branches",
    label="Branches",
    description="The company's branches (units).",
    base=lambda: _models().Branch.objects.all(),
    fields=(
        _simple("id", "Id", "integer", BASIC, "Branch id (use it as branchId in other datasets).", "id", _int, 1),
        _simple("name", "Name", "string", BASIC, "Branch name.", "name", sample="Head Office"),
        _simple("code", "Code", "string", BASIC, "Short branch code.", "code", sample="HO"),
    ),
    filters=(),
    ordering=("name", "id"),
    max_page_size=500,
)

DESIGNATIONS = Dataset(
    key="designations",
    label="Designations",
    description="Job designations and their department.",
    base=lambda: _models().Designation.objects.all(),
    fields=(
        _simple("id", "Id", "integer", BASIC, "Designation id.", "id", _int, 7),
        _simple("title", "Title", "string", BASIC, "Designation title.", "title", sample="Supervisor"),
        _related("department", "Department", "string", BASIC, "Department name.", "department.name", sample="Stitching"),
        _simple("level", "Level", "string", BASIC, "Level (junior, mid, senior, manager, executive, staff).", "level", sample="senior"),
    ),
    filters=(),
    ordering=("title", "id"),
    max_page_size=500,
)

# attendance-days ----------------------------------------------------------
ATTENDANCE_DAY_FILTERS = (
    Filter("dateFrom", "From date", "date", "First day (YYYY-MM-DD).", required=True, apply=lambda q, v: q.filter(date__gte=v)),
    Filter("dateTo", "To date", "date", "Last day (YYYY-MM-DD), at most 31 days after dateFrom.", required=True, apply=lambda q, v: q.filter(date__lte=v)),
    Filter("employeeCode", "Employee code", "string", "Exactly this employee code.", apply=lambda q, v: q.filter(employee__employee_code=v)),
    Filter("departmentId", "Department id", "integer", "Only employees of this department.", apply=lambda q, v: q.filter(employee__department_id=v)),
    Filter("branchId", "Branch id", "integer", "Only employees of this branch.", apply=lambda q, v: q.filter(employee__branch_id=v)),
    Filter("employmentType", "Employment type", "enum", "staff or production.", values=EMPLOYMENT_TYPE_VALUES, apply=lambda q, v: q.filter(employee__employment_type=v)),
)

ATTENDANCE_DAYS = Dataset(
    key="attendance-days",
    label="Attendance (daily verdicts)",
    description="The final stored attendance verdict of each employee for each day (what payroll reads).",
    base=lambda: _models().AttendanceDayRecord.objects.all(),
    fields=(
        _related("employeeCode", "Employee code", "string", BASIC, "The employee's code.", "employee.employee_code", sample="UK0123"),
        _f("employeeName", "Employee name", "string", BASIC, "First and last name.", ("employee__first_name", "employee__last_name"),
           lambda o: _full_name(_walk(o, ("employee", "first_name")), _walk(o, ("employee", "last_name"))), "Asha Kumar"),
        _simple("date", "Date", "date", BASIC, "The day (YYYY-MM-DD).", "date", _date, "2026-10-14"),
        _simple("status", "Status", "string", BASIC, "present, absent, half_shift, on_leave or holiday.", "status", sample="present"),
        _simple("firstPunch", "First punch", "time", BASIC, "Time of the first punch (HH:MM:SS); empty when none.", "first_punch", _time, "08:29:41"),
        _simple("lastPunch", "Last punch", "time", BASIC, "Time of the last punch (HH:MM:SS); empty when none.", "last_punch", _time, "17:46:10"),
        _simple("shiftsEarned", "Shifts earned", "number", BASIC, "Shifts earned that day (0.5 = half a shift).", "shifts_earned", _money, 1.0),
        _simple("isLate", "Late", "boolean", BASIC, "True when the day was judged late.", "is_late", bool, False),
        _simple("earlyLeave", "Early leave", "boolean", BASIC, "True when the day was judged an early leave.", "early_leave", bool, False),
        _simple("isHalfShift", "Half shift", "boolean", BASIC, "True when the day counted as a half shift.", "is_half_shift", bool, False),
        _f("compensationKind", "Compensation kind", "string", BASIC, "Which compensation shaped the day (empty when none).", ("compensation_kind",),
           lambda o: o.compensation_kind or None, None),
    ),
    filters=ATTENDANCE_DAY_FILTERS,
    ordering=("date", "employee_id", "id"),
    max_page_size=1000,
    date_range=("dateFrom", "dateTo", 31),
)

# attendance-punches -------------------------------------------------------
ATTENDANCE_PUNCHES = Dataset(
    key="attendance-punches",
    label="Attendance (raw punches)",
    description="Every raw punch recorded in a date range (time and where it came from).",
    base=lambda: _models().AttendanceLog.objects.all(),
    fields=(
        _related("employeeCode", "Employee code", "string", BASIC, "The employee's code.", "employee.employee_code", sample="UK0123"),
        _simple("date", "Date", "date", BASIC, "The day of the punch (YYYY-MM-DD).", "date", _date, "2026-10-14"),
        _simple("time", "Time", "time", BASIC, "Time of the punch (HH:MM:SS).", "punch_time", _time, "08:29:41"),
        _f("source", "Source", "string", BASIC, "Kind of source: biometric, geo, on_duty, missing_punch, manual or other (never a device id).", ("source",),
           lambda o: _source_category(o.source), "biometric"),
    ),
    filters=(
        Filter("dateFrom", "From date", "date", "First day (YYYY-MM-DD).", required=True, apply=lambda q, v: q.filter(date__gte=v)),
        Filter("dateTo", "To date", "date", "Last day (YYYY-MM-DD), at most 7 days after dateFrom.", required=True, apply=lambda q, v: q.filter(date__lte=v)),
        Filter("employeeCode", "Employee code", "string", "Exactly this employee code.", apply=lambda q, v: q.filter(employee__employee_code=v)),
        Filter("departmentId", "Department id", "integer", "Only employees of this department.", apply=lambda q, v: q.filter(employee__department_id=v)),
    ),
    ordering=("date", "punch_time", "id"),
    max_page_size=1000,
    date_range=("dateFrom", "dateTo", 7),
)

# leave-requests -----------------------------------------------------------
LEAVE_STATUS_VALUES = ("pending", "approved", "rejected")

LEAVE_REQUESTS = Dataset(
    key="leave-requests",
    label="Leave requests",
    description="Leave requests with their dates, length and decision.",
    base=lambda: _models().LeaveRequest.objects.all(),
    fields=(
        _related("employeeCode", "Employee code", "string", BASIC, "The employee's code.", "employee.employee_code", sample="UK0123"),
        _f("employeeName", "Employee name", "string", BASIC, "First and last name.", ("employee__first_name", "employee__last_name"),
           lambda o: _full_name(_walk(o, ("employee", "first_name")), _walk(o, ("employee", "last_name"))), "Asha Kumar"),
        _f("leaveType", "Leave type", "string", PERSONAL, "Leave type name (for example Casual Leave).", ("leave_type_ref__name", "type"),
           lambda o: _text(_walk(o, ("leave_type_ref", "name")) or o.type), "Casual Leave"),
        _f("startDate", "Start date", "date", PERSONAL, "First day of leave (YYYY-MM-DD).", ("start_date",), lambda o: _text_date(o.start_date), "2026-10-20"),
        _f("endDate", "End date", "date", PERSONAL, "Last day of leave (YYYY-MM-DD).", ("end_date",), lambda o: _text_date(o.end_date), "2026-10-21"),
        _simple("days", "Days", "number", PERSONAL, "Number of days (0.5 = half day).", "total_days", _decimal1, 2.0),
        _simple("status", "Status", "string", PERSONAL, "pending, approved or rejected.", "status", sample="approved"),
        _simple("reason", "Reason", "string", PERSONAL, "The reason the employee gave (free text).", "reason", sample="Family function"),
    ),
    filters=(
        Filter("dateFrom", "From date", "date", "Only leave that ends on or after this day (YYYY-MM-DD).", apply=lambda q, v: q.filter(end_date__gte=v.isoformat())),
        Filter("dateTo", "To date", "date", "Only leave that starts on or before this day (YYYY-MM-DD).", apply=lambda q, v: q.filter(start_date__lte=v.isoformat())),
        Filter("status", "Status", "enum", "pending, approved or rejected.", values=LEAVE_STATUS_VALUES, apply=lambda q, v: q.filter(status=v)),
        Filter("employeeCode", "Employee code", "string", "Exactly this employee code.", apply=lambda q, v: q.filter(employee__employee_code=v)),
    ),
    ordering=("-start_date", "-id"),
    max_page_size=500,
    date_range=("dateFrom", "dateTo", 366),
)

# holidays -----------------------------------------------------------------
HOLIDAYS = Dataset(
    key="holidays",
    label="Holidays",
    description="The company holiday calendar.",
    base=lambda: _models().Holiday.objects.all(),
    fields=(
        _simple("date", "Date", "date", BASIC, "The holiday (YYYY-MM-DD).", "date", _date, "2026-10-20"),
        _simple("name", "Name", "string", BASIC, "Holiday name.", "name", sample="Deepavali"),
        _simple("type", "Type", "string", BASIC, "national, regional or company.", "holiday_type", sample="national"),
    ),
    filters=(Filter("year", "Year", "year", "Only holidays of this year (for example 2026).", apply=lambda q, v: q.filter(date__year=v)),),
    ordering=("date", "id"),
    max_page_size=500,
)

# payroll-summary ----------------------------------------------------------
PAYROLL_SUMMARY = Dataset(
    key="payroll-summary",
    label="Payroll summary",
    description="Generated payroll rows (staff monthly and production) for one month: gross, deductions and net pay.",
    base=lambda: _models().Payroll.objects.all(),
    fields=(
        _related("employeeCode", "Employee code", "string", BASIC, "The employee's code.", "employee.employee_code", sample="UK0123"),
        _f("employeeName", "Employee name", "string", BASIC, "First and last name.", ("employee__first_name", "employee__last_name"),
           lambda o: _full_name(_walk(o, ("employee", "first_name")), _walk(o, ("employee", "last_name"))), "Asha Kumar"),
        _simple("month", "Month", "integer", BASIC, "Payroll month, 1..12.", "month", _int, 9),
        _simple("year", "Year", "integer", BASIC, "Payroll year.", "year", _int, 2026),
        _simple("periodStart", "Period start", "date", BASIC, "First day of a production pay period (empty for staff payroll).", "period_start", _date, None),
        _simple("periodEnd", "Period end", "date", BASIC, "Last day of a production pay period (empty for staff payroll).", "period_end", _date, None),
        _simple("paidDays", "Paid days or shifts", "number", FINANCIAL, "Paid days (staff) or shifts worked (production), as stored on the payroll row.", "present_days", _decimal1, 26.0),
        _simple("grossPay", "Gross pay", "number", FINANCIAL, "Gross pay in rupees.", "gross_salary", _money, 25000.0),
        _simple("totalDeductions", "Total deductions", "number", FINANCIAL, "Total deductions in rupees.", "deductions", _money, 1800.0),
        _simple("netPay", "Net pay", "number", FINANCIAL, "Net pay in rupees (gross + bonus - deductions).", "final_salary", _money, 23200.0),
    ),
    filters=(
        Filter("month", "Month", "month", "The payroll month as YYYY-MM (for example 2026-09).", required=True, apply=lambda q, v: q.filter(year=v[0], month=v[1])),
        Filter("employmentType", "Employment type", "enum", "staff or production.", values=EMPLOYMENT_TYPE_VALUES, apply=lambda q, v: q.filter(employee__employment_type=v)),
    ),
    ordering=("employee_id", "period_start", "id"),
    max_page_size=500,
)

# fmt: on

DATASETS: dict[str, Dataset] = {
    d.key: d
    for d in (
        EMPLOYEES,
        DEPARTMENTS,
        BRANCHES,
        DESIGNATIONS,
        ATTENDANCE_DAYS,
        ATTENDANCE_PUNCHES,
        LEAVE_REQUESTS,
        HOLIDAYS,
        PAYROLL_SUMMARY,
    )
}


def get_dataset(key) -> Dataset | None:
    return DATASETS.get(key) if isinstance(key, str) else None


def field_map(dataset: Dataset) -> dict[str, Field]:
    return {f.key: f for f in dataset.fields}


def filter_map(dataset: Dataset) -> dict[str, Filter]:
    return {f.key: f for f in dataset.filters}


def effective_fields(dataset: Dataset, keys) -> list[str]:
    """The saved field keys that still exist in the catalog, in saved order, each once (deny by default)."""
    known = field_map(dataset)
    out: list[str] = []
    for key in keys if isinstance(keys, (list, tuple)) else ():
        if isinstance(key, str) and key in known and key not in out:
            out.append(key)
    return out


def sensitive_fields(dataset: Dataset, keys) -> list[str]:
    known = field_map(dataset)
    return [k for k in keys if k in known and known[k].sensitivity in SENSITIVE_LEVELS]


# ── catalog verification (start-up error, not a silent leak) ─────────────────

_WORD = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")


def name_words(name: str) -> set[str]:
    """'employee__first_name' / 'bankAccount' -> {'employee', 'first', 'name'} / {'bank', 'account'}."""
    return {w.lower() for part in name.split("_") for w in _WORD.findall(part)} | {name.lower()}


def excluded_names_in(dataset: Dataset) -> list[str]:
    """Every field key or column of the dataset that contains a hard-excluded word (must be empty)."""
    bad = []
    for f in dataset.fields:
        for name in (f.key, *f.columns):
            if name_words(name) & EXCLUDED_WORDS:
                bad.append(f"{dataset.key}.{f.key}: {name}")
    return bad


def _verify_catalog() -> None:
    problems: list[str] = []
    for key, ds in DATASETS.items():
        if key != ds.key:
            problems.append(f"{key}: registered under a different key")
        keys = [f.key for f in ds.fields]
        if len(keys) != len(set(keys)):
            problems.append(f"{key}: duplicate field key")
        for f in ds.fields:
            if f.type not in FIELD_TYPES or f.sensitivity not in SENSITIVITIES:
                problems.append(f"{key}.{f.key}: unknown type or sensitivity")
            if not f.columns:
                problems.append(f"{key}.{f.key}: declares no columns")
        for flt in ds.filters:
            if flt.type not in FILTER_TYPES:
                problems.append(f"{key}.{flt.key}: unknown filter type")
            if flt.type == "enum" and not flt.values:
                problems.append(f"{key}.{flt.key}: enum without values")
            if flt.type == "boolean" and flt.values != BOOLEAN_VALUES:
                problems.append(f"{key}.{flt.key}: a boolean filter must declare the values true and false")
            if flt.apply is None:
                problems.append(f"{key}.{flt.key}: no apply")
            if flt.default is not None and flt.type in ("enum", "boolean") and flt.default not in flt.values:
                problems.append(f"{key}.{flt.key}: default is not an allowed value")
        problems.extend(excluded_names_in(ds))
        if not 1 <= ds.max_page_size <= 1000:
            problems.append(f"{key}: max_page_size out of range")
        if ds.date_range is not None:
            lo, hi, _days = ds.date_range
            fm = filter_map(ds)
            if lo not in fm or hi not in fm:
                problems.append(f"{key}: date_range names a missing filter")
    if problems:
        raise RuntimeError("shared_datasets catalog is invalid: " + "; ".join(problems))


_verify_catalog()


# ── filters ─────────────────────────────────────────────────────────────────


class FilterError(Exception):
    """A request value that cannot be used: `param` is the parameter named in the 400, `message` one plain sentence."""

    def __init__(self, param: str, message: str):
        super().__init__(message)
        self.param = _printable(param)  # it is echoed in the 400: short, plain ASCII
        self.message = message


_INT_RE = re.compile(r"[0-9]{1,9}", re.ASCII)
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)
_MONTH_RE = re.compile(r"([0-9]{4})-(0[1-9]|1[0-2])", re.ASCII)
_YEAR_RE = re.compile(r"[0-9]{4}", re.ASCII)
_CODE_RE = re.compile(r"[A-Za-z0-9._/-](?:[A-Za-z0-9._/ -]{0,38}[A-Za-z0-9._/-])?", re.ASCII)
MIN_YEAR, MAX_YEAR = 2000, 2100


def parse_filter_value(flt: Filter, raw) -> Any:
    """The typed value of one filter, or FilterError. Only plain ASCII shapes are accepted (no unicode digits, no
    whitespace slack), so what reaches the ORM is an int, a date, or one of a fixed set of words."""
    if isinstance(raw, int) and not isinstance(raw, bool):
        raw = str(raw)  # a locked filter saved as a JSON number
    if not isinstance(raw, str) or not raw:
        raise FilterError(flt.key, f"Parameter '{flt.key}' needs a value.")
    kind = flt.type
    if kind == "enum":
        if raw not in flt.values:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be one of: {', '.join(flt.values)}.")
        return raw
    if kind == "boolean":
        if raw not in BOOLEAN_VALUES:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be true or false.")
        return raw == "true"
    if kind == "integer":
        if _INT_RE.fullmatch(raw) is None or not 1 <= int(raw) <= 2_147_483_647:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be a whole number of at least 1.")
        return int(raw)
    if kind == "date":
        if _DATE_RE.fullmatch(raw) is None:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be a date written YYYY-MM-DD.")
        try:
            value = date.fromisoformat(raw)
        except ValueError:
            raise FilterError(flt.key, f"Parameter '{flt.key}' is not a real date.") from None
        if not MIN_YEAR <= value.year <= MAX_YEAR:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be a year between {MIN_YEAR} and {MAX_YEAR}.")
        return value
    if kind == "month":
        m = _MONTH_RE.fullmatch(raw)
        if m is None or not MIN_YEAR <= int(m.group(1)) <= MAX_YEAR:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be a month written YYYY-MM (for example 2026-09).")
        return (int(m.group(1)), int(m.group(2)))
    if kind == "year":
        if _YEAR_RE.fullmatch(raw) is None or not MIN_YEAR <= int(raw) <= MAX_YEAR:
            raise FilterError(flt.key, f"Parameter '{flt.key}' must be a year between {MIN_YEAR} and {MAX_YEAR}.")
        return int(raw)
    # string (employee codes): letters, digits and . _ / - (single spaces inside)
    if _CODE_RE.fullmatch(raw) is None:
        raise FilterError(flt.key, f"Parameter '{flt.key}' may only contain letters, digits and . _ / - (up to 40).")
    return raw


def parse_filters(dataset: Dataset, supplied: Mapping[str, str], locked: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the caller's filters together with the endpoint's locked ones.

    * a parameter the dataset does not declare is a 400 (typos are caught), and so is one that is locked (a locked filter
      can never be overridden);
    * a required filter that is missing is a 400; a filter with a default gets it;
    * the date range (when the dataset has one) must be ordered and at most N days long.
    Returns {filter key: typed value} for the filters that are in force."""
    declared = filter_map(dataset)
    for name in supplied:
        if name not in declared:
            raise FilterError(name, f"Unknown parameter '{_printable(name)}'.")
        if name in locked:
            raise FilterError(name, f"Parameter '{name}' is fixed for this endpoint and cannot be set.")
    values: dict[str, Any] = {}
    for key, flt in declared.items():
        raw = locked[key] if key in locked else supplied.get(key)
        if raw is None:
            if flt.required:
                raise FilterError(key, f"Parameter '{key}' is required.")
            if flt.default is None:
                continue
            raw = flt.default
        values[key] = parse_filter_value(flt, raw)
    if dataset.date_range is not None:
        lo_key, hi_key, max_days = dataset.date_range
        if lo_key in values and hi_key in values:
            if values[hi_key] < values[lo_key]:
                raise FilterError(hi_key, f"Parameter '{hi_key}' must not be before '{lo_key}'.")
            if (values[hi_key] - values[lo_key]).days + 1 > max_days:
                raise FilterError(
                    hi_key, f"The range between '{lo_key}' and '{hi_key}' can be at most {max_days} days."
                )
    return values


def _printable(name: str) -> str:
    """A parameter name as it may be echoed in an error: short, plain ASCII only."""
    clean = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "_.-[]") else "?" for ch in name[:40])
    return clean


def preview_defaults(dataset: Dataset, supplied: Mapping[str, str], locked: Mapping[str, Any]) -> dict[str, str]:
    """For the Settings preview only: fill the REQUIRED filters nobody gave with a recent window, so the page can show
    sample rows without the owner typing dates (the public call never does this)."""
    out = dict(supplied)
    today = ist_today()
    for flt in dataset.filters:
        if not flt.required or flt.key in out or flt.key in locked:
            continue
        if flt.type == "month":
            out[flt.key] = f"{today.year:04d}-{today.month:02d}"
        elif flt.type == "date" and dataset.date_range is not None:
            lo_key, hi_key, max_days = dataset.date_range
            if flt.key == hi_key:
                out[flt.key] = today.isoformat()
            elif flt.key == lo_key:
                out[flt.key] = (today - timedelta(days=min(max_days, 7) - 1)).isoformat()
    return out


# ── querying ────────────────────────────────────────────────────────────────


def build_queryset(dataset: Dataset, values: Mapping[str, Any], field_keys: list[str]) -> QuerySet:
    """The ordered queryset of the dataset for the validated filter values. It loads only the columns of `field_keys`
    (plus the primary key) and joins only the relations those columns read, so a page is a constant number of queries
    and an unshared column is never read."""
    known = field_map(dataset)
    columns = {"pk"}
    for key in field_keys:
        columns.update(known[key].columns)
    columns.discard("pk")
    only: set[str] = {"id"}
    joins: set[str] = set()
    for column in columns:
        parts = column.split("__")
        for i in range(1, len(parts)):
            prefix = "__".join(parts[:i])
            joins.add(prefix)
            only.add(prefix)
        only.add(column)
    qs = dataset.base()
    if joins:
        qs = qs.select_related(*sorted(joins))
    qs = qs.only(*sorted(only))
    for flt in dataset.filters:
        if flt.key in values:
            qs = flt.apply(qs, values[flt.key])
    return qs.order_by(*dataset.ordering)


def shape_rows(dataset: Dataset, field_keys: list[str], objects) -> list[dict[str, Any]]:
    """Plain dicts of the selected fields only, built from the catalog getters (never from the model's own fields)."""
    known = field_map(dataset)
    getters = [(key, known[key].get) for key in field_keys]
    return [{key: get(obj) for key, get in getters} for obj in objects]


# ── what the management API and the guide show ─────────────────────────────


def filter_json(flt: Filter) -> dict[str, Any]:
    return {
        "key": flt.key,
        "label": flt.label,
        "type": flt.type,
        "required": flt.required,
        "description": flt.description,
        "values": list(flt.values),
        "default": flt.default,
    }


def field_json(f: Field) -> dict[str, Any]:
    return {
        "key": f.key,
        "label": f.label,
        "type": f.type,
        "sensitivity": f.sensitivity,
        "description": f.description,
    }


def dataset_json(ds: Dataset) -> dict[str, Any]:
    return {
        "key": ds.key,
        "label": ds.label,
        "description": ds.description,
        "fields": [field_json(f) for f in ds.fields],
        "filters": [filter_json(f) for f in ds.filters],
        "defaultOrdering": list(ds.ordering),
        "maxPageSize": ds.max_page_size,
        "dateRange": (
            {"from": ds.date_range[0], "to": ds.date_range[1], "maxDays": ds.date_range[2]} if ds.date_range else None
        ),
    }


def catalog_json() -> dict[str, Any]:
    return {
        "datasets": [dataset_json(ds) for ds in DATASETS.values()],
        "hardExcluded": list(HARD_EXCLUDED),
        "sensitivityLevels": {
            BASIC: "Organisation data (names, departments, dates, attendance marks).",
            PERSONAL: "Personal data (phone, email, date of birth, address, leave reasons). Needs your confirmation.",
            FINANCIAL: "Salary and payroll amounts. Needs your confirmation.",
        },
    }
