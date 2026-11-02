"""Mobile Messages (HR portal -> Mobile App Login -> Mobile Messages): the control panel for what reaches employees' phones.

All endpoints are HR-only, branch scoped, and sit under the `mobile_app_login` permission module (URL "mobile-app/messages").

    GET  /api/mobile-app/messages/overview    devices, what was sent today / 7 / 30 days, by kind and by day, the switches' state
    GET  /api/mobile-app/messages/controls    the master switch and a switch per kind of message
    PUT  /api/mobile-app/messages/controls    {pushEnabled?, types: {key: bool}} change them
    GET  /api/mobile-app/messages/log         every notification sent: filters, pagination, what happened to the push
    GET  /api/mobile-app/messages/devices     which employees have a phone registered for notifications
    POST /api/mobile-app/messages/send        {employeeId, title, message} one message from HR to one employee

What a message is, and how it becomes a push, is in push_messages.py (the same text WhatsApp carries) and signals.py (the push
itself). The switches only control the PHONE push (mobile_messages.py): the in-app record is always saved.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import mobile_messages, push_receipts
from . import whatsapp_catalog as catalog
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ
from .models import Employee, MobileMessageSettings, Notification, PushToken
from .view_common import error_response as _error
from .view_common import paginate

PUSH_STATUSES = ("sent", "delivered", "no_device", "failed", "off")
STATUS_LABEL = {
    "sent": "Sent (waiting for the push service)",
    "delivered": "Delivered to the phone",
    "no_device": "No phone registered",
    "failed": "Push failed",
    "off": "Switched off for phones",
    "": "Not pushed (older notice)",
}
MAX_TITLE = 60
MAX_MESSAGE = 500


def _name(e: Employee) -> str:
    return f"{e.first_name} {e.last_name}".strip()


def _source_label(source: str, related_module: str) -> str:
    if source == mobile_messages.MANUAL:
        return "Message from HR"
    t = catalog.get(source)
    if t is None:
        return mobile_messages.extra_label(source) or "In-app notice"
    if t.module == "approvals" and related_module in catalog.APPROVAL_MODULES:
        return f"{t.label}: {catalog.APPROVAL_MODULES[related_module]}"
    return t.label


def _notifications(request: Request):
    return scope_to_branch(Notification.objects.select_related("employee"), request, field="employee__branch_id")


def _employees(request: Request):
    return scope_to_branch(Employee.objects.filter(status="active"), request, field="branch_id")


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    return today - timedelta(days=days_back)


@api_view(["GET"])
@require_hr
def mobile_messages_overview(request: Request) -> Response:
    push_receipts.check_pending()  # read Expo's receipts for what was sent a minute or more ago
    notes = _notifications(request)
    employees = _employees(request)
    settings = MobileMessageSettings.get()

    emp_ids = list(employees.values_list("id", flat=True))
    with_device = PushToken.objects.filter(employee_id__in=emp_ids).values("employee_id").distinct().count()
    last_registered = PushToken.objects.filter(employee_id__in=emp_ids).aggregate(m=Max("updated_at"))["m"]

    def counts(since: datetime) -> dict:
        rows = dict(notes.filter(created_at__gte=since).values_list("push_status").annotate(n=Count("id")))
        total = sum(rows.values())
        return {
            "total": total,
            "sent": rows.get("sent", 0) + rows.get("delivered", 0),
            "delivered": rows.get("delivered", 0),
            "noDevice": rows.get("no_device", 0),
            "failed": rows.get("failed", 0),
            "off": rows.get("off", 0),
        }

    month_start = _day_start(29)
    month = notes.filter(created_at__gte=month_start)
    read = month.filter(is_read=True).count()
    month_total = month.count()

    by_kind: dict[str, dict] = {}
    for source, related, n in month.values_list("source", "related_module").annotate(n=Count("id")).order_by("-n"):
        label = _source_label(source, related)
        row = by_kind.setdefault(label, {"label": label, "count": 0})
        row["count"] += n

    by_day = []
    per_day = (
        notes.filter(created_at__gte=_day_start(13))
        .annotate(d=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("d", "push_status")
        .annotate(n=Count("id"))
    )
    grid: dict = {}
    for r in per_day:
        row = grid.setdefault(r["d"], {"total": 0, "sent": 0})
        row["total"] += r["n"]
        if r["push_status"] in ("sent", "delivered"):
            row["sent"] += r["n"]
    for back in range(13, -1, -1):
        d = _day_start(back).date()
        row = grid.get(d, {"total": 0, "sent": 0})
        by_day.append({"date": d.isoformat(), **row})

    return Response(
        {
            "pushEnabled": settings.push_enabled,
            "switchedOff": len([k for k in (settings.disabled_types or []) if k in mobile_messages.valid_keys()]),
            "devices": {
                "employees": len(emp_ids),
                "withDevice": with_device,
                "withoutDevice": len(emp_ids) - with_device,
                "tokens": PushToken.objects.filter(employee_id__in=emp_ids).count(),
                "lastRegisteredAt": last_registered.isoformat() if last_registered else None,
            },
            "today": counts(_day_start(0)),
            "week": counts(_day_start(6)),
            "month": counts(month_start),
            "readRate": round(read * 100 / month_total, 1) if month_total else None,
            "byKind": list(by_kind.values())[:12],
            "byDay": by_day,
        }
    )


def _controls_body() -> dict:
    settings = MobileMessageSettings.get()
    off = set(settings.disabled_types or [])
    rows = [{**row, "enabled": row["key"] not in off} for row in mobile_messages.controls()]
    return {
        "pushEnabled": settings.push_enabled,
        "controls": rows,
        "updatedBy": settings.updated_by or None,
        "updatedAt": settings.updated_at.isoformat() if settings.updated_at else None,
    }


@api_view(["GET", "PUT"])
@require_hr
def mobile_messages_controls(request: Request) -> Response:
    if request.method == "GET":
        return Response(_controls_body())

    data = request.data
    settings = MobileMessageSettings.get()
    changed: list[str] = []
    if "pushEnabled" in data:
        if not isinstance(data["pushEnabled"], bool):
            return _error("pushEnabled must be true or false")
        if settings.push_enabled != data["pushEnabled"]:
            changed.append(f"phone notifications {'ON' if data['pushEnabled'] else 'OFF'}")
        settings.push_enabled = data["pushEnabled"]
    types = data.get("types")
    if types is not None:
        if not isinstance(types, dict):
            return _error("types must be an object of key: true/false")
        valid = mobile_messages.valid_keys()
        off = set(settings.disabled_types or [])
        for key, value in types.items():
            if key not in valid:
                return _error(f"'{key}' is not a message that can be switched")
            if not isinstance(value, bool):
                return _error(f"'{key}' must be true or false")
            if value and key in off:
                off.discard(key)
                changed.append(f"{key} ON")
            elif not value and key not in off:
                off.add(key)
                changed.append(f"{key} OFF")
        settings.disabled_types = sorted(off)
    if not changed and "pushEnabled" not in data and types is None:
        return _error("Nothing to change")
    settings.updated_by = get_hr_display_name(request)
    settings.updated_at = timezone.now()
    settings.save()
    if changed:
        log_action(
            request,
            "update",
            "mobile_app_login",
            record_id=settings.pk,
            description="Mobile Messages: " + ", ".join(changed),
        )
    return Response(_controls_body())


def _log_row(n: Notification) -> dict:
    e = n.employee
    return {
        "id": n.id,
        "employeeId": e.id,
        "employeeName": _name(e),
        "employeeCode": e.employee_code,
        "title": n.title or "",
        "message": n.message,
        "type": n.type,
        "kind": _source_label(n.source, n.related_module),
        "source": n.source or "",
        "pushStatus": n.push_status or "",
        "pushStatusLabel": STATUS_LABEL.get(n.push_status or "", n.push_status),
        "pushError": n.push_error or None,
        "isRead": n.is_read,
        "createdAt": n.created_at.isoformat(),
        "pushedAt": n.pushed_at.isoformat() if n.pushed_at else None,
    }


@api_view(["GET"])
@require_hr
def mobile_messages_log(request: Request) -> Response:
    """Newest first. Filters: search (name / code / text), status (a push status), kind (a catalogue key, "manual" or
    "older"), read (read | unread), dateFrom / dateTo (YYYY-MM-DD, Indian time). Without `page` it is a capped array."""
    push_receipts.check_pending()
    q = request.query_params
    qs = _notifications(request).order_by("-created_at", "-id")
    if status := q.get("status"):
        if status not in PUSH_STATUSES:
            return _error(f"status must be one of: {', '.join(PUSH_STATUSES)}")
        qs = qs.filter(push_status=status)
    if kind := q.get("kind"):
        if kind == "older":
            qs = qs.filter(source="")
        elif kind == mobile_messages.MANUAL or kind in catalog.TYPES or kind in mobile_messages.EXTRA_TYPES:
            qs = qs.filter(source=kind)
        else:
            return _error("kind is not a known kind of message")
    if (read := q.get("read")) in ("read", "unread"):
        qs = qs.filter(is_read=(read == "read"))
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(employee__first_name__icontains=search)
            | Q(employee__last_name__icontains=search)
            | Q(employee__employee_code__icontains=search)
            | Q(title__icontains=search)
            | Q(message__icontains=search)
        )
    from datetime import date

    for param, op in (("dateFrom", "gte"), ("dateTo", "lt")):
        if raw := q.get(param):
            try:
                d = date.fromisoformat(raw)
            except ValueError:
                return _error(f"{param} must be YYYY-MM-DD")
            if op == "lt":
                d += timedelta(days=1)
            qs = qs.filter(**{f"created_at__{op}": datetime.combine(d, datetime.min.time(), tzinfo=FACTORY_TZ)})
    return paginate(request, qs, _log_row)


@api_view(["GET"])
@require_hr
def mobile_messages_devices(request: Request) -> Response:
    """The active employees with how many phones each has registered for notifications. Filters: has (with | without),
    search (name / code / phone)."""
    q = request.query_params
    qs = (
        _employees(request)
        .annotate(devices=Count("push_tokens"), registered=Max("push_tokens__updated_at"))
        .order_by("first_name", "id")
    )
    if (has := q.get("has")) == "with":
        qs = qs.filter(devices__gt=0)
    elif has == "without":
        qs = qs.filter(devices=0)
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(employee_code__icontains=search)
            | Q(phone__icontains=search)
        )

    def row(e: Employee) -> dict:
        return {
            "id": e.id,
            "name": _name(e),
            "employeeCode": e.employee_code,
            "employmentType": e.employment_type,
            "phone": (e.phone or "").strip() or None,
            "devices": e.devices,
            "lastRegisteredAt": e.registered.isoformat() if e.registered else None,
        }

    return paginate(request, qs, row)


@api_view(["POST"])
@require_hr
def mobile_messages_send(request: Request) -> Response:
    """One message from HR to one employee: an in-app notification, pushed to their phones like any other. For a test of a
    phone, or a short note that is not any of the system's messages."""
    data = request.data
    emp = (
        _employees(request).filter(pk=data.get("employeeId")).first()
        if str(data.get("employeeId") or "").isdigit()
        else None
    )
    if emp is None:
        return _error("Choose an active employee", 404)
    title = str(data.get("title") or "").strip()
    message = str(data.get("message") or "").strip()
    if not title or not message:
        return _error("Write a title and a message")
    if len(title) > MAX_TITLE or len(message) > MAX_MESSAGE:
        return _error(f"The title can be {MAX_TITLE} characters and the message {MAX_MESSAGE}")
    n = Notification.objects.create(
        employee=emp, type="general", title=title, message=message, source=mobile_messages.MANUAL
    )
    n.refresh_from_db()  # the push result is written by the signal
    log_action(
        request,
        "create",
        "mobile_app_login",
        record_id=n.pk,
        description=f"Sent a message to {_name(emp)} ({emp.employee_code}): {title}",
    )
    return Response(_log_row(n), status=201)
