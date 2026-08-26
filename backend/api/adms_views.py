"""
ZKTeco ADMS listener -for AiFace-Mars devices configured with Server Mode:
ADMS (Settings → Cloud Server Setting on the device itself), which is a
completely different wire protocol from the simple JSON `/api/biometric/punch`
push endpoint in attendance_views.py. ADMS is not documented by the vendor in
a way we have access to; this is built against the protocol shape confirmed
across several independent open-source ADMS server implementations
(mmd-rehan/ADMS-server-ZKTeco, saifulcoder/adms-server-ZKTeco, the Laravel
and Odoo ADMS packages) -not verified against this specific unit's firmware,
since nothing has hit this endpoint yet. Every request is logged in full
before any parsing is attempted, specifically so the first real device
request gives us ground truth to correct anything this guessed wrong, rather
than a silent failure with no forensic trail (the same lesson already
applied to biometric_punch in attendance_views.py).

Mounted at the bare root -/iclock/cdata, not under /api/ -because that's the
fixed path ADMS-mode devices are hardcoded to call; see config/urls.py.

No shared-secret header exists in this protocol (unlike X-Device-Key on the
JSON push endpoint) -ADMS devices identify themselves only by a serial
number (SN) in the query string, which isn't a secret. This endpoint is
therefore reachable by anyone who knows the URL, same exposure shape as
/api/biometric/punch minus even the API-key check. Bounded by the fact that
the worst it can do is create AttendanceLog rows for real employee codes;
still, if this needs tightening later (IP allowlist, SN allowlist), do it
here.
"""
from __future__ import annotations

import logging
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from django.views.decorators.csrf import csrf_exempt

from .models import Attendance, AttendanceLog, Employee

logger = logging.getLogger(__name__)

# ZKTeco's standard attendance status codes (ATTLOG table). 0/1 map cleanly
# onto this app's IN/OUT; the rest (break/overtime) have no slot in the
# simple two-value AttendanceLog.punch_type this app uses everywhere else,
# so they're folded onto the same even=IN/odd=OUT pattern rather than
# dropped -logged distinctly so real distribution is visible once live.
_OUT_STATUS_CODES = {1, 3, 5}


def _ok() -> HttpResponse:
    # Every reference ADMS server implementation checked returns a bare
    # "OK" plain-text body for both the handshake and each data push -this
    # is what tells the device "received, don't retry."
    return HttpResponse("OK", content_type="text/plain")


def _handle_handshake(request: HttpRequest) -> HttpResponse:
    """GET /iclock/cdata -device registration/handshake, sent on boot and
    periodically. Params seen across reference implementations: SN, options,
    language, pushver, DeviceType, PushOptionsFlag. Logged in full since the
    exact response this specific firmware expects (beyond a bare 200) isn't
    confirmed -if the device doesn't consider itself successfully
    registered, that will show up here as repeated handshakes with no
    subsequent ATTLOG POSTs ever arriving."""
    logger.warning("ADMS handshake (GET): SN=%s full_query=%r", request.GET.get("SN"), request.GET.urlencode())
    return _ok()


def _parse_attlog_line(line: str) -> dict | None:
    """One ATTLOG line: UserID\\tTimestamp\\tStatus\\tVerifyType\\t...
    (trailing fields vary and aren't used here). Returns None for a line
    that doesn't even have the three fields actually needed -logged, not
    raised, so one malformed line can't take the rest of the batch down."""
    parts = line.split("\t")
    if len(parts) < 3:
        return None
    user_id, timestamp_raw, status_raw = parts[0].strip(), parts[1].strip(), parts[2].strip()
    if not user_id or not timestamp_raw:
        return None
    try:
        dt = datetime.strptime(timestamp_raw, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        logger.warning("ADMS ATTLOG: unparsable timestamp %r in line %r", timestamp_raw, line)
        return None
    try:
        status = int(status_raw)
    except ValueError:
        status = 0
    return {"user_id": user_id, "dt": dt, "status": status}


def _handle_attlog(request: HttpRequest, sn: str) -> HttpResponse:
    """POST /iclock/cdata?table=ATTLOG -the actual attendance push."""
    body = request.body.decode("utf-8", errors="replace")
    logger.warning("ADMS ATTLOG push: SN=%s stamp=%s body=%r", sn, request.GET.get("Stamp"), body)

    processed = 0
    skipped_unparsable = 0
    skipped_no_employee = 0
    duplicates = 0

    for line in body.splitlines():
        if not line.strip():
            continue
        parsed = _parse_attlog_line(line)
        if not parsed:
            skipped_unparsable += 1
            continue

        emp = Employee.objects.filter(employee_code=parsed["user_id"]).first()
        if not emp:
            skipped_no_employee += 1
            logger.warning("ADMS ATTLOG: no employee with code %r (SN=%s)", parsed["user_id"], sn)
            continue

        punch_type = AttendanceLog.PUNCH_OUT if parsed["status"] in _OUT_STATUS_CODES else AttendanceLog.PUNCH_IN
        _log, created = AttendanceLog.objects.get_or_create(
            employee=emp,
            date=parsed["dt"].date(),
            punch_time=parsed["dt"].time().replace(microsecond=0),
            punch_type=punch_type,
            defaults={"source": f"biometric:adms:{sn}" if sn else "biometric:adms"},
        )
        if created:
            processed += 1
            Attendance.objects.update_or_create(
                employee=emp, date=str(parsed["dt"].date()), defaults={"present": True},
            )
        else:
            # Same (employee, date, time, punch_type) already recorded -this
            # is the device retrying a record it never got an "OK" for
            # earlier, not a new punch. The unique_together constraint on
            # AttendanceLog makes this safe to just accept silently rather
            # than error.
            duplicates += 1

    logger.warning(
        "ADMS ATTLOG result: SN=%s processed=%d duplicates=%d skipped_unparsable=%d skipped_no_employee=%d",
        sn, processed, duplicates, skipped_unparsable, skipped_no_employee,
    )
    return _ok()


@csrf_exempt
def adms_cdata(request: HttpRequest) -> HttpResponse:
    """The single ADMS endpoint every request type arrives at, dispatched by
    method and the `table` query param. Plain Django view, not DRF -ADMS
    devices don't send JSON or DRF-recognised content types, and don't carry
    any auth this app's existing require_auth/require_hr decorators could
    check against; see module docstring for what that means for exposure."""
    sn = request.GET.get("SN", "")

    if request.method == "GET":
        return _handle_handshake(request)

    if request.method == "POST":
        table = request.GET.get("table", "")
        if table == "ATTLOG":
            return _handle_attlog(request, sn)
        # OPERLOG (enrollment/admin events) and anything else this device
        # sends -not attendance data, out of scope to parse, but still
        # logged and acknowledged so the device doesn't spin retrying
        # something that was never going to be processed.
        logger.warning(
            "ADMS POST (table=%r, not handled): SN=%s body=%r",
            table, sn, request.body.decode("utf-8", errors="replace")[:2000],
        )
        return _ok()

    return HttpResponse(status=405)
