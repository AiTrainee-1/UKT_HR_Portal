"""/api/missed-payroll/... - the Missed Payroll page (permission key missed_payroll; HR -> Payroll -> Missed Payroll).

    GET  employees?kind=staff|production&month=&year=     who the regular payroll missed, by category, with their entry
    GET  entry?id=                                         one entry's figures (earnings, deductions, statement row, days)
    POST generate {kind, month, year, employeeIds}        work out and save (at most 20 a call)
    POST clear    {kind, month, year, employeeIds}        Generated -> Cleared        (approval payroll_mark_cleared)
    POST unclear  {kind, month, year, employeeIds}        Cleared -> Generated
    POST discard  {kind, month, year, employeeIds}        drop Generated entries
    POST done     {kind, month, year, employeeIds}        Cleared -> Done: into the month's payroll (whole company;
                                                           approval payroll_finalize)
    POST paid     {kind, month, year, employeeIds, paidOn} Done -> Paid (whole company; approval payroll_mark_paid);
                                                           staff get the "salary paid" notification once
    GET  bank-check?kind&month&year&ids                   who the bank file pays (Done, not paid) and who it leaves out
    GET  download/report?kind&month&year&ids              payroll report .xlsx
    GET  download/statement?kind&month&year&ids&fmt=pdf|xlsx
    GET  download/bank-file?kind&month&year&ids           the bank template .xlsx

View rights read and download; edit rights everything else (HrPermissionMiddleware: GET = view, POST = edit). Every
endpoint only sees the employees of the caller's branch scope.
"""

from __future__ import annotations

from datetime import date

from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .. import hr_access
from .. import payroll_month_workflow as month_workflow
from ..audit_utils import log_action
from ..auth import get_hr_display_name, require_hr
from ..branch_scope import scope_to_branch
from ..clock import ist_today
from ..models import Employee, MissedPayroll
from . import engine, exports, lists, service

MODULE = "missed_payroll"
AUDIT_MODULE = "payroll"
WHOLE_COMPANY_ONLY = (
    "Done and Paid change the month's payroll for the whole company: only a login for all units can do it."
)


class BadRequest(Exception):
    pass


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


def _handle(fn):
    def wrapper(request, *args, **kwargs):
        try:
            return fn(request, *args, **kwargs)
        except BadRequest as exc:
            return _error(str(exc))
        except service.Busy as exc:
            return _error(str(exc), 409)

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def _kind(data) -> str:
    kind = str(data.get("kind") or engine.KIND_STAFF).strip().lower()
    if kind not in (engine.KIND_STAFF, engine.KIND_PRODUCTION):
        raise BadRequest("kind must be staff or production.")
    return kind


def _month_year(data) -> tuple[int, int]:
    today = ist_today()
    try:
        month = int(data.get("month") or today.month)
        year = int(data.get("year") or today.year)
    except (TypeError, ValueError):
        raise BadRequest("Pick a month and a year.") from None
    if not (1 <= month <= 12) or not (2000 <= year <= 2100):
        raise BadRequest("Pick a month and a year.")
    return month, year


def _ids(raw) -> list[int]:
    if isinstance(raw, str):
        raw = [part for part in raw.split(",") if part.strip()]
    if not isinstance(raw, (list, tuple)) or not raw:
        raise BadRequest("Select at least one employee.")
    try:
        return list(dict.fromkeys(int(v) for v in raw))
    except (TypeError, ValueError):
        raise BadRequest("Select at least one employee.") from None


def _scope(request: Request, kind: str):
    return lists.employees_qs(scope_to_branch(Employee.objects, request).filter(lists.kind_filter(kind)))


def _employees(request: Request, kind: str, ids: list[int]) -> list[Employee]:
    found = {e.id: e for e in _scope(request, kind).filter(id__in=ids)}
    return [found[i] for i in ids if i in found]


def _entries(request: Request, kind: str, month: int, year: int, ids: list[int]) -> list[MissedPayroll]:
    emps = _employees(request, kind, ids)
    if not emps:
        raise BadRequest("None of these employees is in your list.")
    return list(
        MissedPayroll.objects.select_related("employee__department", "employee__designation", "employee__branch")
        .filter(kind=kind, month=month, year=year, employee_id__in=[e.id for e in emps])
        .order_by("employee__employee_code")
    )


def can_edit(request: Request) -> bool:
    from ..permission_registry import effective_permissions, resolve_permission

    hr = getattr(request, "hr_actor", None) or month_workflow._hr_user(request)
    if hr is None:
        return False
    if hr.is_super_admin:
        return True
    return resolve_permission(effective_permissions(hr), MODULE) == "edit"


def _file(content: bytes, filename: str, content_type: str) -> HttpResponse:
    response = HttpResponse(content, content_type=content_type)
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"
    return response


