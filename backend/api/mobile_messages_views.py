"""Phone Notify Control (HR portal -> /hr/phone-notify-control, 2026-11-17; before that Mobile App Login -> Mobile Messages):
the control panel for what reaches employees' phones.

All endpoints are HR-only and branch scoped. They keep the URL prefix "mobile-app/messages" (permission key
`phone_notify_control`, which a role with nothing set on it takes from Mobile App Login, the page that held them before).

    GET  /api/mobile-app/messages/overview    devices, what was sent today / 7 / 30 days, by kind and by day, the switches' state
    GET  /api/mobile-app/messages/controls    the master switch and a switch per kind of message
    PUT  /api/mobile-app/messages/controls    {pushEnabled?, types: {key: bool}} change them
    GET  /api/mobile-app/messages/log         every notification sent: filters, pagination, what happened to the push
    GET  /api/mobile-app/messages/devices     which employees have a phone registered for notifications
    POST /api/mobile-app/messages/send        {employeeId, title, message} one message from HR to one employee
    POST /api/mobile-app/messages/log/<id>/push-again        push a failed / not-pushed notification again
    PUT  /api/mobile-app/messages/devices/<employee>/mute    {muted} mute / unmute one employee's phone notifications
    DELETE /api/mobile-app/messages/devices/phones/<id>      forget one registered phone
    GET  /api/mobile-app/messages/config      how delivery works and its health (failures by reason)

What a message is, and how it becomes a push, is in push_messages.py (the same text WhatsApp carries) and signals.py (the push
itself). The switches only control the PHONE push (mobile_messages.py): the in-app record is always saved.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.db.models import Count, Exists, Max, OuterRef, Q
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
from .models import Employee, MobileMessageSettings, Notification, PushOptOut, PushRecipient, PushToken
from .view_common import error_response as _error
from .view_common import paginate

PUSH_STATUSES = ("sent", "delivered", "no_device", "failed", "off")
STATUS_LABEL = {
    "sent": "Sent (waiting for the push service)",
    "delivered": "Delivered to the phone",
    "no_device": "No phone registered",
    "failed": "Push failed",
    "off": "Switched off for phones",
    "sending": "Sending to the phone",
    "": "Waiting to be pushed",
}
MAX_TITLE = 60
MAX_MESSAGE = 500
AUDIT_MODULE = "phone_notify_control"
AGAIN_STATUSES = ("failed", "no_device", "off")
REASON_LABELS = {
    "InvalidCredentials": "Firebase key missing or wrong",
    "DeviceNotRegistered": "App uninstalled / notifications reset",
    "MessageTooBig": "Message too large",
    "MessageRateExceeded": "Too many pushes to one phone",
    "MismatchSenderId": "Firebase project mismatch",
}


def _name(e: Employee) -> str:
    return f"{e.first_name} {e.last_name}".strip()


def _source_label(source: str, related_module: str) -> str:
    if source == mobile_messages.MANUAL:
        return "Message from HR"
    label = mobile_messages.kind_label(source)
    if label is None:
        return "In-app notice"
    if source in ("approval_approved", "approval_rejected") and related_module in catalog.APPROVAL_MODULES:
        return f"{label}: {catalog.APPROVAL_MODULES[related_module]}"
    return label


def _notifications(request: Request):
    # The log shows the employee's name and code only: never load the base64 photo (up to ~2 MB) with every row.
    return scope_to_branch(
        Notification.objects.select_related("employee").defer("employee__photo_url"),
        request,
        field="employee__branch_id",
    )


def _employees(request: Request):
    return scope_to_branch(Employee.objects.filter(status="active"), request, field="branch_id")


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    return today - timedelta(days=days_back)


@api_view(["GET"])
@require_hr
def mobile_messages_overview(request: Request) -> Response:
    push_receipts.check_pending()  # read Expo's receipts for what was sent a minute or more ago
    from . import push_recipients

    notes = _notifications(request)
    # the phone figures count the people who receive phone notifications (Phone Notify Control -> Settings), not everybody
    employees = push_recipients.narrow(_employees(request))
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

    failed_recent = [
        _log_row(n)
        for n in notes.filter(push_status="failed", created_at__gte=_day_start(6))
        .annotate(has_phone=Exists(PushToken.objects.filter(employee_id=OuterRef("employee_id"))))
        .order_by("-created_at", "-id")[:5]
    ]

    return Response(
        {
            # additive (2026-11-17): the dashboard's categories and the week's latest failed pushes
            "categories": _categories(month, settings),
            "failedRecent": failed_recent,
            # additive (2026-11-17): who receives phone notifications (Phone Notify Control -> Settings)
            "recipients": _recipients_line(request),
            "pushEnabled": settings.push_enabled,
            "switchedOff": len([k for k in (settings.disabled_types or []) if k in mobile_messages.valid_keys()]),
            "kinds": len(mobile_messages.valid_keys()),
            "muted": PushOptOut.objects.filter(employee_id__in=emp_ids).count(),
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


def _empty_counts() -> dict:
    return {"total": 0, "sent": 0, "delivered": 0, "failed": 0, "off": 0, "noDevice": 0}


def _add(c: dict, status: str, n: int) -> None:
    c["total"] += n
    if status in ("sent", "delivered"):
        c["sent"] += n
    if status == "delivered":
        c["delivered"] += n
    elif status == "failed":
        c["failed"] += n
    elif status == "off":
        c["off"] += n
    elif status == "no_device":
        c["noDevice"] += n


def _categories(month_qs, settings) -> list[dict]:
    """Every category with its switches (how many on), who receives it and its last 30 days, each notification counted in
    exactly one category."""
    off = set(settings.disabled_types or [])
    rows = mobile_messages.categorized_controls()
    counts = {key: _empty_counts() for key in mobile_messages.CATEGORIES}
    for source, related, status, n in month_qs.values_list("source", "related_module", "push_status").annotate(
        n=Count("id")
    ):
        _add(counts[mobile_messages.category_of_notification(source or "", related or "")], status or "", n)
    out = []
    for key, cat in mobile_messages.CATEGORIES.items():
        mine = [r for r in rows if r["category"] == key]
        out.append(
            {
                "key": key,
                "label": cat.label,
                "description": cat.description,
                "keys": [r["key"] for r in mine],
                "total": len(mine),
                "on": len([r for r in mine if r["key"] not in off]),
                "audience": sorted({r["audience"] for r in mine}),
                "month": counts[key],
            }
        )
    return out


def _recipients_line(request) -> dict | None:
    from .push_recipients_views import overview_summary

    try:
        return overview_summary(request)
    except Exception:  # the column before migration 0157: the page still opens
        return None


def _stats(request=None) -> tuple[dict, dict]:
    """The last 30 days' notifications by kind and by workflow: ({source: counts}, {workflow: counts})."""
    qs = _notifications(request) if request is not None else Notification.objects.all()
    rows = (
        qs.filter(created_at__gte=_day_start(29))
        .values("source", "related_module", "push_status")
        .annotate(n=Count("id"))
    )
    by_source: dict = {}
    by_module: dict = {}

    def add(table: dict, key: str, status: str, n: int) -> None:
        c = table.setdefault(key, {"total": 0, "sent": 0, "delivered": 0, "failed": 0, "off": 0, "noDevice": 0})
        c["total"] += n
        if status in ("sent", "delivered"):
            c["sent"] += n
        if status == "delivered":
            c["delivered"] += n
        elif status == "failed":
            c["failed"] += n
        elif status == "off":
            c["off"] += n
        elif status == "no_device":
            c["noDevice"] += n

    for r in rows:
        add(by_source, r["source"] or "", r["push_status"] or "", r["n"])
        if r["related_module"]:
            add(by_module, r["related_module"], r["push_status"] or "", r["n"])
    return by_source, by_module


