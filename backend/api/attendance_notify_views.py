"""
The /api/attendance/notify/* endpoints behind Attendance -> Attendance Notify (owner 2026-11-17). Under the
"attendance/" prefix on purpose: a role with nothing set on the page gets its Attendance level (the permission
compatibility proof checks every path against the old map).

The engine and the rules are in attendance_notify.py; the report in attendance_notify_report.py. A login limited to one
branch sees and makes automations, lists and runs of its own branch only, and its reports cover that branch.
"""

from __future__ import annotations

from datetime import date

from django.db.models import Count, Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import attendance_notify as notify
from . import attendance_notify_report as rpt
from .auth import require_hr
from .branch_scope import get_branch_scope
from .clock import ist_now

PAGE_SIZE = 25
PREVIEW_DAYS = 7
PREVIEW_ROWS = 200


def _actor(request) -> str:
    user = getattr(request, "jwt_user", {}) or {}
    return user.get("name") or user.get("username") or "HR"


def _bad(message: str, field: str = "", status: int = 400) -> Response:
    return Response({"error": message, **({"field": field} if field else {})}, status=status)


def _automations(request):
    from .models import AttendanceNotifyAutomation

    qs = AttendanceNotifyAutomation.objects.select_related("branch")
    branch_id = get_branch_scope(request)
    return qs.filter(branch_id=branch_id) if branch_id is not None else qs


def _runs(request):
    from .models import AttendanceNotifyRun

    qs = AttendanceNotifyRun.objects.all()
    branch_id = get_branch_scope(request)
    if branch_id is not None:
        qs = qs.filter(config__branchId=branch_id)
    return qs


def _lists(request, channel: str = ""):
    from .models import AttendanceNotifyRecipientList

    qs = AttendanceNotifyRecipientList.objects.all()
    branch_id = get_branch_scope(request)
    if branch_id is not None:
        qs = qs.filter(Q(branch_id=branch_id) | Q(branch__isnull=True))
    if channel:
        qs = qs.filter(channel=channel)
    return qs


def _last_runs(ids) -> dict:
    from .models import AttendanceNotifyRun

    out: dict = {}
    for run in AttendanceNotifyRun.objects.filter(automation_id__in=list(ids)).order_by("automation_id", "-started_at"):
        out.setdefault(run.automation_id, run)
    return out


# ─────────────────────────── overview / snapshot ───────────────────────────


