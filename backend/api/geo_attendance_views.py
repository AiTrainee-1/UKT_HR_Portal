"""
Geo Attendance — location-based punching + live location tracking
====================================================================
Independent capabilities, all opt-in and additive to the existing
biometric-first attendance system (never modifies biometric_sync.py, the
payroll engine, or AttendanceDayRecord computation):

1. Office Geo Punch (Inside Company Radius): an alternative to biometric
   punching for staff physically on-premises. No photos, no approval step —
   inside the branch's geofence, the punch is written immediately through
   the exact same _ingest_punches() path biometric sync and Excel import
   already share, tagged source="geo:auto". Outside the fence, the punch is
   hard-rejected (nothing is recorded) — the app should have already shown
   the employee they're out of range via geo_punch_precheck before they
   even tried. This is NOT for off-site work; that's On-Duty below.

2. On-Duty Attendance: for employees working away from the branch (field
   visits, drivers, offsite work). Two photos + a reason + GPS are captured,
   but nothing touches AttendanceLog until BOTH stages approve, in order:
     - pending_hod -> the employee's Department Head approves/rejects
       (mobile Approvals screen, manager_views.py::manager_update_on_duty_status)
     - pending_hr  -> HR gives the final approval (HR portal dashboard)
   A HOD rejection short-circuits straight to "rejected" — HR is never
   consulted. HR may also act directly on a still-pending_hod request as a
   fallback (e.g. no Department Head assigned), finalizing to
   approved/rejected in one step. On final approval the punch is written via
   the same _ingest_punches() path, tagged "on_duty:approved", at the
   ORIGINAL captured punch_time, never the approval time.

3. Live location tracking: strictly opt-in per employee (Employee.
   location_tracking_enabled, set by HR) — the app only starts sending
   pings when it sees that flag true on the employee's own profile. Pings
   are append-only and self-prune past PING_RETENTION_HOURS on every write
   (no cron/Celery in this project) — kept long enough (72h) to back both
   the Live Map's "current position" and the Route Map's "today/yesterday's
   travel path" views.

Same conventions as the rest of this codebase: plain @api_view + @require_hr
/@require_auth functions, no serializers/viewsets, camelCase response JSON,
branch scoping via scope_to_branch for every HR-facing list/action.
"""
from datetime import date, datetime, time, timedelta

from django.core.files.base import ContentFile
from django.http import FileResponse
from django.utils import timezone
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, is_hr, require_auth, require_hr
from .biometric_sync import _ingest_punches
from .branch_scope import get_branch_scope, scope_to_branch
from .geo_utils import haversine_distance_m
from .models import AttendanceLog, Employee, OnDutyRequest, LiveLocationPing, Notification

ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png"}
MAX_PHOTO_BYTES = 8 * 1024 * 1024  # 8MB
DEFAULT_RADIUS_M = 200
PING_RETENTION_HOURS = 72
IST_OFFSET = timedelta(hours=5, minutes=30)


def _error(msg: str, code: int = 400) -> Response:
    return Response({"error": msg}, status=code)


def source_label(source: str) -> str:
    """Human-facing label for an AttendanceLog.source tag — shared across the
    attendance report/log, the Attendance Search page, and the dashboard so
    the same source always reads the same way everywhere."""
    if not source:
        return "Unknown"
    if source.startswith("biometric"):
        return "Biometric"
    if source == "geo:auto":
        return "Geo Punch"
    if source == "on_duty:approved":
        return "On-Duty"
    if source == "manual":
        return "HR Entry"
    return source.replace("_", " ").replace(":", " ").title()


# ── Shared helpers ──────────────────────────────────────────────────────────

def _next_punch(emp: Employee, d) -> tuple[int | None, str | None]:
    """(punch number 1-4, IN/OUT) for the next punch this employee can make
    today, across every source (biometric + geo + on-duty combined) — mirrors
    the strict 4-punch engine's IN/OUT/IN/OUT pairing. None once 4 recorded."""
    count = AttendanceLog.objects.filter(employee=emp, date=d).count()
    if count >= 4:
        return None, None
    punch_type = AttendanceLog.PUNCH_IN if count % 2 == 0 else AttendanceLog.PUNCH_OUT
    return count + 1, punch_type


