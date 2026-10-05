"""The analytics contract of the MD portal: periods, scope, provenance, caching and the read-only endpoint decorator.

Every analytics function (md_portal/analytics/*.py) takes a ``Period`` and a ``Scope`` and returns a plain JSON-ready
dict built with ``envelope(...)``. The REST views and the AI assistant both call those functions, so a number on a page
and the same number quoted by the assistant can never differ. Nothing here writes to the database.

Conventions every module follows (see md-portal.md at the repository root):
  * "today" is ``ist_today()`` (the factory's calendar), never ``date.today()``.
  * "active headcount" is ``Employee.status == "active"``; everything else is a leaver.
  * dates inside a period are inclusive; a period never reaches into the future unless the module says so.
  * money is a float rounded to 2 places, percentages are 0-100 floats rounded to 1 place, empty is ``None`` (never 0).
  * every figure that is not obvious carries a ``provenance`` entry: where it comes from, the rule, the formula, the
    rows behind it and the caveats, so the screen (and the assistant) can explain it.
"""

from __future__ import annotations

import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import wraps
from typing import Any, Callable, Iterable, Iterator

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q, QuerySet
from rapidfuzz import fuzz, process
from rest_framework.decorators import api_view
from rest_framework.response import Response

from ..auth import require_md
from ..clock import ist_now, ist_today
from ..models import Branch, Department, Employee

# ─── errors ───────────────────────────────────────────────────────────────────────────────────────────────────


class MdParamError(ValueError):
    """A request parameter the analytics cannot use. The REST layer answers 400 with this message; the assistant gets
    it back as the tool's error so it can correct itself."""


# ─── periods ──────────────────────────────────────────────────────────────────────────────────────────────────

PRESET_LABELS: dict[str, str] = {
    "today": "Today",
    "yesterday": "Yesterday",
    "last_7_days": "Last 7 days",
    "last_30_days": "Last 30 days",
    "last_90_days": "Last 90 days",
    "this_week": "This week",
    "last_week": "Last week",
    "this_month": "This month",
    "last_month": "Last month",
    "last_12_months": "Last 12 months",
    "this_year": "This calendar year",
    "this_fy": "This financial year",
}
PRESETS = tuple(PRESET_LABELS)
MAX_PERIOD_DAYS = 800

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def month_label(year: int, month: int) -> str:
    return f"{_MONTHS[month - 1]} {year}"


def month_bounds(year: int, month: int) -> tuple[date, date]:
    first = date(year, month, 1)
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return first, nxt - timedelta(days=1)


def add_months(year: int, month: int, n: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + n
    return index // 12, index % 12 + 1


def last_n_months(n: int, today: date | None = None) -> list[tuple[int, int]]:
    """The last ``n`` calendar months, oldest first, the current month included."""
    today = today or ist_today()
    return [add_months(today.year, today.month, -i) for i in range(n - 1, -1, -1)]


def parse_month(value: str) -> tuple[int, int]:
    """ "2026-09" -> (2026, 9)."""
    try:
        year_s, month_s = str(value).strip().split("-")[:2]
        year, month = int(year_s), int(month_s)
        if not (1 <= month <= 12 and 1900 < year < 2200):
            raise ValueError
        return year, month
    except (ValueError, TypeError):
        raise MdParamError(f"'{value}' is not a month: use YYYY-MM, for example 2026-09.") from None


def parse_day(value: Any, name: str = "date") -> date:
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except (ValueError, TypeError):
        raise MdParamError(f"'{value}' is not a date for '{name}': use YYYY-MM-DD, for example 2026-10-05.") from None


def fy_start_month() -> int:
    """First month of the financial year (April by default), as HR set it for bonus (PayrollSettings)."""
    try:
        from ..models import PayrollSettings

        row = PayrollSettings.objects.filter(pk=1).only("bonus_fy_start_month").first()  # never .get(): it would INSERT
        value = int(getattr(row, "bonus_fy_start_month", 4) or 4)
        return value if 1 <= value <= 12 else 4
    except Exception:  # noqa: BLE001 - a settings read must never break analytics
        return 4


@dataclass(frozen=True)
class Period:
    start: date
    end: date  # inclusive
    preset: str | None
    label: str

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def previous(self) -> "Period":
        """The period of the same length that ends the day before this one starts (for "vs previous" figures)."""
        end = self.start - timedelta(days=1)
        start = end - timedelta(days=self.days - 1)
        return Period(start, end, None, f"Previous {self.days} days" if self.days > 1 else "Previous day")

    def months(self) -> list[tuple[int, int]]:
        """Every (year, month) the period touches, oldest first."""
        out, y, m = [], self.start.year, self.start.month
        while (y, m) <= (self.end.year, self.end.month):
            out.append((y, m))
            y, m = add_months(y, m, 1)
        return out

    def key(self) -> str:
        return f"{self.start.isoformat()}..{self.end.isoformat()}"

    def to_json(self) -> dict:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "preset": self.preset,
            "label": self.label,
            "days": self.days,
        }


