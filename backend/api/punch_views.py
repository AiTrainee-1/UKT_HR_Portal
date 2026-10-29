"""
Attendance page support views: Skipped, Punch View, Sync status, Errors.

These replace the three device-dependent features (Sync Biometric, Manual
Import, Auto Sync) for a cloud-hosted backend. The key difference: nothing
here ever contacts a biometric device. Every endpoint reads data already in
the database -put there by the ADMS push path -so none of it can hang, time
out, or fail because the device sits on an unreachable private LAN.

That also means Punch View's export/import round-trip is safe to run from
anywhere, unlike the old Manual Import which had to reach the device first
just to produce the file.
"""
from __future__ import annotations

import io
from datetime import datetime

from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .view_common import error_response as _error
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .device_health import device_health
from .models import Attendance, AttendanceLog, Employee, UnmatchedPunch

# Must stay in step with the import parser below -the round trip only works
# if what we write is exactly what we expect to read back.
PUNCH_EXPORT_HEADERS = [
    "Punch ID", "Employee Code", "Employee Name", "Department",
    "Date", "Punch Time", "Punch Type", "Source",
]


# The columns that say WHICH punch a row is and WHEN: a sheet cannot be read without them. The other three are shown for
# the reader's benefit (the employee and the source come from the punch itself), so they may be removed.
PUNCH_REQUIRED_HEADERS = ["Punch ID", "Employee Code", "Date", "Punch Time", "Punch Type"]
PUNCH_SHEET = "Punches"
# The hidden sheet every download carries: the IDs of the punches it listed (column A) and what filter it was made with.
# It is what lets an upload tell "removed from the sheet" from "was never in this download".
EXPORT_RECORD_SHEET = "Export record"


# ── Skipped: device IDs with no matching employee ────────────────────────

@api_view(["GET"])
@require_hr
def skipped_punches(request: Request) -> Response:
    """Device user IDs that punched but match no Employee.

    ?includeResolved=1 to also list ones already dealt with.
    """
    qs = UnmatchedPunch.objects.all()
    if request.query_params.get("includeResolved") not in ("1", "true", "True"):
        qs = qs.filter(resolved=False)

    rows = [{
        "id": u.id,
        "deviceUserId": u.device_user_id,
        "deviceLabel": u.device_label or None,
        "deviceSerial": u.device_serial or None,
        "punchCount": u.punch_count,
        "firstSeenAt": u.first_seen_at.isoformat() if u.first_seen_at else None,
        "lastSeenAt": u.last_seen_at.isoformat() if u.last_seen_at else None,
        "lastPunchDate": str(u.last_punch_date) if u.last_punch_date else None,
        "lastPunchTime": u.last_punch_time.strftime("%H:%M:%S") if u.last_punch_time else None,
        "resolved": u.resolved,
        "resolvedNote": u.resolved_note or None,
    } for u in qs]

    return Response({
        "results": rows,
        "unresolvedCount": UnmatchedPunch.objects.filter(resolved=False).count(),
        # Total punches being discarded -the number that actually conveys
        # the cost of leaving these unresolved.
        "discardedPunches": sum(u.punch_count for u in UnmatchedPunch.objects.filter(resolved=False)),
    })


@api_view(["POST"])
@require_hr
def resolve_skipped_punch(request: Request, pk: int) -> Response:
    """Mark one unmatched ID as dealt with. Kept, not deleted -if that ID
    punches again it un-resolves itself and reappears (see
    device_health.record_unmatched_punch)."""
    row = UnmatchedPunch.objects.filter(pk=pk).first()
    if not row:
        return _error("Not found", 404)
    row.resolved = True
    row.resolved_note = str(request.data.get("note") or "").strip()[:500]
    row.save(update_fields=["resolved", "resolved_note"])
    log_action(
        request, "update", "attendance", record_id=row.id,
        description=f"Resolved unmatched device ID {row.device_user_id}",
    )
    return Response({"ok": True})


