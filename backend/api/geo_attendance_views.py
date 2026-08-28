"""
Geo Attendance -location-based punching + live location tracking
====================================================================
Independent capabilities, all opt-in and additive to the existing
biometric-first attendance system (never modifies biometric_sync.py, the
payroll engine, or AttendanceDayRecord computation):

1. Office Geo Punch (Inside Company Radius): an alternative to biometric
   punching for staff physically on-premises. No photos, no approval step —
   inside the branch's geofence, the punch is written immediately through
   the exact same _ingest_punches() path biometric sync and Excel import
   already share, tagged source="geo:auto". Outside the fence, the punch is
   hard-rejected (nothing is recorded). Also blocked outright while the
   employee has an ACTIVE On-Duty session (see below) -they're expected to
   be off-site, so their punches route through the On-Duty verification
   flow instead.

2. On-Duty Attendance: for employees working away from the branch (field
   visits, drivers, offsite work). This reuses the SAME 4-punches-per-day
   attendance system every other source uses -it does not add a separate
   on-duty punch count -split into two layers:
     a. OnDutySession -a lightweight gate. The employee submits just a
        destination (no photos/GPS at this stage) and it goes through the
        existing two-stage chain:
          - pending_hod -> Department Head approves/rejects
            (mobile Approvals screen, manager_views.py::manager_update_on_duty_status)
          - pending_hr  -> HR gives the final approval
        A HOD rejection is terminal; HR may also act on a still-pending_hod
        session as a fallback (no Department Head assigned), collapsing
        straight to active/rejected. Approval flips status to "active" and
        stamps started_at -this is what gates live-location tracking
        (live_location_ping) and routes the employee's regular attendance
        punches through the photo+GPS verification flow below instead of a
        plain punch.
     b. OnDutyPunchVerification -one of the day's (up to 4) attendance
        punches, captured with a selfie + GPS + the ORIGINAL time while the
        session is active. Held "pending" until HR approves it (the fraud
        check an unsupervised off-site punch needs, unlike Office/biometric)
        -only then is it written via the shared _ingest_punches() path,
        tagged "on_duty:approved". Approving the day's 4th punch also
        auto-completes the parent session. The employee can also end the
        session manually at any point via "Mark as Done" -nobody else can
        end it early.

3. Live location tracking: opt-in either by Employee.location_tracking_enabled
   (HR's manual per-employee toggle) OR by having an active OnDutySession —
   the app only sends pings when one of those is true. Pings are append-only
   and self-prune past PING_RETENTION_HOURS on every write (no cron/Celery
   in this project) -kept long enough (72h) to back both the Live Map's
   "current position" and the Route Map's "today/yesterday's travel path".

Same conventions as the rest of this codebase: plain @api_view + @require_hr
/@require_auth functions, no serializers/viewsets, camelCase response JSON,
branch scoping via scope_to_branch for every HR-facing list/action.
"""
from datetime import date, datetime, time, timedelta, timezone as dt_timezone

from django.core.files.base import ContentFile
from django.db.models import Q
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
from .models import (
    AttendanceLog, DepartmentManager, Employee, LiveLocationPing, Notification,
    OnDutyPunchVerification, OnDutySession,
)

ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png"}
MAX_PHOTO_BYTES = 8 * 1024 * 1024  # 8MB
DEFAULT_RADIUS_M = 200
PING_RETENTION_HOURS = 72
IST_OFFSET = timedelta(hours=5, minutes=30)


def _error(msg: str, code: int = 400) -> Response:
    return Response({"error": msg}, status=code)


def source_label(source: str) -> str:
    """Human-facing label for an AttendanceLog.source tag -shared across the
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
    if source == "missing_punch:approved":
        return "Missing Punch"
    if source == "manual":
        return "HR Entry"
    return source.replace("_", " ").replace(":", " ").title()


# ── Shared helpers ──────────────────────────────────────────────────────────

def _extra_punch(emp: Employee, d) -> tuple[int, str]:
    """(sequence number, IN/OUT) for an UNCAPPED punch -used by Office Geo
    Punch, which records every punch an employee makes rather than stopping
    at four.

    The 4-punch model still governs pay: shift_engine derives punch1-4
    semantically (first punch of the day, the midday one, the next after it,
    the last of the day), so punches in between are captured as evidence and
    simply not selected. This function only numbers them; it never widens
    what payroll counts.

    Type keeps alternating IN/OUT off the running count, so punch 5 is an IN,
    6 an OUT, and so on -the same rhythm the first four follow."""
    count = (
        AttendanceLog.objects.filter(employee=emp, date=d).count()
        + OnDutyPunchVerification.objects.filter(
            employee=emp, punch_date=d, status=OnDutyPunchVerification.STATUS_PENDING,
        ).count()
    )
    punch_type = AttendanceLog.PUNCH_IN if count % 2 == 0 else AttendanceLog.PUNCH_OUT
    return count + 1, punch_type


def _next_punch(emp: Employee, d) -> tuple[int | None, str | None]:
    """(punch number 1-4, IN/OUT) for the next punch this employee can make
    today, across every source (biometric + geo + on-duty combined) -mirrors
    the strict 4-punch engine's IN/OUT/IN/OUT pairing. None once 4 are taken.

    Counts on-duty punches still awaiting approval as well as recorded ones.
    They have not reached AttendanceLog yet, but they have taken their slot
    in the day -without them an employee punching several times before HR
    reviews any of it would get #1/IN back every single time."""
    count = (
        AttendanceLog.objects.filter(employee=emp, date=d).count()
        + OnDutyPunchVerification.objects.filter(
            employee=emp, punch_date=d, status=OnDutyPunchVerification.STATUS_PENDING,
        ).count()
    )
    if count >= 4:
        return None, None
    punch_type = AttendanceLog.PUNCH_IN if count % 2 == 0 else AttendanceLog.PUNCH_OUT
    return count + 1, punch_type