@api_view(["GET"])
@require_hr
def notify_overview(request: Request) -> Response:
    from .models import AttendanceNotifySettings

    autos = list(_automations(request))
    now = ist_now()
    upcoming = []
    for a in autos:
        at = notify.next_run_for(a, now)
        if at is not None:
            upcoming.append({"automationId": a.pk, "name": a.name, "channel": a.channel, "at": notify._aware(at)})
    upcoming.sort(key=lambda u: u["at"])
    today_start = timezone.now().astimezone(rpt_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
    runs_today = _runs(request).filter(started_at__gte=today_start)
    by_channel = {c: 0 for c in notify.CHANNELS}
    for a in autos:
        by_channel[a.channel] = by_channel.get(a.channel, 0) + 1
    return Response(
        {
            "channels": notify.channel_status(),
            "counts": {
                "automations": len(autos),
                "active": sum(1 for a in autos if a.is_active),
                "byChannel": by_channel,
                "runsToday": runs_today.count(),
                "failedToday": runs_today.filter(status__in=("failed", "partial")).count(),
            },
            "settings": {"connectedNumber": AttendanceNotifySettings.get().connected_number},
            "upcoming": upcoming[:5],
        }
    )


def rpt_tz():
    from .clock import FACTORY_TZ

    return FACTORY_TZ


@api_view(["GET"])
@require_hr
def notify_snapshot(request: Request) -> Response:
    """The dashboard's live numbers: how many are in each category on a day (today by default)."""
    q = request.query_params
    employee_type = q.get("employeeType") or "all"
    if employee_type not in rpt.EMPLOYEE_TYPES:
        return _bad("employeeType is all, staff or production.")
    now = ist_now()
    try:
        day = date.fromisoformat(q.get("date")) if q.get("date") else now.date()
    except ValueError:
        return _bad("date is YYYY-MM-DD.")
    if day > now.date():
        return _bad("The date is in the future.")
    config = {
        "reportType": "custom",
        "dateFrom": day,
        "dateTo": day,
        "categories": list(rpt.CATEGORIES),
        "employeeType": employee_type,
    }
    report = rpt.build(config, now=now, branch_id=get_branch_scope(request))
    return Response(
        {
            "date": day.isoformat(),
            "employeeType": employee_type,
            "counts": report.counts,
            "total": report.total_employees,
            "asOf": report.as_of or None,
            "generatedAt": timezone.now().astimezone(rpt_tz()).isoformat(),
        }
    )


# ─────────────────────────── automations ───────────────────────────


@api_view(["GET", "POST"])
@require_hr
def notify_automations(request: Request) -> Response:
    from .models import AttendanceNotifyAutomation

    if request.method == "POST":
        branch_id = get_branch_scope(request)
        try:
            fields = notify.clean(request.data, branch_id=branch_id)
        except notify.Invalid as exc:
            return _bad(str(exc), exc.field)
        actor = _actor(request)
        a = AttendanceNotifyAutomation.objects.create(**fields, branch_id=branch_id, created_by=actor, updated_by=actor)
        a = _automations(request).get(pk=a.pk)
        return Response(notify.automation_json(a), status=201)
    qs = _automations(request)
    q = request.query_params
    if q.get("channel") in notify.CHANNELS:
        qs = qs.filter(channel=q["channel"])
    if q.get("status") == "active":
        qs = qs.filter(is_active=True)
    elif q.get("status") == "inactive":
        qs = qs.filter(is_active=False)
    if q.get("search"):
        qs = qs.filter(name__icontains=q["search"].strip()[:80])
    autos = list(qs)
    last = _last_runs(a.pk for a in autos)
    now = ist_now()
    return Response({"items": [notify.automation_json(a, last_run=last.get(a.pk), now=now) for a in autos]})


def _get_automation(request, pk: int):
    return _automations(request).filter(pk=pk).first()


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def notify_automation(request: Request, pk: int) -> Response:
    a = _get_automation(request, pk)
    if a is None:
        return _bad("Automation not found.", status=404)
    if request.method == "DELETE":
        a.delete()  # its runs stay in the history (automation set to null, the name kept on each run)
        return Response(status=204)
    if request.method == "PUT":
        try:
            fields = notify.clean(request.data, branch_id=a.branch_id, existing=a)
        except notify.Invalid as exc:
            return _bad(str(exc), exc.field)
        for k, v in fields.items():
            setattr(a, k, v)
        a.updated_by = _actor(request)
        a.save()
    return Response(notify.automation_json(a, last_run=_last_runs([a.pk]).get(a.pk)))


@api_view(["POST"])
@require_hr
def notify_automation_toggle(request: Request, pk: int) -> Response:
    a = _get_automation(request, pk)
    if a is None:
        return _bad("Automation not found.", status=404)
    value = request.data.get("isActive")
    if not isinstance(value, bool):
        return _bad("isActive must be true or false.", "isActive")
    a.is_active = value
    a.updated_by = _actor(request)
    a.save(update_fields=["is_active", "updated_by", "updated_at"])
    return Response(notify.automation_json(a, last_run=_last_runs([a.pk]).get(a.pk)))


@api_view(["POST"])
@require_hr
def notify_automation_run(request: Request, pk: int) -> Response:
    """Run now: the run and its deliveries are created here; a background thread sends them."""
    from .models import AttendanceNotifyRun

    a = _get_automation(request, pk)
    if a is None:
        return _bad("Automation not found.", status=404)
    if notify.running_run_for(a.pk) is not None:
        return _bad("This automation is already sending: wait for it to finish.", status=409)
    run = notify.create_run(
        a, trigger=AttendanceNotifyRun.TRIGGER_MANUAL, run_date=ist_now().date(), requested_by=_actor(request)
    )
    notify.launch(run.pk)
    return Response({"run": notify.run_json(run)}, status=202)


# ─────────────────────────── preview ───────────────────────────


def _draft(request):
    """(cleaned fields, error response). Recipients are not needed for a preview."""
    data = dict(request.data) if isinstance(request.data, dict) else {}
    try:
        fields = notify.clean(data, branch_id=get_branch_scope(request), need_recipients=False)
    except notify.Invalid as exc:
        return None, _bad(str(exc), exc.field)
    return fields, None


def _preview_report(request, fields):
    from .models import Branch

    config = notify.config_from_fields(fields)
    branch_id = get_branch_scope(request)
    branch_name = Branch.objects.filter(pk=branch_id).values_list("name", flat=True).first() if branch_id else ""
    days = rpt.resolve_days(config, ist_now().date())
    report = rpt.build(config, now=ist_now(), branch_id=branch_id, branch_name=branch_name or "", max_days=PREVIEW_DAYS)
    return config, report, len(days)


def _warnings(config: dict, report, total_days: int) -> list:
    from .models import AttendanceNotifySettings, WhatsAppSettings

    out = []
    if total_days > PREVIEW_DAYS:
        out.append(f"The preview shows the first {PREVIEW_DAYS} of {total_days} days; the report sent covers them all.")
    channel = config.get("channel")
    state = notify.channel_status().get(channel)
    if state and not state["available"]:
        out.append(state["note"])
    if channel == "whatsapp":
        s = WhatsAppSettings.get()
        if s.quiet_hours_enabled and s.quiet_start != s.quiet_end:
            start, end = s.quiet_start.strftime("%H:%M"), s.quiet_end.strftime("%H:%M")
            for t in config.get("times") or []:
                inside = start <= t < end if start < end else (t >= start or t < end)
                if inside:
                    out.append(
                        f"{t} is inside WhatsApp's quiet hours ({start}–{end}, WhatsApp Control): nothing is sent then."
                    )
        r = config.get("recipients") or {}
        if r.get("connected") and not AttendanceNotifySettings.get().connected_number:
            out.append("Set the connected WhatsApp number on this page, or that recipient is skipped.")
        if config.get("content") in ("detailed", "both") or config.get("includePhotos"):
            out.append(
                "WhatsApp sends the summary line only (an approved template message): the employee list and the PDF "
                "with photos go by Gmail or Internal Chat."
            )
    if channel == "chat":
        out.append(
            "A company channel is read by every employee of that branch, and a department channel by that "
            "department: choose who should see these names."
        )
    if config.get("reportType") == "daily" and config.get("reportDay") == "today":
        out.append("A report about today counts as Absent everyone who has not punched yet at the sending time.")
    return out


@api_view(["POST"])
@require_hr
def notify_preview(request: Request) -> Response:
    from . import email_service
    from .employee_photo import photo_links
    from .models import PayrollSettings

    fields, error = _draft(request)
    if error:
        return error
    config, report, total_days = _preview_report(request, fields)
    content = config["content"]
    channel = config["channel"]
    messages: list = []
    html = subject = None
    if channel == "whatsapp":
        # ONE approved template message (hrms_attendance_report) with the counts on one line
        messages.append({"kind": "text", "text": notify.whatsapp_text(report)})
    elif channel == "chat":
        for text in rpt.message_parts(report, content, markdown=False):
            messages.append({"kind": "text", "text": text})
    else:
        ps = PayrollSettings.get()
        params = {
            "report_name": report.name,
            "date": rpt.days_text(report.days),
            "employee_type": rpt.TYPE_LABELS.get(report.employee_type, "All employees"),
        }
        photo_cids = None
        if config["includePhotos"] and config["emailFormat"] == "html":
            links = photo_links([r.person.id for r in report.rows[:PREVIEW_ROWS]])
            photo_cids = {k: v for k, v in links.items() if v}
        block = rpt.email_html(report, content, None) if config["emailFormat"] == "html" else ""
        if photo_cids is not None:
            # the preview shows the photos by their signed links; the email itself embeds them (cid:)
            block = rpt.email_html(report, content, {pk: f"__photo{pk}__" for pk in photo_cids})
            for pk, link in photo_cids.items():
                block = block.replace(f"cid:__photo{pk}__", link)
        subject, text, full = email_service.render_email(
            notify.SOURCE,
            params,
            company=email_service.company_name(ps),
            extra_html=block,
            extra_text=rpt.email_text(report, content),
            subject=config.get("subject") or None,
        )
        html = full if config["emailFormat"] == "html" else None
        messages.append({"kind": "text", "text": text})
    links = photo_links([r.person.id for r in report.rows[:PREVIEW_ROWS]]) if config["includePhotos"] else {}
    return Response(
        {
            "dates": [d.isoformat() for d in report.days],
            "counts": report.counts,
            "total": report.total_employees,
            "employees": report.employees,
            "messages": messages,
            "html": html,
            "subject": subject,
            "rows": [rpt.row_json(r, links.get(r.person.id)) for r in report.rows[:PREVIEW_ROWS]],
            "truncated": len(report.rows) > PREVIEW_ROWS,
            "warnings": _warnings(config, report, total_days),
        }
    )


@api_view(["POST"])
@require_hr
def notify_preview_pdf(request: Request):
    fields, error = _draft(request)
    if error:
        return error
    config, report, _total = _preview_report(request, fields)
    content = rpt.pdf_bytes(report, with_photos=bool(config["includePhotos"]), content=config["content"])
    resp = HttpResponse(content, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{rpt.pdf_filename(report)}"'
    return resp


# ─────────────────────────── runs ───────────────────────────


@api_view(["GET"])
@require_hr
def notify_runs(request: Request) -> Response:
    q = request.query_params
    qs = _runs(request)
    if q.get("automation"):
        try:
            qs = qs.filter(automation_id=int(q["automation"]))
        except ValueError:
            return _bad("automation is a number.")
    if q.get("channel") in notify.CHANNELS:
        qs = qs.filter(channel=q["channel"])
    if q.get("status") in ("running", "done", "partial", "failed", "skipped"):
        qs = qs.filter(status=q["status"])
    try:
        page = max(1, int(q.get("page") or 1))
    except ValueError:
        page = 1
    total = qs.count()
    runs = list(qs.order_by("-started_at", "-id")[(page - 1) * PAGE_SIZE : page * PAGE_SIZE])
    notify.sync_whatsapp([r.pk for r in runs])
    from .models import AttendanceNotifyDelivery, AttendanceNotifyRun

    runs = list(AttendanceNotifyRun.objects.filter(pk__in=[r.pk for r in runs]).order_by("-started_at", "-id"))
    by_run: dict = {}
    for d in AttendanceNotifyDelivery.objects.filter(run_id__in=[r.pk for r in runs]).order_by("id"):
        by_run.setdefault(d.run_id, []).append(d)
    return Response(
        {
            "total": total,
            "page": page,
            "pageSize": PAGE_SIZE,
            "items": [notify.run_json(r, by_run.get(r.pk, [])) for r in runs],
        }
    )


@api_view(["GET"])
@require_hr
def notify_run(request: Request, pk: int) -> Response:
    run = _runs(request).filter(pk=pk).first()
    if run is None:
        return _bad("Run not found.", status=404)
    notify.sync_whatsapp([run.pk])
    run.refresh_from_db()
    return Response(notify.run_json(run))


@api_view(["POST"])
@require_hr
def notify_run_retry(request: Request, pk: int) -> Response:
    run = _runs(request).filter(pk=pk).first()
    if run is None:
        return _bad("Run not found.", status=404)
    if run.status == "running":
        return _bad("This run is still sending.", status=409)
    if not notify.retry_failed(run, _actor(request)):
        return _bad("Nothing failed in this run.", status=400)
    run.refresh_from_db()
    return Response({"run": notify.run_json(run)}, status=202)


# ─────────────────────────── recipient lists ───────────────────────────


def _list_items(channel: str, raw):
    if channel == "whatsapp":
        if not isinstance(raw, list) or not raw:
            raise notify.Invalid("Add at least one number to the list.", "items")
        out, seen = [], set()
        for item in raw:
            value = item.get("value") if isinstance(item, dict) else item
            phone = notify.normalize_number(value)
            if not phone:
                raise notify.Invalid(f"'{value}' is not a WhatsApp number.", "items")
            if phone not in seen:
                seen.add(phone)
                out.append(
                    {"value": phone, "label": (item.get("label") or "").strip()[:80] if isinstance(item, dict) else ""}
                )
        if len(out) > notify.MAX_NUMBERS:
            raise notify.Invalid(f"A list holds at most {notify.MAX_NUMBERS} numbers.", "items")
        return out
    if channel == "email":
        raw = raw if isinstance(raw, dict) else {}
        out = {}
        for key in ("to", "cc", "bcc"):
            values = []
            for a in raw.get(key) or []:
                a = str(a or "").strip()
                if a and not notify._EMAIL.match(a):
                    raise notify.Invalid(f"'{a}' is not an email address.", "items")
                if a and a not in values:
                    values.append(a)
            out[key] = values
        if not any(out.values()):
            raise notify.Invalid("Add at least one address to the list.", "items")
        return out
    raise notify.Invalid("A saved list is for WhatsApp or Gmail.", "channel")


def _list_json(lst) -> dict:
    return {
        "id": lst.pk,
        "name": lst.name,
        "channel": lst.channel,
        "items": lst.items,
        "createdBy": lst.created_by,
        "updatedAt": notify._aware(lst.updated_at),
    }


@api_view(["GET", "POST"])
@require_hr
def notify_recipient_lists(request: Request) -> Response:
    from .models import AttendanceNotifyRecipientList

    if request.method == "POST":
        channel = request.data.get("channel")
        name = str(request.data.get("name") or "").strip()
        if not name or len(name) > notify.NAME_MAX:
            return _bad("Give the list a name (at most 120 characters).", "name")
        try:
            items = _list_items(channel, request.data.get("items"))
        except notify.Invalid as exc:
            return _bad(str(exc), exc.field)
        lst = AttendanceNotifyRecipientList.objects.create(
            name=name, channel=channel, items=items, branch_id=get_branch_scope(request), created_by=_actor(request)
        )
        return Response(_list_json(lst), status=201)
    channel = request.query_params.get("channel") or ""
    return Response(
        {"items": [_list_json(lst) for lst in _lists(request, channel if channel in ("whatsapp", "email") else "")]}
    )


@api_view(["PUT", "DELETE"])
@require_hr
def notify_recipient_list(request: Request, pk: int) -> Response:
    lst = _lists(request).filter(pk=pk).first()
    if lst is None:
        return _bad("List not found.", status=404)
    if request.method == "DELETE":
        lst.delete()
        return Response(status=204)
    name = str(request.data.get("name") or lst.name).strip()
    if not name or len(name) > notify.NAME_MAX:
        return _bad("Give the list a name (at most 120 characters).", "name")
    try:
        items = _list_items(lst.channel, request.data.get("items", lst.items))
    except notify.Invalid as exc:
        return _bad(str(exc), exc.field)
    lst.name, lst.items = name, items
    lst.save(update_fields=["name", "items", "updated_at"])
    return Response(_list_json(lst))


# ─────────────────────────── channels / settings ───────────────────────────


@api_view(["GET"])
@require_hr
def notify_whatsapp_groups(request: Request) -> Response:
    """WhatsApp groups are not offered any more: the official WhatsApp Cloud API sends approved templates to individual
    numbers only. Kept so the page gets a plain answer (supported: false and the reason) instead of an error."""
    from . import whatsapp_service as wa

    return Response({"supported": False, "groups": [], "note": wa.REASON_NO_GROUPS, "fetchedAt": None})


@api_view(["GET"])
@require_hr
def notify_chat_channels(request: Request) -> Response:
    """The chat channels a report can be posted in: each branch's company channel and every department's channel."""
    from .models import Branch, ChatChannel, Department, Employee

    branch_id = get_branch_scope(request)
    active = Employee.objects.filter(status="active")
    items = []
    branches = Branch.objects.filter(is_active=True).order_by("name")
    if branch_id is not None:
        branches = branches.filter(pk=branch_id)
    else:
        # the channel from before branches: employees with no branch read it in the app (everyone else reads their
        # branch's), and it is the one an admin's HR chat page opens first
        legacy = ChatChannel.get_company_channel(None)
        items.append(
            {
                "id": legacy.pk,
                "type": "company",
                "name": "Company (no branch)",
                "branch": None,
                "members": active.filter(branch__isnull=True).count(),
                "note": "Employees with no branch read it in the app; HR Chat opens it first.",
            }
        )
    per_branch = dict(active.values("branch_id").annotate(n=Count("id")).values_list("branch_id", "n"))
    for b in branches:
        c = ChatChannel.get_company_channel(b.pk)
        items.append(
            {
                "id": c.pk,
                "type": "company",
                "name": f"Company – {b.name}",
                "branch": b.name,
                "members": per_branch.get(b.pk, 0),
                "note": "Its branch's employees read it in the app; open it on HR Chat with the channel switch.",
            }
        )
    depts = Department.objects.select_related("branch").order_by("name")
    if branch_id is not None:
        depts = depts.filter(branch_id=branch_id)
    per_dept = dict(active.values("department_id").annotate(n=Count("id")).values_list("department_id", "n"))
    for d in depts:
        c = ChatChannel.get_department_channel(d)
        items.append(
            {
                "id": c.pk,
                "type": "department",
                "name": d.name,
                "branch": d.branch.name if d.branch_id and d.branch else None,
                "members": per_dept.get(d.pk, 0),
                "note": "Only this department's employees read it, in the app: HR Chat cannot open department channels.",
            }
        )
    return Response({"items": items})


@api_view(["GET", "PUT"])
@require_hr
def notify_settings(request: Request) -> Response:
    from .models import AttendanceNotifySettings

    s = AttendanceNotifySettings.get()
    if request.method == "PUT":
        raw = str(request.data.get("connectedNumber") or "").strip()
        number = notify.normalize_number(raw) if raw else ""
        if raw and not number:
            return _bad(f"'{raw}' is not a WhatsApp number.", "connectedNumber")
        s.connected_number = number
        s.updated_by = _actor(request)
        s.updated_at = timezone.now()
        s.save()
    return Response({"connectedNumber": s.connected_number})
