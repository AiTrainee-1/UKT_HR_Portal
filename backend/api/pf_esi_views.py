"""PF & ESI: the rule settings API and the coverage counts. The rules and the arithmetic live in pf_esi.py.

    GET    /api/pf-esi-settings?branchId=   the rules of a scope: ANY HR login may read (a branch login reads its own branch's)
    PUT    /api/pf-esi-settings             replace rule lists: SUPER ADMIN only, with the stale-edit guard (expectedVersion)
    DELETE /api/pf-esi-settings?branchId=   make a branch follow the global rules again: SUPER ADMIN only
    GET    /api/pf-esi/coverage?type=&branchId=&detail=   how many Co Emp employees have PF / ESI and how many do not

Scopes. GLOBAL = the four rule lists on the universal PayrollSettings row, visible to every login. A BRANCH override = a copy of
all four lists inside that branch's BranchSettingsOverride.overrides, written here and nowhere else (the generic settings API
never touches them, and user_settings.persist_overlay keeps them exactly as stored). A branch without one follows the global
rules. Payroll reads the rules through settings_for_employee(), i.e. from the EMPLOYEE's branch.

The stale-edit guard is a content hash of the scope's four effective lists (pf_esi.version_of): whoever saves names the version
they started from, and a save from an out-of-date page is refused with 409 instead of silently replacing a newer edit.
"""

from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from . import pf_esi
from .audit_utils import log_action
from .auth import require_hr
from .branch_scope import scope_to_branch
from .models import Branch, BranchSettingsOverride, Employee, PayrollSettings
from .user_settings import _overlay_for_branch, _SettingsOverlay, get_hr_user
from .view_common import error_response

FORBIDDEN = {"error": "permission_denied", "message": "Only the Super Admin can change PF / ESI rules."}


def _forbidden(message: str | None = None) -> Response:
    return Response({**FORBIDDEN, **({"message": message} if message else {})}, status=403)


def _is_super_admin(hr_user) -> bool:
    return bool(hr_user is not None and hr_user.is_super_admin)


def _resolve_scope(hr_user, is_super: bool, raw_branch):
    """(Branch | None, error Response | None). None = the global rules.

    A Super Admin chooses any branch (or none = global). Anybody else is always on their own scope: their branch's rules,
    or the global ones when the login has no branch; naming another branch is refused rather than quietly ignored."""
    wanted = None
    if raw_branch not in (None, ""):
        try:
            if isinstance(raw_branch, bool):
                raise ValueError(raw_branch)
            wanted = int(raw_branch)
        except (TypeError, ValueError):
            return None, error_response("branchId must be a number")
    if is_super:
        if wanted is None:
            return None, None
        branch = Branch.objects.filter(pk=wanted).first()
        return (branch, None) if branch else (None, error_response("Branch not found", 404))
    own = hr_user.branch_id if hr_user is not None else None
    if wanted is not None and wanted != own:
        return None, _forbidden("You can only see the PF / ESI rules of your own branch.")
    return (Branch.objects.filter(pk=own).first() if own else None), None


def _effective(branch):
    """(settings carrying the rules the scope uses, whether the branch has its own rule lists)."""
    if branch is None:
        return PayrollSettings.get(), False
    overlay = _overlay_for_branch(branch.id)
    return overlay, any(name in overlay.overrides for name in pf_esi.RULE_FIELD_NAMES)


