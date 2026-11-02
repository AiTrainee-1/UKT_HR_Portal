"""Put back the overtime pay that the old payroll edit dropped (owner approved the correction on 2026-10-31).

Before 2026-10-31, `PATCH /api/payroll/<id>` (Mark as Paid, or a bonus/deduction edit) recomputed
`final_salary = gross + bonus - deductions`, leaving out `ot_amount`; the engine's net is `gross + OT - deductions`. A row it
damaged is recognised exactly: it has OT pay, and its final salary equals the old formula and not the right one. Nothing
else is touched (a row HR adjusted some other way does not match).

    python manage.py fix_payroll_dropped_ot                 # dry run: lists the rows it would correct
    python manage.py fix_payroll_dropped_ot --year 2026 --month 9
    python manage.py fix_payroll_dropped_ot --apply         # corrects them (asks to type "correct" unless --noinput)

`--apply` sets `final_salary = gross + OT + bonus - deductions` on each matching row in one transaction, adds a line to the
row's notes and writes one audit-log entry per row (old and new final salary). It changes no salary slip, no status and
no other field.
"""

from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from api.models import AuditLog, Payroll

CENT = Decimal("0.01")
ACTOR = "fix_payroll_dropped_ot"


def _q(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT)


def damaged_rows(year=None, month=None):
    """(payroll, wrong_final, right_final) for every row the old edit damaged."""
    qs = (
        Payroll.objects.select_related("employee")
        .filter(ot_amount__gt=0)
        .order_by("year", "month", "employee_id", "id")
    )
    if year:
        qs = qs.filter(year=year)
    if month:
        qs = qs.filter(month=month)
    out = []
    for p in qs:
        old_formula = _q(_q(p.gross_salary) + _q(p.bonus) - _q(p.deductions))
        right = _q(_q(p.gross_salary) + _q(p.ot_amount) + _q(p.bonus) - _q(p.deductions))
        if _q(p.final_salary) == old_formula and old_formula != right:
            out.append((p, old_formula, right))
    return out


class Command(BaseCommand):
    help = "Put back overtime pay that the old payroll edit (before 2026-10-31) dropped from final salary. Dry run by default."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Correct the rows (default: only list them).")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation with --apply.")
        parser.add_argument("--year", type=int)
        parser.add_argument("--month", type=int)

    def handle(self, *args, **opts):
        if opts["month"] and not 1 <= opts["month"] <= 12:
            raise CommandError("--month must be 1 to 12")
        db = connection.settings_dict
        self.stdout.write(f"Database: {db.get('NAME')} on {db.get('HOST') or 'local socket'}")
        rows = damaged_rows(opts["year"], opts["month"])
        if not rows:
            self.stdout.write("No payroll record has dropped overtime pay. Nothing to correct.")
            return
        total = Decimal("0")
        self.stdout.write(
            f"{'Period':<10} {'Code':<10} {'Employee':<28} {'Status':<9} {'Final now':>12} {'OT':>10} {'Corrected':>12}"
        )
        for p, wrong, right in rows:
            emp = p.employee
            name = f"{emp.first_name} {emp.last_name}".strip() if emp else "-"
            period = f"{p.year}-{p.month:02d}" + (f" w{p.week_number}" if p.week_number else "")
            code = emp.employee_code if emp else "-"
            self.stdout.write(
                f"{period:<10} {code:<10} {name[:28]:<28} {p.status:<9} {wrong:>12} {_q(p.ot_amount):>10} {right:>12}"
            )
            total += right - wrong
        self.stdout.write(f"{len(rows)} record(s); overtime to put back: Rs. {total}")
        if not opts["apply"]:
            self.stdout.write("DRY RUN - nothing was changed. Run again with --apply to correct these records.")
            return
        if not opts["noinput"]:
            answer = input('Type "correct" to change these payroll records: ')
            if answer.strip().lower() != "correct":
                self.stdout.write("Cancelled - nothing was changed.")
                return
        corrected = 0
        with transaction.atomic():
            for p, wrong, right in rows:
                locked = Payroll.objects.select_for_update().get(pk=p.pk)
                if _q(locked.final_salary) != wrong:
                    continue  # changed since it was read: leave it alone
                corrected += 1
                note = f"[{ACTOR}] Overtime Rs. {_q(locked.ot_amount)} put back: final salary {wrong} -> {right}."
                locked.final_salary = right
                locked.notes = f"{locked.notes}\n{note}" if locked.notes else note
                locked.save(update_fields=["final_salary", "notes"])
                emp = locked.employee
                AuditLog.objects.create(
                    user_type="system",
                    user_name=ACTOR,
                    action="update",
                    module="payroll",
                    record_id=locked.pk,
                    record_description=(
                        f"Overtime put back on payroll {locked.year}-{locked.month:02d} of "
                        f"{emp.employee_code if emp else locked.employee_id}"
                    ),
                    old_values={"finalSalary": float(wrong)},
                    new_values={"finalSalary": float(right), "otAmount": float(_q(locked.ot_amount))},
                    branch_id=emp.branch_id if emp else None,
                )
        self.stdout.write(self.style.SUCCESS(f"Corrected {corrected} payroll record(s)."))
