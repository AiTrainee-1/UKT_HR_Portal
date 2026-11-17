"""Routes for Attendance -> Attendance Notify (2026-11-17). Included from api/urls.py."""

from django.urls import path

from .attendance_notify_views import (
    notify_automation,
    notify_automation_run,
    notify_automation_toggle,
    notify_automations,
    notify_chat_channels,
    notify_overview,
    notify_preview,
    notify_preview_pdf,
    notify_recipient_list,
    notify_recipient_lists,
    notify_run,
    notify_run_retry,
    notify_runs,
    notify_settings,
    notify_snapshot,
    notify_whatsapp_groups,
)

urlpatterns: list = [
    path("attendance/notify/overview", notify_overview),
    path("attendance/notify/snapshot", notify_snapshot),
    path("attendance/notify/automations", notify_automations),
    path("attendance/notify/automations/<int:pk>", notify_automation),
    path("attendance/notify/automations/<int:pk>/toggle", notify_automation_toggle),
    path("attendance/notify/automations/<int:pk>/run", notify_automation_run),
    path("attendance/notify/preview", notify_preview),
    path("attendance/notify/preview-pdf", notify_preview_pdf),
    path("attendance/notify/runs", notify_runs),
    path("attendance/notify/runs/<int:pk>", notify_run),
    path("attendance/notify/runs/<int:pk>/retry", notify_run_retry),
    path("attendance/notify/recipient-lists", notify_recipient_lists),
    path("attendance/notify/recipient-lists/<int:pk>", notify_recipient_list),
    path("attendance/notify/whatsapp-groups", notify_whatsapp_groups),
    path("attendance/notify/chat-channels", notify_chat_channels),
    path("attendance/notify/settings", notify_settings),
]