def _custom_label(start: date, end: date) -> str:
    if start == end:
        return f"{start.day:02d} {_MONTHS[start.month - 1]} {start.year}"
    if start.year == end.year:
        return f"{start.day:02d} {_MONTHS[start.month - 1]} – {end.day:02d} {_MONTHS[end.month - 1]} {end.year}"
    return (
        f"{start.day:02d} {_MONTHS[start.month - 1]} {start.year} – {end.day:02d} {_MONTHS[end.month - 1]} {end.year}"
    )


def period_for_preset(preset: str, today: date) -> Period:
    if preset not in PRESET_LABELS:
        raise MdParamError(
            f"Unknown period '{preset}'. Choose one of: {', '.join(PRESETS)}, or give from and to dates."
        )
    label = PRESET_LABELS[preset]
    if preset == "today":
        return Period(today, today, preset, label)
    if preset == "yesterday":
        d = today - timedelta(days=1)
        return Period(d, d, preset, label)
    if preset in ("last_7_days", "last_30_days", "last_90_days"):
        n = int(preset.split("_")[1])
        return Period(today - timedelta(days=n - 1), today, preset, label)
    if preset == "this_week":  # Monday to today, as the gate summaries count a week
        return Period(today - timedelta(days=today.weekday()), today, preset, label)
    if preset == "last_week":
        monday = today - timedelta(days=today.weekday() + 7)
        return Period(monday, monday + timedelta(days=6), preset, label)
    if preset == "this_month":
        return Period(today.replace(day=1), today, preset, label)
    if preset == "last_month":
        y, m = add_months(today.year, today.month, -1)
        first, last = month_bounds(y, m)
        return Period(first, last, preset, label)
    if preset == "last_12_months":
        y, m = add_months(today.year, today.month, -11)
        return Period(date(y, m, 1), today, preset, label)
    if preset == "this_year":
        return Period(date(today.year, 1, 1), today, preset, label)
    if preset == "this_fy":
        start_month = fy_start_month()
        year = today.year if today.month >= start_month else today.year - 1
        return Period(date(year, start_month, 1), today, preset, label)
    raise AssertionError(f"preset {preset} has a label but no rule")  # a new PRESET_LABELS entry needs a branch above


def resolve_period(
    params: dict, *, default: str = "last_30_days", today: date | None = None, max_days: int = MAX_PERIOD_DAYS
) -> Period:
    """The period a request asks for: ``from`` + ``to`` (YYYY-MM-DD), a whole ``month`` (YYYY-MM), or a ``period``
    preset (see PRESETS); the default when none is given. Raises MdParamError for anything unusable."""
    today = today or ist_today()
    start_raw, end_raw = params.get("from") or params.get("dateFrom"), params.get("to") or params.get("dateTo")
    if start_raw or end_raw:
        if not (start_raw and end_raw):
            raise MdParamError("Give both 'from' and 'to' dates, or neither.")
        start, end = parse_day(start_raw, "from"), parse_day(end_raw, "to")
        if end < start:
            raise MdParamError("'to' is before 'from'.")
        period = Period(start, end, "custom", _custom_label(start, end))
    elif params.get("month"):
        year, month = parse_month(params["month"])
        first, last = month_bounds(year, month)
        period = Period(first, last, "month", month_label(year, month))
    else:
        preset = str(params.get("period") or default).strip().lower()
        period = period_for_preset(preset, today)
    if period.days > max_days:
        raise MdParamError(f"That is {period.days} days; the most one request covers is {max_days}.")
    return period


# ─── scope: which part of the company ────────────────────────────────────────────────────────────────────────

FUZZY_CUTOFF = 78


def _match_name(value: str, choices: dict[str, Any], what: str) -> tuple[Any, str | None]:
    """The choice whose name is ``value`` (exact ignoring case, else a close match). Returns (key, note)."""
    lowered = {name.lower(): name for name in choices}
    wanted = value.strip().lower()
    if wanted in lowered:
        return choices[lowered[wanted]], None
    best = process.extractOne(wanted, list(lowered), scorer=fuzz.WRatio, score_cutoff=FUZZY_CUTOFF)
    if best is None:
        sample = ", ".join(sorted(choices)[:12])
        raise MdParamError(f"No {what} called '{value}'. Known {what}s include: {sample}.")
    name = lowered[best[0]]
    return choices[name], f"Matched {what} '{value}' to '{name}'."


