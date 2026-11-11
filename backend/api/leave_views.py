from datetime import date as date_type

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval, hr_access, whatsapp_approvals
from .auth import require_hr, require_auth, get_token_employee_id, is_hr, get_hr_display_name
from .branch_scope import scope_to_branch
from .models import LeaveType, LeaveBalance, Holiday, Employee, Notification, EmployeePermission
from .request_window import enforce_employee_date
from .view_common import paginate


def leave_type_json(lt):
    return {
        "id": lt.id,
        "name": lt.name,
        "code": lt.code,
        "maxDaysPerYear": lt.max_days_per_year,
        "carryForward": lt.carry_forward,
        "maxCarryForwardDays": lt.max_carry_forward_days,
        "isPaid": lt.is_paid,
        "applicableGender": lt.applicable_gender,
        "isActive": lt.is_active,
    }


def leave_balance_json(lb):
    return {
        "id": lb.id,
        "employeeId": lb.employee_id,
        "leaveTypeId": lb.leave_type_id,
        "leaveTypeName": lb.leave_type.name if lb.leave_type else None,
        "leaveTypeCode": lb.leave_type.code if lb.leave_type else None,
        "year": lb.year,
        "allocated": float(lb.allocated),
        "used": float(lb.used),
        "remaining": float(lb.remaining),
        "carriedForward": float(lb.carried_forward),
    }


def holiday_json(h):
    return {
        "id": h.id,
        "name": h.name,
        "date": h.date.isoformat() if h.date else None,
        "holidayType": h.holiday_type,
        "branchId": h.branch_id,
        "branchName": h.branch.name if h.branch else None,
        "departmentId": h.department_id,
        "departmentName": h.department.name if h.department else None,
        "isRecurring": h.is_recurring,
        "description": h.description,
    }


# ── Leave Types ──────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def leave_types(request: Request) -> Response:
    if request.method == "GET":
        qs = LeaveType.objects.filter(is_active=True).order_by("name")
        return Response([leave_type_json(lt) for lt in qs])
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    data = request.data
    if not data.get("name") or not data.get("code"):
        return Response({"error": "name and code are required"}, status=400)
    if LeaveType.objects.filter(code=data["code"]).exists():
        return Response({"error": "Leave type code already exists"}, status=400)

    lt = LeaveType.objects.create(
        name=data["name"],
        code=data["code"].upper(),
        max_days_per_year=int(data.get("maxDaysPerYear", 12)),
        carry_forward=bool(data.get("carryForward", False)),
        max_carry_forward_days=int(data.get("maxCarryForwardDays", 0)),
        is_paid=bool(data.get("isPaid", True)),
        applicable_gender=data.get("applicableGender", "all"),
    )
    return Response(leave_type_json(lt), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def leave_type_detail(request: Request, pk: int) -> Response:
    try:
        lt = LeaveType.objects.get(pk=pk)
    except LeaveType.DoesNotExist:
        return Response({"error": "Leave type not found"}, status=404)

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("maxDaysPerYear", "max_days_per_year"),
            ("carryForward", "carry_forward"), ("maxCarryForwardDays", "max_carry_forward_days"),
            ("isPaid", "is_paid"), ("applicableGender", "applicable_gender"),
            ("isActive", "is_active"),
        ]:
            if field in data:
                setattr(lt, attr, data[field])
        lt.save()
        return Response(leave_type_json(lt))

    lt.is_active = False
    lt.save()
    return Response(status=204)


# ── Leave Balances ───────────────────────────────────────────────────────────

@api_view(["GET"])
@require_auth
def leave_balances(request: Request) -> Response:
    emp_id = request.query_params.get("employeeId")
    year = request.query_params.get("year")
    # Employees can only see their own balance
    token_emp_id = get_token_employee_id(request)
    if token_emp_id:
        emp_id = token_emp_id
    qs = LeaveBalance.objects.select_related("leave_type").order_by("employee_id", "leave_type__name")
    if emp_id:
        qs = qs.filter(employee_id=emp_id)
    if year:
        qs = qs.filter(year=year)
    return Response([leave_balance_json(lb) for lb in qs])


