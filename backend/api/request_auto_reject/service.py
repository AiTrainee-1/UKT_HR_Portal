"""Rejecting a waiting request automatically, the way its own module rejects it, and the run that rejects every due one.

Each kind is rejected by setting the module's own rejected status and stamps exactly as its manual rejection does, and by
running every side effect that rejection runs, EXCEPT WhatsApp (owner 2026-11-24: the first run rejects the whole backlog at
once and must not flood WhatsApp). The employee still gets what a manual rejection gives them on the phone: the same
in-app notice + phone push (push_messages.announce with the same message, variables and dedupe key as the WhatsApp path
hands it: whatsapp_approvals.decision_message, whatsapp_notifications.geo_session_rejection / geo_punch_rejection).

    kind                   module path mirrored (manual rejection)            what happens here besides the stamps
    leave                  leave_request_views.resolve_leave                  -
    permission             leave_views.resolve_permission                     -
    casual_leave           casual_leave_views.resolve_casual_leave            the day's attendance verdict (_write_attendance_for_cl)
    missing_punch          missing_punch_views.resolve_missing_punch          - (a rejection writes no punch)
    on_duty                geo_attendance_views.resolve_on_duty_session       waiting punches voided, geo tracking ended
    on_duty_punch          geo_attendance_views.resolve_on_duty_punch_hr      (called, without its WhatsApp)
    attendance_correction  attendance_edit_views.attendance_override_decision - (a rejection changes no attendance)
    holiday_work           compensation_claims.decide                         after_claim_decided on commit (no-op for a rejection)
    compensation_placement compensation_claims.decide (HR's step)             as holiday_work: nothing credited, the day freed
    birthday_compensation  birthday_compensation_service.decide_use           - (a rejection changes no attendance; frees the 0.50 / 1.00)
    outpass                outpass_request_views.resolve_outpass_request      - (no pass issued)
    request                leave_views.employee_request_action                -
    advance                settlement_views.advance_detail (PUT rejected)     an AdvanceDecision row, as every decision has

Who decided: nobody did, so no Department Head decision is faked and the approval engine's role checks (decide) are not
used. A trail entry is appended with role "hr" (every renderer and LEGACY_ROLE lookup keeps working), decision "rejected",
by "Automatic rejection", "auto": True, the time and the remark; the module's reviewer / approver fields say "Automatic
rejection" (role "hr" where the module stores one).

Attendance: only a Casual Leave rejection writes attendance (the day becomes leave). It never changes a day whose payroll is
finalized (Payroll Done: attendance_edit.lock_refusal): the request is still rejected, the write is skipped, and that is
recorded on the history row.

Safety: each request is rejected in its own transaction, holding a row lock (select_for_update), after checking again that
it is still waiting and still old enough, so a decision made at the same moment wins and nothing is rejected twice. One
failure is logged and does not stop the run. Holds follow naturally: a rejected Casual Leave / attendance-correction proposal
no longer holds Casual Leave balance, a rejected compensation use request no longer holds compensation balance (each balance
counts only waiting / approved rows).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime

from django.db import transaction
from django.utils import timezone

from .. import approval_workflow as approval
from ..clock import ist_today
from ..models import AutoRejectedRequest, Employee, RequestAutoRejectSettings
from . import engine

logger = logging.getLogger(__name__)

AUTO_BY = "Automatic rejection"
HR_ROLE = approval.HR  # "hr" in the trail
HR_LEGACY = approval.LEGACY_ROLE[approval.HR]  # "hr" in approver_role / reviewer_role
FAILURES_KEPT = 20


def settings_row() -> RequestAutoRejectSettings:
    """Read without creating (the row is made by the first save / run)."""
    return RequestAutoRejectSettings.objects.filter(pk=1).first() or RequestAutoRejectSettings()


def day_text(d: date) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


def remark_for(days: int, submitted_at: datetime) -> str:
    """What the employee reads as the reason (the remark of the rejection)."""
    return (
        f"Automatically rejected: no decision within {days} days of being submitted "
        f"(submitted {day_text(engine.submitted_day(submitted_at))})."
    )


@dataclass
class Context:
    days: int
    now: datetime
    remark: str
    trigger: str
    run_by: str = ""
    effects: dict = field(default_factory=dict)
    # On-Duty punches the rejection of their On-Duty request voided (each gets a history row of its own)
    voided_punch_ids: list[int] = field(default_factory=list)

    def trail_entry(self) -> dict:
        entry = {
            "role": HR_ROLE,
            "decision": "rejected",
            "by": AUTO_BY,
            "at": self.now.isoformat(),
            "comment": self.remark,
            "auto": True,
        }
        if self.run_by:
            entry["runBy"] = self.run_by  # the HR user who pressed Run now
        return entry


def _append_trail(key: str, obj, ctx: Context) -> None:
    obj.approval_trail = approval.trail_of(key, obj) + [ctx.trail_entry()]


# ───────────────────────────── telling the employee (phone only) ─────────────────────────────


def _announce(employee, document_type: str, params: dict, dedupe_key: str, module: str, ctx: Context) -> None:
    from .. import push_messages

    made = push_messages.announce(employee, document_type, related_module=module, dedupe_key=dedupe_key, params=params)
    ctx.effects["notified"] = made is not None


def _announce_decision(module: str, obj, ctx: Context) -> None:
    """The "Approval - Rejected" message of whatsapp_approvals, to the phone only (in-app notice + push)."""
    from .. import whatsapp_approvals

    try:
        employee, document_type, params, dedupe_key = whatsapp_approvals.decision_message(
            module, obj, "rejected", approver=AUTO_BY, comment=ctx.remark
        )
    except Exception:  # the manual path swallows a message failure too: it never undoes the decision
        logger.exception("Automatic rejection: could not build the message for %s %s", module, obj.pk)
        ctx.effects["notified"] = False
        return
    _announce(employee, document_type, params, dedupe_key, module, ctx)


# ───────────────────────────── attendance (Casual Leave) ─────────────────────────────


def _write_attendance(emp, day: date, write, ctx: Context) -> None:
    """Run the module's attendance write for a rejection, unless the day's payroll is finalized (then skip it and say
    why). A failed write is logged on the row; the rejection stands (the day keeps what the engine worked out)."""
    from ..attendance_edit import lock_refusal

    refusal = lock_refusal(emp, day)
    if refusal:
        logger.info("Automatic rejection: attendance of %s on %s not changed: %s", emp.employee_code, day, refusal)
        ctx.effects["attendance"] = "skipped"
        ctx.effects["attendanceNote"] = refusal
        return
    try:
        with transaction.atomic():
            write()
        ctx.effects["attendance"] = "written"
    except Exception as exc:
        logger.exception("Automatic rejection: attendance of %s on %s could not be written", emp.employee_code, day)
        ctx.effects["attendance"] = "failed"
        ctx.effects["attendanceNote"] = str(exc)[:300]


# ───────────────────────────── one rejector per kind ─────────────────────────────


def _reject_leave(obj, ctx: Context) -> None:
    """resolve_leave's rejection: the comment, who decided (approved_by / approver_role), status."""
    _append_trail("leave", obj, ctx)
    obj.hr_comment = ctx.remark
    obj.approved_by = AUTO_BY
    obj.approver_role = HR_LEGACY
    obj.status = "rejected"
    obj.save()
    _announce_decision("leave", obj, ctx)


