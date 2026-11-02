""" "HR edited this day": the latest HR attendance edit of each day, for the calendars (owner 2026-11-02).

Every attendance change HR proposes on the Attendance Edit page is an AttendanceOverrideRequest that the Department Head and
then HR approve (approval_workflow.py, "attendance_correction"). The calendars show a "!" on every day HR edited, with a
tooltip saying what was changed and where the approval stands, and the employee apps colour the days where the change was
applied. Both read `hrEdit` from here:

    hrEdit = null | {
        requestId, status ("waiting_hod" | "waiting_hr" | "applied" | "rejected"), stageLabel,
        from: {label, shifts}, to: {label, shifts}, option, type, typeLabel, reason, comment,
        raisedBy, raisedAt, decidedBy, decidedAt,
    }

The LATEST edit of the day is shown (waiting or decided). An edit HR withdrew by putting the day back to automatic (the
"revert" on the Attendance Edit page) is not an HR edit of the day any more and is left out. Read-only.
"""

from __future__ import annotations

from datetime import date, datetime

from . import approval_workflow as approval
from .attendance_edit import STATUS_LABEL, group_of, hod_of
from .clock import FACTORY_TZ

KEY = "attendance_correction"
REVERTED_COMMENT = "Superseded by revert to automatic"
SUPERSEDED_COMMENT = "Superseded by a newer request"
STATUSES = ("waiting_hod", "waiting_hr", "applied", "rejected")
ON_DUTY_LABEL = "On-Duty marked by HR (attendance edit)"


def _moment(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _iso(value) -> str | None:
    moment = _moment(value)
    return moment.isoformat() if moment else None


def _day(value) -> str:
    moment = _moment(value)
    if moment is None:
        return ""
    if moment.tzinfo is not None:
        moment = moment.astimezone(FACTORY_TZ)
    return moment.strftime("%d %b %Y")


def _shifts(value) -> float | None:
    try:
        return round(float(value), 2) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _status_label(status) -> str:
    return STATUS_LABEL.get(str(status or ""), str(status or "").replace("_", " ").capitalize() or "Not recorded")


def is_withdrawn(req) -> bool:
    """An edit taken back by putting the day back to automatic: a waiting one is closed with REVERTED_COMMENT, an applied one
    is stamped `revertedAt` (growth_views.attendance_day_override, reset)."""
    if req.status == "rejected" and (req.review_comment or "") == REVERTED_COMMENT:
        return True
    return req.status == "approved" and bool((req.requested_values or {}).get("revertedAt"))


def _entry(trail: list[dict], role: str, decision: str = "approved") -> dict | None:
    return next((e for e in reversed(trail) if e.get("role") == role and e.get("decision") == decision), None)


def hr_edit_json(req, hod_name: str | None = None, cfg=None) -> dict:
    """The hrEdit block of one AttendanceOverrideRequest (see the module docstring)."""
    cfg = cfg or approval.get_config(KEY)
    trail = approval.trail_of(KEY, req)
    asked = req.requested_values or {}
    before = req.previous_values or {}
    hod_ok = _entry(trail, approval.HOD)
    decided_by = decided_at = None

    if req.status == "pending":
        waiting = approval.progress(KEY, req, cfg).get("waitingFor") or []
        if approval.HOD in waiting:
            status = "waiting_hod"
            stage = f"Waiting for Department Head ({hod_name})" if hod_name else "Waiting for Department Head"
        else:
            status = "waiting_hr"
            stage = "Waiting for HR"
            if hod_ok:
                stage += f" (Department Head {hod_ok.get('by')} approved on {_day(hod_ok.get('at'))})"
    elif req.status == "approved":
        status = "applied"
        final = _entry(trail, approval.HR) or (trail[-1] if trail else None)
        decided_by = (final or {}).get("by") or req.reviewed_by
        decided_at = (final or {}).get("at") or req.reviewed_at
        names = []
        if hod_ok:
            names.append(f"{hod_ok.get('by')} (Department Head)")
        hr_ok = _entry(trail, approval.HR)
        if hr_ok:
            names.append(f"{hr_ok.get('by')} (HR)")
        stage = "Applied - approved by " + (" and ".join(names) or (decided_by or "HR"))
        if decided_at:
            stage += f" on {_day(decided_at)}"
    else:
        status = "rejected"
        rejected = next((e for e in reversed(trail) if e.get("decision") == "rejected"), None)
        if rejected:
            decided_by = rejected.get("by")
            decided_at = rejected.get("at")
            role = approval.ROLE_LONG.get(rejected.get("role"), "")
            stage = f"Rejected by {decided_by}" + (f" ({role})" if role else "") + f" on {_day(decided_at)}"
            if rejected.get("comment"):
                stage += f": {rejected.get('comment')}"
        elif (req.review_comment or "") == SUPERSEDED_COMMENT:
            decided_at = req.reviewed_at
            stage = "Replaced by a newer HR edit of this day"
        else:
            decided_by = req.reviewed_by
            decided_at = req.reviewed_at
            stage = (
                "Rejected"
                + (f" by {decided_by}" if decided_by else "")
                + (f": {req.review_comment}" if req.review_comment else "")
            )

    to_label = asked.get("typeLabel") or _status_label(asked.get("status"))
    return {
        "requestId": req.id,
        "status": status,
        "stageLabel": stage,
        "from": {"label": _status_label(before.get("status")), "shifts": _shifts(before.get("shiftsEarned"))},
        "to": {"label": to_label, "shifts": _shifts(asked.get("shiftsEarned"))},
        "option": group_of(asked),
        "type": str(asked.get("type") or asked.get("status") or ""),
        "typeLabel": to_label,
        "reason": req.reason or asked.get("reason") or None,
        "comment": req.review_comment or None,
        "raisedBy": req.requested_by or None,
        "raisedAt": _iso(req.created_at),
        "decidedBy": decided_by or None,
        "decidedAt": _iso(decided_at),
    }


def latest_requests(emp, start: date, end: date) -> dict[date, object]:
    """{date: the latest AttendanceOverrideRequest of that day} between start and end (withdrawn edits left out). One
    query."""
    from .models import AttendanceOverrideRequest

    out: dict[date, object] = {}
    for req in AttendanceOverrideRequest.objects.filter(employee=emp, date__range=(start, end)).order_by(
        "date", "-created_at", "-id"
    ):
        if req.date in out or is_withdrawn(req):
            continue
        out[req.date] = req
    return out


def hr_edit_map(emp, start: date, end: date, requests: dict | None = None) -> dict[date, dict]:
    """{date: hrEdit} for the days between start and end that HR edited."""
    requests = latest_requests(emp, start, end) if requests is None else requests
    if not requests:
        return {}
    cfg = approval.get_config(KEY)
    hod = None
    if any(r.status == "pending" for r in requests.values()):
        m = hod_of(emp)
        hod = f"{m.employee.first_name} {m.employee.last_name}".strip() if m is not None else None
    return {d: hr_edit_json(r, hod, cfg) for d, r in requests.items()}


def on_duty_of(req) -> dict | None:
    """The calendars' `onDuty` block for a day an applied HR edit made On-Duty (it counts as worked, like a verified
    On-Duty day), else None."""
    if req is None or req.status != "approved":
        return None
    asked = req.requested_values or {}
    if asked.get("option") != "on_duty":
        return None
    return {"state": "verified", "label": ON_DUTY_LABEL, "destination": asked.get("destination") or ""}
