"""Explain why a WhatsApp attendance alert was, or wasn't, sent to an employee.

    python manage.py whatsapp_alert_trace 30020
    python manage.py whatsapp_alert_trace 30020 30021 --at 09:25

It runs the same decision code the scheduler runs (whatsapp_alerts.evaluate) for today, and prints each
step in plain words: the employee's shift and grace, their punches, and for every alert whether it is
due and, if not, exactly why. It never sends anything. `--at` asks "what would be due at this time
today?", handy for checking a rule without waiting for the clock.
"""

from django.core.management.base import BaseCommand, CommandError

from api import whatsapp_alerts, whatsapp_service
from api.clock import FACTORY_TZ, ist_now
from api.models import Employee, WhatsAppMessageLog, WhatsAppSettings


class Command(BaseCommand):
    help = "Explain, step by step, which WhatsApp attendance alerts are due for an employee and why (sends nothing)."

    def add_arguments(self, parser):
        parser.add_argument("employee_codes", nargs="+", help="Employee code(s), e.g. 30020")
        parser.add_argument("--at", metavar="HH:MM", help="Pretend it is this time of day today")

    def handle(self, *args, **options):
        now = ist_now()
        if options["at"]:
            try:
                hour, minute = (int(p) for p in options["at"].split(":"))
                now = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            except ValueError as exc:
                raise CommandError("--at must look like 09:25") from exc

        out = self.stdout.write
        switches = WhatsAppSettings.get()
        out(f"Now (IST): {now:%Y-%m-%d %H:%M}   WhatsApp configured: {whatsapp_service.is_configured()}")
        out(
            "Switches: attendance alerts (all)={} | absent={} | late={} | punch reminder={} | missing punch={}".format(
                *(
                    "ON" if v else "OFF"
                    for v in (
                        switches.attendance_alerts_enabled,
                        switches.absent_alert_enabled,
                        switches.late_alert_enabled,
                        switches.four_punch_alert_enabled,
                        switches.missing_punch_alert_enabled,
                    )
                )
            )
        )
        out(
            f"Timing: reminder {switches.four_punch_lead_minutes} min before a punch | missing-punch alert "
            f"{switches.missing_punch_after_minutes} min after | extra wait before Absent {switches.absent_extra_minutes} min"
        )
        blocked = []
        if not switches.attendance_alerts_enabled:
            blocked.append("the master 'Attendance Alerts (All)' switch is OFF")
        if not whatsapp_service.is_configured():
            blocked.append("WhatsApp (WAClient) is not configured on this server")
        reason = whatsapp_alerts.non_working_reason(now.date())
        if reason:
            blocked.append(f"today is {reason}")
        if blocked:
            out("The scheduler sends NOTHING right now because " + "; ".join(blocked) + ".")

        day = whatsapp_alerts.load_day(now, switches)
        for code in options["employee_codes"]:
            emp = Employee.objects.filter(employee_code=code).first()
            out("")
            if emp is None:
                out(f"== {code}: no employee with this code")
                continue
            out(
                f"== {emp.employee_code} {emp.first_name} {emp.last_name} | status={emp.status} | "
                f"type={emp.employment_type} | phone={'yes' if emp.phone else 'MISSING'}"
            )
            if emp.status != "active" or emp.employment_type != Employee.EMPLOYMENT_TYPE_STAFF:
                out("   Only ACTIVE STAFF employees are checked by the alert job: this employee is skipped.")
                continue
            trace: list[str] = []
            due = whatsapp_alerts.evaluate(emp, day, trace)
            for line in trace:
                out(f"   - {line}")
            out("   Due right now: " + (", ".join(f"{d.doc_type} ({d.tag})" for d in due) or "nothing"))

            sent = WhatsAppMessageLog.objects.filter(employee=emp, dedupe_key__contains=f":{day.iso}:").order_by(
                "created_at"
            )
            out("   Already sent today:" + ("" if sent else " nothing"))
            for row in sent:
                when = row.created_at.astimezone(FACTORY_TZ).strftime("%H:%M")
                out(f"     {when} {row.document_type} [{row.dedupe_key}] status={row.status}")