def _reject_permission(obj, ctx: Context) -> None:
    """resolve_permission's rejection (attendance reads the status: a rejected permission protects nothing)."""
    _append_trail("permission", obj, ctx)
    obj.hr_comment = ctx.remark
    obj.approved_by = AUTO_BY
    obj.approver_role = HR_LEGACY
    obj.status = "rejected"
    obj.save()
    _announce_decision("permission", obj, ctx)


def _reject_casual_leave(obj, ctx: Context) -> None:
    """resolve_casual_leave's rejection: reviewer stamps, then the day's attendance verdict (a full day becomes leave; a
    half day / an unworked birthday is recomputed) exactly as the module writes it, unless that payroll is finalized."""
    from ..casual_leave_views import _write_attendance_for_cl

    _append_trail("casual_leave", obj, ctx)
    obj.reviewer_role = HR_LEGACY
    obj.reviewed_by = AUTO_BY
    obj.review_comment = ctx.remark
    obj.reviewed_at = ctx.now
    obj.status = "rejected"
    obj.save()
    _write_attendance(obj.employee, obj.date, lambda: _write_attendance_for_cl(obj, AUTO_BY), ctx)
    _announce_decision("casual_leave", obj, ctx)


def _reject_missing_punch(obj, ctx: Context) -> None:
    """resolve_missing_punch's rejection by HR: the HR stamps; no punch is written."""
    _append_trail("missing_punch", obj, ctx)
    obj.hr_reviewed_by, obj.hr_reviewed_at = AUTO_BY, ctx.now
    obj.hr_review_comment = ctx.remark
    obj.status = "rejected"
    obj.save()
    _announce_decision("missing_punch", obj, ctx)


