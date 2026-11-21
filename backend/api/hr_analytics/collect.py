"""The records behind every Analytics check, per employee.

Each collector returns {employee id: [record, ...]}. A record is what the page lists when HR opens the employee (date,
title, detail, the employee's reason, status, who, when) plus `_spread`: the (day, weight) pairs it counts for, so a 3-day
leave counts 3 and lands in the right weeks and weekdays. Every collector reads its table once for all the employees.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta

from django.db.models import Count, Q
from django.utils import timezone

from .. import approval_workflow as approval
from ..clock import FACTORY_TZ, ist_today
from . import categories as C
from .period import Filters

Records = dict[int, list[dict]]


def _bounds(f: Filters) -> tuple[datetime, datetime]:
    start = datetime.combine(f.start, time.min, tzinfo=FACTORY_TZ)
    return start, datetime.combine(f.end + timedelta(days=1), time.min, tzinfo=FACTORY_TZ)


def _local_day(moment: datetime | None) -> date | None:
    return moment.astimezone(FACTORY_TZ).date() if moment else None


def _hhmm(t: time | None) -> str:
    return t.strftime("%H:%M") if t else ""


def _minutes(t: time | None) -> int | None:
    return t.hour * 60 + t.minute if t else None


def _as_date(value) -> date | None:
    """A date column, or a text column holding YYYY-MM-DD (LeaveRequest keeps its dates as text)."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _moment(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if timezone.is_aware(value) else timezone.make_aware(value)
    try:
        parsed = datetime.fromisoformat(str(value)) if value else None
    except ValueError:
        return None
    if parsed and timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed)
    return parsed


def rec(
    day: date,
    title: str,
    *,
    detail: str | None = None,
    reason: str | None = None,
    status: str | None = None,
    by: str | None = None,
    at=None,
    end: date | None = None,
    spread: list[tuple[date, float]] | None = None,
    count_as: float | None = None,
    **extra,
) -> dict:
    return {
        "date": day,
        "endDate": end,
        "title": title,
        "detail": detail,
        "reason": (reason or "").strip() or None,
        "status": status,
        "by": by or None,
        "at": at,
        "_spread": spread if spread is not None else [(day, 1.0)],
        # counts as this many instead of its days (a run of days off is ONE run, however long)
        "_count": count_as,
        "_extra": extra,
    }


def _add(out: Records, emp_id: int, record: dict) -> None:
    out.setdefault(emp_id, []).append(record)


# ───────────────────────────── shared readings ─────────────────────────────


def approved_leave(f: Filters, ids) -> tuple[dict[int, dict[date, float]], Records]:
    """Approved leave and casual leave inside the period: {emp: {day: weight}} (0.5 for a half day) and their records."""
    from ..models import CasualLeaveRequest, LeaveRequest

    days: dict[int, dict[date, float]] = defaultdict(dict)
    out: Records = {}
    # the dates are YYYY-MM-DD text: compared as text they order like dates
    leaves = LeaveRequest.objects.filter(
        employee_id__in=ids, status="approved", start_date__lte=f.end.isoformat(), end_date__gte=f.start.isoformat()
    ).order_by("start_date")
    for r in leaves:
        first, last = _as_date(r.start_date), _as_date(r.end_date) or _as_date(r.start_date)
        if first is None or last is None:
            continue
        start, end = max(first, f.start), min(last, f.end)
        if start > end:
            continue
        span = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        weight = 0.5 if r.is_half_day else 1.0
        # a leave whose own day count leaves out the Sundays in it counts its working days only
        whole = last - first
        if r.total_days is not None and not r.is_half_day and float(r.total_days) < whole.days + 1:
            span = [d for d in span if d.weekday() != 6]
        spread = [(d, weight) for d in span]
        for d, w in spread:
            days[r.employee_id][d] = max(days[r.employee_id].get(d, 0), w)
        n = sum(w for _d, w in spread)
        kind = (r.type or "leave").replace("_", " ").strip().capitalize()
        title = f"{kind}{'' if kind.lower().endswith('leave') else ' leave'} · {n:g} day{'' if n == 1 else 's'}"
        if r.is_half_day:
            title = f"Half-day {kind.lower()}{'' if kind.lower().endswith('leave') else ' leave'}"
        _add(
            out,
            r.employee_id,
            rec(
                start,
                title,
                end=end if end != start else None,
                reason=r.reason,
                status=r.status,
                by=r.approved_by,
                at=r.created_at,
                spread=spread,
                source="leave",
            ),
        )
    cls = CasualLeaveRequest.objects.filter(employee_id__in=ids, status="approved", date__range=(f.start, f.end))
    for r in cls.order_by("date"):
        weight = 1.0 if (r.portion or "full") == "full" else 0.5
        days[r.employee_id][r.date] = max(days[r.employee_id].get(r.date, 0), weight)
        _add(
            out,
            r.employee_id,
            rec(
                r.date,
                "Casual leave" if weight == 1 else "Casual leave · half day",
                reason=r.reason,
                status=r.status,
                by=r.reviewed_by,
                at=r.created_at,
                spread=[(r.date, weight)],
                source="casual_leave",
            ),
        )
    return days, out


