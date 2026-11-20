"""/api/salary-slip-center/... (views.py)."""

from django.urls import path

from . import views

urlpatterns = [
    path("employees", views.employees),
    path("preview", views.preview),
    path("slip", views.saved_slip),
    path("generate", views.generate),
    path("hold", views.hold),
    path("bank-check", views.bank_check),
    path("download/slips", views.download_slips),
    path("download/statement", views.download_statement),
    path("download/bank-file", views.download_bank_file),
]
