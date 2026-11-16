"""Replacing DRAFT production payrolls (owner 2026-11-16).

"If the payroll status is only Generated, I should still be able to regenerate or recompute the payroll without any
restrictions." A production payroll is FINAL once its salary is marked Paid or its pay period is finalized (Payroll Done);
every other one is a DRAFT (production_coverage.FinalRule). When a period is generated with "replace the overlapping draft
payslips", every draft of ANOTHER period of the same worker that shares a day with it -the old week-start grid after the
week start was changed, the worker's old cycle after a move- is deleted first, so the period is worked out on the latest
data and each day is paid once:

    * the draft's Payroll row and its SalarySlip are deleted (a FINAL row is never touched: refused if one became final);
    * the advance repayments its slip deducted are released (not processed again, the advance's repaid total and
      outstanding put back, a closed advance re-opened) so the next payroll of their month recovers them, once;
    * New Joiners: an "added to the payroll" of a replaced draft of the SAME cycle is carried to the new payslip, so HR does
      not have to add the worker again; a replaced draft of another cycle carries nothing (the new payslip is judged afresh);
    * the run logs who replaced which rows and why (production_payroll_views), and reports the days of the deleted drafts
      outside the period that no payroll pays any more: they wait for their own period to be generated (never lost
      silently, never paid twice).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from django.db.models import Q

from .models import AdvanceRepayment, Payroll, SalarySlip
from .production_coverage import day_count, fmt_range, merge, parse_ranges, subtract


class DraftReplaceRefused(Exception):
    """A row listed as a draft is no longer one (paid, or its period finalized meanwhile)."""


def _repayment_ids(slip: SalarySlip | None) -> list[int]:
    deductions = ((slip.breakdown_details or {}).get("deductions") or {}) if slip is not None else {}
    ids = []
    for detail in deductions.get("advanceDetails") or []:
        try:
            ids.append(int(detail["repaymentId"]))
        except (KeyError, TypeError, ValueError):
            continue
    return ids


def release_repayments(repayment_ids, deleting_slip_ids) -> list[int]:
    """Undo what a deleted payslip deducted: each processed repayment it recorded is processed no more, and its advance's
    repaid total / outstanding (and a closed status) are put back. A repayment another payslip (not being deleted) also
    records is left alone. Returns the ids released."""
    released = []
    for rep in AdvanceRepayment.objects.select_related("advance").filter(pk__in=list(repayment_ids), is_processed=True):
        elsewhere = (
            SalarySlip.objects.filter(breakdown_details__deductions__advanceDetails__contains=[{"repaymentId": rep.pk}])
            .exclude(pk__in=list(deleting_slip_ids))
            .exists()
        )
        if elsewhere:
            continue
        rep.is_processed = False
        rep.save(update_fields=["is_processed"])
        adv = rep.advance
        adv.total_repaid = max(Decimal("0"), Decimal(str(adv.total_repaid)) - Decimal(str(rep.amount)))
        adv.outstanding = max(Decimal("0"), Decimal(str(adv.amount)) - Decimal(str(adv.total_repaid)))
        if adv.status == adv.STATUS_CLOSED and adv.outstanding > 0:
            adv.status = adv.STATUS_APPROVED
        adv.save(update_fields=["total_repaid", "outstanding", "status"])
        released.append(rep.pk)
    return released


def row_days(payroll: Payroll) -> list[tuple[date, date]]:
    return parse_ranges(payroll.paid_ranges) or [(payroll.period_start, payroll.period_end)]


def replace_drafts(emp, draft_ids, cycle: str | None) -> dict:
    """Delete the worker's draft payrolls `draft_ids` (each must still be a draft) with their payslips, releasing the
    advance repayments they deducted. Returns what was replaced, for the run's answer and its audit log:
    {"rows": [...], "days": [(from, to), ...] every day they paid, "carryAdded": (at, by) or None}."""
    from .production_coverage import FinalRule

    is_final = FinalRule()
    rows = list(
        Payroll.objects.select_for_update()
        .select_related("employee")
        .filter(employee=emp, id__in=list(draft_ids), period_start__isnull=False)
    )
    out_rows, days, carry = [], [], None
    for p in rows:
        if is_final(p.pay_cycle, p.period_start, p.period_end, p.payment_status):
            raise DraftReplaceRefused(
                f"The payslip for {fmt_range(p.period_start, p.period_end)} is final (paid or finalized) and is never "
                "replaced."
            )
    slips = list(
        SalarySlip.objects.filter(
            employee=emp,
            period_start__in=[p.period_start for p in rows],
            period_end__in=[p.period_end for p in rows],
        )
    )
    slip_of = {(s.period_start, s.period_end): s for s in slips}
    slip_ids = [
        s.pk for s in slips if any((s.period_start, s.period_end) == (p.period_start, p.period_end) for p in rows)
    ]
    for p in rows:
        slip = slip_of.get((p.period_start, p.period_end))
        released = release_repayments(_repayment_ids(slip), slip_ids)
        if cycle and p.pay_cycle == cycle and p.added_to_payroll_at is not None:
            carry = (p.added_to_payroll_at, p.added_to_payroll_by)
        days.extend(row_days(p))
        out_rows.append(
            {
                "payrollId": p.pk,
                "cycle": p.pay_cycle,
                "periodStart": p.period_start.isoformat(),
                "periodEnd": p.period_end.isoformat(),
                "periodLabel": fmt_range(p.period_start, p.period_end),
                "net": float(p.final_salary),
                "status": p.status,
                "cleared": p.status == Payroll.STATUS_PAID,
                "days": day_count(row_days(p)),
                "releasedRepayments": released,
            }
        )
        if slip is not None:
            slip.delete()
        p.delete()
    return {"rows": out_rows, "days": merge(days), "carryAdded": carry}


def left_unpaid(emp_id: int, replaced_days, period: tuple[date, date]) -> list[tuple[date, date]]:
    """The days of replaced drafts outside `period` that no payroll of the worker pays any more (they wait for their own
    period to be generated)."""
    outside = []
    for start, end in merge(replaced_days):
        outside.extend(subtract((start, end), [period]))
    if not outside:
        return []
    remaining = []
    for p in Payroll.objects.filter(employee_id=emp_id).filter(
        Q(period_start__isnull=False) | Q(salary_mode=Payroll.SALARY_MODE_MONTHLY)
    ):
        if p.period_start is not None:
            remaining.extend(row_days(p))
        elif p.month and p.year:
            import calendar

            remaining.append((date(p.year, p.month, 1), date(p.year, p.month, calendar.monthrange(p.year, p.month)[1])))
    out = []
    for r in merge(outside):
        out.extend(subtract(r, remaining))
    return merge(out)
