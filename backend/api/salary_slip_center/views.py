"""/api/salary-slip-center/... - the Salary Slip page (permission key salary_slip_center).

    GET  employees?month=&year=                      every employee of the caller's scope with the month's slip / hold
    GET  preview?month=&year=&employeeId=&statutory=&late=&advances=
                                                     the month worked out NOW, not saved
    GET  slip?month=&year=&employeeId=               the saved slip
    POST generate   {month, year, employeeIds, options}   work out and save (edit)
    POST hold       {month, year, employeeIds, hold, reason}  the page's own Hold / Release (edit)
    GET  bank-check?month=&year=&ids=                who the bank file pays and who it leaves out, with the reason
    GET  download/slips?month=&year=&ids=&layout=single|double       PDF
    GET  download/statement?month=&year=&ids=&fmt=pdf|xlsx            Salary Statement
    GET  download/bank-file?month=&year=&ids=                         bank template .xlsx

View rights see, preview and download; edit rights Generate and Hold (HrPermissionMiddleware: GET = view, POST = edit).
Every endpoint only ever sees the employees of the caller's branch scope. Downloads use the SAVED slips only.
"""

from __future__ import annotations

import calendar
from datetime import date

from django.http import HttpResponse
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..audit_utils import log_action
from ..auth import get_hr_display_name, require_hr
from ..branch_scope import scope_to_branch
from ..clock import ist_today
from ..models import Employee, HRUser
from . import bank_file, engine, service, statement
from .pdf import LAYOUTS, build_slips_pdf

MODULE = "salary_slip_center"
AUDIT_MODULE = "Salary Slip"


def _error(message: str, status: int = 400, **extra) -> Response:
    return Response({"error": message, **extra}, status=status)


class BadRequest(Exception):
    pass


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
    if not isinstance(raw, (list, tuple)):
        raise BadRequest("Select at least one employee.")
    out = []
    for value in raw:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            raise BadRequest("Select at least one employee.") from None
    if not out:
        raise BadRequest("Select at least one employee.")
    return list(dict.fromkeys(out))


def _scope(request: Request):
    return scope_to_branch(Employee.objects, request)


def _employees(request: Request, ids: list[int]) -> list[Employee]:
    """The given employees (in the order asked), only those of the caller's scope."""
    found = {e.id: e for e in service.employees_qs(_scope(request).filter(id__in=ids))}
    return [found[i] for i in ids if i in found]


def _actor(request: Request):
    user_id = (getattr(request, "jwt_user", None) or {}).get("hrUserId")
    return HRUser.objects.filter(pk=user_id).first() if user_id else None


def can_edit(request: Request) -> bool:
    from ..permission_registry import effective_permissions, resolve_permission

    hr = getattr(request, "hr_actor", None) or _actor(request)
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


def _handle(fn):
    def wrapper(request, *args, **kwargs):
        try:
            return fn(request, *args, **kwargs)
        except BadRequest as exc:
            return _error(str(exc))
        except engine.CannotCalculate as exc:
            return _error(str(exc))

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


@api_view(["GET"])
@require_hr
@_handle
def employees(request: Request) -> Response:
    month, year = _month_year(request.query_params)
    rows = list(service.employees_qs(_scope(request)))
    period_start = date(year, month, 1)
    period_end = date(year, month, calendar.monthrange(year, month)[1])
    return Response(
        {
            "month": month,
            "year": year,
            "periodLabel": f"{engine.MONTHS[month]} {year}",
            "monthStart": period_start.isoformat(),
            "monthEnd": period_end.isoformat(),
            "inProgress": period_start <= ist_today() < period_end,
            "canEdit": can_edit(request),
            "defaultOptions": dict(engine.DEFAULT_OPTIONS),
            "employees": service.page_rows(rows, month, year),
            **service.filter_options(rows),
        }
    )


def _one(request: Request, raw_id) -> Employee:
    try:
        emp_id = int(raw_id)
    except (TypeError, ValueError):
        raise BadRequest("Pick an employee.") from None
    found = _employees(request, [emp_id])
    if not found:
        raise BadRequest("That employee is not in your list.")
    return found[0]


@api_view(["GET"])
@require_hr
@_handle
def preview(request: Request) -> Response:
    month, year = _month_year(request.query_params)
    emp = _one(request, request.query_params.get("employeeId"))
    result = engine.calculate(emp, month, year, engine.options_from_query(request.query_params))
    return Response({"result": result})


@api_view(["GET"])
@require_hr
@_handle
def saved_slip(request: Request) -> Response:
    month, year = _month_year(request.query_params)
    emp = _one(request, request.query_params.get("employeeId"))
    slip = service.saved_slips([emp.id], month, year).get(emp.id)
    if slip is None:
        return _error(
            f"No salary slip generated for {engine.full_name(emp)} for {engine.MONTHS[month]} {year} yet.", 404
        )
    return Response({"result": slip.figures, "slip": service.slip_summary(slip)})


