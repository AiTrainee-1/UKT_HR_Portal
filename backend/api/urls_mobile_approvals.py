"""Routes for the HOD Approvals page history (mobile, 2026-10-31). Included from api/urls.py; owned by that work only."""

from django.urls import path

from .mobile_approvals_views import manager_requests, manager_requests_summary

urlpatterns: list = [
    path("manager/requests/summary", manager_requests_summary),
    path("manager/requests", manager_requests),
]
