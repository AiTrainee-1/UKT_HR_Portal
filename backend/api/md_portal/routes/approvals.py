"""MD portal: HOD approvals (mounted at /api/md/approvals/), see md_portal/hod_approvals.py.

  GET  hods                   the Department Heads of the MD department, with what each can decide now (the page's
                              sub-tabs and the sidebar's sub-menu)
  GET  hods/<id>?status=      everything submitted to that Department Head: pending (what they can decide now),
                              approved, rejected or all
  POST hods/<id>/decide       {kind, id, decision: approved|rejected, comment}: the MD decides at that Department Head's
                              step, through the Department Head's own code (the only write in the MD portal's API)

The reads run read-only like every MD view; the decision cannot (it changes the request), so it is a plain POST view
behind the same @require_md gate.
"""

from django.urls import path
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ...audit_utils import log_action
from ...auth import require_md
from .. import hod_approvals as H
from ..common import md_get, read_only_db

NOT_MD_HOD = (
    "This Department Head is not in the MD department any more (or is no longer a Department Head). "
    "Refresh the page to see the current list."
)


@md_get
def hods(request):
    return H.hods_payload()


@api_view(["GET"])
@require_md
def hod_requests(request: Request, manager_id: int) -> Response:
    """Read-only like an @md_get view, but a Department Head who is not (or no longer) one of the MD's is a 404."""
    status = (request.query_params.get("status") or "pending").strip().lower()
    if status not in H.STATUSES:
        return Response({"error": f"'status' must be one of {', '.join(H.STATUSES)}, got '{status}'."}, status=400)
    with read_only_db():
        m = H.md_hod(manager_id)
        body = H.requests_payload(m, status) if m is not None else None
    if body is None:
        return Response({"error": NOT_MD_HOD, "code": "not_md_hod"}, status=404)
    return Response(body)


@api_view(["POST"])
@require_md
def decide(request: Request, manager_id: int) -> Response:
    m = H.md_hod(manager_id)
    if m is None:
        return Response({"error": NOT_MD_HOD, "code": "not_md_hod"}, status=404)
    data = request.data if isinstance(request.data, dict) else {}
    kind = H.KINDS.get(str(data.get("kind") or ""))
    if kind is None:
        return Response({"error": f"'kind' must be one of {', '.join(H.KINDS)}."}, status=400)
    try:
        pk = int(str(data.get("id")))
    except (TypeError, ValueError):
        return Response({"error": "'id' must be the request's number."}, status=400)
    decision = str(data.get("decision") or "")
    if decision not in H.DECISIONS:
        return Response({"error": "'decision' must be 'approved' or 'rejected'."}, status=400)
    comment = str(data.get("comment") or "").strip()[:500] or None
    if not getattr(m, kind.right):
        return Response(
            {
                "error": (
                    f"{H.hod_name(m)}'s '{kind.right_label}' right is switched off in User Management, so this step "
                    "cannot be decided for them."
                ),
                "code": "hod_right_off",
            },
            status=403,
        )

    actor = H.md_actor(request.md_user, m)
    response = H.deciders()[kind.key](m, pk, decision, comment, actor, request)
    if response.status_code >= 400:
        return response
    row = response.data if isinstance(response.data, dict) else {}
    done = H.item(kind.key, row, m) if row else None
    employee = (done or {}).get("employee") or {}
    log_action(
        request,
        "approve" if decision == "approved" else "reject",
        "md_approvals",
        record_id=pk,
        description=(
            f"{actor} {decision} the {kind.label.lower()} request #{pk} of {employee.get('code') or '?'} "
            f"{employee.get('name') or ''} at the Department Head's step (MD portal, HOD approvals)"
        ).strip(),
        new_values={
            "kind": kind.key,
            "requestId": pk,
            "decision": decision,
            "comment": comment,
            "departmentManagerId": m.id,
            "statusAfter": (done or {}).get("status"),
        },
    )
    return Response({"item": done, "decision": decision, "actor": actor})


urlpatterns = [
    path("hods", hods),
    path("hods/<int:manager_id>", hod_requests),
    path("hods/<int:manager_id>/decide", decide),
]
