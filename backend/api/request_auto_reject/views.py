"""/api/request-auto-reject/... - Settings -> Auto-Reject Requests (permission key settings.request_auto_reject; it follows
Settings until a role sets it).

    GET  config[?days=N]                        the switch, the number of days, the last run, and the requests due at the
                                                next run (in the caller's branch scope; ?days= previews another number of
                                                days before it is saved)
    PUT  config  {enabled?, days?}              change the switch / the days (one company-wide rule: a login for all units)
    POST run-now                                reject every due request now, by exactly the nightly rules (the saved days),
                                                whatever the switch says; only the requests in the caller's branch scope
    GET  history?page=&pageSize=&kind=&trigger=  what was rejected automatically, newest first (the caller's branch scope)

GET = view, PUT / POST = edit (HrPermissionMiddleware; checked here again). The nightly run itself is company-wide.
"""

from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import get_hr_display_name, require_hr
from ..branch_scope import get_branch_scope, scope_to_branch
from ..models import AutoRejectedRequest, RequestAutoRejectSettings
from . import engine, service
from .scheduler import RUN_AT

MODULE_KEY = "settings.request_auto_reject"
PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 100
DAYS_MIN, DAYS_MAX = RequestAutoRejectSettings.DAYS_MIN, RequestAutoRejectSettings.DAYS_MAX
DAYS_MESSAGE = f"The number of days must be a whole number from {DAYS_MIN} to {DAYS_MAX}."


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _iso(value):
    return value.isoformat() if value else None


def _hr_user(request: Request):
    hr = getattr(request, "hr_actor", None)
    if hr is not None:
        return hr
    from ..models import HRUser

    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    return HRUser.objects.select_related("role").filter(pk=user_id, is_active=True).first() if user_id else None


def _may_edit(request: Request) -> bool:
    """The Settings edit right on this tab (the middleware's rule: its own key, else what it follows)."""
    from ..permission_registry import effective_permissions, resolve_permission

    hr = _hr_user(request)
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr), MODULE_KEY) == "edit"