def _reject_on_duty(obj, ctx: Context) -> None:
    """resolve_on_duty_session's terminal rejection by HR: the HR stamps, every waiting punch voided (they never reached
    attendance, and now never will), geo tracking ended (what was collected is kept), then the On-Duty rejection message."""
    from ..geo_attendance_views import _end_track_safely, _void_session_punches
    from ..models import OnDutyPunchVerification
    from ..whatsapp_notifications import geo_session_rejection

    _append_trail("on_duty", obj, ctx)
    obj.hr_reviewed_by, obj.hr_reviewed_at = AUTO_BY, ctx.now
    obj.hr_review_comment = ctx.remark
    obj.status = "rejected"
    obj.save()
    waiting = list(
        obj.punch_verifications.select_for_update()
        .filter(status=OnDutyPunchVerification.STATUS_PENDING)
        .values_list("id", flat=True)
    )
    voided = _void_session_punches(obj, AUTO_BY, f"{approval.ROLE_PHRASE[approval.HR]} (automatic rejection)")
    _end_track_safely(obj, "rejected")
    ctx.voided_punch_ids = waiting
    ctx.effects["voidedPunches"] = voided
    ctx.effects["trackingEnded"] = True
    document_type, params, dedupe_key = geo_session_rejection(obj, AUTO_BY, "", ctx.remark, voided)
    _announce(obj.employee, document_type, params, dedupe_key, "on_duty", ctx)


def _reject_on_duty_punch(obj, ctx: Context) -> None:
    """HR's rejection of one On-Duty punch (resolve_on_duty_punch_hr itself, without its WhatsApp): the slot stays open."""
    from ..geo_attendance_views import resolve_on_duty_punch_hr
    from ..whatsapp_notifications import geo_punch_rejection

    resolve_on_duty_punch_hr(obj, "rejected", AUTO_BY, ctx.remark, notify=False)
    document_type, params, dedupe_key = geo_punch_rejection(obj, AUTO_BY, ctx.remark)
    _announce(obj.employee, document_type, params, dedupe_key, "on_duty_punch", ctx)


def _reject_attendance_correction(obj, ctx: Context) -> None:
    """attendance_override_decision's rejection: ends the proposal and changes nothing in attendance (a proposed Casual
    Leave / use of the compensation balance stops holding the balance)."""
    _append_trail("attendance_correction", obj, ctx)
    obj.status = "rejected"
    obj.reviewed_by = AUTO_BY
    obj.reviewed_at = ctx.now
    obj.review_comment = ctx.remark
    obj.save()
    _announce_decision("attendance_correction", obj, ctx)


def _reject_holiday_work(obj, ctx: Context) -> None:
    """compensation_claims.decide's rejection: the reviewer stamps; after the commit after_claim_decided runs as there (it
    changes nothing for a rejection). A use request stops holding compensation balance; nothing is credited."""
    from .. import compensation_claims

    _append_trail("holiday_work", obj, ctx)
    obj.status = "rejected"
    obj.reviewed_by = AUTO_BY
    obj.reviewed_at = ctx.now
    obj.review_comment = ctx.remark
    obj.save()
    transaction.on_commit(lambda cid=obj.id: compensation_claims._after_decided(cid))
    _announce_decision("holiday_work", obj, ctx)


def _reject_compensation_placement(obj, ctx: Context) -> None:
    """A compensation day HR placed on a chosen date (2026-11-28): the same claim row and rejection as holiday_work, under
    its own (Department Head, then HR) trail. Nothing is credited or taken; the day and the balance it held are free."""
    from .. import compensation_claims

    _append_trail("compensation_placement", obj, ctx)
    obj.status = "rejected"
    obj.reviewed_by = AUTO_BY
    obj.reviewed_at = ctx.now
    obj.review_comment = ctx.remark
    obj.save()
    transaction.on_commit(lambda cid=obj.id: compensation_claims._after_decided(cid))
    _announce_decision("holiday_work", obj, ctx)


def _reject_birthday_compensation(obj, ctx: Context) -> None:
    """birthday_compensation_service.decide_use's rejection (2026-11-25): HR's stamps (the step a rejection ends), no
    attendance change; the day it held is free again (only waiting / approved uses hold the birthday's 1.00)."""
    _append_trail("birthday_compensation", obj, ctx)
    obj.status = "rejected"
    obj.hr_reviewed_by = AUTO_BY
    obj.hr_reviewed_at = ctx.now
    obj.hr_review_comment = ctx.remark
    obj.save()
    _announce_decision("birthday_compensation", obj, ctx)


