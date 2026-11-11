"""
HR Requests page -> HoD's and Notify tabs: what is pending with every Department Head, and the reminders sent to them.

    GET      /api/hr/hod-pending?branchId=&departmentId=&search=&onlyPending=1
    GET|PUT  /api/hr/hod-reminders/settings
    POST     /api/hr/hod-reminders/preview   {template?}                 -> {messages: [...]}   (nothing is sent)
    POST     /api/hr/hod-reminders/send      {managerIds?, channels?}    -> 202 {run}            (sent in the background)
    GET      /api/hr/hod-reminders/runs?page=&pageSize=                  -> {items, total, page, pageSize}
    GET      /api/hr/hod-reminders/runs/<id>                             -> Run with its deliveries

Access is the Requests page's own module (`requests`, permission_registry.URL_MODULE_MAP): whoever can open the page can
view all of this (the preview only reads, so a view-level login may call it); changing the schedule and sending need edit.
The schedule is ONE for the whole company, so a login limited to a branch gets 403 {code: "company_wide_rule"} on the PUT
and on Send. A branch login sees the heads of its own branch and the requests of its own branch only; every login sees
only the kinds of request whose own module it can open (as the Requests page itself).

Shapes: hod_reminders_contract (2026-11-04). The rules: hod_pending.py (what is pending) and hod_reminders.py (sending).
"""

from __future__ import annotations

from collections import defaultdict

from django.db import transaction
from django.db.models import Count
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import hod_reminders as rem
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import get_branch_scope
from .clock import FACTORY_TZ, ist_today
from .hod_pending import active_managers, collect, item_json, waiting_days
from .mobile_approvals_views import CATEGORIES

COMPANY_WIDE_MESSAGE = (
    "The Department Head reminders are one schedule for the whole company, so a login limited to one branch can see "
    "them but not change or send them. Ask an administrator or a head-office login."
)
DEFAULT_RUNS_PAGE_SIZE = 20
MAX_RUNS_PAGE_SIZE = 100


def _iso(value) -> str | None:
    return timezone.localtime(value, FACTORY_TZ).isoformat() if value else None


def _hr_user(request: Request):
    from .models import HRUser

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    return HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None


def _can_edit(request: Request) -> bool:
    """Edit on the Requests page's module (the MD only views it), and not limited to one branch (company-wide rule)."""
    from .permission_registry import effective_permissions, resolve_permission

    hr = _hr_user(request)
    if hr is None:
        return False
    if not hr.is_super_admin and resolve_permission(effective_permissions(hr), "requests") != "edit":
        return False
    return get_branch_scope(request) is None


def _refuse_change(request: Request) -> Response | None:
    """403 for a login that may not change the schedule or send (the middleware already refuses a view-only role)."""
    if get_branch_scope(request) is not None:
        return Response({"error": COMPANY_WIDE_MESSAGE, "code": "company_wide_rule"}, status=403)
    if not _can_edit(request):
        return Response(
            {"error": "You can view the Department Head reminders but not change or send them.", "code": "view_only"},
            status=403,
        )
    return None


def _visible_categories(request: Request):
    """The categories whose kind of request this login may open (the Requests page drops the others the same way)."""
    from .hr_requests_views import _access_by_kind

    access, _may_approve = _access_by_kind(request)
    return [c for c in CATEGORIES if c.workflow in access]


# ─────────────────────────── GET /hr/hod-pending ───────────────────────────


def _int_param(raw) -> tuple[int | None, bool]:
    if raw in (None, ""):
        return None, True
    try:
        return int(raw), True
    except (TypeError, ValueError):
        return None, False


