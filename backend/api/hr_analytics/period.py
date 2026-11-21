"""The filters of the Analytics page: which employees (type, department, one employee, a search) over which dates."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from django.db.models import Q

from ..clock import ist_today

TYPES = ("staff", "production")
MAX_DAYS = 366
DAYS_PER_MONTH = 30.44


class FilterError(ValueError):
    """A parameter the page sent that cannot be used; the message is shown as is."""


@dataclass(frozen=True)
class Filters:
    type: str
    start: date
    end: date
    department_id: int | None = None
    employee_id: int | None = None
    q: str = ""
    overrides: dict[str, float] = field(default_factory=dict)

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def months(self) -> float:
        return self.days / DAYS_PER_MONTH

    def dates(self):
        d = self.start
        while d <= self.end:
            yield d
            d += timedelta(days=1)

    def period_json(self) -> dict:
        same_year = self.start.year == self.end.year
        first = f"{self.start.day} {self.start:%b}" + ("" if same_year else f" {self.start.year}")
        label = f"{first} - {self.end.day} {self.end:%b} {self.end.year}"
        if self.start == self.end:
            label = f"{self.end.day} {self.end:%b} {self.end.year}"
        return {
            "from": self.start.isoformat(),
            "to": self.end.isoformat(),
            "days": self.days,
            "months": round(self.months, 2),
            "label": label,
        }


def _date(value: str | None, name: str) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError as exc:
        raise FilterError(f"{name} must be a date (YYYY-MM-DD)") from exc


def _int(value, name: str) -> int | None:
    if value in (None, "", "all"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise FilterError(f"{name} must be a number") from exc


def parse(params, *, need_type: bool = True) -> Filters:
    """The page's query string as Filters. Default period: this month, the 1st to today; `to` never goes past today."""
    kind = (params.get("type") or "").strip().lower()
    if kind not in TYPES:
        if need_type or kind:
            raise FilterError("type must be staff or production")
        kind = "staff"
    today = ist_today()
    end = _date(params.get("to"), "to") or today
    end = min(end, today)
    start = _date(params.get("from"), "from") or end.replace(day=1)
    if start > end:
        raise FilterError("The period ends before it starts.")
    if (end - start).days + 1 > MAX_DAYS:
        raise FilterError(f"Choose a period of at most {MAX_DAYS} days.")
    overrides: dict[str, float] = {}
    for key, value in params.items():
        if key.startswith("t_") and value not in (None, ""):
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise FilterError(f"{key} must be a number") from exc
            if number <= 0:
                raise FilterError(f"{key} must be more than 0")
            overrides[key[2:]] = number
    return Filters(
        type=kind,
        start=start,
        end=end,
        department_id=_int(params.get("departmentId"), "departmentId"),
        employee_id=_int(params.get("employeeId"), "employeeId"),
        q=" ".join(str(params.get("q") or "").split())[:100],
        overrides=overrides,
    )


def employee_scope(f: Filters, request, *, use_search: bool = True):
    """The active employees of the tab the caller may see (their branch only, for a branch-scoped login), narrowed by
    department, one employee and the search (every word must match the name, code, designation or department)."""
    from ..branch_scope import scope_to_branch
    from ..models import Employee

    qs = Employee.objects.filter(employment_type=f.type, status="active")
    qs = scope_to_branch(qs, request, field="branch_id")
    if f.department_id:
        qs = qs.filter(department_id=f.department_id)
    if f.employee_id:
        qs = qs.filter(pk=f.employee_id)
    if use_search and f.q:
        for word in f.q.split():
            qs = qs.filter(
                Q(first_name__icontains=word)
                | Q(last_name__icontains=word)
                | Q(employee_code__icontains=word)
                | Q(designation__title__icontains=word)
                | Q(department__name__icontains=word)
            )
    return qs.select_related("department", "designation", "branch").defer("photo_url")