@dataclass
class Scope:
    """Which employees an analysis covers: units (branches), departments and staff/production. Empty = everyone."""

    branch_ids: tuple[int, ...] = ()
    department_ids: tuple[int, ...] = ()
    employment_type: str | None = None
    labels: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def key(self) -> str:
        return (
            f"b{','.join(map(str, self.branch_ids))}|d{','.join(map(str, self.department_ids))}|t{self.employment_type}"
        )

    def is_everyone(self) -> bool:
        return not (self.branch_ids or self.department_ids or self.employment_type)

    def describe(self) -> str:
        parts = [
            self.labels.get("branch", "All units"),
            self.labels.get("department", "all departments"),
            {"staff": "staff only", "production": "production only"}.get(
                self.employment_type or "", "staff and production"
            ),
        ]
        return " · ".join(parts)

    def employee_q(self, prefix: str = "") -> Q:
        """A Q for Employee itself (prefix "") or for a model that points to it (prefix "employee__")."""
        q = Q()
        if self.branch_ids:
            q &= Q(**{f"{prefix}branch_id__in": self.branch_ids})
        if self.department_ids:
            q &= Q(**{f"{prefix}department_id__in": self.department_ids})
        if self.employment_type:
            q &= Q(**{f"{prefix}employment_type": self.employment_type})
        return q

    def employees(self, *, active: bool | None = True) -> QuerySet:
        qs = Employee.objects.filter(self.employee_q())
        if active is True:
            qs = qs.filter(status="active")
        elif active is False:
            qs = qs.exclude(status="active")
        return qs

    def to_json(self) -> dict:
        return {
            "branchIds": list(self.branch_ids),
            "departmentIds": list(self.department_ids),
            "employmentType": self.employment_type,
            "description": self.describe(),
        }


def resolve_scope(params: dict) -> Scope:
    """The scope a request asks for: ``branch`` (unit id or name), ``department`` (id or name) and ``type``
    (staff | production). Names are matched ignoring case and small typos ("stiching" finds "Stitching"); a match that
    was not exact is reported in ``notes`` so the answer says what it assumed."""
    scope = Scope()

    branch_raw = params.get("branch") or params.get("branchId")
    if branch_raw not in (None, "", "all"):
        text = str(branch_raw).strip()
        if text.isdigit():
            branch = Branch.objects.filter(pk=int(text)).first()
            if branch is None:
                raise MdParamError(f"There is no unit with id {text}.")
        else:
            branches = {b.name: b for b in Branch.objects.all()}
            branch, note = _match_name(text, branches, "unit")
            if note:
                scope.notes.append(note)
        scope.branch_ids = (branch.id,)
        scope.labels["branch"] = branch.name

    dept_raw = params.get("department") or params.get("departmentId")
    if dept_raw not in (None, "", "all"):
        text = str(dept_raw).strip()
        qs = Department.objects.all()
        if scope.branch_ids:
            qs = qs.filter(branch_id__in=scope.branch_ids)
        if text.isdigit():
            dept = qs.filter(pk=int(text)).first()
            if dept is None:
                raise MdParamError(f"There is no department with id {text}.")
            same_name = [dept.id]
            name = dept.name
        else:
            by_name: dict[str, list[int]] = {}
            for d in qs:
                by_name.setdefault(d.name, []).append(d.id)
            ids, note = _match_name(text, by_name, "department")
            if note:
                scope.notes.append(note)
            same_name = ids
            name = next(n for n, v in by_name.items() if v == ids)
        # the same department name in several units is one department of the company
        scope.department_ids = tuple(sorted(same_name))
        scope.labels["department"] = name

    type_raw = params.get("type") or params.get("employmentType")
    if type_raw not in (None, "", "all"):
        value = str(type_raw).strip().lower()
        if value not in ("staff", "production"):
            raise MdParamError("'type' must be staff or production.")
        scope.employment_type = value
        scope.labels["type"] = value.title()
    return scope


# ─── provenance and the response envelope ────────────────────────────────────────────────────────────────────


def prov(
    id: str,
    title: str,
    *,
    dataset: str,
    definition: str,
    formula: str | None = None,
    rows: int | None = None,
    filters: Iterable[str] = (),
    caveats: Iterable[str] = (),
) -> dict:
    """One explanation entry: how a figure is made. ``dataset`` names the data (in HR's own words), ``definition`` says
    what the figure means, ``formula`` shows the arithmetic, ``rows`` how many records stand behind it."""
    return {
        "id": id,
        "title": title,
        "dataset": dataset,
        "definition": definition,
        "formula": formula,
        "rows": rows,
        "filters": list(filters),
        "caveats": list(caveats),
    }


