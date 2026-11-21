"""
WhatsApp Control page (HR portal -> WhatsApp Control): one place to run every WhatsApp feature, through the official
Meta WhatsApp Cloud API (2026-11-20). All endpoints are HR-only and sit under the `whatsapp_control` permission module
and its tabs (permission_tree.py: overview, usage, controls, templates, otp, messages, employees, test, config).

    GET    /api/whatsapp-control/overview                    connection (Meta's view of the number), this month's
                                                             messages and cost, templates, WhatsApp OTP, the queue, and
                                                             alerts (whatsapp_usage.overview)
    GET    /api/whatsapp-control/usage?month=YYYY-MM         per day / Meta pricing category / message type, cost so far
                                                             and projected (with and without 18% GST), the budget, the
                                                             rates used, and Meta's own figures (whatsapp_usage.usage)
    GET    /api/whatsapp-control/messages                    message history (filters + pagination), with the template,
                                                             pricing category, billable and the delivery / read times
    GET    /api/whatsapp-control/employees                   employee-wise message counts + opt-out
    PATCH  /api/whatsapp-control/employees/<id>/opt-out      opt an employee out of (or back into) WhatsApp messages
    GET    /api/whatsapp-control/settings                    master switch, WhatsApp OTP master, feature / per-type
                                                             switches, timings, queue limits, quiet hours, template
                                                             overrides, price per category, monthly budget, set-up
    PATCH  /api/whatsapp-control/settings                    change any of those (PUT does the same, for older pages);
                                                             every value it changes needs edit on its tab (OTP,
                                                             Message Controls, Templates, Settings): else 403
                                                             {"code": "permission_denied", "tabs": [...]}, nothing saved
    GET    /api/whatsapp-control/queue                       the send queue right now (whatsapp_dispatcher.queue_status)
    POST   /api/whatsapp-control/queue/clear                 every queued message -> skipped ("Cleared by HR")
    GET    /api/whatsapp-control/meta-templates              the Meta templates (local mirror) and which types use each
    POST   /api/whatsapp-control/meta-templates              create a template and submit it to Meta for approval
    POST   /api/whatsapp-control/meta-templates/sync         pull every template from Meta now
    POST   /api/whatsapp-control/meta-templates/create-missing   submit a draft for every switched-on type without an
                                                             approved or pending template
    GET    /api/whatsapp-control/meta-templates/draft/<type> a ready-to-submit draft for one message type
    DELETE /api/whatsapp-control/meta-templates/<id>         delete a template at Meta and here
    (connection and test-message: whatsapp_test_views.py)

The old "Message Text" wording endpoints (whatsapp-control/templates..., whatsapp/templates...) are gone: with Meta the
wording IS the approved template (whatsapp_templates.py).

What the message types, modules and variables are comes from whatsapp_catalog.py, so a new notification appears here
without touching this file. Credentials stay in .env (Railway Variables on the live server) and are never returned or
editable here: only their names, set or not.
"""

import re
from datetime import date, datetime, time as time_type, timedelta
from decimal import Decimal, InvalidOperation

from django.conf import settings as dj_settings
from django.db.models import Count, Exists, F, Max, OuterRef, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import whatsapp_catalog as catalog, whatsapp_dispatcher, whatsapp_service, whatsapp_templates as templates
from . import whatsapp_usage as wa_usage
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import FACTORY_TZ
from .models import Employee, HRUser, WhatsAppMessageLog, WhatsAppOptOut, WhatsAppSettings, WhatsAppTemplate
from .view_common import error_response as _error, paginate

AUDIT_MODULE = "whatsapp_control"
TYPE_LABELS = {key: t.label for key, t in catalog.TYPES.items()}
STATUSES = list(WhatsAppMessageLog.STATUSES)
CATEGORY_OF = {key: t.module for key, t in catalog.TYPES.items()}
CATEGORIES = catalog.categories()

# Which workflow a message was raised by, beyond its module ("leave", "on_duty", ...).
RELATED_LABELS = {**catalog.APPROVAL_MODULES, "on_duty": "On-Duty request", "on_duty_punch": "On-Duty punch"}

