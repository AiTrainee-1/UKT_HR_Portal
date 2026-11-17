"""Phone Notify Control -> Message Text (2026-11-17): HR's wording of each kind of phone notification (push_templates.py).

    GET  /api/mobile-app/messages/templates                every kind with wording: placeholders, built-in wording,
                                                           HR's wording, a sample preview, and how often it went out
    PUT  /api/mobile-app/messages/templates/<key>          {title, body}; both blank = back to the built-in wording
    POST /api/mobile-app/messages/templates/<key>/preview  {title, body} -> {title, body, error} with sample values

Permission: the Message Text tab of Phone Notify Control (the URL prefix maps to it, permission_tree.py).
"""

from __future__ import annotations

from django.db.models import Count, Max, Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import mobile_messages, push_templates
from .audit_utils import log_action
from .auth import get_hr_display_name, require_hr
from .branch_scope import scope_to_branch
from .models import MobileMessageSettings, Notification, PushTemplate
from .view_common import error_response as _error

AUDIT_MODULE = "phone_notify_control"


def _usage(request: Request) -> dict:
    qs = scope_to_branch(Notification.objects.all(), request, field="employee__branch_id")
    return {
        r["source"]: r
        for r in qs.exclude(source="")
        .values("source")
        .annotate(
            total=Count("id"),
            sent=Count("id", filter=Q(push_status__in=("sent", "delivered"))),
            failed=Count("id", filter=Q(push_status="failed")),
            last=Max("created_at"),
        )
    }


def _row(control: dict, t: PushTemplate | None, usage: dict, off: set[str]) -> dict:
    key = control["key"]
    s = push_templates.spec(key)
    title = (t.title.strip() if t else "") or ""
    body = (t.body.strip() if t else "") or ""
    stats = usage.get(key, {})
    return {
        "key": key,
        "label": control["label"],
        "description": control["description"],
        "group": control["group"],
        "groupLabel": control["groupLabel"],
        "category": control["category"],
        "categoryLabel": control["categoryLabel"],
        "enabled": key not in off,
        "variables": [{"name": v.name, "help": v.help, "sample": v.sample} for v in s.variables],
        "title": title,
        "body": body,
        "defaultTitle": s.default_title,
        "defaultBody": s.default_body,
        "defaultNote": s.note,
        "customised": bool(title or body),
        "preview": push_templates.preview(key, title, body),
        "updatedBy": (t.updated_by or None) if t and (title or body) else None,
        "updatedAt": t.updated_at.isoformat() if t and (title or body) and t.updated_at else None,
        "total": stats.get("total", 0),
        "sent": stats.get("sent", 0),
        "failed": stats.get("failed", 0),
        "lastSentAt": stats["last"].isoformat() if stats.get("last") else None,
    }


def _controls() -> dict[str, dict]:
    return {r["key"]: r for r in mobile_messages.categorized_controls() if r["kind"] == "message"}


@api_view(["GET"])
@require_hr
def push_templates_list(request: Request) -> Response:
    controls = _controls()
    saved = {t.key: t for t in PushTemplate.objects.all()}
    usage = _usage(request)
    off = set(MobileMessageSettings.get().disabled_types or [])
    return Response([_row(controls[k], saved.get(k), usage, off) for k in push_templates.keys() if k in controls])


def _texts(data) -> tuple[str, str] | None:
    if not isinstance(data, dict):
        return None
    title, body = data.get("title", ""), data.get("body", "")
    if not isinstance(title, str) or not isinstance(body, str):
        return None
    return title.strip(), body.strip()


@api_view(["PUT"])
@require_hr
def push_template_update(request: Request, key: str) -> Response:
    controls = _controls()
    if key not in controls or push_templates.spec(key) is None:
        return _error("This notification has no wording to customise.", 404)
    texts = _texts(request.data)
    if texts is None:
        return _error("title and body must be text")
    title, body = texts
    if problem := push_templates.problem(key, title, body):
        return _error(problem)
    t = PushTemplate.objects.filter(key=key).first()
    if title or body:
        t = t or PushTemplate(key=key)
        t.title, t.body, t.updated_by = title, body, get_hr_display_name(request)
        t.save()
        what = "saved"
    else:
        if t is not None:
            t.delete()
        t = None
        what = "reset to the built-in wording"
    push_templates.forget()
    log_action(
        request,
        "update",
        AUDIT_MODULE,
        description=f"Phone notification wording of '{controls[key]['label']}' {what}",
    )
    off = set(MobileMessageSettings.get().disabled_types or [])
    return Response(_row(controls[key], t, _usage(request), off))


@api_view(["POST"])
@require_hr
def push_template_preview(request: Request, key: str) -> Response:
    if push_templates.spec(key) is None:
        return _error("This notification has no wording to customise.", 404)
    texts = _texts(request.data)
    if texts is None:
        return _error("title and body must be text")
    title, body = texts
    return Response({**push_templates.preview(key, title, body), "error": push_templates.problem(key, title, body)})
