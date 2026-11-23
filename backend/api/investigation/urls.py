"""/api/employee-investigation/... (views.py)."""

from django.urls import path

from . import views

urlpatterns = [
    path("summary", views.summary),
    path("list", views.list_view),
    path("auto", views.auto_view),
    path("detail", views.detail),
    path("inactivate", views.inactivate),
    path("keep-active", views.keep_active),
    path("reactivate", views.reactivate),
    path("settings", views.settings_view),
    path("run-now", views.run_now),
]
