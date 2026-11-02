"""Routes for the 2026-10-31 mobile pages round (reminders). Included from api/urls.py; owned by that slice only.

My Requests + "remind the approver" (mobile HOD Assignment), and the HR list of reminders sent to HR (Requests hub).
See mobile_reminder_views.py."""

from django.urls import path

from .mobile_reminder_views import hr_approval_reminders, my_pending_requests, remind_approver

urlpatterns: list = [
    path("my/pending-requests", my_pending_requests),
    path("my/pending-requests/<str:module>/<int:pk>/remind", remind_approver),
    path("hr/approval-reminders", hr_approval_reminders),
]
