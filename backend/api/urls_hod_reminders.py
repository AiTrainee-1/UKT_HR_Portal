"""Routes for the HR Requests page's HoD's and Notify tabs (2026-11-04). Included from api/urls.py."""

from django.urls import path

from .hod_reminders_views import (
    hod_pending,
    hod_reminder_preview,
    hod_reminder_run_detail,
    hod_reminder_runs,
    hod_reminder_send,
    hod_reminder_settings,
)

urlpatterns: list = [
    path("hr/hod-pending", hod_pending),
    path("hr/hod-reminders/settings", hod_reminder_settings),
    path("hr/hod-reminders/preview", hod_reminder_preview),
    path("hr/hod-reminders/send", hod_reminder_send),
    path("hr/hod-reminders/runs", hod_reminder_runs),
    path("hr/hod-reminders/runs/<int:pk>", hod_reminder_run_detail),
]
