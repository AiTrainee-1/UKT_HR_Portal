"""Investigation decisions: Mark inactive, Keep active, Make active again, and the nightly Auto Trigger.

Each one is recorded on EmployeeInvestigation with the absence it is about (spell_start, days away, last attended day) and
the reason, and in the Activity Logs. Marking inactive only changes Employee.status (the same switch as the Active /
Inactive toggle on the Employees page); nothing else about the employee changes.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from ..clock import ist_today
from ..models import Employee, EmployeeInvestigation, InvestigationSettings
from . import engine

logger = logging.getLogger(__name__)

REASON_MIN = 3
REASON_MAX = 500
AUTO_BY = "Auto Trigger"


class Refused(Exception):
    pass


def settings_row() -> InvestigationSettings:
    """Read without creating (the row is made by the first save / run)."""
    return InvestigationSettings.objects.filter(pk=1).first() or InvestigationSettings()


def clean_reason(raw) -> str:
    reason = str(raw or "").strip()
    if not (REASON_MIN <= len(reason) <= REASON_MAX):
        raise Refused(f"Write a reason of {REASON_MIN} to {REASON_MAX} characters: it is kept with the decision.")
    return reason


def _record(emp: Employee, spell: engine.Spell, action: str, reason: str, by: str, bucket: str, **details):
    return EmployeeInvestigation.objects.create(
        employee=emp,
        action=action,
        spell_start=spell.start,
        last_attended=spell.last_attended,
        absent_days=spell.absent_days,
        calendar_days=spell.calendar_days,
        bucket=bucket,
        reason=reason,
        by=by,
        details={
            "gapDays": len(spell.gap_days),
            "leaveDays": spell.leave_days,
            "workingDays": spell.working_days,
            "coveredByLeave": spell.covered_by_leave,
            "neverAttended": spell.never_attended,
            **details,
        },
    )


def _who(emp: Employee) -> dict:
    return {
        "employeeId": emp.id,
        "employeeCode": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}".strip(),
    }


def inactivate(emps, reason: str, by: str, bucket: str) -> tuple[list[dict], list[dict]]:
    """Mark inactive from the 15 / 30 Days lists. Returns (done, refused)."""
    spells = engine.spells(emps)
    done, refused = [], []
    for emp in emps:
        if (emp.status or "").lower() != "active":
            refused.append({**_who(emp), "reason": "Already inactive."})
            continue
        spell = spells[emp.id]
        with transaction.atomic():
            if not Employee.objects.filter(pk=emp.pk, status="active").update(status="inactive"):
                refused.append({**_who(emp), "reason": "Changed by someone else just now: refresh."})
                continue
            _record(emp, spell, EmployeeInvestigation.ACTION_INACTIVATED, reason, by, bucket)
        done.append({**_who(emp), "absentDays": spell.absent_days})
    return done, refused


def keep_active(emps, reason: str, by: str, bucket: str) -> tuple[list[dict], list[dict]]:
    """Keep active for this absence: the Auto Trigger leaves them alone until they attend again."""
    spells = engine.spells(emps)
    done, refused = [], []
    for emp in emps:
        spell = spells[emp.id]
        if (emp.status or "").lower() != "active":
            refused.append({**_who(emp), "reason": "Inactive: use Make active again instead."})
            continue
        if spell.start is None or spell.calendar_days <= 0:
            refused.append({**_who(emp), "reason": "Not away at the moment: nothing to keep."})
            continue
        _record(emp, spell, EmployeeInvestigation.ACTION_KEPT, reason, by, bucket)
        done.append({**_who(emp), "absentDays": spell.absent_days})
    return done, refused


def reactivate(emps, reason: str, by: str) -> tuple[list[dict], list[dict]]:
    """Make active again (e.g. an Auto Trigger decision HR does not agree with). The decision also keeps them active for
    the absence that is still running, so the next night's run does not inactivate them again."""
    spells = engine.spells(emps)
    done, refused = [], []
    for emp in emps:
        if (emp.status or "").lower() == "active":
            refused.append({**_who(emp), "reason": "Already active."})
            continue
        spell = spells[emp.id]
        with transaction.atomic():
            if not Employee.objects.filter(pk=emp.pk).exclude(status="active").update(status="active"):
                refused.append({**_who(emp), "reason": "Changed by someone else just now: refresh."})
                continue
            _record(emp, spell, EmployeeInvestigation.ACTION_REACTIVATED, reason, by, "auto")
        done.append({**_who(emp), "absentDays": spell.absent_days})
    return done, refused