def _employee_from_token(request: Request) -> Employee | None:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None
    return Employee.objects.select_related("branch").filter(pk=emp_id).first()


def _get_is_mocked(data) -> bool:
    """The mobile app's axios client auto-decamelizes JSON request bodies
    (isMocked -> is_mocked) before they hit the wire, but doesn't touch
    multipart/FormData bodies — the web app and HR portal never decamelize
    at all. Reading both spellings keeps this endpoint correct for every
    caller regardless of which convention (or none) it applies."""
    raw = data.get("isMocked")
    if raw is None:
        raw = data.get("is_mocked")
    if isinstance(raw, str):
        return raw.lower() in ("1", "true")
    return bool(raw)


def _day_bounds_utc(d: date) -> tuple[datetime, datetime]:
    """UTC-aware [start, end) for the given IST calendar day `d`. This
    server's clock is IST (the project-wide convention — see punch_date/
    punch_time everywhere else), but LiveLocationPing.recorded_at is a real,
    correct UTC instant (timezone.now(), unlike the naive date.today()/
    datetime.now() used for punch dates) — so building the day boundary
    requires the explicit IST offset rather than a naive date comparison."""
    start_naive = datetime.combine(d, time.min)
    start_utc = start_naive - IST_OFFSET
    end_utc = start_utc + timedelta(days=1)
    return timezone.make_aware(start_utc, timezone.utc), timezone.make_aware(end_utc, timezone.utc)


def _on_duty_request_dict(req: OnDutyRequest) -> dict:
    emp = req.employee
    return {
        "id": req.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "punchDate": str(req.punch_date),
        "punchTime": req.punch_time.strftime("%H:%M:%S"),
        "punchType": req.punch_type,
        "reason": req.reason,
        "branchId": req.branch_id,
        "branchName": req.branch.name if req.branch_id and req.branch else None,
        "latitude": float(req.latitude),
        "longitude": float(req.longitude),
        "accuracyM": req.accuracy_m,
        "isMocked": req.is_mocked,
        "hasPhotos": bool(req.photo1 and req.photo2),
        "status": req.status,
        "hodReviewedBy": req.hod_reviewed_by,
        "hodReviewComment": req.hod_review_comment,
        "hodReviewedAt": req.hod_reviewed_at.isoformat() if req.hod_reviewed_at else None,
        "hrReviewedBy": req.hr_reviewed_by,
        "hrReviewComment": req.hr_review_comment,
        "hrReviewedAt": req.hr_reviewed_at.isoformat() if req.hr_reviewed_at else None,
        "createdAt": req.created_at.isoformat() if req.created_at else None,
    }


def resolve_on_duty_hod(req: OnDutyRequest, decision: str, reviewer_name: str, comment: str | None) -> None:
    """
    Stage 1 — Department Head decision. Called from manager_views.py::
    manager_update_on_duty_status. Approval moves the request to pending_hr
    (nothing is written to AttendanceLog yet); rejection is terminal — HR
    never sees it.
    """
    req.status = OnDutyRequest.STATUS_PENDING_HR if decision == "approved" else OnDutyRequest.STATUS_REJECTED
    req.hod_reviewed_by = reviewer_name
    req.hod_reviewed_at = timezone.now()
    if comment:
        req.hod_review_comment = comment
    req.save()
    punch_label = "Check-In" if req.punch_type == AttendanceLog.PUNCH_IN else "Check-Out"
    if decision == "approved":
        message = f"Your On-Duty {punch_label} request for {req.punch_date} was approved by your Department Head and is now awaiting HR approval."
    else:
        message = f"Your On-Duty {punch_label} request for {req.punch_date} was rejected by your Department Head."
    Notification.objects.create(employee=req.employee, type="on_duty", message=message)