def _days_param(raw) -> int | None:
    """A number of days from a request, or None when it is not a whole number in range (True / False are not numbers)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, float) and raw.is_integer():
        value = int(raw)
    elif isinstance(raw, str) and raw.strip().isdigit():
        value = int(raw.strip())
    else:
        return None
    return value if DAYS_MIN <= value <= DAYS_MAX else None


def _kinds_json() -> list[dict]:
    return [{"key": key, "label": engine.spec(key).label} for key in engine.AUTO_KINDS]


def config_json(request: Request, preview_days: int | None = None) -> dict:
    row = service.settings_row()
    branch_id = get_branch_scope(request)
    days = preview_days or row.days
    due = engine.preview(days, branch_id=branch_id)
    due["days"] = days
    due["saved"] = days == row.days
    may_edit = _may_edit(request)
    return {
        "enabled": row.enabled,
        "days": row.days,
        "limits": {"min": DAYS_MIN, "max": DAYS_MAX, "default": RequestAutoRejectSettings.DAYS_DEFAULT},
        "runAt": RUN_AT,
        "lastRunAt": _iso(row.last_run_at),
        "lastRunBy": row.last_run_by or None,
        "lastRun": row.last_run_result or None,
        "updatedBy": row.updated_by or None,
        "updatedAt": _iso(row.updated_at) if row.pk else None,
        # the switch and the days are one company-wide rule: a branch login may look (and Run now for its branch)
        "canChange": may_edit and branch_id is None,
        "canRun": may_edit,
        "branchScoped": branch_id is not None,
        "kinds": _kinds_json(),
        "neverRejected": [{"key": key, "label": engine.spec(key).label} for key in engine.NEVER_AUTO],
        "due": due,
    }


@api_view(["GET", "PUT"])
@require_hr
def config_view(request: Request) -> Response:
    if request.method == "GET":
        raw = request.query_params.get("days")
        preview_days = None
        if raw not in (None, ""):
            preview_days = _days_param(raw)
            if preview_days is None:
                return _error(DAYS_MESSAGE)
        return Response(config_json(request, preview_days))

    if not _may_edit(request):
        return _error("You may look at this tab but not change it.", 403)
    if get_branch_scope(request) is not None:
        return _error(
            "The automatic rejection is one company-wide rule: only a login for all units can change it.", 403
        )
    data = request.data if isinstance(request.data, dict) else {}
    errors: dict[str, str] = {}
    values: dict = {}
    if "enabled" in data:
        if isinstance(data["enabled"], bool):
            values["enabled"] = data["enabled"]
        else:
            errors["enabled"] = "enabled must be true or false."
    if "days" in data:
        days = _days_param(data["days"])
        if days is None:
            errors["days"] = DAYS_MESSAGE
        else:
            values["days"] = days
    if errors:
        return _error(next(iter(errors.values())), errors=errors)
    row = RequestAutoRejectSettings.get()
    changes = []
    if "enabled" in values and values["enabled"] != row.enabled:
        changes.append(f"switched {'on' if values['enabled'] else 'off'}")
    if "days" in values and values["days"] != row.days:
        changes.append(f"days {row.days} -> {values['days']}")
    if changes:
        before = {"enabled": row.enabled, "days": row.days}
        for name, value in values.items():
            setattr(row, name, value)
        row.updated_by = get_hr_display_name(request)[:150]
        row.save()
        log_action(
            request,
            "update",
            "settings",
            record_id=row.pk,
            description="Auto-Reject Requests: " + "; ".join(changes),
            old_values=before,
            new_values={"enabled": row.enabled, "days": row.days},
        )
    return Response(config_json(request))


@api_view(["POST"])
@require_hr
def run_now(request: Request) -> Response:
    """Reject every request due now, at once (the confirm on the page said how many). A branch login rejects only the
    requests of its branch; the nightly run is company-wide."""
    if not _may_edit(request):
        return _error("You may look at this tab but not run it.", 403)
    actor = get_hr_display_name(request)
    branch_id = get_branch_scope(request)
    summary = service.run(trigger=AutoRejectedRequest.TRIGGER_RUN_NOW, run_by=actor, branch_id=branch_id)
    kinds = ", ".join(f"{engine.spec(k).label} {n}" for k, n in summary["byKind"].items())
    log_action(
        request,
        "reject",
        "settings",
        record_id=1,
        description=(
            f"Auto-Reject Requests run now: {summary['rejected']} waiting request(s) rejected"
            + (f" ({kinds})" if kinds else "")
            + (f"; {summary['failed']} could not be rejected" if summary["failed"] else "")
        ),
        new_values={"byKind": summary["byKind"], "failed": summary["failed"], "branchId": branch_id},
    )
    return Response({"summary": summary, "config": config_json(request)})


def _effects_text(effects: dict) -> list[str]:
    out = []
    voided = effects.get("voidedPunches")
    if voided:
        out.append(f"{voided} waiting On-Duty punch{'es' if voided != 1 else ''} voided")
    if effects.get("trackingEnded"):
        out.append("Geo tracking ended")
    attendance = effects.get("attendance")
    if attendance == "written":
        out.append("Attendance of the day updated as the module does on a rejection")
    elif attendance in ("skipped", "failed"):
        word = "not changed" if attendance == "skipped" else "could not be updated"
        out.append(f"Attendance {word}: {effects.get('attendanceNote') or ''}".strip().rstrip(":"))
    if effects.get("notified") is False:
        out.append("No phone notification (not a recipient, or already told)")
    return out


def history_json(row: AutoRejectedRequest) -> dict:
    try:
        label = engine.spec(row.kind).label
    except KeyError:
        label = row.kind.replace("_", " ").capitalize()
    return {
        "id": row.id,
        "kind": row.kind,
        "kindLabel": label,
        "requestId": row.request_id,
        "employee": {"id": row.employee_id, "code": row.employee_code, "name": row.employee_name},
        "what": row.what,
        "summary": row.summary,
        "submittedAt": _iso(row.submitted_at),
        "daysWaited": row.days_waited,
        "daysSetting": row.days_setting,
        "remark": row.remark,
        "rejectedAt": _iso(row.rejected_at),
        "trigger": row.trigger,
        "runBy": row.run_by or None,
        "by": f"Run now by {row.run_by}" if row.trigger == AutoRejectedRequest.TRIGGER_RUN_NOW else "Nightly run",
        "effects": row.effects or {},
        "effectsText": _effects_text(row.effects or {}),
    }


@api_view(["GET"])
@require_hr
def history(request: Request) -> Response:
    q = request.query_params
    try:
        page = max(1, int(q.get("page") or 1))
        size = max(1, min(PAGE_SIZE_MAX, int(q.get("pageSize") or PAGE_SIZE_DEFAULT)))
    except (TypeError, ValueError):
        return _error("page and pageSize must be numbers")
    qs = scope_to_branch(AutoRejectedRequest.objects.all(), request, field="branch_id")
    kind = (q.get("kind") or "").strip()
    if kind:
        if kind not in engine.AUTO_KINDS:
            return _error(f"kind must be one of: {', '.join(engine.AUTO_KINDS)}")
        qs = qs.filter(kind=kind)
    trigger = (q.get("trigger") or "").strip()
    if trigger:
        if trigger not in (AutoRejectedRequest.TRIGGER_NIGHTLY, AutoRejectedRequest.TRIGGER_RUN_NOW):
            return _error("trigger must be nightly or run_now")
        qs = qs.filter(trigger=trigger)
    total = qs.count()
    pages = max(1, -(-total // size))
    page = min(page, pages)
    rows = list(qs.order_by("-rejected_at", "-id")[(page - 1) * size : page * size])
    return Response(
        {
            "items": [history_json(r) for r in rows],
            "page": page,
            "pageSize": size,
            "total": total,
            "pages": pages,
        }
    )