def _payload(branch, is_super: bool) -> dict:
    ps, is_override = _effective(branch)
    lists = pf_esi.rules_json(ps)
    branches = []
    if is_super:
        overridden = {
            row.branch_id: any(name in (row.overrides or {}) for name in pf_esi.RULE_FIELD_NAMES)
            for row in BranchSettingsOverride.objects.all()
        }
        for b in Branch.objects.order_by("name", "id"):
            if b.is_active or overridden.get(b.id):
                branches.append({"id": b.id, "name": b.name, "hasOverride": bool(overridden.get(b.id))})
    return {
        "scope": {
            "branchId": branch.id if branch else None,
            "branchName": branch.name if branch else None,
            "isOverride": is_override,
        },
        "canEdit": is_super,
        "version": pf_esi.version_of(lists),
        "staff": {
            "pfRules": lists[(pf_esi.CLASS_STAFF, pf_esi.KIND_PF)],
            "esiRules": lists[(pf_esi.CLASS_STAFF, pf_esi.KIND_ESI)],
        },
        "production": {
            "pfRules": lists[(pf_esi.CLASS_PRODUCTION, pf_esi.KIND_PF)],
            "esiRules": lists[(pf_esi.CLASS_PRODUCTION, pf_esi.KIND_ESI)],
        },
        "branches": branches,
        "basisOptions": pf_esi.BASIS_OPTIONS,
        "limits": {
            "maxRulesPerList": pf_esi.MAX_RULES_PER_LIST,
            "maxAmount": float(pf_esi.MAX_AMOUNT),
            "maxRatePercent": float(pf_esi.MAX_RATE_PERCENT),
        },
    }


def _scope_text(branch) -> str:
    return f"branch {branch.name}" if branch is not None else "all units (global)"


def _named(lists: dict) -> dict:
    """{ "staff.pfRules": [...], ... } for the audit log."""
    return {pf_esi.LIST_KEYS[key]: lists[key] for key in pf_esi.RULE_FIELDS}


@api_view(["GET", "PUT", "DELETE"])
@require_hr
def pf_esi_settings(request: Request) -> Response:
    hr_user = get_hr_user(request)
    is_super = _is_super_admin(hr_user)
    if request.method == "GET":
        branch, problem = _resolve_scope(hr_user, is_super, request.query_params.get("branchId"))
        return problem or Response(_payload(branch, is_super))
    if not is_super:
        return _forbidden()
    if request.method == "DELETE":
        return _reset_branch(request, hr_user)
    return _save(request, hr_user)


def _save(request: Request, hr_user) -> Response:
    data = request.data
    if not isinstance(data, dict):
        return error_response("The request body must be a JSON object.")
    expected = data.get("expectedVersion")
    if not isinstance(expected, str) or not expected.strip():
        return error_response("expectedVersion is required: reload the page and apply your change again.")
    branch, problem = _resolve_scope(hr_user, True, data.get("branchId"))
    if problem:
        return problem

    sent: dict[tuple[str, str], list[dict]] = {}
    for emp_class, body_key in ((pf_esi.CLASS_STAFF, "staff"), (pf_esi.CLASS_PRODUCTION, "production")):
        block = data.get(body_key)
        if block is None:
            continue
        if not isinstance(block, dict):
            return error_response(f"{body_key} must be an object with pfRules and/or esiRules.")
        for kind, key in ((pf_esi.KIND_PF, "pfRules"), (pf_esi.KIND_ESI, "esiRules")):
            if key not in block:
                continue
            try:
                sent[(emp_class, kind)] = pf_esi.clean_rule_list(block[key], emp_class, kind)
            except pf_esi.RulesInvalid as problem_found:
                return Response(problem_found.payload(), status=400)
    if not sent:
        return error_response(
            "Send at least one rule list (staff.pfRules, staff.esiRules, production.pfRules or production.esiRules)."
        )

    with transaction.atomic():
        # One lock for both scopes, always taken first: it serialises every save, so the version check below and the write
        # are one step and a branch's first override can never be created twice.
        base = PayrollSettings.objects.select_for_update().get(pk=PayrollSettings.get().pk)
        row = None
        if branch is None:
            current_ps = base
        else:
            row = BranchSettingsOverride.objects.select_for_update().filter(branch_id=branch.id).first()
            current_ps = _SettingsOverlay(base, dict(row.overrides) if row else {}, branch.id)
        before = pf_esi.rules_json(current_ps)
        current_version = pf_esi.version_of(before)
        if expected.strip() != current_version:
            return Response(
                {
                    "error": "stale_version",
                    "message": (
                        "These rules were changed by someone else since you opened them. "
                        "Reload and apply your change again."
                    ),
                    "currentVersion": current_version,
                },
                status=409,
            )
        after = {key: sent.get(key, before[key]) for key in pf_esi.RULE_FIELDS}
        if branch is None:
            for key, field in pf_esi.RULE_FIELDS.items():
                setattr(base, field, after[key])
            base.save(update_fields=[*pf_esi.RULE_FIELD_NAMES, "updated_at"])
        else:
            if row is None:
                row = BranchSettingsOverride(branch_id=branch.id, overrides={})
            overrides = dict(row.overrides or {})
            for key, field in pf_esi.RULE_FIELDS.items():
                overrides[field] = after[key]
            row.overrides = overrides
            row.save()
        changed = ", ".join(
            f"{pf_esi.LIST_KEYS[key]} ({len(sent[key])} rule{'s' if len(sent[key]) != 1 else ''})" for key in sent
        )
        log_action(
            request,
            "update",
            "settings",
            description=f"PF / ESI rules updated for {_scope_text(branch)}: {changed}",
            old_values=_named(before),
            new_values=_named(after),
        )
    return Response(_payload(branch, True))


