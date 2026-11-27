"""The Salary Advance and Term Loan rules, set by HR in Settings -> Loan & Advance (owner 2026-11-27: "all rules customizable
from the Settings page rather than hard-coded"; the two kept separate). Every check - the employee apps, HR's manual
request, eligibility, approval, reports - reads them from here, so a change in Settings applies at once to new requests.

Salary Advance (defaults): up to 50 % of the salary earned from the 1st to the 20th of the month; employees apply on the
21st and 22nd; one Salary Advance a month (a rejected one does not count).

Term Loan (defaults; STAFF ONLY - owner 2026-11-27: "not applicable for production employees now"):
  * up to 100 % of the fixed monthly salary; above the salary only when "Allow loan above monthly salary" is on;
  * repaid in 1 to 6 monthly EMIs (Settings, at most 12), the EMI worked out from the approved amount and months;
  * any day of the month; after 6 completed months of service (the Casual Leave count);
  * one Term Loan approved per CALENDAR year (owner's choice: approved in March 2026 -> again from 1 January 2027);
  * one waiting or active Term Loan at a time;
  * rejected: not again in the same month (from the 1st of the next month).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

LIMITS = {
    "sa_percent": (1, 100),
    "sa_window_from": (1, 28),
    "sa_window_to": (1, 28),
    "sa_earned_through": (1, 28),
    "sa_per_month": (1, 5),
    "tl_limit_percent": (1, 1000),
    "tl_max_months": (1, 12),
    "tl_min_amount": (0, 10_00_000),
    "tl_per_year": (1, 12),
    "tl_min_service_months": (0, 120),
}
ABSOLUTE_MAX_MONTHS = 12


@dataclass(frozen=True)
class Rules:
    sa_percent: int = 50
    sa_window_from: int = 21
    sa_window_to: int = 22
    sa_earned_through: int = 20
    sa_per_month: int = 1
    sa_rejected_allows_reapply: bool = True
    tl_limit_percent: int = 100
    tl_allow_above_salary: bool = False
    tl_max_months: int = 6
    tl_min_amount: int = 1000
    tl_per_year: int = 1
    tl_min_service_months: int = 6
    tl_reapply_next_month: bool = True
    tl_one_open: bool = True

    @property
    def tl_effective_percent(self) -> int:
        """The Term Loan limit's % of the monthly salary: never above 100 unless "allow above salary" is on."""
        return self.tl_limit_percent if self.tl_allow_above_salary else min(self.tl_limit_percent, 100)

    def sa_json(self) -> dict:
        return {
            "percent": self.sa_percent,
            "windowFromDay": self.sa_window_from,
            "windowToDay": self.sa_window_to,
            "earnedThroughDay": self.sa_earned_through,
            "perMonth": self.sa_per_month,
            "rejectedAllowsReapply": self.sa_rejected_allows_reapply,
            "windowText": window_text(self),
        }

    def tl_json(self) -> dict:
        return {
            "limitPercent": self.tl_limit_percent,
            "effectivePercent": self.tl_effective_percent,
            "allowAboveSalary": self.tl_allow_above_salary,
            "maxMonths": self.tl_max_months,
            "absoluteMaxMonths": ABSOLUTE_MAX_MONTHS,
            "minAmount": self.tl_min_amount,
            "perYear": self.tl_per_year,
            "minServiceMonths": self.tl_min_service_months,
            "reapplyNextMonth": self.tl_reapply_next_month,
            "oneOpenAtATime": self.tl_one_open,
            "staffOnly": True,
        }


DEFAULT = Rules()
FIELDS = tuple(Rules.__dataclass_fields__)


def rules() -> Rules:
    """The rules in force (Settings -> Loan & Advance), the defaults without a settings row."""
    from .models import SettlementSettings

    row = SettlementSettings.objects.order_by("id").values(*FIELDS).first()
    return Rules(**row) if row else DEFAULT


