"""
My Requests + "remind the approver" (mobile HOD Assignment -> My Requests; owner 2026-10-31).

    GET  /api/my/pending-requests                          the signed-in employee's OWN requests still waiting for an answer
    POST /api/my/pending-requests/<module>/<id>/remind     remind whoever has to act on one of them NOW
    GET  /api/hr/approval-reminders                        HR: the reminders employees sent to HR (the Requests hub shows them)

Which requests: every kind an EMPLOYEE raises (leave, permission, casual leave, missing punch, On-Duty, gate outpass,
resignation, general requests to HR, and an advance the employee applied for in the app), plus the ATTENDANCE CHANGES HR
proposed for this employee (owner 2026-10-31: "display requests related to attendance edits made by HR"). Those carry
`raisedBy: "hr"` and a `change` block saying what HR asked for (the day, what it was, what it would become). The other
kinds HR raises (holiday / Sunday work, an advance HR entered) stay out. `recentHrEdits` adds HR's attendance changes for this
employee decided in the last 30 days, so the employee can see what HR changed.

An HR-raised attendance change can be reminded like the employee's own requests (same 24 hours, same "who acts now"): the
engine knows only approver roles, never the requester, so it gives no reason to treat the employee differently, and the
employee is the one whose attendance waits on it. The head's notification says it was raised by HR.

Who acts now is the approval engine's answer, never a rule of this file: `approval_workflow.progress()` gives the step the
request is at and the role(s) holding it ("waitingFor"), and `hod_scope.managers_to_notify()` gives the employee's ONE
Department Head when that head is allowed to decide this kind (the same call the engine uses to tell a head a request has
reached them). So:
    * the step is the Department Head's and the employee has one who may decide it  -> remind that head (phone push + in-app)
    * otherwise, when HR holds the step (alone, or "Department Head or HR" with no usable head)  -> remind HR
    * a Department-Head-only step with no head who can decide it (none assigned, the employee IS the head, or the head is
      not allowed to approve this kind)  -> HR is reminded too: only HR can unblock it (by assigning a head)

A reminder is allowed once per request every 24 hours (owner). The HOD's reminder is a Notification row: creating it is
what pushes it to their phones (signals.py), its `source` is "approval_reminder" so HR can switch the push off on Mobile
App Login -> Mobile Messages like any other kind; the in-app record is kept either way. HR has no inbox of its own in the
HR portal (the Notifications page lists the notifications sent TO employees), so an HR reminder is the ApprovalReminder row
itself, which the Requests hub reads through GET /api/hr/approval-reminders and shows on the request as
"Employee reminded on <time>".
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.apps import apps
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from . import hr_requests_views as hub
from .auth import get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ
from .hod_scope import managers_to_notify
from .mobile_messages import REMINDER_SOURCE
from .models import ApprovalReminder, Employee, Notification

COOLDOWN = timedelta(hours=24)
COOLDOWN_HOURS = 24
RECENT_DAYS = 30  # how far back `recentHrEdits` reaches
RECENT_LIMIT = 30

REMINDER_TITLE = "Reminder: request waiting"
REMINDER_OPENING = "Sir, please review this request and provide your approval."

# The kinds an employee raises themselves, in the order the app lists their filters.
MODULES: tuple[str, ...] = (
    "leave",
    "permission",
    "casual_leave",
    "missing_punch",
    "on_duty",
    "outpass",
    "attendance_correction",  # raised by HR FOR the employee: listed so they can see it and remind the approver
    "resignation",
    "advance",
    "request",
)

# Waiting statuses of the two HR-only kinds (they have no staged adapter in the engine). A general request HR marked
# "more info needed" is waiting for the EMPLOYEE, not for HR, so it is not listed.
_HR_ONLY_WAITING = {"request": ("pending", "in_review"), "advance": ("pending",)}


# ───────────────────────────── queries ─────────────────────────────


def _waiting_qs(module: str, employee_id: int):
    kind = hub.BY_KEY[module]
    model = apps.get_model("api", kind.model)
    qs = model.objects.filter(employee_id=employee_id).select_related(*kind.select)
    a = approval.adapter(module)
    if a is not None:
        return qs.filter(status__in=a.pending, **a.extra_filter)
    qs = qs.filter(status__in=_HR_ONLY_WAITING[module])
    if module == "advance":
        qs = qs.filter(applied_by="employee")  # an advance HR entered is not the employee's request
    return qs


def _is_waiting(module: str, obj) -> bool:
    a = approval.adapter(module)
    if a is not None:
        return obj.status in a.pending and all(getattr(obj, f) == v for f, v in a.extra_filter.items())
    if module == "advance" and getattr(obj, "applied_by", "") != "employee":
        return False
    return obj.status in _HR_ONLY_WAITING[module]


# ───────────────────────────── who acts now ─────────────────────────────


class _Heads:
    """The employee's Department Head per approval switch, looked up once per switch for one request."""

    def __init__(self, emp):
        self.emp = emp
        self._memo: dict[str, object] = {}

    def for_module(self, module: str):
        flag = approval.definition(module).hod_flag
        if not flag:
            return None
        if flag not in self._memo:
            # exclude_self: a head never decides their own request, so they are never "their own" approver here.
            found = managers_to_notify(self.emp, flag, exclude_self=True)
            self._memo[flag] = found[0] if found else None
        return self._memo[flag]


