"""
Birthday compensation (Compensation Leave, part C): who has a birthday in a period and what it gives them.

Two rules, by the birthday's date (compensation_engine.birthday_rule):
  * before CompensationConfig.claims_from (the OLD rule): PAID compensation leave for that whole day whatever happened -
    present, 1.00 shift, no late / early / half-day / permission detection;
  * from claims_from on (owner 2026-11-19): the birthday is a NORMAL working day judged from the punches. Not worked (no
    punch: absent, or on approved leave) = paid birthday leave (present, 1.00, marker "birthday", no leave balance used);
    worked (present or half day) = a normal day plus ONE 1.00 credit the employee (or HR) can claim, which goes to the
    Department Head like every compensation claim. Off days (Sunday, declared holiday, off Saturday) give nothing.
The attendance engine applies the day (and payroll reads the result); this endpoint LISTS who is affected and the outcome.

    GET /api/compensation/birthdays?period=today|week|month&date=YYYY-MM-DD
        [&departmentId=&branchId=&q=&outcome=]

`period` is `today` (default), `week` (Monday to Sunday containing `date`) or `month` (the calendar month); `date` defaults
to today (India). Active STAFF only (production is never listed), branch-scoped; an employee without a date of birth cannot
be listed. `departmentId` and `branchId` narrow the list, `q` searches the name / employee code, `outcome` keeps one or
more outcomes (comma separated; values of compensation_effects.BIRTHDAY_*). A read, except that - for a login that may
change Compensation, and never in a finalized (Payroll Done) month - a birthday that has already come and was never
computed (or is stale) is computed through the normal attendance path (compensation_effects); a view-only login gets the
stored day as it is.

A 29 February birthday is celebrated on the 28th in a year that has no 29th. Each row says whether the person BENEFITS:
the master and Birthday switches are on, the day is on or after the feature's effective date (nothing is retroactive) and it
is a working day for them (a Sunday or a declared holiday is a day off already). A row that does not benefit says why. The
day's attendance (`attendanceStatus`) comes from the stored day record; `applied` is true when the birthday IS a paid
birthday leave: the outcome says paid_leave, or (old rule) the engine marked the day `compensation_kind="birthday"` and HR
did not set it by hand for less than a full day; before that (a day not computed yet) it is false, never guessed. `outcome` / `outcomeLabel` / `message` / `claim` / `claimable` say what the birthday gives
(compensation_effects.birthday_outcomes): paid_leave, credit_claimable, credit_pending, credit_approved, credit_rejected,
upcoming, off_day, not_eligible or old_rule.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import compensation_effects as effects
from .auth import require_hr
from .branch_scope import scope_to_branch
from .clock import ist_today
from .compensation_shared import (
    PERIODS,
    birthday_employee_problem,
    birthday_verdict,
    birthdays_between,
    employee_json,
    holiday_names,
    master_enabled,
    parse_date,
    parse_int,
    period_bounds,
)
from .models import AttendanceDayRecord, CompensationConfig, Employee, EmployeeShiftAssignment
from .shift_engine import _get_assignment_for_date


OUTCOME_LABELS = {
    effects.BIRTHDAY_PAID_LEAVE: "Paid birthday leave",
    effects.BIRTHDAY_CREDIT_CLAIMABLE: "Worked: credit to claim",
    effects.BIRTHDAY_CREDIT_PENDING: "Credit claim pending",
    effects.BIRTHDAY_CREDIT_APPROVED: "Credit approved",
    effects.BIRTHDAY_CREDIT_REJECTED: "Credit claim rejected",
    effects.BIRTHDAY_UPCOMING: "Upcoming",
    effects.BIRTHDAY_OFF_DAY: "Day off: nothing to give",
    effects.BIRTHDAY_NOT_ELIGIBLE: "Not eligible",
    effects.BIRTHDAY_OLD_RULE: "Paid automatically (old rule)",
}
CLAIM_STATUS_LABELS = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected"}


def _hhmm(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _num(value) -> float | None:
    return float(value) if value is not None else None


def _search(qs, text: str):
    """Every word of `text` must match the first name, last name or employee code."""
    for word in (text or "").split():
        qs = qs.filter(Q(first_name__icontains=word) | Q(last_name__icontains=word) | Q(employee_code__icontains=word))
    return qs


def _claim_json(claim: dict | None) -> dict | None:
    if not claim:
        return None
    status = claim.get("status")
    return {
        "id": claim.get("id"),
        "kind": claim.get("kind"),
        "status": status,
        "statusLabel": CLAIM_STATUS_LABELS.get(status, status),
        "shifts": _num(claim.get("shifts")),
    }


def _marker_trusted(record) -> bool:
    """The stored day carries the engine's birthday marker and is not a day set by hand that pays less than a full day
    (compensation_effects._birthday_from_day reads the marker the same way)."""
    if record is None or record.compensation_kind != "birthday":
        return False
    return not (record.source == "manual" and Decimal(record.shifts_earned or 0) < Decimal("1.00"))


def birthday_rows(
    request: Request, start, end, department_id=None, branch_id=None, q=None, today=None, refresh: bool = False
) -> list[dict]:
    """The birthdays of active staff in [start, end], each with its verdict, its outcome (compensation_effects
    .birthday_outcomes: paid leave / credit / claim state ...) and the day's stored attendance. A handful of queries
    whatever the number of employees (people, holidays, outcomes, day records). `q` searches the name / code. `refresh`:
    a day not worked out yet (or stale) is worked out first - only for a caller that may change Compensation, never in a
    finalized payroll month (a read never rewrites attendance)."""
    # a period is at most a month, so it touches at most two calendar months (the SQL filter narrows the people read)
    months = {start.month, end.month} if (end - start).days <= 31 else set(range(1, 13))
    qs = scope_to_branch(
        Employee.objects.select_related("department", "designation", "branch").filter(
            employment_type="staff", status="active", date_of_birth__isnull=False, date_of_birth__month__in=months
        ),
        request,
    )
    if department_id is not None:
        qs = qs.filter(department_id=department_id)
    if branch_id is not None:
        qs = qs.filter(branch_id=branch_id)
    if q:
        qs = _search(qs, q)
    people = list(qs)
    if not people:
        return []
    cfg = CompensationConfig.get()
    master = master_enabled()
    holidays = holiday_names(start, end)
    dated = [(emp, day) for emp in people for day in birthdays_between(emp.date_of_birth, start, end)]
    # before the day records are read: a birthday that has come and was never computed is computed here
    outcomes = effects.birthday_outcomes(dated, today=today or ist_today(), refresh=refresh)
    records = {
        (r.employee_id, r.date): r
        for r in AttendanceDayRecord.objects.filter(
            employee_id__in=[e.id for e in people], date__gte=start, date__lte=end
        )
    }
    # a Saturday birthday needs the shift assignment (an off Saturday is already a day off): one query for all of them
    assignments: dict[int, list] = defaultdict(list)
    saturday_ids = {emp.id for emp, day in dated if day.weekday() == 5}
    if saturday_ids:
        for assignment in EmployeeShiftAssignment.objects.filter(employee_id__in=saturday_ids):
            assignments[assignment.employee_id].append(assignment)
    rows = []
    for emp, day in dated:
        benefits, why = birthday_verdict(day, master, cfg, holidays)
        if benefits:
            saturday_off = False
            if day.weekday() == 5:
                assignment = _get_assignment_for_date(emp, day, assignments=assignments[emp.id])
                saturday_off = bool(assignment and assignment.saturday_off)
            why = birthday_employee_problem(emp, day, saturday_off)
            benefits = not why
        record = records.get((emp.id, day))
        outcome = outcomes.get((emp.id, day)) or {}
        value = outcome.get("outcome") or effects.BIRTHDAY_NOT_ELIGIBLE
        rows.append(
            {
                **employee_json(emp),
                "birthday": day.isoformat(),
                "weekday": day.strftime("%A"),
                "benefits": benefits,
                "reason": why or None,
                "attendanceStatus": record.status if record else None,
                # paid birthday leave by the outcome (the same reading as the employee's page), never the raw marker
                # alone: a day set by hand that pays less than a full day keeps a stale marker (verification 2026-11-19)
                "applied": value == effects.BIRTHDAY_PAID_LEAVE
                or (value == effects.BIRTHDAY_OLD_RULE and _marker_trusted(record)),
                "compensationKind": (record.compensation_kind or None) if record else None,
                "firstPunch": _hhmm(record.first_punch) if record else None,
                "lastPunch": _hhmm(record.last_punch) if record else None,
                "shiftsEarned": float(record.shifts_earned) if record else None,
                # what the birthday gives (claim rules from CompensationConfig.claims_from on)
                "outcome": value,
                "outcomeLabel": OUTCOME_LABELS.get(value, value),
                "message": outcome.get("message"),
                "outcomeShifts": _num(outcome.get("shifts")),
                "claim": _claim_json(outcome.get("claim")),
                "claimable": bool(outcome.get("claimable")),
            }
        )
    rows.sort(key=lambda r: (r["birthday"], r["employeeName"], r["employeeCode"]))
    return rows


@api_view(["GET"])
@require_hr
def compensation_birthdays(request: Request) -> Response:
    from .compensation_views import can_edit_compensation

    q = request.query_params
    period = (q.get("period") or "today").lower()
    if period not in PERIODS:
        return Response({"error": "period must be today, week or month."}, status=400)
    anchor = ist_today()
    if q.get("date"):
        anchor = parse_date(q.get("date"))
        if anchor is None:
            return Response({"error": "date must be a date (YYYY-MM-DD)."}, status=400)
    for name in ("departmentId", "branchId"):
        if q.get(name) not in (None, "") and parse_int(q.get(name)) is None:
            return Response({"error": f"{name} must be a number."}, status=400)
    wanted = {part.strip() for part in (q.get("outcome") or "").split(",") if part.strip()}
    unknown = sorted(wanted - set(OUTCOME_LABELS))
    if unknown:
        return Response(
            {"error": f"outcome must be one of {', '.join(OUTCOME_LABELS)} (got {', '.join(unknown)})."}, status=400
        )
    start, end = period_bounds(period, anchor)
    rows = birthday_rows(
        request,
        start,
        end,
        parse_int(q.get("departmentId")),
        parse_int(q.get("branchId")),
        q=(q.get("q") or "").strip() or None,
        today=ist_today(),
        # only a login that may change Compensation works a missing / stale birthday out (a view-only list never writes)
        refresh=can_edit_compensation(request, "compensation.leave.birthdays"),
    )
    # the counts by outcome are of the whole period (before the outcome filter), for the page's tiles
    outcome_counts = {key: 0 for key in OUTCOME_LABELS}
    for row in rows:
        outcome_counts[row["outcome"]] = outcome_counts.get(row["outcome"], 0) + 1
    if wanted:
        rows = [row for row in rows if row["outcome"] in wanted]
    cfg = CompensationConfig.get()
    master = master_enabled()
    return Response(
        {
            "period": period,
            "date": anchor.isoformat(),
            "from": start.isoformat(),
            "to": end.isoformat(),
            "enabled": {
                "master": master,
                "birthday": master and cfg.birthday_enabled,
                "effectiveFrom": cfg.birthday_effective_from.isoformat() if cfg.birthday_effective_from else None,
                # the claim rules (absent = paid leave, worked = a credit to claim) apply to birthdays from this day on
                "claimsFrom": cfg.claims_from.isoformat() if cfg.claims_from else None,
            },
            "count": len(rows),
            "benefitCount": sum(1 for r in rows if r["benefits"]),
            "outcomeCounts": outcome_counts,
            # the same counts under the name the HR page reads (counted before the outcome filter)
            "summary": {"byOutcome": outcome_counts},
            "outcomeLabels": OUTCOME_LABELS,
            "results": rows,
        }
    )
