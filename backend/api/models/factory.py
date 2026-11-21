"""Employees -> Factory Employees (/hr/employees/factory-emp, api/factory_employee_views.py): drivers, housekeeping,
chefs, security and other factory support staff (owner 2026-11-20).

A factory employee is an ordinary Employee with `is_factory` set and an optional FactoryLabel, so attendance and both
payrolls treat them exactly like everyone else (employment type staff -> Staff Payroll, production -> Production
Payroll). The labels are the page's own grouping, created and edited there.
"""

from django.db import models
from django.db.models.functions import Lower


class FactoryLabel(models.Model):
    name = models.TextField()
    color = models.TextField(default="#4f46e5")
    description = models.TextField(blank=True, default="")
    sort_order = models.IntegerField(default=0)
    created_by_name = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "factory_employee_labels"
        ordering = ["sort_order", "name", "id"]
        constraints = [models.UniqueConstraint(Lower("name"), name="factory_label_name_unique_ci")]

    def __str__(self) -> str:
        return self.name
