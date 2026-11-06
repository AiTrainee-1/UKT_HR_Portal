"""
WhatsApp Control page (HR portal -> WhatsApp Control): one place to monitor and
manage every WhatsApp feature. All endpoints are HR-only and sit under the
`whatsapp_control` permission module (see permission_registry.URL_MODULE_MAP).

    GET  /api/whatsapp-control/overview                    totals, today / this month, per-module and per-day counts, config
    GET  /api/whatsapp-control/messages                    message history (filters + pagination)
    GET  /api/whatsapp-control/employees                   employee-wise message counts + opt-out
    PATCH /api/whatsapp-control/employees/<id>/opt-out     opt an employee out of (or back into) WhatsApp messages
    GET  /api/whatsapp-control/settings                    master switch, feature / per-type switches, timings, queue limits,
                                                           quiet hours, read-only configuration
    PUT  /api/whatsapp-control/settings                    change any of those
    GET  /api/whatsapp-control/queue                       the send queue right now (whatsapp_dispatcher.queue_status)
    POST /api/whatsapp-control/queue/clear                 every queued message -> skipped ("Cleared by HR")
    GET  /api/whatsapp-control/templates                   every message type: wording, variables, switch, usage
    PUT  /api/whatsapp-control/templates/<type>            change wording / per-type switch
    POST /api/whatsapp-control/templates/<type>/preview    render wording with sample values

What the message types, modules and variables are comes from whatsapp_catalog.py, so a new
notification appears here without touching this file. Credentials stay in .env and are never
returned or editable here.
"""

import re
from datetime import datetime, time as time_type, timedelta

from django.conf import settings as dj_settings
from django.db.models import Count, Exists, F, Max, OuterRef, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_catalog as catalog, whatsapp_dispatcher, whatsapp_service
from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ
from .models import Employee, HRUser, WhatsAppMessageLog, WhatsAppMessageTemplate, WhatsAppOptOut, WhatsAppSettings
from .view_common import error_response as _error, paginate

TYPE_LABELS = {key: t.label for key, t in catalog.TYPES.items()}
STATUSES = list(WhatsAppMessageLog.STATUSES)
CATEGORY_OF = {key: t.module for key, t in catalog.TYPES.items()}
CATEGORIES = catalog.categories()

# Which workflow a message was raised by, beyond its module ("leave", "on_duty", ...).
RELATED_LABELS = {**catalog.APPROVAL_MODULES, "on_duty": "On-Duty request", "on_duty_punch": "On-Duty punch"}

# The groups the Feature Controls tab shows, in order.
GROUPS = [
    ("signin", "Employee sign-in", "How employees get into the mobile app and the Employee Web App."),
    ("documents", "Documents", "Salary slips, ID cards and letters HR sends from the Documents pages."),
    (
        "attendance",
        "Attendance alerts (automatic)",
        "Checked every minute against each staff member's own shift. Nobody is messaged on Sundays, holidays, approved leave, "
        "or when HR has already set their day. Each alert is sent once per employee per day.",
    ),
    (
        "approvals",
        "Approval notifications (automatic)",
        "The employee is told as soon as their request is approved or rejected, with the approver and reason. "
        "Switch off one workflow without touching the others.",
    ),
    ("geo", "Geo Attendance", "Approval and rejection messages for On-Duty requests and their punches."),
    ("visitors", "Visitors", "Tells an employee who is at reception to meet them, with a tap-to-call contact card."),
    ("outpass", "Outpass & gate", "Confirms to the employee each time the gate records them going out or coming back."),
]

