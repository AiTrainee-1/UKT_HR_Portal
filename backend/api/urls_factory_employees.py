"""Employees -> Factory Employees (factory_employee_views.py)."""

from django.urls import path

from . import factory_employee_views as v

urlpatterns = [
    path("employees/factory", v.factory_employees),
    path("employees/factory/candidates", v.factory_candidates),
    path("employees/factory/add", v.factory_add),
    path("employees/factory/remove", v.factory_remove),
    path("employees/factory/label", v.factory_assign_label),
    path("employees/factory/labels", v.factory_labels),
    path("employees/factory/labels/<int:pk>", v.factory_label_detail),
    path("employees/factory/<int:pk>/history", v.factory_history),
    path("employees/factory/shifts", v.factory_shifts),
    path("employees/factory/shifts/plan", v.factory_shift_plan),
    path("employees/factory/shifts/apply", v.factory_shift_apply),
    path("employees/factory/shifts/remove", v.factory_shift_remove),
    path("employees/factory/payroll", v.factory_payroll),
]