def data_gaps(f: Filters, kind: str) -> set[date]:
    """Days of the period on which (almost) NOBODY of this type (staff / production) has attendance although the day is
    not a holiday for them - fewer than 1 in 10 of the people due that day: the devices' punches did not arrive (not
    synced, device down). Such a day says nothing about anybody, so the absence checks leave it out instead of calling
    everyone absent. Today is never judged."""
    from ..models import AttendanceDayRecord

    rows = (
        AttendanceDayRecord.objects.filter(
            employee__employment_type=kind, employee__status="active", date__range=(f.start, f.end)
        )
        .values("date")
        .annotate(
            worked=Count("id", filter=Q(status__in=("present", "half_shift")) | Q(total_punches__gt=0)),
            off=Count("id", filter=Q(status="holiday")),
            total=Count("id"),
        )
    )
    today = ist_today()
    return {
        r["date"]
        for r in rows
        if r["date"] < today and r["total"] > r["off"] and r["worked"] * 10 < r["total"] - r["off"]
    }


def _day_records(f: Filters, ids, **filters):
    from ..models import AttendanceDayRecord

    return AttendanceDayRecord.objects.filter(employee_id__in=ids, date__range=(f.start, f.end), **filters).order_by(
        "date"
    )


# ───────────────────────────── checks used by both tabs ─────────────────────────────


def late(f: Filters, ids) -> Records:
    out: Records = {}
    rows = _day_records(f, ids, is_late=True).values_list("employee_id", "date", "first_punch", "late_reason")
    for emp_id, day, first, reason in rows:
        title = f"Late · first punch {_hhmm(first)}" if first else "Late"
        # the engine's explanation (deadline, grace) is a detail, not something the employee said
        _add(out, emp_id, rec(day, title, detail=reason, firstPunch=_minutes(first)))
    return out


# ───────────────────────────── staff ─────────────────────────────


def staff_leave(f: Filters, ids) -> Records:
    return approved_leave(f, ids)[1]


def missing_punch(f: Filters, ids) -> Records:
    from ..models import MissingPunchRequest

    out: Records = {}
    seen: set[tuple[int, date]] = set()
    for r in MissingPunchRequest.objects.filter(employee_id__in=ids, date__range=(f.start, f.end)).order_by("date"):
        slot = dict(r.PUNCH_SLOT_CHOICES).get(r.punch_slot) or ("Check-in" if r.punch_type == "IN" else "Check-out")
        seen.add((r.employee_id, r.date))
        _add(
            out,
            r.employee_id,
            rec(
                r.date,
                f"Missing-punch request · {slot} at {_hhmm(r.punch_time)}",
                reason=r.reason,
                status=r.status.replace("pending_hod", "waiting for HOD").replace("pending_hr", "waiting for HR"),
                by=r.hr_reviewed_by or r.hod_reviewed_by,
                at=r.created_at,
            ),
        )
    today = ist_today()
    odd = (
        _day_records(f, ids, total_punches__gt=0)
        .exclude(status="holiday")
        .exclude(date=today)
        .values_list("employee_id", "date", "total_punches", "first_punch")
    )
    for emp_id, day, punches, first in odd:
        if punches % 2 == 0 or (emp_id, day) in seen:
            continue
        _add(
            out,
            emp_id,
            rec(
                day,
                f"Only {punches} punch{'' if punches == 1 else 'es'} recorded",
                detail=f"First punch {_hhmm(first)}" if first else None,
            ),
        )
    for rows in out.values():
        rows.sort(key=lambda r: r["date"])
    return out