# Editable feature switches (WhatsAppSettings booleans): json key, model field, label, group, description.
FEATURES = [
    (
        "otpLoginEnabled",
        "otp_login_enabled",
        "OTP login",
        "signin",
        "Employees sign in to the apps with a code sent on WhatsApp.",
    ),
    (
        "otpResetEnabled",
        "otp_reset_enabled",
        "OTP password reset",
        "signin",
        "Forgot-password and reset use a WhatsApp code.",
    ),
    (
        "otpActivateEnabled",
        "otp_activate_enabled",
        "OTP new-account activation",
        "signin",
        "A new employee confirms a WhatsApp code before choosing their first password.",
    ),
    (
        "passwordLoginEnabled",
        "password_login_enabled",
        "Password login",
        "signin",
        "Keep Employee Code + password sign-in available. Turned off only takes effect while WhatsApp OTP is working.",
    ),
    (
        "documentNotificationsEnabled",
        "document_notifications_enabled",
        "Document notifications",
        "documents",
        "Salary slips, ID cards, offer / experience / resignation letters and other documents sent on WhatsApp.",
    ),
    (
        "attendanceAlertsEnabled",
        "attendance_alerts_enabled",
        "Attendance alerts (all)",
        "attendance",
        "Master switch for the four alerts below. Each one still has to be on too.",
    ),
    (
        "absentAlertEnabled",
        "absent_alert_enabled",
        "Absent alert",
        "attendance",
        "Message an employee marked Absent: no punch within the permitted time after their shift started.",
    ),
    (
        "lateAlertEnabled",
        "late_alert_enabled",
        "Late attendance alert",
        "attendance",
        "Message an employee whose first punch came after start + grace, with how late they were.",
    ),
    (
        "fourPunchAlertEnabled",
        "four_punch_alert_enabled",
        "Punch reminder (4 punches)",
        "attendance",
        "A friendly reminder for each of the day's punches that is still missing. Also reminds employees on On-Duty to make their Geo Punch.",
    ),
    (
        "missingPunchAlertEnabled",
        "missing_punch_alert_enabled",
        "Missing punch alert",
        "attendance",
        "After the shift ends, message an employee whose day still has missing punches.",
    ),
    (
        "approvalNotificationsEnabled",
        "approval_notifications_enabled",
        "Approval notifications (all)",
        "approvals",
        "Master switch: Approved / Rejected messages for every workflow below.",
    ),
    (
        "geoApprovalEnabled",
        "geo_approval_enabled",
        "Geo Attendance approval & rejection",
        "geo",
        "Tell the employee when their Geo Attendance request, or one of its punches, is approved or rejected.",
    ),
    (
        "visitorNotificationEnabled",
        "visitor_notification_enabled",
        "Visitor notification",
        "visitors",
        "Message the employee a visitor came to meet, with the visitor's details and contact card.",
    ),
    (
        "outpassNotificationsEnabled",
        "outpass_notifications_enabled",
        "Outpass gate IN / OUT",
        "outpass",
        "Message the employee when the gate records them going out or coming back.",
    ),
]
FEATURE_COLUMNS = {key: field for key, field, *_ in FEATURES}
# Kept for older imports.
FEATURE_SWITCHES = [(key, field, label, desc) for key, field, label, _group, desc in FEATURES]

# One switch per message type that has no switch of its own above (or shares one with another type): stored as the list
# of types HR has switched OFF (WhatsAppSettings.disabled_message_types). Key "type:<document_type>", group = its module.
TYPE_SWITCH_PREFIX = "type:"
TYPE_SWITCHES = {f"{TYPE_SWITCH_PREFIX}{key}": key for key in catalog.individually_switched()}

# The send queue's pacing (whatsapp_dispatcher.py): json key, model field, label, (min, max), unit.
QUEUE_LIMITS = [
    ("minGapSeconds", "min_gap_seconds", "Pause between two messages", (5, 600), "seconds"),
    ("maxPerHour", "max_per_hour", "Most messages in any hour", (1, 1000), "messages"),
    ("maxPerDay", "max_per_day", "Most messages in a day", (1, 5000), "messages"),
    (
        "maxPerEmployeePerDay",
        "max_per_employee_per_day",
        "Most automatic messages to one employee in a day",
        (1, 20),
        "messages",
    ),
]


