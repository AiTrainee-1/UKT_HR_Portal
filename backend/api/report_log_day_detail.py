"""
The Report Log register's day card (owner 2026-11-16): beside every punch of the day, the shift the day was judged
against ("detected shift"), how its shift credit was earned ("earned shift breakdown") and what the attendance engine
detected (late, early out, permissions, compensation ...). Read only: everything comes from the stored day record (what
payroll reads) and, for a production day judged by the shift-table rules, from the same arithmetic that judged it
(production_shift_rules.explain_day).

Staff credit is built in the engine's own order (attendance_final.compute_day_record): Half-Day Detection gives a Full
(1.00) or Half (0.50) day; a first punch after the Late window takes the quarter shift off a Full day; a Penalty Early
Out takes its deduction; leave, Casual Leave and compensation can change it after that. The breakdown lists the first
three as steps and any remaining difference as one adjustment line, so the steps always add up to the stored credit.
"""

from __future__ import annotations

from decimal import Decimal

from . import production_shift_rules as psr

_CENT = Decimal("0.01")

ZONE_TEXT = {
    "on_time": "On time",
    "late": "Late arrival (inside the Late window)",
    "excused": "Late arrival excused by an approved Morning Late-In permission",
    "quarter": "Arrived after the Late window: a quarter shift comes off",
    "second_half": "Arrived after the first-half limit: the morning half was missed",
}

STATUS_TEXT = {
    "present": "Full day",
    "half_shift": "Half day",
    "absent": "Absent",
    "on_leave": "On leave",
    "holiday": "Holiday",
}