def resolve_on_duty_hr(req: OnDutyRequest, decision: str, reviewer_name: str, comment: str | None) -> None:
    """
    Stage 2 — HR's final decision. Called both for a request already at
    pending_hr (the normal path) and directly on a still-pending_hod request
    (HR's fallback when there's no Department Head to act, or they haven't).
    Either way this call is the one that finalizes the request: approval
    writes a real punch via the same shared ingestion path every other punch
    source uses, at the ORIGINAL captured time — never the approval time.
    """
    if decision == "approved":
        _ingest_punches(
            [(req.employee.employee_code, req.punch_date, req.punch_time, req.punch_type)],
            None,
            "on_duty:approved",
        )
        req.status = OnDutyRequest.STATUS_APPROVED
    else:
        req.status = OnDutyRequest.STATUS_REJECTED
    req.hr_reviewed_by = reviewer_name
    req.hr_reviewed_at = timezone.now()
    if comment:
        req.hr_review_comment = comment
    req.save()
    punch_label = "Check-In" if req.punch_type == AttendanceLog.PUNCH_IN else "Check-Out"
    Notification.objects.create(
        employee=req.employee,
        type="on_duty",
        message=f"Your On-Duty {punch_label} request for {req.punch_date} was {req.status} by HR.",
    )


def _notify_hod_approvers(req: OnDutyRequest) -> None:
    """Push a Notification to every active Department Head covering this
    employee with on-duty approval enabled. HR always sees the request too,
    via the Pending Approvals tab on the HR dashboard (no push needed there —
    HRUser accounts aren't push-token-registered, only employees are)."""
    from django.db.models import Q
    from .models import DepartmentManager

    emp = req.employee
    managers = DepartmentManager.objects.select_related("employee").filter(
        Q(employee_assignments__employee_id=emp.id) | Q(department_assignments__department_id=emp.department_id),
        is_active=True,
        can_approve_on_duty=True,
    ).distinct()
    punch_label = "Check-In" if req.punch_type == AttendanceLog.PUNCH_IN else "Check-Out"
    for m in managers:
        Notification.objects.create(
            employee=m.employee,
            type="on_duty",
            message=f"{emp.first_name} {emp.last_name} submitted an On-Duty {punch_label} request — {req.reason[:80]}",
        )


# ── Employee-facing: Office Geo Punch (Type 1) ──────────────────────────────

