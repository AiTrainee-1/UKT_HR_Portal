"""Routes for the 2026-10-31 mobile pages round (requests). Included from api/urls.py; owned by that slice only."""

from django.urls import path

from .mobile_requests_views import my_on_duty_sessions

urlpatterns: list = [
    # The employee's own On-Duty requests (On-Duty page -> View Records). Employee token only.
    path("on-duty-sessions/mine", my_on_duty_sessions),
]