def _camel(module: str) -> str:
    head, *rest = module.split("_")
    return head + "".join(p.title() for p in rest)


# One switch per approval workflow, stored as the list of workflows HR has switched OFF.
APPROVAL_MODULE_KEYS = {f"approval{_camel(m)[0].upper()}{_camel(m)[1:]}Enabled": m for m in catalog.APPROVAL_MODULES}

# Numeric timing settings: json key, model field, label, (min, max).
TIMINGS = [
    ("otpExpiryMinutes", "otp_expiry_minutes", "OTP expiry (minutes)", (1, 30)),
    (
        "absentExtraMinutes",
        "absent_extra_minutes",
        "Extra wait before an Absent alert (minutes)",
        (0, 240),
    ),
    (
        "fourPunchLeadMinutes",
        "four_punch_lead_minutes",
        "Send a punch reminder this long before the punch is due (minutes)",
        (1, 60),
    ),
    (
        "missingPunchAfterMinutes",
        "missing_punch_after_minutes",
        "Send a Missing Punch alert this long after the punch was due (minutes)",
        (0, 240),
    ),
]


def _messages_qs(request: Request):
    return scope_to_branch(
        WhatsAppMessageLog.objects.select_related("employee", "sent_by"), request, field="employee__branch_id"
    )


def _status_counts(qs) -> dict:
    rows = qs.values("status").annotate(n=Count("id"))
    counts = {s: 0 for s in STATUSES}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + row["n"]
    counts["total"] = sum(counts.values())
    # "delivered to WhatsApp" = accepted by the provider and not failed/pending.
    counts["accepted"] = counts["sent"] + counts["delivered"] + counts["read"]
    return counts


def _message_json(m: WhatsAppMessageLog) -> dict:
    emp = m.employee
    module = CATEGORY_OF.get(m.document_type, "other")
    related = RELATED_LABELS.get(m.related_module, "")
    return {
        "id": m.id,
        "employeeId": m.employee_id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}".strip(),
        "phone": m.phone_number,
        "documentType": m.document_type,
        "typeLabel": TYPE_LABELS.get(m.document_type, m.document_type),
        "category": module,
        "categoryLabel": catalog.MODULES.get(module, module),
        # The HRMS workflow behind it ("Approvals - Leave"), for the "Related module" column.
        "relatedModule": m.related_module,
        "relatedLabel": f"{catalog.MODULES.get(module, module)} - {related}"
        if related
        else catalog.MODULES.get(module, module),
        "status": m.status,
        "error": m.error_message,
        "messageText": m.message_text,
        "providerMessageId": m.provider_message_id,
        "referenceId": m.document_ref_id,
        "sentBy": (m.sent_by.full_name or m.sent_by.username) if m.sent_by else None,
        "automatic": bool(m.dedupe_key) or m.document_type in CATEGORIES.get("otp", ()),
        # the send queue: code | requested | automatic | document (rows from before the queue: the catalog's kind)
        "kind": m.kind or catalog.kind_of(m.document_type),
        "sentAt": m.sent_at.isoformat() if m.sent_at else None,
        "expiresAt": m.expires_at.isoformat() if m.expires_at else None,
        "attempts": m.attempts,
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        "updatedAt": m.updated_at.isoformat() if m.updated_at else None,
    }


