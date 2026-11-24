"""Routes for Employee Enquiries (2026-11-24). Included from api/urls.py. See enquiry_views.py."""

from django.urls import path

from .enquiry_views import enquiries_hr, enquiries_summary, my_enquiries, update_enquiry

urlpatterns: list = [
    path("my/enquiries", my_enquiries),
    path("enquiries", enquiries_hr),
    path("enquiries/summary", enquiries_summary),
    path("enquiries/<int:pk>", update_enquiry),
]