# The groups the Message Controls tab shows, in order.
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
    (
        "hod",
        "Department Head notifications",
        "What a Department Head is told on WhatsApp about the requests waiting for their approval: a message when a "
        "request reaches them, and the scheduled reminder of everything still pending (its times are set on "
        "Requests -> Notify).",
    ),
    ("geo", "Geo Attendance", "Approval and rejection messages for On-Duty requests and their punches."),
    ("visitors", "Visitors", "Tells an employee who is at reception to meet them, with the visitor's phone number."),
    ("outpass", "Outpass & gate", "Confirms to the employee each time the gate records them going out or coming back."),
    (
        "other",
        "Attendance reports",
        "The reports scheduled on Attendance -> Attendance Notify, sent to the numbers chosen there.",
    ),
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
        "Keep Employee Code + password sign-in available. Turned off only takes effect while code sign-in (WhatsApp or "
        "SMS) is working.",
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
        "hodNotificationsEnabled",
        "hod_notifications_enabled",
        "Department Head notifications (all)",
        "hod",
        "Master switch for the messages to Department Heads below. Each one still has to be on too.",
    ),
    (
        "hodRequestWaitingEnabled",
        "hod_request_waiting_enabled",
        "New request waiting for approval",
        "hod",
        "Message the employee's Department Head as soon as a request reaches their step, with who asked, what and when.",
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
        "Message the employee a visitor came to meet, with the visitor's details.",
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


_KEY_OF_FIELD = {field: key for key, field, *_rest in FEATURES}


def _type_switches(type_key: str, spec) -> list[str]:
    """The json keys of every switch that must be on for this type to be sent (the engine aside), in the order the page
    names the first one that is off: the WhatsApp OTP master (codes), the section's master, a switch the type shares with
    others (geo approvals, punch reminders), its own switch. Mirrors whatsapp_service.switch_off_reason."""
    out = ["otpEnabled"] if templates.is_code_type(spec) else []
    for field in (catalog.MODULE_SWITCHES.get(spec.module), spec.switch):
        if field and field in _KEY_OF_FIELD and _KEY_OF_FIELD[field] not in out:
            out.append(_KEY_OF_FIELD[field])
    own = f"{TYPE_SWITCH_PREFIX}{type_key}"
    if own in TYPE_SWITCHES:
        out.append(own)
    return out


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

# A monthly budget above this (rupees) is a typing mistake.
MAX_BUDGET = Decimal("1000000000")
_TEMPLATE_NAME = re.compile(r"^[a-z0-9_]{1,512}$")


def _messages_qs(request: Request):
    return scope_to_branch(
        WhatsAppMessageLog.objects.select_related("employee", "sent_by"), request, field="employee__branch_id"
    )


def _status_counts(qs) -> dict:
    rows = qs.order_by().values("status").annotate(n=Count("id"))
    counts = {s: 0 for s in STATUSES}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + row["n"]
    counts["total"] = sum(counts.values())
    # "delivered to WhatsApp" = accepted by Meta and not failed/pending.
    counts["accepted"] = counts["sent"] + counts["delivered"] + counts["read"]
    return counts


def _message_json(m: WhatsAppMessageLog, template_categories: dict | None = None) -> dict:
    emp = m.employee  # None for a number that is not an employee (Attendance Notify)
    module = CATEGORY_OF.get(m.document_type, "other")
    related = RELATED_LABELS.get(m.related_module, "")
    return {
        "id": m.id,
        "employeeId": m.employee_id,
        "employeeCode": emp.employee_code if emp else "",
        "employeeName": f"{emp.first_name} {emp.last_name}".strip() if emp else (m.recipient_label or m.phone_number),
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
        # Meta Cloud API: the template it went out as, what Meta prices it as (from the delivery receipt, else the
        # template's / catalog's category), whether Meta charges it (null until the webhook says), delivery and read.
        "templateName": m.template_name,
        "pricingCategory": wa_usage.category_of(
            m.document_type, m.pricing_category, m.template_name, template_categories or {}
        ),
        "pricingCategoryFromMeta": bool(m.pricing_category),
        "billable": m.billable,
        "deliveredAt": m.delivered_at.isoformat() if m.delivered_at else None,
        "readAt": m.read_at.isoformat() if m.read_at else None,
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        "updatedAt": m.updated_at.isoformat() if m.updated_at else None,
    }


def _config(request: Request) -> dict:
    base = whatsapp_service._backend_public_base_url(request)
    s = WhatsAppSettings.get()
    return {
        "provider": "Meta WhatsApp Cloud API",
        "configured": whatsapp_service.is_configured(),
        # Why nothing can be sent from this server (no credentials, or a development machine), else null.
        "sendingBlockedReason": whatsapp_service.sending_block_reason(),
        "apiVersion": dj_settings.WHATSAPP_CLOUD_API_VERSION,
        "defaultCountryCode": dj_settings.WHATSAPP_DEFAULT_COUNTRY_CODE,
        # The pause between two messages: since the 2026-11-06 send queue that is its minimum gap (Message Controls).
        "sendDelaySeconds": s.min_gap_seconds,
        "publicBaseUrl": base,
        "webhookUrl": f"{base}/api/whatsapp/webhook/",
        "webhookVerifyTokenSet": bool(dj_settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN),
        "appSecretSet": bool(dj_settings.WHATSAPP_CLOUD_APP_SECRET),
        "backgroundSending": bool(dj_settings.WHATSAPP_ASYNC_SEND),
        "engineEnabled": bool(s.engine_enabled),
    }


def _day_start(days_back: int = 0) -> datetime:
    today = timezone.now().astimezone(FACTORY_TZ).date() - timedelta(days=days_back)
    return datetime.combine(today, datetime.min.time(), tzinfo=FACTORY_TZ)


def _template_categories(names) -> dict[str, str]:
    names = {n for n in names if n}
    if not names:
        return {}
    return dict(WhatsAppTemplate.objects.filter(name__in=names).values_list("name", "category"))


@api_view(["GET"])
@require_hr
def whatsapp_overview(request: Request) -> Response:
    """The Overview tab: {connection, month, cost, templates, otp, queue, alerts} (whatsapp_usage.overview), plus the
    older page's cheap keys (config, today, thisMonth, recentFailures, stalePending, categories, relatedModules)."""
    qs = _messages_qs(request)
    data = wa_usage.overview(qs)
    failed = list(qs.filter(status="failed").order_by("-created_at", "-id")[:8])
    categories = _template_categories(m.template_name for m in failed)
    cutoff = timezone.now() - timedelta(minutes=10)
    today_start = _day_start()
    month_start = today_start.replace(day=1)
    data.update(
        {
            "config": _config(request),
            "today": _status_counts(qs.filter(created_at__gte=today_start)),
            "thisMonth": _status_counts(qs.filter(created_at__gte=month_start)),
            "recentFailures": [_message_json(m, categories) for m in failed],
            "stalePending": qs.filter(
                Q(status="pending", created_at__lt=cutoff) | Q(status="sending", updated_at__lt=cutoff)
            ).count(),
            "categories": [{"key": key, "label": catalog.MODULES[key]} for key in CATEGORIES],
            "relatedModules": [{"key": key, "label": label} for key, label in RELATED_LABELS.items()],
        }
    )
    return Response(data)


@api_view(["GET"])
@require_hr
def whatsapp_usage(request: Request) -> Response:
    """The Usage & Cost tab for one month (?month=YYYY-MM, default this month): see whatsapp_usage.usage."""
    try:
        month = wa_usage.parse_month(request.query_params.get("month"))
    except ValueError:
        return _error("month must be YYYY-MM, for example 2026-11")
    return Response(wa_usage.usage(_messages_qs(request), month))


@api_view(["GET"])
@require_hr
def whatsapp_messages(request: Request) -> Response:
    """Message history, newest first. Filters: status, category (module), type, template (Meta template name), related
    (the workflow, e.g. leave), employeeId, search (name / code / phone), dateFrom, dateTo (YYYY-MM-DD, IST). Without
    `page` this is a bare array capped like every other list endpoint."""
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
    if template := q.get("template"):
        qs = qs.filter(template_name=template)
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
    for param, op in (("dateFrom", "gte"), ("dateTo", "lt")):
        if raw := q.get(param):
            try:
                d = date.fromisoformat(raw)
            except ValueError:
                return _error(f"{param} must be YYYY-MM-DD")
            if op == "lt":
                d += timedelta(days=1)
            qs = qs.filter(**{f"created_at__{op}": datetime.combine(d, datetime.min.time(), tzinfo=FACTORY_TZ)})

    categories: dict[str, str] = {}

    def prepare(rows) -> None:  # one look-up of the template categories for the whole page
        categories.update(_template_categories(r.template_name for r in rows))

    return paginate(request, qs, lambda m: _message_json(m, categories), prepare=prepare)


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


def _hr_user(request: Request) -> HRUser | None:
    return HRUser.objects.filter(pk=(getattr(request, "jwt_user", None) or {}).get("hrUserId")).first()


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
        user = _hr_user(request)
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
        # WhatsApp's own OTP switch: off sends no code by WhatsApp. SMS codes are switched on SMS Control, on their own.
        "otpEnabled": bool(s.otp_enabled),
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
        # {message type: Meta template} where HR chose another template than the default (hrms_<type>).
        "templateOverrides": {k: v for k, v in (s.template_overrides or {}).items() if isinstance(v, str) and v},
        # Every message type: the Meta template it goes out as (null: never sent through Meta) and the json keys of the
        # switches that must ALL be on for it besides the engine (the OTP master, its section's master, a switch it
        # shares with other types, its own), so the page never guesses either.
        "messageTypes": {
            key: {"templateName": whatsapp_service.template_name_for(key, s), "switches": _type_switches(key, spec)}
            for key, spec in catalog.TYPES.items()
        },
        # Rupees per billable message before GST, per Meta pricing category (HR's, else the India default).
        "priceRates": wa_usage.rates_json(s),
        "defaultPriceRates": {k: float(v) for k, v in wa_usage.DEFAULT_RATES.items()},
        "monthlyBudget": float(s.monthly_budget) if s.monthly_budget is not None else None,
        "gstRate": float(wa_usage.GST_RATE),
        "currency": wa_usage.CURRENCY,
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


def _decimal(value) -> Decimal | None:
    """A number from JSON (a number or numeric text) as a Decimal, else None. A boolean is not a number here."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"\s*\d+(\.\d+)?\s*", value):
        return None
    try:
        return Decimal(value.strip())
    except InvalidOperation:
        return None


def _template_overrides(raw, s: WhatsAppSettings) -> tuple[dict | None, str | None]:
    """The new template_overrides after merging HR's {type: name} (a blank name = back to the default), or an error."""
    if not isinstance(raw, dict):
        return None, "templateOverrides must be an object: {messageType: templateName}"
    overrides = {k: v for k, v in (s.template_overrides or {}).items() if isinstance(v, str) and v}
    for key, name in raw.items():
        spec = catalog.get(key) if isinstance(key, str) else None
        if spec is None:
            return None, f"templateOverrides: unknown message type {key}"
        if spec.default_template_name is None:
            return (
                None,
                f"templateOverrides: '{spec.label}' is not sent through WhatsApp Cloud API, so it has no template",
            )
        if name is None or (isinstance(name, str) and not name.strip()):
            overrides.pop(key, None)
            continue
        if not isinstance(name, str) or not _TEMPLATE_NAME.fullmatch(name.strip()):
            return None, (
                f"templateOverrides: the template for '{spec.label}' must be a Meta template name: lowercase letters, "
                "numbers and underscores"
            )
        name = name.strip()
        if name == spec.default_template_name:
            overrides.pop(key, None)
        else:
            overrides[key] = name
    return overrides, None


def _price_rates(raw, s: WhatsAppSettings) -> tuple[dict | None, str | None]:
    """The new price_rates after merging HR's {category: rupees} (null = back to the default), or an error."""
    if not isinstance(raw, dict):
        return None, "priceRates must be an object: {authentication, utility, marketing, service}"
    rates = {k: v for k, v in (s.price_rates or {}).items() if k in wa_usage.CATEGORIES}
    for key, value in raw.items():
        if key not in wa_usage.CATEGORIES:
            return None, f"priceRates: unknown pricing category {key} (use {', '.join(wa_usage.CATEGORIES)})"
        if value is None:
            rates.pop(key, None)
            continue
        rate = _decimal(value)
        if rate is None or not Decimal("0") <= rate <= wa_usage.MAX_RATE:
            return None, f"priceRates.{key} must be a number of rupees from 0 to {wa_usage.MAX_RATE}"
        rates[key] = float(rate.quantize(Decimal("0.0001")))
    return rates, None


# Which tab of the page each setting is changed on (permission_tree.py whatsapp_control.*): every value a save CHANGES
# needs edit on its tab (a tab follows the page until a role sets it on its own). The settings endpoint is one URL for
# all tabs, so the middleware can only check the page; this is the per-tab check, like payroll_views.FIELD_GROUPS.
_TAB_OF_FIELD = {
    **{f: "whatsapp_control.otp" for f in ("otp_enabled", "password_login_enabled", "otp_expiry_minutes")},
    **{field: "whatsapp_control.otp" for _k, field, _l, group, _d in FEATURES if group == "signin"},
    "price_rates": "whatsapp_control.config",
    "monthly_budget": "whatsapp_control.config",
}
# which tabs may change a setting not named above (the switches, limits, quiet hours and timings: Message Controls);
# which template a type goes out as may be changed from Templates too
_TABS_OF_FIELD = {"template_overrides": ("whatsapp_control.templates", "whatsapp_control.controls")}
_TAB_LABELS = {
    "whatsapp_control.otp": "OTP",
    "whatsapp_control.config": "Settings",
    "whatsapp_control.controls": "Message Controls",
    "whatsapp_control.templates": "Templates",
}


def _tabs_for(field: str) -> tuple[str, ...]:
    if field in _TABS_OF_FIELD:
        return _TABS_OF_FIELD[field]
    return (_TAB_OF_FIELD.get(field, "whatsapp_control.controls"),)


def _refused_tabs(request: Request, fields) -> list[str]:
    """The tabs whose edit access this login lacks for the given model fields (empty = all allowed). A super admin may
    change everything; a login with no HR account behind it may change nothing (fail closed)."""
    from .permission_registry import effective_permissions, resolve_permission

    hr = _hr_user(request)
    if hr is not None and hr.is_super_admin:
        return []
    permissions = effective_permissions(hr) if hr is not None else {}
    refused: list[str] = []
    for field in fields:
        tabs = _tabs_for(field)
        if not any(resolve_permission(permissions, tab) == "edit" for tab in tabs) and tabs[0] not in refused:
            refused.append(tabs[0])
    return refused


@api_view(["GET", "PUT", "PATCH"])
@require_hr
def whatsapp_control_settings(request: Request) -> Response:
    """GET the settings; PATCH (or PUT, the same) changes only the keys sent. Nothing is saved when any value is
    refused (400 with the reason)."""
    s = WhatsAppSettings.get()
    if request.method == "GET":
        return Response(_settings_json(request, s))

    data = request.data if isinstance(request.data, dict) else {}
    updates = {}
    for key, field in (("engineEnabled", "engine_enabled"), ("otpEnabled", "otp_enabled")):
        if key in data:
            if not isinstance(data[key], bool):
                return _error(f"{key} must be true or false")
            updates[field] = data[key]
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
    if "templateOverrides" in data:
        overrides, problem = _template_overrides(data["templateOverrides"], s)
        if problem:
            return _error(problem)
        updates["template_overrides"] = overrides
    if "priceRates" in data:
        rates, problem = _price_rates(data["priceRates"], s)
        if problem:
            return _error(problem)
        updates["price_rates"] = rates
    if "monthlyBudget" in data:
        raw = data["monthlyBudget"]
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            updates["monthly_budget"] = None
        else:
            budget = _decimal(raw)
            if budget is None or not Decimal("0") <= budget <= MAX_BUDGET:
                return _error("monthlyBudget must be empty (no budget) or a number of rupees from 0 up")
            updates["monthly_budget"] = budget.quantize(Decimal("0.01"))
    changed = {field: value for field, value in updates.items() if getattr(s, field) != value}
    refused = _refused_tabs(request, changed)
    if refused:
        names = ", ".join(f"WhatsApp Control -> {_TAB_LABELS.get(tab, tab)}" for tab in refused)
        return Response(
            {
                "error": f"You may view but not change {names}. Nothing was saved.",
                "code": "permission_denied",
                "tabs": refused,
            },
            status=403,
        )
    for field, value in updates.items():
        setattr(s, field, value)
    if updates:
        s.save()
    if changed:
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            s.pk,
            "WhatsApp Control settings changed: " + ", ".join(sorted(changed)),
            new_values={k: (str(v) if not isinstance(v, (bool, int, list, dict)) else v) for k, v in changed.items()},
        )
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