EMPTY_STATS = {"total": 0, "sent": 0, "delivered": 0, "failed": 0, "off": 0, "noDevice": 0}


def _controls_body(request=None) -> dict:
    settings = MobileMessageSettings.get()
    off = set(settings.disabled_types or [])
    by_source, by_module = _stats(request)
    rows = []
    for row in mobile_messages.categorized_controls():
        if row["kind"] == "workflow":
            stats = by_module.get(row["key"][len(mobile_messages.APPROVAL_PREFIX) :], EMPTY_STATS)
        else:
            stats = by_source.get(row["key"], EMPTY_STATS)
        rows.append({**row, "enabled": row["key"] not in off, "stats": dict(stats)})
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
        return Response(_controls_body(request))

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
            AUDIT_MODULE,
            record_id=settings.pk,
            description="Phone notifications: " + ", ".join(changed),
        )
    return Response(_controls_body(request))


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
        "category": mobile_messages.category_of_notification(n.source or "", n.related_module or ""),
        "pushStatus": n.push_status or "",
        "pushStatusLabel": STATUS_LABEL.get(n.push_status or "", n.push_status),
        "pushError": n.push_error or None,
        "isRead": n.is_read,
        "createdAt": n.created_at.isoformat(),
        "pushedAt": n.pushed_at.isoformat() if n.pushed_at else None,
        # only when there is a phone to push to now (the log's query says so; a single row asks)
        "canPushAgain": (n.push_status or "") in AGAIN_STATUSES
        and (n.has_phone if hasattr(n, "has_phone") else PushToken.objects.filter(employee_id=n.employee_id).exists()),
    }


