"""
Approval Workflow Control -the API behind User Management -> Approval Workflow Control.

    GET    /api/approval-workflows          every approval workflow with its current pipeline (HR page)
    PUT    /api/approval-workflows/<key>    change a pipeline and/or switch the workflow ON/OFF
    DELETE /api/approval-workflows/<key>    put a workflow back to its built-in pipeline
    GET    /api/approval-summary            the pipelines for any signed-in user (apps explain a request's path with it)

The rules themselves (what a pipeline is, who may decide when) live in approval_workflow.py; this file only exposes them.
Configuring a pipeline never assigns anybody: who the Department Head of an employee is stays in HOD Assignment.
"""

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import approval_workflow as approval
from .audit_utils import log_action
from .auth import get_hr_display_name, require_auth, require_hr


def _steps_json(steps) -> list[dict]:
    return [s.to_json() for s in steps]


def _hod_switch(defn: approval.WorkflowDef) -> str | None:
    if not defn.hod_flag:
        return None
    return defn.hod_flag.replace("_", " ").capitalize()


def _warnings(defn: approval.WorkflowDef, cfg: approval.Config) -> list[str]:
    out: list[str] = []
    if not cfg.enabled:
        out.append(
            "Switched OFF: nobody can submit a new request of this kind. Requests already waiting can still be decided."
        )
    roles_in_use = {r for s in cfg.steps for r in s.roles}
    if approval.HR not in roles_in_use and defn.editable:
        out.append(
            "HR is not part of this pipeline: HR can no longer approve or reject these requests, only view them."
        )
    hod_only_first = cfg.steps[0].roles == (approval.HOD,) and cfg.steps[0].mandatory
    if approval.HOD in roles_in_use and hod_only_first and len(cfg.steps) >= 1 and defn.editable:
        out.append(
            "The Department Head step is mandatory: a request from an employee who has no Department Head (or who is a "
            "Department Head themselves) waits until that changes. Make the step optional to let the next role decide it."
        )
    return out


def _hints(defn: approval.WorkflowDef, cfg: approval.Config) -> list[str]:
    """Things worth knowing that are not a problem (a warning is something HR may want to change)."""
    out: list[str] = []
    roles_in_use = {r for s in cfg.steps for r in s.roles}
    if approval.HOD in roles_in_use and defn.hod_flag:
        out.append(
            f"A Department Head can only decide these when their own profile has '{_hod_switch(defn)}' switched on in HOD Assignment."
        )
    return out


def _waiting(key: str) -> dict:
    """How many requests are waiting right now, and how many each role could decide today."""
    a = approval.adapter(key)
    if a is None:
        return {"total": 0, "hod": 0, "hr": 0}
    from django.apps import apps

    cfg = approval.get_config(key)
    rows = list(apps.get_model("api", a.model).objects.filter(status__in=a.pending, **a.extra_filter))
    return {
        "total": len(rows),
        "hod": sum(1 for r in rows if approval.can_act(key, r, approval.HOD, cfg)),
        "hr": sum(1 for r in rows if approval.can_act(key, r, approval.HR, cfg)),
    }


def workflow_json(defn: approval.WorkflowDef, cfg: approval.Config, with_waiting: bool = True) -> dict:
    return {
        "key": defn.key,
        "label": defn.label,
        "group": defn.group,
        "purpose": defn.purpose,
        "requestedBy": defn.requested_by,
        "enabled": cfg.enabled,
        "steps": _steps_json(cfg.steps),
        "defaultSteps": _steps_json(defn.default_steps),
        "customised": cfg.customised,
        "path": approval.pipeline_text(defn.requested_by, cfg.steps),
        "editable": defn.editable,
        "canDisable": defn.can_disable,
        "allowedRoles": list(defn.allowed_roles),
        "fixedNote": defn.fixed_note or None,
        "note": defn.note or None,
        "onOffEffect": defn.on_off_effect,
        "hodSwitch": _hod_switch(defn),
        "warnings": _warnings(defn, cfg),
        "hints": _hints(defn, cfg),
        "waiting": _waiting(defn.key) if with_waiting else None,
        "updatedBy": cfg.updated_by,
        "updatedAt": cfg.updated_at.isoformat() if cfg.updated_at else None,
    }


@api_view(["GET"])
@require_hr
def approval_workflows(request: Request) -> Response:
    configs = approval.all_configs()
    return Response(
        {
            "roles": [
                {"key": r, "label": approval.ROLE_LABEL[r], "long": approval.ROLE_LONG[r]} for r in approval.ROLES
            ],
            "maxSteps": approval.MAX_STEPS,
            "workflows": [workflow_json(d, configs[d.key]) for d in approval.DEFINITIONS],
        }
    )


@api_view(["PUT", "DELETE"])
@require_hr
def approval_workflow_detail(request: Request, key: str) -> Response:
    if key not in approval.BY_KEY:
        return Response({"error": "Unknown approval workflow"}, status=404)
    defn = approval.BY_KEY[key]
    before = approval.get_config(key)
    hr_name = get_hr_display_name(request)

    if request.method == "DELETE":
        after = approval.reset_config(key)
        log_action(
            request,
            "reset",
            "approval_workflow",
            description=f"{defn.label}: back to the built-in pipeline",
            old_values={"enabled": before.enabled, "steps": _steps_json(before.steps)},
            new_values={"enabled": after.enabled, "steps": _steps_json(after.steps)},
        )
        return Response(workflow_json(defn, after))

    data = request.data if isinstance(request.data, dict) else {}
    if "enabled" not in data and "steps" not in data:
        return Response({"error": "Send 'enabled' and/or 'steps'."}, status=400)

    enabled = None
    if "enabled" in data:
        if not isinstance(data["enabled"], bool):
            return Response({"error": "'enabled' must be true or false."}, status=400)
        enabled = data["enabled"]
        if not enabled and not defn.can_disable:
            return Response(
                {"error": f"{defn.label} cannot be switched off: it belongs to another workflow."}, status=400
            )

    steps = None
    if "steps" in data:
        steps, error = approval.validate_steps(defn, data["steps"])
        if error:
            return Response({"error": error}, status=400)

    new_enabled = before.enabled if enabled is None else enabled
    new_steps = before.steps if steps is None else steps
    if new_enabled and new_steps == defn.default_steps:
        after = approval.reset_config(key)  # nothing left that differs from the built-in pipeline
    else:
        after = approval.save_config(key, enabled=enabled, steps=steps, actor=hr_name)
    log_action(
        request,
        "update",
        "approval_workflow",
        description=f"{defn.label}: {approval.pipeline_text(defn.requested_by, after.steps)}"
        + ("" if after.enabled else " (switched OFF)"),
        old_values={"enabled": before.enabled, "steps": _steps_json(before.steps)},
        new_values={"enabled": after.enabled, "steps": _steps_json(after.steps)},
    )
    return Response(workflow_json(defn, after))


@api_view(["GET"])
@require_auth
def approval_summary(request: Request) -> Response:
    return Response(approval.summary())
