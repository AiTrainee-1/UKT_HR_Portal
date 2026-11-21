"""Staff Payroll page additions of 2026-11-20 (payroll_excess_views.py): the Excess tab, the Payroll tab's Not included
view and the Payslip tab. One routes file so these never edit the same lines as the rest of urls.py."""

from django.urls import path

from . import payroll_excess_views as v

urlpatterns = [
    path("payroll-excess/month", v.excess_month),
    path("payroll-excess/entries", v.excess_add),
    path("payroll-excess/entries/<int:pk>", v.excess_change),
    path("payroll-excess/remove", v.excess_remove),
    path("payroll-excess/history", v.excess_history),
    path("payroll/not-included", v.not_included),
    path("payslips/staff", v.staff_payslips),
    path("payslips/staff/pdf", v.staff_payslips_pdf),
    # Production Payroll (one pay cycle's period): the same three
    path("production-payroll-excess/period", v.production_excess_period),
    path("production-payroll-excess/entries", v.production_excess_add),
    path("production-payroll-excess/entries/<int:pk>", v.production_excess_change),
    path("production-payroll-excess/remove", v.production_excess_remove),
    path("production-payroll-excess/history", v.production_excess_history),
    path("payroll/production/not-included", v.production_not_included),
    path("payslips/production", v.production_payslips),
    path("payslips/production/pdf", v.production_payslips_pdf),
]