def _kind_label(kind: str) -> str:
    return "Staff" if kind == engine.KIND_STAFF else "Production"


@api_view(["GET"])
@require_hr
@_handle
def employees(request: Request) -> Response:
    kind = _kind(request.query_params)
    month, year = _month_year(request.query_params)
    emps = list(_scope(request, kind).order_by("employee_code"))
    rows = sorted(lists.classify(kind, emps, month, year).values(), key=lambda r: r["code"] or "")
    first, last = engine.month_bounds(month, year)
    departments = sorted({(r["departmentId"], r["department"]) for r in rows if r["departmentId"]}, key=lambda d: d[1])
    units = sorted({(r["branchId"], r["unit"]) for r in rows if r["branchId"]}, key=lambda u: u[1])
    close = month_workflow.month_close(month, year) if kind == engine.KIND_STAFF else None
    return Response(
        {
            "kind": kind,
            "month": month,
            "year": year,
            "periodLabel": engine.label(month, year),
            "monthStart": first.isoformat(),
            "monthEnd": last.isoformat(),
            "monthStarted": engine.month_started(month, year),
            "monthEnded": engine.month_ended(month, year),
            "mainGenerated": lists.main_generated(kind, month, year),
            # the Staff Payroll's own state of the month (Payroll Done / Paid): Done here still adds to it
            "mainFinalized": bool(close),
            "mainPaid": bool(close and close.paid_at),
            "canEdit": can_edit(request),
            "wholeCompany": month_workflow.is_whole_company(request),
            "summary": lists.summary(rows),
            "categories": [{"value": c, "label": lists.CATEGORY_LABELS[c]} for c in lists.CATEGORIES],
            "departments": [{"id": i, "name": n} for i, n in departments],
            "units": [{"id": i, "name": n} for i, n in units],
            "employees": rows,
        }
    )


@api_view(["GET"])
@require_hr
@_handle
def entry(request: Request) -> Response:
    try:
        pk = int(request.query_params.get("id"))
    except (TypeError, ValueError):
        raise BadRequest("Pick an entry.") from None
    found = (
        MissedPayroll.objects.select_related("employee__department", "employee__designation", "employee__branch")
        .filter(pk=pk, employee__in=scope_to_branch(Employee.objects.all(), request))
        .first()
    )
    if found is None:
        return _error("Not found", 404)
    return Response(exports.detail_json(found))


def _body(request: Request):
    data = request.data if isinstance(request.data, dict) else {}
    kind = _kind(data)
    month, year = _month_year(data)
    return data, kind, month, year


@api_view(["POST"])
@require_hr
@_handle
def generate(request: Request) -> Response:
    data, kind, month, year = _body(request)
    ids = _ids(data.get("employeeIds"))
    if len(ids) > service.MAX_PER_CALL:
        return _error(f"Generate at most {service.MAX_PER_CALL} employees at a time.")
    emps = _employees(request, kind, ids)
    if not emps:
        return _error("None of these employees is in your list.")
    out = service.generate(kind, emps, month, year, get_hr_display_name(request))
    if out["generated"]:
        log_action(
            request,
            "generate",
            AUDIT_MODULE,
            description=(
                f"Missed Payroll ({_kind_label(kind)}) {engine.label(month, year)}: worked out "
                f"{len(out['generated'])} employee(s)"
                + (f", {len(out['skipped'])} could not be worked out" if out["skipped"] else "")
            ),
            new_values={
                "kind": kind,
                "month": month,
                "year": year,
                "employeeIds": [g["employeeId"] for g in out["generated"]],
            },
        )
    return Response(out)


def _logged(request, kind, month, year, verb: str, done: list, refused: list) -> Response:
    if done:
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            description=f"Missed Payroll ({_kind_label(kind)}) {engine.label(month, year)}: {verb} {len(done)} employee(s)",
            new_values={"kind": kind, "month": month, "year": year, "done": done},
        )
    return Response({"done": done, "refused": refused})


@api_view(["POST"])
@require_hr
@_handle
def clear(request: Request) -> Response:
    data, kind, month, year = _body(request)
    if refused := hr_access.approval_refusal(request, "payroll_mark_cleared"):
        return refused
    entries = _entries(request, kind, month, year, _ids(data.get("employeeIds")))
    done, refused_rows = service.clear(entries, get_hr_display_name(request))
    return _logged(request, kind, month, year, "cleared", done, refused_rows)


@api_view(["POST"])
@require_hr
@_handle
def unclear(request: Request) -> Response:
    data, kind, month, year = _body(request)
    entries = _entries(request, kind, month, year, _ids(data.get("employeeIds")))
    done, refused_rows = service.unclear(entries, get_hr_display_name(request))
    return _logged(request, kind, month, year, "put back to generated", done, refused_rows)


