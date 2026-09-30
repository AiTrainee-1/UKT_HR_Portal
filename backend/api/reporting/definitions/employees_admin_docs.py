"""Employee documents (compliance matrix, upload log) and Mobile App Access."""

from __future__ import annotations

from collections import defaultdict

from django.db.models import BooleanField, Case, Count, Q, Value, When

from api.employee_documents_views import _REQUIRED_COMMON, _required_categories
from api.models import EmployeeDocument, PushToken

from ..common import EMP_COLS, emp_cells
from ..filters import date_range, select, scope, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, PERCENT, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_admin_util import (
    employee_qs,
    ist_date,
    ist_range_q,
    label,
    natural_key,
    pct,
    status_label,
    type_label,
)

DOC_LABEL = dict(EmployeeDocument.CATEGORY_CHOICES)
_STAFF_LETTER = EmployeeDocument.CATEGORY_STAFF_LETTER
_PRODUCTION_DOCS = EmployeeDocument.CATEGORY_PRODUCTION_DOCS


# ── Employee Document Compliance ────────────────────────────────────────────

_COMPLIANCE_STATES = (
    ("all", "All employees"),
    ("pending", "Pending (something missing)"),
    ("complete", "Complete"),
)
_MISSING_OPTIONS = [(c, DOC_LABEL[c]) for c in (*_REQUIRED_COMMON, _STAFF_LETTER, _PRODUCTION_DOCS)]


def _run_compliance(ctx):
    state = ctx.param("state", "pending")
    only_missing = ctx.param("missingCategory")

    have: dict[int, set[str]] = defaultdict(set)
    last: dict[int, object] = {}
    for emp_id, category, at in EmployeeDocument.objects.filter(ctx.emp_q("employee__")).values_list(
        "employee_id", "category", "uploaded_at"
    ):
        have[emp_id].add(category)
        if at is not None and (emp_id not in last or at > last[emp_id]):
            last[emp_id] = at

    checked = complete = 0
    missing_by_category: dict[str, int] = defaultdict(int)
    rows = []
    for emp in employee_qs(ctx):
        required = _required_categories(emp.employment_type)
        got = have.get(emp.id, set())
        missing = [c for c in required if c not in got]
        checked += 1
        if not missing:
            complete += 1
        for c in missing:
            missing_by_category[c] += 1
        if state == "pending" and not missing:
            continue
        if state == "complete" and missing:
            continue
        if only_missing and only_missing not in missing:
            continue
        row = {
            **emp_cells(emp),
            "employmentType": type_label(emp.employment_type),
            "typeSpecific": "Missing" if required[-1] in missing else "Uploaded",
            "uploadedCount": len(required) - len(missing),
            "missingCount": len(missing),
            "missing": ", ".join(DOC_LABEL[c] for c in missing) or None,
            "lastUploadedOn": ist_date(last.get(emp.id)),
            "completionPct": pct(len(required) - len(missing), len(required)),
        }
        for c in _REQUIRED_COMMON:
            row[c] = "Missing" if c in missing else "Uploaded"
        rows.append(row)
    rows.sort(key=lambda r: natural_key(r["employeeCode"]))

    notes = [
        "Required documents: PAN card, Aadhaar card, educational certificate, voter ID or birth certificate and "
        "bank passbook, plus the Staff Letter (staff) or Production Employee Documents (production) - the same "
        "rule as the Documents page. Offer, experience and resignation letters are never required.",
        "A category counts as uploaded when at least one file exists for it; the file itself is not opened or verified.",
    ]
    if missing_by_category:
        parts = [f"{DOC_LABEL[c]} {n}" for c, n in sorted(missing_by_category.items(), key=lambda kv: (-kv[1], kv[0]))]
        notes.append("Missing by category (all employees checked): " + ", ".join(parts) + ".")
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employees checked", "value": checked, "format": "integer"},
            {"label": "Complete", "value": complete, "format": "integer"},
            {"label": "Pending", "value": checked - complete, "format": "integer"},
            {"label": "Completion", "value": pct(complete, checked), "format": "percent"},
        ],
        notes=notes,
    )