def _who_acts(module: str, waiting: tuple[str, ...], heads: _Heads) -> dict:
    """{role: "hod" | "hr", manager, stuck}: who a reminder for this request goes to."""
    if approval.HOD in waiting:
        manager = heads.for_module(module)
        if manager is not None:
            return {"role": approval.HOD, "manager": manager, "stuck": False}
    if approval.HR in waiting:
        return {"role": approval.HR, "manager": None, "stuck": False}
    # A Department-Head-only step and no head who can decide it: only HR can sort that out.
    return {"role": approval.HR, "manager": None, "stuck": True}


def _person(emp) -> str:
    return f"{emp.first_name} {emp.last_name}".strip()


def _stage_text(waiting: tuple[str, ...], target: dict) -> str:
    if target["role"] == approval.HOD:
        name = _person(target["manager"].employee)
        text = f"Waiting for your Department Head ({name})"
        return f"{text} or HR" if approval.HR in waiting else text
    if target["stuck"]:
        return "Waiting for your Department Head (none can approve it yet; HR can sort this out)"
    return "Waiting for HR"


def _approver_json(target: dict) -> dict:
    if target["role"] == approval.HOD:
        return {"role": "hod", "name": _person(target["manager"].employee), "label": "Department Head"}
    return {"role": "hr", "name": "HR", "label": "HR"}


def _sent_to(target: dict) -> str:
    return f"hod:{target['manager'].employee_id}" if target["role"] == approval.HOD else "hr"


# ───────────────────────────── who raised it, what HR asked for ─────────────────────────────


def _raised_by(module: str, obj) -> str:
    """ "employee" or "hr". An advance says it itself; every other kind is raised by whoever its workflow names."""
    if module == "advance":
        return "employee" if getattr(obj, "applied_by", "") == "employee" else "hr"
    return "hr" if approval.definition(module).requested_by == "HR" else "employee"


def _raised_json(module: str, obj) -> dict:
    who = _raised_by(module, obj)
    return {
        "raisedBy": who,
        "raisedByLabel": "Raised by HR" if who == "hr" else "Raised by you",
        "raisedByName": (getattr(obj, "requested_by", None) or "HR") if who == "hr" else None,
    }


def _shifts(value) -> str | None:
    try:
        return f"{float(value):.2f} shift"
    except (TypeError, ValueError):
        return None


def _change_json(obj) -> dict:
    """What an attendance change HR proposed would do to the day, in parts and as one plain sentence:
    "2026-10-08: Absent (0.00 shift) -> Present (1.00 shift), 09:00 to 18:00, marked Late"."""
    asked = obj.requested_values or {}
    before = obj.previous_values or {}
    from_label = hub._cap(before.get("status")) or None
    to_label = asked.get("typeLabel") or hub._cap(asked.get("status")) or None
    from_shifts = _shifts(before.get("shiftsEarned")) if "shiftsEarned" in before else None
    to_shifts = _shifts(asked.get("shiftsEarned")) if "shiftsEarned" in asked else None
    first, last = asked.get("firstPunch") or None, asked.get("lastPunch") or None
    marks = [m for m, on in (("Late", asked.get("isLate")), ("Early out", asked.get("isEarlyOut"))) if on]

    def side(label, shifts):
        return f"{label or 'Not recorded'}" + (f" ({shifts})" if shifts else "")

    text = f"{obj.date}: {side(from_label, from_shifts)} → {side(to_label, to_shifts)}"
    if first or last:
        text += f", {first or '-'} to {last or '-'}"
    if marks:
        text += f", marked {' and '.join(marks)}"
    return {
        "date": str(obj.date),
        "fromLabel": from_label,
        "fromShifts": from_shifts,
        "toLabel": to_label,
        "toShifts": to_shifts,
        "firstPunch": first,
        "lastPunch": last,
        "marks": marks,
        "text": text,
    }


