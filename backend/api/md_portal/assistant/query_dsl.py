"""A safe, read-only way for the assistant to answer questions that no built-in tool covers.

The model never writes SQL. It describes a query in a small JSON language (dataset, filters, grouping, metrics) and the
server turns it into an ORM query over a WHITELIST of datasets and fields. Anything outside the whitelist is refused with
a message the model can act on. Limits keep it cheap: at most 2 group fields, 4 metrics, 8 filters, 50 rows, and a
database statement timeout. It runs inside ``common.read_only_db()`` like every tool, so even a bug here cannot write.

Datasets expose business fields only: no phone numbers, bank details, passwords or ids of other systems, and salary only
as slip totals. People never come back by name from here (grouping is by department, status, month...), so nothing needs
pseudonymising, but the audit log's ``user_name`` is declared as a person field for the privacy layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable

from django.db import connection
from django.db.models import Avg, Count, F, Max, Min, Model, Q, Sum
from django.db.models.functions import (
    ExtractIsoWeekDay,
    Substr,
    TruncDay,
    TruncHour,
    TruncMonth,
    TruncWeek,
    TruncYear,
)

from ...clock import FACTORY_TZ
from ...models import (
    Advance,
    Applicant,
    AttendanceDayRecord,
    AuditLog,
    Employee,
    Job,
    LeaveRequest,
    OutpassRequest,
    OvertimeRecord,
    PayrollRun,
    ResignationRequest,
    SalarySlip,
    VisitorVisit,
)
from ..common import MdParamError, Period, Scope, prov, resolve_period, resolve_scope

MAX_ROWS = 50
DEFAULT_ROWS = 20
MAX_GROUPS = 2
MAX_METRICS = 4
MAX_FILTERS = 8
STATEMENT_TIMEOUT_MS = 8000

OPS = ("eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "between", "is_null", "not_null")
METRIC_FUNCTIONS = ("count", "count_distinct", "sum", "avg", "min", "max")
DATE_PARTS = ("day", "week", "month", "year", "hour", "weekday")


@dataclass(frozen=True)
class Fld:
    name: str
    #: ORM path (``"department__name"``) or a callable returning an expression
    source: str | Callable[[], Any]
    kind: str  # string | number | date | datetime | text_date | bool
    description: str
    values: tuple[str, ...] = ()
    measure: bool = False  # numeric, usable in sum / avg / min / max


@dataclass(frozen=True)
class Dataset:
    name: str
    model: type[Model]
    label: str
    description: str
    fields: tuple[Fld, ...]
    #: the field the period applies to (None: the dataset is not time-based)
    date_field: str | None = None
    #: how the unit / department / staff-production filters reach this model ("" = it IS the employee,
    #: "employee__" = it points at one, None = the filter does not apply)
    employee_prefix: str | None = None
    branch_path: str | None = None  # for datasets that carry a branch but no employee
    notes: tuple[str, ...] = ()
    person_fields: tuple[str, ...] = ()

    def field(self, name: str) -> Fld:
        for f in self.fields:
            if f.name == name:
                return f
        known = ", ".join(f.name for f in self.fields)
        raise MdParamError(f"Dataset '{self.name}' has no field '{name}'. Its fields are: {known}.")


def _text_year() -> Any:
    return Substr("join_date", 1, 4)


def _text_month() -> Any:
    return Substr("join_date", 1, 7)


def _leave_month() -> Any:
    return Substr("start_date", 1, 7)


EMP_STATUS = ("active", "inactive", "resigned", "terminated")

DATASETS: dict[str, Dataset] = {
    d.name: d
    for d in (
        Dataset(
            "employees",
            Employee,
            "Employees",
            "One row per employee, current and former. For headcount use status = active.",
            (
                Fld("status", "status", "string", "Employment status (active is current headcount)."),
                Fld("employment_type", "employment_type", "string", "staff or production.", ("staff", "production")),
                Fld("gender", "gender", "string", "male, female or other."),
                Fld("unit", "branch__name", "string", "The unit (branch) the employee belongs to."),
                Fld("department", "department__name", "string", "Department."),
                Fld("designation", "designation__title", "string", "Designation (job title)."),
                Fld("join_year", _text_year, "string", "Year of joining, e.g. 2024."),
                Fld("join_month", _text_month, "string", "Month of joining, e.g. 2024-06."),
            ),
            employee_prefix="",
            notes=("Use filters status = active for the current workforce.",),
        ),
        Dataset(
            "attendance_days",
            AttendanceDayRecord,
            "Attendance day records",
            "One row per employee per day: the day's final verdict. For attendance percentages use the attendance "
            "tools; use this for custom counts.",
            (
                Fld("date", "date", "date", "The attendance day."),
                Fld(
                    "status",
                    "status",
                    "string",
                    "present, absent, half_shift, on_leave or holiday.",
                    ("present", "absent", "half_shift", "on_leave", "holiday"),
                ),
                Fld("is_late", "is_late", "bool", "Arrived late."),
                Fld("early_leave", "early_leave", "bool", "Left early."),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
                Fld("employment_type", "employee__employment_type", "string", "staff or production."),
                Fld("shifts_earned", "shifts_earned", "number", "Shifts earned that day (1.0 = full).", measure=True),
            ),
            date_field="date",
            employee_prefix="employee__",
            notes=("A Saturday off has no row at all; it is not an absence.", "Today's rows are provisional."),
        ),
        Dataset(
            "salary_slips",
            SalarySlip,
            "Salary slips",
            "One row per employee per paid period. Amounts are rupees.",
            (
                Fld("year", "year", "number", "Pay year."),
                Fld("month", "month", "number", "Pay month 1-12."),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
                Fld("employment_type", "employee__employment_type", "string", "staff or production."),
                Fld("gross_salary", "gross_salary", "number", "Gross pay.", measure=True),
                Fld("net_salary", "net_salary", "number", "Net pay.", measure=True),
                Fld("total_deductions", "total_deductions", "number", "All deductions.", measure=True),
                Fld("ot_amount", "ot_amount", "number", "Overtime pay.", measure=True),
                Fld("bonuses", "bonuses", "number", "Bonus paid.", measure=True),
                Fld("pf_deduction", "pf_deduction", "number", "Provident fund.", measure=True),
                Fld("esi_deduction", "esi_deduction", "number", "ESI.", measure=True),
                Fld("advance_deduction", "advance_deduction", "number", "Advance recovered.", measure=True),
                Fld("present_days", "present_days", "number", "Days present.", measure=True),
                Fld("absent_days", "absent_days", "number", "Days absent.", measure=True),
                Fld("late_days", "late_days", "number", "Late arrivals.", measure=True),
            ),
            employee_prefix="employee__",
            notes=("For payroll cost and trends prefer the payroll tools; use this for custom slices.",),
        ),
        Dataset(
            "leave_requests",
            LeaveRequest,
            "Leave requests",
            "One row per leave request.",
            (
                Fld("type", "type", "string", "Leave type (casual, sick...)."),
                Fld(
                    "status", "status", "string", "pending, approved or rejected.", ("pending", "approved", "rejected")
                ),
                Fld("start_date", "start_date", "text_date", "First day of leave (YYYY-MM-DD)."),
                Fld("start_month", _leave_month, "string", "Month the leave starts, e.g. 2026-09."),
                Fld("total_days", "total_days", "number", "Days of leave.", measure=True),
                Fld("is_half_day", "is_half_day", "bool", "A half-day leave."),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
            ),
            employee_prefix="employee__",
        ),
        Dataset(
            "visits",
            VisitorVisit,
            "Visitor visits",
            "One row per visitor visit at the gate (there is no check-out time).",
            (
                Fld("visited_at", "visited_at", "datetime", "When the visitor arrived."),
                Fld("purpose", "purpose", "string", "Purpose of the visit."),
                Fld("unit", "branch__name", "string", "Unit visited."),
            ),
            date_field="visited_at",
            branch_path="branch_id",
            notes=("Visitors have no check-out, so durations and 'inside now' are not available.",),
        ),
        Dataset(
            "outpass_requests",
            OutpassRequest,
            "Outpass requests",
            "One row per employee outpass request (leaving during shift).",
            (
                Fld("created_at", "created_at", "datetime", "When it was requested."),
                Fld("status", "status", "string", "Request status."),
                Fld("pass_type", "pass_type", "string", "Type of pass."),
                Fld("reason", "reason", "string", "Stated reason."),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
            ),
            date_field="created_at",
            employee_prefix="employee__",
        ),
        Dataset(
            "overtime_records",
            OvertimeRecord,
            "Overtime records",
            "One row per employee overtime day.",
            (
                Fld("date", "date", "date", "The overtime day."),
                Fld("status", "status", "string", "Record status."),
                Fld("ot_minutes", "ot_minutes", "number", "Overtime minutes.", measure=True),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
            ),
            date_field="date",
            employee_prefix="employee__",
        ),
        Dataset(
            "advances",
            Advance,
            "Salary advances",
            "One row per advance given to an employee. Amounts are rupees.",
            (
                Fld("created_at", "created_at", "datetime", "When it was requested."),
                Fld("status", "status", "string", "Advance status."),
                Fld("advance_type", "advance_type", "string", "Type of advance."),
                Fld("amount", "amount", "number", "Amount advanced.", measure=True),
                Fld("outstanding", "outstanding", "number", "Still to be recovered.", measure=True),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
            ),
            date_field="created_at",
            employee_prefix="employee__",
        ),
        Dataset(
            "resignations",
            ResignationRequest,
            "Resignations",
            "One row per resignation request.",
            (
                Fld("created_at", "created_at", "datetime", "When it was submitted."),
                Fld("status", "status", "string", "pending, dept_approved, approved, rejected..."),
                Fld("last_working_date", "last_working_date", "date", "Last working day."),
                Fld("department", "employee__department__name", "string", "Employee's department."),
                Fld("unit", "employee__branch__name", "string", "Employee's unit."),
            ),
            date_field="created_at",
            employee_prefix="employee__",
        ),
        Dataset(
            "jobs",
            Job,
            "Job openings",
            "One row per job opening.",
            (
                Fld("title", "title", "string", "Job title."),
                Fld("status", "status", "string", "open, closed..."),
                Fld("department", "department__name", "string", "Department."),
                Fld("created_at", "created_at", "datetime", "When it was opened."),
            ),
            date_field="created_at",
        ),
        Dataset(
            "applicants",
            Applicant,
            "Job applicants",
            "One row per applicant.",
            (
                Fld("status", "status", "string", "Pipeline stage."),
                Fld("job", "job__title", "string", "The job applied for."),
                Fld("created_at", "created_at", "datetime", "When they applied."),
            ),
            date_field="created_at",
        ),
        Dataset(
            "audit_logs",
            AuditLog,
            "Activity (audit) log",
            "One row per recorded action in the HR system.",
            (
                Fld("created_at", "created_at", "datetime", "When it happened."),
                Fld("action", "action", "string", "login, create, update, delete, approve, reject, export..."),
                Fld("module", "module", "string", "The area of the system."),
                Fld("user_name", "user_name", "string", "Who did it."),
                Fld("unit", "branch__name", "string", "Unit of the acting user."),
            ),
            date_field="created_at",
            branch_path="branch_id",
            person_fields=("user_name",),
        ),
        Dataset(
            "payroll_runs",
            PayrollRun,
            "Payroll runs",
            "One row per payroll run (a month's processing). Company level: no unit or department filter.",
            (
                Fld("year", "year", "number", "Pay year."),
                Fld("month", "month", "number", "Pay month 1-12."),
                Fld("status", "status", "string", "draft, processing, approved or locked."),
                Fld("run_type", "run_type", "string", "monthly or biweekly."),
                Fld("total_gross", "total_gross", "number", "Gross of the run.", measure=True),
                Fld("total_net", "total_net", "number", "Net of the run.", measure=True),
                Fld("total_deductions", "total_deductions", "number", "Deductions of the run.", measure=True),
                Fld("total_employees", "total_employees", "number", "Employees paid.", measure=True),
            ),
        ),
    )
}


def catalog_text() -> str:
    """The datasets, written for the model's system prompt (so it needs no extra round trip to discover them)."""
    lines = []
    for d in DATASETS.values():
        fields = ", ".join(f"{f.name} ({f.kind}{', measure' if f.measure else ''})" for f in d.fields)
        scope = (
            "unit/department/type filters apply"
            if d.employee_prefix is not None
            else ("unit filter applies" if d.branch_path else "no unit/department filter")
        )
        period = f"; period applies to {d.date_field}" if d.date_field else ""
        lines.append(f"- {d.name}: {d.description} Fields: {fields}. ({scope}{period})")
        for note in d.notes:
            lines.append(f"    note: {note}")
    return "\n".join(lines)