def on_duty(f: Filters, ids) -> Records:
    from ..models import OnDutySession

    out: Records = {}
    lo, hi = _bounds(f)
    for s in OnDutySession.objects.filter(employee_id__in=ids, created_at__gte=lo, created_at__lt=hi).order_by(
        "created_at"
    ):
        _add(
            out,
            s.employee_id,
            rec(
                _local_day(s.created_at),
                f"On-Duty · {s.destination}" if s.destination else "On-Duty",
                status=s.status.replace("pending_hod", "waiting for HOD").replace("pending_hr", "waiting for HR"),
                by=s.hr_reviewed_by or s.hod_reviewed_by,
                at=s.created_at,
            ),
        )
    return out


def on_duty_no_punch(f: Filters, ids) -> Records:
    """Approved On-Duty days (active or completed) with fewer than the 4 punches; today's running one is not judged yet."""
    from ..models import OnDutySession

    out: Records = {}
    lo, hi = _bounds(f)
    today = ist_today()
    sessions = (
        OnDutySession.objects.filter(employee_id__in=ids, created_at__gte=lo, created_at__lt=hi)
        .filter(status__in=(OnDutySession.STATUS_ACTIVE, OnDutySession.STATUS_COMPLETED))
        .annotate(punches=Count("punch_verifications", filter=~Q(punch_verifications__status="rejected")))
        .order_by("created_at")
    )
    for s in sessions:
        day = _local_day(s.started_at or s.created_at)
        if s.status == OnDutySession.STATUS_ACTIVE and day == today:
            continue
        if s.punches >= C.ON_DUTY_PUNCHES:
            continue
        _add(
            out,
            s.employee_id,
            rec(
                day,
                f"{s.punches} of {C.ON_DUTY_PUNCHES} punches recorded",
                detail=f"On-Duty at {s.destination}" if s.destination else None,
                status=s.status,
                at=s.created_at,
                punches=s.punches,
            ),
        )
    return out


def absent_on_leave(f: Filters, ids, gaps: set[date] = frozenset()) -> Records:
    leave_days, _records = approved_leave(f, ids)
    out: Records = {}
    rows = _day_records(f, ids, status="absent").values_list("employee_id", "date")
    for emp_id, day in rows:
        if day in gaps:
            continue
        if leave_days.get(emp_id, {}).get(day, 0) >= 1:
            _add(out, emp_id, rec(day, "Marked absent on an approved leave day", detail="Full-day leave was approved"))
    return out


def attendance_edits(f: Filters, ids) -> Records:
    from ..hr_edit_marks import is_withdrawn
    from ..models import AttendanceOverrideRequest

    out: Records = {}
    seen: set[tuple[int, date]] = set()
    edits = AttendanceOverrideRequest.objects.filter(employee_id__in=ids, date__range=(f.start, f.end)).order_by("date")
    for r in edits:
        if is_withdrawn(r):
            continue
        asked = r.requested_values or {}
        before = r.previous_values or {}
        was = (before.get("status") or "-").replace("_", " ")
        proposed = asked.get("typeLabel") or (asked.get("status") or "").replace("_", " ") or "changed"
        seen.add((r.employee_id, r.date))
        _add(
            out,
            r.employee_id,
            rec(
                r.date,
                f"Attendance edit · {was} → {proposed}",
                reason=r.reason,
                status=r.status,
                by=r.requested_by or "HR",
                at=r.created_at,
            ),
        )
    for emp_id, day, by, note in _day_records(f, ids, source="manual").values_list(
        "employee_id", "date", "override_by", "override_note"
    ):
        if (emp_id, day) in seen:
            continue
        _add(out, emp_id, rec(day, "Day set by hand", reason=note, by=by))
    for rows in out.values():
        rows.sort(key=lambda r: r["date"])
    return out