def _config(request: Request) -> dict:
    base = whatsapp_service._backend_public_base_url(request)
    instance = dj_settings.WACLIENT_INSTANCE_ID
    s = WhatsAppSettings.get()
    return {
        "provider": "WAClient (WhatsApp Web API)",
        "configured": whatsapp_service.is_configured(),
        # Why nothing can be sent from this server (no credentials, or a development machine), else null.
        "sendingBlockedReason": whatsapp_service.sending_block_reason(),
        "instanceId": f"…{instance[-4:]}" if instance else None,
        "apiUrl": dj_settings.WACLIENT_API_URL,
        "defaultCountryCode": dj_settings.WHATSAPP_DEFAULT_COUNTRY_CODE,
        # The pause between two messages: since the 2026-11-06 send queue that is its minimum gap (Feature Controls).
        "sendDelaySeconds": s.min_gap_seconds,
        "publicBaseUrl": base,
        "webhookUrl": f"{base}/api/whatsapp/webhook/",
        "webhookTokenSet": bool(dj_settings.WHATSAPP_WEBHOOK_TOKEN),
        "backgroundSending": bool(dj_settings.WHATSAPP_ASYNC_SEND),
        "engineEnabled": bool(s.engine_enabled),
    }


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date() - timedelta(days=days_back)
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


@api_view(["GET"])
@require_hr
def whatsapp_overview(request: Request) -> Response:
    """Totals and breakdowns over the last `days` days (default 30), plus today's and this month's
    counts whatever the range."""
    try:
        days = max(1, min(365, int(request.query_params.get("days", 30))))
    except ValueError:
        return _error("days must be a number")
    since = timezone.now() - timedelta(days=days)
    everything = _messages_qs(request)
    qs = everything.filter(created_at__gte=since)

    by_category = {}
    for category, types in CATEGORIES.items():
        by_category[category] = _status_counts(qs.filter(document_type__in=types))

    by_type = [
        {
            "documentType": row["document_type"],
            "label": TYPE_LABELS.get(row["document_type"], row["document_type"]),
            "category": CATEGORY_OF.get(row["document_type"], "other"),
            "total": row["total"],
            "failed": row["failed"],
        }
        for row in qs.values("document_type")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")))
        .order_by("-total")
    ]

    daily_rows = (
        qs.annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")))
        .order_by("day")
    )
    daily = [{"date": r["day"].isoformat(), "total": r["total"], "failed": r["failed"]} for r in daily_rows]

    failures = [_message_json(m) for m in qs.filter(status="failed")[:8]]
    cutoff = timezone.now() - timedelta(minutes=10)
    stale = qs.filter(Q(status="pending", created_at__lt=cutoff) | Q(status="sending", updated_at__lt=cutoff)).count()
    today_start = _day_start()
    month_start = today_start.replace(day=1)
    return Response(
        {
            "days": days,
            "config": _config(request),
            "totals": _status_counts(qs),
            "today": _status_counts(everything.filter(created_at__gte=today_start)),
            "thisMonth": _status_counts(everything.filter(created_at__gte=month_start)),
            "categories": [{"key": key, "label": catalog.MODULES[key]} for key in CATEGORIES],
            "relatedModules": [{"key": key, "label": label} for key, label in RELATED_LABELS.items()],
            "byCategory": by_category,
            "byType": by_type,
            "daily": daily,
            "recentFailures": failures,
            "stalePending": stale,
        }
    )


@api_view(["GET"])
@require_hr
def whatsapp_messages(request: Request) -> Response:
    """Message history, newest first. Filters: status, category (module), type, related (the
    workflow, e.g. leave), employeeId, search (name / code / phone), dateFrom, dateTo (YYYY-MM-DD,
    IST). Without `page` this is a bare array capped like every other list endpoint."""
    q = request.query_params
    qs = _messages_qs(request).order_by("-created_at", "-id")
    if status := q.get("status"):
        if status not in STATUSES:
            return _error(f"status must be one of: {', '.join(STATUSES)}")
        qs = qs.filter(status=status)
    if category := q.get("category"):
        if category not in CATEGORIES:
            return _error(f"category must be one of: {', '.join(CATEGORIES)}")
        qs = qs.filter(document_type__in=CATEGORIES[category])
    if doc_type := q.get("type"):
        qs = qs.filter(document_type=doc_type)
    if related := q.get("related"):
        qs = qs.filter(related_module=related)
    if emp_id := q.get("employeeId"):
        try:
            qs = qs.filter(employee_id=int(emp_id))
        except ValueError:
            return _error("employeeId must be a number")
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(employee__first_name__icontains=search)
            | Q(employee__last_name__icontains=search)
            | Q(employee__employee_code__icontains=search)
            | Q(phone_number__icontains=search)
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
    return paginate(request, qs, _message_json)