# ───────────────────────────── one row ─────────────────────────────


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _parse(value):
    """An ISO date-time string back into an aware datetime, or None."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else timezone.make_aware(parsed)


def _local(value) -> str:
    """'31 Oct 2026, 10:05' in factory (Indian) time."""
    return value.astimezone(FACTORY_TZ).strftime("%d %b %Y, %H:%M")


def _steps_json(prog: dict) -> list[dict]:
    out = []
    for s in prog.get("steps", []):
        roles = tuple(s.get("roles") or ())
        out.append(
            {
                "index": s.get("index"),
                "roles": list(roles),
                "label": " or ".join(approval.ROLE_LONG[r] for r in roles if r in approval.ROLE_LONG),
                "state": s.get("state"),
                "by": s.get("by"),
                "at": s.get("at"),
            }
        )
    return out


def _trail_json(module: str, obj) -> list[dict]:
    if approval.adapter(module) is None:
        return []
    return [
        {
            "role": e.get("role"),
            "roleLabel": approval.ROLE_LONG.get(e.get("role"), e.get("role") or ""),
            "decision": e.get("decision"),
            "by": e.get("by"),
            "at": e.get("at"),
            "comment": e.get("comment"),
        }
        for e in approval.trail_of(module, obj)
    ]


def _reminder_state(last, now) -> dict:
    if last is None:
        return {"lastRemindedAt": None, "canRemind": True, "nextReminderAt": None, "remindInSeconds": 0}
    opens = last.created_at + COOLDOWN
    wait = max(0, int((opens - now).total_seconds()))
    return {
        "lastRemindedAt": _iso(last.created_at),
        "canRemind": wait == 0,
        "nextReminderAt": _iso(opens) if wait else None,
        "remindInSeconds": wait,
    }


def _last_reminder(module: str, request_id: int):
    return ApprovalReminder.objects.filter(module=module, request_id=request_id).order_by("-created_at", "-id").first()


def _item(module: str, obj, *, cfg, heads: _Heads, extra: dict, last, count: int, now) -> dict:
    build = hub.BUILDERS.get(module)
    parts = build(obj) if build else hub._permission(obj, extra)
    prog = approval.progress(module, obj, cfg)
    waiting = tuple(prog.get("waitingFor") or ())
    target = _who_acts(module, waiting, heads)
    return {
        "key": f"{module}-{obj.id}",
        "module": module,
        "moduleLabel": hub.BY_KEY[module].label,
        "id": obj.id,
        "title": parts["label"],
        "summary": parts["summary"],
        "reason": parts.get("reason"),
        "date": parts.get("date"),
        "submittedAt": _iso(obj.created_at),
        "status": obj.status,
        "stage": _stage_text(waiting, target),
        "waitingFor": list(waiting),
        "approver": _approver_json(target),
        "steps": _steps_json(prog),
        "currentStep": prog.get("currentStep"),
        "trail": _trail_json(module, obj),
        "workflowEnabled": cfg.enabled,
        "details": [{"label": a, "value": b} for a, b in parts.get("details", [])],
        "change": _change_json(obj) if module == "attendance_correction" else None,
        **_raised_json(module, obj),
        "reminderCount": count,
        **_reminder_state(last, now),
    }


def _items_for(emp, modules=MODULES) -> list[dict]:
    now = timezone.now()
    heads = _Heads(emp)
    extra = {"permission": hub._permission_row_builder()}
    rows: list[tuple[str, object]] = [(m, obj) for m in modules for obj in _waiting_qs(m, emp.id)]
    # The latest reminder (and how many) per request, in one query.
    last: dict[tuple[str, int], object] = {}
    counts: dict[tuple[str, int], int] = {}
    if rows:
        for r in ApprovalReminder.objects.filter(
            employee_id=emp.id, module__in={m for m, _ in rows}, request_id__in={o.id for _, o in rows}
        ).order_by("created_at", "id"):
            key = (r.module, r.request_id)
            last[key] = r
            counts[key] = counts.get(key, 0) + 1
    items = [
        _item(
            m,
            obj,
            cfg=approval.get_config(m),
            heads=heads,
            extra=extra,
            last=last.get((m, obj.id)),
            count=counts.get((m, obj.id), 0),
            now=now,
        )
        for m, obj in rows
    ]
    items.sort(key=lambda i: (i["submittedAt"] or "", i["id"]), reverse=True)
    return items


def _recent_hr_edits(emp, now) -> list[dict]:
    """HR's attendance changes for this employee that were approved or rejected in the last RECENT_DAYS days, newest first."""
    since = now - timedelta(days=RECENT_DAYS)
    kind = hub.BY_KEY["attendance_correction"]
    model = apps.get_model("api", kind.model)
    qs = model.objects.filter(employee_id=emp.id, status__in=("approved", "rejected")).filter(
        Q(reviewed_at__gte=since) | Q(created_at__gte=since)
    )
    out = []
    for obj in qs.order_by("-created_at", "-id")[: RECENT_LIMIT * 2]:
        parts = hub._correction(obj)
        decision = hub._decision_of(kind, obj, parts)
        decided_at = decision["at"] or _iso(obj.reviewed_at)
        when = _parse(decided_at) or obj.created_at
        if when is None or when < since:
            continue  # submitted inside the window but decided (or, with no stamp, submitted) before it
        out.append(
            {
                "key": f"attendance_correction-{obj.id}",
                "module": "attendance_correction",
                "id": obj.id,
                "title": parts["label"],
                "summary": parts["summary"],
                "reason": parts.get("reason"),
                "date": parts.get("date"),
                "details": [{"label": a, "value": b} for a, b in parts["details"]],
                "change": _change_json(obj),
                "status": obj.status,
                "statusLabel": "Approved" if obj.status == "approved" else "Rejected",
                "submittedAt": _iso(obj.created_at),
                "decidedAt": decided_at,
                "decidedBy": decision["by"],
                "decidedByRole": decision["role"],
                "comment": decision["comment"],
                **_raised_json("attendance_correction", obj),
            }
        )
    out.sort(key=lambda i: (i["decidedAt"] or i["submittedAt"] or "", i["id"]), reverse=True)
    return out[:RECENT_LIMIT]


