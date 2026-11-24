"""
Employee Enquiries (owner 2026-11-24): an employee raises a question from the mobile app; HR works through them on the HR
portal's Enquiries page like a to-do list (Pending -> On Hold -> Done) and replies; the employee is told on their phone.

Employee (mobile app):
    GET  /api/my/enquiries                 my enquiries, newest first
    POST /api/my/enquiries                 {category, subject, message}
HR portal (module "requests": who may see / handle the Requests page may do the same here):
    GET   /api/enquiries                   ?status=pending|on_hold|done|all &q= &from= &to= -> {items, counts}
    GET   /api/enquiries/summary           {pending, onHold, done} for the sidebar badge (cheap)
    PATCH /api/enquiries/<id>              {status?, reply?} -> the enquiry; the employee gets a push

Not an approval request (EmployeeRequest stays what it was for the web portals): nothing is approved, no workflow runs.
"""

from __future__ import annotations

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .audit_utils import log_action
from .auth import get_hr_display_name, get_token_employee_id, require_auth, require_hr
from .branch_scope import scope_to_branch
from .date_span import DaySpanError, parse_day_span
from .employee_photo import employee_photo_link
from .models import Employee, Enquiry, Notification

SUBJECT_MIN, SUBJECT_MAX, MESSAGE_MAX, REPLY_MAX = 3, 200, 2000, 2000
CATEGORIES = dict(Enquiry.CATEGORY_CHOICES)
STATUSES = dict(Enquiry.STATUS_CHOICES)
EMPLOYEE_STATUS_WORDS = {
    Enquiry.STATUS_PENDING: "waiting for HR",
    Enquiry.STATUS_ON_HOLD: "on hold",
    Enquiry.STATUS_DONE: "done",
}


def _text(data, *names) -> str:
    for name in names:
        value = data.get(name)
        if value not in (None, ""):
            return str(value).strip()
    return ""


def enquiry_json(e: Enquiry, *, with_employee: bool = False) -> dict:
    data = {
        "id": e.id,
        "category": e.category,
        "categoryLabel": CATEGORIES.get(e.category, e.category),
        "subject": e.subject,
        "message": e.message,
        "status": e.status,
        "statusLabel": STATUSES.get(e.status, e.status),
        "hrReply": e.hr_reply or None,
        "handledBy": e.handled_by or None,
        "handledAt": e.handled_at.isoformat() if e.handled_at else None,
        "doneAt": e.done_at.isoformat() if e.done_at else None,
        "history": e.history or [],
        "createdAt": e.created_at.isoformat() if e.created_at else None,
        "updatedAt": e.updated_at.isoformat() if e.updated_at else None,
    }
    if with_employee:
        emp = e.employee
        data["employee"] = {
            "id": emp.id,
            "employeeCode": emp.employee_code,
            "name": f"{emp.first_name} {emp.last_name}".strip(),
            "department": emp.department.name if emp.department_id and emp.department else None,
            "designation": emp.designation.title if emp.designation_id and emp.designation else None,
            "branch": emp.branch.name if emp.branch_id and emp.branch else None,
            "phone": emp.phone or None,
            "photoUrl": employee_photo_link(emp),
        }
    return data


# ── employee ──────────────────────────────────────────────────────────────


@api_view(["GET", "POST"])
@require_auth
def my_enquiries(request: Request) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return Response({"error": "Only an employee can raise an enquiry."}, status=403)
    if request.method == "GET":
        rows = Enquiry.objects.filter(employee_id=employee_id).order_by("-created_at")[:200]
        return Response([enquiry_json(e) for e in rows])

    data = request.data
    category = _text(data, "category") or "general"
    subject = _text(data, "subject")
    message = _text(data, "message", "description")
    if category not in CATEGORIES:
        return Response({"error": "Choose what the enquiry is about.", "code": "invalid_category"}, status=400)
    if not SUBJECT_MIN <= len(subject) <= SUBJECT_MAX:
        return Response({"error": f"Write a subject of {SUBJECT_MIN} to {SUBJECT_MAX} characters."}, status=400)
    if len(message) > MESSAGE_MAX:
        return Response({"error": f"The details can be at most {MESSAGE_MAX} characters."}, status=400)
    if not Employee.objects.filter(pk=employee_id).exists():
        return Response({"error": "Employee not found"}, status=404)
    e = Enquiry.objects.create(employee_id=employee_id, category=category, subject=subject, message=message)
    return Response(enquiry_json(e), status=201)


# ── HR ────────────────────────────────────────────────────────────────────


def _hr_queryset(request):
    qs = Enquiry.objects.select_related("employee__department", "employee__designation", "employee__branch").defer(
        "employee__photo_url"
    )
    return scope_to_branch(qs, request, field="employee__branch_id")