@api_view(["POST"])
@require_hr
@_handle
def generate(request: Request) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    month, year = _month_year(data)
    ids = _ids(data.get("employeeIds"))
    if len(ids) > service.MAX_PER_CALL:
        return _error(f"Generate at most {service.MAX_PER_CALL} employees at a time.")
    emps = _employees(request, ids)
    if not emps:
        return _error("None of these employees is in your list.")
    try:
        engine.period_for(month, year)
    except engine.CannotCalculate as exc:
        return _error(str(exc))
    options = engine.clean_options(data.get("options"))
    out = service.generate(emps, month, year, options, _actor(request), get_hr_display_name(request))
    if out["generated"]:
        log_action(
            request,
            "generate",
            AUDIT_MODULE,
            description=(
                f"Generated {len(out['generated'])} standalone salary slip(s) for {engine.MONTHS[month]} {year}"
                + (f" ({len(out['skipped'])} could not be worked out)" if out["skipped"] else "")
            ),
            new_values={
                "month": month,
                "year": year,
                "employeeIds": [g["employeeId"] for g in out["generated"]],
                "options": options,
            },
        )
    return Response(out)


@api_view(["POST"])
@require_hr
@_handle
def hold(request: Request) -> Response:
    data = request.data if isinstance(request.data, dict) else {}
    month, year = _month_year(data)
    emps = _employees(request, _ids(data.get("employeeIds")))
    if not emps:
        return _error("None of these employees is in your list.")
    on = data.get("hold")
    if not isinstance(on, bool):
        return _error("Say whether to hold or release.")
    reason = str(data.get("reason") or "").strip()[: service.REASON_MAX]
    rows = service.set_hold(emps, month, year, on, reason, _actor(request), get_hr_display_name(request))
    log_action(
        request,
        "hold" if on else "release",
        AUDIT_MODULE,
        description=(
            f"{'Held' if on else 'Released'} {len(rows)} salary slip(s) for {engine.MONTHS[month]} {year}"
            + (f": {reason}" if on and reason else "")
        ),
        new_values={"month": month, "year": year, "employeeIds": [e.id for e in emps], "hold": on},
    )
    return Response({"updated": len(rows), "employees": rows})


def _saved_or_missing(request: Request):
    month, year = _month_year(request.query_params)
    emps = _employees(request, _ids(request.query_params.get("ids")))
    if not emps:
        raise BadRequest("None of these employees is in your list.")
    slips = service.saved_slips([e.id for e in emps], month, year)
    return month, year, emps, slips


def _missing_response(emps, slips) -> Response | None:
    missing = [e.id for e in emps if e.id not in slips]
    if missing:
        return _error(
            f"{len(missing)} of the selected employees have no slip generated for this month yet. Generate them first.",
            409,
            missing=missing,
        )
    return None


@api_view(["GET"])
@require_hr
@_handle
def bank_check(request: Request) -> Response:
    month, year, emps, slips = _saved_or_missing(request)
    held = service.held_ids([e.id for e in emps], month, year)
    return Response(bank_file.check(emps, slips, held))


@api_view(["GET"])
@require_hr
@_handle
def download_slips(request: Request):
    month, year, emps, slips = _saved_or_missing(request)
    missing = _missing_response(emps, slips)
    if missing:
        return missing
    layout = request.query_params.get("layout") or "single"
    if layout not in LAYOUTS:
        layout = "single"
    ordered = [slips[e.id] for e in emps]
    content = build_slips_pdf(ordered, layout)
    name = engine.MONTHS[month]
    filename = (
        f"Salary-Slip-{emps[0].employee_code}-{name}-{year}.pdf"
        if len(emps) == 1
        else f"Salary-Slips-{name}-{year}.pdf"
    )
    return _file(content, filename, "application/pdf")


@api_view(["GET"])
@require_hr
@_handle
def download_statement(request: Request):
    month, year, emps, slips = _saved_or_missing(request)
    missing = _missing_response(emps, slips)
    if missing:
        return missing
    held = service.held_ids([e.id for e in emps], month, year)
    ordered = [slips[e.id] for e in emps]
    fmt = (request.query_params.get("fmt") or "pdf").lower()
    name = f"Salary-Statement-{engine.MONTHS[month]}-{year}"
    if fmt == "xlsx":
        return _file(
            statement.build_xlsx(ordered, held, month, year),
            f"{name}.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    return _file(statement.build_pdf(ordered, held, month, year), f"{name}.pdf", "application/pdf")


@api_view(["GET"])
@require_hr
@_handle
def download_bank_file(request: Request):
    month, year, emps, slips = _saved_or_missing(request)
    held = service.held_ids([e.id for e in emps], month, year)
    checked = bank_file.check(emps, slips, held)
    if not checked["included"]:
        return _error("Nobody in this selection can be paid through the bank file.", 400, leftOut=checked["leftOut"])
    content = bank_file.build_xlsx(emps, slips, held, f"{engine.MONTHS[month]} {year}")
    log_action(
        request,
        "export",
        AUDIT_MODULE,
        description=(
            f"Downloaded the bank file for {engine.MONTHS[month]} {year}: {len(checked['included'])} employee(s), "
            f"total {checked['total']:,.2f}"
        ),
        new_values={"month": month, "year": year, "employeeIds": [r["employeeId"] for r in checked["included"]]},
    )
    return _file(
        content,
        f"Bank-File-{engine.MONTHS[month]}-{year}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