def envelope(
    data: dict,
    *,
    period: Period | None = None,
    scope: Scope | None = None,
    provenance: Iterable[dict] = (),
    notes: Iterable[str] = (),
) -> dict:
    out: dict = {"generatedAt": ist_now().isoformat(timespec="seconds"), **data}
    if period is not None:
        out["period"] = period.to_json()
    if scope is not None:
        out["scope"] = scope.to_json()
    out["provenance"] = list(provenance)
    # one line per distinct caveat: a module may raise the same note from several of its calculations
    out["notes"] = list(dict.fromkeys([*(scope.notes if scope else []), *notes]))
    return out


# ─── small numeric helpers ───────────────────────────────────────────────────────────────────────────────────


def pct(part: float | int | None, whole: float | int | None, digits: int = 1) -> float | None:
    """part / whole as a 0-100 percentage, None when there is no whole (never 0 for "no data")."""
    if part is None or not whole:
        return None
    return round(100.0 * float(part) / float(whole), digits)


def money(value: Any) -> float:
    return round(float(value or 0), 2)


def change(current: float | None, previous: float | None) -> dict | None:
    """{"abs", "pct"} between two figures, None when either side is missing; pct is None when previous is 0."""
    if current is None or previous is None:
        return None
    return {"abs": round(current - previous, 2), "pct": pct(current - previous, abs(previous)) if previous else None}


# ─── a tiny in-process cache (analytics are read often and change slowly) ─────────────────────────────────────

_RUNNING_TESTS = len(sys.argv) > 1 and sys.argv[1] == "test"


def cache_seconds() -> int:
    configured = getattr(settings, "MD_ANALYTICS_CACHE_SECONDS", None)
    if configured is not None:
        return int(configured)
    return 0 if _RUNNING_TESTS else 60


class TtlCache:
    def __init__(self, maxsize: int = 256) -> None:
        self._data: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._maxsize = maxsize

    def get_or_compute(self, key: Any, ttl: float, compute: Callable[[], Any]) -> Any:
        if ttl <= 0:
            return compute()
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = compute()
        with self._lock:
            if len(self._data) >= self._maxsize:
                self._data.clear()
            self._data[key] = (now + ttl, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


CACHE = TtlCache()


def cached(ttl: int | None = None) -> Callable:
    """Cache an analytics function that takes (scope, period, **simple keyword args) for ``ttl`` seconds (default
    MD_ANALYTICS_CACHE_SECONDS, 60). Off in tests. The cached value is returned as is: callers must not mutate it."""

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            seconds = cache_seconds() if ttl is None else (ttl if not _RUNNING_TESTS else 0)
            key = (
                fn.__module__ + "." + fn.__qualname__,
                tuple(a.key() if hasattr(a, "key") else a for a in args),
                tuple(sorted((k, v.key() if hasattr(v, "key") else v) for k, v in kwargs.items())),
            )
            return CACHE.get_or_compute(key, seconds, lambda: fn(*args, **kwargs))

        return wrapper

    return decorator


# ─── the read-only guarantee and the endpoint decorator ──────────────────────────────────────────────────────


@contextmanager
def read_only_db() -> Iterator[None]:
    """Run the block in a transaction that the DATABASE ITSELF keeps read-only: any INSERT, UPDATE or DELETE raises
    ("cannot execute ... in a read-only transaction"). Every MD view and every assistant tool runs inside it, so an
    analytics function that tried to write (a ``get_or_create`` of a settings row, a ``compute_*`` that saves) fails
    loudly instead of quietly changing company data.

    ``SET LOCAL`` (not ``SET TRANSACTION``) because it is allowed after the transaction has started, which is the
    case inside a test and inside a request that already read something. Postgres cannot switch a transaction back to
    read-write, so the block always ends by rolling its (sub)transaction back: that undoes the setting, and there is
    nothing to keep because nothing in here may write."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL transaction_read_only = on")
        yield
        transaction.set_rollback(True)


def md_get(fn: Callable) -> Callable:
    """Turn ``fn(request) -> dict`` into a GET-only DRF view that only the MD can call, run inside ``read_only_db()``.
    A bad parameter (MdParamError) becomes a 400 with its message; nothing else is caught here."""

    @api_view(["GET"])
    @require_md
    @wraps(fn)
    def view(request, *args, **kwargs):
        started = time.monotonic()
        try:
            with read_only_db():
                body = fn(request, *args, **kwargs)
        except MdParamError as exc:
            return Response({"error": str(exc)}, status=400)
        if isinstance(body, dict):
            body = {**body, "tookMs": int((time.monotonic() - started) * 1000)}
        return Response(body)

    return view


def request_params(request) -> dict:
    """The query string as a plain dict (last value wins), for resolve_period / resolve_scope."""
    return {k: v for k, v in request.query_params.items()}
