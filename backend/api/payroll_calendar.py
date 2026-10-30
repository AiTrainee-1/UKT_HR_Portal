"""What the attendance calendar on the payroll details page needs beyond the day-by-day breakdown a payroll stores.

A payroll stores what each WORKING day was counted as (present, absent, half ...). The calendar also has to tell apart, for the
whole period, the things that breakdown cannot say:

    holidayName       the declared holiday's own name (a holiday day used to read blank)
    casualLeave       an approved Casual Leave day (it is stored as an ordinary Present day)
    isLate/isEarlyOut the two arrival / departure flags, separately (Late In and Early Out have their own colours)
    compensationType  "compensation" | "sunday_compensation" | "ot_compensation": the compensation behind the day
    onDuty            where an On-Duty request stands for the day: it only counts once HR approved the request AND the
                      punches are there (see ON_DUTY_STATES)
    offDays           the days the payroll does not list (Sundays, holidays, a Saturday off) with their name, and the real
                      attendance when somebody worked one: a worked Sunday shows what was worked, not "holiday"

Nothing here touches a payroll: no payroll, salary slip or figure is computed or written. `live=True` (the Sync button of the
card) re-reads each listed day from the attendance engine as it stands NOW, so an approval HR or a Department Head gave after the
payroll was generated shows up; the engine refreshes its own day verdicts the way every attendance page does, and the payroll's
figures stay exactly as generated until it is generated again.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from django.utils import timezone

from .attendance_final import compute_range_records
from .clock import FACTORY_TZ, ist_today
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    CasualLeaveRequest,
    Holiday,
    HolidayWorkClaim,
    OnDutyPunchVerification,
    OnDutySession,
    OvertimeRecord,
)

# Where an On-Duty request stands on a day. Only "verified" may carry the day as worked.
ON_DUTY_STATES = {
    "verified": "On-Duty approved and punched",
    "punches_pending": "On-Duty approved; punches await HR",
    "no_punches": "On-Duty approved; no punches yet",
    "pending": "On-Duty request awaiting approval",
    "rejected": "On-Duty request rejected",
}

_ON_DUTY_PUNCH_SOURCE = "on_duty:approved"
_COMPENSATION_NOTE_TYPES = (
    ("sunday compensation", "sunday_compensation"),
    ("ot compensation", "ot_compensation"),
    ("compensation", "compensation"),
)


def _ist_day(moment: datetime) -> date:
    return moment.astimezone(FACTORY_TZ).date()


def _each_day(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def _status_of(rec_status: str) -> str:
    """The payroll's own day vocabulary for an attendance record's status (see payroll_views._generate_staff_payroll)."""
    return {
        "present": "present",
        "half_shift": "present",
        "on_leave": "unpaid_leave",
        "holiday": "holiday",
    }.get(rec_status, "absent")


def _clock(value) -> str | None:
    return value.strftime("%H:%M") if value else None


def _compensation_type(rec_kind: str, note: str, d: date, claim_dates: set, ot_dates: set) -> str | None:
    text = (note or "").strip().lower()
    for prefix, kind in _COMPENSATION_NOTE_TYPES:
        if text.startswith(prefix):
            return kind
    if d in claim_dates:
        return "sunday_compensation"
    if d in ot_dates or rec_kind == "ot_allowance":
        return "ot_compensation"
    if rec_kind:
        return "compensation"
    return None


def _on_duty_states(employee_id: int, start: date, end: date) -> dict[date, dict]:
    """{date: {state, label, destination}} for every day an On-Duty request touches. Approved means HR gave the final
    approval (active / completed); the day only counts as worked once an On-Duty punch of the day was approved too."""
    today = ist_today()
    sessions = list(
        OnDutySession.objects.filter(employee_id=employee_id).values(
            "id", "status", "destination", "created_at", "started_at", "employee_ended_at", "completed_at"
        )
    )
    punched = set(
        AttendanceLog.objects.filter(
            employee_id=employee_id, date__range=(start, end), source=_ON_DUTY_PUNCH_SOURCE
        ).values_list("date", flat=True)
    )
    awaiting = set(
        OnDutyPunchVerification.objects.filter(
            employee_id=employee_id,
            punch_date__range=(start, end),
            status=OnDutyPunchVerification.STATUS_PENDING,
        ).values_list("punch_date", flat=True)
    )
    out: dict[date, dict] = {}

    def put(day: date, state: str, destination: str) -> None:
        # the most advanced state of the day wins: verified > punches_pending > no_punches > pending > rejected
        rank = list(ON_DUTY_STATES)
        if day in out and rank.index(out[day]["state"]) <= rank.index(state):
            return
        out[day] = {"state": state, "label": ON_DUTY_STATES[state], "destination": destination}

    for s in sessions:
        if s["status"] in (OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED) and s["started_at"]:
            first = _ist_day(s["started_at"])
            ended = s["employee_ended_at"] or s["completed_at"]
            last = _ist_day(ended) if ended else (today if s["status"] == OnDutySession.STATUS_ACTIVE else first)
            for day in _each_day(max(first, start), min(max(last, first), end)):
                if day in punched:
                    put(day, "verified", s["destination"])
                elif day in awaiting:
                    put(day, "punches_pending", s["destination"])
                else:
                    put(day, "no_punches", s["destination"])
        elif s["status"] in (OnDutySession.STATUS_PENDING_HOD, OnDutySession.STATUS_PENDING_HR):
            day = _ist_day(s["created_at"])
            if start <= day <= end:
                put(day, "pending", s["destination"])
        elif s["status"] == OnDutySession.STATUS_REJECTED:
            day = _ist_day(s["created_at"])
            if start <= day <= end:
                put(day, "rejected", s["destination"])
    return out


def _holidays(start: date, end: date) -> dict[date, tuple[str, str | None]]:
    found: dict[date, tuple[str, str | None]] = {}
    for h in Holiday.objects.filter(date__range=(start, end)).order_by("id"):
        found.setdefault(h.date, (h.name, getattr(h, "holiday_type", None)))
    return found


def _view_of_record(rec) -> dict:
    """The attendance facts of one record (a stored AttendanceDayRecord or one the engine just computed)."""
    status = _status_of(rec.status)
    shifts = float(rec.shifts_earned or 0)
    return {
        "status": status,
        "firstIn": _clock(rec.first_punch),
        "lastOut": _clock(rec.last_punch),
        "shifts": shifts if status == "present" else 0.0,
        "isLate": bool(rec.is_late),
        "isEarlyOut": bool(rec.early_leave),
        "compensationKind": rec.compensation_kind or None,
        "compensationMinutes": int(rec.compensation_minutes or 0),
        "compensationNote": rec.compensation_note or None,
        "note": rec.late_reason or None,
    }


def calendar_extras(
    emp, start: date, end: date, days: list[dict], live: bool = False
) -> tuple[list[dict], list[dict], dict]:
    """(days, offDays, sync): `days` are the payroll's listed days with the extra keys (and, when `live`, re-read from the
    attendance engine); `offDays` the other days of the period; `sync` says whether the card is live and how many days
    differ from what the payroll counted."""
    today = ist_today()
    holidays = _holidays(start, end)
    casual = set(
        CasualLeaveRequest.objects.filter(
            employee=emp, date__range=(start, end), status=CasualLeaveRequest.STATUS_APPROVED
        ).values_list("date", flat=True)
    )
    claim_dates = set(
        HolidayWorkClaim.objects.filter(
            employee=emp, work_date__range=(start, end), status=HolidayWorkClaim.STATUS_APPROVED
        ).values_list("work_date", flat=True)
    )
    ot_dates = set(
        OvertimeRecord.objects.filter(employee=emp, date__range=(start, end), status=OvertimeRecord.STATUS_ANNOUNCED)
        .exclude(ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE)
        .values_list("date", flat=True)
    )
    on_duty = _on_duty_states(emp.id, start, end)

    if live:
        last = min(end, today)
        records = {r.date: r for r in compute_range_records(emp, start, last)} if start <= last else {}
    else:
        records = {r.date: r for r in AttendanceDayRecord.objects.filter(employee=emp, date__range=(start, end))}

    listed = {str(d.get("date")) for d in days}
    differs = 0
    production = emp.employment_type == "production"

    def extras(d: date, base: dict) -> dict:
        # a payroll generated before a compensation was approved does not carry it: the attendance record does
        rec = records.get(d)
        kind = base.get("compensationKind") or (rec.compensation_kind if rec is not None else "") or ""
        note = base.get("compensationNote") or (rec.compensation_note if rec is not None else "") or ""
        return {
            "isSunday": d.weekday() == 6 and not production,
            "holidayName": holidays[d][0] if d in holidays else None,
            "casualLeave": d in casual,
            "compensationType": _compensation_type(kind, note, d, claim_dates, ot_dates),
            "onDuty": on_duty.get(d),
        }

    for day in days:
        d = date.fromisoformat(str(day["date"])[:10])
        rec = records.get(d)
        before = (day.get("status"), day.get("shifts"))
        if live and rec is not None:
            fresh = _view_of_record(rec)
            # a day payroll counted as worked or absent follows the engine now; the payroll's own pay vocabulary is kept
            # (a manual Holiday override is paid leave in a payroll but still a holiday on the calendar)
            day.update(
                status=fresh["status"],
                firstIn=fresh["firstIn"],
                lastOut=fresh["lastOut"],
                shifts=fresh["shifts"],
                compensationKind=fresh["compensationKind"],
                compensationMinutes=fresh["compensationMinutes"],
                compensationNote=fresh["compensationNote"],
            )
            if fresh["note"]:
                day["note"] = fresh["note"]
            if (day["status"], day["shifts"]) != before:
                differs += 1
            day["isLate"] = fresh["isLate"]
            day["isEarlyOut"] = fresh["isEarlyOut"]
        elif rec is not None:
            day["isLate"] = bool(rec.is_late)
            day["isEarlyOut"] = bool(rec.early_leave)
        else:
            day["isLate"] = "late_in" in (day.get("flags") or [])
            day["isEarlyOut"] = "early_out" in (day.get("flags") or [])
        day.update(extras(d, day))

    off_days: list[dict] = []
    for d in _each_day(start, end):
        if d.isoformat() in listed:
            continue
        rec = records.get(d)
        worked = rec is not None and rec.status in ("present", "half_shift")
        if d in holidays:
            kind, name = "holiday", holidays[d][0]
        elif d.weekday() == 6:
            kind, name = "weekly_off", None
        else:
            kind, name = "off", None
        entry = {"date": d.isoformat(), "kind": kind, "name": name, "attendance": None}
        if worked:
            view = _view_of_record(rec)
            entry["attendance"] = {
                "date": d.isoformat(),
                "day": d.strftime("%A"),
                "flags": [],
                "marks": [],
                "note": view["note"],
                **{k: view[k] for k in ("status", "firstIn", "lastOut", "shifts", "isLate", "isEarlyOut")},
                "compensationKind": view["compensationKind"],
                "compensationMinutes": view["compensationMinutes"],
                "compensationNote": view["compensationNote"],
                "isSunday": d.weekday() == 6,
                "holidayName": name,
                "casualLeave": d in casual,
                "compensationType": _compensation_type(
                    view["compensationKind"] or "", view["compensationNote"] or "", d, claim_dates, ot_dates
                )
                or ("sunday_compensation" if d in claim_dates else None),
                "onDuty": on_duty.get(d),
                "workedOffDay": True,
            }
        elif d in on_duty:
            entry["onDuty"] = on_duty[d]
        off_days.append(entry)

    sync = {
        "live": live,
        "syncedAt": timezone.now().isoformat() if live else None,
        "changedDays": differs if live else 0,
    }
    return days, off_days, sync