@api_view(["GET"])
@require_auth
def geo_punch_precheck(request: Request) -> Response:
    """
    GET /api/attendance/geo-punch/precheck?latitude=..&longitude=..
    Read-only status check — no punch is written. Lets the app clearly show
    "You are inside/outside the allowed company radius" BEFORE the employee
    commits to punching, per the requirement that this must be visible ahead
    of the actual punch action.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    try:
        lat = float(request.query_params.get("latitude"))
        lng = float(request.query_params.get("longitude"))
    except (TypeError, ValueError):
        return _error("latitude and longitude are required")

    branch = emp.branch
    if branch is None or branch.geofence_lat is None or branch.geofence_lng is None:
        return _error("Your branch has no location configured — ask HR to set it up in Manage Branch")

    distance = haversine_distance_m(lat, lng, float(branch.geofence_lat), float(branch.geofence_lng))
    radius = branch.geofence_radius_m or DEFAULT_RADIUS_M
    inside = distance <= radius

    today = date.today()
    punch_num, punch_type = _next_punch(emp, today)

    return Response({
        "insideRadius": inside,
        "distanceM": round(distance),
        "radiusM": radius,
        "branchName": branch.name,
        "nextPunchNumber": punch_num,
        "nextPunchType": punch_type,
        "message": (
            f"You are inside the allowed company radius ({round(distance)}m from {branch.name})."
            if inside else
            f"You are outside the allowed company radius — {round(distance)}m from {branch.name} (allowed: {radius}m)."
        ),
    })


@api_view(["POST"])
@require_auth
def geo_punch(request: Request) -> Response:
    """
    POST /api/attendance/geo-punch — JSON {latitude, longitude, accuracy?, isMocked?}
    Office Geo Punch: an alternative to biometric punching for staff
    physically on-premises. No photos, no approval step. Inside the branch's
    geofence, the punch is written immediately. Outside it, the punch is
    hard-rejected — nothing is recorded, and no approval request is created.
    Employees working off-site should use the On-Duty flow instead
    (on_duty_request below).
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    data = request.data
    try:
        lat = float(data.get("latitude"))
        lng = float(data.get("longitude"))
    except (TypeError, ValueError):
        return _error("latitude and longitude are required")
    is_mocked = _get_is_mocked(data)

    # Plain stdlib date/datetime, NOT timezone.localdate()/localtime() —
    # this project runs with settings.TIME_ZONE="UTC" (Django never converts
    # "local" to anything but UTC), while every other punch-ingestion path
    # relies on the SERVER MACHINE's OS clock already being set to IST.
    today = date.today()
    now_time = datetime.now().time().replace(microsecond=0)
    punch_num, punch_type = _next_punch(emp, today)
    if punch_type is None:
        return _error("All 4 punches have already been recorded for today")

    branch = emp.branch
    if branch is None or branch.geofence_lat is None or branch.geofence_lng is None:
        return _error("Your branch has no location configured — ask HR to set it up in Manage Branch")

    distance = haversine_distance_m(lat, lng, float(branch.geofence_lat), float(branch.geofence_lng))
    radius = branch.geofence_radius_m or DEFAULT_RADIUS_M

    if is_mocked:
        return _error("This looks like a simulated/mock location — Office Geo Punch requires your real GPS location.", 403)

    if distance > radius:
        return Response({
            "status": "rejected",
            "distanceM": round(distance), "radiusM": radius,
            "message": (
                f"You are outside the allowed company radius — {round(distance)}m from {branch.name} "
                f"(allowed: {radius}m). Move within range to punch, or submit an On-Duty request if you're working off-site."
            ),
        }, status=403)

    result = _ingest_punches([(emp.employee_code, today, now_time, punch_type)], None, "geo:auto")
    if result["created"] >= 1:
        return Response({
            "status": "accepted", "punchNumber": punch_num, "punchType": punch_type,
            "distanceM": round(distance), "date": str(today), "time": now_time.strftime("%H:%M:%S"),
        }, status=201)
    return Response({"status": "already_recorded", "punchNumber": punch_num, "punchType": punch_type})


# ── Employee-facing: On-Duty Attendance (Type 2) ────────────────────────────

