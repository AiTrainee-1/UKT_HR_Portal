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

from .device_health import record_device_push, record_unmatched_punch
from .models import Attendance, AttendanceLog, Employee

logger = logging.getLogger(__name__)

# Status-code → IN/OUT mapping is imported from biometric_sync rather than
# redefined here, so the ADMS push path and the pull path can never disagree
# about what a given punch means. They briefly did: a locally-defined table
# here mapped status 3 to OUT while the pull path's _STATUS_MAP falls through
# to IN for it, meaning the same physical punch would have been recorded
# differently depending purely on which path happened to ingest it.
#
# Real devices on this site send status 255 ("undefined"), which both paths
# treat as IN via the same shared default -confirmed against live ATTLOG
# pushes, where every record carried status=255.
from .biometric_sync import _STATUS_MAP  # noqa: E402  (kept beside its explanation)


def _ok() -> HttpResponse:
    # Every reference ADMS server implementation checked returns a bare
    # "OK" plain-text body for both the handshake and each data push -this
    # is what tells the device "received, don't retry."
    return HttpResponse("OK", content_type="text/plain")


def _handle_handshake(request: HttpRequest) -> HttpResponse:
    """GET /iclock/cdata[.aspx] -device registration/handshake, sent on boot
    and periodically.

    A bare "OK" is NOT enough here: the device expects a config block back and
    uses it to decide how (and whether) to push data afterwards. The key line
    is TransFlag, which enables the record types it will send -without it a
    device can handshake happily and then never send a single ATTLOG.

    Realtime=1 asks the device to push each punch as it happens rather than
    batching, which is what makes attendance appear in the portal live.
    """
    sn = request.GET.get("SN", "")
    logger.warning("ADMS handshake (GET): SN=%s full_query=%r", sn, request.GET.urlencode())

    # TimeZone is advisory only for this app: punches arrive as local wall
    # time ("2026-08-27 09:15:00") and AttendanceLog stores date and time as
    # separate naive fields, exactly as the pull-based sync does -so no
    # timezone conversion happens on either path.
    config = "\n".join([
        f"GET OPTION FROM: {sn}",
        "Stamp=9999",
        "OpStamp=9999",
        "ErrorDelay=30",
        "Delay=10",
        "TransTimes=00:00;14:05",
        "TransInterval=1",
        "TransFlag=1111000000",
        "TimeZone=5.5",
        "Realtime=1",
        "Encrypt=0",
    ])
    return HttpResponse(config + "\n", content_type="text/plain")


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
            # Recorded, not just logged: a log line is invisible in the portal,
            # so real people were punching daily and having it silently
            # discarded with no way for HR to notice. Surfaces on the
            # Attendance page's "Skipped" view.
            record_unmatched_punch(
                device_user_id=parsed["user_id"],
                device_serial=sn,
                punch_dt=parsed["dt"],
            )
            continue

        punch_type = _STATUS_MAP.get(parsed["status"], AttendanceLog.PUNCH_IN)
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
    check against; see module docstring for what that means for exposure.

    Registered under both /iclock/cdata and /iclock/cdata.aspx: the firmware
    on this site's AiFace-Mars ("iClock Proxy/1.09") calls the .aspx form,
    while other ZKTeco firmware calls it without -so both are accepted
    rather than betting on one.
    """
    sn = request.GET.get("SN", "")
    # Any contact at all counts as a heartbeat -handshake, options, OPERLOG,
    # BIODATA, not just attendance. A device with nobody punching is quiet but
    # healthy, and the Sync indicator must not call that a failure.
    record_device_push(sn)

    if request.method == "GET":
        return _handle_handshake(request)

    if request.method == "POST":
        table = request.GET.get("table", "")
        if table == "ATTLOG":
            return _handle_attlog(request, sn)
        # Everything else the device pushes: "options" (its own capability
        # list, sent right after handshake), OPERLOG (enrollment/admin
        # events), and any other table. None are attendance data, so they're
        # logged and acknowledged rather than parsed -an unacknowledged push
        # makes the device retry the same payload indefinitely.
        logger.warning(
            "ADMS POST (table=%r, acknowledged without parsing): SN=%s body=%r",
            table, sn, request.body.decode("utf-8", errors="replace")[:2000],
        )
        return _ok()

    return HttpResponse(status=405)


@csrf_exempt
def adms_getrequest(request: HttpRequest) -> HttpResponse:
    """GET /iclock/getrequest[.aspx] -the device polling for server-issued
    commands (remote door open, user sync, reboot, ...). This app never issues
    any, so a bare "OK" correctly means "nothing queued for you". Must still
    exist: a 404 here makes the device treat the whole server as unreachable
    and it can stop pushing attendance entirely."""
    logger.info("ADMS getrequest: SN=%s", request.GET.get("SN", ""))
    return _ok()


@csrf_exempt
def adms_devicecmd(request: HttpRequest) -> HttpResponse:
    """POST /iclock/devicecmd[.aspx] -device reporting the result of a command
    it was given. Nothing issues commands here, but acknowledging keeps the
    device from retrying if it ever posts one."""
    logger.info("ADMS devicecmd: SN=%s body=%r", request.GET.get("SN", ""),
                request.body.decode("utf-8", errors="replace")[:500])
    return _ok()