# ─── parsing the model's query ─────────────────────────────────────────────────────────────────────────────────


def _split_group(token: str) -> tuple[str, str | None]:
    name, _, part = str(token).partition(":")
    if part and part not in DATE_PARTS:
        raise MdParamError(f"'{token}': a date can be grouped by {', '.join(DATE_PARTS)}.")
    return name.strip(), part or None


def _expression(f: Fld) -> Any:
    return f.source() if callable(f.source) else F(f.source)


def _coerce(f: Fld, value: Any) -> Any:
    text = str(value).strip()
    try:
        if f.kind == "number":
            return Decimal(text)
        if f.kind == "bool":
            return text.lower() in ("true", "yes", "1")
        if f.kind == "date":
            return date.fromisoformat(text[:10])
        if f.kind == "datetime":
            return date.fromisoformat(text[:10])
    except (ValueError, ArithmeticError):
        raise MdParamError(f"'{value}' is not a valid {f.kind} for '{f.name}'.") from None
    return text[:100]


def _filter_q(dataset: Dataset, spec: dict) -> tuple[Q, str]:
    f = dataset.field(str(spec.get("field", "")))
    op = str(spec.get("op", "eq")).lower()
    if op not in OPS:
        raise MdParamError(f"Unknown filter operator '{op}'. Use one of: {', '.join(OPS)}.")
    path = f.source if isinstance(f.source, str) else None
    if path is None:  # a computed field (join_year...) is for grouping only
        raise MdParamError(f"'{f.name}' is for grouping; filter on a plain field instead (for example status).")
    key = f"{path}__date" if f.kind == "datetime" else path
    values = spec.get("values")
    if not isinstance(values, list):
        values = [spec.get("value")] if spec.get("value") is not None else []
    if op in ("is_null", "not_null"):
        return Q(**{f"{path}__isnull": op == "is_null"}), f"{f.name} is {'empty' if op == 'is_null' else 'set'}"
    if not values:
        raise MdParamError(f"Filter on '{f.name}' needs a value.")
    coerced = [_coerce(f, v) for v in values]
    if op == "between":
        if len(coerced) != 2:
            raise MdParamError("'between' needs exactly two values.")
        return Q(**{f"{key}__range": (coerced[0], coerced[1])}), f"{f.name} between {values[0]} and {values[1]}"
    if op == "in":
        return Q(**{f"{key}__in": coerced}), f"{f.name} in {', '.join(map(str, values))}"
    one = coerced[0]
    if op == "contains":
        return Q(**{f"{path}__icontains": str(one)}), f"{f.name} contains '{one}'"
    if op == "eq":
        lookup = "iexact" if f.kind == "string" or f.kind == "text_date" else "exact"
        return Q(**{f"{key}__{lookup}": one}), f"{f.name} = {values[0]}"
    if op == "ne":
        lookup = "iexact" if f.kind == "string" or f.kind == "text_date" else "exact"
        return ~Q(**{f"{key}__{lookup}": one}), f"{f.name} ≠ {values[0]}"
    sym = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}[op]
    return Q(**{f"{key}__{op}": one}), f"{f.name} {sym} {values[0]}"