@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_auth
def on_duty_request(request: Request) -> Response:
    """
    POST /api/attendance/on-duty/request — multipart:
      latitude, longitude, accuracy?, isMocked?, reason, photo1 (file), photo2 (file)
    For employees working away from the branch. Creates a pending_hod
    OnDutyRequest — the punch is NOT recorded until the Department Head then
    HR both approve it.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    data = request.data
    try:
        lat = float(data.get("latitude"))
        lng = float(data.get("longitude"))
    except (TypeError, ValueError):
        return _error("latitude and longitude are required")
    is_mocked = _get_is_mocked(data)
    accuracy = data.get("accuracy")
    try:
        accuracy = float(accuracy) if accuracy not in (None, "") else None
    except (TypeError, ValueError):
        accuracy = None

    reason = (data.get("reason") or "").strip()
    if not reason:
        return _error("A reason for the on-duty work is required")

    photo1 = request.FILES.get("photo1")
    photo2 = request.FILES.get("photo2")
    if not photo1 or not photo2:
        return _error("Two photos (photo1, photo2) are required for an On-Duty request")
    for f in (photo1, photo2):
        ext = f.name.rsplit(".", 1)[-1].lower() if "." in f.name else ""
        if ext not in ALLOWED_PHOTO_EXTENSIONS:
            return _error(f"Unsupported photo type '.{ext}' — only JPG and PNG are accepted")
        if f.size > MAX_PHOTO_BYTES:
            return _error(f"Photo is too large ({f.size / 1024 / 1024:.1f}MB) — the limit is 8MB")

    today = date.today()
    now_time = datetime.now().time().replace(microsecond=0)
    punch_num, punch_type = _next_punch(emp, today)
    if punch_type is None:
        return _error("All 4 punches have already been recorded for today")

    req = OnDutyRequest(
        employee=emp, punch_date=today, punch_time=now_time, punch_type=punch_type,
        reason=reason, branch=emp.branch, latitude=lat, longitude=lng,
        accuracy_m=accuracy, is_mocked=is_mocked,
    )
    req.photo1.save(photo1.name, ContentFile(photo1.read()), save=False)
    req.photo2.save(photo2.name, ContentFile(photo2.read()), save=False)
    req.save()
    _notify_hod_approvers(req)

    return Response({
        "status": "pending_hod_approval", "requestId": req.id,
        "punchNumber": punch_num, "punchType": punch_type,
    }, status=201)


@api_view(["GET"])
@require_auth
def geo_punch_status(request: Request) -> Response:
    """GET /api/attendance/geo-punch/status?date=YYYY-MM-DD (defaults to today)
    Today's recorded punches (any source) + this employee's pending/recent
    On-Duty requests — lets the app show "Punch 2 pending HOD approval" etc."""
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    date_str = request.query_params.get("date")
    d = date.today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return _error("Invalid date format")

    logs = AttendanceLog.objects.filter(employee=emp, date=d).order_by("punch_time")
    requests_qs = OnDutyRequest.objects.filter(employee=emp, punch_date=d).order_by("punch_time")

    punch_num, next_type = _next_punch(emp, d)
    return Response({
        "date": str(d),
        "punches": [
            {
                "punchTime": log.punch_time.strftime("%H:%M:%S"),
                "punchType": log.punch_type,
                "source": log.source,
                "sourceLabel": source_label(log.source),
            }
            for log in logs
        ],
        "onDutyRequests": [_on_duty_request_dict(r) for r in requests_qs],
        "nextPunchNumber": punch_num,
        "nextPunchType": next_type,
    })


@api_view(["POST"])
@require_auth
def live_location_ping(request: Request) -> Response:
    """
    POST /api/live-location/ping — JSON {latitude, longitude, accuracy?, isMocked?}
    Only accepted while Employee.location_tracking_enabled is true — the app
    should stop its ping loop the moment it sees this 403 back, since it
    means HR turned tracking off for this employee.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)
    if not emp.location_tracking_enabled:
        return Response(
            {"error": "Location tracking is not enabled for your account", "code": "TRACKING_DISABLED"},
            status=403,
        )

    data = request.data
    try:
        lat = float(data.get("latitude"))
        lng = float(data.get("longitude"))
    except (TypeError, ValueError):
        return _error("latitude and longitude are required")
    accuracy = data.get("accuracy")
    try:
        accuracy = float(accuracy) if accuracy not in (None, "") else None
    except (TypeError, ValueError):
        accuracy = None
    is_mocked = _get_is_mocked(data)

    LiveLocationPing.objects.create(
        employee=emp, latitude=lat, longitude=lng, accuracy_m=accuracy, is_mocked=is_mocked,
    )
    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    LiveLocationPing.objects.filter(employee=emp, recorded_at__lt=cutoff).delete()
    return Response({"ok": True}, status=201)


# ── HR-facing (dashboard) ────────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def on_duty_requests_hr(request: Request) -> Response:
    """GET /api/on-duty-requests?status=pending|pending_hod|pending_hr|approved|rejected|all
    — branch-scoped. "pending" (the default) covers both pending_hod and
    pending_hr so HR's Pending Approvals tab sees everything awaiting either
    stage in one list."""
    status_filter = request.query_params.get("status", "pending")
    qs = OnDutyRequest.objects.select_related(
        "employee__department", "employee__designation", "branch"
    )
    qs = scope_to_branch(qs, request)  # OnDutyRequest.branch_id is a direct field
    if status_filter == "pending":
        qs = qs.filter(status__in=[OnDutyRequest.STATUS_PENDING_HOD, OnDutyRequest.STATUS_PENDING_HR])
    elif status_filter != "all":
        qs = qs.filter(status=status_filter)
    qs = qs.order_by("-created_at")[:200]
    return Response([_on_duty_request_dict(r) for r in qs])


