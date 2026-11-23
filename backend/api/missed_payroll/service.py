"""Missed Payroll: Generate, Clear, Done, Paid (and their undo where it is safe).

Generate   works the figures out (engine.py, always rolled back) and saves them on the page's own entry; again
           replaces them while the entry is only Generated.
Clear      HR checked the figures: they are frozen (Undo clear puts it back to Generated).
Done       the figures go into the month's Payroll + SalarySlip (engine.write), one employee at a time, all or nothing
           per employee, under the payroll run slot so it never runs beside a Generate / Payroll Done.
Paid       the payroll is marked paid (payment status) on the day HR says; staff get the usual "salary paid" phone
           notification once (payroll_month_workflow.notify_salary_paid; owner 2026-11-23), production none.
Discard    a Generated entry is dropped (nothing was written anywhere).
"""

from __future__ import annotations

from datetime import date

from django.db import transaction
from django.utils import timezone

from .. import payroll_month_workflow as month_workflow
from .. import payroll_progress
from ..models import MissedPayroll, Payroll
from . import engine, lists

MAX_PER_CALL = 20


class Busy(Exception):
    """Another payroll run (or Done) holds the run slot."""


def _who(emp) -> dict:
    return {"employeeId": emp.id, "employeeCode": emp.employee_code, "name": lists._name(emp)}


def _claim():
    if not payroll_progress.try_begin_run():
        raise Busy("A payroll run is in progress. Wait for it to finish, then try again.")


def generate(kind: str, emps, month: int, year: int, actor: str) -> dict:
    """Work out the missed payroll of `emps` (the page's selection) and save it. Returns {generated, skipped}."""
    rows = lists.classify(kind, emps, month, year)
    generated, skipped = [], []
    spans = None
    if kind == engine.KIND_PRODUCTION:
        from .. import production_coverage as coverage

        spans = coverage.spans_for_employees([e.id for e in emps])
    parked = engine.parked_rows([e.id for e in emps], month, year) if kind == engine.KIND_PRODUCTION else {}
    _claim()
    try:
        for emp in emps:
            row = rows.get(emp.id)
            if row is None:
                skipped.append({**_who(emp), "reason": "Not missed: the payroll already pays this employee."})
                continue
            if not row["canGenerate"]:
                skipped.append({**_who(emp), "reason": row["cannotGenerate"] or "Cannot be generated here."})
                continue
            try:
                if kind == engine.KIND_STAFF:
                    figures = engine.compute_staff(emp, month, year)
                else:
                    figures = engine.compute_production(
                        emp, month, year, parked=parked.get(emp.id), spans=spans.get(emp.id, [])
                    )
            except engine.Refused as exc:
                skipped.append({**_who(emp), "reason": str(exc)})
                continue
            gross, deductions, net = engine.amounts(figures)
            with transaction.atomic():
                entry = (
                    MissedPayroll.objects.select_for_update()
                    .filter(employee=emp, kind=kind, month=month, year=year)
                    .first()
                )
                if entry is not None and entry.status != MissedPayroll.STATUS_GENERATED:
                    skipped.append({**_who(emp), "reason": f"Already {entry.get_status_display().lower()}."})
                    continue
                if entry is None:
                    entry = MissedPayroll(employee=emp, kind=kind, month=month, year=year, generated_by=actor)
                else:
                    entry.regenerated_at = timezone.now()
                    entry.generated_by = actor
                entry.category = row["category"]
                entry.replaces_id = figures.get("replaces")
                entry.figures = figures
                entry.gross, entry.deductions, entry.net = gross, deductions, net
                entry.save()
            generated.append({**_who(emp), "entryId": entry.id, "net": float(net), "gross": float(gross)})
    finally:
        payroll_progress.end_run()
    return {"generated": generated, "skipped": skipped}


def _entries(kind: str, month: int, year: int, emp_ids) -> list[MissedPayroll]:
    return list(
        MissedPayroll.objects.select_related("employee")
        .filter(kind=kind, month=month, year=year, employee_id__in=list(emp_ids))
        .order_by("employee__employee_code")
    )


def _step(entries, want: str, to: str, actor: str, field: str | None, refusal: str) -> tuple[list[int], list[dict]]:
    done, refused = [], []
    for entry in entries:
        if entry.status != want:
            refused.append({**_who(entry.employee), "reason": refusal.format(status=entry.get_status_display())})
            continue
        changes = {"status": to}
        if field:
            changes[f"{field}_at"] = timezone.now()
            changes[f"{field}_by"] = actor
        updated = MissedPayroll.objects.filter(pk=entry.pk, status=want).update(**changes)
        if updated:
            done.append(entry.id)
        else:
            refused.append({**_who(entry.employee), "reason": "Changed by someone else just now: refresh."})
    return done, refused


