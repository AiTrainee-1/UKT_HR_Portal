"""Report Center -> Customise: the reports HR builds and saves themselves (api/reporting/custom/).

    SavedCustomReport   one saved report: a data source (dataset), the chosen fields in order, the filter values and the
                        sort. It is run and exported through the ordinary Report Center endpoints as ``custom-<id>``.

Every saved report is a team library entry: everyone with view on Reports -> Customise sees and runs it; who may change or
delete it is decided in api/reporting/custom/views.py. Nothing here is a figure: the rows always come from the HRMS data
at run time, so a saved report can never go stale.
"""

from django.db import models

from .accounts import HRUser


class SavedCustomReport(models.Model):
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    # The data source (reporting/custom/datasets: employees | attendance_days | punches | requests | payroll)
    dataset = models.CharField(max_length=40)
    # The chosen field keys, in column order (e.g. ["emp.code", "emp.name", "att.present_days", "pay.net"])
    fields = models.JSONField(default=list)
    # {filter param: value} in the Report Center query-parameter format (dateFrom, dateTo, period, departmentIds ...)
    filters = models.JSONField(default=dict, blank=True)
    # [{"key": field key, "dir": "asc" | "desc"}], first key first; empty = the data source's own order
    sort = models.JSONField(default=list, blank=True)
    created_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="created_by_id", related_name="+"
    )
    updated_by = models.ForeignKey(
        HRUser, on_delete=models.SET_NULL, null=True, blank=True, db_column="updated_by_id", related_name="+"
    )
    # The names as they were, so the library still says who made a report after that account is removed
    created_by_name = models.TextField(blank=True, default="", db_column="created_by_name")
    updated_by_name = models.TextField(blank=True, default="", db_column="updated_by_name")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "saved_custom_reports"
        ordering = ["name", "id"]

    def __str__(self) -> str:
        return f"{self.name} ({self.dataset})"
