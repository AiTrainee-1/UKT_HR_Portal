"""Mobile app "My requests" round (2026-10-31): the employee's own On-Duty history for the On-Duty page's View Records.

GET /api/on-duty-sessions/mine (employee token only; an HR token gets 403)

    ?page=1&pageSize=50   (pageSize 1..100)
    ?month=YYYY-MM        (optional, 2026-11-02: only the requests of that month - see below)

    -> {"items": [...], "total", "page", "pageSize", "hasMore",
        "counts": {"waiting", "month", "approved", "rejected"}}
       (+ "month": "YYYY-MM" when the month filter was applied)

Every On-Duty request the employee ever made, newest first, each with its places, the day it was for, how it ended,
who approved / rejected it (the `approval` block every request carries), the four geo-punches and the recorded journey
when there is one. `counts` are over ALL of the employee's requests (not only this page), so the app's four view cards
are right even before older pages are loaded:

    waiting  = the request is still with an approver (pending_hod / pending_hr) - the employee may be working under it
    approved = approved (active, or completed once the day ended)
    rejected = rejected
    month    = requests SENT this calendar month in India time, whatever their status

With `?month=YYYY-MM` (the app's month switcher, owner 2026-11-02) everything above is about that month only: the
items, `total`, paging and all four counts cover just the requests SENT in that calendar month in India time (the day an
On-Duty request is for), so `month` is then the number of requests of that month whatever their status. The reply echoes
the month it applied, so an app can tell a server that knows the filter from one that ignored it. Without the param the
reply is exactly as before. A month that is not YYYY-MM is a 400.

`status` is what the employee sees elsewhere in the app (a request still with an approver reads "active" while the day
is being worked, "completed" once ended - see geo_attendance_views._on_duty_session_dict); `approvalStatus` is the true
HRMS state and is what the four views are sorted by.
"""

import re
from datetime import date, datetime

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .auth import get_token_employee_id, require_auth
from .clock import FACTORY_TZ, ist_today
from .geo_attendance_views import WORKFLOW as ON_DUTY_WORKFLOW
from .models import DutyTrack, OnDutySession
from .view_common import error_response

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100

WAITING_STATUSES = (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR)
APPROVED_STATUSES = (OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED)


def _ist_date(value) -> str | None:
    """The calendar day in India of an aware datetime (created_at is stored in UTC)."""
    if value is None:
        return None
    return timezone.localtime(value, FACTORY_TZ).date().isoformat()


def month_bounds(today: date) -> tuple[datetime, datetime]:
    """[first instant of `today`'s month, first instant of the next month) in India, as aware datetimes."""
    year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    return (
        datetime(today.year, today.month, 1, tzinfo=FACTORY_TZ),
        datetime(year, month, 1, tzinfo=FACTORY_TZ),
    )


MONTH_PARAM = re.compile(r"^(\d{4})-(\d{2})$")


def parse_month(value: str) -> date:
    """'2026-09' -> date(2026, 9, 1). Raises ValueError for anything that is not a real YYYY-MM month."""
    m = MONTH_PARAM.match(value.strip())
    if not m:
        raise ValueError(f"not a YYYY-MM month: {value!r}")
    year, month = int(m.group(1)), int(m.group(2))
    if year < 1900 or not 1 <= month <= 12:
        raise ValueError(f"not a YYYY-MM month: {value!r}")
    return date(year, month, 1)


def employee_status(session: OnDutySession) -> str:
    """The status the employee sees (the same rule as geo_attendance_views._on_duty_session_dict(for_employee=True)):
    a request still with an approver reads "active" while the day is being worked and "completed" once it ended."""
    if session.status in WAITING_STATUSES:
        return OnDutySession.STATUS_COMPLETED if session.employee_ended_at else OnDutySession.STATUS_ACTIVE
    return session.status


def _punches(session: OnDutySession) -> list[dict]:
    """The latest capture of each of the day's (up to) four geo-punches, in slot order. Uses the prefetched rows."""
    latest: dict[int, object] = {}
    for v in session.punch_verifications.all():
        cur = latest.get(v.punch_number)
        if cur is None or v.id > cur.id:
            latest[v.punch_number] = v
    return [
        {
            "punchNumber": v.punch_number,
            "punchType": v.punch_type,
            "punchDate": str(v.punch_date),
            "punchTime": v.punch_time.strftime("%H:%M"),
            "status": v.status,
            "isMocked": v.is_mocked,
        }
        for _, v in sorted(latest.items())
    ]


