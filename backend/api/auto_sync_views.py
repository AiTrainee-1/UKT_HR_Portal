"""
Auto Sync -CRUD for configurable background biometric sync timing rules.
See auto_sync.py for the APScheduler wiring; every mutation here calls
straight into it so a rule change takes effect immediately, no restart.
"""

from datetime import time as time_type

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import auto_sync
from .auth import require_hr
from .models import AutoSyncRule


def _rule_dict(r: AutoSyncRule) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "time": r.time.strftime("%H:%M"),
        "daysOfWeek": r.days_of_week,
        "deviceSelection": r.device_selection,
        "mode": r.mode,
        "isEnabled": r.is_enabled,
        "lastRunAt": r.last_run_at.isoformat() if r.last_run_at else None,
        "lastRunStatus": r.last_run_status,
        "lastRunSummary": r.last_run_summary,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


def _apply_fields(rule: AutoSyncRule, data: dict) -> str | None:
    """Mutates rule in place from request body; returns an error string or None."""
    if "name" in data:
        rule.name = (data.get("name") or "").strip()
    if "time" in data:
        try:
            h, m = str(data["time"]).split(":")
            rule.time = time_type(int(h), int(m))
        except Exception:
            return "time must be in HH:MM format"
    if "daysOfWeek" in data:
        rule.days_of_week = data.get("daysOfWeek") or "*"
    if "deviceSelection" in data:
        sel = data.get("deviceSelection")
        rule.device_selection = sel if isinstance(sel, list) else []
    if "mode" in data:
        mode = data.get("mode")
        if mode not in dict(AutoSyncRule.MODE_CHOICES):
            return "mode must be one of: day, week, month, all"
        rule.mode = mode
    if "isEnabled" in data:
        rule.is_enabled = bool(data.get("isEnabled"))
    return None


@api_view(["GET", "POST"])
@require_hr
def auto_sync_rules(request: Request) -> Response:
    if request.method == "GET":
        return Response([_rule_dict(r) for r in AutoSyncRule.objects.all()])

    data = request.data
    if not data.get("time"):
        return Response({"error": "time is required"}, status=400)

    rule = AutoSyncRule()
    if err := _apply_fields(rule, {"mode": "day", **data}):
        return Response({"error": err}, status=400)
    rule.save()
    auto_sync.apply_rule_to_scheduler(rule)
    return Response(_rule_dict(rule), status=201)


@api_view(["GET", "PUT", "PATCH", "DELETE"])
@require_hr
def auto_sync_rule_detail(request: Request, pk: int) -> Response:
    rule = AutoSyncRule.objects.filter(pk=pk).first()
    if not rule:
        return Response({"error": "Auto Sync rule not found"}, status=404)

    if request.method == "GET":
        return Response(_rule_dict(rule))

    if request.method == "DELETE":
        auto_sync.remove_rule_from_scheduler(rule.id)
        rule.delete()
        return Response(status=204)

    if err := _apply_fields(rule, request.data):
        return Response({"error": err}, status=400)
    rule.save()
    auto_sync.apply_rule_to_scheduler(rule)
    return Response(_rule_dict(rule))