@api_view(["GET"])
@require_hr
def mobile_messages_log(request: Request) -> Response:
    """Newest first. Filters: search (name / code / text), status (a push status), kind (a catalogue key, "manual" or
    "older"), read (read | unread), dateFrom / dateTo (YYYY-MM-DD, Indian time). Without `page` it is a capped array."""
    push_receipts.check_pending()
    q = request.query_params
    qs = (
        _notifications(request)
        .annotate(has_phone=Exists(PushToken.objects.filter(employee_id=OuterRef("employee_id"))))
        .order_by("-created_at", "-id")
    )
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
    if q.get("muted") in ("1", "true"):
        qs = qs.filter(push_opt_out__isnull=False)
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(employee_code__icontains=search)
            | Q(phone__icontains=search)
        )

    qs = qs.defer("photo_url").select_related("push_opt_out")
    # additive (2026-11-17): is this employee a phone notification recipient (Phone Notify Control -> Settings)?
    from . import push_recipients

    current = push_recipients.mode()
    if current == push_recipients.SELECTED:
        qs = qs.annotate(is_selected=Exists(PushRecipient.objects.filter(employee_id=OuterRef("pk"))))

    def row(e: Employee) -> dict:
        if current == push_recipients.SELECTED:
            receives = bool(getattr(e, "is_selected", False))
        else:
            receives = current == push_recipients.ALL or e.employment_type == current
        return {**_device_row(e), "isRecipient": receives}

    return paginate(request, qs, row)


def _device_row(e: Employee) -> dict:
    mute = getattr(e, "push_opt_out", None)
    devices = getattr(e, "devices", None)
    registered = getattr(e, "registered", None)
    phones = [
        {
            "id": t.id,
            "platform": t.platform,
            "registeredAt": t.created_at.isoformat() if t.created_at else None,
            "updatedAt": t.updated_at.isoformat() if t.updated_at else None,
        }
        for t in e.push_tokens.all().order_by("-updated_at")
    ]
    return {
        "id": e.id,
        "name": _name(e),
        "employeeCode": e.employee_code,
        "employmentType": e.employment_type,
        "phone": (e.phone or "").strip() or None,
        "devices": devices if devices is not None else len(phones),
        "lastRegisteredAt": (registered.isoformat() if registered else (phones[0]["updatedAt"] if phones else None)),
        "muted": mute is not None,
        "mutedBy": (mute.muted_by or None) if mute is not None else None,
        "mutedAt": mute.created_at.isoformat() if mute is not None and mute.created_at else None,
        "phones": phones,
    }


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
    from . import push_delivery

    n = Notification.objects.create(
        employee=emp, type="general", title=title, message=message, source=mobile_messages.MANUAL
    )
    # HR is waiting for the answer: push it now, in this request (the queued push then finds it done and skips it)
    push_delivery.push([n.pk])
    n.refresh_from_db()
    log_action(
        request,
        "create",
        AUDIT_MODULE,
        record_id=n.pk,
        description=f"Sent a message to {_name(emp)} ({emp.employee_code}): {title}",
    )
    return Response(_log_row(n), status=201)


@api_view(["POST"])
@require_hr
def mobile_messages_push_again(request: Request, pk: int) -> Response:
    """Push one notification to its employee's phones again (it failed, found no phone, or was switched off then)."""
    from . import push_delivery

    n = _notifications(request).filter(pk=pk).first()
    if n is None:
        return _error("Notification not found", 404)
    if (n.push_status or "") not in AGAIN_STATUSES:
        return _error("Only a notification that failed, found no phone or was switched off can be pushed again.")
    off = mobile_messages.off_reason(n.source, n.related_module, n.employee_id)
    if off:
        return _error(off)
    if not PushToken.objects.filter(employee_id=n.employee_id).exists():
        return _error("This employee has no phone registered for notifications: they need to open the app once.")
    push_delivery.push_again(n.pk)
    n.refresh_from_db()
    log_action(
        request,
        "update",
        AUDIT_MODULE,
        record_id=n.pk,
        description=f"Pushed again to {_name(n.employee)} ({n.employee.employee_code}): {n.title or n.message[:60]}",
    )
    return Response(_log_row(n))


