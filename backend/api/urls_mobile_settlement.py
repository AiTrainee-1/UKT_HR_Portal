"""Routes for the 2026-10-31 mobile pages round (settlement). Included from api/urls.py; owned by that slice only.

Employee self-service Salary Advance and Term Loan (mobile_settlement_views.py). HR keeps /api/advances.
"""

from django.urls import path

from .mobile_settlement_views import my_advance_detail, my_advance_eligibility, my_advances

urlpatterns: list = [
    path("my/advances/eligibility", my_advance_eligibility),
    path("my/advances/<int:pk>", my_advance_detail),
    path("my/advances", my_advances),
]
