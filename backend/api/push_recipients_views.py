"""Phone Notify Control -> Settings (2026-11-17): who receives phone notifications at all (push_recipients.py).

    GET  /api/mobile-app/messages/recipients            the mode, what each mode would reach, the selected list's size
    PUT  /api/mobile-app/messages/recipients            {mode}
    GET  /api/mobile-app/messages/recipients/employees  the employees to pick from (paginated, filters)
    POST /api/mobile-app/messages/recipients/employees  {add} | {remove} | {addMatching} | {removeMatching} | {clear}

The mode is one company-wide setting. The counts and the employee list follow the HR account's branch scope, and so does
what it can add to or remove from the list. Permission: the Settings tab of Phone Notify Control (the URL prefix maps
to it, permission_tree.py).
"""

from __future__ import annotations

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import push_recipients as pr
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .models import Employee, MobileMessageSettings, PushRecipient, PushToken
from .view_common import error_response as _error
from .view_common import paginate

AUDIT_MODULE = "phone_notify_control"
MAX_IDS = 5000
EMPTY_SELECTED = (
    "Select at least one employee first: the Selected employees list is empty, so nobody would get phone "
    "notifications. Add employees in the list below, then choose this option."
)


def _active(request: Request):
    return scope_to_branch(Employee.objects.filter(status="active"), request, field="branch_id")


def _with_phone(qs):
    return qs.filter(Exists(PushToken.objects.filter(employee_id=OuterRef("pk"))))


def _count(qs) -> tuple[int, int]:
    return qs.count(), _with_phone(qs).count()


def _summary(request: Request, s: MobileMessageSettings | None = None) -> dict:
    s = s or MobileMessageSettings.get()
    active = _active(request)
    by_type = dict(active.values_list("employment_type").annotate(n=Count("id")))
    phones = dict(_with_phone(active).values_list("employment_type").annotate(n=Count("id")))
    selected = active.filter(push_recipient__isnull=False)
    sel_total, sel_phone = _count(selected)
    figures = {
        pr.ALL: (sum(by_type.values()), sum(phones.values())),
        pr.STAFF: (by_type.get("staff", 0), phones.get("staff", 0)),
        pr.PRODUCTION: (by_type.get("production", 0), phones.get("production", 0)),
        pr.SELECTED: (sel_total, sel_phone),
    }
    current = s.recipient_mode if s.recipient_mode in pr.MODES else pr.ALL
    return {
        "mode": current,
        "modeLabel": pr.MODE_LABELS[current],
        "modes": [
            {
                "key": key,
                "label": pr.MODE_LABELS[key],
                "description": pr.MODE_DESCRIPTIONS[key],
                "employees": figures[key][0],
                "withPhone": figures[key][1],
            }
            for key in pr.MODES
        ],
        "selected": sel_total,
        "selectedWithPhone": sel_phone,
        "receiving": figures[current][0],
        "receivingWithPhone": figures[current][1],
        "updatedBy": s.updated_by or None,
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


def overview_summary(request: Request) -> dict:
    """The line the Overview shows: {mode, modeLabel, receiving, receivingWithPhone}."""
    body = _summary(request)
    return {k: body[k] for k in ("mode", "modeLabel", "receiving", "receivingWithPhone")}


@api_view(["GET", "PUT"])
@require_hr
def push_recipients_settings(request: Request) -> Response:
    if request.method == "GET":
        return Response(_summary(request))
    new = (request.data or {}).get("mode") if isinstance(request.data, dict) else None
    if new not in pr.MODES:
        return _error("mode must be one of: " + ", ".join(pr.MODES))
    with transaction.atomic():
        s = MobileMessageSettings.objects.select_for_update().filter(pk=1).first() or MobileMessageSettings.get()
        if new == pr.SELECTED and not PushRecipient.objects.filter(employee__status="active").exists():
            return _error(EMPTY_SELECTED)
        old = s.recipient_mode
        if old != new:
            s.recipient_mode = new
            s.updated_by = get_hr_display_name(request)
            s.updated_at = timezone.now()
            s.save(update_fields=["recipient_mode", "updated_by", "updated_at"])
    if old != new:
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            record_id=s.pk,
            description=f"Phone notification recipients: {pr.MODE_LABELS.get(old, old)} -> {pr.MODE_LABELS[new]}",
        )
    return Response(_summary(request, s))