# ── Punch View: everything already in the database ───────────────────────

def _filtered_punches(request: Request):
    """Shared filter for the list and the Excel export, so a download can
    never disagree with what's on screen."""
    # Person-wise, not time-wise: all of one employee's punches stay together,
    # in the order they happened, before the next employee begins. A purely
    # chronological feed interleaves everybody, so checking whether one
    # person's day looks right means hunting their rows out of hundreds.
    #
    # Name → date → time, all ascending. Ascending time matters: within a day
    # the rows then read as the actual sequence of the shift (first IN, last
    # OUT), which is how you spot a missing punch.
    #
    # The Excel export shares this function, so a download always matches the
    # on-screen order rather than quietly re-sorting.
    qs = (
        AttendanceLog.objects
        .select_related("employee", "employee__department")
        .order_by(
            "employee__first_name", "employee__last_name", "employee_id",
            "date", "punch_time",
        )
    )
    qs = scope_to_branch(qs, request, field="employee__branch_id")

    p = request.query_params
    if p.get("dateFrom"):
        qs = qs.filter(date__gte=p["dateFrom"])
    if p.get("dateTo"):
        qs = qs.filter(date__lte=p["dateTo"])
    if p.get("employeeId"):
        qs = qs.filter(employee_id=p["employeeId"])
    if p.get("employmentType") in ("staff", "production"):
        qs = qs.filter(employee__employment_type=p["employmentType"])
    if p.get("punchType") in (AttendanceLog.PUNCH_IN, AttendanceLog.PUNCH_OUT):
        qs = qs.filter(punch_type=p["punchType"])
    if p.get("source"):
        qs = qs.filter(source__icontains=p["source"])
    if p.get("search"):
        from django.db.models import Q
        s = p["search"].strip()
        qs = qs.filter(
            Q(employee__employee_code__icontains=s)
            | Q(employee__first_name__icontains=s)
            | Q(employee__last_name__icontains=s)
        )
    return qs


def _punch_row(log: AttendanceLog) -> dict:
    emp = log.employee
    return {
        "id": log.id,
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}".strip(),
        "department": emp.department.name if emp.department else None,
        "employmentType": emp.employment_type,
        "date": str(log.date),
        "punchTime": log.punch_time.strftime("%H:%M:%S"),
        "punchType": log.punch_type,
        "source": log.source,
    }


@api_view(["GET"])
@require_hr
def punch_list(request: Request) -> Response:
    """Paged punch list for the Punch View table. Reads only the database —
    never touches a device, so it works regardless of where the backend runs."""
    qs = _filtered_punches(request)
    total = qs.count()

    try:
        limit = min(int(request.query_params.get("limit", 200)), 1000)
        offset = int(request.query_params.get("offset", 0))
    except ValueError:
        return _error("limit/offset must be numbers")

    return Response({
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [_punch_row(l) for l in qs[offset:offset + limit]],
    })