def _reject_outpass(obj, ctx: Context) -> None:
    """resolve_outpass_request's rejection: who decided and the comment; no pass is issued."""
    _append_trail("outpass", obj, ctx)
    obj.approver_role = HR_LEGACY
    obj.approved_by = AUTO_BY
    obj.review_comment = ctx.remark
    obj.status = "rejected"
    obj.save()
    _announce_decision("outpass", obj, ctx)


def _reject_request(obj, ctx: Context) -> None:
    """employee_request_action's rejection: HR's notes carry the reason (any notes already there are kept above it)."""
    prior = (obj.hr_notes or "").strip()
    obj.status = "rejected"
    obj.hr_notes = f"{prior}\n\n{ctx.remark}" if prior else ctx.remark
    obj.handled_by = AUTO_BY
    obj.handled_at = ctx.now
    obj.save()
    _announce_decision("request", obj, ctx)


def _reject_advance(obj, ctx: Context) -> None:
    """advance_detail's rejection: the remark, when and by whom, and the AdvanceDecision row every decision gets."""
    from ..models import AdvanceDecision

    requested = obj.requested_amount if obj.requested_amount is not None else obj.amount
    obj.status = "rejected"
    obj.decision_remark = ctx.remark
    obj.decided_at = ctx.now
    obj.approved_by = AUTO_BY
    obj.save()
    AdvanceDecision.objects.create(
        advance=obj,
        action=AdvanceDecision.ACTION_REJECTED,
        requested_amount=requested,
        remark=ctx.remark,
        actor_name=AUTO_BY,
    )
    _announce_decision("advance", obj, ctx)


REJECTORS = {
    "leave": _reject_leave,
    "permission": _reject_permission,
    "casual_leave": _reject_casual_leave,
    "missing_punch": _reject_missing_punch,
    "on_duty": _reject_on_duty,
    "on_duty_punch": _reject_on_duty_punch,
    "attendance_correction": _reject_attendance_correction,
    "holiday_work": _reject_holiday_work,
    "compensation_placement": _reject_compensation_placement,
    "birthday_compensation": _reject_birthday_compensation,
    "outpass": _reject_outpass,
    "request": _reject_request,
    "advance": _reject_advance,
}


# ───────────────────────────── one request, and the run ─────────────────────────────


def _history_row(key: str, obj, ctx: Context, today: date, what: str, summary: str, **extra) -> AutoRejectedRequest:
    emp = obj.employee
    fields = {
        "kind": key,
        "request_id": obj.pk,
        "employee": emp,
        "employee_code": emp.employee_code or "",
        "employee_name": f"{emp.first_name or ''} {emp.last_name or ''}".strip(),
        "branch_id": engine.scope_branch_of(key, obj),
        "what": what,
        "summary": summary,
        "submitted_at": obj.created_at,
        "days_waited": engine.days_waiting(obj.created_at, today),
        "days_setting": ctx.days,
        "remark": ctx.remark,
        "trigger": ctx.trigger,
        "run_by": ctx.run_by,
        "effects": ctx.effects,
    }
    fields.update(extra)
    return AutoRejectedRequest.objects.create(**fields)


def reject_one(
    key: str,
    pk: int,
    *,
    days: int,
    today: date | None = None,
    trigger: str = AutoRejectedRequest.TRIGGER_NIGHTLY,
    run_by: str = "",
    describe: engine.Describer | None = None,
) -> list[AutoRejectedRequest]:
    """Reject request `pk` of kind `key` if it is still waiting and still submitted more than `days` days ago (checked
    under a row lock). Returns the history rows written: the request's own first, then one per On-Duty punch its rejection
    voided (an On-Duty request); [] when there was nothing to do (decided meanwhile, too recent, gone). Raises whatever the
    rejection raised; nothing of it is kept then."""
    if key not in REJECTORS:
        raise KeyError(f"{key} is never rejected automatically")
    s = engine.spec(key)
    today = today or ist_today()
    describe = describe or engine.Describer()
    with transaction.atomic():
        if key in ("holiday_work", "compensation_placement"):
            # employee first, then the claim: the lock order every compensation writer uses (compensation_claims.decide)
            emp_id = s.model.objects.filter(pk=pk).values_list("employee_id", flat=True).first()
            if emp_id is None:
                return []
            Employee.objects.select_for_update().filter(pk=emp_id).first()
        obj = (
            s.model.objects.select_for_update(of=("self",))
            .select_related("employee")
            .filter(pk=pk, **s.extra_filter)
            .first()
        )
        if obj is None or obj.status not in s.waiting or not engine.is_due(obj.created_at, days, today):
            return []
        what, summary = describe(key, obj)
        ctx = Context(
            days=days,
            now=timezone.now(),
            remark=remark_for(days, obj.created_at),
            trigger=trigger,
            run_by=run_by,
        )
        REJECTORS[key](obj, ctx)
        rows = [_history_row(key, obj, ctx, today, what, summary)]
        if ctx.voided_punch_ids:
            from ..models import OnDutyPunchVerification

            for punch in OnDutyPunchVerification.objects.select_related("employee", "session").filter(
                pk__in=ctx.voided_punch_ids
            ):
                punch_what, punch_summary = describe("on_duty_punch", punch)
                rows.append(
                    _history_row(
                        "on_duty_punch",
                        punch,
                        ctx,
                        today,
                        punch_what,
                        punch_summary,
                        remark=punch.hr_review_comment or ctx.remark,
                        effects={"voidedWith": {"kind": key, "id": obj.pk}},
                    )
                )
        return rows