@api_view(["GET"])
@require_hr
def hod_pending(request: Request) -> Response:
    from .models import ManagerDepartmentAssignment, PushToken

    q = request.query_params
    branch_id, ok_branch = _int_param(q.get("branchId"))
    department_id, ok_dept = _int_param(q.get("departmentId"))
    if not (ok_branch and ok_dept):
        return Response({"error": "branchId and departmentId must be numbers."}, status=400)
    search = (q.get("search") or "").strip()[:80]
    only_pending = (q.get("onlyPending") or "").strip().lower() in ("1", "true", "yes")

    scope = get_branch_scope(request)
    categories = _visible_categories(request)
    managers = active_managers(scope)
    if branch_id is not None:
        managers = [m for m in managers if m.employee.branch_id == branch_id]

    departments: dict[int, list] = defaultdict(list)
    for a in (
        ManagerDepartmentAssignment.objects.filter(manager_id__in=[m.id for m in managers])
        .select_related("department")
        .order_by("department__name", "id")
    ):
        departments[a.manager_id].append(a.department)
    if department_id is not None:
        managers = [
            m
            for m in managers
            if m.employee.department_id == department_id or any(d.id == department_id for d in departments[m.id])
        ]
    if search:
        terms = search.casefold().split()[:5]

        def haystack(m) -> str:
            emp = m.employee
            names = " ".join(d.name for d in departments[m.id])
            return f"{emp.first_name} {emp.last_name} {emp.employee_code} {names}".casefold()

        managers = [m for m in managers if all(t in haystack(m) for t in terms)]

    pending = collect(managers, branch_id=scope, categories=categories)
    devices = dict(
        PushToken.objects.filter(employee_id__in=[m.employee_id for m in managers])
        .values("employee_id")
        .annotate(n=Count("id"))
        .values_list("employee_id", "n")
    )
    today = ist_today()
    by_key = {c.key: c for c in categories}
    heads = []
    for m in managers:
        hp = pending[m.id]
        emp = m.employee
        items = sorted(
            ((by_key[key], obj) for key, rows in hp.items.items() for obj in rows),
            key=lambda pair: (pair[1].created_at, pair[0].key, pair[1].id),
        )
        oldest = items[0][1].created_at if items else None
        heads.append(
            {
                "managerId": m.id,
                "employeeId": emp.id,
                "code": emp.employee_code,
                "name": rem.full_name(emp),
                "designation": emp.designation.title if emp.designation_id and emp.designation else None,
                "departments": [d.name for d in departments[m.id]],
                "branch": emp.branch.name if emp.branch_id and emp.branch else None,
                "phone": emp.phone or None,
                "email": emp.email or None,
                "devices": devices.get(emp.id, 0),
                "pending": hp.total,
                "byCategory": hp.counts(categories),
                "oldestPendingAt": _iso(oldest),
                "oldestDays": waiting_days(oldest, today),
                "items": [item_json(cat, obj, today) for cat, obj in items],
            }
        )
    listed = len(heads)
    if only_pending:
        heads = [h for h in heads if h["pending"]]
    heads.sort(key=lambda h: (-h["pending"], h["name"].casefold(), h["managerId"]))

    by_category = {c.key: 0 for c in categories}
    for h in heads:
        for key, n in h["byCategory"].items():
            by_category[key] += n or 0
    return Response(
        {
            "generatedAt": timezone.now().astimezone(FACTORY_TZ).isoformat(),
            "categories": [{"key": c.key, "label": c.label} for c in categories],
            "totals": {
                "hods": listed,
                "withPending": sum(1 for h in heads if h["pending"]),
                "pending": sum(h["pending"] for h in heads),
                "byCategory": by_category,
            },
            "hods": heads,
        }
    )


# ─────────────────────────── runs ───────────────────────────


def _empty_counts() -> dict:
    return {ch: {"sent": 0, "failed": 0, "skipped": 0} for ch in rem.CHANNELS}


def _deliveries_qs(request: Request):
    from .models import HodReminderDelivery

    qs = HodReminderDelivery.objects.all()
    scope = get_branch_scope(request)
    return qs.filter(employee__branch_id=scope) if scope is not None else qs


def _counts(request: Request, run_ids) -> tuple[dict, dict]:
    """({run_id: counts}, {run_id: heads}) for these rounds in ONE query (a branch login counts its own branch's heads)."""
    counts: dict = defaultdict(_empty_counts)
    heads: dict = defaultdict(int)
    rows = (
        _deliveries_qs(request)
        .filter(run_id__in=list(run_ids))
        .values("run_id", "whatsapp_status", "email_status", "push_status")
        .annotate(n=Count("id"))
    )
    for row in rows:
        heads[row["run_id"]] += row["n"]
        for ch in rem.CHANNELS:
            status = row[f"{ch}_status"]
            if status in ("sent", "failed", "skipped"):
                counts[row["run_id"]][ch][status] += row["n"]
    return counts, heads


def _status_json(status: str, note: str) -> dict:
    # "sending" is an internal step of "pending" (not tried yet / being tried)
    return {"status": "pending" if status == "sending" else status, "note": note or None}


def _delivery_json(d) -> dict:
    return {
        "managerId": d.manager_id,
        "employeeId": d.employee_id,
        "name": d.name,
        "pending": d.pending,
        "byCategory": d.by_category,
        "text": d.text,
        "whatsapp": _status_json(d.whatsapp_status, d.whatsapp_note),
        "email": _status_json(d.email_status, d.email_note),
        "push": _status_json(d.push_status, d.push_note),
    }