@api_view(["GET"])
@require_hr
def punch_export(request: Request) -> HttpResponse:
    """The current filter, as .xlsx. Includes Punch ID because the re-import
    below matches on it -that's what makes editing a downloaded file and
    uploading it back an update rather than a duplicate insert. A hidden
    sheet lists the punches the file holds, so the upload can also delete
    the ones removed from the sheet."""
    qs = _filtered_punches(request)

    wb = Workbook()
    ws = wb.active
    ws.title = PUNCH_SHEET
    ws.append(PUNCH_EXPORT_HEADERS)

    fill = PatternFill("solid", fgColor="006496")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(horizontal="left", vertical="center")

    count = 0
    exported: list[int] = []
    for log in qs.iterator(chunk_size=1000):
        emp = log.employee
        exported.append(log.id)
        ws.append([
            log.id,
            str(emp.employee_code or ""),
            f"{emp.first_name} {emp.last_name}".strip(),
            emp.department.name if emp.department else "",
            str(log.date),
            log.punch_time.strftime("%H:%M:%S"),
            log.punch_type,
            log.source or "",
        ])
        count += 1

    # Employee Code as text so codes like "007" keep their leading zero.
    for col, width in zip("ABCDEFGH", (10, 16, 28, 20, 14, 14, 12, 24)):
        ws.column_dimensions[col].width = width
    ws.column_dimensions["B"].number_format = "@"
    ws.freeze_panes = "A2"

    # The record of what this download listed, in a hidden sheet (see EXPORT_RECORD_SHEET).
    record = wb.create_sheet(EXPORT_RECORD_SHEET)
    record.append(["Exported Punch ID", None, "Setting", "Value"])
    q = request.query_params
    meta = [
        ("Exported at", timezone.now().isoformat(timespec="seconds")),
        ("Punches", count),
        ("Date from", q.get("dateFrom") or ""),
        ("Date to", q.get("dateTo") or ""),
        ("Employment type", q.get("employmentType") or ""),
        ("Punch type", q.get("punchType") or ""),
        ("Search", q.get("search") or ""),
        ("Note", "Do not edit this sheet: it tells Punch View which punches this file listed."),
    ]
    for i in range(max(len(exported), len(meta))):
        key, value = meta[i] if i < len(meta) else (None, None)
        record.append([exported[i] if i < len(exported) else None, None, key, value])
    record.sheet_state = "hidden"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"punches-{timezone.localdate().isoformat()}.xlsx"
    resp = HttpResponse(
        buf.read(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    log_action(request, "export", "attendance", description=f"Exported {count} punches")
    return resp


@api_view(["POST"])
@require_hr
@parser_classes([MultiPartParser, FormParser])
def punch_import(request: Request) -> Response:
    """Re-import an edited export, so the system matches the file: additions, updates AND deletions.

    * A row carrying a Punch ID updates that punch; a row with the ID blank is a new punch.
    * A punch that was in the downloaded file and is no longer in the uploaded one is DELETED, but only when the
      request says so (``deleteMissing=1``). What "was in the downloaded file" is read from the export record the
      download carries in a hidden sheet (the IDs it listed), never guessed from the filters: a punch that arrived
      after the download, or one the download's filter never showed, is never touched. A file without that sheet
      (an old download, or the sheet removed) deletes nothing.
    * ``preview=1`` works everything out and changes nothing, so the page can show what will be deleted and ask first.
    * A column the system keeps for display (Employee Name, Department, Source) may be left out of the sheet; the
      columns that say which punch it is and when (Punch ID, Employee Code, Date, Punch Time, Punch Type) may not.
      Removing a column from the sheet never removes it from the system.
    """
    f = request.FILES.get("file")
    if not f:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")
    preview = _flag(request, "preview")
    delete_missing = _flag(request, "deleteMissing")

    try:
        wb = load_workbook(io.BytesIO(f.read()), data_only=True)
        ws = wb[PUNCH_SHEET] if PUNCH_SHEET in wb.sheetnames else wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
        exported_ids = _exported_ids(wb)
    except Exception as exc:  # noqa: BLE001
        return _error(f"Could not read that Excel file: {exc}")

    if not rows:
        return _error("The uploaded file is empty.")

    header = [str(c).strip() if c is not None else "" for c in rows[0]]
    while header and header[-1] == "":
        header.pop()
    unknown = [h for h in header if h not in PUNCH_EXPORT_HEADERS]
    missing = [h for h in PUNCH_REQUIRED_HEADERS if h not in header]
    if unknown or missing or len(set(header)) != len(header):
        why = []
        if unknown:
            why.append("unknown column " + ", ".join(repr(h) for h in unknown))
        if missing:
            why.append("missing column " + ", ".join(repr(h) for h in missing))
        if len(set(header)) != len(header):
            why.append("a column appears twice")
        return _error(
            "Unrecognised columns (" + "; ".join(why) + "). Upload a file downloaded from Punch View; "
            "Employee Name, Department and Source may be removed, the other columns may not."
        )

    updated = created = unchanged = 0
    errors: list[str] = []
    seen_ids: set[int] = set()  # every Punch ID in the sheet, rejected rows included: a row with a typo is not a deletion
    data_rows = 0
    plan: list[tuple] = []  # what to write, in sheet order; nothing is written until the plan is complete

    for idx, raw in enumerate(rows[1:], start=2):
        if not raw or all(c is None or str(c).strip() == "" for c in raw):
            continue
        data_rows += 1
        row = dict(zip(header, raw))

        punch_id = row.get("Punch ID")
        existing = None
        if str(punch_id or "").strip().isdigit():
            seen_ids.add(int(str(punch_id).strip()))
            existing = AttendanceLog.objects.filter(pk=int(str(punch_id).strip())).first()

        code = str(row.get("Employee Code") or "").strip()
        date_raw = row.get("Date")
        time_raw = row.get("Punch Time")
        ptype = str(row.get("Punch Type") or "").strip().upper()

        if ptype not in (AttendanceLog.PUNCH_IN, AttendanceLog.PUNCH_OUT):
            errors.append(f"Row {idx}: Punch Type must be IN or OUT (got {ptype!r})")
            continue

        emp = Employee.objects.filter(employee_code=code).first()
        if not emp:
            errors.append(f"Row {idx}: no employee with code {code!r}")
            continue

        try:
            pdate = date_raw.date() if isinstance(date_raw, datetime) else datetime.strptime(str(date_raw).strip()[:10], "%Y-%m-%d").date()
            if isinstance(time_raw, datetime):
                ptime = time_raw.time()
            elif hasattr(time_raw, "hour"):
                ptime = time_raw
            else:
                ptime = datetime.strptime(str(time_raw).strip()[:8], "%H:%M:%S").time()
            ptime = ptime.replace(microsecond=0)
        except (ValueError, TypeError, AttributeError):
            errors.append(f"Row {idx}: bad Date/Punch Time ({date_raw!r} {time_raw!r}) -expected YYYY-MM-DD and HH:MM:SS")
            continue

        if existing:
            if (existing.employee_id == emp.id and existing.date == pdate
                    and existing.punch_time == ptime and existing.punch_type == ptype):
                unchanged += 1
                continue
            # Guard the unique constraint rather than letting the DB raise:
            # an edit that collides with a punch that already exists should
            # report the conflict, not 500.
            clash = AttendanceLog.objects.filter(
                employee=emp, date=pdate, punch_time=ptime, punch_type=ptype,
            ).exclude(pk=existing.pk).exists()
            if clash:
                errors.append(f"Row {idx}: that punch already exists for {code} -edit skipped")
                continue
            plan.append(("update", existing, emp, pdate, ptime, ptype))
            updated += 1
        elif AttendanceLog.objects.filter(employee=emp, date=pdate, punch_time=ptime, punch_type=ptype).exists():
            unchanged += 1
            plan.append(("present", None, emp, pdate, ptime, ptype))
        else:
            plan.append(("create", None, emp, pdate, ptime, ptype))
            created += 1

    # ── deletions: what the download listed and the file no longer has ──
    to_delete = AttendanceLog.objects.none()
    if exported_ids is not None:
        gone = exported_ids - seen_ids
        if gone:
            to_delete = scope_to_branch(
                AttendanceLog.objects.filter(pk__in=gone), request, field="employee__branch_id",
            ).select_related("employee")
    delete_count = to_delete.count() if exported_ids is not None else 0
    delete_sample = [_deleted_row(log) for log in to_delete.order_by("employee__employee_code", "date", "punch_time")[:20]] if delete_count else []

    result = {
        "ok": True,
        "preview": preview,
        "updated": updated,
        "created": created,
        "unchanged": unchanged,
        "errors": errors[:100],
        "errorCount": len(errors),
        # a file from an old download (or with the record sheet removed) can add and update but never delete
        "canDelete": exported_ids is not None,
        "exportedCount": len(exported_ids) if exported_ids is not None else 0,
        "toDelete": delete_count,
        "deleteSample": delete_sample,
        "deleted": 0,
        "deleteAll": exported_ids is not None and bool(exported_ids) and not (exported_ids & seen_ids) and delete_count > 0,
    }
    if preview:
        return Response(result)

    with transaction.atomic():
        for kind, existing, emp, pdate, ptime, ptype in plan:
            if kind == "update":
                existing.employee = emp
                existing.date = pdate
                existing.punch_time = ptime
                existing.punch_type = ptype
                existing.save(update_fields=["employee", "date", "punch_time", "punch_type"])
            elif kind == "create":
                AttendanceLog.objects.get_or_create(
                    employee=emp, date=pdate, punch_time=ptime, punch_type=ptype,
                    defaults={"source": "manual:punch-view"},
                )
            Attendance.objects.update_or_create(employee=emp, date=str(pdate), defaults={"present": True})

        if delete_missing and delete_count:
            doomed = list(to_delete)
            summary = [f"{d.employee.employee_code} {d.date} {d.punch_time:%H:%M:%S} {d.punch_type}" for d in doomed[:500]]
            AttendanceLog.objects.filter(pk__in=[d.pk for d in doomed]).delete()
            result["deleted"] = len(doomed)
            log_action(
                request, "delete", "attendance",
                description=f"Punch View import deleted {len(doomed)} punch(es) that were removed from the sheet",
                old_values={"deletedPunches": summary, "listed": len(summary), "total": len(doomed)},
            )

    log_action(
        request, "update", "attendance",
        description=(
            f"Punch View import: {updated} updated, {created} created, {result['deleted']} deleted, "
            f"{len(errors)} rejected"
        ),
    )
    result["skippedDeletes"] = 0 if delete_missing else delete_count
    return Response(result)


def _flag(request: Request, name: str) -> bool:
    return str(request.data.get(name) or request.query_params.get(name) or "").strip().lower() in ("1", "true", "yes")


def _deleted_row(log: AttendanceLog) -> dict:
    emp = log.employee
    return {
        "id": log.id,
        "employeeCode": emp.employee_code,
        "employeeName": f"{emp.first_name} {emp.last_name}".strip(),
        "date": str(log.date),
        "punchTime": log.punch_time.strftime("%H:%M:%S"),
        "punchType": log.punch_type,
    }


def _exported_ids(wb) -> set[int] | None:
    """The punch IDs the download listed (its hidden record sheet), or None when the file has no such record."""
    if EXPORT_RECORD_SHEET not in wb.sheetnames:
        return None
    ids: set[int] = set()
    for row in wb[EXPORT_RECORD_SHEET].iter_rows(min_row=2, max_col=1, values_only=True):
        v = row[0] if row else None
        if v is None or str(v).strip() == "":
            continue
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if not str(v).strip().isdigit():
            return None  # the record was edited by hand: trust none of it
        ids.add(int(str(v).strip()))
    return ids


# ── Sync status + Errors ─────────────────────────────────────────────────

@api_view(["GET"])
@require_hr
def sync_status(request: Request) -> Response:
    """Live device health, for the blinking Sync indicator and Errors view.

    Cheap enough to poll: a handful of rows plus recent-punch counts, no
    device contact.
    """
    health = device_health()

    today = timezone.localdate()
    todays_punches = AttendanceLog.objects.filter(date=today).count()
    latest = AttendanceLog.objects.order_by("-date", "-punch_time").first()

    health.update({
        "punchesToday": todays_punches,
        "lastPunchAt": (
            f"{latest.date} {latest.punch_time.strftime('%H:%M:%S')}" if latest else None
        ),
        "unresolvedSkipped": UnmatchedPunch.objects.filter(resolved=False).count(),
    })
    return Response(health)
