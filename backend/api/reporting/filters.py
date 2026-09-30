"""
Filters: ready-made ``FilterSpec`` factories for report definitions, request-parameter
parsing/validation, and the ``ReportContext`` a report's ``run()`` receives.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from django.db.models import Q

from api.branch_scope import get_branch_scope
from api.clock import ist_today

from .formatting import MONTH_NAMES, display_date, month_bounds, parse_date, parse_period
from .types import (
    F_BOOLEAN,
    F_BRANCH,
    F_DATE_RANGE,
    F_DEPARTMENT,
    F_DESIGNATION,
    F_EMPLOYEE,
    F_EMPLOYEE_STATUS,
    F_EMPLOYMENT_TYPE,
    F_NUMBER,
    F_PERIOD,
    F_SELECT,
    F_TEXT,
    F_YEAR,
    FilterSpec,
    ReportSpec,
)

MAX_IDS = 1000
MAX_DB_INT = 2_147_483_647  # ids are 32-bit integer columns; a bigger number is a DataError (HTTP 500) otherwise
DEFAULT_MAX_DAYS = 366
EARLIEST_YEAR = 2000
LATEST_YEAR = 2100

EMPLOYMENT_TYPE_OPTIONS = (("staff", "Staff"), ("production", "Production"))
EMPLOYEE_STATUS_OPTIONS = (("active", "Active"), ("inactive", "Inactive / left"), ("all", "All"))


class ReportParamError(ValueError):
    """A filter value is missing or invalid. Surfaces as HTTP 400 with the field name."""

    def __init__(self, message: str, field_name: str | None = None):
        super().__init__(message)
        self.message = message
        self.field = field_name


# ── factories ───────────────────────────────────────────────────────────────


def period(default: str = "thisMonth", label: str = "Month", required: bool = True) -> FilterSpec:
    return FilterSpec("period", F_PERIOD, label, default=default, required=required)


def year(default: str = "thisYear", label: str = "Year", required: bool = True) -> FilterSpec:
    return FilterSpec("year", F_YEAR, label, default=default, required=required)


def date_range(
    default: str = "thisMonth",
    label: str = "Date range",
    required: bool = True,
    max_days: int | None = None,
) -> FilterSpec:
    return FilterSpec("dateRange", F_DATE_RANGE, label, default=default, required=required, max_days=max_days)


def departments(label: str = "Department") -> FilterSpec:
    return FilterSpec("department", F_DEPARTMENT, label, multi=True, placeholder="All departments")


def designations(label: str = "Designation") -> FilterSpec:
    return FilterSpec("designation", F_DESIGNATION, label, multi=True, placeholder="All designations")


def branches(label: str = "Branch") -> FilterSpec:
    return FilterSpec("branch", F_BRANCH, label, multi=True, placeholder="All branches")


def employees(label: str = "Employee") -> FilterSpec:
    return FilterSpec("employee", F_EMPLOYEE, label, multi=True, placeholder="All employees")


def employment_type(label: str = "Employee type") -> FilterSpec:
    return FilterSpec(
        "employmentType", F_EMPLOYMENT_TYPE, label, options=EMPLOYMENT_TYPE_OPTIONS, placeholder="All types"
    )


def employee_status(default: str = "active", label: str = "Employee status") -> FilterSpec:
    return FilterSpec("employeeStatus", F_EMPLOYEE_STATUS, label, options=EMPLOYEE_STATUS_OPTIONS, default=default)


def select(
    key: str,
    label: str,
    options,
    default: str | None = None,
    multi: bool = False,
    required: bool = False,
    placeholder: str | None = None,
    help: str | None = None,
) -> FilterSpec:
    return FilterSpec(
        key,
        F_SELECT,
        label,
        options=tuple((str(v), str(l)) for v, l in options),
        default=default,
        multi=multi,
        required=required,
        placeholder=placeholder or "All",
        help=help,
    )


def boolean(key: str, label: str, default: bool = False, help: str | None = None) -> FilterSpec:
    return FilterSpec(key, F_BOOLEAN, label, default=default, help=help)


def text(key: str, label: str, placeholder: str | None = None) -> FilterSpec:
    return FilterSpec(key, F_TEXT, label, placeholder=placeholder)


def number(
    key: str, label: str, default: int | None = None, min: int = 0, max: int = 10_000, help: str | None = None
) -> FilterSpec:
    return FilterSpec(key, F_NUMBER, label, default=default, min=min, max=max, help=help)


def scope(
    *,
    designation: bool = True,
    branch: bool = True,
    status: str | None = None,
    employee: bool = True,
    employment: bool = True,
) -> tuple[FilterSpec, ...]:
    """The employee-scoping filters almost every report offers.

    ``status``: None = no status filter (transactional reports: an employee who has
    since left must still appear in last month's register); "active"/"all" adds the
    filter with that default (master-data reports)."""
    out: list[FilterSpec] = []
    if branch:
        out.append(branches())
    out.append(departments())
    if designation:
        out.append(designations())
    if employment:
        out.append(employment_type())
    if employee:
        out.append(employees())
    if status:
        out.append(employee_status(status))
    return tuple(out)


# ── defaults ────────────────────────────────────────────────────────────────


def resolve_default(spec_filter: FilterSpec, today: date) -> Any:
    """Turn a FilterSpec default (literal or token) into what the UI should pre-fill."""
    d = spec_filter.default
    kind = spec_filter.kind
    if kind == F_PERIOD:
        if d == "lastMonth":
            first = today.replace(day=1) - timedelta(days=1)
            return f"{first.year}-{first.month:02d}"
        return f"{today.year}-{today.month:02d}"
    if kind == F_YEAR:
        return int(d) if isinstance(d, int) else today.year
    if kind == F_DATE_RANGE:
        return _range_default(d, today)
    if kind in (F_DEPARTMENT, F_DESIGNATION, F_BRANCH, F_EMPLOYEE):
        return []
    if kind == F_BOOLEAN:
        return bool(d)
    return d


def _range_default(token: Any, today: date) -> dict[str, str]:
    if token == "none":  # optional range: open with no dates pre-filled ("all time")
        return {"dateFrom": "", "dateTo": ""}
    if token == "today":
        a = b = today
    elif token == "yesterday":
        a = b = today - timedelta(days=1)
    elif token == "last7":
        a, b = today - timedelta(days=6), today
    elif token == "thisWeek":
        a, b = today - timedelta(days=today.weekday()), today
    elif token == "lastMonth":
        prev_end = today.replace(day=1) - timedelta(days=1)
        a, b = prev_end.replace(day=1), prev_end
    else:  # thisMonth
        a, b = today.replace(day=1), today
    return {"dateFrom": a.isoformat(), "dateTo": b.isoformat()}


# ── parsing ─────────────────────────────────────────────────────────────────


def _ids(raw: str | None, field_name: str) -> list[int]:
    if not raw:
        return []
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit() or int(part) > MAX_DB_INT:
            raise ReportParamError(f"{field_name}: '{part[:12]}' is not a valid id", field_name)
        out.append(int(part))
    if len(out) > MAX_IDS:
        raise ReportParamError(f"{field_name}: too many values (max {MAX_IDS})", field_name)
    return sorted(set(out))


def parse_params(spec: ReportSpec, query) -> dict[str, Any]:
    """Validate the query string against the spec's filters and return typed params.

    Keys in the result: period=(year, month); year; date_from/date_to (date);
    department_ids/designation_ids/branch_ids/employee_ids (list[int]); employment_type;
    employee_status; and for select/boolean/text/number filters, the filter key.
    Unknown query parameters are ignored, so old bookmarks never break a report."""
    today = ist_today()
    out: dict[str, Any] = {}
    for f in spec.filters:
        kind = f.kind
        if kind == F_PERIOD:
            raw = (query.get("period") or "").strip()
            if not raw:
                if f.required or f.default:
                    raw = resolve_default(f, today)
                else:
                    out["period"] = None
                    continue
            parsed = parse_period(raw)
            if not parsed:
                raise ReportParamError("Month must look like 2026-09", "period")
            if not EARLIEST_YEAR <= parsed[0] <= LATEST_YEAR:
                raise ReportParamError("Month is out of range", "period")
            out["period"] = parsed
        elif kind == F_YEAR:
            raw = (query.get("year") or "").strip()
            if not raw:
                raw = str(resolve_default(f, today)) if (f.required or f.default) else ""
            if not raw:
                out["year"] = None
                continue
            if not raw.isdigit() or not EARLIEST_YEAR <= int(raw) <= LATEST_YEAR:
                raise ReportParamError("Year is not valid", "year")
            out["year"] = int(raw)
        elif kind == F_DATE_RANGE:
            raw_from = (query.get("dateFrom") or "").strip()
            raw_to = (query.get("dateTo") or "").strip()
            if not raw_from and not raw_to:
                if f.required or (f.default and f.default != "none"):
                    dflt = resolve_default(f, today)
                    raw_from, raw_to = dflt["dateFrom"], dflt["dateTo"]
                else:
                    out["date_from"] = out["date_to"] = None
                    continue
            d_from, d_to = parse_date(raw_from), parse_date(raw_to)
            if raw_from and d_from is None:
                raise ReportParamError("'From' date is not valid (use YYYY-MM-DD)", "dateFrom")
            if raw_to and d_to is None:
                raise ReportParamError("'To' date is not valid (use YYYY-MM-DD)", "dateTo")
            for d_, key_ in ((d_from, "dateFrom"), (d_to, "dateTo")):
                if d_ is not None and not EARLIEST_YEAR <= d_.year <= LATEST_YEAR:
                    raise ReportParamError("Date is out of range", key_)
            if f.required and (d_from is None or d_to is None):
                raise ReportParamError("Both From and To dates are required", "dateFrom")
            if d_from and d_to:
                if d_from > d_to:
                    raise ReportParamError("'From' date is after 'To' date", "dateFrom")
                limit = f.max_days or DEFAULT_MAX_DAYS
                if (d_to - d_from).days + 1 > limit:
                    raise ReportParamError(
                        f"Date range is too wide (max {limit} days) - narrow it and try again", "dateTo"
                    )
            out["date_from"], out["date_to"] = d_from, d_to
        elif kind == F_DEPARTMENT:
            out["department_ids"] = _ids(query.get("departmentIds"), "departmentIds")
        elif kind == F_DESIGNATION:
            out["designation_ids"] = _ids(query.get("designationIds"), "designationIds")
        elif kind == F_BRANCH:
            out["branch_ids"] = _ids(query.get("branchIds"), "branchIds")
        elif kind == F_EMPLOYEE:
            out["employee_ids"] = _ids(query.get("employeeIds"), "employeeIds")
        elif kind == F_EMPLOYMENT_TYPE:
            raw = (query.get("employmentType") or "").strip().lower()
            if raw and raw not in {v for v, _ in EMPLOYMENT_TYPE_OPTIONS}:
                raise ReportParamError("Employee type must be staff or production", "employmentType")
            out["employment_type"] = raw or None
        elif kind == F_EMPLOYEE_STATUS:
            raw = (query.get("employeeStatus") or "").strip().lower() or (f.default or "active")
            if raw not in {v for v, _ in EMPLOYEE_STATUS_OPTIONS}:
                raise ReportParamError("Employee status is not valid", "employeeStatus")
            out["employee_status"] = raw
        elif kind == F_SELECT:
            raw = (query.get(f.key) or "").strip()
            allowed = {v for v, _ in (f.options or ())}
            if not raw:
                raw = f.default or ""
            if f.multi:
                values = [p.strip() for p in str(raw).split(",") if p.strip()]
                bad = [v for v in values if v not in allowed]
                if bad:
                    raise ReportParamError(f"{f.label}: '{bad[0]}' is not a valid choice", f.key)
                if f.required and not values:
                    raise ReportParamError(f"{f.label} is required", f.key)
                out[f.key] = values
            else:
                if raw and raw not in allowed:
                    raise ReportParamError(f"{f.label}: '{raw}' is not a valid choice", f.key)
                if f.required and not raw:
                    raise ReportParamError(f"{f.label} is required", f.key)
                out[f.key] = raw or None
        elif kind == F_BOOLEAN:
            raw = (query.get(f.key) or "").strip().lower()
            out[f.key] = bool(f.default) if raw == "" else raw in ("1", "true", "yes", "on")
        elif kind == F_TEXT:
            out[f.key] = (query.get(f.key) or "").replace("\x00", "").strip()[:100] or None
        elif kind == F_NUMBER:
            raw = (query.get(f.key) or "").strip()
            if not raw:
                out[f.key] = f.default
                continue
            try:
                val = int(raw)
            except ValueError:
                raise ReportParamError(f"{f.label} must be a whole number", f.key) from None
            lo = f.min if f.min is not None else 0
            hi = f.max if f.max is not None else 10_000
            if not lo <= val <= hi:
                raise ReportParamError(f"{f.label} must be between {lo} and {hi}", f.key)
            out[f.key] = val
    return out


# ── context handed to run() ─────────────────────────────────────────────────


@dataclass
class ReportContext:
    request: Any
    spec: ReportSpec
    params: dict[str, Any]
    row_limit: int
    purpose: str = "screen"  # screen | xlsx | pdf
    _cache: dict = field(default_factory=dict, repr=False)

    # --- typed shortcuts -------------------------------------------------
    @property
    def today(self) -> date:
        return ist_today()

    @property
    def period(self) -> tuple[int, int] | None:
        return self.params.get("period")

    @property
    def year(self) -> int | None:
        return self.params.get("year")

    @property
    def month_range(self) -> tuple[date, date] | None:
        p = self.period
        return month_bounds(*p) if p else None

    @property
    def date_from(self) -> date | None:
        return self.params.get("date_from")

    @property
    def date_to(self) -> date | None:
        return self.params.get("date_to")

    @property
    def days_in_range(self) -> list[date]:
        if not (self.date_from and self.date_to):
            return []
        n = (self.date_to - self.date_from).days + 1
        return [self.date_from + timedelta(days=i) for i in range(n)]

    def param(self, key: str, default=None):
        v = self.params.get(key)
        return default if v is None else v

    @property
    def is_super_admin(self) -> bool:
        from .access import is_super_admin

        return is_super_admin(self.request)

    # --- employee scoping ------------------------------------------------
    def emp_q(self, prefix: str = "") -> Q:
        """Q for the employee-scope filters (+ the user's branch isolation), applied through
        ``prefix`` -- "" on Employee itself, "employee__" on a model that FKs to it.

        Applies only the filters this report declares; branch isolation is always applied."""
        p = self.params
        q = Q()
        branch = get_branch_scope(self.request)
        if branch is not None:
            q &= Q(**{f"{prefix}branch_id": branch})
        if p.get("branch_ids"):
            q &= Q(**{f"{prefix}branch_id__in": p["branch_ids"]})
        if p.get("department_ids"):
            q &= Q(**{f"{prefix}department_id__in": p["department_ids"]})
        if p.get("designation_ids"):
            q &= Q(**{f"{prefix}designation_id__in": p["designation_ids"]})
        if p.get("employment_type"):
            q &= Q(**{f"{prefix}employment_type": p["employment_type"]})
        if p.get("employee_ids"):
            q &= Q(**{f"{prefix}id__in": p["employee_ids"]})
        status = p.get("employee_status")
        if status == "active":
            q &= Q(**{f"{prefix}status": "active"})
        elif status == "inactive":
            q &= ~Q(**{f"{prefix}status": "active"})
        return q

    def employees(self):
        from api.models import Employee

        # photo_url is often a ~43 KB base64 data URI and password_hash is a secret: never load them for a report.
        return (
            Employee.objects.select_related("department", "designation", "branch")
            .defer("photo_url", "password_hash")
            .filter(self.emp_q())
            .order_by("employee_code")
        )

    # --- description for export headers ---------------------------------
    def describe(self) -> list[tuple[str, str]]:
        return describe_params(self.spec, self.params, get_branch_scope(self.request))


def describe_params(spec: ReportSpec, params: dict[str, Any], branch_id: int | None = None) -> list[tuple[str, str]]:
    """Human-readable (label, value) pairs of the filters that were actually applied.

    ``branch_id`` (the viewer's branch, None = unscoped) confines the name lookups: the echo goes into every
    JSON payload and export header, so it must not reveal the name of a department/employee/branch that
    belongs to another branch just because its id was passed in."""
    from api.models import Branch, Department, Designation, Employee

    out: list[tuple[str, str]] = []
    for f in spec.filters:
        k = f.kind
        if k == F_PERIOD and params.get("period"):
            y, m = params["period"]
            out.append((f.label, f"{MONTH_NAMES[m - 1]} {y}"))
        elif k == F_YEAR and params.get("year"):
            out.append((f.label, str(params["year"])))
        elif k == F_DATE_RANGE and (params.get("date_from") or params.get("date_to")):
            a, b = params.get("date_from"), params.get("date_to")
            out.append((f.label, f"{display_date(a)} to {display_date(b)}" if a and b else display_date(a or b)))
        elif k in (F_DEPARTMENT, F_DESIGNATION, F_BRANCH, F_EMPLOYEE):
            key, model, name = {
                F_DEPARTMENT: ("department_ids", Department, "name"),
                F_DESIGNATION: ("designation_ids", Designation, "title"),
                F_BRANCH: ("branch_ids", Branch, "name"),
                F_EMPLOYEE: ("employee_ids", Employee, None),
            }[k]
            ids = params.get(key) or []
            if not ids:
                continue
            qs = model.objects.filter(id__in=ids)
            if branch_id is not None and model is not Designation:
                qs = qs.filter(id=branch_id) if model is Branch else qs.filter(branch_id=branch_id)
            if model is Employee:
                names = [
                    f"{e.employee_code} {e.first_name}".strip()
                    for e in qs.only("employee_code", "first_name").order_by("employee_code")[:6]
                ]
            else:
                names = list(qs.order_by(name).values_list(name, flat=True)[:6])
            more = len(ids) - len(names)
            out.append((f.label, ", ".join(names) + (f" +{more} more" if more > 0 else "")))
        elif k == F_EMPLOYMENT_TYPE and params.get("employment_type"):
            out.append((f.label, params["employment_type"].title()))
        elif k == F_EMPLOYEE_STATUS and params.get("employee_status") not in (None, "all"):
            out.append((f.label, dict(EMPLOYEE_STATUS_OPTIONS)[params["employee_status"]]))
        elif k == F_SELECT:
            val = params.get(f.key)
            labels = dict(f.options or ())
            if f.multi and val:
                out.append((f.label, ", ".join(labels.get(v, v) for v in val)))
            elif val:
                out.append((f.label, labels.get(val, val)))
        elif k == F_BOOLEAN and params.get(f.key):
            out.append((f.label, "Yes"))
        elif k == F_TEXT and params.get(f.key):
            out.append((f.label, params[f.key]))
        elif k == F_NUMBER and params.get(f.key) is not None:
            out.append((f.label, str(params[f.key])))
    return out


def month_days(year_: int, month: int) -> int:
    return calendar.monthrange(year_, month)[1]
