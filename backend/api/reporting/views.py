"""HTTP endpoints of the Report Center.

    GET /api/reports/catalog                 what the user can run (+ filter option lists)
    GET /api/reports/run/<id>?<filters>      rows, totals, summary cards (JSON)
    GET /api/reports/export/<id>?fmt=xlsx|pdf&<filters>    the same data as a file
    GET /api/reports/options/employees?q=..&ids=..            employee picker source

All of them sit under /api/reports/, which HrPermissionMiddleware already gates on the
"reports" module, and require an HR login. Branch isolation is applied inside
ReportContext.emp_q(), so it cannot be forgotten by an individual report.
"""

from __future__ import annotations

import logging
import re

from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.audit_utils import log_action
from api.auth import require_hr
from api.branch_scope import get_branch_scope, scope_to_branch
from api.clock import ist_now, ist_today

from .access import FORBIDDEN, HIDDEN, access_state, can_access
from .export_pdf import build_pdf
from .export_xlsx import build_xlsx
from .filters import ReportParamError, resolve_default
from .registry import all_specs, get_spec
from .runner import column_json, run_report
from .types import CATEGORIES, F_BRANCH, F_DATE_RANGE, F_EMPLOYEE, ReportSpec

logger = logging.getLogger(__name__)

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF_MIME = "application/pdf"


def _error(message: str, status: int, code: str = "invalid_request", field: str | None = None) -> Response:
    body = {"error": code, "message": message}
    if field:
        body["field"] = field
    return Response(body, status=status)


def _resolve(request, report_id: str) -> tuple[ReportSpec | None, Response | None]:
    """The spec, or the error response to return. Admin-only reports look non-existent (404);
    reports whose owning module the role lacks are 403 ``report_forbidden`` (distinct from the
    middleware's ``permission_denied``, which the UI reads as "view-only")."""
    spec = get_spec(report_id)
    state = access_state(request, spec) if spec else HIDDEN
    if spec is None or state == HIDDEN:
        return None, _error("Report not found", 404, "not_found")
    if state == FORBIDDEN:
        return None, _error("Your role does not have access to the data in this report.", 403, "report_forbidden")
    return spec, None


def _filter_json(f, today, branch_scoped: bool) -> dict | None:
    if f.kind == F_BRANCH and branch_scoped:
        return None  # a branch-scoped user only ever sees their own branch
    d = {
        "key": f.key,
        "kind": f.kind,
        "label": f.label,
        "required": f.required,
        "multi": f.multi,
        "default": resolve_default(f, today),
    }
    if f.options:
        d["options"] = [{"value": v, "label": l} for v, l in f.options]
    if f.help:
        d["help"] = f.help
    if f.placeholder:
        d["placeholder"] = f.placeholder
    if f.min is not None:
        d["min"] = f.min
    if f.max is not None:
        d["max"] = f.max
    if f.kind == F_DATE_RANGE and f.max_days:
        d["maxDays"] = f.max_days
    return d


def spec_json(spec: ReportSpec, today, branch_scoped: bool) -> dict:
    return {
        "id": spec.id,
        "title": spec.title,
        "description": spec.description,
        "category": spec.category,
        "icon": spec.icon,
        "tags": list(spec.tags),
        "family": spec.family,
        "variant": spec.variant,
        "landscape": spec.landscape,
        "filters": [j for f in spec.filters if (j := _filter_json(f, today, branch_scoped))],
        "columns": [column_json(c) for c in spec.columns],
        "dynamicColumns": not spec.columns,
        "exports": ["xlsx", "pdf"],
    }


@api_view(["GET"])
@require_hr
def reports_catalog(request):
    from api.models import Branch, Department, Designation

    branch_scoped = get_branch_scope(request) is not None
    today = ist_today()
    specs = [s for s in all_specs() if can_access(request, s)]
    counts: dict[str, int] = {}
    seen_families: set[tuple[str, str]] = set()
    for s in specs:
        key = (s.category, s.family or s.id)
        if key in seen_families:
            continue
        seen_families.add(key)
        counts[s.category] = counts.get(s.category, 0) + 1

    departments = scope_to_branch(Department.objects.all(), request).order_by("name").values("id", "name")
    branches = Branch.objects.all()
    if branch_scoped:
        branches = branches.filter(id=get_branch_scope(request))
    return Response({
        "generatedAt": ist_now().strftime("%Y-%m-%d %H:%M"),
        "branchScoped": branch_scoped,
        "categories": [
            {"id": cid, "label": label, "description": desc, "icon": icon, "count": counts.get(cid, 0)}
            for cid, label, desc, icon in CATEGORIES
            if counts.get(cid)
        ],
        "reports": [spec_json(s, today, branch_scoped) for s in specs],
        "options": {
            "departments": [{"id": d["id"], "name": d["name"]} for d in departments],
            "designations": [{"id": d["id"], "name": d["title"]} for d in Designation.objects.order_by("title").values("id", "title")],
            "branches": [{"id": b["id"], "name": b["name"]} for b in branches.order_by("name").values("id", "name")],
        },
    })


