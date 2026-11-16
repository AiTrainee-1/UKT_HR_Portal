"""Production payroll Cleared before the period workflow counts as Paid (owner decision, 2026-11-16: "count old Cleared as
Paid").

Until 2026-11-16 a production payroll had no payment step: HR's "Mark as Cleared" (Payroll.status "paid") was the only
sign it was paid, and the MD portal read it so. The period workflow (production_period_workflow.py) adds Payroll Done and
Mark as Paid per pay period, and "paid" now means payment_status. So that no past figure changes:

* every production payroll (period_start set) whose status is "paid" (Cleared) gets payment_status "paid",
  payment_paid_at = its own updated_at (when it was last touched, i.e. cleared at the latest) and payment_paid_by
  "Cleared before the period workflow";
* a cycle period every payroll of which is Cleared gets a ProductionPeriodClose, finalized AND paid (finalized_at =
  paid_at = the latest updated_at of the period's payrolls, by the same note; paid_on = that day in India), so the period
  shows as Paid and is locked like one HR finished with the new buttons.

The cycle of a row is the one it was generated on (pay_cycle); a row from before the cycles (none stamped) takes its
worker's cycle now, as the pages show it; a period with such rows and no worker on a cycle gets no close. Rows of a
period are counted whatever the worker's status (inactive workers' rows count too: a period is closed only when EVERY row
of it is Cleared).

Never regenerates or recomputes anything: no figure is touched. Idempotent: a row already paid and a period already
closed are left as they are. Reverse: nothing (the backfill is not undone).
"""

from django.db import migrations
from django.db.models import Count, F, Max, Min, Q

NOTE = "Cleared before the period workflow"


def backfill(apps, schema_editor):
    from datetime import timezone as dt_timezone
    from zoneinfo import ZoneInfo

    Payroll = apps.get_model("api", "Payroll")
    ProductionPeriodClose = apps.get_model("api", "ProductionPeriodClose")
    india = ZoneInfo("Asia/Kolkata")

    production = Payroll.objects.filter(period_start__isnull=False, period_end__isnull=False)
    cleared = production.filter(status="paid").exclude(payment_status="paid")
    marked = cleared.update(payment_status="paid", payment_paid_at=F("updated_at"), payment_paid_by=NOTE)

    # the cycle of each row: stamped, else the worker's cycle now
    periods: dict[tuple, dict] = {}
    rows = production.values("pay_cycle", "employee__production_pay_cycle", "period_start", "period_end").annotate(
        n=Count("id"), cleared=Count("id", filter=Q(status="paid")), last=Max("updated_at"), first=Min("created_at")
    )
    for r in rows:
        cycle = r["pay_cycle"] or r["employee__production_pay_cycle"]
        key = (cycle, r["period_start"], r["period_end"])
        entry = periods.setdefault(key, {"n": 0, "cleared": 0, "last": None, "first": None})
        entry["n"] += r["n"]
        entry["cleared"] += r["cleared"]
        if r["last"] and (entry["last"] is None or r["last"] > entry["last"]):
            entry["last"] = r["last"]
        if r["first"] and (entry["first"] is None or r["first"] < entry["first"]):
            entry["first"] = r["first"]

    closed = 0
    for (cycle, start, end), entry in sorted(periods.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        if not cycle or entry["n"] == 0 or entry["cleared"] < entry["n"] or entry["last"] is None:
            continue
        if ProductionPeriodClose.objects.filter(cycle=cycle, period_start=start, period_end=end).exists():
            continue
        moment = entry["last"]
        ProductionPeriodClose.objects.create(
            cycle=cycle,
            period_start=start,
            period_end=end,
            finalized_at=moment,
            finalized_by=NOTE,
            paid_at=moment,
            paid_by=NOTE,
            paid_on=moment.astimezone(dt_timezone.utc).astimezone(india).date(),
            first_generated_at=entry["first"],
            last_computed_at=moment,
            snapshot={"backfill": True, "inPayroll": entry["n"], "notCleared": 0},
        )
        closed += 1
    if (marked or closed) and schema_editor is not None:
        print(f"\n  0151: {marked} production payroll(s) Cleared before the period workflow marked Paid; {closed} period(s) closed")


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0150_org_category_split"),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