def run_json(run, counts: dict | None = None, heads: int | None = None) -> dict:
    return {
        "id": run.id,
        "trigger": run.trigger,
        "slot": run.slot or None,
        "runDate": run.run_date.isoformat() if run.run_date else None,
        "startedAt": _iso(run.started_at),
        "finishedAt": _iso(run.finished_at),
        "status": run.status,
        "sentBy": run.sent_by or None,
        "hods": run.hods if heads is None else heads,
        "channels": {ch: bool((run.channels or {}).get(ch)) for ch in rem.CHANNELS},
        "error": run.error or None,
        "counts": counts or _empty_counts(),
    }


def _runs_json(request: Request, runs) -> list[dict]:
    runs = list(runs)
    counts, heads = _counts(request, [r.id for r in runs])
    scoped = get_branch_scope(request) is not None
    return [run_json(r, counts.get(r.id), heads.get(r.id, 0) if scoped else None) for r in runs]


@api_view(["GET"])
@require_hr
def hod_reminder_runs(request: Request) -> Response:
    from .models import HodReminderRun

    page, ok_page = _int_param(request.query_params.get("page"))
    size, ok_size = _int_param(request.query_params.get("pageSize"))
    if not (ok_page and ok_size):
        return Response({"error": "page and pageSize must be numbers."}, status=400)
    page = max(1, page or 1)
    size = max(1, min(MAX_RUNS_PAGE_SIZE, size or DEFAULT_RUNS_PAGE_SIZE))
    qs = HodReminderRun.objects.order_by("-started_at", "-id")
    total = qs.count()
    items = _runs_json(request, qs[(page - 1) * size : page * size])
    return Response({"items": items, "total": total, "page": page, "pageSize": size})


@api_view(["GET"])
@require_hr
def hod_reminder_run_detail(request: Request, pk: int) -> Response:
    from .models import HodReminderRun

    run = HodReminderRun.objects.filter(pk=pk).first()
    if run is None:
        return Response({"error": "Reminder round not found."}, status=404)
    body = _runs_json(request, [run])[0]
    deliveries = sorted(
        _deliveries_qs(request).filter(run_id=run.id), key=lambda d: (-d.pending, d.name.casefold(), d.id)
    )
    body["deliveries"] = [_delivery_json(d) for d in deliveries]
    return Response(body)


# ─────────────────────────── settings ───────────────────────────


def _settings_json(request: Request, s) -> dict:
    from .models import HodReminderRun

    last = HodReminderRun.objects.order_by("-started_at", "-id").first()
    next_at = rem.next_run_for(s)
    return {
        "enabled": s.enabled,
        "times": list(s.times or []),
        "days": list(s.days or []),
        "channels": rem.channels_of(s),
        "onlyWithPending": True,
        "template": rem.template_of(s),
        "defaultTemplate": rem.DEFAULT_TEMPLATE,
        "placeholders": list(rem.PLACEHOLDERS),
        "nextRunAt": next_at.isoformat() if next_at else None,
        "lastRun": _runs_json(request, [last])[0] if last else None,
        "channelStatus": rem.channel_status(),
        "canEdit": _can_edit(request),
        "companyWide": True,
        "updatedBy": s.updated_by or None,
        "updatedAt": _iso(s.updated_at),
    }


def _snapshot(s) -> dict:
    return {
        "enabled": s.enabled,
        "times": list(s.times or []),
        "days": list(s.days or []),
        "channels": rem.channels_of(s),
        "template": rem.template_of(s),
    }


@api_view(["GET", "PUT"])
@require_hr
def hod_reminder_settings(request: Request) -> Response:
    from .models import HodReminderSettings

    if request.method == "GET":
        return Response(_settings_json(request, HodReminderSettings.get()))

    refusal = _refuse_change(request)
    if refusal is not None:
        return refusal
    data = request.data
    if not isinstance(data, dict):
        return Response({"error": "The body must be a JSON object."}, status=400)

    with transaction.atomic():
        s = HodReminderSettings.objects.select_for_update().get(pk=HodReminderSettings.get().pk)
        before = _snapshot(s)
        if "enabled" in data:
            if not isinstance(data["enabled"], bool):
                return Response({"error": "enabled must be true or false."}, status=400)
            s.enabled = data["enabled"]
        if "times" in data:
            times, error = rem.parse_times(data["times"])
            if error:
                return Response({"error": error}, status=400)
            s.times = times
        if "days" in data:
            days, error = rem.parse_days(data["days"])
            if error:
                return Response({"error": error}, status=400)
            s.days = days
        if "channels" in data:
            channels, error = rem.parse_channels(data["channels"], rem.channels_of(s))
            if error:
                return Response({"error": error}, status=400)
            s.channel_whatsapp, s.channel_email, s.channel_push = (channels[ch] for ch in rem.CHANNELS)
        if "template" in data:
            raw = data["template"]
            if raw is None:  # back to the built-in wording
                s.template = ""
            else:
                error = rem.template_problem(raw)
                if error:
                    return Response({"error": error}, status=400)
                body = raw.replace("\r\n", "\n").strip()
                s.template = "" if body == rem.DEFAULT_TEMPLATE else body
        after = _snapshot(s)
        changed = sorted(k for k in after if after[k] != before[k])
        if changed:
            s.updated_by = get_hr_display_name(request)
            s.updated_at = timezone.now()
            s.save()
    if changed:
        log_action(
            request,
            "update",
            "hod_reminders",
            description="Changed the Department Head reminders: " + ", ".join(changed),
            old_values={k: before[k] for k in changed},
            new_values={k: after[k] for k in changed},
        )
    return Response(_settings_json(request, s))