def _group_expression(f: Fld, part: str | None) -> Any:
    if part is None:
        return _expression(f)
    if f.kind not in ("date", "datetime"):
        raise MdParamError(f"'{f.name}' is not a date, so it cannot be grouped by {part}.")
    tz = {"tzinfo": FACTORY_TZ} if f.kind == "datetime" else {}
    source = f.source if isinstance(f.source, str) else None
    assert source is not None
    if part == "weekday":
        return ExtractIsoWeekDay(source, **tz)
    if part == "hour":
        if f.kind != "datetime":
            raise MdParamError(f"'{f.name}' has no time of day to group by hour.")
        return TruncHour(source, **tz)
    trunc = {"day": TruncDay, "week": TruncWeek, "month": TruncMonth, "year": TruncYear}[part]
    return trunc(source, **tz)


def _metric(dataset: Dataset, spec: dict) -> tuple[str, Any, str]:
    fn = str(spec.get("fn", "count")).lower()
    if fn not in METRIC_FUNCTIONS:
        raise MdParamError(f"Unknown metric '{fn}'. Use one of: {', '.join(METRIC_FUNCTIONS)}.")
    if fn == "count":
        return "count", Count("pk"), f"count of {dataset.label.lower()}"
    f = dataset.field(str(spec.get("field", "")))
    if fn == "count_distinct":
        return f"distinct_{f.name}", Count(_expression(f), distinct=True), f"distinct {f.name}"
    if not f.measure:
        raise MdParamError(
            f"'{f.name}' is not a number, so '{fn}' cannot be used on it. Measures: "
            + ", ".join(m.name for m in dataset.fields if m.measure)
            + "."
        )
    agg = {"sum": Sum, "avg": Avg, "min": Min, "max": Max}[fn]
    return f"{fn}_{f.name}", agg(_expression(f)), f"{fn} of {f.name}"


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return round(float(value), 2)
    if isinstance(value, float):
        return round(value, 2)
    if isinstance(value, datetime):
        value = value.astimezone(FACTORY_TZ) if value.tzinfo else value
        return value.replace(tzinfo=None).isoformat(timespec="minutes")
    if isinstance(value, date):
        return value.isoformat()
    return value


