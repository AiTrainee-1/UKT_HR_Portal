from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import require_hr, require_super_admin
from .models import LoginSession


def _session_json(session: LoginSession, current_jti: str | None) -> dict:
    account = session.hr_user
    return {
        "id": session.id,
        "hrUserId": account.id,
        "username": account.username,
        "fullName": account.full_name or account.username,
        "roleName": "Super Admin" if account.is_super_admin else (account.role.name if account.role else None),
        "deviceLabel": session.device_label,
        "ipAddress": session.ip_address,
        "createdAt": session.created_at.isoformat(),
        "lastSeenAt": session.last_seen_at.isoformat(),
        "isCurrent": session.jti == current_jti,
    }


@api_view(["GET"])
@require_hr
def login_sessions(request: Request) -> Response:
    sessions = (
        LoginSession.objects.filter(revoked_at__isnull=True)
        .select_related("hr_user", "hr_user__role")
        .order_by("-last_seen_at")
    )
    current_jti = request.jwt_user.get("jti")
    results = [_session_json(s, current_jti) for s in sessions]
    return Response({
        "total": len(results),
        "results": results,
    })


@api_view(["POST"])
@require_super_admin
def revoke_login_session(request: Request, session_id: int) -> Response:
    session = LoginSession.objects.filter(id=session_id, revoked_at__isnull=True).first()
    if session is None:
        return Response({"error": "Session not found or already revoked"}, status=404)
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at"])
    return Response({"message": "Session revoked"})
