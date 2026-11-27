"""Work out the 1st-20th earned salary (Settlement report: Fixed Salary, Working Days, Working Salary, Earned Amount) for
every advance that does not have it yet - run once after deploying migration 0187 (2026-11-26).

The Settlement list also fills a few on each read (advance_earnings.FILL_PER_READ), so running this is not required for
correctness; it only saves HR's first page loads from doing the work. Writes only the advances' earned_* columns (and
salary_at_request where it was empty); never a payroll, slip or repayment.

    python manage.py fill_advance_earnings [--dry-run]
"""

from django.core.management.base import BaseCommand
from django.db.models import Q

from api import advance_earnings
from api.models import Advance


class Command(BaseCommand):
    help = "Fill the 1st-20th earned-salary figures of advances that have none (after migration 0187)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Only count the advances that would be filled.")

    def handle(self, *args, **opts):
        todo = (
            Advance.objects.filter(Q(earned_on__isnull=True) | Q(leave_days_1_20__isnull=True))
            .select_related("employee")
            .order_by("id")
        )
        total = todo.count()
        if opts["dry_run"]:
            self.stdout.write(f"{total} advance(s) have no earned-salary figures yet.")
            return
        done = 0
        for adv in todo.iterator():
            advance_earnings.refresh(adv)
            done += 1
        self.stdout.write(self.style.SUCCESS(f"Filled {done} of {total} advance(s)."))