ON_DUTY_SLOTS = (1, 2, 3, 4)


def _slot_punch_type(slot: int) -> str:
    """Slot parity fixes the type: IN/OUT/IN/OUT, same pairing the strict
    4-punch engine expects. Slot 3 is an IN whether or not slots 1-2 were
    ever filled, so a missed punch never inverts the rest of the day."""
    return AttendanceLog.PUNCH_IN if slot % 2 == 1 else AttendanceLog.PUNCH_OUT


def _taken_slots(emp: Employee, d) -> dict[int, str]:
    """{slot number: what holds it} for one employee-day.

    On-duty punches carry an explicit punch_number, so they hold exactly the
    slot the employee chose -including out of order. Punches from any other
    source (biometric, Office Geo Punch) have no slot of their own, so they
    fill the lowest free slots in time order."""
    taken: dict[int, str] = {}
    for v in OnDutyPunchVerification.objects.filter(
        employee=emp, punch_date=d,
        status__in=[OnDutyPunchVerification.STATUS_PENDING, OnDutyPunchVerification.STATUS_APPROVED],
    ):
        if v.punch_number in ON_DUTY_SLOTS:
            taken[v.punch_number] = v.status  # "pending" | "approved"

    others = (
        AttendanceLog.objects
        .filter(employee=emp, date=d)
        .exclude(source="on_duty:approved")  # already counted above, via its verification
        .order_by("punch_time")
    )
    for _ in others:
        for n in ON_DUTY_SLOTS:
            if n not in taken:
                taken[n] = "recorded"
                break
    return taken


def _slot_dicts(emp: Employee, d) -> list[dict]:
    """All 4 slots with their state, for the app to render one row each —
    a filled slot shows its status, a free one offers "add my punch"."""
    taken = _taken_slots(emp, d)
    return [
        {
            "punchNumber": n,
            "punchType": _slot_punch_type(n),
            "status": taken.get(n, "available"),
            "available": n not in taken,
        }
        for n in ON_DUTY_SLOTS
    ]


def _end_on_duty_session(session: OnDutySession, reason: str) -> bool:
    """Close a session for the day. Returns True if it changed anything.

    A session still awaiting approval is closed by stamping
    employee_ended_at only -it stops being punchable but stays in HR's
    queue, because ending the day is not the same as deciding the request."""
    if session.employee_ended_at or session.status not in PUNCHABLE_STATUSES:
        return False
    now = timezone.now()
    session.employee_ended_at = now
    if _is_provisional(session):
        session.save(update_fields=["employee_ended_at"])
    else:
        session.status = OnDutySession.STATUS_COMPLETED
        session.completed_at = now
        session.completed_by = "system"
        session.completion_reason = reason
        session.save()
    return True


def _employee_from_token(request: Request) -> Employee | None:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return None
    return Employee.objects.select_related("branch").filter(pk=emp_id).first()


def _get_is_mocked(data) -> bool:
    """The mobile app's axios client auto-decamelizes JSON request bodies
    (isMocked -> is_mocked) before they hit the wire, but doesn't touch
    multipart/FormData bodies -the web app and HR portal never decamelize
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
    server's clock is IST (the project-wide convention -see punch_date/
    punch_time everywhere else), but LiveLocationPing.recorded_at is a real,
    correct UTC instant (timezone.now(), unlike the naive date.today()/
    datetime.now() used for punch dates) -so building the day boundary
    requires the explicit IST offset rather than a naive date comparison."""
    start_naive = datetime.combine(d, time.min)
    start_utc = start_naive - IST_OFFSET
    end_utc = start_utc + timedelta(days=1)
    return timezone.make_aware(start_utc, dt_timezone.utc), timezone.make_aware(end_utc, dt_timezone.utc)


# The three states in which the employee is out doing on-duty work, whether
# or not HR has blessed it yet. Approval is a payroll-side decision; it is
# NOT a gate the employee waits behind.
PUNCHABLE_STATUSES = [
    OnDutySession.STATUS_PENDING_HOD,
    OnDutySession.STATUS_PENDING_HR,
    OnDutySession.STATUS_ACTIVE,
]


def _active_on_duty_session(emp: Employee) -> OnDutySession | None:
    return OnDutySession.objects.filter(employee=emp, status=OnDutySession.STATUS_ACTIVE).order_by("-started_at").first()


def _punchable_on_duty_session(emp: Employee) -> OnDutySession | None:
    """The session the employee is currently working under -pending ones
    included. This is the gate for punching, live tracking, and the
    Office-Geo-Punch lockout, all of which must engage the instant the
    request is submitted rather than when HR gets around to it.

    Deliberately excludes a session the employee has already marked Done
    (employee_ended_at set) even while its status is still pending: their
    day is over, so no further punches belong to it."""
    return (
        OnDutySession.objects
        .filter(employee=emp, status__in=PUNCHABLE_STATUSES, employee_ended_at__isnull=True)
        .order_by("-created_at")
        .first()
    )


def _is_provisional(session: OnDutySession) -> bool:
    """Submitted and being worked, but not yet HR-approved."""
    return session.status in (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR)


