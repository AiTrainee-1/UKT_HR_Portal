"""/api/request-auto-reject/... (views.py)."""

from django.urls import path

from . import views

urlpatterns = [
    path("config", views.config_view),
    path("run-now", views.run_now),
    path("history", views.history),
]