@api_view(["PATCH"])
@require_hr
def on_duty_request_hr_status(request: Request, pk: int) -> Response:
    """
    PATCH /api/on-duty-requests/<pk>/status — HR's decision. Works on a
    request at EITHER stage: if it's still pending_hod (Department Head
    hasn't acted, or there isn't one), HR's decision finalizes it directly
    in one step; if it's pending_hr, this is the normal second-stage
    approval. Either way resolve_on_duty_hr() writes the punch identically.
    """
    req = scope_to_branch(
        OnDutyRequest.objects.select_related("employee__department", "employee__designation", "branch"),
        request,
    ).filter(pk=pk).first()
    if not req:
        return _error("On-Duty request not found", 404)
    if req.status not in (OnDutyRequest.STATUS_PENDING_HOD, OnDutyRequest.STATUS_PENDING_HR):
        return _error(f"This request was already {req.status}")

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return _error("status must be 'approved' or 'rejected'")

    reviewer_name = request.jwt_user.get("name") or "HR"
    resolve_on_duty_hr(req, status_val, reviewer_name, request.data.get("comment"))
    return Response(_on_duty_request_dict(req))


@api_view(["GET"])
@require_auth
def on_duty_request_photo(request: Request, pk: int, n: int) -> Response:
    """GET /api/on-duty-requests/<pk>/photo/<1|2> — owner, branch-scoped HR,
    or a Department Head with this employee in their approval scope."""
    from django.db.models import Q
    from .models import DepartmentManager

    req = OnDutyRequest.objects.select_related("employee").filter(pk=pk).first()
    if not req:
        return _error("Request not found", 404)

    owner_employee_id = get_token_employee_id(request)
    allowed = False
    if owner_employee_id == req.employee_id:
        allowed = True
    elif is_hr(request):
        allowed = scope_to_branch(Employee.objects, request).filter(pk=req.employee_id).exists()
    elif owner_employee_id:
        allowed = DepartmentManager.objects.filter(
            Q(employee_assignments__employee_id=req.employee_id)
            | Q(department_assignments__department_id=req.employee.department_id),
            employee_id=owner_employee_id, is_active=True,
        ).exists()
    if not allowed:
        return _error("Access denied", 403)

    photo = req.photo1 if n == 1 else req.photo2 if n == 2 else None
    if not photo:
        return _error("Photo not found", 404)
    return FileResponse(photo.open("rb"))


@api_view(["GET"])
@require_hr
def live_location_team(request: Request) -> Response:
    """GET /api/live-location/team — latest ping per tracking-enabled employee, branch-scoped.
    Also flags whether each employee has an active On-Duty request today, so
    the Live Map can render On-Duty staff in a distinct color."""
    employees = scope_to_branch(
        Employee.objects.select_related("department", "branch"), request
    ).filter(location_tracking_enabled=True, status="active")

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    today = date.today()
    on_duty_emp_ids = set(
        OnDutyRequest.objects.filter(
            punch_date=today,
            status__in=[OnDutyRequest.STATUS_PENDING_HOD, OnDutyRequest.STATUS_PENDING_HR, OnDutyRequest.STATUS_APPROVED],
        ).values_list("employee_id", flat=True)
    )
    out = []
    for emp in employees:
        latest = emp.location_pings.filter(recorded_at__gte=cutoff).order_by("-recorded_at").first()
        out.append({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "branchName": emp.branch.name if emp.branch_id and emp.branch else None,
            "latitude": float(latest.latitude) if latest else None,
            "longitude": float(latest.longitude) if latest else None,
            "isMocked": latest.is_mocked if latest else False,
            "lastSeenAt": latest.recorded_at.isoformat() if latest else None,
            "isOnDutyToday": emp.id in on_duty_emp_ids,
        })
    return Response(out)