def _approve_session_punches(session: OnDutySession, reviewer_name: str) -> int:
    """Approve every still-pending punch this session captured, in capture
    order, writing each into AttendanceLog at its ORIGINAL time.

    This is what makes the On-Duty request the single unit of approval: HR
    decides once on the request, and the whole day's punches follow. Ordered
    by punch_number so the IN/OUT sequence lands the way it was recorded."""
    pending = list(
        session.punch_verifications
        .filter(status=OnDutyPunchVerification.STATUS_PENDING)
        .order_by("punch_number", "punch_time")
    )
    for v in pending:
        resolve_on_duty_punch_hr(v, "approved", reviewer_name, None, notify=False)
    return len(pending)


def _void_session_punches(session: OnDutySession, reviewer_name: str, stage: str) -> int:
    """Reject every still-pending punch this session captured. Called on any
    rejection, at either approval stage.

    Safe by construction: a pending verification has never been written to
    AttendanceLog (resolve_on_duty_punch_hr is the only path there, and
    on_duty_punch_verification_hr_status refuses to run it while the session
    is provisional). So voiding here invalidates the day's punches without
    ever having to delete real attendance rows."""
    pending = list(session.punch_verifications.filter(status=OnDutyPunchVerification.STATUS_PENDING))
    if not pending:
        return 0
    now = timezone.now()
    for v in pending:
        v.status = OnDutyPunchVerification.STATUS_REJECTED
        v.hr_reviewed_by = reviewer_name
        v.hr_reviewed_at = now
        v.hr_review_comment = f"Voided automatically -the On-Duty request was rejected by {stage}."
        v.save(update_fields=["status", "hr_reviewed_by", "hr_reviewed_at", "hr_review_comment"])
    return len(pending)


def _current_on_duty_session(emp: Employee) -> OnDutySession | None:
    """The session most relevant to show the employee right now: whichever
    is pending/active, else today's most recently completed/rejected one
    (so the app can show "session ended" instead of going blank)."""
    live = OnDutySession.objects.filter(
        employee=emp,
        status__in=[OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR, OnDutySession.STATUS_ACTIVE],
    ).order_by("-created_at").first()
    if live:
        return live
    today = date.today()
    return OnDutySession.objects.filter(
        employee=emp, status__in=[OnDutySession.STATUS_COMPLETED, OnDutySession.STATUS_REJECTED],
        created_at__date=today,
    ).order_by("-created_at").first()


def _on_duty_session_dict(session: OnDutySession, *, for_employee: bool = False) -> dict:
    """HR/HOD callers get the literal database status. Employee-facing
    callers (for_employee=True) get a provisional session presented as
    "active", because the employee is cleared to work the moment they
    submit -the pending state is an HRMS-side concern they neither wait for
    nor need to see. The real value is always available alongside it as
    `approvalStatus`, so nothing is hidden, only re-framed for the audience."""
    emp = session.employee
    provisional = _is_provisional(session)
    display_status = (
        OnDutySession.STATUS_ACTIVE if (for_employee and provisional and not session.employee_ended_at)
        else OnDutySession.STATUS_COMPLETED if (for_employee and provisional and session.employee_ended_at)
        else session.status
    )
    return {
        "id": session.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "destination": session.destination,
        "branchId": session.branch_id,
        "branchName": session.branch.name if session.branch_id and session.branch else None,
        "status": display_status,
        # Always the true database status, for both audiences. HR reads this
        # for the decision queue; the app can use it to show a quiet
        # "awaiting approval" note without gating anything on it.
        "approvalStatus": session.status,
        "isProvisional": provisional,
        # What HR is actually deciding about: punches already captured under
        # a request nobody has approved yet, every one of which is voided if
        # they reject.
        "pendingPunchCount": session.punch_verifications.filter(
            status=OnDutyPunchVerification.STATUS_PENDING
        ).count(),
        "employeeEndedAt": session.employee_ended_at.isoformat() if session.employee_ended_at else None,
        "hodReviewedBy": session.hod_reviewed_by,
        "hodReviewComment": session.hod_review_comment,
        "hodReviewedAt": session.hod_reviewed_at.isoformat() if session.hod_reviewed_at else None,
        "hrReviewedBy": session.hr_reviewed_by,
        "hrReviewComment": session.hr_review_comment,
        "hrReviewedAt": session.hr_reviewed_at.isoformat() if session.hr_reviewed_at else None,
        "startedAt": session.started_at.isoformat() if session.started_at else None,
        "completedAt": session.completed_at.isoformat() if session.completed_at else None,
        "completedBy": session.completed_by,
        "completionReason": session.completion_reason,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
    }


def _on_duty_punch_verification_dict(v: OnDutyPunchVerification) -> dict:
    emp = v.employee
    return {
        "id": v.id,
        "sessionId": v.session_id,
        # Whether this punch is even approvable yet. A punch captured under a
        # still-pending request can't become attendance until that request is
        # approved, so the UI needs to know rather than discovering it from a
        # rejected save.
        "sessionStatus": v.session.status,
        "sessionApproved": not _is_provisional(v.session),
        "sessionDestination": v.session.destination,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "department": emp.department.name if emp.department_id and emp.department else None,
        "punchDate": str(v.punch_date),
        "punchTime": v.punch_time.strftime("%H:%M:%S"),
        "punchType": v.punch_type,
        "punchNumber": v.punch_number,
        "latitude": float(v.latitude),
        "longitude": float(v.longitude),
        "accuracyM": v.accuracy_m,
        "isMocked": v.is_mocked,
        "hasPhoto": bool(v.photo),
        "status": v.status,
        "hrReviewedBy": v.hr_reviewed_by,
        "hrReviewComment": v.hr_review_comment,
        "hrReviewedAt": v.hr_reviewed_at.isoformat() if v.hr_reviewed_at else None,
        "createdAt": v.created_at.isoformat() if v.created_at else None,
    }


