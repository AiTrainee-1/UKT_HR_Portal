"""/api/settlement-automation/... and /api/settlement-settings (views.py). Included from api/urls.py."""

from django.urls import path

from . import views

urlpatterns = [
    path("settlement-automation/method", views.method_view),
    path("settlement-automation/month", views.month_view),
    path("settlement-automation/overview", views.overview_view),
    path("settlement-automation/items/<int:pk>", views.item_view),
    path("settlement-automation/items/<int:pk>/final", views.item_final_view),
    path("settlement-automation/batches/<int:pk>/hr-review-bulk", views.hr_review_bulk_view),
    path("settlement-automation/batches/<int:pk>/final-bulk", views.final_bulk_view),
    path("settlement-automation/batches/<int:pk>/forward", views.forward_view),
    path("settlement-automation/batches/<int:pk>/finalize", views.finalize_view),
    path("settlement-automation/batches/<int:pk>/send-auditor", views.send_auditor_view),
    path("settlement-automation/batches/<int:pk>/auditor-done", views.auditor_done_view),
    path("settlement-automation/items/<int:pk>/rework", views.item_rework_view),
    path("settlement-automation/items/<int:pk>/resolve", views.item_resolve_view),
    path("settlement-automation/batches/<int:pk>/resolve-bulk", views.resolve_bulk_view),
    path("settlement-automation/batches/<int:pk>/resubmit-md", views.resubmit_md_view),
    path("settlement-automation/batches/<int:pk>/resubmit-auditor", views.resubmit_auditor_view),
    path("settlement-automation/batches/<int:pk>/send-accounts", views.send_accounts_view),
    path("settlement-automation/batches/<int:pk>/complete", views.complete_view),
    path("settlement-automation/files/<int:pk>", views.file_view),
    path("settlement-settings", views.settings_view),
    # the Auditor Review Portal: public, the e-mailed token is the key (2026-11-27)
    path("auditor-review/<str:token>", views.auditor_portal_view),
    path("auditor-review/<str:token>/timecard/<int:item_id>", views.auditor_timecard_view),
    path("auditor-review/<str:token>/items/<int:item_id>", views.auditor_item_view),
    path("auditor-review/<str:token>/bulk", views.auditor_bulk_view),
    path("auditor-review/<str:token>/leave/<int:item_id>", views.auditor_leave_view),
    path("auditor-review/<str:token>/submit", views.auditor_submit_view),
]