# ─────────────────────────── preview / send ───────────────────────────


@api_view(["POST"])
@require_hr
def hod_reminder_preview(request: Request) -> Response:
    """What each head would get if the reminders went now (a branch login: its own branch's heads). Sends nothing."""
    from .models import HodReminderSettings

    data = request.data if isinstance(request.data, dict) else {}
    template = data.get("template")
    if template in (None, ""):
        template = rem.template_of(HodReminderSettings.get())
    else:
        error = rem.template_problem(template)
        if error:
            return Response({"error": error}, status=400)
    today = ist_today()
    messages = [
        {
            "managerId": t.manager.id,
            "name": t.name,
            "pending": t.total,
            "byCategory": t.by_category,
            "text": rem.render(template, name=t.name, by_category=t.by_category, total=t.total, day=today),
        }
        for t in rem.targets(branch_id=get_branch_scope(request))
    ]
    return Response({"messages": messages})


@api_view(["POST"])
@require_hr
def hod_reminder_send(request: Request) -> Response:
    """Start a reminder round now: the round and its deliveries are made here, the sending happens in the background."""
    from .models import DepartmentManager, HodReminderRun, HodReminderSettings

    refusal = _refuse_change(request)
    if refusal is not None:
        return refusal
    data = request.data if isinstance(request.data, dict) else {}
    s = HodReminderSettings.get()

    manager_ids = data.get("managerIds")
    if manager_ids is not None:
        if not isinstance(manager_ids, list) or any(isinstance(i, bool) or not isinstance(i, int) for i in manager_ids):
            return Response({"error": "managerIds must be a list of Department Head ids."}, status=400)
        if not manager_ids:
            return Response({"error": "Choose at least one Department Head."}, status=400)
        known = set(DepartmentManager.objects.filter(pk__in=manager_ids, is_active=True).values_list("id", flat=True))
        unknown = sorted(set(manager_ids) - known)
        if unknown:
            return Response(
                {"error": f"Not an active Department Head: {', '.join(str(i) for i in unknown)}."}, status=400
            )
        manager_ids = sorted(set(manager_ids))
    channels = rem.channels_of(s)
    if data.get("channels") is not None:
        channels, error = rem.parse_channels(data["channels"], channels)
        if error:
            return Response({"error": error}, status=400)

    with transaction.atomic():
        busy = rem.running_round()
        if busy is not None:
            return Response(
                {
                    "error": "A reminder round is still being sent. Wait for it to finish before sending again.",
                    "code": "run_in_progress",
                    "run": _runs_json(request, [busy])[0],
                },
                status=409,
            )
        hr = _hr_user(request)
        run = HodReminderRun.objects.create(
            trigger=HodReminderRun.TRIGGER_MANUAL,
            run_date=ist_today(),
            channels=channels,
            manager_ids=manager_ids,
            template=rem.template_of(s),
            sent_by=get_hr_display_name(request),
            sent_by_user_id=hr.id if hr else None,
        )
        run = rem.prepare(run)
        if not run.hods:
            transaction.set_rollback(True)
            return Response(
                {
                    "error": "No Department Head has a request waiting for them right now, so there is nothing to send.",
                    "code": "nothing_pending",
                },
                status=400,
            )
        log_action(
            request,
            "create",
            "hod_reminders",
            record_id=run.id,
            description=f"Sent the Department Head reminders now to {run.hods} head(s)",
            new_values={"channels": channels, "managerIds": manager_ids},
        )
        rem.launch(run.id)  # after the commit, on its own thread
    return Response({"run": _runs_json(request, [run])[0]}, status=202)