@api_view(["GET"])
@require_hr
def live_location_trail(request: Request, employee_id: int) -> Response:
    """GET /api/live-location/team/<employee_id>/trail — today-so-far breadcrumb trail for one employee."""
    emp = scope_to_branch(Employee.objects, request).filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)
    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    pings = emp.location_pings.filter(recorded_at__gte=cutoff).order_by("recorded_at")
    return Response([
        {
            "latitude": float(p.latitude), "longitude": float(p.longitude),
            "recordedAt": p.recorded_at.isoformat(), "isMocked": p.is_mocked,
        }
        for p in pings
    ])


@api_view(["GET"])
@require_hr
def live_location_route(request: Request, employee_id: int) -> Response:
    """GET /api/live-location/team/<employee_id>/route?date=YYYY-MM-DD (defaults today)
    Full-day breadcrumb trail for the Route Map tab — like trail() above but
    scoped to a specific calendar day within the retention window, ordered
    for drawing a directional path rather than just "latest position"."""
    emp = scope_to_branch(Employee.objects, request).filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)

    date_str = request.query_params.get("date")
    d = date.today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return _error("Invalid date format")

    day_start, day_end = _day_bounds_utc(d)
    pings = emp.location_pings.filter(recorded_at__gte=day_start, recorded_at__lt=day_end).order_by("recorded_at")
    points = [
        {
            "latitude": float(p.latitude), "longitude": float(p.longitude),
            "recordedAt": p.recorded_at.isoformat(), "isMocked": p.is_mocked,
        }
        for p in pings
    ]
    return Response({
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "date": str(d),
        "points": points,
    })


@api_view(["GET"])
@require_hr
def on_duty_map(request: Request) -> Response:
    """GET /api/on-duty-map?date=YYYY-MM-DD (defaults today) — branch-scoped.
    Every employee with an On-Duty request on the given day, each with their
    current live position (if location tracking is enabled) and today's
    route points, for the dedicated On-Duty Map tab."""
    date_str = request.query_params.get("date")
    d = date.today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return _error("Invalid date format")

    reqs = scope_to_branch(
        OnDutyRequest.objects.select_related("employee__department", "employee__branch", "branch"),
        request,
    ).filter(punch_date=d).order_by("employee_id", "punch_time")

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    day_start, day_end = _day_bounds_utc(d)

    by_employee: dict[int, dict] = {}
    for r in reqs:
        emp = r.employee
        entry = by_employee.get(emp.id)
        if entry is None:
            latest = None
            points = []
            if emp.location_tracking_enabled:
                latest = emp.location_pings.filter(recorded_at__gte=cutoff).order_by("-recorded_at").first()
                points = [
                    {"latitude": float(p.latitude), "longitude": float(p.longitude), "recordedAt": p.recorded_at.isoformat()}
                    for p in emp.location_pings.filter(recorded_at__gte=day_start, recorded_at__lt=day_end).order_by("recorded_at")
                ]
            entry = {
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name} {emp.last_name}",
                "department": emp.department.name if emp.department_id and emp.department else None,
                "locationTrackingEnabled": emp.location_tracking_enabled,
                "latitude": float(latest.latitude) if latest else None,
                "longitude": float(latest.longitude) if latest else None,
                "lastSeenAt": latest.recorded_at.isoformat() if latest else None,
                "routePoints": points,
                "requests": [],
            }
            by_employee[emp.id] = entry
        entry["requests"].append({
            "id": r.id, "punchType": r.punch_type, "punchTime": r.punch_time.strftime("%H:%M:%S"),
            "reason": r.reason, "status": r.status,
        })

    return Response({"date": str(d), "employees": list(by_employee.values())})