def ordinal(n: int) -> str:
    suffix = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def window_text(r: Rules) -> str:
    """ "the 21st and 22nd of each month" / "the 21st to the 25th of each month" / "the 21st of each month"."""
    a, b = r.sa_window_from, r.sa_window_to
    if a == b:
        return f"the {ordinal(a)} of each month"
    if b == a + 1:
        return f"the {ordinal(a)} and {ordinal(b)} of each month"
    return f"the {ordinal(a)} to the {ordinal(b)} of each month"


def clean(data: dict, current: Rules) -> dict:
    """The rule fields of a Settings PUT (camelCase blocks `salaryAdvanceRules` / `termLoanRules`), validated; refuses an
    impossible combination. Returns {model field: value} for what changed."""
    from .settlement_automation.service import WorkflowError

    sa = data.get("salaryAdvanceRules") or {}
    tl = data.get("termLoanRules") or {}
    pairs = {
        "sa_percent": sa.get("percent"),
        "sa_window_from": sa.get("windowFromDay"),
        "sa_window_to": sa.get("windowToDay"),
        "sa_earned_through": sa.get("earnedThroughDay"),
        "sa_per_month": sa.get("perMonth"),
        "sa_rejected_allows_reapply": sa.get("rejectedAllowsReapply"),
        "tl_limit_percent": tl.get("limitPercent"),
        "tl_allow_above_salary": tl.get("allowAboveSalary"),
        "tl_max_months": tl.get("maxMonths"),
        "tl_min_amount": tl.get("minAmount"),
        "tl_per_year": tl.get("perYear"),
        "tl_min_service_months": tl.get("minServiceMonths"),
        "tl_reapply_next_month": tl.get("reapplyNextMonth"),
        "tl_one_open": tl.get("oneOpenAtATime"),
    }
    out: dict = {}
    for field, raw in pairs.items():
        if raw is None:
            continue
        if isinstance(getattr(DEFAULT, field), bool):
            if not isinstance(raw, bool):
                raise WorkflowError("Choose on or off.", "rules", field=field)
            out[field] = raw
            continue
        try:
            value = int(str(raw).strip()) if not isinstance(raw, bool) else None
        except ValueError:
            value = None
        low, high = LIMITS[field]
        if value is None or not low <= value <= high:
            raise WorkflowError(f"Enter a whole number from {low} to {high}.", "rules", field=field)
        out[field] = value
    merged = Rules(**{**{f: getattr(current, f) for f in FIELDS}, **out})
    if merged.sa_window_from > merged.sa_window_to:
        raise WorkflowError(
            "The Salary Advance window must start on or before the day it ends.", "rules", field="sa_window_to"
        )
    if merged.sa_earned_through >= merged.sa_window_from:
        raise WorkflowError(
            "The earned salary must be counted up to a day BEFORE the application window opens, so the figure is "
            "complete when employees apply.",
            "rules",
            field="sa_earned_through",
        )
    if merged.tl_limit_percent > 100 and not merged.tl_allow_above_salary:
        raise WorkflowError(
            "A Term Loan limit above 100% of the monthly salary needs 'Allow loan above monthly salary' switched on.",
            "rules",
            field="tl_limit_percent",
        )
    return out


# ─────────────────────────── Term Loan eligibility ───────────────────────────


def term_limit(emp, r: Rules | None = None) -> Decimal | None:
    """The most a staff employee may ask for as a Term Loan: the % of their fixed monthly salary (whole rupees down);
    None for production / without a salary (no Term Loan)."""
    from .advance_earnings import monthly_fixed_salary

    r = r or rules()
    salary = monthly_fixed_salary(emp)
    if salary is None:
        return None
    return Decimal(math.floor(salary * r.tl_effective_percent / 100))


def _year_bounds(year: int):
    from datetime import datetime

    from .clock import FACTORY_TZ

    return datetime(year, 1, 1, tzinfo=FACTORY_TZ), datetime(year + 1, 1, 1, tzinfo=FACTORY_TZ)