# ── Meta templates (whatsapp_templates.py) ──────────────────────────────────────────


def _template_error(exc: templates.TemplateError) -> Response:
    body = {"error": exc.message}
    if exc.fields:
        body["fields"] = exc.fields
    if exc.code is not None:
        body["code"] = exc.code
    return Response(body, status=exc.status)


@api_view(["GET", "POST"])
@require_hr
def whatsapp_meta_templates(request: Request) -> Response:
    """GET: {templates, lastSyncedAt, configured, language}. POST: create a template and submit it to Meta. Body:
    {name, language?, category (UTILITY | AUTHENTICATION), header? ("" | document | image | text), headerText?, body,
    footer?, examples {variable: example}, messageType?, codeExpirationMinutes? (AUTHENTICATION)}. 400 {error, fields}
    when it breaks Meta's rules or Meta refuses it (Meta's words included); 201 {template, message, warnings}."""
    if request.method == "GET":
        return Response(templates.list_json())
    data = request.data if isinstance(request.data, dict) else {}
    checked = templates.validate(data)
    if not checked.ok:
        return Response(
            {"error": checked.first_error(), "fields": checked.errors, "warnings": checked.warnings}, status=400
        )
    try:
        row, message = templates.create(checked.clean, user=_hr_user(request))
    except templates.TemplateError as exc:
        return _template_error(exc)
    log_action(
        request,
        "create",
        AUDIT_MODULE,
        row.id,
        f"Submitted the WhatsApp template {row.name} ({row.language}, {row.category}) to Meta: {row.status}",
    )
    return Response(
        {"template": templates.template_json(row), "message": message, "warnings": checked.warnings}, status=201
    )