def _d(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(_CENT)


def _txt(value: Decimal) -> str:
    return f"{value:.2f}"


def _hhmm(t) -> str | None:
    return t.strftime("%H:%M") if t else None


def detected_shift(emp, d, rec, explained: dict | None) -> dict | None:
    """The shift the day was judged against: the production shift group the rules selected, else the employee's own
    shift template for the date. None when neither exists."""
    if explained is not None:
        return {
            "name": explained["group"],
            "source": "production_rules",
            "start": explained["start"],
            "end": explained["standardOut"],
            "endNextDay": explained["standardOutNextDay"],
            "graceMinutes": explained["graceMinutes"],
        }
    from .shift_engine import _get_shift_for_date

    shift = _get_shift_for_date(emp, d)
    if shift is None or getattr(shift, "start_time", None) is None:
        return None
    start, end = shift.start_time, getattr(shift, "end_time", None)
    return {
        "name": getattr(shift, "name", None) or "Shift",
        "source": "shift",
        "start": _hhmm(start),
        "end": _hhmm(end),
        "endNextDay": bool(end and end <= start),
        "graceMinutes": int(getattr(shift, "grace_period_minutes", 0) or 0),
    }


def _staff_steps(rec, settings) -> list[dict]:
    """The staff credit in the engine's order, plus one adjustment line for whatever came after (see module doc)."""
    total = _d(rec.shifts_earned)
    status = rec.status
    steps: list[dict] = []
    if status == "present":
        running = Decimal("1.00")
        steps.append({"label": "Full day", "shifts": "1.00", "kind": "base"})
    elif status == "half_shift":
        running = Decimal("0.50")
        which = {"second_half": "evening half worked"}.get(rec.arrival_zone or "", "")
        steps.append({"label": f"Half day{f' ({which})' if which else ''}", "shifts": "0.50", "kind": "base"})
    else:
        running = Decimal("0.00")
        steps.append({"label": STATUS_TEXT.get(status, status.title()), "shifts": "0.00", "kind": "base"})
    if status == "present" and (rec.arrival_zone or "") == "quarter":
        q = _d(getattr(settings, "arrival_quarter_deduction", Decimal("0.25")))
        steps.append({"label": "Arrived after the Late window (quarter shift)", "shifts": _txt(-q), "kind": "minus"})
        running -= q
    penalty = _d(getattr(rec, "penalty_deduction", 0))
    if getattr(rec, "penalty_early_out", False) and penalty > 0:
        mins = int(getattr(rec, "early_out_minutes", 0) or 0)
        label = f"Penalty Early Out ({mins} min early)" if mins else "Penalty Early Out"
        steps.append({"label": label, "shifts": _txt(-penalty), "kind": "minus"})
        running -= penalty
    rest = total - running
    if rest != 0:
        why = []
        if getattr(rec, "is_half_day_leave", False):
            why.append("half-day leave")
        if getattr(rec, "compensation_kind", ""):
            why.append("compensation")
        steps.append({
            "label": f"Adjusted ({', '.join(why)})" if why else "Adjusted (leave, Casual Leave or compensation)",
            "shifts": f"{'+' if rest > 0 else ''}{_txt(rest)}",
            "kind": "plus" if rest > 0 else "minus",
        })
    return steps


def _production_steps(explained: dict) -> list[dict]:
    steps = []
    for i, p in enumerate(explained["pairs"], start=1):
        counted = p["countedIn"] != p["in"] or p["countedOut"] != p["out"]
        label = f"{p['in']} – {p['out']}{' (next day)' if p['outNextDay'] else ''}"
        if counted:
            label += f", counted {p['countedIn']} – {p['countedOut']}"
        steps.append({"label": label, "shifts": p["shifts"], "kind": "pair", "pair": i})
    if explained["unpaired"]:
        steps.append({"label": f"{explained['unpaired']} has no pair: not counted", "shifts": "0.00", "kind": "note"})
    shown = sum((Decimal(p["shifts"]) for p in explained["pairs"]), Decimal("0"))
    if len(explained["pairs"]) > 1 and shown != Decimal(explained["pairTotal"]):
        # each pair is shown rounded to 0.01; the day adds them exactly first
        steps.append({
            "label": "The pairs together, before rounding each",
            "shifts": explained["pairTotal"],
            "kind": "note",
        })
    if explained["minimumApplied"]:
        steps.append({
            "label": f"Raised to the minimum credit {explained['minimumCredit']}",
            "shifts": explained["minimumCredit"],
            "kind": "note",
        })
    if Decimal(explained["shifts"]) != Decimal(explained["pairTotal"]) and not explained["minimumApplied"]:
        capped = Decimal(explained["shifts"]) >= Decimal(explained["maxShifts"]) and Decimal(
            explained["pairTotal"]
        ) > Decimal(explained["maxShifts"])
        steps.append({
            "label": f"Capped at the table's top {explained['maxShifts']}"
            if capped
            else f"Rounded to the {explained['roundingStep']} step",
            "shifts": explained["shifts"],
            "kind": "note",
        })
    return steps


def earned_breakdown(rec, settings, explained: dict | None) -> dict:
    total = _d(rec.shifts_earned)
    if rec.source == "manual":
        return {
            "method": "manual",
            "steps": [{"label": "Set by HR", "shifts": _txt(total), "kind": "base"}],
            "total": _txt(total),
            "note": rec.override_note or None,
        }
    if explained is not None:
        note = explained["note"]
        steps = _production_steps(explained)
        if Decimal(explained["shifts"]) != total:
            # the stored day differs from the punches as they are now (a later change not worked out yet)
            steps.append({"label": "Stored for the day (payroll reads this)", "shifts": _txt(total), "kind": "note"})
        return {"method": "production_rules", "steps": steps, "total": _txt(total), "note": note}
    if rec.employee.employment_type == "production":
        return {
            "method": "production_legacy",
            "steps": [{"label": "Worked out by the old production calculation", "shifts": _txt(total), "kind": "base"}],
            "total": _txt(total),
            "note": None,
        }
    return {"method": "staff", "steps": _staff_steps(rec, settings), "total": _txt(total), "note": None}


def detections(rec, explained: dict | None) -> list[dict]:
    """What the engine flagged on the day, each with a short detail. Tones: bad (cost the day or a late mark), warn
    (worth a look), good (excused / topped up), info."""
    out: list[dict] = []

    def add(key, label, detail=None, tone="info"):
        out.append({"key": key, "label": label, "detail": detail, "tone": tone})

    if rec.provisional_until:
        add("provisional", "Day still running", "The evening is judged once the shift is over", "info")
    if rec.source == "manual":
        add("manual", "Set by HR", rec.override_note or None, "info")
    if rec.is_late:
        add("late", "Late", rec.late_reason or None, "bad")
    zone = rec.arrival_zone or ""
    if zone and zone not in ("on_time", "late"):
        add(f"zone_{zone}", ZONE_TEXT.get(zone, zone), None, "good" if zone == "excused" else "bad")
    if rec.early_leave:
        mins = int(rec.early_out_minutes or 0)
        add("early_out", "Early out", f"Left {mins} min early" if mins else None, "warn")
    if getattr(rec, "penalty_early_out", False):
        add("penalty_early_out", "Penalty Early Out", f"−{_txt(_d(rec.penalty_deduction))} shift", "bad")
    if rec.is_half_shift and rec.status == "half_shift":
        add("half_shift", "Half shift", None, "warn")
    if rec.is_half_day_leave:
        add("half_day_leave", "Half-day leave", None, "good")
    if rec.morning_permission_applied:
        add("permission_morning", "Morning Late-In permission", "Approved, inside the monthly limit", "good")
    if rec.evening_permission_applied:
        add("permission_evening", "Evening Early-Out permission", "Approved, inside the monthly limit", "good")
    if rec.morning_permission_excess:
        add("permission_morning_excess", "Morning permission over the limit", "Did not move the start", "warn")
    if rec.evening_permission_excess:
        add("permission_evening_excess", "Evening permission over the limit", "Did not move the end", "warn")
    if rec.middle_permission_today:
        add("permission_middle", "Middle permission", None, "info")
    if rec.compensation_kind:
        add("compensation", "Compensation used", rec.compensation_note or rec.compensation_kind, "good")
    elif rec.is_compensation_day:
        add("compensation_day", "Compensation day", "Late / permission checks were relaxed", "good")
    if rec.ot_extra_minutes:
        add("ot", "Worked past the shift end", f"{rec.ot_extra_minutes} min", "info")
    if explained is not None and explained.get("earlyLeave") and not rec.early_leave:
        add("early_out", "Early out", "Left before the standard out time", "warn")
    return out


def day_detail(emp, d, settings, prod_rules, resolved) -> dict:
    """{shift, earned, detections} of one employee's day. `resolved` is the production shift day's resolved punches
    ([(seconds, log)]) when the shift-table rules judge it, else None."""
    from .attendance_final import compute_day_record
    from .day_progress import progress_fields
    from .models import AttendanceDayRecord

    rec = AttendanceDayRecord.objects.select_related("employee").filter(employee=emp, date=d).first()
    if rec is None:
        rec = compute_day_record(emp, d)
        rec.employee = emp
    explained = None
    if prod_rules is not None and resolved and rec.source != "manual":
        explained = psr.explain_day(prod_rules, d, [secs for secs, _log in resolved], emp.id)
    return {
        "shift": detected_shift(emp, d, rec, explained),
        "earned": earned_breakdown(rec, settings, explained),
        "detections": detections(rec, explained),
        "status": rec.status,
        # TODAY while the shift is still running (day_progress.py): "In progress", no shift credit yet
        **progress_fields(rec),
    }