def _employees_qs(request: Request):
    """Employees with their WhatsApp counts and opt-out (the photo, base64 and up to MBs, never loaded)."""
    return (
        scope_to_branch(Employee.objects, request)
        .annotate(
            total=Count("whatsapp_messages"),
            failed=Count("whatsapp_messages", filter=Q(whatsapp_messages__status="failed")),
            last_at=Max("whatsapp_messages__created_at"),
        )
        .select_related("department", "whatsapp_opt_out")
        .defer("photo_url")
    )


def _employee_json(e) -> dict:
    opt_out = getattr(e, "whatsapp_opt_out", None)
    return {
        "employeeId": e.id,
        "employeeCode": e.employee_code,
        "employeeName": f"{e.first_name} {e.last_name}".strip(),
        "phone": whatsapp_service.normalize_phone(e.phone) or "",
        "department": e.department.name if e.department_id else None,
        "total": e.total,
        "failed": e.failed,
        "lastMessageAt": e.last_at.isoformat() if e.last_at else None,
        # Opted out: no WhatsApp notifications or documents (a code the employee asks for still goes).
        "optOut": opt_out is not None,
        "optOutReason": opt_out.reason if opt_out else "",
        "optOutAt": opt_out.created_at.isoformat() if opt_out and opt_out.created_at else None,
        "optOutBy": opt_out.created_by if opt_out else "",
    }


@api_view(["GET"])
@require_hr
def whatsapp_employees(request: Request) -> Response:
    """Employee-wise view: who has been messaged, how many, how many failed, and who opted out. Lists the employees
    with at least one message or an opt-out; `all=1` lists every employee (to find someone to opt out), `optOut=true`
    only the opted-out ones. `search` matches name or code."""
    q = request.query_params
    qs = _employees_qs(request)
    if q.get("all") not in ("1", "true"):
        has_messages = Exists(WhatsAppMessageLog.objects.filter(employee_id=OuterRef("pk")))
        has_opt_out = Exists(WhatsAppOptOut.objects.filter(employee_id=OuterRef("pk")))
        qs = qs.filter(Q(has_messages) | Q(has_opt_out))
    if q.get("optOut") in ("1", "true"):
        qs = qs.filter(whatsapp_opt_out__isnull=False)
    elif q.get("optOut") in ("0", "false"):
        qs = qs.filter(whatsapp_opt_out__isnull=True)
    if search := (q.get("search") or "").strip():
        qs = qs.filter(
            Q(first_name__icontains=search) | Q(last_name__icontains=search) | Q(employee_code__icontains=search)
        )
    qs = qs.order_by(F("last_at").desc(nulls_last=True), "id")
    return paginate(request, qs, _employee_json)


@api_view(["PATCH"])
@require_hr
def whatsapp_employee_opt_out(request: Request, employee_id: int) -> Response:
    """{optOut: boolean, reason?: string}: opt the employee out of WhatsApp notifications and documents (a code they ask
    for themselves still goes), or back in. Answers with the employee's row as the list shows it."""
    data = request.data if isinstance(request.data, dict) else {}
    if not isinstance(data.get("optOut"), bool):
        return _error("optOut must be true or false")
    reason = data.get("reason", "")
    if reason is None:
        reason = ""
    if not isinstance(reason, str) or len(reason) > 500 or "\x00" in reason:
        return _error("reason must be text of at most 500 characters")
    if not scope_to_branch(Employee.objects, request).filter(pk=employee_id).exists():
        return _error("Employee not found", 404)
    if data["optOut"]:
        user = HRUser.objects.filter(pk=request.jwt_user.get("hrUserId")).first()
        WhatsAppOptOut.objects.update_or_create(
            employee_id=employee_id,
            defaults={"reason": reason.strip(), "created_by": (user.full_name or user.username) if user else ""},
        )
    else:
        WhatsAppOptOut.objects.filter(employee_id=employee_id).delete()
    return Response(_employee_json(_employees_qs(request).get(pk=employee_id)))


