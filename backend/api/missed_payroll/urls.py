"""/api/missed-payroll/... (views.py)."""

from django.urls import path

from . import views

urlpatterns = [
    path("employees", views.employees),
    path("entry", views.entry),
    path("generate", views.generate),
    path("clear", views.clear),
    path("unclear", views.unclear),
    path("discard", views.discard),
    path("done", views.done),
    path("paid", views.paid),
    path("bank-check", views.bank_check),
    path("download/report", views.download_report),
    path("download/statement", views.download_statement),
    path("download/bank-file", views.download_bank_file),
]