@api_view(["GET"])
@require_hr
def enquiries_hr(request: Request) -> Response:
    qs = _hr_queryset(request)
    try:
        span = parse_day_span(request.query_params)
    except DaySpanError as exc:
        return Response({"error": str(exc)}, status=400)
    if span is not None:
        qs = qs.filter(span.instant_q("created_at"))
    if q := (request.query_params.get("q") or "").strip():
        qs = qs.filter(
            Q(subject__icontains=q)
            | Q(message__icontains=q)
            | Q(employee__first_name__icontains=q)
            | Q(employee__last_name__icontains=q)
            | Q(employee__employee_code__icontains=q)
        )
    if category := (request.query_params.get("category") or "").strip():
        qs = qs.filter(category=category)
    counts = {row["status"]: row["n"] for row in qs.values("status").annotate(n=Count("id"))}
    status = (request.query_params.get("status") or "pending").strip()
    if status != "all":
        if status not in STATUSES:
            return Response({"error": "status must be pending, on_hold, done or all"}, status=400)
        qs = qs.filter(status=status)
    # Oldest first while waiting (a to-do list), newest first once done.
    rows = list(qs.order_by("-created_at" if status in ("done", "all") else "created_at")[:500])
    return Response({
        "items": [enquiry_json(e, with_employee=True) for e in rows],
        "counts": {
            "pending": counts.get(Enquiry.STATUS_PENDING, 0),
            "onHold": counts.get(Enquiry.STATUS_ON_HOLD, 0),
            "done": counts.get(Enquiry.STATUS_DONE, 0),
            "all": sum(counts.values()),
        },
    })


@api_view(["GET"])
@require_hr
def enquiries_summary(request: Request) -> Response:
    counts = {row["status"]: row["n"] for row in _hr_queryset(request).values("status").annotate(n=Count("id"))}
    latest = _hr_queryset(request).filter(status=Enquiry.STATUS_PENDING).order_by("-created_at").first()
    return Response({
        "pending": counts.get(Enquiry.STATUS_PENDING, 0),
        "onHold": counts.get(Enquiry.STATUS_ON_HOLD, 0),
        "done": counts.get(Enquiry.STATUS_DONE, 0),
        # The newest waiting one, so the portal can say "New enquiry from Ravi" when it arrives.
        "latest": {
            "id": latest.id,
            "subject": latest.subject,
            "employeeName": f"{latest.employee.first_name} {latest.employee.last_name}".strip(),
            "createdAt": latest.created_at.isoformat(),
        } if latest else None,
    })


def _notify_employee(e: Enquiry, status_changed: bool, reply: str) -> None:
    """The employee's phone hears about it (a Notification row is pushed by signals.py), in HR's Phone Notify wording."""
    from . import push_recipients, push_templates

    emp = e.employee
    if not push_recipients.allows(emp):
        return
    status_words = EMPLOYEE_STATUS_WORDS.get(e.status, e.status)
    if status_changed and reply:
        default = f"Your enquiry '{e.subject}' is now {status_words}. HR replied: {reply}"
    elif status_changed:
        default = f"Your enquiry '{e.subject}' is now {status_words}."
    else:
        default = f"HR replied to your enquiry '{e.subject}': {reply}"
    title, message = push_templates.apply(
        "request_update",
        {
            "employee_name": f"{emp.first_name} {emp.last_name}",
            "request_type": "Enquiry",
            "subject": e.subject,
            "status": status_words,
        },
        "Enquiry update",
        default[:600],
    )
    Notification.objects.create(
        employee=emp,
        type="enquiry",
        title=title,
        message=message,
        source="request_update",
        related_module="enquiry",
        dedupe_key=f"enquiry:{e.id}:{len(e.history or [])}",
    )


@api_view(["PATCH"])
@require_hr
def update_enquiry(request: Request, pk: int) -> Response:
    e = _hr_queryset(request).filter(pk=pk).first()
    if e is None:
        return Response({"error": "Enquiry not found"}, status=404)
    data = request.data
    status = _text(data, "status") or e.status
    if status not in STATUSES:
        return Response({"error": "status must be pending, on_hold or done"}, status=400)
    reply = _text(data, "reply", "hrReply", "hr_reply")
    if len(reply) > REPLY_MAX:
        return Response({"error": f"The reply can be at most {REPLY_MAX} characters."}, status=400)
    status_changed = status != e.status
    if not status_changed and not reply:
        return Response(enquiry_json(e, with_employee=True))

    by = get_hr_display_name(request)
    now = timezone.now()
    before = e.status
    e.status = status
    if reply:
        e.hr_reply = reply
    e.handled_by = by
    e.handled_at = now
    e.done_at = now if status == Enquiry.STATUS_DONE else None
    e.history = [*(e.history or []), {"at": now.isoformat(), "by": by, "status": status, "reply": reply or None}]
    e.save()
    _notify_employee(e, status_changed, reply)
    log_action(
        request, "update", "requests", record_id=e.id,
        description=f"Enquiry '{e.subject}' of {e.employee.employee_code}: {STATUSES[before]} -> {STATUSES[status]}",
        old_values={"status": before}, new_values={"status": status, "reply": reply or None},
    )
    return Response(enquiry_json(e, with_employee=True))