@api_view(["POST"])
@require_hr
@_handle
def discard(request: Request) -> Response:
    data, kind, month, year = _body(request)
    entries = _entries(request, kind, month, year, _ids(data.get("employeeIds")))
    done, refused_rows = service.discard(entries)
    return _logged(request, kind, month, year, "removed the generated figures of", done, refused_rows)


@api_view(["POST"])
@require_hr
@_handle
def done(request: Request) -> Response:
    data, kind, month, year = _body(request)
    if not month_workflow.is_whole_company(request):
        return _error(WHOLE_COMPANY_ONLY, 403)
    if refused := hr_access.approval_refusal(request, "payroll_finalize"):
        return refused
    entries = _entries(request, kind, month, year, _ids(data.get("employeeIds")))
    rows, refused_rows = service.mark_done(entries, get_hr_display_name(request))
    if rows:
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            description=(
                f"Missed Payroll ({_kind_label(kind)}) {engine.label(month, year)}: Done - added {len(rows)} "
                f"employee(s) to the month's payroll ({', '.join(r['employeeCode'] for r in rows[:10])}"
                + (" ..." if len(rows) > 10 else "")
                + ")"
            ),
            new_values={"kind": kind, "month": month, "year": year, "done": rows},
        )
    return Response({"done": rows, "refused": refused_rows})


@api_view(["POST"])
@require_hr
@_handle
def paid(request: Request) -> Response:
    data, kind, month, year = _body(request)
    if not month_workflow.is_whole_company(request):
        return _error(WHOLE_COMPANY_ONLY, 403)
    if refused := hr_access.approval_refusal(request, "payroll_mark_paid"):
        return refused
    raw = data.get("paidOn")
    try:
        paid_on = date.fromisoformat(str(raw)[:10]) if raw else ist_today()
    except ValueError:
        return _error("paidOn must be a date like 2026-11-23.")
    if paid_on > ist_today():
        return _error("The day it was paid cannot be in the future.")
    entries = _entries(request, kind, month, year, _ids(data.get("employeeIds")))
    rows, refused_rows, notify = service.mark_paid(entries, paid_on, get_hr_display_name(request))
    if notify:
        service.notify_paid(notify)
    if rows:
        log_action(
            request,
            "update",
            AUDIT_MODULE,
            description=(
                f"Missed Payroll ({_kind_label(kind)}) {engine.label(month, year)}: marked {len(rows)} salary(ies) "
                f"paid on {paid_on:%d %b %Y}"
            ),
            new_values={"kind": kind, "month": month, "year": year, "paidOn": paid_on.isoformat(), "paid": rows},
        )
    return Response({"done": rows, "refused": refused_rows, "notified": len(notify)})


def _download_entries(request: Request):
    params = request.query_params
    kind = _kind(params)
    month, year = _month_year(params)
    entries = _entries(request, kind, month, year, _ids(params.get("ids")))
    if not entries:
        raise BadRequest("Nothing is generated for the selected employees yet.")
    return kind, month, year, entries


@api_view(["GET"])
@require_hr
@_handle
def bank_check(request: Request) -> Response:
    _kind_, _m, _y, entries = _download_entries(request)
    return Response(exports.bank_check(entries))


def _stem(kind: str, month: int, year: int) -> str:
    return f"Missed-Payroll-{_kind_label(kind)}-{engine.MONTHS[month]}-{year}"


@api_view(["GET"])
@require_hr
@_handle
def download_report(request: Request):
    kind, month, year, entries = _download_entries(request)
    content = exports.build_report_xlsx(entries, kind, month, year)
    return _file(
        content,
        f"{_stem(kind, month, year)}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@api_view(["GET"])
@require_hr
@_handle
def download_statement(request: Request):
    kind, month, year, entries = _download_entries(request)
    fmt = (request.query_params.get("fmt") or "pdf").lower()
    stem = f"{_stem(kind, month, year)}-Salary-Statement"
    if fmt == "xlsx":
        content = exports.build_statement_xlsx(entries, kind, month, year)
        return _file(content, f"{stem}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    return _file(exports.build_statement_pdf(entries, kind, month, year), f"{stem}.pdf", "application/pdf")


@api_view(["GET"])
@require_hr
@_handle
def download_bank_file(request: Request):
    kind, month, year, entries = _download_entries(request)
    check = exports.bank_check(entries)
    if not check["included"]:
        return _error(
            "Nobody to pay in this bank file: only employees marked Done (not yet paid) with bank details.", 409
        )
    content = exports.build_bank_xlsx(entries, f"{engine.MONTHS[month][:3]} {year} missed")
    return _file(
        content,
        f"{_stem(kind, month, year)}-Bank-File.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
