"""
What is pending WITH each Department Head: the HoD's tab of the HR Requests page, and the reminders of its Notify tab
(hod_reminders.py).

ONE definition of "pending with a head", the one their mobile Approvals tab counts (mobile_approvals_views.py): for every
category the head is `allowed` (the per-person switches on the HOD page), the open rows `_split_pending` puts in the
head's own list - `approval.can_act(workflow, obj, HOD, cfg)` under HR's pipeline - among the employees that really report
to that head (`_scope_filter`: the one-HOD-per-employee rule of hod_scope.py with HR's carve-outs, never the head's own
requests). Nothing here decides anything; it only reads.

For many heads at once the employees each head really has come from hod_scope.managed_employee_map (managed_employee_ids
for every head in one pass), and each category is read ONCE for all heads through the same `_base_qs` / `_split_pending`
the Approvals tab uses, so the number of queries does not grow with the number of heads or requests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

from django.db.models import Q
from django.utils import timezone

from .clock import FACTORY_TZ
from .hod_scope import managed_employee_map
from .mobile_approvals_views import CATEGORIES, Category, _base_qs, _split_pending, allowed
from .models import DepartmentManager


@dataclass
class HeadPending:
    """One Department Head and what waits for them: {category key: [requests, oldest first]} for every category they
    are allowed to decide (a category they are not allowed is absent)."""

    manager: DepartmentManager
    items: dict[str, list] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(len(rows) for rows in self.items.values())

    def counts(self, categories=CATEGORIES) -> dict[str, int | None]:
        """{category key: how many} with None for a category the head is not allowed to decide (not 0)."""
        return {c.key: (len(self.items[c.key]) if c.key in self.items else None) for c in categories}


def active_managers(branch_id: int | None = None):
    """Every ACTIVE Department Head (User Management), with what their card shows."""
    qs = DepartmentManager.objects.filter(is_active=True).select_related(
        "employee", "employee__designation", "employee__branch", "employee__department"
    )
    if branch_id is not None:
        qs = qs.filter(employee__branch_id=branch_id)
    return list(qs.order_by("employee__first_name", "employee__last_name", "id"))


def _item_scope(cat: Category, branch_id: int | None) -> Q:
    """A branch login sees the requests of its own branch only, by the field the Requests page scopes that kind by (an
    On-Duty request by the branch it was raised in, every other kind by the employee's branch)."""
    if branch_id is None:
        return Q()
    return Q(branch_id=branch_id) if cat.key == "on_duty" else Q(employee__branch_id=branch_id)


def collect(managers, *, branch_id: int | None = None, categories=CATEGORIES) -> dict[int, HeadPending]:
    """{manager_id: HeadPending} for these ACTIVE Department Heads (see the module docstring). `branch_id` keeps only
    the requests a branch login may see; `categories` limits which categories are read at all."""
    from . import approval_workflow as approval

    managers = list(managers)
    out = {m.id: HeadPending(m, {c.key: [] for c in categories if allowed(m, c)}) for m in managers}
    if not managers:
        return out
    managed = managed_employee_map(managers)
    head_of = {emp_id: mgr_id for mgr_id, emps in managed.items() for emp_id in emps}
    own = {m.id: m.employee_id for m in managers}
    cfgs = approval.all_configs()
    for cat in categories:
        if not any(cat.key in hp.items for hp in out.values()):
            continue  # no head may decide this category: nothing to read
        mine, _forwarded = _split_pending(cat, _base_qs(cat, _item_scope(cat, branch_id)), cfgs[cat.workflow])
        for obj in mine:  # oldest first (_split_pending orders by created_at, id)
            mgr_id = head_of.get(obj.employee_id)
            if mgr_id is None or own[mgr_id] == obj.employee_id:
                continue  # nobody's report, or the head's own request (a head never decides their own)
            bucket = out[mgr_id].items.get(cat.key)
            if bucket is not None:
                bucket.append(obj)
    return out


# ─────────────────────────── the JSON of one request ───────────────────────────


def day_text(day) -> str:
    """ "05 Nov 2026" (the date format of every line this feature writes)."""
    return day.strftime("%d %b %Y")


def _as_date(value) -> date | None:
    if isinstance(value, datetime):
        return timezone.localtime(value, FACTORY_TZ).date() if timezone.is_aware(value) else value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def span_text(start, end) -> str:
    """ "05 Nov 2026", "05 - 07 Nov 2026", "30 Nov - 02 Dec 2026" or "30 Dec 2026 - 02 Jan 2027"."""
    a, b = _as_date(start), _as_date(end) or _as_date(start)
    if a is None:
        return str(start or "")
    if b is None or b == a:
        return day_text(a)
    if (a.year, a.month) == (b.year, b.month):
        return f"{a.day:02d} - {day_text(b)}"
    if a.year == b.year:
        return f"{a.strftime('%d %b')} - {day_text(b)}"
    return f"{day_text(a)} - {day_text(b)}"


def _hhmm(value) -> str:
    return value.strftime("%H:%M") if value else ""


def _days(value) -> str:
    n = float(value if value is not None else 1)
    return f"{n:g} day{'' if n == 1 else 's'}"


def _cap(text: str | None) -> str:
    return (text or "").replace("_", " ").strip().capitalize()


def _leave(r) -> tuple[str, str]:
    kind = _cap(r.type) or "Leave"
    kind = kind if kind.lower().endswith("leave") else f"{kind} Leave"
    kind = kind.title()
    if r.is_half_day:
        part = "afternoon" if r.half_day_slot == "afternoon" else "morning"
        return span_text(r.start_date, r.end_date), f"{kind} · Half day ({part})"
    return span_text(r.start_date, r.end_date), f"{kind} · {_days(r.total_days)}"


def _permission(r) -> tuple[str, str]:
    from .models import EmployeePermission

    slug = EmployeePermission.normalize_type(r.type)
    kind = EmployeePermission.TYPE_LABELS.get(slug) if slug else None
    when = r.date.strftime("%d %b") if r.date else ""
    summary = "Permission"
    if r.duration_minutes:
        summary += f" · {r.duration_minutes} min"
    if r.permission_time:
        summary += f" at {_hhmm(r.permission_time)}"
    return (f"{kind} · {when}" if kind else day_text(r.date)) if r.date else (kind or ""), summary


def _casual(r) -> tuple[str, str]:
    part = dict(r.PORTION_CHOICES).get(r.portion) or "Full day"
    return day_text(r.date), f"Casual Leave · {part}"


def _attendance(r) -> tuple[str, str]:
    asked = r.requested_values or {}
    before = r.previous_values or {}
    proposed = asked.get("typeLabel") or _cap(asked.get("status")) or "Change"
    was = _cap(before.get("status"))
    return day_text(r.date), f"Attendance correction · {was} → {proposed}" if was else f"Attendance · {proposed}"


def _missing_punch(r) -> tuple[str, str]:
    slot = dict(r.PUNCH_SLOT_CHOICES).get(r.punch_slot) or ("Check-in" if r.punch_type == "IN" else "Check-out")
    return day_text(r.date), f"Missing Punch · {slot} {_hhmm(r.punch_time)}".rstrip()


def _on_duty(r) -> tuple[str, str]:
    day = _as_date(r.started_at or r.created_at)
    return (day_text(day) if day else ""), f"On-Duty · {r.destination}" if r.destination else "On-Duty"


def _outpass(r) -> tuple[str, str]:
    day = _as_date(r.created_at)
    kind = dict(r.PASS_TYPE_CHOICES).get(r.pass_type) if r.pass_type else None
    parts = ["Outpass", kind, r.destination]
    return (day_text(day) if day else ""), " · ".join(p for p in parts if p)


def _holiday_work(r) -> tuple[str, str]:
    day = "Sunday" if r.work_date.weekday() == 6 else "Holiday"
    shifts = float(r.shifts)
    return day_text(r.work_date), f"{day} work · {shifts:g} shift{'' if shifts <= 1 else 's'}"


def _resignation(r) -> tuple[str, str]:
    when = f"Last day {day_text(r.last_working_date)}" if r.last_working_date else "Last day not given"
    return when, "Resignation"


_TEXTS = {
    "leave": _leave,
    "permission": _permission,
    "casual_leave": _casual,
    "attendance": _attendance,
    "missing_punch": _missing_punch,
    "on_duty": _on_duty,
    "outpass": _outpass,
    "holiday_work": _holiday_work,
    "resignation": _resignation,
}


def _name(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _iso(value) -> str | None:
    return timezone.localtime(value, FACTORY_TZ).isoformat() if value else None


def waiting_days(created_at, today: date) -> int | None:
    day = _as_date(created_at)
    return max(0, (today - day).days) if day else None


def item_json(cat: Category, obj, today: date) -> dict:
    """One request waiting for a head, as the HoD's tab lists it."""
    emp = obj.employee
    for_text, summary = _TEXTS[cat.key](obj)
    return {
        "category": cat.key,
        "categoryLabel": cat.label,
        "id": obj.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": _name(emp),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "forText": for_text,
        "summary": summary,
        "raisedAt": _iso(obj.created_at),
        "waitingDays": waiting_days(obj.created_at, today),
        # The Requests page opens it on its own kind's tab (the kinds there are the approval workflow keys).
        "openPath": f"/hr/requests?kind={cat.workflow}&focus={obj.id}",
    }