def due_tonight(emps=None) -> list[tuple[Employee, engine.Spell]]:
    """The active employees the next Auto Trigger run would inactivate (all of them company-wide by default)."""
    days = settings_row().auto_days
    if emps is None:
        emps = Employee.objects.filter(status="active").only("id", "branch_id", "join_date", "status")
    emps = list(emps)
    spells = engine.spells(emps)
    latest = engine.decisions([e.id for e in emps if spells[e.id].absent_days > days])
    out = []
    for emp in emps:
        spell = spells[emp.id]
        if (emp.status or "").lower() != "active":
            continue
        due, _why = engine.auto_due(spell, latest.get(emp.id), days)
        if due:
            out.append((emp, spell))
    return out


def auto_run(force: bool = False, run_by: str | None = None) -> dict:
    """The Auto Trigger: inactivate everyone due. The nightly run does nothing while switched off; `force` (Run now on the
    Auto Trigger tab, or a test) runs whatever the switch says. `run_by`: the HR user who pressed Run now (recorded on
    every decision and in the Activity Logs; None = the nightly run)."""
    settings = InvestigationSettings.get()
    if not settings.auto_enabled and not force:
        return {"ran": False, "reason": "switched off"}
    by = f"{AUTO_BY} (Run now by {run_by})" if run_by else AUTO_BY
    started = timezone.now()
    inactivated = []
    for emp, spell in due_tonight():
        reason = (
            f"Away {spell.absent_days} days in a row (last attended "
            f"{spell.last_attended.strftime('%d %b %Y') if spell.last_attended else 'never'}): more than "
            f"{settings.auto_days} days, not kept active, not approved leave."
        )
        with transaction.atomic():
            if not Employee.objects.filter(pk=emp.pk, status="active").update(status="inactive"):
                continue
            _record(emp, spell, EmployeeInvestigation.ACTION_AUTO, reason, by, "auto")
        inactivated.append(emp.id)
    summary = {
        "ran": True,
        "at": started.isoformat(),
        "day": ist_today().isoformat(),
        "inactivated": len(inactivated),
        "employeeIds": inactivated[:200],
        # "nightly" or the HR user who pressed Run now
        "runBy": run_by or "nightly",
    }
    settings.last_run_at, settings.last_run_summary = started, summary
    settings.save(update_fields=["last_run_at", "last_run_summary", "updated_at"])
    if inactivated:
        logger.info("Investigation Auto Trigger inactivated %s employee(s)", len(inactivated))
    _audit(summary, settings.auto_days, by)
    return summary


def _audit(summary: dict, days: int, by: str = AUTO_BY) -> None:
    """One Activity Logs line per run that changed anything (no request: written directly)."""
    if not summary.get("inactivated"):
        return
    from ..models import AuditLog

    try:
        AuditLog.objects.create(
            user_type="system",
            user_name=by,
            action="update",
            module="employees",
            record_description=(
                f"Investigation Auto Trigger: {summary['inactivated']} employee(s) marked inactive after more than "
                f"{days} days away"
            ),
            new_values={"employeeIds": summary.get("employeeIds")},
        )
    except Exception:  # an Activity Logs failure never undoes the run
        logger.exception("Could not write the Auto Trigger's Activity Logs line")