def run(
    *,
    trigger: str = AutoRejectedRequest.TRIGGER_NIGHTLY,
    run_by: str = "",
    branch_id: int | None = None,
    today: date | None = None,
) -> dict:
    """Reject every request due now (the saved number of days), kind by kind (engine.AUTO_KINDS order). `branch_id`: only
    the requests listed under that branch (Run now by a branch login); None = the whole company. Records the result on the
    settings row and returns it."""
    row = RequestAutoRejectSettings.get()
    days = row.days
    today = today or ist_today()
    started = timezone.now()
    describe = engine.Describer()
    by_kind: dict[str, int] = {}
    failures: list[dict] = []
    skipped = attendance_skipped = 0
    done: set[tuple[str, int]] = set()  # rejected in this run (an On-Duty punch voided with its request among them)
    for key in engine.AUTO_KINDS:
        for pk in engine.due_ids(key, days, today, branch_id):
            if (key, pk) in done:
                continue
            try:
                made = reject_one(key, pk, days=days, today=today, trigger=trigger, run_by=run_by, describe=describe)
            except Exception as exc:
                logger.exception("Automatic rejection of %s %s failed", key, pk)
                failures.append({"kind": key, "id": pk, "error": str(exc)[:300]})
                continue
            if not made:
                skipped += 1
                continue
            for history in made:
                done.add((history.kind, history.request_id))
                by_kind[history.kind] = by_kind.get(history.kind, 0) + 1
                if (history.effects or {}).get("attendance") == "skipped":
                    attendance_skipped += 1
    summary = {
        "ran": True,
        "at": started.isoformat(),
        "day": today.isoformat(),
        "days": days,
        "trigger": trigger,
        # "nightly" or the HR user who pressed Run now
        "runBy": run_by or "nightly",
        "branchId": branch_id,
        "rejected": sum(by_kind.values()),
        "byKind": by_kind,
        # decided (or changed) between the list and the lock: left alone
        "skipped": skipped,
        "attendanceSkipped": attendance_skipped,
        "failed": len(failures),
        "failures": failures[:FAILURES_KEPT],
    }
    row.last_run_at = started
    row.last_run_by = run_by
    row.last_run_result = summary
    row.save(update_fields=["last_run_at", "last_run_by", "last_run_result", "updated_at"])
    if summary["rejected"] or failures:
        logger.info("Automatic rejection: %s", {k: summary[k] for k in ("rejected", "byKind", "failed", "runBy")})
    return summary


def nightly() -> dict:
    """The nightly job: does nothing while the switch is off."""
    if not settings_row().enabled:
        return {"ran": False, "reason": "switched off"}
    summary = run(trigger=AutoRejectedRequest.TRIGGER_NIGHTLY)
    _audit(summary)
    return summary


def _audit(summary: dict) -> None:
    """One Activity Logs line for a nightly run that rejected anything (no request behind it: written directly)."""
    if not summary.get("rejected"):
        return
    from ..models import AuditLog

    try:
        AuditLog.objects.create(
            user_type="system",
            user_name=AUTO_BY,
            action="reject",
            module="settings",
            record_description=(
                f"Automatic rejection: {summary['rejected']} waiting request(s) rejected after more than "
                f"{summary['days']} days without a decision"
            ),
            new_values={"byKind": summary.get("byKind"), "failed": summary.get("failed")},
        )
    except Exception:  # an Activity Logs failure never undoes the run
        logger.exception("Could not write the automatic rejection's Activity Logs line")
