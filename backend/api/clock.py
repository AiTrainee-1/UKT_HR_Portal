"""
The factory clock.

Attendance in this system is naive local time -punch_date and punch_time are
a calendar date and a wall-clock time in Tirupur, with no offset attached.
That worked on the on-premise Windows box because its OS clock was IST, so
`datetime.now()` happened to return the right thing.

Railway's containers run on UTC. Every naive `datetime.now()` / `date.today()`
there is 5h30m early, which stored a 10:24 punch as 04:54 and, before 05:30
IST, filed it under the previous day.

`settings.py` sets TZ=Asia/Kolkata for the process, which fixes this on Linux.
These helpers do not depend on that: they name the zone explicitly, so they
are correct on any host, on any OS, whether or not TZ was set -and they can
be verified on a Windows dev box, where `time.tzset()` does not exist and the
env-var approach cannot be tested at all.

Use these anywhere a punch, shift boundary or attendance day is derived.
"""

from datetime import date, datetime, time as time_type
from zoneinfo import ZoneInfo

#: Everything this company does happens here.
FACTORY_TZ = ZoneInfo("Asia/Kolkata")


def ist_now() -> datetime:
    """Naive wall-clock time in Tirupur.

    Naive on purpose: it is compared against, and stored alongside, shift
    times and punch times that are themselves naive local values. Returning an
    aware datetime here would make those comparisons raise.
    """
    return datetime.now(FACTORY_TZ).replace(tzinfo=None)


def ist_today() -> date:
    """The calendar date in Tirupur right now.

    Distinct from `ist_now().date()` only in intent -this is the "attendance
    day" a punch belongs to, which is the thing that was silently wrong
    between midnight and 05:30 IST on a UTC host.
    """
    return ist_now().date()


def ist_time() -> time_type:
    """Wall-clock time in Tirupur, to the second.

    Microseconds are dropped because punch_time is stored to the second and
    the unique-together on (employee, date, punch_time, punch_type) is what
    protects against duplicates -sub-second noise would defeat it.
    """
    return ist_now().time().replace(microsecond=0)
