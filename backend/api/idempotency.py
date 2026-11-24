"""
Idempotent writes: the same write sent twice is done once.

The mobile app keeps requests made offline in a queue on the phone and sends them when the internet is back
(src/offline in the app). A send can reach the server and still look failed to the phone (the answer was lost when the
signal dropped), so the queue sends it again. Each queued write carries a header

    Idempotency-Key: <random id made on the phone when the employee tapped Submit>

and this middleware remembers the answer per (caller, key): the second send gets the first answer back (with
`Idempotent-Replayed: true`) instead of creating a second leave request, a second punch, ...

  * Only writes (POST / PUT / PATCH / DELETE) under /api/ that carry the header are affected; everything else, and
    every caller that never sends the header (the web portals), works exactly as before.
  * The caller is read from the bearer token ("employee:<id>" / "hr:<id>"), so keys never collide between people.
    A request without a valid token is passed through untouched (the view answers 401 as usual).
  * Answers worth repeating are kept: 2xx and the final 4xx refusals (validation, "already decided" ...). An answer
    that says "try again" is NOT kept, so the retry really runs: 401 (the session may be fixed by signing in again),
    408, 429, and every 5xx.
  * The same key on a different method/path is refused with 422, and a send while the first is still being served
    gets 409 {code: "request_in_progress"} (the queue simply tries again later). A row stuck "in progress" (the worker
    died mid-request) is taken over after STALE_AFTER.
"""

from __future__ import annotations

import json
import logging
import random
import re
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone

from .auth import get_bearer_token
from .jwt_utils import verify_token

logger = logging.getLogger(__name__)

HEADER = "HTTP_IDEMPOTENCY_KEY"
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_\-:.]{8,100}$")
TTL_DAYS = 14
STALE_AFTER = timedelta(minutes=3)
# Statuses that mean "nothing final happened, send it again": never remembered.
RETRYABLE = {401, 408, 425, 429}


def owner_of(request) -> str | None:
    token = get_bearer_token(request)
    if not token:
        return None
    try:
        claims = verify_token(token)
    except Exception:
        return None
    role = claims.get("role")
    if role == "employee" and claims.get("employeeId"):
        return f"employee:{claims['employeeId']}"
    if role == "hr" and claims.get("hrUserId"):
        return f"hr:{claims['hrUserId']}"
    return None


def _body_of(response) -> object | None:
    content_type = response.get("Content-Type", "") if hasattr(response, "get") else ""
    if "json" not in content_type or getattr(response, "streaming", False):
        return None
    try:
        return json.loads(response.content or b"null")
    except (ValueError, TypeError):
        return None


def _replay(row) -> JsonResponse:
    body = row.response_body
    response = JsonResponse(body if body is not None else {}, status=row.status_code or 200, safe=False)
    response["Idempotent-Replayed"] = "true"
    return response


def _purge_sometimes() -> None:
    if random.random() < 0.01:
        from .models import IdempotentRequest

        try:
            IdempotentRequest.objects.filter(created_at__lt=timezone.now() - timedelta(days=TTL_DAYS)).delete()
        except Exception:
            logger.exception("Could not purge old idempotency rows")


class IdempotencyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        key = request.META.get(HEADER)
        if not key or request.method not in WRITE_METHODS or not request.path.startswith("/api/"):
            return self.get_response(request)
        if not KEY_PATTERN.match(key):
            return JsonResponse({"error": "Invalid Idempotency-Key", "code": "idempotency_key_invalid"}, status=400)
        owner = owner_of(request)
        if owner is None:
            return self.get_response(request)

        from .models import IdempotentRequest

        row = None
        try:
            with transaction.atomic():
                row = IdempotentRequest.objects.create(owner=owner, key=key, method=request.method, path=request.path)
        except IntegrityError:
            existing = IdempotentRequest.objects.filter(owner=owner, key=key).first()
            if existing is None:  # removed between the insert and this read: just serve it
                return self.get_response(request)
            if existing.method != request.method or existing.path != request.path:
                return JsonResponse(
                    {"error": "This request id was already used for a different request.",
                     "code": "idempotency_key_reused"},
                    status=422,
                )
            if existing.state == IdempotentRequest.STATE_DONE:
                return _replay(existing)
            if timezone.now() - existing.created_at < STALE_AFTER:
                return JsonResponse(
                    {"error": "This request is still being processed. Please try again in a moment.",
                     "code": "request_in_progress"},
                    status=409,
                )
            # The first attempt died mid-request: take the row over and serve this one.
            existing.created_at = timezone.now()
            existing.save(update_fields=["created_at"])
            row = existing

        _purge_sometimes()
        try:
            response = self.get_response(request)
        except Exception:
            IdempotentRequest.objects.filter(pk=row.pk).delete()
            raise

        status = response.status_code
        if status in RETRYABLE or status >= 500:
            IdempotentRequest.objects.filter(pk=row.pk).delete()
            return response
        try:
            IdempotentRequest.objects.filter(pk=row.pk).update(
                state=IdempotentRequest.STATE_DONE, status_code=status, response_body=_body_of(response)
            )
        except Exception:
            # Remembering the answer must never break the answer itself.
            logger.exception("Could not store the idempotent answer for %s %s", request.method, request.path)
        return response