# ─── running it ─────────────────────────────────────────────────────────────────────────────────────────────────


def run_query(spec: dict, *, scope: Scope, period: Period | None, defaulted: bool = False) -> dict:
    name = str(spec.get("dataset", "")).strip()
    if name not in DATASETS:
        raise MdParamError(f"Unknown dataset '{name}'. Datasets: {', '.join(DATASETS)}.")
    dataset = DATASETS[name]

    qs = dataset.model.objects.all()
    scope_ignored: list[str] = []
    if dataset.employee_prefix is not None:
        qs = qs.filter(scope.employee_q(dataset.employee_prefix))
    elif dataset.branch_path and scope.branch_ids:
        qs = qs.filter(**{f"{dataset.branch_path}__in": scope.branch_ids})
        if scope.department_ids or scope.employment_type:
            scope_ignored.append("department and staff/production filters do not apply to this dataset")
    elif not scope.is_everyone():
        scope_ignored.append("unit, department and staff/production filters do not apply to this dataset")

    words: list[str] = []
    if period is not None and dataset.date_field:
        date_f = dataset.field(dataset.date_field)
        key = f"{date_f.source}__date" if date_f.kind == "datetime" else str(date_f.source)
        qs = qs.filter(**{f"{key}__range": (period.start, period.end)})
        words.append(f"{dataset.date_field} within {period.label}")

    filters = spec.get("filters") or []
    if not isinstance(filters, list) or len(filters) > MAX_FILTERS:
        raise MdParamError(f"'filters' must be a list of at most {MAX_FILTERS} conditions.")
    for item in filters:
        if not isinstance(item, dict):
            raise MdParamError("Each filter must be an object with field, op and value.")
        q, text = _filter_q(dataset, item)
        qs = qs.filter(q)
        words.append(text)

    groups = spec.get("group_by") or []
    if isinstance(groups, str):
        groups = [groups]
    if not isinstance(groups, list) or len(groups) > MAX_GROUPS:
        raise MdParamError(f"'group_by' takes at most {MAX_GROUPS} fields.")
    group_aliases: list[str] = []
    group_words: list[str] = []
    dated_groups = False
    for token in groups:
        fname, part = _split_group(token)
        f = dataset.field(fname)
        dated_groups = dated_groups or f.kind in ("date", "datetime", "text_date")
        alias = f"g_{fname}" + (f"_{part}" if part else "")
        qs = qs.annotate(**{alias: _group_expression(f, part)})
        group_aliases.append(alias)
        group_words.append(f"{fname}" + (f" by {part}" if part else ""))

    metric_specs = spec.get("metrics") or [{"fn": "count"}]
    if not isinstance(metric_specs, list) or not 1 <= len(metric_specs) <= MAX_METRICS:
        raise MdParamError(f"'metrics' takes 1 to {MAX_METRICS} items.")
    metrics = [_metric(dataset, m if isinstance(m, dict) else {"fn": m}) for m in metric_specs]
    metric_labels = [m[0] for m in metrics]
    if len(set(metric_labels)) != len(metric_labels):
        raise MdParamError("The same metric was asked for twice.")

    try:
        limit = max(1, min(MAX_ROWS, int(spec.get("limit") or DEFAULT_ROWS)))
    except (TypeError, ValueError):
        raise MdParamError("'limit' must be a number.") from None

    order = spec.get("order_by") or {}
    order_by = str(order.get("by") or "") if isinstance(order, dict) else ""
    direction = "" if isinstance(order, dict) and str(order.get("dir", "desc")).lower() == "asc" else "-"
    allowed_order = {*metric_labels, *(a.removeprefix("g_") for a in group_aliases)}
    if order_by and order_by not in allowed_order:
        raise MdParamError(f"'order_by.by' must be one of: {', '.join(sorted(allowed_order))}.")

    with connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")

    matched = qs.count()
    annotations = {label: expr for label, expr, _ in metrics}
    if group_aliases:
        grouped = qs.values(*group_aliases).annotate(**annotations)
        if order_by:
            sort_key = f"g_{order_by}" if f"g_{order_by}" in group_aliases else order_by
            ordering = [f"{direction}{sort_key}"]
        elif dated_groups:
            ordering = [group_aliases[0]]  # a time series reads oldest to newest
        else:
            ordering = [f"-{metric_labels[0]}"]  # a ranking reads biggest first
        grouped = grouped.order_by(*ordering)
        grouped_rows = list(grouped[:limit])
        total_groups = grouped.count() if len(grouped_rows) == limit else len(grouped_rows)
        rows = [
            {
                **{a.removeprefix("g_"): _plain(r[a]) for a in group_aliases},
                **{lbl: _plain(r[lbl]) for lbl in metric_labels},
            }
            for r in grouped_rows
        ]
    else:
        aggregated = qs.aggregate(**annotations)
        rows = [{lbl: _plain(aggregated[lbl]) for lbl in metric_labels}]
        total_groups = 1

    described = "; ".join(m[2] for m in metrics)
    if group_words:
        described += ", grouped by " + " and ".join(group_words)
    if words:
        described += ", where " + " and ".join(words)

    notes = list(scope.notes) + scope_ignored
    if total_groups > len(rows):
        notes.append(f"Showing the first {len(rows)} of {total_groups} groups.")
    result: dict[str, Any] = {
        "dataset": dataset.name,
        "query": described,
        "rows": rows,
        "matchedRecords": matched,
        "provenance": [
            prov(
                f"query-{dataset.name}",
                f"{dataset.label} (custom query)",
                dataset=dataset.label,
                definition=dataset.description,
                formula=described,
                rows=matched,
                filters=words,
                caveats=list(dataset.notes) + ["A free-form query: not one of the standard reports."],
            )
        ],
        "notes": notes,
    }
    if period is not None and dataset.date_field:
        result["period"] = period.to_json()
    if not scope.is_everyone():
        result["scope"] = scope.to_json()
    if defaulted:
        result["defaulted"] = [f"no period was given, so {period.label if period else 'all time'} was used"]
    return result


