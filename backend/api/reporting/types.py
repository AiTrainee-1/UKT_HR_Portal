"""
Declarative building blocks of the Report Center.

A report is a ``ReportSpec``: metadata (title, category, filters, columns) plus a
``run(ctx) -> ReportResult`` function that queries the database. Everything the
UI, the Excel export and the PDF export need is derived from that one spec, so a
new report is one function and one ``register()`` call -- no frontend change.

Conventions every ``run`` must follow (the exporters and the UI rely on them):

* Dates are ISO strings ``YYYY-MM-DD``; times ``HH:MM``; date-times are IST
  wall-clock strings ``YYYY-MM-DD HH:MM`` (use ``formatting.fmt_dt``).
* Money is a float rounded to 2 decimals (rupees); minutes are ints; ``percent``
  is a 0-100 float.
* Rows are plain dicts keyed by the column keys. Unknown keys are dropped.
* ``None`` means "no value" and is shown as a dash -- never use 0 for "unknown".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

# ── column types ────────────────────────────────────────────────────────────
TEXT = "text"
INTEGER = "integer"  # whole number, no decimals
NUMBER = "number"  # decimal, 2 places
CURRENCY = "currency"  # rupees, 2 places, Indian digit grouping
PERCENT = "percent"  # 0-100
DATE = "date"  # ISO string in, DD-MMM-YYYY out
TIME = "time"  # HH:MM
DATETIME = "datetime"  # YYYY-MM-DD HH:MM (IST)
BADGE = "badge"  # short status word, rendered as a coloured pill
HOURS = "hours"  # decimal hours, 2 places
MINUTES = "minutes"  # whole minutes
DURATION = "duration"  # minutes, rendered "2h 05m"

COLUMN_TYPES = (
    TEXT,
    INTEGER,
    NUMBER,
    CURRENCY,
    PERCENT,
    DATE,
    TIME,
    DATETIME,
    BADGE,
    HOURS,
    MINUTES,
    DURATION,
)
NUMERIC_TYPES = (INTEGER, NUMBER, CURRENCY, PERCENT, HOURS, MINUTES, DURATION)

# ── filter kinds ────────────────────────────────────────────────────────────
F_PERIOD = "period"  # param "period"  = YYYY-MM
F_YEAR = "year"  # param "year"    = YYYY
F_DATE_RANGE = "dateRange"  # params "dateFrom", "dateTo" (ISO)
F_DEPARTMENT = "department"  # param "departmentIds"  = 1,2,3
F_DESIGNATION = "designation"  # param "designationIds"
F_BRANCH = "branch"  # param "branchIds" (only offered to unscoped users)
F_EMPLOYEE = "employee"  # param "employeeIds"
F_EMPLOYMENT_TYPE = "employmentType"  # param "employmentType" = staff|production
F_EMPLOYEE_STATUS = "employeeStatus"  # param "employeeStatus" = active|inactive|all
F_SELECT = "select"  # param = spec key; options are fixed
F_BOOLEAN = "boolean"  # param = spec key; "true"/"false"
F_TEXT = "text"  # param = spec key
F_NUMBER = "number"  # param = spec key; integer

FILTER_KINDS = (
    F_PERIOD,
    F_YEAR,
    F_DATE_RANGE,
    F_DEPARTMENT,
    F_DESIGNATION,
    F_BRANCH,
    F_EMPLOYEE,
    F_EMPLOYMENT_TYPE,
    F_EMPLOYEE_STATUS,
    F_SELECT,
    F_BOOLEAN,
    F_TEXT,
    F_NUMBER,
)

# Category ids, in display order. (id, label, description, lucide icon name)
CATEGORIES: list[tuple[str, str, str, str]] = [
    ("payroll", "Payroll & Salary", "Slips, registers, wages, statutory statements and deductions", "Wallet"),
    (
        "attendance",
        "Attendance",
        "Time cards, daily and monthly attendance, late, overtime and shifts",
        "CalendarCheck",
    ),
    ("leave", "Leave & Requests", "Leave, permission, on-duty, missing punch and other requests", "CalendarOff"),
    ("gate", "Gate & Visitors", "Outpass, visitor and tea-break registers", "DoorOpen"),
    ("employees", "Employees", "Master data, headcount, joiners, exits and compliance", "Users"),
    ("finance", "Loans & Bonus", "Advances, loans, bonus, increments and promotions", "Banknote"),
    ("admin", "Administration", "Audit trail, user access and system activity", "ShieldCheck"),
]
CATEGORY_IDS = tuple(c[0] for c in CATEGORIES)


@dataclass(frozen=True)
class ColumnSpec:
    key: str
    label: str
    type: str = TEXT
    # Relative width. Used to size Excel columns and to split the PDF page.
    width: float = 1.0
    # "sum" | "count" | "avg" | None -- computed over the data rows into a totals row.
    total: str | None = None
    # "left" | "center" | "right" | None (None = by type: numbers right, text left).
    align: str | None = None

    def __post_init__(self):
        if self.type not in COLUMN_TYPES:
            raise ValueError(f"column {self.key!r}: unknown type {self.type!r}")
        if self.total not in (None, "sum", "count", "avg"):
            raise ValueError(f"column {self.key!r}: unknown total {self.total!r}")


@dataclass(frozen=True)
class FilterSpec:
    key: str  # for select/boolean/text/number this is also the query-param name
    kind: str
    label: str
    options: tuple[tuple[str, str], ...] | None = None  # ((value, label), ...) for select
    default: Any = None  # literal, or a token: today | monthStart | thisMonth | lastMonth | thisYear
    required: bool = False
    multi: bool = False  # select only: comma-separated values
    help: str | None = None
    placeholder: str | None = None
    min: int | None = None  # number only
    max: int | None = None  # number only
    max_days: int | None = None  # dateRange only: widest span allowed

    def __post_init__(self):
        if self.kind not in FILTER_KINDS:
            raise ValueError(f"filter {self.key!r}: unknown kind {self.kind!r}")
        if self.kind == F_SELECT and not self.options:
            raise ValueError(f"filter {self.key!r}: select needs options")


@dataclass
class ReportResult:
    rows: list[dict]
    # Overrides the spec's columns -- for reports whose columns depend on the data
    # (a muster roll has one column per day of the month, a wage register one per
    # salary component).
    columns: list[ColumnSpec] | None = None
    # Overrides the computed totals row ({column key: value}).
    totals: dict[str, Any] | None = None
    # Headline figures shown as cards above the table: {"label", "value", "format"}
    # where format is one of the column types.
    summary: list[dict] = field(default_factory=list)
    # Footnotes: assumptions, rates used, exclusions. Shown under the table and in exports.
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ReportSpec:
    id: str
    title: str
    description: str
    category: str
    filters: tuple[FilterSpec, ...]
    columns: tuple[ColumnSpec, ...]
    run: Callable[["Any"], ReportResult]
    icon: str = "FileText"  # lucide-react icon name
    tags: tuple[str, ...] = ()  # extra search keywords
    # Reports that are two views of the same subject share a family; the UI shows them
    # as one entry with a switcher (e.g. "Permission Records": Records | Counts).
    family: str | None = None
    variant: str | None = None
    landscape: bool = True
    # Permission modules (permission_registry.MODULE_TREE keys) that own this data. The user needs
    # "view" or better on AT LEAST ONE of them, on top of the "reports" module the middleware
    # already checks -- so a role that has Reports but not Payroll cannot read salary data here.
    # Empty = no extra requirement.
    modules: tuple[str, ...] = ()
    # Only a super admin may see/run it (data that is admin-only elsewhere in the app).
    super_admin_only: bool = False
    # Custom document builders: (ctx, result) -> bytes. When set they replace the generic
    # table export for that format (e.g. printable salary slips, per-employee time cards).
    pdf_builder: Callable[..., bytes] | None = None
    xlsx_builder: Callable[..., bytes] | None = None
    # Per-report overrides of the default row ceilings (see views.SCREEN_ROW_LIMIT / PDF_ROW_LIMIT).
    # A run() that can return very many rows must honour ctx.row_limit at query level.
    screen_limit: int | None = None
    pdf_max_rows: int | None = None

    def __post_init__(self):
        if self.category not in CATEGORY_IDS:
            raise ValueError(f"report {self.id!r}: unknown category {self.category!r}")
        keys = [c.key for c in self.columns]
        if len(keys) != len(set(keys)):
            raise ValueError(f"report {self.id!r}: duplicate column keys")
        fkeys = [f.key for f in self.filters]
        if len(fkeys) != len(set(fkeys)):
            raise ValueError(f"report {self.id!r}: duplicate filter keys")
        if (self.family is None) != (self.variant is None):
            raise ValueError(f"report {self.id!r}: family and variant go together")

    def filter(self, key: str) -> FilterSpec | None:
        return next((f for f in self.filters if f.key == key), None)