register(
    ReportSpec(
        id="document-compliance",
        title="Employee Document Compliance",
        description="Per-employee matrix of the required documents uploaded vs missing, with completion percentage.",
        category="employees",
        icon="FolderOpen",
        tags=("documents", "kyc", "pan", "aadhaar", "passbook", "pending documents"),
        family="employee-documents",
        variant="Compliance",
        modules=("recruitment.documents",),
        filters=(
            *scope(status="active", employee=True),
            select("state", "Show", _COMPLIANCE_STATES, default="pending"),
            select("missingCategory", "Missing document", _MISSING_OPTIONS, placeholder="Any"),
        ),
        columns=(
            # widths are tuned so no badge, date or header word breaks mid-word on the printed page (16 columns)
            ColumnSpec("employeeCode", "Emp Code", TEXT, 0.9),
            ColumnSpec("employeeName", "Employee", TEXT, 2.0),
            ColumnSpec("department", "Department", TEXT, 1.4),
            ColumnSpec("employmentType", "Type", BADGE, 1.2),
            ColumnSpec("pan_card", "PAN", BADGE, 1.1),
            ColumnSpec("aadhaar_card", "Aadhaar", BADGE, 1.1),
            ColumnSpec("educational_certificate", "Education Cert.", BADGE, 1.3),
            ColumnSpec("voter_id_or_birth_certificate", "Voter ID / Birth Cert.", BADGE, 1.1),
            ColumnSpec("bank_passbook", "Passbook", BADGE, 1.2),
            ColumnSpec("typeSpecific", "Staff Letter / Production Docs", BADGE, 1.3),
            ColumnSpec("uploadedCount", "Uploaded", INTEGER, 1.2, total="sum"),
            ColumnSpec("missingCount", "Missing", INTEGER, 1.0, total="sum"),
            ColumnSpec("missing", "Missing Documents", TEXT, 2.4),
            ColumnSpec("lastUploadedOn", "Last Upload", DATE, 1.4),
            ColumnSpec("completionPct", "Complete %", PERCENT, 1.2, total="avg"),
        ),
        run=_run_compliance,
    )
)


# ── Document Upload Log ─────────────────────────────────────────────────────


def _run_upload_log(ctx):
    q = ctx.emp_q("employee__") & ist_range_q("uploaded_at", ctx.date_from, ctx.date_to)
    categories = ctx.param("category", [])
    if categories:
        q &= Q(category__in=categories)
    uploader = ctx.param("uploadedBy")
    if uploader:
        q &= Q(uploaded_by__icontains=uploader)

    base = EmployeeDocument.objects.filter(q)
    docs = (
        base.select_related("employee", "employee__department", "employee__designation")
        .defer("file", "employee__photo_url", "employee__password_hash")
        .order_by("-uploaded_at", "-id")[: ctx.row_limit]
    )
    rows = []
    for d in docs:
        rows.append(
            {
                "uploadedAt": fmt_dt(d.uploaded_at),
                **emp_cells(d.employee),
                "category": DOC_LABEL.get(d.category, label(d.category)),
                "originalFilename": d.original_filename,
                "uploadedBy": d.uploaded_by or None,
            }
        )

    agg = base.order_by().aggregate(files=Count("id"), people=Count("employee_id", distinct=True))
    top = base.order_by().values("uploaded_by").annotate(n=Count("id")).order_by("-n", "uploaded_by").first()
    top_text = None
    if top:
        top_text = f"{top['uploaded_by'] or 'Unknown'} ({top['n']})"
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Files uploaded", "value": agg["files"], "format": "integer"},
            {"label": "Employees covered", "value": agg["people"], "format": "integer"},
            {"label": "Top uploader", "value": top_text, "format": "text"},
        ],
        notes=[
            "Lists uploads made in the period (IST). File contents and download links are never included.",
            "'Uploaded by' is the name recorded at upload time.",
        ],
    )


register(
    ReportSpec(
        id="document-upload-log",
        title="Document Upload Log",
        description="Who uploaded which employee document and when.",
        category="employees",
        icon="History",
        tags=("documents", "uploads", "audit"),
        family="employee-documents",
        variant="Upload log",
        modules=("recruitment.documents",),
        filters=(
            date_range("thisMonth", label="Uploaded between"),
            select("category", "Document type", EmployeeDocument.CATEGORY_CHOICES, multi=True, placeholder="All types"),
            text("uploadedBy", "Uploaded by", "Name"),
            *scope(status=None),
        ),
        columns=(
            ColumnSpec("uploadedAt", "Uploaded At", DATETIME, 1.4),
            *EMP_COLS,
            ColumnSpec("category", "Document", TEXT, 1.8),
            ColumnSpec("originalFilename", "File Name", TEXT, 2.2),
            ColumnSpec("uploadedBy", "Uploaded By", TEXT, 1.4),
        ),
        run=_run_upload_log,
    )
)


