"""
Central approval workflow: who decides each kind of request, in what order, and whether the workflow is on.

Until now every approval (leave, permission, missing punch, on-duty, resignation ...) had its own hard-coded
HOD / HR endpoints and status names. This module is the ONE place that says how each pipeline runs, so a change made
in User Management -> Approval Workflow Control reaches every screen and every endpoint that uses the workflow.

The model
---------
A pipeline is 1 or 2 ordered STEPS (HR and the Department Head - HOD - are the only approver roles, and a role can
sit in only one step). A step names who is responsible for it and whether it is MANDATORY:

    [HOD or HR]            one step, whoever acts first (how leave, permission, casual leave and outpass have always run)
    [HOD, HR]              the HOD decides first, then HR (missing punch, resignation)
    [HR, HOD]              HR first, then the HOD
    [HOD] / [HR]           a single responsible role

A request always sits at its CURRENT step: the first one nobody has approved yet. The role(s) of that step can decide
it. A role of a LATER step may decide it early only when every step it would jump over is not mandatory (that is how
HR can approve an on-duty request without waiting for a HOD who has not acted); a mandatory step cannot be skipped. A
rejection by anyone who may decide is final. Approving the last step approves the request and runs that module's side
effects (creating the punch, deducting the balance, closing the employee ...) exactly once, whoever the last role was.

Every step's approval is kept in `approval_trail` on the request, so the progress survives a pipeline change: a request
follows the pipeline in force NOW from wherever it has got to. Switching a workflow OFF only stops NEW requests being
submitted; requests already waiting can still be decided.

Nothing changes until HR edits a pipeline: with no configuration the DEFAULT_STEPS below reproduce what the HRMS did
before this module existed, status for status. The stored `status` values stay the ones older clients know
(`pending`, `pending_hod`, `pending_hr`, `dept_approved`): they are a projection of who the request is waiting for,
kept in step by `project_status` after every decision and by `resync_pending` after a pipeline edit.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from django.apps import apps
from django.core.signals import request_started
from django.db.models.signals import post_delete, post_save
from django.utils import timezone

HOD = "hod"
HR = "hr"
ROLES = (HOD, HR)
ROLE_LABEL = {HOD: "HOD", HR: "HR"}
ROLE_LONG = {HOD: "Department Head", HR: "HR"}
# How a message to the employee names the role ("... was approved by your Department Head").
ROLE_PHRASE = {HOD: "your Department Head", HR: "HR"}
# The spelling older code stores in approver_role / reviewer_role and passes to the WhatsApp layer.
LEGACY_ROLE = {HOD: "dept_head", HR: "hr"}

MAX_STEPS = 2


class ApprovalError(Exception):
    """A decision (or a submission) the pipeline does not allow; carries the HTTP status and a message for the user."""

    def __init__(self, message: str, status: int = 400, code: str = "approval_not_allowed"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Step:
    roles: tuple[str, ...]
    mandatory: bool = True

    @property
    def label(self) -> str:
        return " or ".join(ROLE_LABEL[r] for r in self.roles)

    @property
    def long_label(self) -> str:
        return " or ".join(ROLE_LONG[r] for r in self.roles)

    def to_json(self) -> dict:
        return {"roles": list(self.roles), "mandatory": self.mandatory, "label": self.label}


def _step(*roles: str, mandatory: bool = True) -> Step:
    return Step(tuple(roles), mandatory)


@dataclass(frozen=True)
class WorkflowDef:
    key: str
    label: str
    group: str
    purpose: str  # what the request is for, in words HR reads on the page
    requested_by: str  # who starts it: "Employee" | "HR"
    default_steps: tuple[Step, ...]
    allowed_roles: tuple[str, ...] = ROLES
    editable: bool = True  # False: the pipeline is fixed (the screens for another role do not exist)
    can_disable: bool = True
    hod_flag: str | None = None  # DepartmentManager.can_approve_* switch that lets an individual HOD act
    early_reject_roles: tuple[str, ...] = ()  # roles that may reject before their turn (never approve)
    fixed_note: str = ""  # why a fixed pipeline is fixed
    note: str = ""  # anything HR should know about how this approval behaves
    on_off_effect: str = (
        "New requests cannot be submitted while it is off; requests already waiting can still be decided."
    )


DEFINITIONS: tuple[WorkflowDef, ...] = (
    WorkflowDef(
        key="leave",
        label="Leave",
        group="Leave & attendance",
        purpose="An employee asks for leave (full or half day). Approval updates the leave balance and the attendance calendar.",
        requested_by="Employee",
        default_steps=(_step(HOD, HR),),
        hod_flag="can_approve_leaves",
    ),
    WorkflowDef(
        key="permission",
        label="Permission",
        group="Leave & attendance",
        purpose=(
            "An employee asks for a Morning Late-In, Evening Early-Out or Middle One-Hour permission. An approved permission "
            "protects that day from Late / Early-Out marks (the monthly cap still applies)."
        ),
        requested_by="Employee",
        default_steps=(_step(HOD, HR),),
        hod_flag="can_approve_permissions",
    ),
    WorkflowDef(
        key="casual_leave",
        label="Casual Leave",
        group="Leave & attendance",
        purpose="An employee asks for one paid Casual Leave day (staff, after 6 months' service). Approval marks that day present.",
        requested_by="Employee",
        default_steps=(_step(HOD, HR),),
        hod_flag="can_approve_casual_leave",
    ),
    WorkflowDef(
        key="missing_punch",
        label="Missing Punch",
        group="Leave & attendance",
        purpose="An employee says they forgot to punch. Final approval adds that punch to the day's attendance.",
        requested_by="Employee",
        default_steps=(_step(HOD), _step(HR)),
        hod_flag="can_approve_missing_punch",
    ),
    WorkflowDef(
        key="on_duty",
        label="On-Duty (Geo Attendance)",
        group="Leave & attendance",
        purpose=(
            "An employee working away from the branch declares an On-Duty session. They can start punching as soon as they "
            "submit; the final decision accepts (or voids) those punches and issues the outpass."
        ),
        requested_by="Employee",
        default_steps=(_step(HOD, mandatory=False), _step(HR)),
        hod_flag="can_approve_on_duty",
        note="With the HOD step optional, HR can approve straight away when the HOD has not acted.",
    ),
    WorkflowDef(
        key="on_duty_punch",
        label="On-Duty punch verification",
        group="Leave & attendance",
        purpose="HR checks the photo and location of each On-Duty punch before it counts as attendance.",
        requested_by="Employee",
        default_steps=(_step(HR),),
        allowed_roles=(HR,),
        editable=False,
        can_disable=False,
        fixed_note="Only HR sees the punch photos, so this step is always HR. It belongs to On-Duty and follows that workflow.",
    ),
    WorkflowDef(
        key="attendance_correction",
        label="Attendance correction",
        group="Leave & attendance",
        purpose=(
            "HR proposes a manual change to an employee's attendance and the Department Head must approve it before the day "
            "is overwritten, so attendance is never edited without accountability."
        ),
        requested_by="HR",
        default_steps=(_step(HOD),),
        allowed_roles=(HOD,),
        editable=False,
        hod_flag="can_approve_attendance",
        fixed_note="HR is the one who asks for the change, so the Department Head is always the approver.",
        on_off_effect="HR cannot raise new corrections while it is off; corrections already waiting can still be decided.",
    ),
    WorkflowDef(
        key="outpass",
        label="Gate Outpass",
        group="Requests",
        purpose="An employee asks to leave the premises during work hours. Approval issues a gate QR that is valid for an hour.",
        requested_by="Employee",
        default_steps=(_step(HOD, HR),),
        hod_flag="can_approve_permissions",
        note="A Department Head uses the same 'can approve permissions' switch for outpasses.",
    ),
    WorkflowDef(
        key="request",
        label="Other requests",
        group="Requests",
        purpose="A general request or ticket an employee sends to HR (documents, letters, queries). HR handles it.",
        requested_by="Employee",
        default_steps=(_step(HR),),
        allowed_roles=(HR,),
        editable=False,
        fixed_note="There is no Department Head screen for these tickets, so HR always handles them.",
    ),
    WorkflowDef(
        key="resignation",
        label="Resignation",
        group="Recruitment & payroll",
        purpose="A staff member submits a resignation. Final approval makes the employee inactive.",
        requested_by="Employee",
        default_steps=(_step(HOD), _step(HR)),
        hod_flag="can_approve_resignations",
        early_reject_roles=(HR,),
        note="HR can always reject a resignation, even before the Department Head has decided.",
    ),
    WorkflowDef(
        key="advance",
        label="Advance",
        group="Recruitment & payroll",
        purpose="A salary advance recorded by HR. Approval creates the repayment schedule that payroll then deducts.",
        requested_by="HR",
        default_steps=(_step(HR),),
        allowed_roles=(HR,),
        editable=False,
        fixed_note="Advances are entered and approved by HR only.",
        on_off_effect="HR cannot record new advances while it is off; advances already waiting can still be decided.",
    ),
)

BY_KEY: dict[str, WorkflowDef] = {d.key: d for d in DEFINITIONS}


def definition(key: str) -> WorkflowDef:
    try:
        return BY_KEY[key]
    except KeyError:
        raise KeyError(f"unknown approval workflow: {key!r}") from None


# ─────────────────────────── configuration ───────────────────────────


@dataclass(frozen=True)
class Config:
    key: str
    enabled: bool
    steps: tuple[Step, ...]
    customised: bool = False
    updated_by: str | None = None
    updated_at: datetime | None = None


def steps_from_json(raw) -> tuple[Step, ...] | None:
    """Stored steps back into Step objects; None when the value is unusable (the default is used instead)."""
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        roles = tuple(r for r in item.get("roles", []) if r in ROLES)
        if not roles:
            return None
        out.append(Step(roles, bool(item.get("mandatory", True))))
    return tuple(out)


def _config_of(defn: WorkflowDef, row) -> Config:
    if row is None:
        return Config(defn.key, True, defn.default_steps)
    steps = steps_from_json(row.steps) if defn.editable else None
    return Config(
        defn.key,
        bool(row.enabled),
        steps or defn.default_steps,
        customised=bool(steps) or not row.enabled,
        updated_by=row.updated_by,
        updated_at=row.updated_at,
    )


# The pipelines are read many times while one request is served (every row of a list carries its own progress block), so
# they are remembered for the length of a request: cleared when a request starts and whenever a row is written, so a
# change made by HR reaches the very next request in every worker.
_local = threading.local()


def clear_cache(*_args, **_kwargs) -> None:
    _local.configs = None


request_started.connect(clear_cache, dispatch_uid="approval_workflow_clear_cache")


def _connect_cache_invalidation() -> None:
    model = apps.get_model("api", "ApprovalWorkflowConfig")
    post_save.connect(clear_cache, sender=model, dispatch_uid="approval_workflow_saved")
    post_delete.connect(clear_cache, sender=model, dispatch_uid="approval_workflow_deleted")


def all_configs() -> dict[str, Config]:
    cached = getattr(_local, "configs", None)
    if cached is None:
        rows = {r.key: r for r in apps.get_model("api", "ApprovalWorkflowConfig").objects.all()}
        cached = {d.key: _config_of(d, rows.get(d.key)) for d in DEFINITIONS}
        _local.configs = cached
    return cached


def get_config(key: str) -> Config:
    definition(key)  # unknown keys fail loudly
    return all_configs()[key]


def validate_steps(defn: WorkflowDef, raw) -> tuple[tuple[Step, ...] | None, str | None]:
    """Normalise the steps HR submitted, or say what is wrong with them."""
    if not defn.editable:
        return None, f"The pipeline of {defn.label} is fixed. {defn.fixed_note}".strip()
    if not isinstance(raw, list) or not raw:
        return None, "A pipeline needs at least one step."
    if len(raw) > MAX_STEPS:
        return (
            None,
            f"A pipeline can have at most {MAX_STEPS} steps (HR and the Department Head are the only approver roles).",
        )
    steps: list[Step] = []
    seen: set[str] = set()
    for i, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            return None, f"Step {i} is not valid."
        roles_raw = item.get("roles")
        if roles_raw is None and item.get("role"):
            roles_raw = [item["role"]]
        if not isinstance(roles_raw, list) or not roles_raw:
            return None, f"Step {i} needs a responsible role."
        roles: list[str] = []
        for r in roles_raw:
            if r not in ROLES:
                return None, f"Step {i}: '{r}' is not an approver role."
            if r not in defn.allowed_roles:
                return None, f"{ROLE_LONG[r]} cannot be responsible for {defn.label}."
            if r not in roles:
                roles.append(r)
        if len(roles) > 1 and len(raw) > 1:
            return None, "'HOD or HR' can only be used when it is the only step."
        for r in roles:
            if r in seen:
                return (
                    None,
                    f"{ROLE_LONG[r]} appears in more than one step. Each role can be responsible for one step only.",
                )
            seen.add(r)
        steps.append(Step(tuple(roles), bool(item.get("mandatory", True))))
    # The last step is always mandatory: nobody can skip past the end of the pipeline.
    last = steps[-1]
    steps[-1] = Step(last.roles, True)
    return tuple(steps), None


def save_config(key: str, *, enabled=None, steps=None, actor: str = "") -> Config:
    """Persist a change (already validated by the caller) and re-project the status of the requests still waiting."""
    defn = definition(key)
    model = apps.get_model("api", "ApprovalWorkflowConfig")
    row, _ = model.objects.get_or_create(key=key)
    if enabled is not None:
        row.enabled = bool(enabled)
    if steps is not None:
        row.steps = [{"roles": list(s.roles), "mandatory": s.mandatory} for s in steps]
    row.updated_by = actor or row.updated_by
    row.save()
    resync_pending(key)
    return _config_of(defn, row)


def reset_config(key: str) -> Config:
    definition(key)
    apps.get_model("api", "ApprovalWorkflowConfig").objects.filter(key=key).delete()
    resync_pending(key)
    return get_config(key)


def require_enabled(key: str) -> None:
    """Refuse a NEW request of this kind while HR has switched the workflow off."""
    if not get_config(key).enabled:
        defn = definition(key)
        noun = defn.label if defn.label.lower().endswith("requests") else f"{defn.label} requests"
        raise ApprovalError(
            f"{noun} are switched off right now. Please contact HR.",
            status=403,
            code="workflow_disabled",
        )


# ─────────────────────────── the rules ───────────────────────────


def satisfied_mask(steps: tuple[Step, ...], approved: set[str]) -> list[bool]:
    """Which steps have been dealt with: approved by a role that belongs to them, or skipped (not mandatory and a later
    step has been approved)."""
    mask = [bool(set(s.roles) & approved) for s in steps]
    for i in range(len(steps) - 2, -1, -1):
        if not mask[i] and not steps[i].mandatory and mask[i + 1]:
            mask[i] = True
    return mask


def position(steps: tuple[Step, ...], approved: set[str]) -> int:
    """Index of the step the request is at: the first that is not satisfied (the last, when all already are)."""
    for i, done in enumerate(satisfied_mask(steps, approved)):
        if not done:
            return i
    return len(steps) - 1


def holding_roles(steps: tuple[Step, ...], approved: set[str]) -> tuple[str, ...]:
    return steps[position(steps, approved)].roles


def check_can_act(
    steps: tuple[Step, ...], approved: set[str], role: str, decision: str, early_reject_roles: tuple[str, ...] = ()
) -> tuple[bool, str | None, int, str]:
    """(allowed, message, http status, code) for `role` deciding a request that has `approved` roles behind it."""
    if not any(role in s.roles for s in steps):
        return False, f"{ROLE_LONG[role]} does not take part in this approval.", 403, "role_not_in_pipeline"
    p = position(steps, approved)
    if role in steps[p].roles:
        return True, None, 200, ""
    # A later step's role may decide early only when every step it jumps over can be skipped.
    for j in range(p + 1, len(steps)):
        if role in steps[j].roles and all(not steps[k].mandatory for k in range(p, j)):
            return True, None, 200, ""
    if decision == "rejected" and role in early_reject_roles:
        return True, None, 200, ""
    return False, f"This request is still awaiting {steps[p].long_label} approval.", 400, "not_your_turn"


# ─────────────────────────── per-workflow adapters ───────────────────────────


@dataclass(frozen=True)
class Adapter:
    model: str
    pending: tuple[str, ...]
    project: Callable[[tuple[str, ...]], str]
    legacy: Callable[[object], list[dict]]
    extra_filter: dict = field(default_factory=dict)


def _iso(value):
    return value.isoformat() if value else None


def _no_legacy(obj) -> list[dict]:
    return []


def _legacy_hod_hr_stamps(obj) -> list[dict]:
    """Missing punch and on-duty: the approvals of a request made before the trail existed. `pending_hr` always
    meant "the Department Head has approved" then, so it implies that approval even if the stamp is missing."""
    out = []
    if getattr(obj, "hod_reviewed_by", None) or getattr(obj, "status", None) == "pending_hr":
        out.append(
            {
                "role": HOD,
                "decision": "approved",
                "by": getattr(obj, "hod_reviewed_by", None),
                "at": _iso(getattr(obj, "hod_reviewed_at", None)),
                "comment": getattr(obj, "hod_review_comment", None),
            }
        )
    if getattr(obj, "hr_reviewed_by", None):
        out.append(
            {
                "role": HR,
                "decision": "approved",
                "by": obj.hr_reviewed_by,
                "at": _iso(getattr(obj, "hr_reviewed_at", None)),
                "comment": getattr(obj, "hr_review_comment", None),
            }
        )
    return out


def _legacy_resignation(obj) -> list[dict]:
    if getattr(obj, "status", None) == "dept_approved" or getattr(obj, "dept_head_status", None) == "approved":
        return [
            {
                "role": HOD,
                "decision": "approved",
                "by": None,
                "at": _iso(getattr(obj, "dept_head_approved_at", None)),
                "comment": getattr(obj, "dept_head_comment", None),
            }
        ]
    return []


def _project_plain(roles: tuple[str, ...]) -> str:
    return "pending"


def _project_hod_hr(roles: tuple[str, ...]) -> str:
    return "pending_hod" if HOD in roles else "pending_hr"


def _project_resignation(roles: tuple[str, ...]) -> str:
    # "pending" has always meant "awaiting the Department Head" and "dept_approved" "awaiting HR".
    return "pending" if HOD in roles else "dept_approved"


_PLAIN = dict(pending=("pending",), project=_project_plain, legacy=_no_legacy)
ADAPTERS: dict[str, Adapter] = {
    "leave": Adapter("LeaveRequest", **_PLAIN),
    "permission": Adapter("EmployeePermission", **_PLAIN),
    "casual_leave": Adapter("CasualLeaveRequest", **_PLAIN),
    "outpass": Adapter("OutpassRequest", extra_filter={"source": "manual"}, **_PLAIN),
    "attendance_correction": Adapter("AttendanceOverrideRequest", **_PLAIN),
    "missing_punch": Adapter(
        "MissingPunchRequest", ("pending_hod", "pending_hr"), _project_hod_hr, _legacy_hod_hr_stamps
    ),
    "on_duty": Adapter("OnDutySession", ("pending_hod", "pending_hr"), _project_hod_hr, _legacy_hod_hr_stamps),
    "resignation": Adapter(
        "ResignationRequest", ("pending", "dept_approved"), _project_resignation, _legacy_resignation
    ),
}


def adapter(key: str) -> Adapter | None:
    """None for the workflows with a fixed HR-only pipeline: they have no stages to track."""
    return ADAPTERS.get(key)


def is_pending(key: str, obj) -> bool:
    a = adapter(key)
    return a is not None and getattr(obj, "status", None) in a.pending


def trail_of(key: str, obj) -> list[dict]:
    """The approvals recorded for this request (from `approval_trail`, or the older per-role stamps)."""
    stored = getattr(obj, "approval_trail", None)
    if stored is not None:  # [] is a real, empty trail (a request made under the pipeline); None is a legacy row
        return list(stored)
    a = adapter(key)
    return a.legacy(obj) if a else []


def approved_roles(trail: list[dict]) -> set[str]:
    return {e["role"] for e in trail if e.get("decision") == "approved" and e.get("role") in ROLES}


def project_status(key: str, roles: tuple[str, ...]) -> str:
    return ADAPTERS[key].project(roles)


# ─────────────────────────── deciding ───────────────────────────


@dataclass
class Outcome:
    kind: str  # "approved" (final) | "advanced" (passed on) | "rejected"
    role: str
    decision: str
    waiting: tuple[str, ...] = ()  # who the request now waits for (advanced)
    skipped: tuple[str, ...] = ()  # roles whose step was skipped by this decision
    status: str = ""  # the legacy status to store

    @property
    def final(self) -> bool:
        return self.kind == "approved"

    @property
    def rejected(self) -> bool:
        return self.kind == "rejected"


def decide(
    key: str,
    obj,
    role: str,
    decision: str,
    *,
    actor: str,
    comment: str | None = None,
    cfg: Config | None = None,
) -> Outcome:
    """Apply one approve / reject decision by `role` to a request under the pipeline in force.

    Validates that the request is still waiting and that this role may decide it now, appends the decision to
    `obj.approval_trail` and works out what happens next. It does NOT save `obj` and does NOT run any side effect: the
    calling module stamps its own fields, saves, and runs its final-approval work when `outcome.final`.
    Raises ApprovalError (with a message and HTTP status) when the decision is not allowed."""
    a = adapter(key)
    if a is None:
        raise ApprovalError(f"{definition(key).label} has no staged pipeline")
    if not is_pending(key, obj):
        raise ApprovalError(f"This request was already {getattr(obj, 'status', 'decided')}.")
    if decision not in ("approved", "rejected"):
        raise ApprovalError("status must be 'approved' or 'rejected'")
    defn = definition(key)
    cfg = cfg or get_config(key)
    trail = trail_of(key, obj)
    approved = approved_roles(trail)
    ok, message, http_status, code = check_can_act(cfg.steps, approved, role, decision, defn.early_reject_roles)
    if not ok:
        raise ApprovalError(message or "Not allowed", status=http_status, code=code)

    entry = {
        "role": role,
        "decision": decision,
        "by": actor,
        "at": timezone.now().isoformat(),
        "comment": comment or None,
    }
    if decision == "rejected":
        obj.approval_trail = trail + [entry]
        return Outcome("rejected", role, decision, status="rejected")

    before = satisfied_mask(cfg.steps, approved)
    new_approved = approved | {role}
    after = satisfied_mask(cfg.steps, new_approved)
    skipped = tuple(
        r
        for i, step in enumerate(cfg.steps)
        if not before[i] and after[i] and role not in step.roles
        for r in step.roles
    )
    if skipped:
        entry["skipped"] = list(skipped)
    obj.approval_trail = trail + [entry]
    if all(after):
        return Outcome("approved", role, decision, skipped=skipped, status="approved")
    waiting = cfg.steps[position(cfg.steps, new_approved)].roles
    return Outcome("advanced", role, decision, waiting=waiting, skipped=skipped, status=project_status(key, waiting))


def refusal(exc: ApprovalError):
    """The JSON error response for an ApprovalError, the same shape every approval endpoint returns."""
    from rest_framework.response import Response

    return Response({"error": exc.message, "code": exc.code}, status=exc.status)


def can_act(key: str, obj, role: str, cfg: Config | None = None, decision: str = "approved") -> bool:
    """Whether `role` could decide this request right now under the pipeline (not counting who the individual HOD is)."""
    if not is_pending(key, obj):
        return False
    cfg = cfg or get_config(key)
    approved = approved_roles(trail_of(key, obj))
    ok, *_ = check_can_act(cfg.steps, approved, role, decision, definition(key).early_reject_roles)
    return ok


def filter_actionable(key: str, objs, role: str, cfg: Config | None = None) -> list:
    cfg = cfg or get_config(key)
    return [o for o in objs if can_act(key, o, role, cfg)]


def role_takes_part(key: str, role: str, cfg: Config | None = None) -> bool:
    cfg = cfg or get_config(key)
    return any(role in s.roles for s in cfg.steps)


# ─────────────────────────── for screens ───────────────────────────


def progress(key: str, obj, cfg: Config | None = None) -> dict:
    """The `approval` block shipped with every request: the pipeline, how far it has got, who is up next and who may act.

    Step states: approved | skipped | pending (the current step) | waiting (a later step) | rejected."""
    cfg = cfg or get_config(key)
    a = adapter(key)
    status = getattr(obj, "status", None)
    trail = trail_of(key, obj) if a else []
    approved = approved_roles(trail)
    if a is not None:
        pending = status in a.pending
    else:  # a fixed HR-only workflow: one step that is pending until HR approves or rejects
        pending = status not in ("approved", "rejected", "closed")
    rejected_entry = next((e for e in reversed(trail) if e.get("decision") == "rejected"), None)
    mask = satisfied_mask(cfg.steps, approved)
    pos = position(cfg.steps, approved) if pending else None
    steps_json = []
    for i, step in enumerate(cfg.steps):
        done = next((e for e in trail if e.get("decision") == "approved" and e.get("role") in step.roles), None)
        if status in ("approved", "closed"):
            state = "approved" if (done or a is None) else "skipped"
        elif status == "rejected":
            if done:
                state = "approved"
            elif rejected_entry and rejected_entry.get("role") in step.roles or (a is None and i == len(cfg.steps) - 1):
                state = "rejected"
            else:
                state = "waiting"
        elif done:
            state = "approved"
        elif mask[i]:
            state = "skipped"
        else:
            state = "pending" if i == pos else "waiting"
        item = step.to_json()
        item.update({"index": i, "state": state})
        actor = done or (rejected_entry if state == "rejected" else None)
        if actor:
            item.update(
                {
                    "by": actor.get("by"),
                    "at": actor.get("at"),
                    "comment": actor.get("comment"),
                    "decidedBy": actor.get("role"),
                }
            )
        steps_json.append(item)
    defn = definition(key)
    return {
        "workflow": key,
        "label": defn.label,
        "enabled": cfg.enabled,
        "steps": steps_json,
        "currentStep": pos,
        "waitingFor": list(cfg.steps[pos].roles) if pending and pos is not None else [],
        "canAct": {
            HOD: bool(pending) and (can_act(key, obj, HOD, cfg) if a else HOD in cfg.steps[0].roles),
            HR: bool(pending) and (can_act(key, obj, HR, cfg) if a else HR in cfg.steps[0].roles),
        },
        # Rejecting can be allowed out of turn (a resignation HR may always reject), so it is told apart from approving.
        "canReject": {
            HOD: bool(pending) and (can_act(key, obj, HOD, cfg, "rejected") if a else HOD in cfg.steps[0].roles),
            HR: bool(pending) and (can_act(key, obj, HR, cfg, "rejected") if a else HR in cfg.steps[0].roles),
        },
    }


def summary() -> dict:
    """The pipelines as clients need them to explain a request to the person raising it (no counts, nothing sensitive)."""
    out = {}
    for key, cfg in all_configs().items():
        defn = definition(key)
        out[key] = {
            "label": defn.label,
            "enabled": cfg.enabled,
            "requestedBy": defn.requested_by,
            "steps": [s.to_json() for s in cfg.steps],
            "path": pipeline_text(defn.requested_by, cfg.steps),
        }
    return out


def pipeline_text(requested_by: str, steps: tuple[Step, ...]) -> str:
    """'Employee -> HOD -> HR' (or 'HR -> HOD' for a request HR starts)."""
    return " → ".join([requested_by, *(s.label for s in steps)])


def pending_count(key: str) -> int:
    a = adapter(key)
    if a is None:
        return 0
    return apps.get_model("api", a.model).objects.filter(status__in=a.pending, **a.extra_filter).count()


def resync_pending(key: str) -> int:
    """After a pipeline edit: give every request still waiting the status that matches who it now waits for. Only the
    status label is re-projected; nothing is approved or rejected and no side effect runs. Returns rows changed."""
    a = adapter(key)
    if a is None:
        return 0
    cfg = get_config(key)
    model = apps.get_model("api", a.model)
    changed = 0
    for obj in model.objects.filter(status__in=a.pending, **a.extra_filter):
        approved = approved_roles(trail_of(key, obj))
        wanted = a.project(holding_roles(cfg.steps, approved))
        if wanted != obj.status:
            model.objects.filter(pk=obj.pk).update(status=wanted)
            changed += 1
    return changed


def notify_hod_of_request(key: str, emp, what: str) -> None:
    """Tell the employee's ONE Department Head (if they may act on this kind of request) that a request has reached
    their step. Used when a decision passes a request to the Department Head, and at submission when the pipeline
    starts with the Department Head alone."""
    defn = definition(key)
    if not defn.hod_flag:
        return
    from .hod_scope import managers_to_notify

    notification = apps.get_model("api", "Notification")
    for m in managers_to_notify(emp, defn.hod_flag):
        notification.objects.create(
            employee=m.employee,
            type=key,
            message=f"{emp.first_name} {emp.last_name}'s {what} is waiting for your approval.",
        )


def notify_new_request(key: str, emp, what: str, cfg: Config | None = None) -> None:
    """At submission: when the Department Head alone is the first step, they have to be told (they act on a list, not
    an inbox). A first step shared with HR ('HOD or HR') is left as it always was: HR's queue and the HOD's approvals
    screen show it."""
    cfg = cfg or get_config(key)
    if cfg.steps[0].roles == (HOD,):
        notify_hod_of_request(key, emp, what)


def phrase(roles: tuple[str, ...]) -> str:
    """'your Department Head', 'HR' or 'your Department Head or HR'."""
    return " or ".join(ROLE_PHRASE[r] for r in roles)


def notice_for(what: str, outcome: Outcome, final_tail: str = "") -> str:
    """The in-app message telling the employee how their request moved, e.g.
    'Your Missing Punch request for 2026-03-04 was approved by your Department Head and is now awaiting HR approval.'"""
    who = ROLE_PHRASE[outcome.role]
    if outcome.rejected:
        return f"Your {what} was rejected by {who}."
    if outcome.final:
        return f"Your {what} was approved by {who}{final_tail}."
    return f"Your {what} was approved by {who} and is now awaiting {phrase(outcome.waiting)} approval."