def clear(entries, actor: str):
    return _step(
        entries,
        MissedPayroll.STATUS_GENERATED,
        MissedPayroll.STATUS_CLEARED,
        actor,
        "cleared",
        "Only a generated payroll can be cleared (this one is {status}).",
    )


def unclear(entries, actor: str):
    done, refused = [], []
    for entry in entries:
        if entry.status != MissedPayroll.STATUS_CLEARED:
            refused.append({**_who(entry.employee), "reason": "Only a cleared payroll can go back to generated."})
            continue
        if MissedPayroll.objects.filter(pk=entry.pk, status=MissedPayroll.STATUS_CLEARED).update(
            status=MissedPayroll.STATUS_GENERATED, cleared_at=None, cleared_by=""
        ):
            done.append(entry.id)
    return done, refused


def discard(entries):
    done, refused = [], []
    for entry in entries:
        if entry.status != MissedPayroll.STATUS_GENERATED:
            refused.append({**_who(entry.employee), "reason": "Only a generated (not cleared) payroll can be removed."})
            continue
        if MissedPayroll.objects.filter(pk=entry.pk, status=MissedPayroll.STATUS_GENERATED).delete()[0]:
            done.append(entry.id)
    return done, refused


def mark_done(entries, actor: str) -> tuple[list[dict], list[dict]]:
    """Done: write each cleared entry into the month's payroll. Returns (done rows, refused rows)."""
    done, refused = [], []
    _claim()
    try:
        for entry in entries:
            if entry.status != MissedPayroll.STATUS_CLEARED:
                refused.append(
                    {**_who(entry.employee), "reason": "Clear it first: only a cleared payroll can be Done."}
                )
                continue
            try:
                with transaction.atomic():
                    locked = MissedPayroll.objects.select_for_update().get(pk=entry.pk)
                    if locked.status != MissedPayroll.STATUS_CLEARED:
                        raise engine.Refused("Changed by someone else just now: refresh.")
                    payroll = engine.write(locked, actor)
                    locked.payroll = payroll
                    locked.status = MissedPayroll.STATUS_DONE
                    locked.done_at, locked.done_by = timezone.now(), actor
                    locked.save(update_fields=["payroll", "status", "done_at", "done_by"])
            except engine.Refused as exc:
                refused.append({**_who(entry.employee), "reason": str(exc)})
                continue
            done.append({**_who(entry.employee), "entryId": entry.id, "payrollId": payroll.id})
    finally:
        payroll_progress.end_run()
    return done, refused


def mark_paid(entries, paid_on: date, actor: str) -> tuple[list[dict], list[dict], list[int]]:
    """Paid: the Done payrolls are marked paid. Returns (paid rows, refused rows, staff payroll ids to notify)."""
    paid, refused, notify = [], [], []
    now = timezone.now()
    for entry in entries:
        if entry.status != MissedPayroll.STATUS_DONE or entry.payroll_id is None:
            refused.append({**_who(entry.employee), "reason": "Only a payroll marked Done can be marked paid."})
            continue
        with transaction.atomic():
            updated = MissedPayroll.objects.filter(pk=entry.pk, status=MissedPayroll.STATUS_DONE).update(
                status=MissedPayroll.STATUS_PAID, paid_at=now, paid_by=actor, paid_on=paid_on
            )
            if not updated:
                refused.append({**_who(entry.employee), "reason": "Changed by someone else just now: refresh."})
                continue
            Payroll.objects.filter(pk=entry.payroll_id).exclude(payment_status=Payroll.PAYMENT_PAID).update(
                payment_status=Payroll.PAYMENT_PAID, payment_paid_at=now, payment_paid_by=actor
            )
        paid.append({**_who(entry.employee), "entryId": entry.id, "payrollId": entry.payroll_id})
        if entry.kind == engine.KIND_STAFF:
            notify.append(entry.payroll_id)
    return paid, refused, notify


def notify_paid(payroll_ids: list[int]) -> None:
    month_workflow.notify_later(payroll_ids, f"missed-payroll-paid-{payroll_ids[0]}" if payroll_ids else "missed")