def resolve_on_duty_session_hod(session: OnDutySession, decision: str, reviewer_name: str, comment: str | None) -> None:
    """
    Stage 1 -Department Head decision on the destination request. Called
    from manager_views.py::manager_update_on_duty_status. Approval moves the
    session to pending_hr; rejection is terminal -HR never sees it.
    """
    session.status = OnDutySession.STATUS_PENDING_HR if decision == "approved" else OnDutySession.STATUS_REJECTED
    session.hod_reviewed_by = reviewer_name
    session.hod_reviewed_at = timezone.now()
    if comment:
        session.hod_review_comment = comment
    session.save()
    if decision == "approved":
        message = f"Your On-Duty request for {session.destination} was approved by your Department Head and is now awaiting HR approval."
    else:
        # Terminal rejection -the employee may already have worked and
        # punched all day under this request. Those punches never reached
        # AttendanceLog, and now never will.
        voided = _void_session_punches(session, reviewer_name, "your Department Head")
        message = f"Your On-Duty request for {session.destination} was rejected by your Department Head."
        if voided:
            message += f" The {voided} punch(es) you recorded under it are not valid and have not been counted."
    Notification.objects.create(employee=session.employee, type="on_duty", message=message)


def resolve_on_duty_session_hr(session: OnDutySession, decision: str, reviewer_name: str, comment: str | None) -> None:
    """
    Stage 2 -HR's final decision. Called both for a session already at
    pending_hr (the normal path) and directly on a still-pending_hod session
    (HR's fallback when there's no Department Head to act, or they haven't).
    Approval starts the session (status=active, started_at=now) -this is
    what live_location_ping and the mobile on-duty punch flow key off of.
    """
    if decision == "approved":
        session.started_at = session.started_at or session.created_at
        if session.employee_ended_at:
            # The employee already worked and closed out the day while this
            # sat in the queue -approving it retroactively should land on
            # "completed", not re-open a finished session as active.
            session.status = OnDutySession.STATUS_COMPLETED
            session.completed_at = session.employee_ended_at
            session.completed_by = "employee"
            session.completion_reason = OnDutySession.COMPLETION_MANUAL
        else:
            session.status = OnDutySession.STATUS_ACTIVE
    else:
        session.status = OnDutySession.STATUS_REJECTED
    session.hr_reviewed_by = reviewer_name
    session.hr_reviewed_at = timezone.now()
    if comment:
        session.hr_review_comment = comment
    session.save()
    if decision == "approved":
        # One decision, one card: approving the request accepts every punch
        # captured under it as real attendance.
        approved = _approve_session_punches(session, reviewer_name)
        message = f"Your On-Duty request for {session.destination} was approved by HR."
        message += (
            f" Your {approved} recorded punch(es) have been accepted as attendance."
            if approved else " You can now begin."
        )
    else:
        voided = _void_session_punches(session, reviewer_name, "HR")
        message = f"Your On-Duty request for {session.destination} was rejected by HR."
        if voided:
            message += f" The {voided} punch(es) you recorded under it are not valid and have not been counted."
    Notification.objects.create(employee=session.employee, type="on_duty", message=message)


def resolve_on_duty_punch_hr(
    v: OnDutyPunchVerification, decision: str, reviewer_name: str, comment: str | None,
    notify: bool = True,
) -> None:
    """
    HR's single-stage decision on a captured on-duty punch. Approval writes
    the punch via the same shared ingestion path every other source uses, at
    the ORIGINAL captured time -never the approval time. Callers must not
    approve while the parent session is still provisional (see
    on_duty_punch_verification_hr_status) -that guard is what guarantees a
    rejected On-Duty request can never leave real attendance behind. If this is the
    day's 4th punch, approving it also auto-completes the parent session (a
    still-active session only -a manually-completed one is left alone).
    Rejection just leaves the punch slot open for the employee to retry.
    """
    if decision == "approved":
        _ingest_punches(
            [(v.employee.employee_code, v.punch_date, v.punch_time, v.punch_type)],
            None,
            "on_duty:approved",
        )
        v.status = OnDutyPunchVerification.STATUS_APPROVED
    else:
        v.status = OnDutyPunchVerification.STATUS_REJECTED
    v.hr_reviewed_by = reviewer_name
    v.hr_reviewed_at = timezone.now()
    if comment:
        v.hr_review_comment = comment
    v.save()

    if notify:
        # Suppressed for bulk runs -the caller sends one summary notification
        # for the whole request instead of four near-identical pings.
        punch_label = "Check-In" if v.punch_type == AttendanceLog.PUNCH_IN else "Check-Out"
        Notification.objects.create(
            employee=v.employee, type="on_duty",
            message=f"Your On-Duty {punch_label} (punch {v.punch_number}) was {v.status} by HR.",
        )

    # Live recount, not the frozen `v.punch_number` -that number was assigned
    # from whatever was in AttendanceLog at the moment this punch was
    # CAPTURED (see _next_punch), which can go stale if biometric sync
    # backfills an earlier punch for the same day before this one gets
    # approved. Re-deriving from the actual current count is the only way
    # to know reliably whether today's 4th punch has really landed.
    day_punch_count = AttendanceLog.objects.filter(employee=v.employee, date=v.punch_date).count()
    if decision == "approved" and day_punch_count >= 4:
        session = v.session
        if session.status == OnDutySession.STATUS_ACTIVE:
            session.status = OnDutySession.STATUS_COMPLETED
            session.completed_at = timezone.now()
            session.completed_by = "system"
            session.completion_reason = OnDutySession.COMPLETION_AUTO_4TH_PUNCH
            session.save()
            Notification.objects.create(
                employee=v.employee, type="on_duty",
                message="Your On-Duty session was automatically completed after your 4th punch was approved.",
            )


