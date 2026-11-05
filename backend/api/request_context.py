"""The request being served, for code deep in a response that needs it without having it passed down.

employee_photo.photo_link builds an absolute link to the API (the HR portal and the employee apps live on other
domains, so a relative /api/... link would resolve against the wrong host) and takes the scheme and host from here.

A ContextVar rather than a module global or a thread-local: each thread (and each task, should the server ever run
async) sees only the request it is serving, and the value is reset when the response is done, so nothing outlives it.
"""

from contextvars import ContextVar

_current = ContextVar("api_current_request", default=None)


def current_request():
    """The Django request being served on this thread / task, or None (a management command, a scheduler job)."""
    return _current.get()


class RequestContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = _current.set(request)
        try:
            return self.get_response(request)
        finally:
            _current.reset(token)