# ── Mobile App Access ───────────────────────────────────────────────────────

_ACCESS = (
    ("all", "Everyone"),
    ("has_access", "Has app access (password set)"),
    ("no_access", "No access (never set up)"),
    ("signed_in", "Signed in"),
    ("never_signed_in", "No sign-in recorded"),
)


def _run_mobile_access(ctx):
    access = ctx.param("access", "all")
    emps = list(
        employee_qs(ctx)
        .annotate(
            has_pw=Case(
                When(Q(password_hash__isnull=False) & ~Q(password_hash=""), then=Value(True)),
                default=Value(False),
                output_field=BooleanField(),
            )
        )
        .order_by("employee_code")
    )
    devices = {
        r["employee_id"]: r["n"]
        for r in PushToken.objects.filter(ctx.emp_q("employee__"))
        .order_by()
        .values("employee_id")
        .annotate(n=Count("id"))
    }
    has_access = [e for e in emps if e.has_pw]
    no_access = [e for e in emps if not e.has_pw]
    signed_in = [e for e in has_access if e.last_mobile_login_at]
    if access == "has_access":
        shown = has_access
    elif access == "no_access":
        shown = no_access
    elif access == "signed_in":
        shown = signed_in
    elif access == "never_signed_in":
        shown = [e for e in emps if not e.last_mobile_login_at]
    else:
        shown = emps
    shown = sorted(shown, key=lambda e: natural_key(e.employee_code))

    rows = []
    for e in shown:
        rows.append(
            {
                **emp_cells(e),
                "employmentType": type_label(e.employment_type),
                "phone": e.phone or None,
                "status": status_label(e.status),
                "appPassword": "Set" if e.has_pw else "Not set",
                "passwordUpdatedAt": fmt_dt(e.password_updated_at),
                "lastAppLogin": fmt_dt(e.last_mobile_login_at),
                "devices": devices.get(e.id, 0),
                "liveTracking": "On" if e.location_tracking_enabled else "Off",
                "coEmp": "On" if e.co_emp_enabled else "Off",
            }
        )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Employees", "value": len(emps), "format": "integer"},
            {"label": "Has app access", "value": len(has_access), "format": "integer"},
            {"label": "No access", "value": len(no_access), "format": "integer"},
            {"label": "Signed in", "value": len(signed_in), "format": "integer"},
            {
                "label": "Active without access",
                "value": sum(1 for e in no_access if e.status == "active"),
                "format": "integer",
            },
        ],
        notes=[
            "Passwords are never shown: 'Set' only means an app password exists.",
            "Last sign-in is recorded only since the release that added it (it is also stamped by WhatsApp-code "
            "sign-in), so 'no sign-in recorded' can mean 'not since then'.",
            "The app does not check employee status at sign-in: an inactive employee with a password can still sign in.",
            "Devices = push-notification registrations, i.e. phones where the app ran while signed in.",
            "The Mobile App Login page lists staff only; this report covers every employee type unless filtered.",
        ],
    )


register(
    ReportSpec(
        id="mobile-app-access",
        title="Mobile App Access",
        description="Who can and does sign in to the employee app: password state, last sign-in, devices, live tracking.",
        category="employees",
        icon="Smartphone",
        tags=("mobile app", "login", "password", "employee app"),
        modules=("mobile_app_login",),
        filters=(
            *scope(status="all", designation=True),
            select("access", "App access", _ACCESS, default="all"),
        ),
        columns=(
            *EMP_COLS,
            ColumnSpec("employmentType", "Type", BADGE, 0.9),
            ColumnSpec("phone", "Phone", TEXT, 1.2),
            ColumnSpec("status", "Status", BADGE, 0.9),
            ColumnSpec("appPassword", "App Password", BADGE, 0.9),
            ColumnSpec("passwordUpdatedAt", "Password Updated", DATETIME, 1.3),
            ColumnSpec("lastAppLogin", "Last App Sign-in", DATETIME, 1.3),
            ColumnSpec("devices", "Devices", INTEGER, 0.7, total="sum"),
            ColumnSpec("liveTracking", "Live Tracking", BADGE, 0.9),
            ColumnSpec("coEmp", "Co Emp", BADGE, 0.7),
        ),
        run=_run_mobile_access,
    )
)