def permissions(f: Filters, ids) -> Records:
    from ..models import EmployeePermission

    out: Records = {}
    labels = getattr(EmployeePermission, "TYPE_LABELS", {})
    for p in EmployeePermission.objects.filter(employee_id__in=ids, date__range=(f.start, f.end)).order_by("date"):
        kind = labels.get(p.type_key, None) if hasattr(p, "type_key") else None
        title = f"Permission · {kind}" if kind else "Permission"
        if p.permission_time:
            title += f" at {_hhmm(p.permission_time)}"
        _add(
            out,
            p.employee_id,
            rec(p.date, title, reason=p.reason, status=p.status, by=p.approved_by, at=p.created_at),
        )
    return out


# ── the Department Head checks ──

# (workflow key, model, the field holding the date the request is FOR, or None = the day it was asked)
HOD_KINDS = (
    ("leave", "LeaveRequest", "start_date"),
    ("permission", "EmployeePermission", "date"),
    ("casual_leave", "CasualLeaveRequest", "date"),
    ("missing_punch", "MissingPunchRequest", "date"),
    ("on_duty", "OnDutySession", None),
    ("outpass", "OutpassRequest", None),
    ("attendance_correction", "AttendanceOverrideRequest", "date"),
    ("holiday_work", "HolidayWorkClaim", "work_date"),
    ("resignation", "ResignationRequest", "last_working_date"),
)


def _hod_steps(f: Filters, ids):
    """Every request submitted in the period that went (or is going) through a Department Head, as
    (key, label, obj, request day, hod entry or None, waiting-for-hod-now, hours with the HOD)."""
    from django.apps import apps

    lo, hi = _bounds(f)
    now = timezone.now()
    for key, model_name, day_field in HOD_KINDS:
        model = apps.get_model("api", model_name)
        qs = model.objects.filter(employee_id__in=ids, created_at__gte=lo, created_at__lt=hi)
        if key == "outpass":
            qs = qs.filter(source="manual")
        try:
            label = approval.definition(key).label
            cfg = approval.get_config(key)
        except Exception:  # noqa: BLE001 - a workflow the HRMS does not know any more is skipped
            continue
        for obj in qs.order_by("created_at"):
            trail = approval.trail_of(key, obj) if approval.adapter(key) else (obj.approval_trail or [])
            start = obj.created_at
            entry = None
            for e in trail:
                if e.get("role") == approval.HOD and e.get("decision") in ("approved", "rejected"):
                    entry = e
                    break
                start = max(start, _moment(e.get("at")) or start)
            waiting = False
            if entry is not None:
                end = _moment(entry.get("at")) or start
            else:
                try:
                    waiting = approval.HOD in (approval.progress(key, obj, cfg).get("waitingFor") or [])
                except Exception:  # noqa: BLE001
                    waiting = False
                if not waiting:
                    continue
                end = now
            hours = max(0.0, (end - start).total_seconds() / 3600) if start else 0.0
            day = _as_date(getattr(obj, day_field)) if day_field else None
            yield key, label, obj, (day or _local_day(obj.created_at)), entry, waiting, hours


def hod_checks(f: Filters, ids) -> tuple[Records, Records, Records]:
    rejected: Records = {}
    waiting_long: Records = {}
    corrections: Records = {}
    for key, label, obj, day, entry, waiting, hours in _hod_steps(f, ids):
        emp = obj.employee_id
        if entry is not None and entry.get("decision") == "rejected":
            _add(
                rejected,
                emp,
                rec(
                    day,
                    f"{label} rejected by the HOD",
                    reason=entry.get("comment"),
                    status="rejected",
                    by=entry.get("by"),
                    at=entry.get("at"),
                    kind=key,
                ),
            )
        if hours > C.HOD_WAIT_HOURS:
            days_text = f"{hours / 24:.1f} days"
            _add(
                waiting_long,
                emp,
                rec(
                    day,
                    f"{label} {'waiting' if waiting else 'waited'} {days_text} with the HOD",
                    status="waiting for HOD" if waiting else (entry or {}).get("decision"),
                    by=(entry or {}).get("by"),
                    at=obj.created_at,
                    kind=key,
                    hours=round(hours, 1),
                ),
            )
        if key == "attendance_correction" and entry is not None:
            _add(
                corrections,
                emp,
                rec(
                    day,
                    f"Attendance correction {entry.get('decision')} by the HOD",
                    reason=entry.get("comment") or getattr(obj, "reason", None),
                    status=entry.get("decision"),
                    by=entry.get("by"),
                    at=entry.get("at"),
                ),
            )
    return rejected, waiting_long, corrections