@api_view(["PUT"])
@require_hr
def mobile_messages_mute(request: Request, employee_id: int) -> Response:
    """Mute (or unmute) every phone notification of one employee. Their in-app Notifications list still fills."""
    emp = _employees(request).filter(pk=employee_id).first()
    if emp is None:
        return _error("Choose an active employee", 404)
    muted = request.data.get("muted")
    if not isinstance(muted, bool):
        return _error("muted must be true or false")
    if muted:
        PushOptOut.objects.get_or_create(employee=emp, defaults={"muted_by": get_hr_display_name(request)})
    else:
        PushOptOut.objects.filter(employee=emp).delete()
    log_action(
        request,
        "update",
        AUDIT_MODULE,
        record_id=emp.pk,
        description=f"Phone notifications {'muted' if muted else 'unmuted'} for {_name(emp)} ({emp.employee_code})",
    )
    emp = (
        _employees(request)
        .annotate(devices=Count("push_tokens"), registered=Max("push_tokens__updated_at"))
        .select_related("push_opt_out")
        .defer("photo_url")
        .get(pk=emp.pk)
    )
    return Response(_device_row(emp))


@api_view(["DELETE"])
@require_hr
def mobile_messages_remove_phone(request: Request, token_id: int) -> Response:
    """Forget one registered phone (it registers again the next time the app is opened on it)."""
    token = PushToken.objects.select_related("employee").filter(pk=token_id).first()
    if token is None or not _employees(request).filter(pk=token.employee_id).exists():
        return _error("Phone not found", 404)
    emp = token.employee
    token.delete()
    log_action(
        request,
        "delete",
        AUDIT_MODULE,
        record_id=token_id,
        description=f"Removed a registered phone of {_name(emp)} ({emp.employee_code})",
    )
    return Response(status=204)


@api_view(["GET"])
@require_hr
def mobile_messages_config(request: Request) -> Response:
    """How a phone notification travels, and how well it has been doing (the last 30 days; failures by reason)."""
    from .signals import EXPO_PUSH_URL

    push_receipts.check_pending()
    notes = _notifications(request)
    since = _day_start(29)
    month = notes.filter(created_at__gte=since)
    counts = dict(month.values_list("push_status").annotate(n=Count("id")))
    sent = counts.get("sent", 0) + counts.get("delivered", 0)
    delivered = counts.get("delivered", 0)
    failed = counts.get("failed", 0)
    reasons: dict = {}
    for error, n in month.filter(push_status="failed").values_list("push_error").annotate(n=Count("id")):
        code = (error or "").split(":", 1)[0].strip()
        if code not in push_receipts.HINTS:
            code = "Other"
        row = reasons.setdefault(
            code,
            {
                "reason": code,
                "label": REASON_LABELS.get(code, "Other failures"),
                "count": 0,
                "advice": push_receipts.HINTS.get(code, (error or "")[:200]),
            },
        )
        row["count"] += n
    last_sent = notes.filter(push_status__in=("sent", "delivered")).aggregate(m=Max("pushed_at"))["m"]
    last_delivered = notes.filter(push_status="delivered").aggregate(m=Max("pushed_at"))["m"]
    settings = MobileMessageSettings.get()
    emp_ids = list(_employees(request).values_list("id", flat=True))
    tokens = PushToken.objects.filter(employee_id__in=emp_ids)
    with_phone = tokens.values("employee_id").distinct().count()
    last_registered = tokens.aggregate(m=Max("updated_at"))["m"]
    if "InvalidCredentials" in reasons or "MismatchSenderId" in reasons:
        state, note = "problem", "Google refused pushes: the app's Firebase key is missing or wrong (see the reasons)."
    elif not settings.push_enabled:
        state, note = "warning", "Phone notifications are switched off for everyone (Controls)."
    elif sent == 0 and failed == 0:
        state, note = "unknown", "Nothing was pushed in the last 30 days, so there is nothing to judge yet."
    elif failed and failed >= sent:
        state, note = "warning", "More pushes failed than went through in the last 30 days (see the reasons)."
    else:
        state, note = "ok", "Pushes are reaching phones."
    return Response(
        {
            "service": {
                "provider": "Expo push service",
                "transport": "Firebase Cloud Messaging (Android)",
                "url": EXPO_PUSH_URL,
                "androidChannel": "default",
                "appPackage": "net.uktex.employee",
            },
            "health": {
                "state": state,
                "note": note,
                "lastSentAt": last_sent.isoformat() if last_sent else None,
                "lastDeliveredAt": last_delivered.isoformat() if last_delivered else None,
                "sent30": sent,
                "delivered30": delivered,
                "failed30": failed,
                "failureReasons": sorted(reasons.values(), key=lambda r: -r["count"]),
            },
            "phones": {
                "employeesWithPhone": with_phone,
                "tokens": tokens.count(),
                "lastRegisteredAt": last_registered.isoformat() if last_registered else None,
            },
            "pushEnabled": settings.push_enabled,
        }
    )