def _filtered(request: Request, f: dict):
    """The active employees (in scope) matching the list filters: search, type, branch, department, selected."""
    qs = _active(request)
    if search := str(f.get("search") or "").strip():
        qs = qs.filter(
            Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
            | Q(employee_code__icontains=search)
            | Q(phone__icontains=search)
        )
    if (kind := f.get("type")) in ("staff", "production"):
        qs = qs.filter(employment_type=kind)
    if str(f.get("branch") or "").isdigit():
        qs = qs.filter(branch_id=int(f["branch"]))
    if str(f.get("department") or "").isdigit():
        qs = qs.filter(department_id=int(f["department"]))
    selected = str(f.get("selected") or "")
    if selected in ("1", "true"):
        qs = qs.filter(push_recipient__isnull=False)
    elif selected in ("0", "false"):
        qs = qs.filter(push_recipient__isnull=True)
    return qs


def _row(e: Employee) -> dict:
    return {
        "id": e.id,
        "name": f"{e.first_name} {e.last_name}".strip(),
        "code": e.employee_code,
        "employmentType": e.employment_type,
        "department": e.department.name if e.department_id and e.department else None,
        "branch": e.branch.name if e.branch_id and e.branch else None,
        "hasPhone": bool(getattr(e, "has_phone", False)),
        "selected": bool(getattr(e, "is_selected", False)),
    }


def _ids(raw) -> list[int] | None:
    if not isinstance(raw, list) or len(raw) > MAX_IDS:
        return None
    out = []
    for v in raw:
        if isinstance(v, bool) or not str(v).isdigit():
            return None
        out.append(int(v))
    return out


@api_view(["GET", "POST"])
@require_hr
def push_recipients_employees(request: Request) -> Response:
    if request.method == "GET":
        qs = (
            _filtered(request, request.query_params)
            .select_related("department", "branch")
            .defer("photo_url")
            .annotate(
                has_phone=Exists(PushToken.objects.filter(employee_id=OuterRef("pk"))),
                is_selected=Exists(PushRecipient.objects.filter(employee_id=OuterRef("pk"))),
            )
            .order_by("first_name", "last_name", "id")
        )
        return paginate(request, qs, _row)

    data = request.data if isinstance(request.data, dict) else {}
    actions = [k for k in ("add", "remove", "addMatching", "removeMatching", "clear") if k in data]
    if len(actions) != 1:
        return _error("Send exactly one of: add, remove, addMatching, removeMatching, clear")
    action = actions[0]
    scope = _active(request)
    if action in ("add", "remove"):
        ids = _ids(data[action])
        if ids is None:
            return _error(f"{action} must be a list of at most {MAX_IDS} employee ids")
        target = scope.filter(pk__in=ids)
    elif action in ("addMatching", "removeMatching"):
        if not isinstance(data[action], dict):
            return _error(f"{action} must be an object of filters (search, type, branch, department)")
        target = _filtered(request, {k: v for k, v in data[action].items() if k != "selected"})
    else:
        if data["clear"] is not True:
            return _error("clear must be true")
        target = scope

    who = get_hr_display_name(request)
    with transaction.atomic():
        if action in ("add", "addMatching"):
            fresh = list(target.filter(push_recipient__isnull=True).values_list("id", flat=True))
            PushRecipient.objects.bulk_create(
                [PushRecipient(employee_id=i, added_by=who) for i in fresh], batch_size=500, ignore_conflicts=True
            )
            changed = len(fresh)
        else:
            changed, _ = PushRecipient.objects.filter(employee_id__in=target.values("id")).delete()
        s = MobileMessageSettings.get()
        left = PushRecipient.objects.filter(employee__status="active").exists()
        if changed and not left and s.recipient_mode == pr.SELECTED:
            # emptying the list while it is in use would silently stop every phone notification: refuse it
            transaction.set_rollback(True)
            return _error(
                "This would leave the Selected employees list empty while it is the recipient setting, so nobody would "
                "get phone notifications. Choose another option above first."
            )
    if changed:
        verb = "Added" if action in ("add", "addMatching") else "Removed"
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            record_id=s.pk,
            description=f"Phone notification recipients: {verb} {changed} employee(s) "
            + ("to" if verb == "Added" else "from")
            + " the Selected employees list",
        )
    return Response({**_summary(request, s), "changed": changed})