def hod_view(f: Filters, ids) -> list[dict]:
    """Per Department Head (the employee's head now): what they decided in the period and what waits for them."""
    from ..hod_scope import effective_owner_map
    from ..models import DepartmentManager

    owner = effective_owner_map(ids)
    stats: dict[int, dict] = {}
    for _key, _label, obj, _day, entry, waiting, hours in _hod_steps(f, ids):
        mgr = owner.get(obj.employee_id)
        if mgr is None:
            continue
        s = stats.setdefault(
            mgr, {"decided": 0, "rejected": 0, "hours": [], "waitingNow": 0, "waitingLong": 0, "oldest": 0.0}
        )
        if entry is not None:
            s["decided"] += 1
            s["hours"].append(hours)
            if entry.get("decision") == "rejected":
                s["rejected"] += 1
        elif waiting:
            s["waitingNow"] += 1
            s["oldest"] = max(s["oldest"], hours)
            if hours > C.HOD_WAIT_HOURS:
                s["waitingLong"] += 1
    managers = DepartmentManager.objects.filter(pk__in=stats).select_related("employee__department")
    out = []
    for m in managers:
        s = stats[m.pk]
        emp = m.employee
        out.append(
            {
                "managerId": m.pk,
                "employeeId": emp.id if emp else None,
                "code": emp.employee_code if emp else "",
                "name": f"{emp.first_name} {emp.last_name}".strip() if emp else "Department Head",
                "department": emp.department.name if emp and emp.department_id and emp.department else None,
                "decided": s["decided"],
                "rejected": s["rejected"],
                "rejectionRate": round(s["rejected"] / s["decided"], 2) if s["decided"] else 0.0,
                "avgResponseHours": round(sum(s["hours"]) / len(s["hours"]), 1) if s["hours"] else None,
                "waitingNow": s["waitingNow"],
                "waitingLong": s["waitingLong"],
                "oldestWaitingHours": round(s["oldest"], 1) if s["waitingNow"] else None,
            }
        )
    out.sort(key=lambda h: (-h["waitingLong"], -(h["avgResponseHours"] or 0), h["name"]))
    return out


# ───────────────────────────── production ─────────────────────────────


def _working_days(f: Filters, ids):
    """{emp: [(day, status, first, last)]} of the period, holidays (and Sundays the engine marks holiday) included."""
    days: dict[int, list] = defaultdict(list)
    for emp_id, day, status, first, last in _day_records(f, ids).values_list(
        "employee_id", "date", "status", "first_punch", "last_punch"
    ):
        days[emp_id].append((day, status, first, last))
    return days


def production_leave(f: Filters, ids, gaps: set[date] = frozenset()) -> Records:
    leave_days, out = approved_leave(f, ids)
    today = ist_today()
    for emp_id, rows in _working_days(f, ids).items():
        for day, status, _first, _last in rows:
            # Sunday is the weekly off of production (the engine leaves it "absent" when nobody came in to work)
            if (
                status != "absent"
                or day.weekday() == 6
                or day >= today
                or day in gaps
                or leave_days.get(emp_id, {}).get(day)
            ):
                continue
            _add(
                out, emp_id, rec(day, "Absent · no attendance", detail="A working day with no punches", source="absent")
            )
    for rows in out.values():
        rows.sort(key=lambda r: r["date"])
    return out


