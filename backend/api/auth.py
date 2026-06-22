from functools import wraps

from rest_framework.request import Request
from rest_framework.response import Response

from .jwt_utils import verify_token


def get_bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


def require_auth(view_func):
    @wraps(view_func)
    def wrapper(request: Request, *args, **kwargs):
        token = get_bearer_token(request)
        if not token:
            return Response({"error": "Unauthorized"}, status=401)
        try:
            request.jwt_user = verify_token(token)
        except Exception:
            return Response({"error": "Invalid or expired token"}, status=401)
        return view_func(request, *args, **kwargs)

    return wrapper


def require_hr(view_func):
    @wraps(view_func)
    @require_auth
    def wrapper(request: Request, *args, **kwargs):
        if request.jwt_user.get("role") != "hr":
            return Response({"error": "HR access required"}, status=403)
        return view_func(request, *args, **kwargs)

    return wrapper
