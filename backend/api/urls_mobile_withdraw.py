"""Routes for the 2026-11-24 mobile round (withdraw my own request). Included from api/urls.py.

See mobile_withdraw_views.py."""

from django.urls import path

from .mobile_withdraw_views import withdraw_my_request

urlpatterns: list = [
    path("my/requests/<str:module>/<int:pk>/withdraw", withdraw_my_request),
]
