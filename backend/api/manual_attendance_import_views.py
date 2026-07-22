"""
Manual Biometric Punch Import
==============================
A backup path alongside the live "Sync Biometric" flow: HR can pull the raw
punch list off a device into an Excel file, visually verify it, then upload
that file back in to import whatever's missing. Exists because live sync
occasionally misses punches that genuinely exist on the device, for reasons
that vary case to case — this gives HR a way to close the gap themselves
without waiting on a root-cause fix each time.

Both this and live sync write through the exact same `_ingest_punches()` in
biometric_sync.py, so attendance data always lands identically regardless of
path — the only difference is the `source` tag and how each row's employee
gets resolved (device uid vs. a hand-typed, HR-reviewed Employee Code).

Deliberately does NOT touch AttendanceDayRecord (the payroll source of
truth) — same as live sync, that table is lazily recomputed from
AttendanceLog on the next payroll/attendance read (see
attendance_final.py::compute_day_record). Also deliberately bypasses the
AttendanceOverrideRequest/Department-Head-approval flow — that's for HR-
initiated corrections to an existing day's verdict, not raw punch ingestion,
and live sync already bypasses it the same way.
"""
import io
from datetime import date, datetime, time

from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr
from .attendance_views import _date_from_for_mode
from .biometric_sync import BiometricSyncError, get_sync_targets, fetch_records_for_export, _ingest_punches
from .branch_scope import scope_to_branch
from .models import Employee

EXPORT_HEADERS = [
    "Employee Code", "Employee Name", "Device User ID", "Matched", "Date", "Punch Time", "Punch Type",
]


def _error(message: str, code: int = 400) -> Response:
    return Response({"error": message}, status=code)


