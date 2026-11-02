"""Routes for the 2026-10-31 mobile pages round (pay). Included from api/urls.py; owned by that slice only."""

from django.urls import path

from .mobile_pay_views import my_compensation_history, my_salary_insights, my_salary_slip_breakdown

urlpatterns: list = [
    path("my/salary-insights", my_salary_insights),
    path("my/salary-slips/<int:pk>/breakdown", my_salary_slip_breakdown),
    path("my/compensation-history", my_compensation_history),
]