def _reset_branch(request: Request, hr_user) -> Response:
    raw = request.query_params.get("branchId")
    if raw in (None, ""):
        return error_response("branchId is required: the global rules cannot be deleted, only a branch's own rules.")
    branch, problem = _resolve_scope(hr_user, True, raw)
    if problem:
        return problem
    if branch is None:  # unreachable (raw is not blank), kept so a refactor cannot turn this into a global reset
        return error_response("branchId is required.")
    with transaction.atomic():
        PayrollSettings.objects.select_for_update().get(pk=PayrollSettings.get().pk)
        row = BranchSettingsOverride.objects.select_for_update().filter(branch_id=branch.id).first()
        had = bool(row and any(name in (row.overrides or {}) for name in pf_esi.RULE_FIELD_NAMES))
        before = pf_esi.rules_json(_overlay_for_branch(branch.id)) if had else None
        if row is not None:
            remaining = {k: v for k, v in (row.overrides or {}).items() if k not in pf_esi.RULE_FIELD_NAMES}
            if remaining:
                row.overrides = remaining
                row.save(update_fields=["overrides", "updated_at"])
            else:
                row.delete()
        if had:
            log_action(
                request,
                "update",
                "settings",
                description=f"PF / ESI rules of branch {branch.name} reset: it follows the global rules again",
                old_values=_named(before),
                new_values=None,
            )
    return Response(_payload(branch, True))


class CoverageParamError(ValueError):
    """A coverage request whose `type` or `branchId` cannot be read: answered as a 400 with this message."""


def load_coverage(request: Request) -> tuple[str, int | None, list[dict]]:
    """(type, branch id, rows) of a coverage request: the active employees in the caller's branch scope (narrowed by `type` and
    `branchId`), judged by pf_esi.coverage_rows. The JSON endpoint and the Excel / PDF export both read it, so the file always
    holds exactly the numbers the page shows. Raises CoverageParamError."""
    kind = request.query_params.get("type", "all")
    if kind not in ("all", pf_esi.CLASS_STAFF, pf_esi.CLASS_PRODUCTION):
        raise CoverageParamError("type must be staff, production or all")
    qs = scope_to_branch(Employee.objects.filter(status="active").select_related("department", "branch"), request)
    branch_id = None
    raw_branch = request.query_params.get("branchId")
    if raw_branch not in (None, ""):
        try:
            branch_id = int(raw_branch)
        except ValueError:
            raise CoverageParamError("branchId must be a number") from None
        qs = qs.filter(branch_id=branch_id)
    if kind != "all":
        qs = qs.filter(employment_type=kind)
    return kind, branch_id, pf_esi.coverage_rows(qs.order_by("employee_code", "id"))


@api_view(["GET"])
@require_hr
def pf_esi_coverage(request: Request) -> Response:
    try:
        kind, branch_id, rows = load_coverage(request)
    except CoverageParamError as problem:
        return error_response(str(problem))
    body: dict = {
        "asOf": timezone.now().isoformat(),
        "filters": {"type": kind, "branchId": branch_id},
    }
    for emp_class in (pf_esi.CLASS_STAFF, pf_esi.CLASS_PRODUCTION):
        if kind in ("all", emp_class):
            body[emp_class] = pf_esi.coverage_counts(rows, emp_class)
    if request.query_params.get("detail") in ("1", "true"):
        body["employees"] = rows
    return Response(body)