def continuous_leave(f: Filters, ids, gaps: set[date] = frozenset()) -> Records:
    """Runs of CONTINUOUS_DAYS+ working days off in a row (absent or full-day approved leave); holidays neither count
    nor break a run, a day worked (or a day with no record, or a day whose punches never arrived) ends it. A run counts
    as ONE, however long."""
    leave_days, _records = approved_leave(f, ids)
    today = ist_today()
    out: Records = {}
    for emp_id, rows in _working_days(f, ids).items():
        run: list[date] = []
        last_day: date | None = None

        def close(run=run, emp_id=emp_id):
            if len(run) >= C.CONTINUOUS_DAYS:
                _add(
                    out,
                    emp_id,
                    rec(
                        run[0],
                        f"Off {len(run)} working days in a row",
                        end=run[-1],
                        detail=", ".join(f"{d.day} {d:%b}" for d in run),
                        spread=[(d, 1.0) for d in run],
                        count_as=1,
                        days=len(run),
                    ),
                )
            run.clear()

        for day, status, _first, _last in rows:
            if day >= today:
                break
            if last_day is not None and (day - last_day).days > 1:
                close()  # a gap with no attendance record ends the run
            last_day = day
            if day in gaps:
                close()
                continue
            if status == "holiday" or day.weekday() == 6:  # a holiday or the weekly off neither counts nor breaks it
                continue
            off = status == "absent" or leave_days.get(emp_id, {}).get(day, 0) >= 1
            if off:
                run.append(day)
            else:
                close()
        close()
    return out


def _night_minutes(first: time | None, last: time | None) -> int:
    """Minutes of first..last (past midnight when last is earlier) inside 22:00-06:00."""
    a, b = _minutes(first), _minutes(last)
    if a is None or b is None:
        return 0
    if b <= a:
        b += 24 * 60
    total = 0
    for lo, hi in ((0, C.NIGHT_END_MIN), (C.NIGHT_START_MIN, 24 * 60 + C.NIGHT_END_MIN), (48 * 60 - 120, 48 * 60)):
        total += max(0, min(b, hi) - max(a, lo))
    return total


def night_work(f: Filters, ids) -> Records:
    out: Records = {}
    for emp_id, rows in _working_days(f, ids).items():
        for day, _status, first, last in rows:
            minutes = _night_minutes(first, last)
            if minutes < C.NIGHT_MINUTES:
                continue
            crossed = _minutes(last) is not None and _minutes(first) is not None and _minutes(last) <= _minutes(first)
            _add(
                out,
                emp_id,
                rec(
                    day,
                    f"Night work · {_hhmm(first)} to {_hhmm(last)}{' (next day)' if crossed else ''}",
                    detail=f"{minutes / 60:.1f} h between 22:00 and 06:00",
                    nightMinutes=minutes,
                ),
            )
    return out


# ───────────────────────────── the tabs ─────────────────────────────


def collect(kind: str, f: Filters, ids, keys=None) -> dict[str, Records]:
    """{category key: {employee id: [records]}} for the tab (only `keys` when given)."""
    ids = list(ids)
    wanted = set(keys) if keys else {c.key for c in C.categories(kind)}
    out: dict[str, Records] = {}
    gaps = data_gaps(f, kind)
    if kind == "staff":
        simple = {
            "leave": staff_leave,
            "late": late,
            "missing_punch": missing_punch,
            "on_duty": on_duty,
            "on_duty_no_punch": on_duty_no_punch,
            "absent_on_leave": absent_on_leave,
            "attendance_edits": attendance_edits,
            "permissions": permissions,
        }
        for key, fn in simple.items():
            if key in wanted:
                out[key] = fn(f, ids, gaps) if key == "absent_on_leave" else fn(f, ids)
        if wanted & {"hod_rejected", "hod_waiting", "hod_corrections"}:
            rejected, waiting, corrections = hod_checks(f, ids)
            out.update(
                {
                    k: v
                    for k, v in (("hod_rejected", rejected), ("hod_waiting", waiting), ("hod_corrections", corrections))
                    if k in wanted
                }
            )
        return out
    late_rows = late(f, ids) if wanted & {"late", "late_details"} else {}
    fns = {"leave": production_leave, "night_work": night_work, "continuous_leave": continuous_leave}
    for key, fn in fns.items():
        if key in wanted:
            out[key] = fn(f, ids, gaps) if key in ("leave", "continuous_leave") else fn(f, ids)
    if "late" in wanted:
        out["late"] = late_rows
    if "late_details" in wanted:
        out["late_details"] = late_rows
    return out


# ───────────────────────────── counting, patterns, JSON ─────────────────────────────

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _weight(r: dict) -> float:
    return r["_count"] if r.get("_count") is not None else sum(w for _d, w in r["_spread"])


