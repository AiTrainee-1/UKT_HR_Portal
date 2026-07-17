"""
Query-level branch isolation — the enforcement half of multi-branch data
isolation (the RBAC-style permission_middleware.py only gates *which pages*
an HR user can reach; this gates *which rows* they see once there).

HrPermissionMiddleware resolves the requesting HR user's branch_id fresh
from the DB on every request (same pattern as it already does for
role.permissions) and attaches it to request.hr_branch_id. None means
unscoped — super admins, branch-less roles (MD/Directors/Admin today), and
non-HR/unauthenticated requests all read as unscoped here; the view's own
auth decorator is what actually rejects the latter.
"""


def get_branch_scope(request) -> int | None:
    return getattr(request, "hr_branch_id", None)


def scope_to_branch(queryset, request, field: str = "branch_id"):
    """Filter queryset to the requester's branch. No-op when unscoped."""
    branch_id = get_branch_scope(request)
    if branch_id is None:
        return queryset
    return queryset.filter(**{field: branch_id})
