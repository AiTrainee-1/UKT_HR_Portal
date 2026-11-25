"""Routes for the mobile Home page's "My Insights" (owner 2026-11-25). Included from api/urls.py."""

from django.urls import path

from .mobile_analytics_views import my_analytics

urlpatterns: list = [
    path("my/analytics", my_analytics),
]