# ───────────────────────────── endpoints ─────────────────────────────


def _employee_or_refusal(request: Request):
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None, Response(
            {
                "error": "Only an employee signed in to the app can see or remind their own requests.",
                "code": "employee_only",
            },
            status=403,
        )
    emp = Employee.objects.filter(pk=emp_id).first()
    if emp is None:
        return None, Response({"error": "Employee not found", "code": "not_found"}, status=404)
    return emp, None


@api_view(["GET"])
@require_auth
def my_pending_requests(request: Request) -> Response:
    emp, refused = _employee_or_refusal(request)
    if refused:
        return refused
    items = _items_for(emp)
    now = timezone.now()
    return Response(
        {
            "items": items,
            "count": len(items),
            "cooldownHours": COOLDOWN_HOURS,
            "recentHrEdits": _recent_hr_edits(emp, now),
            "recentDays": RECENT_DAYS,
            "serverTime": now.isoformat(),
        }
    )


def _reminder_message(emp, item: dict, submitted) -> str:
    who = f"{_person(emp)} ({emp.employee_code})" if emp.employee_code else _person(emp)
    raised = " (raised by HR)" if item.get("raisedBy") == "hr" else ""
    lines = [REMINDER_OPENING, f"{who} - {item['title']}{raised}: {item['summary']}."]
    if submitted:
        lines.append(f"Submitted {_local(submitted)}.")
    return "\n".join(lines)