@api_view(["GET"])
@require_hr
def reports_run(request, report_id: str):
    spec, denied = _resolve(request, report_id)
    if denied is not None:
        return denied
    try:
        out = run_report(request, spec, request.query_params, purpose="screen")
    except ReportParamError as e:
        return _error(e.message, 400, "invalid_filter", e.field)
    except Exception:
        logger.exception("report %s failed", report_id)
        return _error("This report could not be generated. Please try again or contact support.", 500, "report_failed")
    return Response(out.payload())


_SLUG = re.compile(r"[^a-z0-9]+")


@api_view(["GET"])
@require_hr
def reports_export(request, report_id: str):
    spec, denied = _resolve(request, report_id)
    if denied is not None:
        return denied
    fmt = (request.query_params.get("fmt") or "xlsx").lower()
    if fmt not in ("xlsx", "pdf"):
        return _error("fmt must be xlsx or pdf", 400, "invalid_filter", "fmt")
    try:
        out = run_report(request, spec, request.query_params, purpose=fmt)
        if out.truncated:
            # Never hand over a silently cut-off register: totals and statutory figures must be complete.
            kind = "Excel" if fmt == "xlsx" else "PDF"
            body = {
                "error": "too_many_rows",
                "message": f"This report has more than {out.limit:,} rows, which is too many for a {kind} file. "
                "Narrow the filters (dates, department, employees) and try again.",
                "limit": out.limit,
            }
            return Response(body, status=413)
        if fmt == "xlsx":
            content = spec.xlsx_builder(out.ctx, out) if spec.xlsx_builder else build_xlsx(out)
            mime, ext = XLSX_MIME, "xlsx"
        else:
            content = spec.pdf_builder(out.ctx, out) if spec.pdf_builder else build_pdf(out)
            mime, ext = PDF_MIME, "pdf"
    except ReportParamError as e:
        return _error(e.message, 400, "invalid_filter", e.field)
    except Exception:
        logger.exception("report export %s (%s) failed", report_id, fmt)
        return _error("This report could not be exported. Please try again or contact support.", 500, "export_failed")

    filters = "; ".join(f"{k}: {v}" for k, v in out.filters) or "no filters"
    log_action(request, "export", "reports", description=f"{spec.title} - {fmt.upper()} - {out.row_count} rows - {filters}"[:480])

    slug = _SLUG.sub("_", spec.title.lower()).strip("_") or "report"
    stamp = ist_now().strftime("%Y%m%d_%H%M")
    resp = HttpResponse(content, content_type=mime)
    resp["Content-Disposition"] = f'attachment; filename="{slug}_{stamp}.{ext}"'
    resp["Cache-Control"] = "no-store"
    return resp


@api_view(["GET"])
@require_hr
def reports_options(request, source: str):
    """Server-side search for pickers too big to ship in the catalog. Employees only."""
    if source != "employees":
        return _error("Unknown option source", 404, "not_found")
    # The picker only makes sense for someone who can open a report that has an employee filter; do not
    # let a role with no report access at all use it to browse the staff list.
    if not any(f.kind == F_EMPLOYEE for s in all_specs() if can_access(request, s) for f in s.filters):
        return _error("Your role does not have access to any report that uses this filter.", 403, "report_forbidden")
    from django.db.models import Q

    from api.models import Employee

    qs = scope_to_branch(Employee.objects.select_related("department"), request)
    status = (request.query_params.get("status") or "").lower()
    if status == "active":
        qs = qs.filter(status="active")
    ids = [int(i) for i in (request.query_params.get("ids") or "").split(",") if i.strip().isdigit()][:200]
    if ids:
        qs = qs.filter(id__in=ids)
    else:
        q = (request.query_params.get("q") or "").strip()
        if q:
            for term in q.split()[:4]:
                qs = qs.filter(
                    Q(employee_code__icontains=term) | Q(first_name__icontains=term) | Q(last_name__icontains=term)
                )
        dept_ids = [int(i) for i in (request.query_params.get("departmentIds") or "").split(",") if i.strip().isdigit()]
        if dept_ids:
            qs = qs.filter(department_id__in=dept_ids)
    qs = qs.order_by("employee_code")[:200 if ids else 40]
    return Response([
        {
            "value": e.id,
            "label": f"{e.employee_code} · {e.first_name} {e.last_name}".strip(),
            "sub": e.department.name if e.department_id else "",
            "status": e.status,
        }
        for e in qs
    ])

