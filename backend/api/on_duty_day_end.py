"""
On-Duty Day End -closes sessions left open at the end of the day
=================================================================
An On-Duty session is a *day* of off-site work, not an open-ended state.
It normally ends one of three ways:

  1. the employee taps "Done" in the app,
  2. all 4 of the day's punches are in (closed at capture -see
     geo_attendance_views.on_duty_punch_request), or
  3. this job, at 23:00 IST, for every session still open.

Without (3) a session that never reached 4 punches -the common case, since
an employee off-site for half a day may only punch twice -would stay
punchable indefinitely, letting tomorrow's punches land against yesterday's
request and blocking a fresh one.

Closing does NOT decide the request. A session still awaiting approval is
stamped employee_ended_at and left in HR's queue at its real status; only an
already-approved (active) session becomes "completed" here. Rejecting a
day's work is HR's call, never a timer's.
"""

import logging
from datetime import date

from django.utils import timezone

logger = logging.getLogger(__name__)


def end_stale_on_duty_sessions(for_date: date | None = None) -> dict:
    """Close every still-open On-Duty session created on `for_date`
    (default: today). Safe to run repeatedly -_end_on_duty_session is a
    no-op on a session that is already closed."""
    from .geo_attendance_views import PUNCHABLE_STATUSES, _end_on_duty_session
    from .models import Notification, OnDutySession

    d = for_date or date.today()
    open_sessions = OnDutySession.objects.select_related("employee").filter(
        status__in=PUNCHABLE_STATUSES,
        employee_ended_at__isnull=True,
        created_at__date=d,
    )

    ended = 0
    for session in open_sessions:
        if _end_on_duty_session(session, OnDutySession.COMPLETION_AUTO_DAY_END):
            ended += 1
            Notification.objects.create(
                employee=session.employee, type="on_duty",
                message=(
                    f"Your On-Duty session for {session.destination} was closed automatically "
                    "at the end of the day."
                ),
            )

    # Sessions opened on an EARLIER day and never closed -only reachable if
    # the job didn't run that night (server down, deploy). Swept here so a
    # missed night can't leave a session punchable forever.
    stragglers = OnDutySession.objects.select_related("employee").filter(
        status__in=PUNCHABLE_STATUSES,
        employee_ended_at__isnull=True,
        created_at__date__lt=d,
    )
    swept = 0
    for session in stragglers:
        if _end_on_duty_session(session, OnDutySession.COMPLETION_AUTO_DAY_END):
            swept += 1

    result = {"date": str(d), "ended": ended, "sweptFromEarlierDays": swept,
              "at": timezone.now().isoformat()}
    logger.info("On-Duty day-end job: %s", result)
    return result