@api_view(["POST"])
@require_auth
def remind_approver(request: Request, module: str, pk: int) -> Response:
    emp, refused = _employee_or_refusal(request)
    if refused:
        return refused
    if module not in MODULES:
        return Response({"error": "This kind of request cannot be reminded.", "code": "not_found"}, status=404)
    kind = hub.BY_KEY[module]
    model = apps.get_model("api", kind.model)
    now = timezone.now()
    with transaction.atomic():
        # Locked so two quick taps (or two phones) cannot both pass the 24-hour check.
        obj = model.objects.select_for_update().filter(pk=pk, employee_id=emp.id).first()
        if obj is None:  # someone else's request reads exactly like a missing one
            return Response({"error": "Request not found.", "code": "not_found"}, status=404)
        if not _is_waiting(module, obj):
            return Response(
                {
                    "error": "This request already has an answer, so there is nobody to remind.",
                    "code": "already_decided",
                },
                status=409,
            )
        last = _last_reminder(module, obj.id)
        if last is not None and last.created_at + COOLDOWN > now:
            opens = last.created_at + COOLDOWN
            wait = int((opens - now).total_seconds()) + 1
            hours, minutes = divmod(max(wait, 60) // 60, 60)
            when = f"{hours} h {minutes} m" if hours else f"{minutes} m"
            response = Response(
                {
                    "error": f"You already reminded the approver about this request. You can remind again in {when} "
                    f"({_local(opens)}).",
                    "code": "too_soon",
                    "lastRemindedAt": _iso(last.created_at),
                    "nextReminderAt": _iso(opens),
                    "retryAfterSeconds": wait,
                },
                status=429,
            )
            response["Retry-After"] = str(wait)
            return response
        heads = _Heads(emp)
        cfg = approval.get_config(module)
        extra = {"permission": hub._permission_row_builder()} if module == "permission" else {}
        item = _item(module, obj, cfg=cfg, heads=heads, extra=extra, last=None, count=0, now=now)
        waiting = tuple(item["waitingFor"])
        target = _who_acts(module, waiting, heads)
        reminder = ApprovalReminder.objects.create(
            employee=emp, module=module, request_id=obj.id, sent_to=_sent_to(target)
        )

    push = ""
    if target["role"] == approval.HOD:
        manager = target["manager"]
        # Made after the lock is released: creating it is what pushes it to the head's phones (signals.py), a network call.
        note = Notification.objects.create(
            employee=manager.employee,
            # Its own type, so a tap on the head's phone opens Approvals (mobile notificationRoute) and not the head's
            # own leave/permission screens.
            type=REMINDER_SOURCE,
            title=REMINDER_TITLE,
            message=_reminder_message(emp, item, obj.created_at),
            source=REMINDER_SOURCE,
            dedupe_key=f"reminder:{reminder.id}",
        )
        note.refresh_from_db(fields=["push_status"])
        push = note.push_status
        name = _person(manager.employee)
        message = f"Reminder sent to {name} (Department Head)."
        if push == "no_device":
            message += (
                " They have no phone registered for notifications, so they will see it in the app's notifications."
            )
        elif push == "off":
            message += " Phone notifications for reminders are switched off by HR, so they will see it in the app."
    else:
        message = "Reminder sent to HR. HR will see it on the Requests page."
        if target["stuck"]:
            message = (
                "You have no Department Head who can approve this request, so HR has been reminded instead. "
                "HR will see it on the Requests page."
            )

    count = ApprovalReminder.objects.filter(module=module, request_id=obj.id).count()
    item.update({"reminderCount": count, **_reminder_state(reminder, timezone.now())})
    return Response(
        {
            "message": message,
            "sentTo": "hod" if target["role"] == approval.HOD else "hr",
            "approver": item["approver"],
            "push": push,
            "remindedAt": _iso(reminder.created_at),
            "nextReminderAt": _iso(reminder.created_at + COOLDOWN),
            "item": item,
        }
    )


@api_view(["GET"])
@require_hr
def hr_approval_reminders(request: Request) -> Response:
    """The reminders employees sent to HR in the last `days` (default 7, at most 60), latest per request, for the requests
    still waiting. Branch-scoped like the Requests hub. Keys match the hub's item keys ("leave-12")."""
    try:
        days = min(60, max(1, int(request.query_params.get("days", 7))))
    except (TypeError, ValueError):
        days = 7
    since = timezone.now() - timedelta(days=days)
    qs = scope_to_branch(
        ApprovalReminder.objects.filter(sent_to="hr", created_at__gte=since).select_related("employee"),
        request,
        field="employee__branch_id",
    ).order_by("-created_at", "-id")
    latest: dict[str, dict] = {}
    for r in qs[:2000]:
        key = f"{r.module}-{r.request_id}"
        if key in latest:
            latest[key]["count"] += 1
            continue
        latest[key] = {
            "key": key,
            "module": r.module,
            "requestId": r.request_id,
            "employeeId": r.employee_id,
            "employeeName": _person(r.employee),
            "remindedAt": _iso(r.created_at),
            "count": 1,
        }
    # Only requests that are still waiting: a reminder about something HR already decided is history.
    by_module: dict[str, list[int]] = {}
    for row in latest.values():
        if row["module"] in MODULES:
            by_module.setdefault(row["module"], []).append(row["requestId"])
    waiting_keys: set[str] = set()
    for module, ids in by_module.items():
        model = apps.get_model("api", hub.BY_KEY[module].model)
        for obj in model.objects.filter(pk__in=ids):
            if _is_waiting(module, obj):
                waiting_keys.add(f"{module}-{obj.id}")
    rows = [row for key, row in latest.items() if key in waiting_keys]
    return Response({"reminders": rows, "days": days})