def count(records: list[dict]) -> float:
    total = sum(_weight(r) for r in records)
    return round(total, 1) if total % 1 else int(total)


def _longest_streak(days: list[date]) -> int:
    """Longest run of consecutive days; a Sunday in between does not break it (Sat -> Mon is consecutive)."""
    best = run = 0
    prev: date | None = None
    for d in sorted(set(days)):
        gap = (d - prev).days if prev else None
        if prev and (gap == 1 or (gap == 2 and (prev + timedelta(days=1)).weekday() == 6)):
            run += 1
        else:
            run = 1
        best = max(best, run)
        prev = d
    return best


def pattern(key: str, records: list[dict]) -> dict:
    days = [d for r in records for d, _w in r["_spread"]]
    by_weekday = {w: 0 for w in WEEKDAYS}
    for d in days:
        by_weekday[WEEKDAYS[d.weekday()]] += 1
    out: dict = {
        "byWeekday": by_weekday,
        "longestStreak": _longest_streak(days),
        "lastDate": max(days).isoformat() if days else None,
        "note": None,
    }
    if len(days) >= 3:
        top, n = max(by_weekday.items(), key=lambda kv: kv[1])
        if n / len(days) >= 0.4:
            out["note"] = (
                f"Mostly on {dict(zip(WEEKDAYS, ('Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays')))[top]}"
            )
    if key in ("late", "late_details"):
        firsts = [r["_extra"].get("firstPunch") for r in records if r["_extra"].get("firstPunch") is not None]
        if firsts:
            avg = round(sum(firsts) / len(firsts))
            out["avgFirstPunch"] = f"{avg // 60:02d}:{avg % 60:02d}"
            out["latestFirstPunch"] = f"{max(firsts) // 60:02d}:{max(firsts) % 60:02d}"
            out["earliestFirstPunch"] = f"{min(firsts) // 60:02d}:{min(firsts) % 60:02d}"
    if key == "night_work":
        out["nightHours"] = round(sum(r["_extra"].get("nightMinutes", 0) for r in records) / 60, 1)
    if key == "leave":
        approved = sum(w for r in records if r["_extra"].get("source") != "absent" for _d, w in r["_spread"])
        absent = sum(w for r in records if r["_extra"].get("source") == "absent" for _d, w in r["_spread"])
        out["approvedLeaveDays"] = approved
        out["absentDays"] = absent
    if key == "continuous_leave":
        out["longestRunDays"] = max((r["_extra"].get("days", 0) for r in records), default=0)
    if key == "hod_waiting":
        out["longestWaitHours"] = max((r["_extra"].get("hours", 0) for r in records), default=0)
    return out


def record_json(r: dict, category: str | None = None) -> dict:
    at = r.get("at")
    out = {
        "date": r["date"].isoformat() if r.get("date") else None,
        "endDate": r["endDate"].isoformat() if r.get("endDate") else None,
        "title": r["title"],
        "detail": r.get("detail"),
        "reason": r.get("reason"),
        "status": r.get("status"),
        "by": r.get("by"),
        "at": at.isoformat() if hasattr(at, "isoformat") else at,
    }
    if category:
        out["category"] = category
    return out


def weekly(f: Filters, by_category: dict[str, Records]) -> list[dict]:
    """Per week (Monday to Sunday) of the period, each check's count."""
    first = f.start - timedelta(days=f.start.weekday())
    weeks = []
    d = first
    while d <= f.end:
        weeks.append({"weekStart": d, "weekEnd": d + timedelta(days=6), "counts": defaultdict(float)})
        d += timedelta(days=7)
    for key, per_emp in by_category.items():
        for records in per_emp.values():
            for r in records:
                pairs = [(r["date"], r["_count"])] if r.get("_count") is not None else r["_spread"]
                for day, w in pairs:
                    if f.start <= day <= f.end:
                        weeks[(day - first).days // 7]["counts"][key] += w
    return [
        {
            "weekStart": w["weekStart"].isoformat(),
            "weekEnd": w["weekEnd"].isoformat(),
            "counts": {k: (round(v, 1) if v % 1 else int(v)) for k, v in w["counts"].items()},
        }
        for w in weeks
    ]
