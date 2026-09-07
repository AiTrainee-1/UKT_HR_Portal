"""
Regression tests for Report Log's Daily Report feature: the is_informed
report annotation must persist across a normal attendance recompute (it is
deliberately excluded from compute_day_record's `fields` dict, so
update_or_create's defaults=fields never touches it).

Run via: python manage.py test api.tests_report_log_daily -v 2
"""
from datetime import date, time

from django.test import TestCase

from .models import (
    Employee, ShiftTemplate, EmployeeShiftAssignment, AttendanceLog,
    AttendanceDayRecord, PayrollSettings,
)
from .attendance_final import compute_day_record


class IsInformedPersistenceTests(TestCase):
    def setUp(self):
        self.settings = PayrollSettings.get()
        self.shift = ShiftTemplate.objects.create(
            name="Informed Test Shift", shift_type="staff",
            start_time=time(9, 0), end_time=time(18, 0),
            grace_period_minutes=15, first_half_end=time(13, 30),
            lunch_duration_minutes=60, lunch_grace_minutes=10,
        )
        self.emp = Employee.objects.create(
            employee_code="INFORMEDTEST01", first_name="Informed", last_name="Test",
            employment_type="staff", status="active",
        )
        EmployeeShiftAssignment.objects.create(
            employee=self.emp, shift=self.shift, effective_from=date(2020, 1, 1),
        )

    def test_defaults_to_none(self):
        d = date(2026, 8, 3)
        record = compute_day_record(self.emp, d, settings=self.settings)
        self.assertIsNone(record.is_informed)

    def test_set_and_survives_recompute(self):
        d = date(2026, 8, 4)
        # Day with zero punches -> absent, no leave on file.
        record = compute_day_record(self.emp, d, settings=self.settings)
        self.assertEqual(record.status, "absent")

        record.is_informed = True
        record.save(update_fields=["is_informed"])

        # Recompute the same day (e.g. a later punch sync, or another page
        # reading attendance) -is_informed must not be clobbered.
        record2 = compute_day_record(self.emp, d, settings=self.settings)
        self.assertTrue(record2.is_informed)

    def test_set_false_and_survives_recompute_after_new_punches(self):
        d = date(2026, 8, 5)
        record = compute_day_record(self.emp, d, settings=self.settings)
        record.is_informed = False
        record.save(update_fields=["is_informed"])

        # A punch arrives later (e.g. late biometric sync) -status changes,
        # is_informed must still survive.
        AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=time(9, 0), punch_type="IN", source="test")
        AttendanceLog.objects.create(employee=self.emp, date=d, punch_time=time(18, 0), punch_type="IN", source="test")
        record2 = compute_day_record(self.emp, d, settings=self.settings)
        self.assertEqual(record2.status, "present")
        self.assertFalse(record2.is_informed)