@api_view(["POST"])
@require_hr
def whatsapp_meta_templates_sync(request: Request) -> Response:
    """Pull every template from Meta now: {synced, created, updated, deleted, lastSyncedAt, message, templates}."""
    try:
        result = templates.sync()
    except templates.TemplateError as exc:
        return _template_error(exc)
    log_action(request, "sync", AUDIT_MODULE, None, f"WhatsApp templates synced from Meta: {result['message']}")
    return Response({**templates.list_json(), **result})  # the sync's own time wins (even with no templates)


@api_view(["POST"])
@require_hr
def whatsapp_meta_templates_create_missing(request: Request) -> Response:
    """Submit a draft for every switched-on message type with neither an approved nor a pending template:
    {results: [{type, label, name, ok, status, error, message}], created, failed}."""
    try:
        results = templates.create_missing(user=_hr_user(request))
    except templates.TemplateError as exc:
        return _template_error(exc)
    names = sorted({r["name"] for r in results if r.get("ok") and r.get("name")})
    if names:
        log_action(
            request,
            "create",
            AUDIT_MODULE,
            None,
            "Submitted the missing WhatsApp templates to Meta: " + ", ".join(names),
        )
    return Response(
        {
            "results": results,
            "created": len(names),
            "failed": len({r["name"] for r in results if not r.get("ok")}),
        }
    )


@api_view(["GET"])
@require_hr
def whatsapp_meta_template_draft(request: Request, type_key: str) -> Response:
    """A ready-to-submit draft for one message type (whatsapp_templates.draft_for)."""
    try:
        return Response(templates.draft_for(type_key))
    except templates.TemplateError as exc:
        return _template_error(exc)


@api_view(["DELETE"])
@require_hr
def whatsapp_meta_template_delete(request: Request, pk: int) -> Response:
    """Delete one template (one language) at Meta and here: {deleted, name, language, messageTypes, message}."""
    row = WhatsAppTemplate.objects.filter(pk=pk).first()
    if row is None:
        return _error("Template not found", 404)
    try:
        result = templates.delete(row)
    except templates.TemplateError as exc:
        return _template_error(exc)
    log_action(
        request,
        "delete",
        AUDIT_MODULE,
        pk,
        f"Deleted the WhatsApp template {result['name']} ({result['language']})"
        + (" at Meta and here" if result["atMeta"] else " (this server only)"),
    )
    return Response(result)