def _notify_hod_approvers(session: OnDutySession) -> None:
    """Push a Notification to every active Department Head covering this
    employee with on-duty approval enabled. HR always sees the request too,
    via the Pending Approvals tab on the HR dashboard (no push needed there —
    HRUser accounts aren't push-token-registered, only employees are)."""
    emp = session.employee
    managers = DepartmentManager.objects.select_related("employee").filter(
        Q(employee_assignments__employee_id=emp.id) | Q(department_assignments__department_id=emp.department_id),
        is_active=True,
        can_approve_on_duty=True,
    ).distinct()
    for m in managers:
        Notification.objects.create(
            employee=m.employee,
            type="on_duty",
            message=f"{emp.first_name} {emp.last_name} submitted an On-Duty request -{session.destination[:80]}",
        )


# ── Employee-facing: Office Geo Punch (Type 1) ──────────────────────────────

@api_view(["GET"])
@require_auth
def geo_punch_precheck(request: Request) -> Response:
    """
    GET /api/attendance/geo-punch/precheck?latitude=..&longitude=..
    Read-only status check -no punch is written. Lets the app clearly show
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
        return _error("Your branch has no location configured -ask HR to set it up in Manage Branch")

    distance = haversine_distance_m(lat, lng, float(branch.geofence_lat), float(branch.geofence_lng))
    radius = branch.geofence_radius_m or DEFAULT_RADIUS_M
    inside = distance <= radius

    today = date.today()
    punch_num, punch_type = _extra_punch(emp, today)
    active_session = _punchable_on_duty_session(emp)

    return Response({
        "insideRadius": inside,
        "distanceM": round(distance),
        "radiusM": radius,
        "branchName": branch.name,
        "nextPunchNumber": punch_num,
        "nextPunchType": punch_type,
        "activeOnDutySession": active_session is not None,
        "message": (
            "You have an active On-Duty session -use the On-Duty page to punch instead of Office Geo Punch."
            if active_session else
            f"You are inside the allowed company radius ({round(distance)}m from {branch.name})."
            if inside else
            f"You are outside the allowed company radius -{round(distance)}m from {branch.name} (allowed: {radius}m)."
        ),
    })


@api_view(["POST"])
@require_auth
def geo_punch(request: Request) -> Response:
    """
    POST /api/attendance/geo-punch -JSON {latitude, longitude, accuracy?, isMocked?}
    Office Geo Punch: an alternative to biometric punching for staff
    physically on-premises. No photos, no approval step, and no daily cap —
    every punch is recorded. Inside the branch's geofence, the punch is
    written immediately. Outside it, the punch is hard-rejected -nothing is
    recorded. Location is the only gate here. Blocked outright while the employee
    has an active On-Duty session -they should punch from the On-Duty page
    instead, where each punch is photo+GPS verified.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    if _punchable_on_duty_session(emp):
        return _error(
            "You have an active On-Duty session -use the On-Duty page to record your punches instead of Office Geo Punch.",
            409,
        )

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
    # Uncapped on purpose: every punch an employee makes on-premises is worth
    # keeping, even past the fourth. The geofence below is what this endpoint
    # actually enforces -a punch is refused for being in the wrong PLACE,
    # never for being the fifth of the day. Payroll still reads only the 4
    # logical punches (see _extra_punch).
    punch_num, punch_type = _extra_punch(emp, today)

    branch = emp.branch
    if branch is None or branch.geofence_lat is None or branch.geofence_lng is None:
        return _error("Your branch has no location configured -ask HR to set it up in Manage Branch")

    distance = haversine_distance_m(lat, lng, float(branch.geofence_lat), float(branch.geofence_lng))
    radius = branch.geofence_radius_m or DEFAULT_RADIUS_M

    if is_mocked:
        return _error("This looks like a simulated/mock location -Office Geo Punch requires your real GPS location.", 403)

    if distance > radius:
        return Response({
            "status": "rejected",
            "distanceM": round(distance), "radiusM": radius,
            "message": (
                f"You are outside the allowed company radius -{round(distance)}m from {branch.name} "
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


# ── Employee-facing: On-Duty session lifecycle ──────────────────────────────

@api_view(["POST"])
@require_auth
def on_duty_session_request(request: Request) -> Response:
    """
    POST /api/on-duty-sessions/request -JSON {destination}
    Starts the two-stage approval chain for a day of On-Duty work. No
    photos/GPS at this stage -that verification happens per-punch (see
    on_duty_punch_request below).

    The employee does not wait for that chain: the session is punchable and
    trackable the moment it is created, and this response says "active" so
    the app moves straight on. HR's queue still shows it as pending, and
    nothing it captures counts as attendance until HR approves.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    # Only a session they're still working blocks a new one. A finished
    # session that HR simply hasn't reviewed yet must NOT block tomorrow's
    # request -under provisional start, "pending" can now mean "worked,
    # done, and waiting on paperwork", which could otherwise lock the
    # employee out for as long as HR takes to act.
    existing = _punchable_on_duty_session(emp)
    if existing:
        return _error("You already have an On-Duty session in progress", 409)

    destination = (request.data.get("destination") or "").strip()
    if not destination:
        return _error("A destination is required")

    session = OnDutySession.objects.create(employee=emp, destination=destination, branch=emp.branch)
    _notify_hod_approvers(session)

    # "active", not "pending_hod_approval" -the employee is cleared to start
    # working and punching right now. The database still says pending_hod
    # and HR's queue still shows it as pending; only this response is
    # framed for the person standing there waiting to get on with their day.
    return Response({
        "status": "active",
        "approvalStatus": session.status,
        "isProvisional": True,
        "canPunch": True,
        "sessionId": session.id,
        "session": _on_duty_session_dict(session, for_employee=True),
        "message": "Your On-Duty session has started -you can begin punching. HR approval will follow.",
    }, status=201)


@api_view(["POST"])
@require_auth
def on_duty_session_complete(request: Request) -> Response:
    """POST /api/on-duty-sessions/complete -the employee manually marks
    their own active session as Done. Nobody else can end a session early."""
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    session = _punchable_on_duty_session(emp)
    if not session:
        return _error("You don't have an active On-Duty session", 404)

    now = timezone.now()
    session.employee_ended_at = now
    if _is_provisional(session):
        # Their day is over, but HR still hasn't decided -leave `status`
        # alone so the request stays in the approval queue. Marking it
        # completed here would quietly remove HR's chance to reject it and
        # strand the captured punches as pending forever.
        session.save(update_fields=["employee_ended_at"])
    else:
        session.status = OnDutySession.STATUS_COMPLETED
        session.completed_at = now
        session.completed_by = "employee"
        session.completion_reason = OnDutySession.COMPLETION_MANUAL
        session.save()
    return Response(_on_duty_session_dict(session, for_employee=True))


@api_view(["GET"])
@require_auth
def on_duty_session_status(request: Request) -> Response:
    """GET /api/on-duty-sessions/status -the employee's current/most recent
    On-Duty session (pending/active, or today's completed/rejected one) plus
    its punch verifications, for the dedicated On-Duty page."""
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    session = _current_on_duty_session(emp)
    if not session:
        return Response({"session": None, "punchVerifications": []})

    verifications = session.punch_verifications.select_related("session").order_by("punch_number", "created_at")
    return Response({
        "session": _on_duty_session_dict(session, for_employee=True),
        "punchVerifications": [_on_duty_punch_verification_dict(v) for v in verifications],
        # All four slots, each either filled or offering "add my punch" —
        # the app renders one row per slot rather than a single next-punch
        # button, so a missed punch never blocks the ones after it.
        "punchSlots": _slot_dicts(emp, date.today()),
    })


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_auth
def on_duty_punch_request(request: Request) -> Response:
    """
    POST /api/on-duty-sessions/punch -multipart:
      latitude, longitude, accuracy?, isMocked?, photo (file)
    Captures one of the day's (up to 4) attendance punches while an On-Duty
    session is in progress -including one still awaiting approval. Held
    pending until HR approves BOTH the session and this punch; if the
    session is rejected instead, this row is voided by
    _void_session_punches() and never becomes attendance.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    session = _punchable_on_duty_session(emp)
    if not session:
        return _error("You don't have an active On-Duty session", 404)

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

    photo = request.FILES.get("photo")
    if not photo:
        return _error("A selfie photo is required to verify this punch")
    ext = photo.name.rsplit(".", 1)[-1].lower() if "." in photo.name else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        return _error(f"Unsupported photo type '.{ext}' -only JPG and PNG are accepted")
    if photo.size > MAX_PHOTO_BYTES:
        return _error(f"Photo is too large ({photo.size / 1024 / 1024:.1f}MB) -the limit is 8MB")

    today = date.today()
    now_time = datetime.now().time().replace(microsecond=0)

    taken = _taken_slots(emp, today)
    available = [n for n in ON_DUTY_SLOTS if n not in taken]
    if not available:
        return _error("All 4 punches have already been recorded for today")

    # The employee chooses which of the day's four punches this is. Omitting
    # it keeps the old behaviour (next free slot), so an app that hasn't been
    # updated still works unchanged.
    requested = data.get("punchNumber", data.get("punch_number"))
    if requested in (None, ""):
        punch_num = available[0]
    else:
        try:
            punch_num = int(requested)
        except (TypeError, ValueError):
            return _error("punchNumber must be a whole number from 1 to 4")
        if punch_num not in ON_DUTY_SLOTS:
            return _error("punchNumber must be a whole number from 1 to 4")
        if punch_num in taken:
            already = taken[punch_num]
            return _error(
                f"Punch {punch_num} has already been "
                + ("recorded" if already == "recorded" else f"submitted and is {already}")
                + " today.",
                409,
            )
    punch_type = _slot_punch_type(punch_num)

    v = OnDutyPunchVerification(
        session=session, employee=emp, punch_date=today, punch_time=now_time,
        punch_type=punch_type, punch_number=punch_num,
        latitude=lat, longitude=lng, accuracy_m=accuracy, is_mocked=is_mocked,
    )
    v.photo.save(photo.name, ContentFile(photo.read()), save=False)
    v.save()

    # Four punches is a full day -close the session now, at capture, rather
    # than waiting for HR to approve the fourth. The employee is done.
    session_ended = False
    if len(available) == 1:
        session_ended = _end_on_duty_session(session, OnDutySession.COMPLETION_AUTO_4TH_PUNCH)
        if session_ended:
            Notification.objects.create(
                employee=emp, type="on_duty",
                message="Your On-Duty session ended automatically -all 4 punches for the day are in.",
            )

    return Response({
        "status": "pending_hr_approval", "verificationId": v.id,
        "punchNumber": punch_num, "punchType": punch_type,
        "sessionEnded": session_ended,
        "punchSlots": _slot_dicts(emp, today),
    }, status=201)


@api_view(["GET"])
@require_auth
def geo_punch_status(request: Request) -> Response:
    """GET /api/attendance/geo-punch/status?date=YYYY-MM-DD (defaults to today)
    Today's recorded punches (any source) + a lightweight snapshot of the
    employee's current On-Duty session (full detail lives at
    on_duty_session_status) -used by the compact status banners on the
    Attendance page and home screen."""
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
    session = _current_on_duty_session(emp)

    # Uncapped, matching geo_punch itself -this is the number the NEXT punch
    # would get, not a countdown to a limit that no longer exists.
    punch_num, next_type = _extra_punch(emp, d)
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
        "onDutySession": _on_duty_session_dict(session, for_employee=True) if session else None,
        "nextPunchNumber": punch_num,
        "nextPunchType": next_type,
        "punchSlots": _slot_dicts(emp, d),
    })


@api_view(["POST"])
@require_auth
def live_location_ping(request: Request) -> Response:
    """
    POST /api/live-location/ping -JSON {latitude, longitude, accuracy?, isMocked?}
    Accepted while Employee.location_tracking_enabled is true OR the
    employee has an active On-Duty session -the app should stop its ping
    loop the moment it sees this 403 back.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)
    # Tracking starts with the request, not with the approval -the trail it
    # builds is a large part of what HR judges the request on.
    if not emp.location_tracking_enabled and not _punchable_on_duty_session(emp):
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
def on_duty_sessions_hr(request: Request) -> Response:
    """GET /api/on-duty-sessions?status=pending|pending_hod|pending_hr|active|completed|rejected|all
    -branch-scoped. "pending" (the default) covers both pending_hod and
    pending_hr so HR's Pending Approvals tab sees everything awaiting either
    stage in one list."""
    status_filter = request.query_params.get("status", "pending")
    qs = OnDutySession.objects.select_related("employee__department", "employee__designation", "branch")
    qs = scope_to_branch(qs, request)  # OnDutySession.branch_id is a direct field
    if status_filter == "pending":
        qs = qs.filter(status__in=[OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR])
    elif status_filter != "all":
        qs = qs.filter(status=status_filter)
    qs = qs.order_by("-created_at")[:200]
    return Response([_on_duty_session_dict(s) for s in qs])


@api_view(["PATCH"])
@require_hr
def on_duty_session_hr_status(request: Request, pk: int) -> Response:
    """
    PATCH /api/on-duty-sessions/<pk>/status -HR's decision. Works on a
    session at EITHER stage: if it's still pending_hod (Department Head
    hasn't acted, or there isn't one), HR's decision finalizes it directly
    in one step; if it's pending_hr, this is the normal second-stage
    approval.
    """
    session = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__designation", "branch"),
        request,
    ).filter(pk=pk).first()
    if not session:
        return _error("On-Duty session not found", 404)
    if session.status not in (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR):
        return _error(f"This session was already {session.status}")

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return _error("status must be 'approved' or 'rejected'")

    reviewer_name = request.jwt_user.get("name") or "HR"
    resolve_on_duty_session_hr(session, status_val, reviewer_name, request.data.get("comment"))
    return Response(_on_duty_session_dict(session))


@api_view(["GET"])
@require_hr
def on_duty_punch_verifications_hr(request: Request) -> Response:
    """GET /api/on-duty-punch-verifications?status=pending|approved|rejected|all -branch-scoped."""
    status_filter = request.query_params.get("status", "pending")
    qs = OnDutyPunchVerification.objects.select_related("employee__department", "employee__designation", "session")
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    if status_filter != "all":
        qs = qs.filter(status=status_filter)
    qs = qs.order_by("-created_at")[:200]
    return Response([_on_duty_punch_verification_dict(v) for v in qs])


@api_view(["PATCH"])
@require_hr
def on_duty_punch_verification_hr_status(request: Request, pk: int) -> Response:
    """PATCH /api/on-duty-punch-verifications/<pk>/status -HR approves/rejects
    one captured on-duty punch. Single-stage (HR only) -see
    resolve_on_duty_punch_hr() for what happens on approval."""
    v = scope_to_branch(
        OnDutyPunchVerification.objects.select_related("employee__department", "employee__designation", "session"),
        request, field="employee__branch_id",
    ).filter(pk=pk).first()
    if not v:
        return _error("Punch verification not found", 404)
    if v.status != OnDutyPunchVerification.STATUS_PENDING:
        return _error(f"This punch was already {v.status}")

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return _error("status must be 'approved' or 'rejected'")

    # The invariant that makes provisional on-duty safe: a punch cannot
    # become real attendance before its session is approved. Without this,
    # HR could approve a punch and then reject the session under it, leaving
    # an AttendanceLog row behind that the rejection has no way to take back.
    # Rejecting early is always allowed -it never writes anything.
    if status_val == "approved" and _is_provisional(v.session):
        return _error(
            "Approve the On-Duty request itself first -this punch was recorded under a request "
            "that is still awaiting approval, so it can't be counted as attendance yet.",
            409,
        )

    reviewer_name = request.jwt_user.get("name") or "HR"
    resolve_on_duty_punch_hr(v, status_val, reviewer_name, request.data.get("comment"))
    return Response(_on_duty_punch_verification_dict(v))


@api_view(["PATCH"])
@require_hr
def on_duty_session_punches_hr_status(request: Request, pk: int) -> Response:
    """
    PATCH /api/on-duty-sessions/<pk>/punches -one decision for every punch
    still pending under this On-Duty request.

    Covers the punches that arrive AFTER the request itself was approved
    (the employee keeps punching through the day). The request's own
    approval already accepted everything captured up to that moment, so this
    is the same one-card decision applied to the rest, rather than making HR
    click through each punch individually.
    """
    session = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__designation", "branch"),
        request,
    ).filter(pk=pk).first()
    if not session:
        return _error("On-Duty session not found", 404)

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected"):
        return _error("status must be 'approved' or 'rejected'")

    # Same invariant as the single-punch endpoint: nothing becomes attendance
    # while the request it belongs to is unapproved. Decide the request first
    # -that path approves these punches anyway.
    if status_val == "approved" and _is_provisional(session):
        return _error(
            "Approve the On-Duty request itself first -that accepts these punches with it.",
            409,
        )

    reviewer_name = request.jwt_user.get("name") or "HR"
    if status_val == "approved":
        count = _approve_session_punches(session, reviewer_name)
    else:
        count = _void_session_punches(session, reviewer_name, "HR")
    if count:
        Notification.objects.create(
            employee=session.employee, type="on_duty",
            message=(
                f"{count} of your On-Duty punch(es) for {session.destination} were {status_val} by HR."
                + ("" if status_val == "approved" else " They do not count as attendance.")
            ),
        )
    session.refresh_from_db()
    return Response({"updated": count, "session": _on_duty_session_dict(session)})


@api_view(["GET"])
@require_auth
def on_duty_punch_verification_photo(request: Request, pk: int) -> Response:
    """GET /api/on-duty-punch-verifications/<pk>/photo -owner, branch-scoped
    HR, or a Department Head with this employee in their approval scope."""
    v = OnDutyPunchVerification.objects.select_related("employee").filter(pk=pk).first()
    if not v:
        return _error("Punch verification not found", 404)

    owner_employee_id = get_token_employee_id(request)
    allowed = False
    if owner_employee_id == v.employee_id:
        allowed = True
    elif is_hr(request):
        allowed = scope_to_branch(Employee.objects, request).filter(pk=v.employee_id).exists()
    elif owner_employee_id:
        allowed = DepartmentManager.objects.filter(
            Q(employee_assignments__employee_id=v.employee_id)
            | Q(department_assignments__department_id=v.employee.department_id),
            employee_id=owner_employee_id, is_active=True,
        ).exists()
    if not allowed:
        return _error("Access denied", 403)

    if not v.photo:
        return _error("Photo not found", 404)
    return FileResponse(v.photo.open("rb"))


@api_view(["GET"])
@require_hr
def live_location_team(request: Request) -> Response:
    """GET /api/live-location/team -latest ping per tracking-enabled employee, branch-scoped.
    Also flags whether each employee has an active On-Duty session today, so
    the Live Map can render On-Duty staff in a distinct color."""
    employees = scope_to_branch(
        Employee.objects.select_related("department", "branch"), request
    ).filter(location_tracking_enabled=True, status="active")

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    on_duty_emp_ids = set(
        OnDutySession.objects.filter(
            status__in=PUNCHABLE_STATUSES, employee_ended_at__isnull=True,
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
    """GET /api/live-location/team/<employee_id>/trail -today-so-far breadcrumb trail for one employee."""
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
    Full-day breadcrumb trail for the Route Map tab -like trail() above but
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
    """GET /api/on-duty-map?date=YYYY-MM-DD (defaults today) -branch-scoped.
    Every employee with On-Duty activity on the given day (a session opened
    that day, or one still active), each with their current live position
    (if location tracking is enabled), today's route points, and their
    session + punch-verification status, for the dedicated On-Duty Map tab."""
    date_str = request.query_params.get("date")
    d = date.today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return _error("Invalid date format")

    sessions = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__branch", "branch")
        .prefetch_related("punch_verifications"),
        request,
    ).filter(Q(created_at__date=d) | Q(status=OnDutySession.STATUS_ACTIVE)).order_by("employee_id", "-created_at")

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    day_start, day_end = _day_bounds_utc(d)

    by_employee: dict[int, dict] = {}
    for s in sessions:
        emp = s.employee
        if emp.id in by_employee:
            continue  # one entry per employee -most recent session for the day (already ordered)
        latest = None
        points = []
        if emp.location_tracking_enabled:
            latest = emp.location_pings.filter(recorded_at__gte=cutoff).order_by("-recorded_at").first()
            points = [
                {"latitude": float(p.latitude), "longitude": float(p.longitude), "recordedAt": p.recorded_at.isoformat()}
                for p in emp.location_pings.filter(recorded_at__gte=day_start, recorded_at__lt=day_end).order_by("recorded_at")
            ]
        by_employee[emp.id] = {
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "department": emp.department.name if emp.department_id and emp.department else None,
            "locationTrackingEnabled": emp.location_tracking_enabled,
            "latitude": float(latest.latitude) if latest else None,
            "longitude": float(latest.longitude) if latest else None,
            "lastSeenAt": latest.recorded_at.isoformat() if latest else None,
            "routePoints": points,
            "session": {"id": s.id, "destination": s.destination, "status": s.status},
            "punches": [
                {"punchNumber": v.punch_number, "punchType": v.punch_type, "punchTime": v.punch_time.strftime("%H:%M:%S"), "status": v.status}
                for v in s.punch_verifications.order_by("punch_number")
            ],
        }

    return Response({"date": str(d), "employees": list(by_employee.values())})