# ─── the tool ───────────────────────────────────────────────────────────────────────────────────────────────────


def query_declaration() -> dict:
    filter_item = {
        "type": "object",
        "properties": {
            "field": {"type": "string"},
            "op": {"type": "string", "enum": list(OPS)},
            "value": {"type": "string", "description": "One value (dates as YYYY-MM-DD)."},
            "values": {"type": "array", "items": {"type": "string"}, "description": "For op in / between."},
        },
        "required": ["field", "op"],
    }
    metric_item = {
        "type": "object",
        "properties": {
            "fn": {"type": "string", "enum": list(METRIC_FUNCTIONS)},
            "field": {
                "type": "string",
                "description": "A numeric measure (sum, avg, min, max) or any field (count_distinct).",
            },
        },
        "required": ["fn"],
    }
    return {
        "name": "query_data",
        "description": (
            "Run a custom read-only query over one dataset when no built-in analysis tool answers the question: filter "
            "rows, group them (a date field can be grouped as field:month, :week, :day, :year, :weekday or :hour) and "
            "compute counts, sums, averages. Returns at most 50 rows."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset": {"type": "string", "enum": list(DATASETS)},
                "filters": {"type": "array", "items": filter_item},
                "group_by": {"type": "array", "items": {"type": "string"}},
                "metrics": {"type": "array", "items": metric_item, "description": "Default: a count."},
                "order_by": {
                    "type": "object",
                    "properties": {"by": {"type": "string"}, "dir": {"type": "string", "enum": ["asc", "desc"]}},
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_ROWS},
                "period": {
                    "type": "string",
                    "description": "A named period (last_30_days, this_month, last_month...).",
                },
                "from": {"type": "string", "description": "YYYY-MM-DD, with 'to'."},
                "to": {"type": "string", "description": "YYYY-MM-DD, inclusive."},
                "month": {"type": "string", "description": "A calendar month, YYYY-MM."},
                "branch": {"type": "string", "description": "Unit name or id."},
                "department": {"type": "string", "description": "Department name or id."},
                "type": {"type": "string", "enum": ["staff", "production"]},
            },
            "required": ["dataset"],
        },
    }


def run_query_tool(args: dict) -> dict:
    """The tool entry point: resolve the period and scope like every other tool, then run the query."""
    name = str(args.get("dataset", "")).strip()
    dataset = DATASETS.get(name)
    if dataset is None:
        raise MdParamError(f"Unknown dataset '{name}'. Datasets: {', '.join(DATASETS)}.")
    clean = {k: v for k, v in args.items() if v not in (None, "")}
    period = None
    defaulted = False
    if dataset.date_field:
        given = any(k in clean for k in ("period", "from", "to", "month"))
        period = resolve_period(clean, default="last_30_days")
        defaulted = not given
    return run_query(clean, scope=resolve_scope(clean), period=period, defaulted=defaulted)
