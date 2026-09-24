"""In-app notifications and push-token registration."""

from .auth import get_token_employee_id, require_auth
from .branch_scope import scope_to_branch
from .models import Notification, PushToken
from .serializers import notification_json
from .view_common import _employee_name, _error, paginate
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Notifications ---


def _notif_with_name(record: Notification) -> dict:
    return notification_json(record, _employee_name(record.employee_id))


@api_view(["GET", "POST"])
@require_auth
def notifications(request: Request) -> Response:
    if request.method == "GET":
        qs = Notification.objects.select_related("employee")
        # An employee token only ever sees their own notifications.
        employee_id = get_token_employee_id(request)
        if employee_id:
            qs = qs.filter(employee_id=employee_id)
        else:
            # HR used to see every branch's notifications here. A notification
            # is about one employee, so it belongs to that employee's branch;
            # an unscoped admin still sees all of them.
            qs = scope_to_branch(qs, request, field="employee__branch_id")
        if request.query_params.get("unreadOnly") in ("true", "1", True):
            qs = qs.filter(is_read=False)
        return paginate(request, qs.order_by("-created_at", "-id"), _notif_with_name)
    # POST is HR-only -every legitimate notification is created server-side
    # by the business-logic views themselves (approvals, leave, etc.) calling
    # Notification.objects.create() directly, never through this generic
    # endpoint. Without this check any employee token could POST an
    # arbitrary employeeId + message and plant a fake notification in
    # anyone else's inbox.
    if get_token_employee_id(request):
        return _error("HR access required", 403)
    return _notifications_create(request)


def _notifications_create(request: Request) -> Response:
    data = request.data
    record = Notification.objects.create(
        employee_id=data.get("employeeId"),
        type=data.get("type", "general"),
        message=data.get("message"),
    )
    return Response(_notif_with_name(record), status=201)


@api_view(["PATCH"])
@require_auth
def mark_notification_read(request: Request, pk: int) -> Response:
    record = Notification.objects.filter(pk=pk).first()
    if not record:
        return _error("Not found", 404)
    # An employee token may only mark their OWN notifications read -without
    # this check any logged-in employee could PATCH an arbitrary pk and
    # silently mark another employee's notification as read.
    token_employee_id = get_token_employee_id(request)
    if token_employee_id and record.employee_id != token_employee_id:
        return _error("Access denied", 403)
    record.is_read = True
    record.save(update_fields=["is_read"])
    return Response(_notif_with_name(record))


@api_view(["PATCH"])
@require_auth
def mark_all_notifications_read(request: Request) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return _error("Employee access required", 403)
    updated = Notification.objects.filter(employee_id=employee_id, is_read=False).update(is_read=True)
    return Response({"updated": updated})


@api_view(["POST"])
@require_auth
def register_push_token(request: Request) -> Response:
    """
    Mobile app only -the web app has no push equivalent. Called once after
    login (and again if Expo issues a new token). Upserts by token value so
    re-registering the same device just reassigns it, which also covers
    "a different employee logged into this phone".
    """
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return _error("Employee access required", 403)

    token = (request.data.get("token") or "").strip()
    if not token:
        return _error("token is required")

    PushToken.objects.update_or_create(
        token=token, defaults={"employee_id": employee_id, "platform": request.data.get("platform", "expo")}
    )
    return Response({"message": "Push token registered"}, status=201)
