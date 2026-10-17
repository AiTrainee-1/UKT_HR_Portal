"""Per-IP throttling for the public @api_view function views (sign-in, one-time codes, the gate / visitor forms).

Why this module exists: DRF's ScopedRateThrottle reads `view.throttle_scope`, but the @api_view wrapper never carries an
attribute that a function sets on `request` INSIDE its body (that code runs after the throttles were checked), so the old
`request.throttle_scope = "..."` lines never throttled anything. `@throttle("scope")` goes on the function, BELOW @api_view
(exactly where @throttle_classes goes) and counts the client address against DEFAULT_THROTTLE_RATES[scope].

Who the client is follows REST_FRAMEWORK["NUM_PROXIES"] (config/settings.py, env NUM_PROXIES, default 1): DRF then takes
the LAST hop of X-Forwarded-For, the one the platform's proxy appended. The first hop is whatever the caller wrote, so a
caller rotating it cannot dodge the limit. (connector_auth._caller relies on the same fact.) The counters live in the
default cache (per server process).

These per-IP limits are only a flood guard: a whole shop floor (a few hundred employees) sits behind ONE address at shift
start, so the rates are generous. The real cost / abuse guards are the per-employee, per-phone and global caps in
otp_service.py and sms_service.py, and the per-username lockout of the HR login.
"""

import math

from rest_framework.exceptions import Throttled
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import exception_handler as drf_exception_handler


class IpRateThrottle(SimpleRateThrottle):
    """One bucket per (scope, client address). Who the client is follows REST_FRAMEWORK["NUM_PROXIES"] (settings.py)."""

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


def throttle(scope: str):
    """@api_view(["POST"]) then @throttle("otp_request") then the function. The scope must be a key of
    DEFAULT_THROTTLE_RATES: a typo fails when the module is imported, not silently."""
    throttle_class = type(f"{scope.title().replace('_', '')}Throttle", (IpRateThrottle,), {"scope": scope})
    throttle_class()  # raises ImproperlyConfigured now if the scope has no rate

    def decorate(func):
        func.throttle_classes = [throttle_class]
        return func

    return decorate


def exception_handler(exc, context):
    """DRF's own handler, except that a throttled call answers in this API's shape ({"error", "retryAfterSeconds"}: what
    the apps already read from the per-employee 429s) instead of {"detail": "..."}. The Retry-After header and the JSON
    number are the same whole seconds (rounded up)."""
    response = drf_exception_handler(exc, context)
    if response is not None and isinstance(exc, Throttled):
        wait = max(1, math.ceil(exc.wait or 1))
        response.data = {
            "error": f"Too many attempts from this network. Please wait {wait} seconds and try again.",
            "retryAfterSeconds": wait,
        }
        response["Retry-After"] = str(wait)
    return response