def _month_bounds(today: date):
    from datetime import datetime

    from .clock import FACTORY_TZ

    start = datetime(today.year, today.month, 1, tzinfo=FACTORY_TZ)
    end = datetime(today.year + (today.month == 12), today.month % 12 + 1, 1, tzinfo=FACTORY_TZ)
    return start, end


def term_loan_status(emp, today: date, r: Rules | None = None) -> dict:
    """Every Term Loan rule for one employee today: {eligible, reason, code, limit, monthlySalary, approvedThisYear,
    open (the waiting / active one), rejectedThisMonth, nextEligibleOn}. The first rule that fails gives the reason."""
    from django.db.models import Q

    from .advance_earnings import monthly_fixed_salary, term_loan_service
    from .models import Advance, Employee

    r = r or rules()
    salary = monthly_fixed_salary(emp)
    limit = term_limit(emp, r)
    out = {
        "monthlySalary": float(salary) if salary is not None else None,
        "limit": float(limit) if limit is not None else None,
        "limitPercent": r.tl_effective_percent,
        "minAmount": r.tl_min_amount,
        "maxMonths": r.tl_max_months,
        "perYear": r.tl_per_year,
        "approvedThisYear": 0,
        "open": None,
        "rejectedThisMonth": False,
        "nextEligibleOn": None,
        "eligible": False,
        "reason": None,
        "code": None,
    }

    def refuse(code, reason, next_on=None):
        out.update(code=code, reason=reason, nextEligibleOn=next_on.isoformat() if next_on else None)
        return out

    if emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF:
        return refuse("staff_only", "A Term Loan is for staff employees only.")
    if salary is None:
        return refuse(
            "no_salary",
            "Your monthly salary is not recorded yet, so a Term Loan cannot be worked out. Please contact HR.",
        )
    service = term_loan_service(emp, today, r)
    if not service["eligible"]:
        nxt = date.fromisoformat(service["eligibleFrom"]) if service.get("eligibleFrom") else None
        return refuse("service", service["reason"], nxt)
    term = Advance.objects.filter(employee=emp, advance_type="term")
    year_start, year_end = _year_bounds(today.year)
    approved_this_year = term.filter(status__in=("approved", "closed")).filter(
        Q(approved_at__gte=year_start, approved_at__lt=year_end)
        | Q(approved_at__isnull=True, decided_at__gte=year_start, decided_at__lt=year_end)
    )
    out["approvedThisYear"] = approved_this_year.count()
    if r.tl_one_open:
        open_one = term.filter(Q(status="pending") | Q(status="approved", outstanding__gt=0)).order_by("-id").first()
        if open_one is not None:
            out["open"] = {"id": open_one.id, "status": open_one.status, "amount": float(open_one.amount)}
            if open_one.status == "pending":
                return refuse(
                    "pending", "Your earlier Term Loan request is still waiting for a decision. One request at a time."
                )
            return refuse(
                "active",
                f"Your Term Loan of ₹{open_one.amount:,.0f} is still being repaid. A new one can be asked for once it is "
                "repaid.",
            )
    if out["approvedThisYear"] >= r.tl_per_year:
        nxt = date(today.year + 1, 1, 1)
        times = "once" if r.tl_per_year == 1 else f"{r.tl_per_year} times"
        return refuse(
            "yearly",
            f"A Term Loan can be given {times} a year, and you already had one in {today.year}. You can apply again from "
            f"1 January {today.year + 1}.",
            nxt,
        )
    if r.tl_reapply_next_month:
        m_start, m_end = _month_bounds(today)
        rejected = term.filter(status="rejected").filter(
            Q(decided_at__gte=m_start, decided_at__lt=m_end)
            | Q(decided_at__isnull=True, created_at__gte=m_start, created_at__lt=m_end)
        )
        if rejected.exists():
            out["rejectedThisMonth"] = True
            nxt = date(today.year + (today.month == 12), today.month % 12 + 1, 1)
            return refuse(
                "rejected_this_month",
                f"Your Term Loan request was rejected this month. You can apply again from {nxt.day} "
                f"{nxt.strftime('%B %Y')}.",
                nxt,
            )
    out["eligible"] = True
    return out
