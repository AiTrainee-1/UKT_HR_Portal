"""OT detection and the HR endpoints of the Compensation overhaul: the two-type OT list, assign (relaxation / pay),
reject, the legacy announce, the compensation balance and its redemption, and what payroll pays.

Run via: python manage.py test api.tests_compensation_ot -v 2

Same fixtures as tests_compensation_engine: shift 08:30-17:30, March 2026 (Monday 2 March is day one, Sundays 1, 8, 15, ...).
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from . import tests_compensation_engine as base
from .models import (
    AttendanceDayRecord,
    AttendanceLog,
    AuditLog,
    Branch,
    CompensationLeaveCredit,
    CompensationLedger,
    Employee,
    EmployeeShiftAssignment,
    Holiday,
    HRUser,
    OvertimeRecord,
    PayrollSettings,
    Role,
)
from .attendance_final import _holiday_dates_for_month
from .overtime import detect_overtime_for_month

LIST = "/api/compensation/ot"
MON, TUE, WED, THU, FRI, SAT, SUN = base.MON, base.TUE, base.WED, base.THU, base.FRI, base.SAT, base.SUN


def branch_login(branch) -> dict:
    """The auth headers of an HR login that belongs to one branch (it sees and changes that branch only)."""
    role = Role.objects.create(name=f"Comp {branch.name}", permissions={"compensation": "edit"})
    user = HRUser.objects.create(username=f"hr_{branch.name}", password_hash="x", role=role, branch=branch)
    return base.bearer({"role": "hr", "hrUserId": user.id, "name": "Branch HR"})


class OtBase(base.CompBase):
    CODE = "OT1"

    def setUp(self):
        super().setUp()
        self.on(allowance_enabled=True, shift_enabled=True, relaxation_enabled=True, pay_enabled=True)
        self.headers = base.hr_headers()

    # ── api helpers ──
    def get_list(self, **params):
        params.setdefault("month", 3)
        params.setdefault("year", 2026)
        return self.client.get(LIST, params, **self.headers)

    def rows(self, **params) -> dict:
        body = self.get_list(**params).json()
        return {(r["employeeCode"], r["date"]): r for r in body["results"]}

    def post(self, path, body=None, headers=None):
        return self.client.post(
            f"/api/compensation{path}", body or {}, content_type="application/json", **(headers or self.headers)
        )

    def assign(self, records, mode="relaxation", **extra):
        return self.post("/ot/assign", {"records": records, "mode": mode, **extra})

    def rec_of(self, code, d) -> OvertimeRecord:
        return OvertimeRecord.objects.get(employee__employee_code=code, date=d)

    def candidate(self, last=time(21, 30), d=MON, emp=None, next_date=False):
        """A Type 2 candidate: `emp` worked until `last` (or `last` the next calendar date), listed by the detection."""
        emp = emp or self.emp
        if next_date:
            self.punch(d, time(8, 25), time(13, 0), time(14, 0), emp=emp, next_date_times=[last])
        else:
            self.worked(d, last, emp=emp)
        self.rec(d, emp)
        self.get_list()
        return OvertimeRecord.objects.get(employee=emp, date=d)

    def item(self, emp=None, d=MON, **extra):
        return {"employeeId": (emp or self.emp).id, "date": str(d), **extra}


# ── detection ───────────────────────────────────────────────────────────────


class DetectionTests(OtBase):
    def test_a_day_up_to_the_threshold_is_type_1_and_automatic(self):
        self.worked(MON, time(18, 30))  # 60 minutes
        self.rec(MON)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["otType"], row["status"], row["statusLabel"]), ("allowance", "auto", "Automatic"))
        self.assertEqual((row["allowanceMinutes"], row["otMinutes"], row["canAssign"]), (30, 60, False))
        self.assertIsNone(row["suggestedShifts"])
        self.assertIsNone(row["shifts"])
        self.assertEqual((row["lastPunchOut"], row["shiftEndTime"], row["lastPunchNextDay"]), ("18:30", "17:30", False))
        self.assertEqual(row["allowanceUsed"], False)

    def test_exactly_two_hours_thirty_is_still_type_1_and_more_is_type_2(self):
        self.worked(MON, time(20, 0))
        self.worked(TUE, time(20, 1))
        self.rec(MON)
        self.rec(TUE)
        rows = self.rows()
        self.assertEqual(
            (rows[(self.CODE, str(MON))]["otType"], rows[(self.CODE, str(MON))]["allowanceMinutes"]), ("allowance", 60)
        )
        tue = rows[(self.CODE, str(TUE))]
        self.assertEqual(
            (tue["otType"], tue["status"], tue["canAssign"], tue["suggestedShifts"]), ("shift", "detected", True, 0.25)
        )

    def test_below_an_hour_is_not_ot_at_all(self):
        self.worked(MON, time(18, 29, 59))
        self.rec(MON)
        self.assertEqual(self.rows(), {})

    def test_the_default_ladder_boundaries_on_the_last_punch(self):
        cases = {
            # last punch (same calendar day unless next_date), expected suggested shifts, shows as next-day
            "20:59": (time(20, 59), False, 0.25),
            "21:00": (time(21, 0), False, 0.5),
            "23:59": (time(23, 59), False, 0.5),
            "00:00": (time(0, 0), True, 0.75),
            "01:59": (time(1, 59), True, 0.75),
            "02:00": (time(2, 0), True, 1.0),
        }
        for i, (label, (last, next_date, _want)) in enumerate(cases.items()):
            emp = self.new_staff(f"LB{i}")
            if next_date:
                self.punch(MON, time(8, 25), time(13, 0), time(14, 0), emp=emp, next_date_times=[last])
            else:
                self.worked(MON, last, emp=emp)
            self.rec(MON, emp)
        rows = self.rows()
        for i, (label, (_last, next_date, want)) in enumerate(cases.items()):
            row = rows[(f"LB{i}", str(MON))]
            self.assertEqual(
                (row["otType"], row["suggestedShifts"], row["lastPunchNextDay"]), ("shift", want, next_date), label
            )

    def test_a_punch_at_six_in_the_morning_and_later_is_a_full_shift(self):
        ps = PayrollSettings.get()
        ps.last_punch_post_shift_grace_hours = Decimal(
            "14.0"
        )  # the forgotten exit may be made up to 07:30 next morning
        ps.save()
        self.punch(MON, time(8, 25), time(13, 0), time(14, 0), next_date_times=[time(6, 0)])
        self.rec(MON)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["otType"], row["suggestedShifts"], row["otMinutes"]), ("shift", 1.0, 750))

    def test_a_shift_that_ends_late_is_measured_from_its_own_end(self):
        late = base.make_shift(name="Late", start_time=time(11, 0), end_time=time(20, 0), first_half_end=time(14, 0))
        emp = self.new_staff("LT1", shift=late)
        # 22:45 is 165 minutes past a 20:00 end: Type 2; the clock-time ladder (before 24:00) says 0.50
        self.worked(MON, time(22, 45), emp=emp, first=time(11, 0))
        self.rec(MON, emp)
        row = self.rows()[("LT1", str(MON))]
        self.assertEqual((row["otType"], row["otMinutes"], row["suggestedShifts"]), ("shift", 165, 0.5))

    def test_detection_is_an_idempotent_upsert(self):
        self.worked(MON, time(21, 30))
        self.worked(TUE, time(18, 30))
        self.rec(MON)
        self.rec(TUE)
        first = self.get_list().json()["count"]
        ids = set(OvertimeRecord.objects.values_list("id", flat=True))
        self.get_list()
        detect_overtime_for_month(2026, 3)
        self.assertEqual(first, 2)
        self.assertEqual(OvertimeRecord.objects.count(), 2)
        self.assertEqual(set(OvertimeRecord.objects.values_list("id", flat=True)), ids)

    def test_a_decided_record_is_never_re_flagged_or_changed(self):
        rec = self.candidate()
        self.assertEqual(self.assign([self.item(shifts=0.5, claimDate=str(WED))]).status_code, 200)
        self.worked(MON, time(23, 0))  # the day changes afterwards
        self.rec(MON)
        self.get_list()
        rec.refresh_from_db()
        self.assertEqual((rec.status, rec.shifts, rec.ot_minutes), ("announced", Decimal("0.50"), 240))

    def test_a_rejected_record_stays_rejected(self):
        self.candidate()
        self.assertEqual(self.post("/ot/reject", {"records": [self.item()]}).json(), {"rejected": 1})
        self.get_list()
        self.assertEqual(self.rec_of(self.CODE, MON).status, "rejected")

    def test_an_undecided_candidate_follows_a_corrected_punch_and_disappears_when_it_no_longer_qualifies(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.rec_of(self.CODE, MON).suggested_shifts, Decimal("0.50"))
        self.worked(MON, time(20, 30))
        self.rec(MON)
        self.get_list()
        self.assertEqual(self.rec_of(self.CODE, MON).suggested_shifts, Decimal("0.25"))
        self.worked(MON, time(19, 0))  # now only 90 minutes: Type 1, the candidate row goes
        self.rec(MON)
        self.get_list()
        self.assertEqual(self.rec_of(self.CODE, MON).ot_type, "allowance")
        self.worked(MON, time(17, 0))
        self.rec(MON)
        self.get_list()
        self.assertFalse(OvertimeRecord.objects.filter(employee=self.emp, date=MON).exists())

    def test_a_type_1_row_follows_the_rules(self):
        self.worked(MON, time(19, 30))  # 120 -> 60
        self.rec(MON)
        self.get_list()
        self.assertEqual(self.rec_of(self.CODE, MON).allowance_minutes, 60)
        base.CompensationRule.objects.filter(kind="allowance", min_extra_minutes=120).update(allowance_minutes=45)
        self.get_list()
        self.assertEqual(self.rec_of(self.CODE, MON).allowance_minutes, 45)

    def test_nothing_on_a_sunday_or_a_holiday(self):
        self.worked(SUN, time(22, 0))
        Holiday.objects.create(name="Festival", date=WED)
        _holiday_dates_for_month.cache_clear()
        self.worked(WED, time(22, 0))
        self.rec(SUN)
        self.rec(WED)
        self.assertEqual(self.rows(), {})

    def test_production_is_never_listed(self):
        prod = Employee.objects.create(
            employee_code="PRO1", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.worked(MON, time(22, 0), emp=prod)
        self.rec(MON, prod)
        self.assertEqual(self.rows(), {})

    def test_the_stored_day_value_is_used_and_an_old_unrecomputed_day_still_qualifies(self):
        # a day stored before the ot_extra_minutes column existed (0), with its last punch the same evening
        self.worked(MON, time(19, 0))
        self.rec(MON)
        AttendanceDayRecord.objects.filter(employee=self.emp, date=MON).update(ot_extra_minutes=0)
        self.assertEqual(self.rows()[(self.CODE, str(MON))]["otMinutes"], 90)

    def test_the_switches_decide_what_is_detected(self):
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(21, 30))
        self.rec(MON)
        self.rec(TUE)
        base.set_config(allowance_enabled=False)
        rows = self.rows()
        self.assertEqual({k[1] for k in rows}, {str(TUE)})  # only the Type 2 candidate
        base.set_config(allowance_enabled=True, shift_enabled=False)
        OvertimeRecord.objects.all().delete()
        rows = self.rows()
        self.assertEqual({k[1] for k in rows}, {str(MON)})  # only Type 1
        base.set_config(allowance_enabled=False)
        OvertimeRecord.objects.all().delete()
        self.assertEqual(self.rows(), {})

    def test_master_switch_off_detects_nothing_and_still_lists_what_exists(self):
        self.candidate()
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.worked(TUE, time(22, 0))
        self.rec(TUE)
        rows = self.rows()
        self.assertEqual({k[1] for k in rows}, {str(MON)})  # Tuesday was not detected; Monday is still readable

    def test_type_1_rows_start_at_the_allowances_effective_from_date(self):
        base.set_config(allowance_effective_from=TUE)
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(18, 30))
        self.rec(MON)
        self.rec(TUE)
        self.assertEqual({k[1] for k in self.rows()}, {str(TUE)})

    def test_an_undecided_legacy_row_becomes_a_type_2_candidate_when_its_day_qualifies(self):
        self.worked(MON, time(21, 30))
        self.rec(MON)
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            shift_end_time=time(17, 30),
            last_punch_out=time(21, 30),
            ot_minutes=240,
            status="detected",
        )
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual(
            (row["otType"], row["status"], row["suggestedShifts"], row["canAssign"]), ("shift", "detected", 0.5, True)
        )

    def test_a_legacy_row_that_does_not_qualify_and_an_announced_legacy_row_are_left_alone(self):
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            shift_end_time=time(17, 30),
            last_punch_out=time(19, 0),
            ot_minutes=90,
            status="detected",
        )
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=TUE,
            shift_end_time=time(17, 30),
            last_punch_out=time(22, 0),
            ot_minutes=270,
            status="announced",
            compensation_type="pay",
        )
        rows = self.rows()
        self.assertEqual(
            (rows[(self.CODE, str(MON))]["otType"], rows[(self.CODE, str(MON))]["status"]), ("legacy", "detected")
        )
        tue = rows[(self.CODE, str(TUE))]
        self.assertEqual(
            (tue["otType"], tue["status"], tue["statusLabel"], tue["shifts"]),
            ("legacy", "announced", "Announced", None),
        )

    def test_filters(self):
        other = self.new_staff("OT2")
        self.worked(MON, time(18, 30))
        self.rec(MON)
        self.candidate(time(22, 0), d=TUE)
        self.candidate(time(22, 0), d=WED, emp=other)
        self.assertEqual({k for k in self.rows(status="auto")}, {(self.CODE, str(MON))})
        self.assertEqual(len(self.rows(status="detected")), 2)
        self.assertEqual(len(self.rows(type="allowance")), 1)
        self.assertEqual(len(self.rows(type="shift")), 2)
        self.assertEqual(len(self.rows(type="1")), 1)
        self.assertEqual(len(self.rows(type="2")), 2)
        self.assertEqual(len(self.rows(employeeId=other.id)), 1)
        self.assertEqual(self.assign([self.item(d=TUE, shifts=0.5, claimDate=str(THU))]).status_code, 200)
        self.assertEqual(len(self.rows(status="assigned")), 1)
        self.assertEqual(len(self.rows(status="announced")), 1)

    def test_the_old_settings_keys_are_still_answered(self):
        s = self.get_list().json()["settings"]
        self.assertTrue(s["otDetectionEnabled"])
        self.assertEqual(s["otThresholdMinutes"], 150)
        self.assertIn("otCompensationType", s)
        cfg = self.get_list().json()["config"]
        self.assertEqual((cfg["relaxationEnabled"], cfg["payEnabled"], cfg["shiftMinExtraMinutes"]), (True, True, 150))

    def test_the_allowance_use_is_shown_on_the_type_1_row(self):
        self.worked(MON, time(18, 30))
        self.worked(TUE, time(17, 40), first=time(9, 5))
        self.rec(MON)
        self.rec(TUE)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["usedOn"], row["usedMinutes"]), (True, str(TUE), 25))
        self.worked(TUE, time(17, 40), first=time(8, 35))
        self.rec(TUE)
        row = self.rows()[(self.CODE, str(MON))]
        self.assertEqual((row["allowanceUsed"], row["usedOn"]), (False, None))

    def test_a_branch_scoped_login_sees_only_its_own_branch(self):
        north, south = Branch.objects.create(name="North", code="N"), Branch.objects.create(name="South", code="S")
        a = self.new_staff("BN1", branch=north)
        b = self.new_staff("BS1", branch=south)
        for e in (a, b):
            self.worked(MON, time(22, 0), emp=e)
            self.rec(MON, e)
        who = branch_login(north)
        body = self.client.get(LIST, {"month": 3, "year": 2026}, **who).json()
        self.assertEqual({r["employeeCode"] for r in body["results"]}, {"BN1"})


# ── assign ──────────────────────────────────────────────────────────────────


class AssignTests(OtBase):
    def test_relaxation_is_applied_to_the_claim_date_at_once(self):
        self.candidate(time(21, 30))  # suggested 0.50
        r = self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["assigned"], body["skipped"]), (1, []))
        row = body["results"][0]
        self.assertEqual(
            (row["status"], row["statusLabel"], row["compensationType"], row["shifts"], row["claimDate"]),
            ("announced", "Assigned", "relaxation", 0.5, str(THU)),
        )
        self.assertEqual(row["announcedBy"], "Asha HR")
        rec = self.stored(THU)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("half_shift", Decimal("0.50"), "relaxation")
        )

    def test_shifts_can_be_changed_from_the_suggestion_to_another_step(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.assign([self.item(shifts=1, claimDate=str(THU))]).status_code, 200)
        self.assertEqual(self.rec_of(self.CODE, MON).shifts, Decimal("1.00"))
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("1.00"))

    def test_a_batch_level_shifts_and_claim_date_apply_to_every_record(self):
        other = self.new_staff("OT3")
        self.candidate(time(21, 30))
        self.candidate(time(22, 0), d=TUE, emp=other)
        r = self.assign([self.item(), self.item(emp=other, d=TUE)], shifts=0.25, claimDate=str(THU))
        self.assertEqual(r.json()["assigned"], 2, r.content)
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("0.25"))
        self.assertEqual(self.stored(THU, other).shifts_earned, Decimal("0.25"))

    def test_pay_needs_no_claim_date_and_changes_no_attendance(self):
        self.candidate(time(21, 30))
        r = self.assign([self.item(shifts=0.75)], mode="pay")
        self.assertEqual(r.status_code, 200, r.content)
        row = r.json()["results"][0]
        self.assertEqual((row["compensationType"], row["shifts"], row["claimDate"]), ("pay", 0.75, None))
        self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, compensation_kind="relaxation").exists())

    def test_pay_may_carry_a_claim_date_in_the_same_month(self):
        self.candidate(time(21, 30))
        r = self.assign([self.item(claimDate=str(FRI))], mode="pay")
        self.assertEqual(r.json()["results"][0]["claimDate"], str(FRI))

    def test_the_claim_date_must_be_in_the_same_month(self):
        self.candidate(time(21, 30))
        for bad in ("2026-04-01", "2026-02-27", "2025-03-05"):
            r = self.assign([self.item(claimDate=bad)])
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("same month", r.json()["error"])
        self.assertEqual(self.rec_of(self.CODE, MON).status, "detected")

    def test_a_past_claim_date_in_the_month_is_allowed(self):
        self.candidate(time(21, 30), d=THU)
        r = self.assign(
            [self.item(d=THU, claimDate=str(TUE))]
        )  # before the OT day itself: HR regularises a day off taken
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.stored(TUE).shifts_earned, Decimal("0.50"))

    def test_a_relaxation_needs_a_claim_date(self):
        self.candidate(time(21, 30))
        r = self.assign([self.item()])
        self.assertEqual(r.status_code, 400)
        self.assertIn("choose the date", r.json()["error"])

    def test_shifts_must_be_one_of_the_four_steps(self):
        self.candidate(time(21, 30))
        for bad in (0.3, 0, 2, "x", 1.25):
            r = self.assign([self.item(shifts=bad, claimDate=str(THU))])
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("0.25, 0.50, 0.75 or 1", r.json()["error"])
        self.assertEqual(self.assign([self.item(claimDate=str(THU))], shifts=0.3).status_code, 400)

    def test_the_mode_must_be_valid_and_enabled(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.assign([self.item(claimDate=str(THU))], mode="cash").status_code, 400)
        self.assertEqual(self.post("/ot/assign", {"records": [self.item()]}).status_code, 400)
        base.set_config(relaxation_enabled=False)
        r = self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(r.status_code, 403)
        self.assertIn("Relaxation", r.json()["error"])
        base.set_config(relaxation_enabled=True, pay_enabled=False)
        r = self.assign([self.item()], mode="pay")
        self.assertEqual(r.status_code, 403)
        self.assertIn("Payment", r.json()["error"])
        base.set_config(pay_enabled=True, shift_enabled=False)
        self.assertEqual(self.assign([self.item(claimDate=str(THU))]).status_code, 403)
        self.assertEqual(self.rec_of(self.CODE, MON).status, "detected")

    def test_the_master_switch_off_refuses_with_the_usual_reason(self):
        self.candidate(time(21, 30))
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        r = self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(r.status_code, 403)
        self.assertIn("switched off in Settings > Payroll > OT / Compensation", r.json()["error"])

    def test_a_record_can_be_assigned_only_once(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.assign([self.item(claimDate=str(THU))]).status_code, 200)
        again = self.assign([self.item(claimDate=str(FRI))])
        self.assertEqual(again.status_code, 400)
        self.assertIn("already assigned", again.json()["error"])
        self.assertEqual(again.json()["skipped"][0]["employeeId"], self.emp.id)
        self.assertEqual(self.rec_of(self.CODE, MON).claim_date, THU)
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("0.50"))
        self.assertFalse(
            AttendanceDayRecord.objects.filter(employee=self.emp, date=FRI, compensation_kind="relaxation").exists()
        )

    def test_a_partial_batch_assigns_what_it_can_and_says_why_not_for_the_rest(self):
        self.candidate(time(21, 30))
        r = self.assign([self.item(claimDate=str(THU)), self.item(d=TUE, claimDate=str(THU))])
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["assigned"], 1)
        self.assertEqual(len(body["skipped"]), 1)
        self.assertIn("No overtime record found", body["skipped"][0]["reason"])

    def test_a_type_1_row_cannot_be_assigned(self):
        self.worked(MON, time(18, 30))
        self.rec(MON)
        self.get_list()
        r = self.assign([self.item(shifts=0.25, claimDate=str(THU))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("automatic", r.json()["error"])

    def test_an_unknown_record_and_a_production_employee_are_skipped_not_crashed(self):
        prod = Employee.objects.create(
            employee_code="PRO2", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        r = self.assign(
            [
                self.item(emp=prod, claimDate=str(THU)),
                {"employeeId": 999999, "date": "2026-03-02"},
                {"employeeId": self.emp.id, "date": "x"},
            ]
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(len(r.json()["skipped"]), 3)
        # even a hand-made OT record of a production employee is refused
        OvertimeRecord.objects.create(
            employee=prod, date=MON, last_punch_out=time(22, 0), ot_minutes=270, status="detected", ot_type="shift"
        )
        r = self.assign([self.item(emp=prod, shifts=0.25, claimDate=str(THU))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("staff employees only", r.json()["error"])

    def test_no_records_is_a_400(self):
        self.assertEqual(self.post("/ot/assign", {"records": [], "mode": "pay"}).status_code, 400)

    def test_a_branch_login_cannot_assign_another_branchs_record(self):
        north, south = Branch.objects.create(name="North", code="N"), Branch.objects.create(name="South", code="S")
        a = self.new_staff("AN1", branch=north)
        self.candidate(time(22, 0), emp=a)
        who = branch_login(south)
        r = self.client.post(
            "/api/compensation/ot/assign",
            {"records": [self.item(emp=a, claimDate=str(THU))], "mode": "relaxation"},
            content_type="application/json",
            **who,
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(OvertimeRecord.objects.get(employee=a, date=MON).status, "detected")

    def test_assigning_is_audited(self):
        self.candidate(time(21, 30))
        self.assign([self.item(claimDate=str(THU))])
        log = AuditLog.objects.filter(action="assign", module="compensation").first()
        self.assertIsNotNone(log)
        self.assertIn("0.50 shift", log.record_description)
        self.assertIn(self.CODE, log.record_description)
        self.assertIn(str(THU), log.record_description)

    def test_a_non_hr_token_is_refused(self):
        emp_headers = base.bearer({"role": "employee", "employeeId": self.emp.id})
        r = self.client.post(
            "/api/compensation/ot/assign",
            {"records": [], "mode": "pay"},
            content_type="application/json",
            **emp_headers,
        )
        self.assertEqual(r.status_code, 403)

    def test_a_view_only_role_cannot_assign(self):
        role = Role.objects.create(name="Comp Viewer", permissions={"compensation": "view"})
        user = HRUser.objects.create(username="cv", password_hash="x", role=role)
        who = base.bearer({"role": "hr", "hrUserId": user.id, "name": "Viewer"})
        self.assertEqual(self.client.get(LIST, {"month": 3, "year": 2026}, **who).status_code, 200)
        r = self.client.post(
            "/api/compensation/ot/assign", {"records": [], "mode": "pay"}, content_type="application/json", **who
        )
        self.assertEqual(r.status_code, 403)

    # ── what happens on the claim date ──
    def test_never_on_a_sunday(self):
        self.candidate(time(21, 30))
        r = self.assign([self.item(claimDate=str(SUN))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("Sunday", r.json()["error"])
        self.assertEqual(self.rec_of(self.CODE, MON).status, "detected")

    def test_never_on_a_company_holiday(self):
        self.candidate(time(21, 30))
        Holiday.objects.create(name="Festival", date=THU)
        _holiday_dates_for_month.cache_clear()
        r = self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("company holiday", r.json()["error"])

    def test_never_on_an_off_saturday(self):
        EmployeeShiftAssignment.objects.filter(employee=self.emp).update(saturday_off=True)
        self.candidate(time(21, 30))
        r = self.assign([self.item(claimDate=str(SAT))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("off Saturday", r.json()["error"])

    def test_a_working_saturday_is_fine(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.assign([self.item(claimDate=str(SAT))]).status_code, 200)

    def test_never_on_an_already_full_paid_day(self):
        self.candidate(time(21, 30))
        self.worked(THU, time(17, 40), first=time(8, 35))
        r = self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("already a full paid day", r.json()["error"])
        self.assertEqual(self.rec_of(self.CODE, MON).status, "detected")

    def test_an_amount_that_would_go_past_a_full_shift_is_refused_not_shortened(self):
        self.candidate(time(21, 30))
        self.worked(THU, time(17, 40), first=time(10, 0))  # a quarter-shift arrival: 0.75
        r = self.assign([self.item(shifts=0.5, claimDate=str(THU))])
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 0.25", r.json()["error"])
        self.assertEqual(self.assign([self.item(shifts=0.25, claimDate=str(THU))]).status_code, 200)
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("1.00"))

    def test_a_half_day_worked_takes_exactly_a_half_relaxation(self):
        self.candidate(time(21, 30))
        self.punch(THU, time(8, 30), time(12, 30))
        self.assertEqual(self.assign([self.item(shifts=0.5, claimDate=str(THU))]).status_code, 200)
        self.assertEqual((self.stored(THU).status, self.stored(THU).shifts_earned), ("present", Decimal("1.00")))

    def test_an_absent_day_and_an_unpaid_leave_day_are_fine(self):
        self.candidate(time(21, 30))
        self.assertEqual(self.assign([self.item(shifts=0.5, claimDate=str(THU))]).status_code, 200)
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("0.50"))

    def test_a_manual_day_is_topped_up_in_place_once(self):
        self.candidate(time(21, 30))
        AttendanceDayRecord.objects.create(
            employee=self.emp,
            date=THU,
            status="half_shift",
            shifts_earned=Decimal("0.50"),
            is_half_shift=True,
            source="manual",
            override_by="HR",
        )
        self.assertEqual(self.assign([self.item(claimDate=str(THU))]).status_code, 200)
        rec = self.stored(THU)
        self.assertEqual(
            (rec.source, rec.shifts_earned, rec.status, rec.compensation_kind),
            ("manual", Decimal("1.00"), "present", "relaxation"),
        )
        self.rec(THU)  # a manual row is never recomputed: still exactly 1.00
        self.assertEqual(self.stored(THU).shifts_earned, Decimal("1.00"))

    def test_the_relaxation_day_survives_a_recomputation_and_a_payroll_pass(self):
        self.candidate(time(21, 30))
        self.assign([self.item(claimDate=str(THU))])
        self.assertEqual(self.month()[THU].shifts_earned, Decimal("0.50"))
        self.assertEqual(self.rec(THU).shifts_earned, Decimal("0.50"))

    def test_a_future_claim_date_is_topped_up_when_the_day_arrives(self):
        self.candidate(time(21, 30))
        with (
            mock.patch("api.compensation_apply.ist_today", return_value=WED),
            mock.patch("api.attendance_final.ist_today", return_value=WED),
        ):
            r = self.assign([self.item(claimDate="2026-03-20")])
            self.assertEqual(r.status_code, 200, r.content)
            self.assertFalse(AttendanceDayRecord.objects.filter(employee=self.emp, date=date(2026, 3, 20)).exists())
            # a second grant for the same future day cannot take it past one shift
            self.candidate(time(22, 30), d=TUE)
            r = self.assign([self.item(d=TUE, shifts=0.75, claimDate="2026-03-20")])
            self.assertEqual(r.status_code, 400)
            self.assertIn("at most 0.50", r.json()["error"])
        later = self.rec(date(2026, 3, 20))
        self.assertEqual((later.shifts_earned, later.compensation_kind), (Decimal("0.50"), "relaxation"))


# ── legacy announce, reject ─────────────────────────────────────────────────


class AnnounceAndRejectTests(OtBase):
    def legacy(self, d=MON, **kw):
        defaults = dict(
            shift_end_time=time(17, 30),
            last_punch_out=time(19, 30),
            ot_minutes=120,
            status="detected",
        )
        defaults.update(kw)
        return OvertimeRecord.objects.create(employee=self.emp, date=d, **defaults)

    def test_a_legacy_record_keeps_its_old_meaning_for_pay_and_for_relaxation(self):
        self.legacy(MON)
        self.legacy(TUE)
        r = self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"})
        self.assertEqual(r.json()["announced"], 1)
        pay = self.rec_of(self.CODE, MON)
        self.assertEqual(
            (pay.status, pay.compensation_type, pay.shifts, pay.ot_type), ("announced", "pay", None, "legacy")
        )
        r = self.post("/ot/announce", {"records": [self.item(d=TUE)], "compensationType": "relaxation"})
        self.assertEqual(r.json()["announced"], 1)
        self.assertEqual(CompensationLeaveCredit.objects.filter(employee=self.emp).count(), 1)
        self.assertFalse(CompensationLedger.objects.exists())

    def test_announce_maps_a_type_2_record_onto_its_suggested_shifts(self):
        self.candidate(time(21, 30))  # suggested 0.50
        r = self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"})
        self.assertEqual(r.json()["announced"], 1)
        rec = self.rec_of(self.CODE, MON)
        self.assertEqual((rec.status, rec.compensation_type, rec.shifts), ("announced", "pay", Decimal("0.50")))

    def test_announce_of_a_type_2_relaxation_without_a_date_goes_to_the_balance(self):
        self.candidate(time(21, 30))
        r = self.post("/ot/announce", {"records": [self.item()], "compensationType": "relaxation"})
        self.assertEqual(r.json()["announced"], 1)
        entry = CompensationLedger.objects.get(employee=self.emp)
        self.assertEqual((entry.entry_type, entry.shifts, entry.source), ("credit", Decimal("0.50"), "ot_shift"))
        self.assertFalse(CompensationLeaveCredit.objects.exists())
        self.assertEqual(self.get_balance()["balance"], 0.5)

    def test_announce_skips_type_1_and_a_disabled_mode_and_a_candidate_with_no_suggestion(self):
        self.worked(MON, time(18, 30))
        self.rec(MON)
        self.get_list()
        self.assertEqual(
            self.post("/ot/announce", {"records": [self.item()], "compensationType": "pay"}).json()["announced"], 0
        )
        self.candidate(time(21, 30), d=TUE)
        base.set_config(pay_enabled=False)
        self.assertEqual(
            self.post("/ot/announce", {"records": [self.item(d=TUE)], "compensationType": "pay"}).json()["announced"], 0
        )
        OvertimeRecord.objects.filter(employee=self.emp, date=TUE).update(suggested_shifts=None)
        base.set_config(pay_enabled=True)
        self.assertEqual(
            self.post("/ot/announce", {"records": [self.item(d=TUE)], "compensationType": "pay"}).json()["announced"], 0
        )

    def test_announce_validates_its_input(self):
        self.assertEqual(self.post("/ot/announce", {"records": []}).status_code, 400)
        self.assertEqual(
            self.post("/ot/announce", {"records": [self.item()], "compensationType": "cash"}).status_code, 400
        )

    def test_reject_works_on_candidates_only(self):
        self.candidate(time(21, 30))
        self.worked(TUE, time(18, 30))
        self.rec(TUE)
        self.get_list()
        self.assertEqual(
            self.post("/ot/reject", {"records": [self.item(d=TUE)]}).json(), {"rejected": 0}
        )  # Type 1: nothing to reject
        self.assertEqual(self.post("/ot/reject", {"records": [self.item()]}).json(), {"rejected": 1})
        self.assertEqual(self.post("/ot/reject", {"records": [self.item()]}).json(), {"rejected": 0})  # already decided
        self.assertEqual(
            self.assign([self.item(claimDate=str(THU))]).status_code, 400
        )  # and a rejected one cannot be assigned

    def get_balance(self, emp=None):
        return self.client.get("/api/compensation/balance", {"employeeId": (emp or self.emp).id}, **self.headers).json()


# ── balance and redemption ──────────────────────────────────────────────────


class BalanceTests(OtBase):
    def credit(self, shifts, d=MON, emp=None, source="holiday_work"):
        return CompensationLedger.objects.create(
            employee=emp or self.emp, entry_type="credit", shifts=Decimal(shifts), date=d, source=source
        )

    def balance(self, emp=None):
        return self.client.get("/api/compensation/balance", {"employeeId": (emp or self.emp).id}, **self.headers).json()

    def redeem(self, d, shifts, emp=None, headers=None):
        return self.client.post(
            "/api/compensation/balance/redeem",
            {"employeeId": (emp or self.emp).id, "date": str(d), "shifts": shifts},
            content_type="application/json",
            **(headers or self.headers),
        )

    def test_an_empty_balance(self):
        body = self.balance()
        self.assertEqual((body["balance"], body["entries"]), (0.0, []))
        self.assertEqual(body["employeeCode"], self.CODE)

    def test_credits_and_redemptions_make_the_balance(self):
        self.credit("1.00")
        self.credit("0.50", d=TUE)
        self.assertEqual(self.balance()["balance"], 1.5)
        r = self.redeem(THU, 0.75)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(
            (body["entry"]["type"], body["entry"]["shifts"], body["entry"]["source"], body["balance"]),
            ("debit", 0.75, "redemption", 0.75),
        )
        self.assertEqual(self.balance()["balance"], 0.75)
        entries = self.balance()["entries"]
        self.assertEqual(
            sorted((e["type"], e["shifts"]) for e in entries), [("credit", 0.5), ("credit", 1.0), ("debit", 0.75)]
        )

    def test_a_redemption_tops_the_day_up_and_marks_it(self):
        self.credit("1.00")
        self.assertEqual(self.redeem(THU, 0.5).status_code, 201)
        rec = self.stored(THU)
        self.assertEqual(
            (rec.status, rec.shifts_earned, rec.compensation_kind), ("half_shift", Decimal("0.50"), "relaxation")
        )
        self.assertIn("the compensation balance", rec.compensation_note)
        self.assertEqual(self.redeem(THU, 0.5).status_code, 201)  # the other half
        self.assertEqual((self.stored(THU).status, self.stored(THU).shifts_earned), ("present", Decimal("1.00")))
        self.assertEqual(self.balance()["balance"], 0.0)

    def test_partial_amounts_of_a_quarter_to_a_full_shift(self):
        for _ in range(3):
            self.credit("1.00")
        spent = Decimal("0")
        for shifts, d in ((0.25, WED), (0.5, THU), (0.75, FRI), (1, SAT)):
            self.assertEqual(self.redeem(d, shifts).status_code, 201, shifts)
            spent += Decimal(str(shifts))
            self.assertEqual(self.stored(d).shifts_earned, Decimal(str(shifts)).quantize(Decimal("0.01")), shifts)
        self.assertEqual(self.balance()["balance"], float(Decimal("3.00") - spent))

    def test_more_than_the_balance_is_refused(self):
        self.credit("0.50")
        r = self.redeem(THU, 0.75)
        self.assertEqual(r.status_code, 400)
        self.assertIn("balance is 0.50", r.json()["error"])
        self.assertEqual(self.balance()["balance"], 0.5)
        self.assertFalse(CompensationLedger.objects.filter(entry_type="debit").exists())
        self.assertEqual(self.redeem(THU, 0.5).status_code, 201)
        self.assertEqual(self.redeem(FRI, 0.25).status_code, 400)  # now empty

    def test_the_amount_must_be_one_of_the_four_steps(self):
        self.credit("1.00")
        for bad in (0.3, 0, "x", None, 2):
            self.assertEqual(self.redeem(THU, bad).status_code, 400, bad)

    def test_the_date_rules_are_those_of_a_relaxation(self):
        self.credit("1.00")
        self.assertIn("Sunday", self.redeem(SUN, 0.5).json()["error"])
        self.worked(THU, time(17, 40), first=time(8, 35))
        self.assertIn("already a full paid day", self.redeem(THU, 0.5).json()["error"])
        self.worked(FRI, time(17, 40), first=time(10, 0))  # 0.75
        self.assertIn("at most 0.25", self.redeem(FRI, 0.5).json()["error"])
        self.assertEqual(self.balance()["balance"], 1.0)  # none of the refusals spent anything
        self.assertEqual(
            self.client.post(
                "/api/compensation/balance/redeem",
                {"employeeId": self.emp.id, "shifts": 0.5},
                content_type="application/json",
                **self.headers,
            ).status_code,
            400,
        )

    def test_a_legacy_credit_counts_as_one_shift_until_it_is_used(self):
        ot = OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="relaxation",
        )
        credit = CompensationLeaveCredit.objects.create(employee=self.emp, source_overtime_record=ot)
        body = self.balance()
        self.assertEqual(body["balance"], 1.0)
        self.assertEqual(
            [(e["source"], e["shifts"], e["type"]) for e in body["entries"]], [("legacy_credit", 1.0, "credit")]
        )
        # the old redeem endpoint keeps working: a manual paid day, the credit used, and a ledger debit mirroring it
        r = self.client.post(
            f"/api/compensation/credits/{credit.id}/redeem",
            {"date": str(THU)},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.stored(THU)
        self.assertEqual(
            (rec.source, rec.status, rec.shifts_earned, rec.compensation_kind),
            ("manual", "present", Decimal("1.00"), "relaxation"),
        )
        debit = CompensationLedger.objects.get(employee=self.emp)
        self.assertEqual(
            (debit.entry_type, debit.shifts, debit.source, debit.date), ("debit", Decimal("1.00"), "legacy_credit", THU)
        )
        self.assertEqual(self.balance()["balance"], 0.0)  # used once, not subtracted twice

    def test_a_used_legacy_credit_does_not_count_and_ledger_credits_still_do(self):
        ot = OvertimeRecord.objects.create(
            employee=self.emp,
            date=MON,
            last_punch_out=time(20, 0),
            ot_minutes=150,
            status="announced",
            compensation_type="relaxation",
        )
        CompensationLeaveCredit.objects.create(
            employee=self.emp, source_overtime_record=ot, status="used", used_date=TUE
        )
        self.credit("0.25")
        self.assertEqual(self.balance()["balance"], 0.25)

    def test_the_balance_list_without_an_employee(self):
        other = self.new_staff("BL2")
        self.credit("1.00")
        self.credit("0.50", emp=other)
        self.redeem(THU, 0.5, emp=other)
        body = self.client.get("/api/compensation/balance", **self.headers).json()
        self.assertEqual({(r["employeeCode"], r["balance"]) for r in body["results"]}, {(self.CODE, 1.0), ("BL2", 0.0)})

    def test_staff_only_and_branch_scoped(self):
        prod = Employee.objects.create(
            employee_code="PRB1", first_name="Pro", last_name="Duction", employment_type="production", status="active"
        )
        self.credit("1.00", emp=prod)
        self.assertEqual(
            self.client.get("/api/compensation/balance", {"employeeId": prod.id}, **self.headers).status_code, 404
        )
        r = self.redeem(THU, 0.5, emp=prod)
        self.assertEqual(r.status_code, 400)
        north = Branch.objects.create(name="North", code="N")
        south = Branch.objects.create(name="South", code="S")
        a = self.new_staff("BB1", branch=north)
        self.credit("1.00", emp=a)
        who = branch_login(south)
        self.assertEqual(self.client.get("/api/compensation/balance", {"employeeId": a.id}, **who).status_code, 404)
        self.assertEqual(self.redeem(THU, 0.5, emp=a, headers=who).status_code, 404)

    def test_the_master_switch_off_refuses_a_redemption_but_not_the_reading(self):
        self.credit("1.00")
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        self.assertEqual(self.redeem(THU, 0.5).status_code, 403)
        self.assertEqual(self.balance()["balance"], 1.0)

    def test_a_redemption_is_audited(self):
        self.credit("1.00")
        self.redeem(THU, 0.5)
        log = AuditLog.objects.filter(action="redeem", module="compensation").first()
        self.assertIsNotNone(log)
        self.assertIn("0.50 shift", log.record_description)

    def test_redeeming_never_goes_below_zero_even_if_asked_twice_in_a_row(self):
        self.credit("0.50")
        results = [self.redeem(THU, 0.5).status_code, self.redeem(FRI, 0.5).status_code]
        self.assertEqual(results, [201, 400])
        self.assertEqual(CompensationLedger.objects.filter(entry_type="debit").count(), 1)


# ── payroll ─────────────────────────────────────────────────────────────────


class PayrollOtPayTests(OtBase):
    """OT pay = the sum of the month's announced PAY records of (shifts or 1.00) x the daily rate payroll already uses.
    March 2026 has 26 working days, so a 26,000 salary has a daily rate of exactly 1,000."""

    def setUp(self):
        super().setUp()
        for i in range(2, 32):
            d = date(2026, 3, i)
            if d.weekday() != 6:
                self.worked(d, time(17, 40), first=time(8, 35))

    def pay_record(self, d, shifts=None, **kw):
        defaults = dict(
            shift_end_time=time(17, 30),
            last_punch_out=time(21, 30),
            ot_minutes=240,
            status="announced",
            compensation_type="pay",
            ot_type="shift" if shifts is not None else "legacy",
            shifts=Decimal(shifts) if shifts is not None else None,
        )
        defaults.update(kw)
        return OvertimeRecord.objects.create(employee=self.emp, date=d, **defaults)

    def run_payroll(self, month=3):
        from .payroll_views import _generate_staff_payroll

        return _generate_staff_payroll(self.emp, month, 2026)

    def test_shifts_times_the_daily_rate(self):
        for shifts, expected in [("0.25", "250.00"), ("0.50", "500.00"), ("0.75", "750.00"), ("1.00", "1000.00")]:
            OvertimeRecord.objects.all().delete()
            self.pay_record(date(2026, 3, 3), shifts)
            r = self.run_payroll()
            self.assertEqual(r["payroll"].ot_amount, Decimal(expected), shifts)
            self.assertEqual(r["slip"].ot_amount, Decimal(expected), shifts)
            self.assertEqual(r["payroll"].final_salary, Decimal("26000.00") + Decimal(expected), shifts)
            self.assertEqual(r["payroll"].gross_salary, Decimal("26000.00"), shifts)  # OT is kept out of gross as ever

    def test_several_records_add_up(self):
        self.pay_record(date(2026, 3, 3), "0.25")
        self.pay_record(date(2026, 3, 4), "0.50")
        self.pay_record(date(2026, 3, 5), "1.00")
        self.assertEqual(self.run_payroll()["payroll"].ot_amount, Decimal("1750.00"))

    def test_the_breakdown_says_how_many_records_and_how_many_shifts(self):
        self.pay_record(date(2026, 3, 3), "0.25")
        self.pay_record(date(2026, 3, 4), "0.50")
        earnings = self.run_payroll()["slip"].breakdown_details["earnings"]
        self.assertEqual((earnings["otDays"], earnings["otShifts"], earnings["otAmount"]), (2, 0.75, 750.0))

    def test_legacy_records_pay_exactly_what_they_always_paid(self):
        # the old fixture of tests_payroll_engine: two announced pay records (no shifts) -> two days' salary
        self.pay_record(date(2026, 3, 3))
        self.pay_record(date(2026, 3, 4))
        r = self.run_payroll()
        self.assertEqual(r["payroll"].ot_amount, Decimal("2000.00"))
        self.assertEqual(r["payroll"].final_salary, Decimal("28000.00"))
        earnings = r["slip"].breakdown_details["earnings"]
        self.assertEqual((earnings["otDays"], earnings["otShifts"]), (2, 2.0))

    def test_legacy_and_shift_records_together(self):
        self.pay_record(date(2026, 3, 3))
        self.pay_record(date(2026, 3, 4), "0.50")
        self.assertEqual(self.run_payroll()["payroll"].ot_amount, Decimal("1500.00"))

    def test_relaxation_type_1_detected_and_rejected_records_never_pay(self):
        self.pay_record(date(2026, 3, 3), "0.50", compensation_type="relaxation", claim_date=date(2026, 3, 10))
        self.pay_record(date(2026, 3, 4), "0.50", status="detected")
        self.pay_record(date(2026, 3, 5), "0.50", status="rejected")
        self.pay_record(
            date(2026, 3, 6), "0.50", ot_type="allowance", status="auto", compensation_type=None, allowance_minutes=30
        )
        # even a (wrongly) paid-looking Type 1 row pays nothing
        self.pay_record(date(2026, 3, 9), "0.50", ot_type="allowance", compensation_type="pay")
        self.assertEqual(self.run_payroll()["payroll"].ot_amount, Decimal("0.00"))

    def test_only_this_months_records_count(self):
        self.pay_record(date(2026, 2, 27), "1.00")
        self.pay_record(date(2026, 4, 1), "1.00")
        self.pay_record(date(2026, 3, 3), "0.25")
        self.assertEqual(self.run_payroll()["payroll"].ot_amount, Decimal("250.00"))

    def test_the_master_switch_off_pays_nothing_as_it_always_did(self):
        self.pay_record(date(2026, 3, 3), "1.00")
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = False
        ps.save()
        r = self.run_payroll()
        self.assertEqual((r["payroll"].ot_amount, r["payroll"].final_salary), (Decimal("0.00"), Decimal("26000.00")))

    def test_the_features_own_switches_do_not_take_back_a_pay_record_already_assigned(self):
        self.pay_record(date(2026, 3, 3), "0.50")
        base.set_config(shift_enabled=False, pay_enabled=False)
        self.assertEqual(self.run_payroll()["payroll"].ot_amount, Decimal("500.00"))

    def test_a_relaxation_day_is_paid_through_attendance_not_as_ot(self):
        # THU is a day the employee did not come in; a 0.50 relaxation makes it half a day's pay
        AttendanceLog.objects.filter(employee=self.emp, date=THU).delete()  # THU: the employee did not come in
        self.assertEqual(self.run_payroll()["payroll"].gross_salary, Decimal("25000.00"))  # one absent day
        OvertimeRecord.objects.create(
            employee=self.emp,
            date=TUE,
            last_punch_out=time(21, 30),
            ot_minutes=240,
            status="announced",
            compensation_type="relaxation",
            ot_type="shift",
            shifts=Decimal("0.50"),
            claim_date=THU,
        )
        r = self.run_payroll()
        self.assertEqual(r["payroll"].gross_salary, Decimal("25500.00"))
        self.assertEqual(r["payroll"].ot_amount, Decimal("0.00"))