def _journey(session: OnDutySession) -> dict | None:
    try:
        track = session.track
    except DutyTrack.DoesNotExist:
        return None
    if track is None:
        return None
    return {
        "id": track.id,
        "status": track.status,
        "distanceM": round(track.distance_m or 0),
        "startedAt": track.started_at.isoformat() if track.started_at else None,
        "endedAt": track.ended_at.isoformat() if track.ended_at else None,
    }


def history_item(session: OnDutySession, cfg: approval.Config) -> dict:
    punches = _punches(session)
    return {
        "id": session.id,
        "destination": session.destination,
        "branchName": session.branch.name if session.branch_id and session.branch else None,
        # The day the On-Duty was for: the India date it was sent (a session never runs past its day).
        "date": _ist_date(session.created_at),
        "status": employee_status(session),
        "approvalStatus": session.status,
        "isProvisional": session.status in WAITING_STATUSES,
        "employeeEndedAt": session.employee_ended_at.isoformat() if session.employee_ended_at else None,
        "startedAt": session.started_at.isoformat() if session.started_at else None,
        "completedAt": session.completed_at.isoformat() if session.completed_at else None,
        "completionReason": session.completion_reason,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
        "hodReviewedBy": session.hod_reviewed_by,
        "hodReviewComment": session.hod_review_comment,
        "hodReviewedAt": session.hod_reviewed_at.isoformat() if session.hod_reviewed_at else None,
        "hrReviewedBy": session.hr_reviewed_by,
        "hrReviewComment": session.hr_review_comment,
        "hrReviewedAt": session.hr_reviewed_at.isoformat() if session.hr_reviewed_at else None,
        "punches": punches,
        # Punches that still count (not rejected), out of four.
        "punchCount": sum(1 for p in punches if p["status"] != "rejected"),
        "journey": _journey(session),
        "approval": approval.progress(ON_DUTY_WORKFLOW, session, cfg),
    }


@api_view(["GET"])
@require_auth
def my_on_duty_sessions(request: Request) -> Response:
    emp_id = get_token_employee_id(request)
    if not emp_id:
        return error_response("Employee authentication required", 403)
    try:
        page = max(1, int(request.query_params.get("page", 1)))
        page_size = max(1, min(MAX_PAGE_SIZE, int(request.query_params.get("pageSize", DEFAULT_PAGE_SIZE))))
    except (TypeError, ValueError):
        return error_response("page and pageSize must be numbers")
    month_param = (request.query_params.get("month") or "").strip()
    try:
        month_first = parse_month(month_param) if month_param else None
    except ValueError:
        return error_response("month must be YYYY-MM")

    mine = OnDutySession.objects.filter(employee_id=emp_id)
    # The month the `month` count is about: the one asked for (and then the only one listed), else this one.
    month_start, next_month = month_bounds(month_first or ist_today())
    if month_first is not None:
        mine = mine.filter(created_at__gte=month_start, created_at__lt=next_month)
    counts = mine.aggregate(
        waiting=Count("id", filter=Q(status__in=WAITING_STATUSES)),
        approved=Count("id", filter=Q(status__in=APPROVED_STATUSES)),
        rejected=Count("id", filter=Q(status=OnDutySession.STATUS_REJECTED)),
        month=Count("id", filter=Q(created_at__gte=month_start, created_at__lt=next_month)),
        total=Count("id"),
    )
    total = counts.pop("total")

    start = (page - 1) * page_size
    rows = (
        mine.select_related("branch", "track")
        .prefetch_related("punch_verifications")
        .order_by("-created_at", "-id")[start : start + page_size]
    )
    cfg = approval.get_config(ON_DUTY_WORKFLOW)
    body = {
        "items": [history_item(s, cfg) for s in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": start + page_size < total,
        "counts": counts,
    }
    if month_first is not None:
        body["month"] = month_first.strftime("%Y-%m")
    return Response(body)
