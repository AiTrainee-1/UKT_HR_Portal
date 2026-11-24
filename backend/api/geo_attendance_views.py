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
import logging
from datetime import date, datetime, time, timedelta, timezone as dt_timezone

from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count, Prefetch, Q
from django.http import FileResponse
from django.utils import timezone
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, hr_access, whatsapp_notifications
from .view_common import error_response as _error
from .auth import get_token_employee_id, is_hr, require_auth, require_hr
from .biometric_sync import _ingest_punches
from .branch_scope import scope_to_branch
from .geo_tracking import sessions as geo_sessions, settings as geo_settings
from .geo_utils import haversine_distance_m
from .clock import FACTORY_TZ, ist_time, ist_today
from .date_span import DaySpanError, parse_day_span
from .hod_scope import manager_may_act_on, managers_to_notify
from .models import (
    AttendanceLog, Employee, LiveLocationPing, Notification,
    OnDutyOvertimePunch, OnDutyPunchVerification, OnDutySession, OutpassRequest,
)

logger = logging.getLogger(__name__)

ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png"}
MAX_PHOTO_BYTES = 8 * 1024 * 1024  # 8MB
DEFAULT_RADIUS_M = 200
PING_RETENTION_HOURS = 72
IST_OFFSET = timedelta(hours=5, minutes=30)


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
    if source == "auto:md":
        return "Auto Attendance"  # md_auto_attendance: the MD department's generated Full-Day Present punches
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


def _taken_slot_details(emp: Employee, d) -> dict[int, dict]:
    """{slot number: {status, punchTime, source, sessionId, verificationId}} for one employee-day.

    On-duty punches carry an explicit punch_number, so they hold exactly the
    slot the employee chose -including out of order. Punches from any other
    source (biometric, Office Geo Punch) have no slot of their own, so they
    fill the lowest free slots in time order."""
    taken: dict[int, dict] = {}
    for v in OnDutyPunchVerification.objects.filter(
        employee=emp, punch_date=d,
        status__in=[OnDutyPunchVerification.STATUS_PENDING, OnDutyPunchVerification.STATUS_APPROVED],
    ):
        if v.punch_number in ON_DUTY_SLOTS:
            taken[v.punch_number] = {
                "status": v.status,  # "pending" | "approved"
                "punchTime": v.punch_time.strftime("%H:%M:%S") if v.punch_time else None,
                "source": "on_duty",
                "sessionId": v.session_id,
                "verificationId": v.id,
            }

    others = (
        AttendanceLog.objects
        .filter(employee=emp, date=d)
        .exclude(source="on_duty:approved")  # already counted above, via its verification
        .order_by("punch_time")
    )
    for log in others:
        for n in ON_DUTY_SLOTS:
            if n not in taken:
                taken[n] = {
                    "status": "recorded",
                    "punchTime": log.punch_time.strftime("%H:%M:%S") if log.punch_time else None,
                    "source": log.source or "",
                    "sessionId": None,
                    "verificationId": None,
                }
                break
    return taken


def _taken_slots(emp: Employee, d) -> dict[int, str]:
    """{slot number: what holds it} for one employee-day (see _taken_slot_details)."""
    return {n: detail["status"] for n, detail in _taken_slot_details(emp, d).items()}


# The four On-Duty punches by name (owner 2026-11-24), in slot order. Each is still an IN/OUT slot of the day's
# 4-punch model (_slot_punch_type); the name and the expected time are what the employee reads.
SLOT_NAMES = {1: "Morning Punch", 2: "Lunch Out", 3: "Lunch In", 4: "Night Punch"}
# When the employee has no shift on that day: the factory's usual day.
DEFAULT_SLOT_TIMES = {1: time(9, 0), 2: time(13, 0), 3: time(14, 0), 4: time(18, 0)}


def _plus_minutes(t: time, minutes: int) -> time:
    return (datetime.combine(date(2000, 1, 1), t) + timedelta(minutes=minutes)).time()