@api_view(["GET"])
@require_hr
def export_punch_records(request: Request) -> Response:
    """
    GET /api/attendance/manual-import/export?deviceId=...&mode=day|week|month|all&includeAllEmployees=1
    Read-only — pulls raw punches off the selected device(s) for HR to review
    and export to Excel. Never writes to the database. deviceId may repeat
    (?deviceId=1&deviceId=env) for a multi-device selection, matching the
    Sync Biometric checklist's shape; omitted means "all enabled devices".

    includeAllEmployees=1 additionally appends one marker row per active
    employee (branch-scoped) who has zero matched punches in this range —
    so the file reflects the full Employees table, not just whoever happened
    to punch. These marker rows carry no Date/Punch Time/Punch Type and are
    silently skipped on re-upload (see import_punch_excel below) — they're
    for visibility only, never importable as a punch.
    """
    mode = request.query_params.get("mode", "all")
    device_ids = request.query_params.getlist("deviceId")
    device_id = device_ids if device_ids else None
    include_all_employees = request.query_params.get("includeAllEmployees") in ("1", "true", "True")

    date_from = _date_from_for_mode(mode)

    try:
        targets = get_sync_targets(device_id)
    except BiometricSyncError as exc:
        return _error(str(exc))

    rows = []
    device_errors = []
    succeeded = 0
    for t in targets:
        if t.get("config_error"):
            device_errors.append(f"{t['label']}: {t['config_error']}")
            continue
        try:
            rows.extend(fetch_records_for_export(t["host"], t["port"], t["password"], date_from))
            succeeded += 1
        except BiometricSyncError as exc:
            device_errors.append(f"{t['label']}: {exc}")

    if succeeded == 0:
        return _error("; ".join(device_errors) or "No device could be reached.", 502)

    for r in rows:
        r["kind"] = "punch"

    employees_without_punches = 0
    total_employees = None
    if include_all_employees:
        matched_codes = {r["employeeCode"] for r in rows if r["employeeCode"]}
        active_employees = list(scope_to_branch(Employee.objects, request).filter(status="active"))
        total_employees = len(active_employees)
        for emp in active_employees:
            if emp.employee_code in matched_codes:
                continue
            employees_without_punches += 1
            rows.append({
                "kind": "no_punch",
                "deviceUserId": "",
                "employeeCode": emp.employee_code,
                "employeeName": f"{emp.first_name} {emp.last_name}".strip(),
                "matched": True,
                "date": None,
                "time": None,
                "punchType": "",
            })

    rows.sort(key=lambda r: (r["employeeCode"] or "￿", r["date"] or date(1900, 1, 1), r["time"] or time(0, 0)))

    return Response({
        "rows": [
            {
                **r,
                "date": r["date"].isoformat() if r["date"] else "",
                "time": r["time"].strftime("%H:%M:%S") if r["time"] else "",
            }
            for r in rows
        ],
        "deviceErrors": device_errors,
        "totalEmployees": total_employees,
        "employeesWithoutPunches": employees_without_punches,
    })


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
@require_hr
def import_punch_excel(request: Request) -> Response:
    """
    POST /api/attendance/manual-import/upload — multipart, key 'file'.
    Must be the file downloaded from the export endpoint above (or an exact
    copy of its column layout) — HR may hand-edit cells (most usefully:
    filling in a blank/wrong Employee Code before re-uploading just that row)
    but the header row itself must match exactly, same rule as Bulk Employee
    Upload.
    """
    file = request.FILES.get("file")
    if not file:
        return _error("No file uploaded. Send as multipart/form-data with key 'file'.")

    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(file.read()), data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
    except Exception as e:
        return _error(f"Failed to read the Excel file: {e}")

    if not rows:
        return _error("The uploaded file is empty.")

    def _normalize_header(c) -> str:
        h = str(c).strip() if c is not None else ""
        return h[:-1].rstrip() if h.endswith("*") else h

    header_row = [_normalize_header(c) for c in rows[0]]
    while header_row and header_row[-1] == "":
        header_row.pop()

    if header_row != EXPORT_HEADERS:
        return Response(
            {
                "error": "invalid_template",
                "message": (
                    "Invalid file — please upload the file exactly as downloaded from "
                    "'Download Punching Data', without renaming, reordering, or removing columns."
                ),
            },
            status=400,
        )

    punches: list[tuple[str, date, time, str]] = []
    errors: list[str] = []

    for idx, raw_row in enumerate(rows[1:], start=2):
        if not raw_row or all(c is None or str(c).strip() == "" for c in raw_row):
            continue
        row = dict(zip(EXPORT_HEADERS, raw_row))

        emp_code = str(row.get("Employee Code") or "").strip()
        if not emp_code:
            errors.append(
                f"Row {idx}: Employee Code is blank — this punch couldn't be matched to any "
                "employee when exported. Fill in the correct Employee Code and re-upload just this row."
            )
            continue

        # "No punches found" marker rows (from includeAllEmployees exports) have
        # an Employee Code but no Date/Punch Time/Punch Type — informational
        # only, never a real punch. Skip silently so re-uploading a full-roster
        # file as-is never produces spurious errors.
        has_date = str(row.get("Date") or "").strip() != ""
        has_time = str(row.get("Punch Time") or "").strip() != ""
        has_type = str(row.get("Punch Type") or "").strip() != ""
        if not (has_date or has_time or has_type):
            continue

        raw_date_val = row.get("Date")
        punch_date = None
        if isinstance(raw_date_val, datetime):
            punch_date = raw_date_val.date()
        elif isinstance(raw_date_val, date):
            punch_date = raw_date_val
        else:
            raw = str(raw_date_val or "").strip()
            for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
                try:
                    punch_date = datetime.strptime(raw, fmt).date()
                    break
                except ValueError:
                    continue
        if punch_date is None:
            errors.append(f"Row {idx}: Cannot parse Date '{raw_date_val}'.")
            continue

        raw_time_val = row.get("Punch Time")
        punch_time = None
        if isinstance(raw_time_val, time):
            punch_time = raw_time_val.replace(microsecond=0)
        elif isinstance(raw_time_val, datetime):
            punch_time = raw_time_val.time().replace(microsecond=0)
        else:
            raw = str(raw_time_val or "").strip()
            for fmt in ("%H:%M:%S", "%H:%M"):
                try:
                    punch_time = datetime.strptime(raw, fmt).time()
                    break
                except ValueError:
                    continue
        if punch_time is None:
            errors.append(f"Row {idx}: Cannot parse Punch Time '{raw_time_val}'.")
            continue

        punch_type = str(row.get("Punch Type") or "").strip().upper()
        if punch_type not in ("IN", "OUT"):
            errors.append(f"Row {idx}: Punch Type must be IN or OUT, got '{row.get('Punch Type')}'.")
            continue

        punches.append((emp_code, punch_date, punch_time, punch_type))

    if not punches:
        return Response({
            "message": f"No valid rows to import. {len(errors)} row(s) had errors."
            if errors else "No rows found to import.",
            "created": 0, "skipped": 0, "notFound": [], "errors": errors, "suspiciousDays": [],
        }, status=400 if errors else 200)

    result = _ingest_punches(punches, date_from=None, source_tag="biometric:excel-import")

    not_found_list = sorted(result["notFound"])
    if not_found_list:
        shown = ", ".join(not_found_list[:10])
        more = f" and {len(not_found_list) - 10} more" if len(not_found_list) > 10 else ""
        errors.append(f"Employee Code(s) not found among active employees: {shown}{more}.")

    return Response({
        "message": f"Imported {result['created']} punch{'es' if result['created'] != 1 else ''}, "
                   f"skipped {result['skipped']} (already recorded or unmatched).",
        "created": result["created"],
        "skipped": result["skipped"],
        "notFound": not_found_list,
        "errors": errors,
        "suspiciousDays": result["suspiciousDays"],
    }, status=201)