@api_view(["POST"])
@require_hr
def allocate_leave(request: Request) -> Response:
    data = request.data
    emp_id = data.get("employeeId")
    lt_id = data.get("leaveTypeId")
    year = data.get("year")
    allocated = data.get("allocated")

    if not all([emp_id, lt_id, year, allocated is not None]):
        return Response({"error": "employeeId, leaveTypeId, year, allocated are required"}, status=400)

    lb, _ = LeaveBalance.objects.get_or_create(
        employee_id=emp_id, leave_type_id=lt_id, year=year,
        defaults={"allocated": allocated, "remaining": allocated},
    )
    if not _:
        lb.allocated = allocated
        lb.remaining = float(allocated) - float(lb.used)
        lb.save()
    return Response(leave_balance_json(lb), status=201)


# ── Holidays ─────────────────────────────────────────────────────────────────

@api_view(["GET", "POST"])
@require_auth
def holidays(request: Request) -> Response:
    if request.method == "GET":
        year = request.query_params.get("year")
        branch_id = request.query_params.get("branchId")
        qs = Holiday.objects.select_related("branch", "department").order_by("date")
        if year:
            qs = qs.filter(date__year=year)
        if branch_id:
            qs = qs.filter(branch_id=branch_id)
        return Response([holiday_json(h) for h in qs])
    if not is_hr(request):
        return Response({"error": "HR access required"}, status=403)

    data = request.data
    if not data.get("name") or not data.get("date"):
        return Response({"error": "name and date are required"}, status=400)

    try:
        parsed_date = date_type.fromisoformat(data["date"])
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    h = Holiday.objects.create(
        name=data["name"],
        date=parsed_date,
        holiday_type=data.get("holidayType", "national"),
        branch_id=data.get("branchId"),
        department_id=data.get("departmentId"),
        is_recurring=bool(data.get("isRecurring", False)),
        description=data.get("description"),
    )
    from .attendance_final import _holiday_dates_for_month
    _holiday_dates_for_month.cache_clear()
    return Response(holiday_json(h), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def holiday_detail(request: Request, pk: int) -> Response:
    try:
        h = Holiday.objects.select_related("branch", "department").get(pk=pk)
    except Holiday.DoesNotExist:
        return Response({"error": "Holiday not found"}, status=404)

    from .attendance_final import _holiday_dates_for_month

    if request.method == "PUT":
        data = request.data
        for field, attr in [
            ("name", "name"), ("date", "date"), ("holidayType", "holiday_type"),
            ("branchId", "branch_id"), ("departmentId", "department_id"),
            ("isRecurring", "is_recurring"), ("description", "description"),
        ]:
            if field in data:
                setattr(h, attr, data[field])
        h.save()
        _holiday_dates_for_month.cache_clear()
        # the date (and branch / department) were set from request text: read the row back so the reply is built from real values
        h = Holiday.objects.select_related("branch", "department").get(pk=h.pk)
        return Response(holiday_json(h))

    h.delete()
    _holiday_dates_for_month.cache_clear()
    return Response(status=204)


# ── Approved Requests (Employee Mobile Requests) ─────────────────────────────

def _req_json(r):
    emp = r.employee
    return {
        "id": r.id,
        "employeeId": emp.id,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "employeeCode": emp.employee_code,
        "requestType": r.request_type,
        "subject": r.subject,
        "description": r.description,
        "status": r.status,
        "hrNotes": r.hr_notes,
        "handledBy": r.handled_by,
        "handledAt": r.handled_at.isoformat() if r.handled_at else None,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }


@api_view(["GET", "POST"])
def employee_requests(request: Request) -> Response:
    from .models import EmployeeRequest
    from .auth import require_auth

    if request.method == "POST":
        return require_auth(_employee_request_create)(request)

    @require_hr
    def _get(req):
        req_type = req.query_params.get("requestType")
        req_status = req.query_params.get("status")
        qs = EmployeeRequest.objects.select_related("employee").order_by("-created_at")
        if req_type:
            qs = qs.filter(request_type=req_type)
        if req_status:
            qs = qs.filter(status=req_status)
        return paginate(req, qs, _req_json)

    return _get(request)


def _employee_request_create(request: Request) -> Response:
    from .models import EmployeeRequest
    data = request.data
    emp_id = data.get("employeeId")
    token_emp_id = get_token_employee_id(request)
    if token_emp_id is not None:
        if emp_id and str(emp_id) != str(token_emp_id):
            return Response({"error": "You can only submit requests for yourself"}, status=403)
        emp_id = token_emp_id
    if not emp_id:
        return Response({"error": "employeeId is required"}, status=400)
    if not data.get("subject") or not data.get("requestType"):
        return Response({"error": "subject and requestType are required"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    try:
        approval.require_enabled("request")  # HR can switch general requests off in Approval Workflow Control
    except approval.ApprovalError as exc:
        return approval.refusal(exc)

    er = EmployeeRequest.objects.create(
        employee=emp,
        request_type=data["requestType"],
        subject=data["subject"],
        description=data.get("description", ""),
    )

    label = dict(EmployeeRequest.REQUEST_TYPES).get(data["requestType"], data["requestType"])
    Notification.objects.create(
        employee=emp,
        type="employee_request",
        message=f"New {label} submitted by {emp.first_name} {emp.last_name}: '{data['subject']}'",
    )

    return Response(_req_json(er), status=201)


@api_view(["PUT"])
@require_hr
def employee_request_action(request: Request, pk: int) -> Response:
    from .models import EmployeeRequest
    from datetime import datetime
    try:
        er = EmployeeRequest.objects.select_related("employee").get(pk=pk)
    except EmployeeRequest.DoesNotExist:
        return Response({"error": "Request not found"}, status=404)

    data = request.data
    prev_status = er.status
    if data.get("status") in ("approved", "rejected") and data.get("status") != prev_status:
        # approving / rejecting a general request is the approval right, not the edit right (hr_access.py)
        if refused := hr_access.approval_refusal(request, "request"):
            return refused
        if hr_access.out_of_branch(request, er.employee.branch_id if er.employee_id else None):
            return Response({"error": "Request not found"}, status=404)
    elif refused := hr_access.decision_only_refusal(request):
        return refused
    if "status" in data:
        er.status = data["status"]
    if "hrNotes" in data:
        er.hr_notes = data["hrNotes"]
    if "handledBy" in data:
        er.handled_by = data["handledBy"]
    er.handled_at = datetime.utcnow()
    er.save()
    if er.status != prev_status:
        if er.status not in ("approved", "rejected"):
            # a final decision is announced by notify_decision below with the full WhatsApp wording
            Notification.objects.create(
                employee=er.employee,
                type="employee_request",
                message=f"Your request '{er.subject}' is now {er.status.replace('_', ' ')}.",
            )
        if er.status in ("approved", "rejected"):
            hr_access.log_decision(request, "request", er, er.status, f"request '{er.subject}'")
            whatsapp_approvals.notify_decision(
                "request", er, er.status, approver=er.handled_by or request.jwt_user.get("name", ""), role="hr",
                comment=er.hr_notes,
            )
    return Response({"id": er.id, "status": er.status})


# ── Employee Permissions ──────────────────────────────────────────────────────
#
# Exactly 3 canonical types (EmployeePermission.TYPE_CHOICES): Morning Late-
# In / Evening Early-Out (each, when approved and still within
# PayrollSettings.permission_monthly_cap that calendar month, shifts that
# day's effective Late Detection boundary -see attendance_final.py) and
# Middle One-Hour (never shifts anything, purely an excused mid-shift gap).
# Every permission is a fixed 60 minutes now (EmployeePermission.
# FIXED_DURATION_MINUTES) -the request no longer chooses a duration.
#
# There is still no hard cap on SUBMITTING a request -HR can approve a 4th
# (or later) one that month; it just stops being protective (see
# capStatus/statusLabel below). monthlyLimit is the real, HR-editable
# permission_monthly_cap now, not a hardcoded display number.


def _month_bounds(year: int, month: int) -> tuple[date_type, date_type]:
    """[first day of the month, first day of the next month)."""
    return date_type(year, month, 1), date_type(year + month // 12, month % 12 + 1, 1)


class _CapStatusCache:
    """within_cap / excess for many permissions without a COUNT per row (an HR list can hold
    thousands). Same ordering rule as attendance_final.permission_cap_status: earliest (date, id)
    first, among the employee's approved permissions of that calendar month.

    `prime(rows)` loads every employee-month a page of rows needs in ONE query. A month asked for
    without it is loaded for every employee at once - one query per month, not one per employee-
    month - so a caller that never primes still batches."""

    def __init__(self, cap):
        self.cap = max(0, int(cap or 0))
        self._months = {}  # (employee_id, year, month) -> {permission id: position in that month}
        self._whole_months = set()  # (year, month) already loaded for every employee

    def _store(self, rows):
        """rows: (employee_id, date, id) ordered by (date, id). Every employee-month they cover must be complete."""
        loaded = {}
        for emp_id, day, pid in rows:
            loaded.setdefault((emp_id, day.year, day.month), []).append(pid)
        for key, ids in loaded.items():
            self._months.setdefault(key, {pid: i for i, pid in enumerate(ids)})

    def prime(self, rows):
        wanted = {
            (p.employee_id, p.date.year, p.date.month)
            for p in rows
            if p.status == "approved" and p.date is not None
        }
        wanted = {k for k in wanted if k not in self._months and (k[1], k[2]) not in self._whole_months}
        if not wanted:
            return
        lo = _month_bounds(*min((y, m) for _e, y, m in wanted))[0]
        hi = _month_bounds(*max((y, m) for _e, y, m in wanted))[1]
        # Every month of [lo, hi) is complete for these employees, so all of it can be kept.
        self._store(
            EmployeePermission.objects.filter(
                status="approved", employee_id__in={k[0] for k in wanted}, date__gte=lo, date__lt=hi
            ).order_by("date", "id").values_list("employee_id", "date", "id")
        )
        for key in wanted:
            self._months.setdefault(key, {})

    def status(self, p):
        if p.status != "approved":
            return "not_applicable"
        key = (p.employee_id, p.date.year, p.date.month)
        position = self._months.get(key)
        if position is None:
            month = (p.date.year, p.date.month)
            if month not in self._whole_months:
                self._whole_months.add(month)
                lo, hi = _month_bounds(*month)
                self._store(
                    EmployeePermission.objects.filter(status="approved", date__gte=lo, date__lt=hi)
                    .order_by("date", "id")
                    .values_list("employee_id", "date", "id")
                )
            position = self._months.setdefault(key, {})
        return "within_cap" if position.get(p.id, len(position)) < self.cap else "excess"


PERMISSION_WORKFLOW = "permission"


def resolve_permission(p, role: str, decision: str, actor: str, comment: str | None) -> approval.Outcome:
    """One decision by `role` ('hod' or 'hr') on a permission request, under the "permission" pipeline
    (approval_workflow.py). Raises approval.ApprovalError when that role may not decide it now.

    An intermediate approval only passes the request on (status stays pending); a final approval or a rejection is
    what attendance reads (an approved, in-cap permission protects the day). Any type or comment change the caller made
    on `p` in memory is saved with the decision."""
    outcome = approval.decide(PERMISSION_WORKFLOW, p, role, decision, actor=actor, comment=comment)
    if comment is not None:
        p.hr_comment = comment
    if outcome.final or outcome.rejected:
        p.approved_by = actor  # always server-derived, never client-supplied
        p.approver_role = approval.LEGACY_ROLE[role]
    p.status = outcome.status
    p.save()
    what = f"permission request for {p.date.isoformat()}"
    approval.stage_notice(p.employee, "permission", approval.notice_for(what, outcome), outcome)
    if outcome.kind == "advanced" and approval.HOD in outcome.waiting and role != approval.HOD:
        approval.notify_hod_of_request(PERMISSION_WORKFLOW, p.employee, "permission request")
    if outcome.final or outcome.rejected:
        whatsapp_approvals.notify_decision(
            PERMISSION_WORKFLOW, p, decision, approver=actor, role=approval.LEGACY_ROLE[role], comment=p.hr_comment
        )
    return outcome


def _permission_json(p, monthly_used=None, settings=None, cap_cache=None, cfg=None):
    if settings is None:
        from .models import PayrollSettings
        settings = PayrollSettings.get()
    from .attendance_final import permission_cap_status
    emp = p.employee
    cap_status = (
        cap_cache.status(p) if cap_cache is not None
        else permission_cap_status(p, settings.permission_monthly_cap)
    )
    # Outcome shown to staff and HR, in the words the policy uses:
    #   Allowed          -approved and within the monthly cap (it protects that day)
    #   Not Allowed      -HR rejected it
    #   Overdue / Excess -approved, but beyond the cap (it does NOT protect the day)
    status_label = {
        "pending": "Pending",
        "rejected": "Not Allowed",
    }.get(p.status) or ("Allowed" if cap_status == "within_cap" else "Overdue / Excess")
    type_key = p.type_key
    return {
        "id": p.id,
        "employeeId": emp.id,
        "employeeName": f"{emp.first_name} {emp.last_name}",
        "employeeCode": emp.employee_code,
        "department": emp.department.name if emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        # for the HR page's branch / department / employee-type filters (added fields: older readers ignore them)
        "departmentId": emp.department_id,
        "branchId": emp.branch_id,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "employmentType": emp.employment_type,
        "date": p.date.isoformat() if p.date else None,
        "permissionTime": p.permission_time.strftime("%H:%M") if p.permission_time else None,
        "reason": p.reason,
        # `type` keeps answering in the spelling the installed mobile app / deployed web app were
        # built against ("Late In" / "Early Out" / "Short Leave") -new clients use typeKey/typeLabel.
        "type": EmployeePermission.LEGACY_TYPE_LABELS.get(type_key, p.type) if type_key else p.type,
        "typeKey": type_key,
        "typeLabel": EmployeePermission.TYPE_LABELS.get(type_key) if type_key else None,
        "durationMinutes": p.duration_minutes,
        "status": p.status,
        "capStatus": cap_status,
        "statusLabel": status_label,
        "hrComment": p.hr_comment,
        "approvedBy": p.approved_by,
        "approverRole": p.approver_role,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "monthlyUsed": monthly_used,
        "monthlyLimit": settings.permission_monthly_cap,
        # DEPRECATED: the old per-day / per-week caps no longer exist (one monthly cap replaced
        # them). Older clients still print "Max N/day - M/week" from these, so keep answering with
        # the monthly cap -the loosest true upper bound- rather than a stale 1 / 2.
        "dailyLimit": settings.permission_monthly_cap,
        "weeklyLimit": settings.permission_monthly_cap,
        # The approval pipeline: who it waits for now and how far it has got (approval_workflow.py)
        "approval": approval.progress(PERMISSION_WORKFLOW, p, cfg),
    }


@api_view(["GET", "POST"])
@require_auth
def employee_permissions(request: Request) -> Response:
    if request.method == "GET":
        # Never the employee's photo (a base64 data URL, up to ~2 MB each): no row shows it, and the sidebar polls this.
        qs = EmployeePermission.objects.select_related(
            "employee__department", "employee__designation", "employee__branch"
        ).defer("employee__photo_url").order_by("-date", "-created_at")
        qs = scope_to_branch(qs, request, field="employee__branch_id")
        # Resolve employee by code or ID; employees can only see their own
        token_emp_id = get_token_employee_id(request)
        if token_emp_id:
            emp_id = token_emp_id
        elif code := request.query_params.get("employeeCode") or request.query_params.get("employee_code"):
            from .models import Employee as _Emp
            found = _Emp.objects.filter(employee_code=code).first()
            emp_id = found.id if found else None
        else:
            emp_id = request.query_params.get("employeeId") or request.query_params.get("employee_id")
        if emp_id:
            qs = qs.filter(employee_id=emp_id)
        if status := request.query_params.get("status"):
            qs = qs.filter(status=status)
        if month := request.query_params.get("month"):
            qs = qs.filter(date__month=month)
        if year := request.query_params.get("year"):
            qs = qs.filter(date__year=year)
        from .models import PayrollSettings
        settings = PayrollSettings.get()
        cap_cache = _CapStatusCache(settings.permission_monthly_cap)
        cfg = approval.get_config(PERMISSION_WORKFLOW)
        return paginate(
            request,
            qs,
            lambda p: _permission_json(p, settings=settings, cap_cache=cap_cache, cfg=cfg),
            prepare=cap_cache.prime,  # the monthly-cap positions of the whole page in one query
        )

    data = request.data
    # Accept employeeCode, camelCase, or snake_case
    emp_id    = None
    if code := data.get("employeeCode") or data.get("employee_code"):
        found = Employee.objects.filter(employee_code=code).first()
        emp_id = found.id if found else None
    if not emp_id:
        emp_id = data.get("employeeId") or data.get("employee_id")
    perm_date = data.get("date") or data.get("permission_date")
    # Employees can only submit permissions for themselves
    token_emp_id = get_token_employee_id(request)
    if token_emp_id and str(token_emp_id) != str(emp_id):
        return Response({"error": "You can only submit permissions for yourself"}, status=403)
    if not emp_id or not perm_date:
        return Response({"error": "employeeId and date are required"}, status=400)

    try:
        parsed_date = date_type.fromisoformat(perm_date)
    except (ValueError, TypeError):
        return Response({"error": "Invalid date format"}, status=400)

    try:
        emp = Employee.objects.get(pk=emp_id)
    except Employee.DoesNotExist:
        return Response({"error": "Employee not found"}, status=404)

    perm_time = data.get("permissionTime") or data.get("permission_time") or None
    if perm_time:
        from datetime import time as time_type
        try:
            h, m = perm_time.split(":")
            perm_time = time_type(int(h), int(m))
        except Exception:
            return Response({"error": "Invalid permissionTime format (HH:MM)"}, status=400)

    # Accept the canonical slug, its label, or the pre-rewrite spelling the installed mobile app
    # still sends ("Late In" / "Early Out" / "Short Leave"). A value that names no type is rejected
    # -but a request that names NONE (the deployed web app never sent one) is still accepted, with
    # the type inferred from the requested time against that day's shift so the permission can do
    # its job. If even that is not possible the request is saved untyped; HR can classify it in the
    # approval step (PUT below).
    raw_type = data.get("type")
    perm_type = EmployeePermission.normalize_type(raw_type)
    if raw_type not in (None, "") and perm_type is None:
        return Response({
            "error": "type must be one of: " + ", ".join(EmployeePermission.TYPE_LABELS.values()),
        }, status=400)
    if perm_type is None:
        from .attendance_final import infer_permission_type
        from .shift_engine import _get_shift_for_date
        perm_type = infer_permission_type(perm_time, _get_shift_for_date(emp, parsed_date))

    # The same kind of permission twice for the same day would burn two of the month's allowed
    # permissions for one absence -reject the duplicate instead of silently double-counting it.
    if perm_type and EmployeePermission.objects.filter(
        employee=emp, date=parsed_date, status__in=["pending", "approved"],
        type__in=EmployeePermission.type_values(perm_type),
    ).exists():
        return Response({
            "error": f"A {EmployeePermission.TYPE_LABELS[perm_type]} request already exists for {parsed_date.isoformat()}",
        }, status=409)

    try:
        approval.require_enabled(PERMISSION_WORKFLOW)
    except approval.ApprovalError as exc:
        return approval.refusal(exc)
    # An employee may only request a date in the current month (plus last month on its 1st to 5th); HR is never limited.
    if refused := enforce_employee_date(request, parsed_date.isoformat()):
        return refused
    # HR recording a permission that is already decided is a decision too: it needs the approval right.
    if is_hr(request) and data.get("status") in ("approved", "rejected"):
        if refused := hr_access.approval_refusal(request, PERMISSION_WORKFLOW):
            return refused
    p = EmployeePermission.objects.create(
        employee=emp,
        date=parsed_date,
        permission_time=perm_time,
        approval_trail=[],
        reason=data.get("reason"),
        type=perm_type,
        # Every permission is a fixed 60 minutes now -a client-supplied
        # durationMinutes (if any, e.g. from an un-updated old client) is
        # ignored, never trusted.
        duration_minutes=EmployeePermission.FIXED_DURATION_MINUTES,
        # Only HR may create a permission that is already decided.
        status=data.get("status", "pending") if is_hr(request) else "pending",
    )

    if p.status == "pending":
        approval.notify_new_request(PERMISSION_WORKFLOW, emp, "permission request")

    month_used_after = EmployeePermission.objects.filter(
        employee=emp,
        date__year=parsed_date.year,
        date__month=parsed_date.month,
        status__in=["pending", "approved"],
    ).count()

    return Response(_permission_json(p, monthly_used=month_used_after), status=201)


@api_view(["PUT", "DELETE"])
@require_hr
def employee_permission_detail(request: Request, pk: int) -> Response:
    try:
        p = EmployeePermission.objects.select_related("employee").get(pk=pk)
    except EmployeePermission.DoesNotExist:
        return Response({"error": "Permission not found"}, status=404)

    if request.method == "DELETE":
        p.delete()
        return Response(status=204)

    data = request.data
    prev_status = p.status
    new_status = data.get("status", prev_status)
    if new_status not in ("pending", "approved", "rejected"):
        return Response({"error": "status must be 'pending', 'approved' or 'rejected'"}, status=400)
    hr_name = get_hr_display_name(request)  # always server-derived: a client-supplied name could be spoofed
    comment = data["hrComment"] if "hrComment" in data else None
    deciding = approval.is_pending(PERMISSION_WORKFLOW, p) and new_status in ("approved", "rejected")
    if deciding or new_status != prev_status:
        # a decision, or a revision of one: the approval right, not the edit right (hr_access.py)
        if refused := hr_access.approval_refusal(request, PERMISSION_WORKFLOW):
            return refused
        if hr_access.out_of_branch(request, p.employee.branch_id):
            return Response({"error": "Permission not found"}, status=404)
    elif refused := hr_access.decision_only_refusal(request):
        return refused  # a type / comment edit by an account that may only decide
    if new_status != prev_status and not deciding and not approval.role_takes_part(PERMISSION_WORKFLOW, approval.HR):
        return Response(
            {"error": "HR is not part of the approval pipeline for Permission, so it cannot change this decision."},
            status=403,
        )
    # HR can classify a request that arrived untyped (older web-app submissions) or correct a
    # mis-picked type -it decides whether an approved permission shifts a boundary at all.
    if "type" in data:
        new_type = EmployeePermission.normalize_type(data["type"])
        if data["type"] not in (None, "") and new_type is None:
            return Response({
                "error": "type must be one of: " + ", ".join(EmployeePermission.TYPE_LABELS.values()),
            }, status=400)
        p.type = new_type
    # Approving (or re-approving, or retyping) must not leave two live requests of the same kind on
    # one day: each burns one of the month's allowed permissions and, if one is in-cap and the other
    # excess, the day would be charged twice. Only checked when this request changes status or type,
    # so an HR comment on a pre-existing duplicate is never blocked.
    if (("status" in data and new_status != prev_status) or "type" in data) and new_status in ("pending", "approved"):
        kind = p.type_key
        if kind and EmployeePermission.objects.filter(
            employee=p.employee, date=p.date, status__in=["pending", "approved"],
            type__in=EmployeePermission.type_values(kind),
        ).exclude(pk=p.pk).exists():
            return Response({
                "error": f"A {EmployeePermission.TYPE_LABELS[kind]} request already exists for {p.date.isoformat()}",
            }, status=409)
    if deciding:
        try:
            resolve_permission(p, approval.HR, new_status, hr_name, comment)
        except approval.ApprovalError as exc:
            return approval.refusal(exc)
        hr_access.log_decision(request, PERMISSION_WORKFLOW, p, new_status)
        return Response(_permission_json(p))

    # A comment / type edit, or a correction of a decision already made (approved <-> rejected).
    p.status = new_status
    if comment is not None:
        p.hr_comment = comment
    if new_status != prev_status and new_status in ("approved", "rejected"):
        p.approved_by = hr_name
        p.approver_role = "hr"
        p.approval_trail = approval.trail_of(PERMISSION_WORKFLOW, p) + [
            {"role": approval.HR, "decision": new_status, "by": hr_name, "comment": comment, "revised": True}
        ]
    p.save()
    if new_status != prev_status:
        hr_access.log_decision(request, PERMISSION_WORKFLOW, p, new_status, f"permission request #{p.pk} (revised)")
    if new_status != prev_status and new_status in ("approved", "rejected"):
        whatsapp_approvals.notify_decision(
            "permission", p, p.status, approver=p.approved_by or "", role="hr", comment=p.hr_comment
        )
    return Response(_permission_json(p))