def expected_slot_times(emp: Employee, d) -> tuple[dict[int, time], str]:
    """({slot: expected time}, "shift" | "default") for the employee's shift on day `d`:
    Morning Punch = shift start, Lunch Out = the end of the first half (the middle of the shift when the shift has no
    lunch break set), Lunch In = Lunch Out + the shift's lunch duration, Night Punch = shift end."""
    try:
        from .shift_engine import _get_shift_for_date

        shift = _get_shift_for_date(emp, d)
    except Exception:
        logger.exception("Could not read the shift of employee %s for the On-Duty punch times", emp.pk)
        shift = None
    if shift is None or not shift.start_time or not shift.end_time:
        return dict(DEFAULT_SLOT_TIMES), "default"
    start, end = shift.start_time, shift.end_time
    lunch_minutes = shift.lunch_duration_minutes or 60
    if getattr(shift, "first_half_end", None):
        lunch_out = shift.first_half_end
    else:
        span = (datetime.combine(date(2000, 1, 1), end) - datetime.combine(date(2000, 1, 1), start)).total_seconds()
        if span <= 0:  # a night shift that crosses midnight
            span += 24 * 3600
        lunch_out = _plus_minutes(start, int(span // 120) - lunch_minutes // 2)
    return {1: start, 2: lunch_out, 3: _plus_minutes(lunch_out, lunch_minutes), 4: end}, "shift"


def _slot_dicts(emp: Employee, d) -> list[dict]:
    """All 4 slots with their state, for the app to render one row each —
    a filled slot shows its status, a free one offers "add my punch"."""
    taken = _taken_slot_details(emp, d)
    expected, expected_source = expected_slot_times(emp, d)
    rows = []
    for n in ON_DUTY_SLOTS:
        detail = taken.get(n) or {}
        rows.append({
            "punchNumber": n,
            "punchType": _slot_punch_type(n),
            "name": SLOT_NAMES[n],
            "expectedTime": expected[n].strftime("%H:%M") if expected.get(n) else None,
            "expectedSource": expected_source,
            "status": detail.get("status", "available"),
            "available": n not in taken,
            "punchTime": detail.get("punchTime"),
            "punchSource": detail.get("source"),
            "sessionId": detail.get("sessionId"),
            "verificationId": detail.get("verificationId"),
        })
    return rows


def _end_on_duty_session(session: OnDutySession, reason: str) -> bool:
    """Close a session for the day. Returns True if it changed anything.

    A session still awaiting approval is closed by stamping
    employee_ended_at only -it stops being punchable but stays in HR's
    queue, because ending the day is not the same as deciding the request."""
    if session.employee_ended_at or session.status not in PUNCHABLE_STATUSES:
        return False
    now = timezone.now()
    with transaction.atomic():
        session.employee_ended_at = now
        if _is_provisional(session):
            session.save(update_fields=["employee_ended_at"])
        else:
            session.status = OnDutySession.STATUS_COMPLETED
            session.completed_at = now
            session.completed_by = "system"
            session.completion_reason = reason
            session.save()
        # The session's geo-tracking ends with it, for the same reason (manual / auto_4th_punch / auto_day_end).
        _end_track_safely(session, reason, now)
    return True


def _end_track_safely(session: OnDutySession, reason: str, now=None) -> None:
    """End the session's geo-tracking (geo_tracking.sessions.end_track, the ONE function that ends a track). Tracking is
    never allowed to break the attendance flow it rides on: a failure is logged and the session still ends; the scheduler's
    orphan check ends the track a couple of minutes later."""
    try:
        with transaction.atomic():
            geo_sessions.end_track_for_session(session, reason, now=now)
    except Exception:
        logger.exception("Could not end the geo-tracking of on-duty session %s (%s)", session.pk, reason)


def _photo_problem(photo) -> str | None:
    """Why an uploaded selfie is not acceptable (type / size), or None."""
    ext = photo.name.rsplit(".", 1)[-1].lower() if "." in photo.name else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        return f"Unsupported photo type '.{ext}' -only JPG and PNG are accepted"
    if photo.size > MAX_PHOTO_BYTES:
        return f"Photo is too large ({photo.size / 1024 / 1024:.1f}MB) -the limit is 8MB"
    return None


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
    correct UTC instant (timezone.now(), unlike the naive ist_today()/
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
    # The OT punches follow the request (never attendance: they only count for overtime, see OnDutyOvertimePunch).
    session.overtime_punches.filter(status=OnDutyOvertimePunch.STATUS_PENDING).update(
        status=OnDutyOvertimePunch.STATUS_APPROVED
    )
    return len(pending)


def _void_session_punches(session: OnDutySession, reviewer_name: str, stage: str) -> int:
    """Reject every still-pending punch this session captured. Called on any
    rejection, at either approval stage.

    Safe by construction: a pending verification has never been written to
    AttendanceLog (resolve_on_duty_punch_hr is the only path there, and
    on_duty_punch_verification_hr_status refuses to run it while the session
    is provisional). So voiding here invalidates the day's punches without
    ever having to delete real attendance rows."""
    session.overtime_punches.exclude(status=OnDutyOvertimePunch.STATUS_REJECTED).update(
        status=OnDutyOvertimePunch.STATUS_REJECTED
    )
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
    today = ist_today()
    return OnDutySession.objects.filter(
        employee=emp, status__in=[OnDutySession.STATUS_COMPLETED, OnDutySession.STATUS_REJECTED],
        created_at__date=today,
    ).order_by("-created_at").first()


WORKFLOW = "on_duty"


def with_pending_punch_count(qs):
    """An OnDutySession queryset with each session's pending punch verifications counted in the same query (read by
    _on_duty_session_dict), instead of one COUNT per session."""
    return qs.annotate(
        pending_punch_count=Count(
            "punch_verifications", filter=Q(punch_verifications__status=OnDutyPunchVerification.STATUS_PENDING)
        )
    )


def _pending_punch_count(session: OnDutySession) -> int:
    annotated = getattr(session, "pending_punch_count", None)
    if annotated is not None:
        return annotated
    return session.punch_verifications.filter(status=OnDutyPunchVerification.STATUS_PENDING).count()


def _on_duty_session_dict(
    session: OnDutySession, *, for_employee: bool = False, cfg: approval.Config | None = None
) -> dict:
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
        # they reject. A list annotates it (with_pending_punch_count) so it
        # costs no COUNT per session.
        "pendingPunchCount": _pending_punch_count(session),
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
        # Who the request waits for under the approval pipeline, and how far it has got (approval_workflow.py).
        "approval": approval.progress(WORKFLOW, session, cfg),
        # Overtime punches after the four (OnDutyOvertimePunch, never attendance) and how far past the shift end.
        **_ot_summary(session),
    }


def _ot_summary(session: OnDutySession) -> dict:
    """{otPunches, otMinutes} for a session dict. Reads the prefetched list when the caller prefetched it (HR list)."""
    punches = [p for p in session.overtime_punches.all() if p.status != OnDutyOvertimePunch.STATUS_REJECTED]
    punches.sort(key=lambda p: p.sequence)
    return {
        "otPunches": [_ot_punch_dict(p) for p in punches],
        "otMinutes": overtime_minutes(session.employee, punches[-1].punch_date, punches[-1].punch_time) if punches else 0,
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
        "hasPhoto2": bool(v.photo2),
        "status": v.status,
        "hrReviewedBy": v.hr_reviewed_by,
        "hrReviewComment": v.hr_review_comment,
        "hrReviewedAt": v.hr_reviewed_at.isoformat() if v.hr_reviewed_at else None,
        "createdAt": v.created_at.isoformat() if v.created_at else None,
    }


def _gate_pass_json(gate_pass: OutpassRequest | None) -> dict | None:
    """The pass as the Gate Outpass page shows it (outpass_request_views._outpass_request_json), or None."""
    if gate_pass is None:
        return None
    from .outpass_request_views import _outpass_request_json

    return _outpass_request_json(gate_pass, with_employee=True)


def _raise_gate_pass_for(session: OnDutySession) -> OutpassRequest:
    """The gate pass of an On-Duty request, raised the moment the request is SUBMITTED (owner 2026-11-24): pending
    while the On-Duty waits for its approval, yet already valid at the gate (outpass_request_views.pass_window /
    pass_presentable), because the employee starts working -and leaves- at once. One pass per On-Duty request: an
    existing one is returned as it is."""
    existing = OutpassRequest.objects.filter(on_duty_session=session).order_by("id").first()
    if existing is not None:
        return existing
    return OutpassRequest.objects.create(
        employee=session.employee,
        destination=session.destination,
        reason=session.destination,
        status=OutpassRequest.STATUS_PENDING,
        source=OutpassRequest.SOURCE_ON_DUTY,
        on_duty_session=session,
        approver_role="system",
    )


def _void_gate_pass_of(session: OnDutySession, reviewer_name: str) -> int:
    """A rejected On-Duty voids its gate pass (the QR stops working). An exit already made stays on record."""
    return OutpassRequest.objects.filter(
        on_duty_session=session, status=OutpassRequest.STATUS_PENDING,
    ).update(
        status=OutpassRequest.STATUS_REJECTED,
        approved_by=reviewer_name,
        review_comment="The On-Duty request was rejected.",
        updated_at=timezone.now(),
    )


def _create_outpass_from_on_duty(session: OnDutySession, reviewer_name: str) -> None:
    """Called once, only from resolve_on_duty_session's final-approval branch —
    On-Duty's own status/fields are never touched here. The pass raised at
    submission (_raise_gate_pass_for) becomes approved and gets its matching
    OutpassRecord (the same row shape a QR-scan or a manual Outpass request
    produces); a session submitted before passes were raised at submission
    gets a new, already-approved pass, as before."""
    from .outpass_visitor_views import _create_outpass_record_for

    existing = OutpassRequest.objects.filter(on_duty_session=session).order_by("id").first()
    if existing is not None:
        if existing.status == OutpassRequest.STATUS_APPROVED:
            return
        existing.status = OutpassRequest.STATUS_APPROVED
        existing.approver_role = "system"
        existing.approved_by = reviewer_name
        existing.approved_at = timezone.now()
        if existing.outpass_record_id is None:
            existing.outpass_record = _create_outpass_record_for(
                session.employee, session.destination, source="request"
            )
        existing.save()
        return
    record = _create_outpass_record_for(session.employee, session.destination, source="request")
    OutpassRequest.objects.create(
        employee=session.employee,
        destination=session.destination,
        reason=session.destination,
        status=OutpassRequest.STATUS_APPROVED,
        source=OutpassRequest.SOURCE_ON_DUTY,
        on_duty_session=session,
        approver_role="system",
        approved_by=reviewer_name,
        approved_at=timezone.now(),
        outpass_record=record,
    )


def resolve_on_duty_session(
    session: OnDutySession, role: str, decision: str, reviewer_name: str, comment: str | None
) -> approval.Outcome:
    """
    One decision by `role` ('hod' or 'hr') on an On-Duty request, under the "on_duty" pipeline (approval_workflow.py).
    Raises approval.ApprovalError when that role may not decide it now.

    An intermediate approval only passes the request to the next step (the employee keeps working under it).
    The FINAL approval starts the session (status=active, started_at=now) -this is what live_location_ping and the
    mobile on-duty punch flow key off of -accepts every punch captured under it and issues the outpass; a
    rejection at any step is terminal and voids the pending punches. Out of the box HR may decide straight away,
    without waiting for a Department Head who has not acted (that step is optional).
    """
    outcome = approval.decide(WORKFLOW, session, role, decision, actor=reviewer_name, comment=comment)
    now = timezone.now()
    if role == approval.HOD:
        session.hod_reviewed_by, session.hod_reviewed_at = reviewer_name, now
        if comment:
            session.hod_review_comment = comment
    else:
        session.hr_reviewed_by, session.hr_reviewed_at = reviewer_name, now
        if comment:
            session.hr_review_comment = comment
    what = f"On-Duty request for {session.destination}"
    if outcome.final:
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
        session.status = outcome.status
    session.save()
    if outcome.final:
        # One decision, one card: approving the request accepts every punch
        # captured under it as real attendance.
        approved = _approve_session_punches(session, reviewer_name)
        # Data-collection only, no attendance/payroll link -see
        # outpass_visitor_views.py's module docstring. The pass was raised at
        # submission (owner 2026-11-24); the approval marks it approved.
        _create_outpass_from_on_duty(session, reviewer_name)
        message = approval.notice_for(what, outcome)
        message += (
            f" Your {approved} recorded punch(es) have been accepted as attendance."
            if approved else " You can now begin."
        )
        whatsapp_notifications.notify_geo_session_approved(session, reviewer_name, comment)
    elif outcome.rejected:
        # Terminal rejection -the employee may already have worked and
        # punched all day under this request. Those punches never reached
        # AttendanceLog, and now never will.
        voided = _void_session_punches(session, reviewer_name, approval.ROLE_PHRASE[role])
        # Tracking stops with the rejection; what was collected so far is kept (owner decision 2026-10-28).
        _end_track_safely(session, "rejected")
        _void_gate_pass_of(session, reviewer_name)
        message = approval.notice_for(what, outcome)
        if voided:
            message += f" The {voided} punch(es) you recorded under it are not valid and have not been counted."
        whatsapp_notifications.notify_geo_session_rejected(session, reviewer_name, approval.LEGACY_ROLE[role], comment, voided)
    else:
        # An approval that only passes the request on stays quiet on WhatsApp until the final decision.
        message = approval.notice_for(what, outcome)
        if approval.HOD in outcome.waiting and role != approval.HOD:
            _notify_hod_approvers(session)  # it has just reached the Department Head's step
    approval.stage_notice(session.employee, "on_duty", message, outcome)
    return outcome


def resolve_on_duty_session_hod(session: OnDutySession, decision: str, reviewer_name: str, comment: str | None):
    """The Department Head's decision (kept under its old name for callers that predate the pipeline)."""
    return resolve_on_duty_session(session, approval.HOD, decision, reviewer_name, comment)


def resolve_on_duty_session_hr(session: OnDutySession, decision: str, reviewer_name: str, comment: str | None):
    """HR's decision (kept under its old name for callers that predate the pipeline)."""
    return resolve_on_duty_session(session, approval.HR, decision, reviewer_name, comment)


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
        if decision == "approved":
            whatsapp_notifications.notify_geo_punch_approved(v, reviewer_name, comment)
        else:
            whatsapp_notifications.notify_geo_punch_rejected(v, reviewer_name, comment)
        # (The notification and push come from the WhatsApp message above: push_messages.py.) Suppressed for bulk
        # runs -the caller sends one summary notification for the whole request instead of four near-identical pings.

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
            _end_track_safely(session, OnDutySession.COMPLETION_AUTO_4TH_PUNCH)
            from . import push_recipients

            if push_recipients.allows(v.employee):
                from . import push_templates

                title, message = push_templates.apply(
                    "on_duty_auto_end",
                    {"employee_name": f"{v.employee.first_name} {v.employee.last_name}", "destination": session.destination},
                    "",
                    "Your On-Duty session was automatically completed after your 4th punch was approved.",
                )
                Notification.objects.create(
                    employee=v.employee, type="on_duty", title=title, message=message, source="on_duty_auto_end",
                )


def _notify_hod_approvers(session: OnDutySession) -> None:
    """Push a Notification to every active Department Head covering this
    employee with on-duty approval enabled. HR always sees the request too,
    via the Pending Approvals tab on the HR dashboard (no push needed there —
    HRUser accounts aren't push-token-registered, only employees are)."""
    emp = session.employee
    # The employee's ONE HOD (hod_scope.py), if allowed to act on on-duty requests.
    from . import push_recipients, whatsapp_hod

    for m in managers_to_notify(emp, "can_approve_on_duty"):
        whatsapp_hod.request_waiting(  # WhatsApp Control's own message
            m.employee,
            "on_duty",
            emp,
            "On-Duty request",
            session,
            request_type="On-Duty",
            details=f"At {session.destination[:80]}",
            date=timezone.localdate().strftime("%d %b %Y"),
        )
        if not push_recipients.allows(m.employee):
            continue  # not a phone notification recipient (Phone Notify Control -> Settings)
        from . import push_templates

        title, message = push_templates.apply(
            "approval_waiting",
            {
                "employee_name": f"{emp.first_name} {emp.last_name}",
                "employee_code": emp.employee_code,
                "request": "On-Duty request",
                "details": session.destination[:80],
            },
            "",
            f"{emp.first_name} {emp.last_name} submitted an On-Duty request -{session.destination[:80]}",
        )
        Notification.objects.create(
            employee=m.employee, type="on_duty", title=title, message=message, source="approval_waiting",
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

    today = ist_today()
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

    # ist_* rather than date.today()/datetime.now(): those read the OS
    # clock, which is IST on the old on-premise box but UTC on Railway —
    # storing a 10:24 punch as 04:54. See api/clock.py.
    today = ist_today()
    now_time = ist_time()
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


# ── Offline captures (owner 2026-11-24) ─────────────────────────────────────
# The app may keep an On-Duty punch / "End On-Duty" made with no internet in a queue on the phone and send it later
# (src/offline in the app, with an Idempotency-Key so a re-send is harmless). Such a call says WHEN it happened
# (`capturedAt`, the phone's clock) and for WHICH session (`sessionId`). The server trusts that time only within
# limits: not in the future (CAPTURE_SKEW for clock drift), not older than CAPTURE_MAX_AGE, and on the session's own
# day, before the session ended. A call without `capturedAt` is a live one, judged exactly as before.
CAPTURE_SKEW = timedelta(minutes=5)
CAPTURE_MAX_AGE = timedelta(hours=72)


class CaptureError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "invalid_capture"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code

    def response(self) -> Response:
        return Response({"error": self.message, "code": self.code}, status=self.status)


def _captured_at(data):
    """The aware datetime the phone says the action happened at, or None for a live call. Raises CaptureError."""
    raw = data.get("capturedAt", data.get("captured_at"))
    if raw in (None, ""):
        return None
    try:
        value = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except ValueError:
        raise CaptureError("capturedAt must be a date and time (ISO 8601)")
    if value.tzinfo is None:
        value = value.replace(tzinfo=FACTORY_TZ)  # a time without a zone is India time, like every punch
    now = timezone.now()
    if value > now + CAPTURE_SKEW:
        raise CaptureError("The time of this punch is in the future. Please check the date and time of your phone.",
                           code="capture_in_future")
    if value < now - CAPTURE_MAX_AGE:
        raise CaptureError("This was recorded more than 3 days ago and can no longer be sent. Please contact HR.",
                           409, "capture_too_old")
    return value


def _session_end(session: OnDutySession):
    return session.employee_ended_at or (session.completed_at if session.status == OnDutySession.STATUS_COMPLETED else None)


def _session_for(emp: Employee, data, captured) -> OnDutySession:
    """The session a punch / an "End On-Duty" belongs to. Live call: the employee's open session (as before).
    Offline call: the session it names (`sessionId`), else the one that was open on that day at that time."""
    raw_id = data.get("sessionId", data.get("session_id"))
    if captured is None:
        session = _punchable_on_duty_session(emp)
        if session is None or (raw_id not in (None, "") and str(session.id) != str(raw_id)):
            raise CaptureError("You don't have an active On-Duty session", 404, "no_active_session")
        return session
    day = captured.astimezone(FACTORY_TZ).date()
    if raw_id not in (None, ""):
        try:
            session = OnDutySession.objects.filter(pk=int(raw_id), employee=emp).first()
        except (TypeError, ValueError):
            session = None
    else:
        # The session of that day that was open at that time; when the On-Duty request itself was also kept on the
        # phone and reached the server only now (after this punch was taken), the first session of that day after it.
        same_day = [
            s for s in OnDutySession.objects.filter(
                employee=emp, created_at__gte=captured - timedelta(days=1), created_at__lte=timezone.now(),
            ).exclude(status=OnDutySession.STATUS_REJECTED).order_by("created_at")
            if s.created_at.astimezone(FACTORY_TZ).date() == day
        ]
        before = [s for s in same_day if s.created_at <= captured + CAPTURE_SKEW]
        after = [s for s in same_day if s.created_at > captured + CAPTURE_SKEW]
        session = before[-1] if before else (after[0] if after else None)
    if session is None:
        raise CaptureError("The On-Duty session of this punch was not found.", 404, "no_active_session")
    if session.status == OnDutySession.STATUS_REJECTED:
        raise CaptureError("This On-Duty request was rejected, so its punches cannot be recorded.", 409,
                           "session_rejected")
    if session.created_at.astimezone(FACTORY_TZ).date() != day:
        raise CaptureError("This punch was made on a different day from its On-Duty session.", 409, "wrong_day")
    ended = _session_end(session)
    if ended is not None and captured > ended + CAPTURE_SKEW:
        raise CaptureError("This punch was made after the On-Duty session had ended.", 409, "session_ended")
    return session


# ── Overtime punches (owner 2026-11-24) ─────────────────────────────────────

def _ot_punch_dict(p: OnDutyOvertimePunch) -> dict:
    return {
        "id": p.id,
        "sessionId": p.session_id,
        "sequence": p.sequence,
        "punchDate": str(p.punch_date),
        "punchTime": p.punch_time.strftime("%H:%M:%S"),
        "latitude": float(p.latitude),
        "longitude": float(p.longitude),
        "accuracyM": p.accuracy_m,
        "isMocked": p.is_mocked,
        "hasPhoto": bool(p.photo),
        "hasPhoto2": bool(p.photo2),
        "status": p.status,
        "isOvertime": True,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
    }


def overtime_minutes(emp: Employee, d, last_ot_time) -> int:
    """Minutes the last OT punch of day `d` is past the employee's shift end (the Night Punch's expected time)."""
    if last_ot_time is None:
        return 0
    expected, _source = expected_slot_times(emp, d)
    end = expected.get(4)
    if end is None:
        return 0
    delta = datetime.combine(d, last_ot_time) - datetime.combine(d, end)
    return max(0, int(delta.total_seconds() // 60))


def _overtime_block(session: OnDutySession) -> dict:
    punches = list(session.overtime_punches.exclude(status=OnDutyOvertimePunch.STATUS_REJECTED).order_by("sequence"))
    day = session.created_at.astimezone(FACTORY_TZ).date() if session.created_at else ist_today()
    regular_done = all(not s["available"] for s in _slot_dicts(session.employee, day))
    return {
        "otPunches": [_ot_punch_dict(p) for p in punches],
        "otMinutes": overtime_minutes(session.employee, punches[-1].punch_date, punches[-1].punch_time) if punches else 0,
        "regularPunchesDone": regular_done,
    }


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_auth
def on_duty_ot_punch_request(request: Request) -> Response:
    """
    POST /api/on-duty-sessions/ot-punch -multipart: latitude, longitude, accuracy?, isMocked?, photo, photo2 (when HR asks
    for two photos), capturedAt? and sessionId? (a punch kept offline on the phone).

    An OVERTIME punch: only after the day's four punches are in and while the On-Duty is still open (the employee chose
    "Continue Duty"). Never written to attendance (OnDutyOvertimePunch); it counts for overtime once the On-Duty is
    approved.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)
    data = request.data
    try:
        captured = _captured_at(data)
        session = _session_for(emp, data, captured)
    except CaptureError as exc:
        return exc.response()

    when = captured.astimezone(FACTORY_TZ) if captured is not None else None
    day = when.date() if when is not None else ist_today()
    if any(slot["available"] for slot in _slot_dicts(emp, day)):
        return Response(
            {"error": "Record your four punches first. OT punches are for work after the Night Punch.",
             "code": "regular_punches_missing"},
            status=409,
        )
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
    photo = request.FILES.get("photo")
    if not photo:
        return _error("A selfie photo is required to verify this punch")
    problem = _photo_problem(photo)
    if problem:
        return _error(problem)
    photo2 = request.FILES.get("photo2")
    if photo2 is None and geo_settings.punch_photos() == 2:
        return Response(
            {"error": "Two photos are required: please update the app", "code": "PHOTO2_REQUIRED"}, status=400
        )
    if photo2 is not None:
        problem = _photo_problem(photo2)
        if problem:
            return _error(problem)

    with transaction.atomic():
        locked = OnDutySession.objects.select_for_update().get(pk=session.pk)
        last = locked.overtime_punches.order_by("-sequence").values_list("sequence", flat=True).first() or 0
        p = OnDutyOvertimePunch(
            session=locked, employee=emp, sequence=last + 1, punch_date=day,
            punch_time=(when.time().replace(microsecond=0) if when is not None else ist_time()),
            latitude=lat, longitude=lng, accuracy_m=accuracy, is_mocked=_get_is_mocked(data),
            # A request already approved: the OT punch is approved with it; otherwise it waits for the same decision.
            status=(OnDutyOvertimePunch.STATUS_PENDING if _is_provisional(locked) else OnDutyOvertimePunch.STATUS_APPROVED),
        )
        p.photo.save(photo.name, ContentFile(photo.read()), save=False)
        if photo2 is not None:
            p.photo2.save(photo2.name, ContentFile(photo2.read()), save=False)
        p.save()
    return Response({
        "otPunch": _ot_punch_dict(p),
        "otMinutes": overtime_minutes(emp, p.punch_date, p.punch_time),
        "message": f"OT punch {p.sequence} recorded.",
    }, status=201)


@api_view(["GET"])
@require_auth
def on_duty_ot_punch_photo(request: Request, pk: int) -> Response:
    """GET /api/on-duty-overtime-punches/<pk>/photo?n=1|2 -the owner, branch-scoped HR, or the employee's HOD."""
    p = OnDutyOvertimePunch.objects.select_related("employee").filter(pk=pk).first()
    if not p:
        return _error("OT punch not found", 404)
    viewer = get_token_employee_id(request)
    if viewer == p.employee_id:
        allowed = True
    elif is_hr(request):
        allowed = scope_to_branch(Employee.objects, request).filter(pk=p.employee_id).exists()
    else:
        allowed = bool(viewer) and manager_may_act_on(viewer, p.employee)
    if not allowed:
        return _error("Access denied", 403)
    which = (request.query_params.get("n") or "1").strip()
    if which not in ("1", "2"):
        return _error("n must be 1 or 2")
    image = p.photo2 if which == "2" else p.photo
    if not image:
        return _error("Photo not found", 404)
    return FileResponse(image.open("rb"))


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
    try:
        captured = _captured_at(request.data)
    except CaptureError as exc:
        return exc.response()
    if captured is not None and captured.astimezone(FACTORY_TZ).date() != ist_today():
        # Kept on the phone (offline) since an earlier day: a new day's On-Duty must be asked for again.
        return Response({
            "error": "This On-Duty request was made on an earlier day and was not sent in time. "
                     "Please submit a new one for today.",
            "code": "stale_request",
        }, status=409)

    try:
        approval.require_enabled(WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    first = approval.get_config(WORKFLOW).steps[0].roles  # the request starts with whoever the first step names
    with transaction.atomic():
        session = OnDutySession.objects.create(
            employee=emp, destination=destination, branch=emp.branch,
            status=approval.project_status(WORKFLOW, first), approval_trail=[],
        )
        # Geo-tracking starts the moment the request is SUBMITTED (before any approval), in the same transaction, and keeps
        # what it records whether the request is later approved or rejected. A failure here must not stop the employee
        # starting duty: the app's next /tracking/state call creates the missing track.
        try:
            with transaction.atomic():
                geo_sessions.start_track(session)
        except Exception:
            logger.exception("Could not start geo-tracking for on-duty session %s", session.pk)
        # Its gate pass, at once (owner 2026-11-24): shown on the Gate Outpass and On-Duty pages while it waits.
        gate_pass = _raise_gate_pass_for(session)
    if approval.HOD in first:
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
        "gatePass": _gate_pass_json(gate_pass),
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

    try:
        captured = _captured_at(request.data)
        session = _session_for(emp, request.data, captured)
    except CaptureError as exc:
        raw_id = request.data.get("sessionId", request.data.get("session_id"))
        ended = None
        if raw_id not in (None, "") and exc.code in ("no_active_session", "session_ended"):
            ended = OnDutySession.objects.filter(pk=raw_id, employee=emp).first() if str(raw_id).isdigit() else None
        if ended is not None and _session_end(ended) is not None:
            # Already over (marked Done elsewhere, or the day-end job closed it): nothing left to do.
            return Response({**_on_duty_session_dict(ended, for_employee=True), "alreadyEnded": True})
        return exc.response()
    if _session_end(session) is not None or session.status not in PUNCHABLE_STATUSES:
        return Response({**_on_duty_session_dict(session, for_employee=True), "alreadyEnded": True})

    now = max(captured, session.created_at) if captured is not None else timezone.now()
    with transaction.atomic():
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
        _end_track_safely(session, OnDutySession.COMPLETION_MANUAL, now)
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
    required_photos = geo_settings.punch_photos()  # 1 or 2 selfies per punch (Geo-Tracking settings)
    if not session:
        return Response({"session": None, "punchVerifications": [], "requiredPhotos": required_photos})

    verifications = session.punch_verifications.select_related("session").order_by("punch_number", "created_at")
    return Response({
        "session": _on_duty_session_dict(session, for_employee=True),
        "requiredPhotos": required_photos,
        "punchVerifications": [_on_duty_punch_verification_dict(v) for v in verifications],
        # All four slots, each either filled or offering "add my punch" —
        # the app renders one row per slot rather than a single next-punch
        # button, so a missed punch never blocks the ones after it.
        "punchSlots": _slot_dicts(emp, ist_today()),
        # The session's gate pass (raised at submission), for the card + QR on the On-Duty page.
        "gatePass": _gate_pass_json(OutpassRequest.objects.filter(on_duty_session=session).order_by("id").first()),
        # Overtime punches after the four (OnDutyOvertimePunch) and how far past the Night Punch's time they go.
        **_overtime_block(session),
    })


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_auth
def on_duty_punch_request(request: Request) -> Response:
    """
    POST /api/on-duty-sessions/punch -multipart:
      latitude, longitude, accuracy?, isMocked?, photo (file), photo2 (file; required while Geo-Tracking Settings
      say two photos per punch: 400 PHOTO2_REQUIRED otherwise)
    Captures one of the day's (up to 4) attendance punches while an On-Duty
    session is in progress -including one still awaiting approval. Held
    pending until HR approves BOTH the session and this punch; if the
    session is rejected instead, this row is voided by
    _void_session_punches() and never becomes attendance.
    """
    emp = _employee_from_token(request)
    if not emp:
        return _error("Employee authentication required", 403)

    data = request.data
    try:
        captured = _captured_at(data)
        session = _session_for(emp, data, captured)
    except CaptureError as exc:
        return exc.response()

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
    problem = _photo_problem(photo)
    if problem:
        return _error(problem)

    # The second selfie. Geo-Tracking settings say whether a punch takes one or two photos: under the two-photo policy a
    # punch without `photo2` is refused (old app builds learn they must update); under the one-photo policy an extra
    # photo2 is still kept if the app sent one.
    photo2 = request.FILES.get("photo2")
    if photo2 is None and geo_settings.punch_photos() == 2:
        return Response(
            {"error": "Two photos are required: please update the app", "code": "PHOTO2_REQUIRED"}, status=400
        )
    if photo2 is not None:
        problem = _photo_problem(photo2)
        if problem:
            return _error(problem)

    if captured is not None:
        local = captured.astimezone(FACTORY_TZ)
        today, now_time = local.date(), local.time().replace(microsecond=0)
    else:
        today = ist_today()
        now_time = ist_time()

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
    if photo2 is not None:
        v.photo2.save(photo2.name, ContentFile(photo2.read()), save=False)
    v.save()

    # Four punches is a full day -close the session now, at capture, rather
    # than waiting for HR to approve the fourth. The employee is done.
    # Since 2026-11-24 the app sends autoEnd=false: after the 4th punch it asks "Complete Duty" (it then ends the session)
    # or "Continue Duty" (the session stays open for OT punches). An app that does not send it keeps the old behaviour.
    raw_auto_end = data.get("autoEnd", data.get("auto_end"))
    auto_end = str(raw_auto_end).strip().lower() not in ("false", "0", "no") if raw_auto_end not in (None, "") else True
    all_in = len(available) == 1
    session_ended = False
    if all_in and auto_end:
        session_ended = _end_on_duty_session(session, OnDutySession.COMPLETION_AUTO_4TH_PUNCH)
        from . import push_recipients

        if session_ended and push_recipients.allows(emp):
            from . import push_templates

            title, message = push_templates.apply(
                "on_duty_auto_end",
                {"employee_name": f"{emp.first_name} {emp.last_name}", "destination": session.destination},
                "",
                "Your On-Duty session ended automatically -all 4 punches for the day are in.",
            )
            Notification.objects.create(
                employee=emp, type="on_duty", title=title, message=message, source="on_duty_auto_end",
            )

    return Response({
        "status": "pending_hr_approval", "verificationId": v.id,
        "punchNumber": punch_num, "punchType": punch_type,
        "sessionEnded": session_ended,
        # All four of the day's punches are in and the session is still open: the app asks Complete / Continue Duty.
        "allPunchesIn": all_in,
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
    d = ist_today()
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
        "requiredPhotos": geo_settings.punch_photos(),
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
    stage in one list.

    Optional &from=YYYY-MM-DD&to=YYYY-MM-DD (2026-11-24, the HR portal's date
    filter, date_span.py): only the requests FOR those India days -the day a
    request was made, since an On-Duty session never runs past its day (the
    same rule as the mobile app's on-duty-sessions/mine?month=). The 200-row
    cap then applies to those days only. Without them: exactly as before."""
    status_filter = request.query_params.get("status", "pending")
    try:
        span = parse_day_span(request.query_params)
    except DaySpanError as exc:
        return _error(str(exc))
    # Never the employee's photo (a base64 data URL, up to ~2 MB each): no row shows it.
    qs = OnDutySession.objects.select_related(
        "employee__department", "employee__designation", "branch"
    ).defer("employee__photo_url")
    qs = scope_to_branch(qs, request)  # OnDutySession.branch_id is a direct field
    if status_filter == "pending":
        qs = qs.filter(status__in=[OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR])
    elif status_filter != "all":
        qs = qs.filter(status=status_filter)
    if span is not None:
        qs = qs.filter(span.instant_q("created_at"))
    # The OT punches of every listed session in one query (shown on each card, _on_duty_session_dict).
    qs = with_pending_punch_count(qs).prefetch_related(
        Prefetch("overtime_punches", queryset=OnDutyOvertimePunch.objects.order_by("sequence"))
    ).order_by("-created_at")[:200]
    cfg = approval.get_config(WORKFLOW)
    return Response([_on_duty_session_dict(s, cfg=cfg) for s in qs])


@api_view(["PATCH"])
@require_hr
def on_duty_session_hr_status(request: Request, pk: int) -> Response:
    """
    PATCH /api/on-duty-sessions/<pk>/status -HR's decision. Under the default pipeline the Department Head step is
    optional, so HR may decide a session at EITHER stage: still pending_hod (the Department Head hasn't acted, or
    there isn't one) HR's decision finalizes it in one step; pending_hr is the normal second-stage approval. If HR has
    made the Department Head step mandatory, HR waits for it (approval_workflow.py).
    """
    session = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__designation", "branch"),
        request,
    ).filter(pk=pk).first()
    if not session:
        return _error("On-Duty session not found", 404)

    status_val = request.data.get("status")
    if status_val not in ("approved", "rejected") and approval.is_pending(WORKFLOW, session):
        return _error("status must be 'approved' or 'rejected'")
    if refused := hr_access.approval_refusal(request, WORKFLOW):  # the approval right, not the edit right
        return refused

    reviewer_name = request.jwt_user.get("name") or "HR"
    try:
        resolve_on_duty_session(session, approval.HR, status_val, reviewer_name, request.data.get("comment"))
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    hr_access.log_decision(request, WORKFLOW, session, status_val, f"On-Duty request for {session.destination}")
    return Response(_on_duty_session_dict(session))


@api_view(["GET"])
@require_hr
def on_duty_punch_verifications_hr(request: Request) -> Response:
    """GET /api/on-duty-punch-verifications?status=pending|approved|rejected|all -branch-scoped.

    Optional &from=YYYY-MM-DD&to=YYYY-MM-DD (2026-11-24, the HR portal's date
    filter, date_span.py): only the punches whose punch date is one of those
    days. The 200-row cap then applies to those days only. Without them:
    exactly as before."""
    status_filter = request.query_params.get("status", "pending")
    try:
        span = parse_day_span(request.query_params)
    except DaySpanError as exc:
        return _error(str(exc))
    # Never the employee's photo (a base64 data URL, up to ~2 MB each): no row shows it, and the sidebar's badge reads the
    # pending list on every HR page.
    qs = OnDutyPunchVerification.objects.select_related(
        "employee__department", "employee__designation", "session"
    ).defer("employee__photo_url")
    qs = scope_to_branch(qs, request, field="employee__branch_id")
    if status_filter != "all":
        qs = qs.filter(status=status_filter)
    if span is not None:
        qs = qs.filter(span.day_q("punch_date"))
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
    if refused := hr_access.approval_refusal(request, "on_duty_punch"):  # the approval right, not the edit right
        return refused
    # rejecting needs the reason the employee reads, approving never does (2026-11-21)
    if refused := approval.reject_remark_refusal(status_val, request.data.get("comment")):
        return refused

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
    hr_access.log_decision(request, "on_duty_punch", v, status_val, f"On-Duty punch of {v.punch_date} {v.punch_time}")
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
    if refused := hr_access.approval_refusal(request, "on_duty_punch"):  # the approval right, not the edit right
        return refused
    # rejecting needs the reason the employee reads, approving never does (2026-11-21)
    if refused := approval.reject_remark_refusal(status_val, request.data.get("comment")):
        return refused

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
        whatsapp_notifications.notify_geo_punches_decided(session, status_val, count, reviewer_name, request.data.get("comment"))
        hr_access.log_decision(
            request, "on_duty_punch", session, status_val, f"{count} On-Duty punch(es) for {session.destination}"
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
        # Only the employee's ONE HOD may open their punch photo (hod_scope.py).
        allowed = manager_may_act_on(owner_employee_id, v.employee)
    if not allowed:
        return _error("Access denied", 403)

    which = (request.query_params.get("n") or "1").strip()
    if which not in ("1", "2"):
        return _error("n must be 1 or 2")
    image = v.photo2 if which == "2" else v.photo
    if not image:
        return _error("Photo not found", 404)
    return FileResponse(image.open("rb"))


@api_view(["GET"])
@require_hr
def live_location_team(request: Request) -> Response:
    """GET /api/live-location/team -latest ping per tracking-enabled employee, branch-scoped.
    Also flags whether each employee has an active On-Duty session today, so
    the Live Map can render On-Duty staff in a distinct color."""
    # Never the photo (a base64 data URL of up to ~2 MB each): the Live Map reads this every 20 s and shows no photo.
    employees = list(scope_to_branch(
        Employee.objects.select_related("department", "branch").defer("photo_url"), request
    ).filter(location_tracking_enabled=True, status="active"))

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    on_duty_emp_ids = set(
        OnDutySession.objects.filter(
            status__in=PUNCHABLE_STATUSES, employee_ended_at__isnull=True,
        ).values_list("employee_id", flat=True)
    )
    # Every employee's newest ping in ONE query (Postgres DISTINCT ON), not one query per employee.
    latest_by_employee = {
        ping.employee_id: ping
        for ping in LiveLocationPing.objects.filter(
            employee_id__in=[e.id for e in employees], recorded_at__gte=cutoff,
        ).order_by("employee_id", "-recorded_at").distinct("employee_id").only(
            "employee_id", "latitude", "longitude", "is_mocked", "recorded_at",
        )
    }
    out = []
    for emp in employees:
        latest = latest_by_employee.get(emp.id)
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
    for drawing a directional path rather than just "latest position".

    Optional &from=YYYY-MM-DD&to=YYYY-MM-DD (2026-11-24, the On-Duty Map's
    date filter): every ping of those India days instead of one day's (the
    pings are only kept PING_RETENTION_HOURS, so older days are empty); the
    reply then carries "from" / "to" and "date" is the last day."""
    emp = scope_to_branch(Employee.objects, request).filter(pk=employee_id).first()
    if not emp:
        return _error("Employee not found", 404)

    try:
        span = parse_day_span(request.query_params)
    except DaySpanError as exc:
        return _error(str(exc))
    if span is not None:
        pings = emp.location_pings.filter(span.instant_q("recorded_at")).order_by("recorded_at")
        return Response({
            "employeeId": emp.id,
            "employeeCode": emp.employee_code,
            "employeeName": f"{emp.first_name} {emp.last_name}",
            "date": str(span.end or ist_today()),
            **span.as_json(),
            "points": [
                {
                    "latitude": float(p.latitude), "longitude": float(p.longitude),
                    "recordedAt": p.recorded_at.isoformat(), "isMocked": p.is_mocked,
                }
                for p in pings
            ],
        })

    date_str = request.query_params.get("date")
    d = ist_today()
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
    session + punch-verification status, for the dedicated On-Duty Map tab.

    Optional &from=YYYY-MM-DD&to=YYYY-MM-DD (2026-11-24, the HR portal's date
    filter, date_span.py) instead of `date`: every employee with an On-Duty
    request made on one of those India days (plus the sessions still active
    when the days include today), one entry each with their LATEST request of
    the days and its punches, the route points of those days (kept only
    PING_RETENTION_HOURS) and "days" (how many of the days they were On-Duty).
    The reply then carries "from" / "to" and "date" is the last day."""
    try:
        span = parse_day_span(request.query_params)
    except DaySpanError as exc:
        return _error(str(exc))
    if span is not None:
        return _on_duty_map_span(request, span)
    date_str = request.query_params.get("date")
    d = ist_today()
    if date_str:
        try:
            d = datetime.fromisoformat(date_str).date()
        except ValueError:
            return _error("Invalid date format")

    # The punches prefetched already in punch order (an .order_by() on the related manager would query once per
    # session again); never the employee's photo (a base64 data URL, up to ~2 MB each), which the map does not show.
    sessions = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__branch", "branch")
        .defer("employee__photo_url")
        .prefetch_related(
            Prefetch(
                "punch_verifications",
                queryset=OnDutyPunchVerification.objects.order_by("punch_number", "id"),
            )
        ),
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
                for v in s.punch_verifications.all()
            ],
        }

    return Response({"date": str(d), "employees": list(by_employee.values())})


def _on_duty_map_span(request: Request, span) -> Response:
    """The On-Duty Map over several days (on_duty_map with from / to): see its docstring."""
    match = span.instant_q("created_at")
    if span.has_today:
        match |= Q(status=OnDutySession.STATUS_ACTIVE)
    sessions = scope_to_branch(
        OnDutySession.objects.select_related("employee__department", "employee__branch", "branch")
        .defer("employee__photo_url")
        .prefetch_related(
            Prefetch(
                "punch_verifications",
                queryset=OnDutyPunchVerification.objects.order_by("punch_number", "id"),
            )
        ),
        request,
    ).filter(match).order_by("employee_id", "-created_at")

    cutoff = timezone.now() - timedelta(hours=PING_RETENTION_HOURS)
    ping_span = span.instant_q("recorded_at")
    by_employee: dict[int, dict] = {}
    days: dict[int, set] = {}
    for s in sessions:
        emp = s.employee
        days.setdefault(emp.id, set()).add(timezone.localtime(s.created_at, FACTORY_TZ).date())
        if emp.id in by_employee:
            continue  # one entry per employee -their latest request of the days (already ordered)
        latest = None
        points = []
        if emp.location_tracking_enabled:
            latest = emp.location_pings.filter(recorded_at__gte=cutoff).order_by("-recorded_at").first()
            points = [
                {"latitude": float(p.latitude), "longitude": float(p.longitude), "recordedAt": p.recorded_at.isoformat()}
                for p in emp.location_pings.filter(ping_span).order_by("recorded_at")
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
                for v in s.punch_verifications.all()
            ],
        }
    for emp_id, entry in by_employee.items():
        entry["days"] = len(days.get(emp_id, ()))
    return Response({
        "date": str(span.end or ist_today()),
        **span.as_json(),
        "employees": list(by_employee.values()),
    })