def _settings_json(request: Request, s: WhatsAppSettings) -> dict:
    disabled = set(s.disabled_approval_modules or [])
    features = [
        {"key": key, "label": label, "description": desc, "group": group, "enabled": bool(getattr(s, field))}
        for key, field, label, group, desc in FEATURES
    ]
    features += [
        {
            "key": key,
            "label": f"{catalog.APPROVAL_MODULES[module]} approval / rejection",
            "description": (
                "Tell the employee when another kind of request (salary enquiry, shift correction, ...) is approved or rejected."
                if module == "request"
                else f"Tell the employee when their {catalog.APPROVAL_MODULES[module].lower()} request is approved or rejected."
            ),
            "group": "approvals",
            "enabled": module not in disabled,
        }
        for key, module in APPROVAL_MODULE_KEYS.items()
    ]
    off_types = set(s.disabled_message_types or [])
    features += [
        {
            "key": key,
            "label": catalog.TYPES[doc_type].label,
            "description": catalog.TYPES[doc_type].description,
            "group": catalog.TYPES[doc_type].module,
            "enabled": doc_type not in off_types,
        }
        for key, doc_type in TYPE_SWITCHES.items()
    ]
    return {
        "engineEnabled": bool(s.engine_enabled),
        "groups": [{"key": key, "title": title, "blurb": blurb} for key, title, blurb in GROUPS],
        "features": features,
        "timings": [
            {"key": key, "label": label, "value": getattr(s, field), "min": lo, "max": hi}
            for key, field, label, (lo, hi) in TIMINGS
        ],
        "queueLimits": [
            {"key": key, "label": label, "value": getattr(s, field), "min": lo, "max": hi, "unit": unit}
            for key, field, label, (lo, hi), unit in QUEUE_LIMITS
        ],
        "quietHours": {
            "enabled": bool(s.quiet_hours_enabled),
            "start": s.quiet_start.strftime("%H:%M"),
            "end": s.quiet_end.strftime("%H:%M"),
        },
        "config": _config(request),
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


_HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


def _parse_hhmm(value) -> time_type | None:
    m = _HHMM.match(value) if isinstance(value, str) else None
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return time_type(int(m.group(1)), int(m.group(2)))


def _whole_number(value) -> int | None:
    """An integer from JSON (a number or digits as text), else None. A boolean is not a number here."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value.strip())
    return None


@api_view(["GET", "PUT"])
@require_hr
def whatsapp_control_settings(request: Request) -> Response:
    s = WhatsAppSettings.get()
    if request.method == "GET":
        return Response(_settings_json(request, s))

    data = request.data if isinstance(request.data, dict) else {}
    updates = {}
    if "engineEnabled" in data:
        if not isinstance(data["engineEnabled"], bool):
            return _error("engineEnabled must be true or false")
        updates["engine_enabled"] = data["engineEnabled"]
    for key in data:
        if isinstance(key, str) and key.startswith(TYPE_SWITCH_PREFIX) and key not in TYPE_SWITCHES:
            return _error(f"Unknown message type switch: {key}")
    off_types = set(s.disabled_message_types or [])
    for key, doc_type in TYPE_SWITCHES.items():
        if key in data:
            if not isinstance(data[key], bool):
                return _error(f"{key} must be true or false")
            if data[key]:
                off_types.discard(doc_type)
            else:
                off_types.add(doc_type)
    if off_types != set(s.disabled_message_types or []):
        updates["disabled_message_types"] = sorted(off_types)
    for key, field, label, (lo, hi), unit in QUEUE_LIMITS:
        if key in data:
            value = _whole_number(data[key])
            if value is None:
                return _error(f"{label} ({key}) must be a whole number of {unit}")
            if not lo <= value <= hi:
                return _error(f"{label} ({key}) must be between {lo} and {hi} {unit}")
            updates[field] = value
    if "quietHours" in data:
        quiet = data["quietHours"]
        if not isinstance(quiet, dict):
            return _error("quietHours must be an object: {enabled, start, end}")
        if "enabled" in quiet:
            if not isinstance(quiet["enabled"], bool):
                return _error("quietHours.enabled must be true or false")
            updates["quiet_hours_enabled"] = quiet["enabled"]
        for part, field in (("start", "quiet_start"), ("end", "quiet_end")):
            if part in quiet:
                parsed = _parse_hhmm(quiet[part])
                if parsed is None:
                    return _error(f"quietHours.{part} must be a time as HH:MM (00:00 to 23:59)")
                updates[field] = parsed
    for key, field, _label, _group, _desc in FEATURES:
        if key in data:
            if not isinstance(data[key], bool):
                return _error(f"{key} must be true or false")
            updates[field] = data[key]
    disabled = set(s.disabled_approval_modules or [])
    for key, module in APPROVAL_MODULE_KEYS.items():
        if key in data:
            if not isinstance(data[key], bool):
                return _error(f"{key} must be true or false")
            if data[key]:
                disabled.discard(module)
            else:
                disabled.add(module)
    if disabled != set(s.disabled_approval_modules or []):
        updates["disabled_approval_modules"] = sorted(disabled)
    for key, field, label, (lo, hi) in TIMINGS:
        if key in data:
            try:
                value = int(data[key])
            except (TypeError, ValueError):
                return _error(f"{label} must be a whole number")
            if not lo <= value <= hi:
                return _error(f"{label} must be between {lo} and {hi}")
            updates[field] = value
    for field, value in updates.items():
        setattr(s, field, value)
    if updates:
        s.save()
    return Response(_settings_json(request, s))


@api_view(["GET"])
@require_hr
def whatsapp_queue(request: Request) -> Response:
    """The send queue right now: master switch, circuit breaker, quiet hours, what is waiting, what went today, when the
    next message may leave, and the limits."""
    return Response(whatsapp_dispatcher.queue_status())


@api_view(["POST"])
@require_hr
def whatsapp_queue_clear(request: Request) -> Response:
    """Drop everything waiting in the queue: each queued message becomes skipped ("Cleared by HR"), never sent."""
    return Response({"cleared": whatsapp_dispatcher.clear_queue()})


def _template_row(
    document_type: str, t: WhatsAppMessageTemplate | None, usage: dict, settings: WhatsAppSettings
) -> dict:
    spec = catalog.get(document_type)
    stats = usage.get(document_type, {})
    switch_column = spec.switch if spec else None
    master_column = catalog.MODULE_SWITCHES.get(spec.module) if spec else None
    wording = (t.message_body if t else "") or ""
    module = spec.module if spec else "other"
    return {
        "documentType": document_type,
        "label": TYPE_LABELS.get(document_type, document_type),
        "description": spec.description if spec else "",
        "category": module,
        "categoryLabel": catalog.MODULES.get(module, module),
        "hasWording": spec.has_wording if spec else True,
        "messageBody": wording,
        "defaultMessage": catalog.TYPES[document_type].body if spec else "",
        "placeholders": catalog.variable_help(document_type),
        "variables": [{"name": v.name, "help": v.help, "sample": v.sample} for v in spec.variables] if spec else [],
        "preview": whatsapp_service.render_message(
            wording.strip() or (spec.body if spec else ""),
            catalog.sample_params(document_type),
            spec.variable_names if spec else [],
        ),
        "isEnabled": t.is_enabled if t else True,
        # The switch for this message (Feature Controls), if it has one, and the one for its whole module.
        # (False also when the type is switched off on its own: its `type:<key>` switch on Feature Controls)
        "featureEnabled": False
        if document_type in (settings.disabled_message_types or [])
        else (bool(getattr(settings, switch_column)) if switch_column else None),
        "moduleEnabled": bool(getattr(settings, master_column)) if master_column else None,
        "customised": bool(t and t.message_body.strip()),
        "updatedAt": t.updated_at.isoformat() if t and t.updated_at else None,
        "total": stats.get("total", 0),
        "failed": stats.get("failed", 0),
        "lastSentAt": stats["last"].isoformat() if stats.get("last") else None,
    }


@api_view(["GET"])
@require_hr
def whatsapp_control_templates(request: Request) -> Response:
    existing = {t.document_type: t for t in WhatsAppMessageTemplate.objects.all()}
    usage = {
        row["document_type"]: row
        for row in _messages_qs(request)
        .values("document_type")
        .annotate(total=Count("id"), failed=Count("id", filter=Q(status="failed")), last=Max("created_at"))
    }
    s = WhatsAppSettings.get()
    return Response([_template_row(key, existing.get(key), usage, s) for key in catalog.TYPES])


_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\}\}")


def _bad_placeholders(document_type: str, body: str) -> list[str]:
    """Placeholders in `body` this message type doesn't know (a typo would otherwise send blank)."""
    spec = catalog.get(document_type)
    if spec is None:
        return []
    names = set(spec.variable_names)
    count = len(names)
    bad = []
    for token in _PLACEHOLDER.findall(body):
        if token.isdigit():
            ok = 1 <= int(token) <= count
        else:
            ok = token in names
        if not ok and token not in bad:
            bad.append(token)
    return bad


def _wording_error(document_type: str, body: str) -> str | None:
    spec = catalog.get(document_type)
    if spec is None or not body:
        return None
    # A one-time code that isn't in the message would be a message nobody can log in with.
    if spec.must_contain_code and "{{1}}" not in body and "{{code}}" not in body:
        return "The message must include {{code}} (or {{1}}), where the code goes."
    bad = _bad_placeholders(document_type, body)
    if bad:
        shown = ", ".join("{{" + b + "}}" for b in bad)
        return f"Unknown placeholder {shown}. You can use: {catalog.variable_help(document_type)}"
    return None


@api_view(["PUT"])
@require_hr
def whatsapp_control_template_update(request: Request, document_type: str) -> Response:
    if document_type not in TYPE_LABELS:
        return _error(f"Unknown message type: {document_type}")
    data = request.data
    t = WhatsAppMessageTemplate.objects.filter(document_type=document_type).first()
    body = None
    if "messageBody" in data:
        body = (data.get("messageBody") or "").strip()
        problem = _wording_error(document_type, body)
        if problem:
            return _error(problem)
    if t is None:
        t = WhatsAppMessageTemplate(document_type=document_type)
    if body is not None:
        t.message_body = body
    if "isEnabled" in data:
        t.is_enabled = bool(data.get("isEnabled"))
    t.save()
    return Response(_template_row(document_type, t, {}, WhatsAppSettings.get()))


@api_view(["POST"])
@require_hr
def whatsapp_control_template_preview(request: Request, document_type: str) -> Response:
    """Render wording with sample values, so HR sees how a message will look before saving it."""
    spec = catalog.get(document_type)
    if spec is None:
        return _error(f"Unknown message type: {document_type}")
    body = (request.data.get("messageBody") or "").strip() or spec.body
    problem = _wording_error(document_type, body)
    return Response(
        {
            "preview": whatsapp_service.render_message(body, catalog.sample_params(document_type), spec.variable_names),
            "error": problem,
        }
    )
