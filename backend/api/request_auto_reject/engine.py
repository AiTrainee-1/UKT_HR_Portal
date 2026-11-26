"""Which waiting requests the automatic rejection is due to reject (read only).

The map of kinds is the Requests hub's (hr_requests_views.KINDS): each kind's model, the statuses that mean "still waiting
for a decision", the extra filter (an outpass the approval engine covers: source "manual") and the branch a request is listed
under. Every kind there is rejected automatically except a resignation (owner 2026-11-24): AUTO_KINDS is the order a run
takes them in (an On-Duty request before its punches: rejecting the request voids its waiting punches, so they are not
rejected a second time on their own).

Age (owner decision): counted from the India day the request was SUBMITTED (created_at), not the day it is for. A request
is due once MORE than `days` days have passed since that day: submitted on 10 Oct with 45 days, it has waited 45 days on
24 Nov (not due) and 46 on 25 Nov (due). In one comparison: created_at before 00:00 India time of (today - days).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from django.apps import apps

from ..clock import FACTORY_TZ, ist_today

# Every kind of the Requests hub except "resignation", in the order a run rejects them.
AUTO_KINDS: tuple[str, ...] = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "on_duty",
    "on_duty_punch",
    "attendance_correction",
    "holiday_work",
    "birthday_compensation",
    "outpass",
    "request",
    "advance",
)
NEVER_AUTO: tuple[str, ...] = ("resignation",)

PREVIEW_MAX = 300  # rows of the "due at the next run" list (the count is always exact)


@dataclass(frozen=True)
class KindSpec:
    key: str
    label: str
    model_name: str
    waiting: tuple[str, ...]
    scope_field: str
    extra_filter: dict
    select: tuple[str, ...]

    @property
    def model(self):
        return apps.get_model("api", self.model_name)


def spec(key: str) -> KindSpec:
    """The Requests hub's definition of one kind (raises KeyError for a kind that is not there)."""
    from ..hr_requests_views import BY_KEY

    kind = BY_KEY[key]
    return KindSpec(
        key=kind.key,
        label=kind.label,
        model_name=kind.model,
        waiting=tuple(kind.waiting),
        scope_field=kind.scope_field,
        extra_filter=dict(kind.extra_filter),
        select=tuple(kind.select),
    )


def cutoff(days: int, today: date | None = None) -> datetime:
    """Requests submitted before this instant (00:00 India time, `days` days before today) are due."""
    today = today or ist_today()
    return datetime.combine(today - timedelta(days=days), time.min, tzinfo=FACTORY_TZ)


def submitted_day(created_at: datetime) -> date:
    return created_at.astimezone(FACTORY_TZ).date()


def days_waiting(created_at: datetime, today: date | None = None) -> int:
    """Whole India days since the day it was submitted (0 on that day itself)."""
    return ((today or ist_today()) - submitted_day(created_at)).days


def is_due(created_at: datetime, days: int, today: date | None = None) -> bool:
    return created_at < cutoff(days, today)


def due_queryset(key: str, days: int, today: date | None = None, branch_id: int | None = None):
    """The requests of `key` the next run would reject, oldest first. `branch_id`: only those listed under that branch
    (a branch login's view and Run now); None = the whole company (the nightly run)."""
    s = spec(key)
    qs = s.model.objects.filter(status__in=s.waiting, created_at__lt=cutoff(days, today), **s.extra_filter)
    if branch_id is not None:
        qs = qs.filter(**{s.scope_field: branch_id})
    return qs.order_by("created_at", "id")


def due_ids(key: str, days: int, today: date | None = None, branch_id: int | None = None) -> list[int]:
    return list(due_queryset(key, days, today, branch_id).values_list("id", flat=True))


def scope_branch_of(key: str, obj) -> int | None:
    """The branch the request is listed under (the hub's scope field: the employee's branch, an On-Duty request's own)."""
    field = spec(key).scope_field
    if field == "branch_id":
        return getattr(obj, "branch_id", None)
    return getattr(getattr(obj, "employee", None), "branch_id", None)


class Describer:
    """What was asked, in the Requests hub's own words (label + summary). Shared across the rows of one list (the permission
    serializer keeps its monthly-cap lookups between rows)."""

    def __init__(self):
        self._permission = None

    def __call__(self, key: str, obj) -> tuple[str, str]:
        fallback = spec(key).label
        try:
            from .. import hr_requests_views as hub

            if key == "permission":
                if self._permission is None:
                    self._permission = {"permission": hub._permission_row_builder()}
                parts = hub._permission(obj, self._permission)
            else:
                parts = hub.BUILDERS[key](obj)
            return str(parts.get("label") or fallback), str(parts.get("summary") or "")
        except Exception:  # a description is never worth failing a list or a rejection over
            return fallback, ""


def _name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def item_json(key: str, obj, today: date, describe: Describer) -> dict:
    what, summary = describe(key, obj)
    emp = obj.employee
    return {
        "key": f"{key}-{obj.id}",
        "kind": key,
        "kindLabel": spec(key).label,
        "id": obj.id,
        "employee": {
            "id": emp.id,
            "code": emp.employee_code,
            "name": _name(emp),
            "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        },
        "what": what,
        "summary": summary,
        "submittedAt": obj.created_at.isoformat(),
        "submittedOn": submitted_day(obj.created_at).isoformat(),
        "daysWaiting": days_waiting(obj.created_at, today),
    }


def preview(days: int, today: date | None = None, branch_id: int | None = None, limit: int = PREVIEW_MAX) -> dict:
    """The requests the next run would reject: {total, byKind {kind: n}, items (oldest first, at most `limit`), truncated}."""
    today = today or ist_today()
    by_kind: dict[str, int] = {}
    rows: list[tuple[str, object]] = []
    for key in AUTO_KINDS:
        s = spec(key)
        qs = due_queryset(key, days, today, branch_id)
        count = qs.count()
        if not count:
            continue
        by_kind[key] = count
        select = tuple(dict.fromkeys(("employee", "employee__branch", *s.select)))
        rows.extend((key, obj) for obj in qs.select_related(*select).defer("employee__photo_url")[:limit])
    rows.sort(key=lambda r: (r[1].created_at, r[0], r[1].id))
    describe = Describer()
    # an On-Duty punch whose On-Duty request is due too is voided by that request's rejection (one notice, not two)
    due_sessions = set(due_queryset("on_duty", days, today, branch_id).values_list("id", flat=True))
    items = []
    for key, obj in rows[:limit]:
        item = item_json(key, obj, today, describe)
        if key == "on_duty_punch" and obj.session_id in due_sessions:
            item["voidedWith"] = {"kind": "on_duty", "id": obj.session_id}
        items.append(item)
    total = sum(by_kind.values())
    return {"total": total, "byKind": by_kind, "items": items, "truncated": total > len(items)}
