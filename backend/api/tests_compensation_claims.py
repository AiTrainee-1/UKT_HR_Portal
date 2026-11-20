"""
Compensation claims (2026-11-19): the one claim workflow for every kind, raised by the employee (mobile app / Employee Web
App) or by HR on their behalf, decided by the employee's Department Head.

Covers compensation_claims.py (create_claim / eligibility / decide / credit_or_debit) through the endpoints of
compensation_claims_views.py and the HOD endpoints: every kind created by the employee and by HR, every refusal code,
approve / reject per kind with the ledger written exactly once and compensation_effects.after_claim_decided called after
the commit, OT records that are paid vs claimed, the balance with pending use requests, withdrawing, branch scope,
permissions, the HOD lists / counts, the employee app contract, the MD path and the old-date (before claims_from) rules.

compensation_effects (BE-2) is mocked: these tests pin the claim side only (credit 0.75 by the quarters rule, a worked
birthday, no refusal). CompensationConfig.claims_from is set explicitly (the test-DB time bomb: migration 0166 sets it to
the real date of the run).

Run via: python manage.py test api.tests_compensation_claims
"""

from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from . import approval_workflow as approval
from . import compensation_claims as claims
from . import compensation_effects as effects
from .jwt_utils import sign_token
from .models import (
    AttendanceLog,
    Branch,
    CompensationConfig,
    CompensationLedger,
    Department,
    DepartmentManager,
    Employee,
    HolidayWorkClaim,
    HRUser,
    ManagerDepartmentAssignment,
    Notification,
    OvertimeRecord,
    PayrollSettings,
    Role,
)

TODAY = date(2026, 10, 14)  # a Wednesday
CLAIMS_FROM = date(2026, 10, 1)
SUNDAY = date(2026, 10, 11)
HOLIDAY = date(2026, 10, 2)  # a Friday, declared below
OT_SHIFT_DAY = date(2026, 10, 12)  # Monday
OT_ALLOW_DAY = date(2026, 10, 13)  # Tuesday
BIRTHDAY = date(2026, 10, 9)  # a Friday
USE_DAY = date(2026, 10, 20)  # a Tuesday in the request window

TODAY_PATCHES = (
    "api.compensation_claims.ist_today",
    "api.compensation_claims_views.ist_today",
    "api.holiday_work_views.ist_today",
    "api.employee_compensation_views.ist_today",
    "api.request_window.ist_today",
)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _hr_user(username, permissions=None, branch=None, super_admin=False) -> HRUser:
    role = Role.objects.create(name=f"role_{username}", permissions=permissions) if permissions is not None else None
    return HRUser.objects.create(
        username=username,
        password_hash="x",
        full_name=username.title(),
        role=role,
        branch=branch,
        is_super_admin=super_admin,
    )


def _hr(user: HRUser) -> dict:
    return _bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name})


def _emp_token(emp) -> dict:
    return _bearer({"role": "employee", "employeeId": emp.id})


def _employee(code, branch, department, kind="staff", **kw) -> Employee:
    return Employee.objects.create(
        employee_code=code,
        first_name=code,
        last_name="Cl",
        employment_type=kind,
        status="active",
        branch=branch,
        department=department,
        **kw,
    )


def _punch(emp, day):
    AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(9, 0), punch_type="IN", source="biometric")
    AttendanceLog.objects.create(employee=emp, date=day, punch_time=time(17, 0), punch_type="OUT", source="biometric")


class ClaimsBase(TestCase):
    def setUp(self):
        from .attendance_final import _holiday_dates_for_month

        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        # the declared holiday below is cached per month: never leak it into a later test module (a payroll of October
        # 2026 would pay it as a holiday)
        _holiday_dates_for_month.cache_clear()
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        for target in TODAY_PATCHES:
            patch = mock.patch(target, return_value=TODAY)
            patch.start()
            self.addCleanup(patch.stop)
        # BE-2's side, pinned: a 0.75 credit by the quarters rule, a worked birthday, nothing refused
        self.ot_credit = self._patch("staff_ot_credit", return_value=Decimal("0.75"))
        self.quarter_rule = self._patch("quarter_rule_applies", return_value=True)
        self.birthday = self._patch(
            "birthday_outcome", return_value={"outcome": effects.BIRTHDAY_CREDIT_CLAIMABLE, "message": "", "shifts": 1}
        )
        self.check = self._patch("check_claim_effects", return_value=None)
        self.after = self._patch("after_claim_decided", return_value=None)
        # the approval's own evidence refresh (the day worked out again + the OT row brought in step) is the attendance
        # side too: the OT records below are made by hand with no punches behind them (tests_comp_fix_v covers it for real)
        refresh = mock.patch.object(claims, "_refresh_evidence", return_value=None)
        refresh.start()
        self.addCleanup(refresh.stop)

        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = True
        settings.save()
        CompensationConfig.objects.update_or_create(
            pk=1,
            defaults={
                "holiday_work_enabled": True,
                "allowance_enabled": True,
                "shift_enabled": True,
                "birthday_enabled": True,
                "pay_enabled": True,
                "relaxation_enabled": True,
                "claims_from": CLAIMS_FROM,
                # migration 0167 seeds the quarters rule's history with the real date of the run: the field decides
                "ot_quarter_rule_history": [],
            },
        )
        from .models import Holiday

        Holiday.objects.create(name="Gandhi Jayanti", date=HOLIDAY)
        self.ho = Branch.objects.create(name="CL Head Office", code="CLHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="CL Unit 2", code="CLU2")
        self.cutting = Department.objects.create(name="CL Cutting", branch=self.ho)
        self.sewing = Department.objects.create(name="CL Sewing", branch=self.u2)
        self.asha = _employee("CL1", self.ho, self.cutting, date_of_birth=date(1990, 10, 9))
        self.ravi = _employee("CL2", self.ho, self.cutting)
        self.mani = _employee("CL3", self.u2, self.sewing)  # no Department Head
        self.prod = _employee("CLP", self.ho, self.cutting, kind="production")
        self.boss = _employee("CLB", self.ho, self.cutting)
        self.manager = DepartmentManager.objects.create(employee=self.boss)
        ManagerDepartmentAssignment.objects.create(manager=self.manager, department=self.cutting)

        self.admin_user = _hr_user("cl_admin", super_admin=True)
        self.admin = _hr(self.admin_user)
        self.view_only = _hr(_hr_user("cl_view", {"compensation": "view"}))
        self.ho_hr = _hr(_hr_user("cl_ho", {"compensation": "edit"}, branch=self.ho))
        self.asha_t = _emp_token(self.asha)
        self.hod = _emp_token(self.boss)

        for emp in (self.asha, self.ravi, self.mani, self.prod, self.boss):
            _punch(emp, SUNDAY)
        self.shift_rec = OvertimeRecord.objects.create(
            employee=self.asha,
            date=OT_SHIFT_DAY,
            shift_end_time=time(18, 0),
            last_punch_out=time(23, 0),
            ot_minutes=300,
            ot_type=OvertimeRecord.OT_TYPE_SHIFT,
            status=OvertimeRecord.STATUS_DETECTED,
            suggested_shifts=Decimal("0.50"),
        )
        self.allow_rec = OvertimeRecord.objects.create(
            employee=self.asha,
            date=OT_ALLOW_DAY,
            shift_end_time=time(18, 0),
            last_punch_out=time(19, 0),
            ot_minutes=60,
            ot_type=OvertimeRecord.OT_TYPE_ALLOWANCE,
            status=OvertimeRecord.STATUS_AUTO,
            allowance_minutes=30,
        )

    def _patch(self, name, **kw):
        patch = mock.patch.object(effects, name, **kw)
        started = patch.start()
        self.addCleanup(patch.stop)
        return started

    # requests
    def emp_claim(self, body, who=None):
        return self.client.post(
            "/api/employee/compensation/claims", body, content_type="application/json", **(who or self.asha_t)
        )

    def emp_use(self, body, who=None):
        return self.client.post(
            "/api/employee/compensation/use", body, content_type="application/json", **(who or self.asha_t)
        )

    def hr_claim(self, body, who=None):
        return self.client.post(
            "/api/compensation/claims", body, content_type="application/json", **(who or self.admin)
        )

    def hr_use(self, body, who=None):
        return self.client.post("/api/compensation/use", body, content_type="application/json", **(who or self.admin))

    def decide(self, claim_id, decision="approved", comment=None, who=None):
        body = {"status": decision}
        if comment:
            body["comment"] = comment
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.patch(
                f"/api/manager/holiday-work/{claim_id}/status",
                body,
                content_type="application/json",
                **(who or self.hod),
            )

    def get(self, path, who=None, **params):
        return self.client.get(path, params, **(who or self.admin))

    def credit(self, emp, shifts="1.00"):
        return CompensationLedger.objects.create(
            employee=emp, entry_type="credit", shifts=Decimal(shifts), date=SUNDAY, source="holiday_work"
        )

    def made(self, response, status=201) -> HolidayWorkClaim:
        self.assertEqual(response.status_code, status, response.content)
        return HolidayWorkClaim.objects.get(pk=response.json()["id"])


# ═════════════════════════════ the employee raises every kind ═════════════════════════════


class EmployeeRaisesTests(ClaimsBase):
    def test_holiday_work_with_the_suggested_shift(self):
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "Dispatch"})
        claim = self.made(r)
        body = r.json()
        self.assertEqual(
            (
                body["kind"],
                body["kindLabel"],
                body["raisedByRole"],
                body["requestedBy"],
                body["shifts"],
                body["status"],
            ),
            ("holiday_work", "Sunday / holiday work", "employee", "CL1 Cl", 1.0, "pending"),
        )
        self.assertEqual(
            (body["workDate"], body["date"], body["dayKind"], body["canWithdraw"]),
            ("2026-10-11", "2026-10-11", "sunday", True),
        )
        self.assertEqual(claim.raised_by_role, "employee")
        # the Department Head is told (notify_new_request: they decide from a list)
        note = Notification.objects.filter(employee=self.boss, type="holiday_work").first()
        self.assertIsNotNone(note)
        self.assertIn("holiday-work compensation claim", note.message)

    def test_ot_allowance_from_a_snake_case_body(self):
        # the mobile app's client sends every body key in snake_case
        r = self.emp_claim(
            {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtime_record_id": self.allow_rec.id}
        )
        claim = self.made(r)
        self.assertEqual(
            (claim.kind, claim.minutes, claim.shifts, claim.overtime_record_id),
            ("ot_allowance", 30, Decimal("0.00"), self.allow_rec.id),
        )
        body = r.json()
        self.assertEqual(body["overtime"]["date"], OT_ALLOW_DAY.isoformat())
        self.assertEqual(
            (body["overtime"]["shiftEnd"], body["overtime"]["lastPunch"], body["overtime"]["extraMinutes"]),
            ("18:00", "19:00", 60),
        )
        self.assertEqual(body["appliesOn"], "2026-10-14")
        self.assertIn("Worked until 19:00", claim.reason)  # a detected claim needs no typed reason

    def test_ot_shift_defaults_to_the_quarters_credit_and_never_more(self):
        refused = self.emp_claim(
            {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id, "shifts": 1}
        )
        self.assertEqual((refused.status_code, refused.json()["code"]), (400, "not_eligible"))
        self.assertIn("at most 0.75", refused.json()["error"])
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        self.assertEqual((claim.shifts, claim.overtime_record_id), (Decimal("0.75"), self.shift_rec.id))

    def test_birthday_without_shifts_is_one_shift(self):
        claim = self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat(), "shifts": 0.25}))
        self.assertEqual((claim.kind, claim.shifts), ("birthday", Decimal("1.00")))

    def test_use_balance(self):
        self.credit(self.asha)
        r = self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "Family function"})
        claim = self.made(r)
        self.assertEqual((claim.kind, claim.shifts, claim.work_date), ("use_balance", Decimal("0.50"), USE_DAY))
        self.assertEqual(r.json()["useDate"], USE_DAY.isoformat())

    def test_own_claims_list_newest_first_with_filters(self):
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        body = self.client.get("/api/employee/compensation/claims", **self.asha_t).json()
        self.assertEqual([i["kind"] for i in body["items"]], ["birthday", "holiday_work"])
        for key in (
            "id",
            "kind",
            "kindLabel",
            "status",
            "statusLabel",
            "date",
            "workDate",
            "useDate",
            "shifts",
            "minutes",
            "reason",
            "raisedByRole",
            "requestedBy",
            "createdAt",
            "reviewedBy",
            "reviewComment",
            "overtime",
            "dayKind",
            "holidayName",
            "canWithdraw",
        ):
            self.assertIn(key, body["items"][0])
        only = self.client.get("/api/employee/compensation/claims", {"kind": "birthday"}, **self.asha_t).json()
        self.assertEqual(len(only["items"]), 1)


# ═════════════════════════════ HR raises on the employee's behalf ═════════════════════════════


class HrRaisesTests(ClaimsBase):
    def test_every_kind_on_behalf(self):
        cases = [
            {
                "kind": "holiday_work",
                "date": SUNDAY.isoformat(),
                "reason": "Rush",
                "items": [{"employeeId": self.asha.id, "shifts": 0.5}],
            },
            {
                "kind": "ot_allowance",
                "date": OT_ALLOW_DAY.isoformat(),
                "reason": "",
                "items": [{"employeeId": self.asha.id, "overtimeRecordId": self.allow_rec.id}],
            },
            {
                "kind": "ot_shift",
                "date": OT_SHIFT_DAY.isoformat(),
                "reason": "",
                "items": [{"employeeId": self.asha.id, "overtimeRecordId": self.shift_rec.id, "shifts": 0.5}],
            },
            {"kind": "birthday", "date": BIRTHDAY.isoformat(), "reason": "", "items": [{"employeeId": self.asha.id}]},
        ]
        for body in cases:
            r = self.hr_claim(body)
            self.assertEqual(r.status_code, 201, (body["kind"], r.content))
            row = r.json()["claims"][0]
            self.assertEqual((row["kind"], row["raisedByRole"], row["requestedBy"]), (body["kind"], "hr", "Cl_Admin"))
            self.assertEqual(r.json()["warnings"], [])
        self.credit(self.asha)
        r = self.hr_use(
            {"employeeId": self.asha.id, "date": USE_DAY.isoformat(), "shifts": 0.25, "reason": "Asked at the desk"}
        )
        self.assertEqual((r.status_code, r.json()["kind"], r.json()["raisedByRole"]), (201, "use_balance", "hr"))
        self.assertEqual(HolidayWorkClaim.objects.filter(employee=self.asha).count(), 5)
        # the employee is told HR raised them (Phone Notify Control's compensation switch)
        self.assertEqual(Notification.objects.filter(employee=self.asha, source="ot_compensation").count(), 5)

    def test_all_or_nothing_lists_who_was_refused(self):
        r = self.hr_claim(
            {
                "kind": "holiday_work",
                "date": SUNDAY.isoformat(),
                "reason": "Rush",
                "items": [{"employeeId": self.asha.id, "shifts": 1}, {"employeeId": self.mani.id, "shifts": 1}],
            }
        )
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual(body["code"], "no_hod")
        self.assertEqual([p["employeeId"] for p in body["problems"]], [self.mani.id])
        self.assertIn("Nothing was raised", body["error"])
        self.assertFalse(HolidayWorkClaim.objects.exists())
        self.assertFalse(Notification.objects.filter(type="holiday_work").exists())

    def test_the_old_holiday_work_raise_keeps_working_as_kind_holiday_work(self):
        r = self.client.post(
            "/api/compensation/holiday-work",
            {"employeeId": self.asha.id, "workDate": SUNDAY.isoformat(), "shifts": 0.5, "reason": "x"},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 201, r.content)
        claim = HolidayWorkClaim.objects.get()
        self.assertEqual((claim.kind, claim.raised_by_role), ("holiday_work", "hr"))
        self.assertEqual(r.json()["claims"][0]["kind"], "holiday_work")


# ═════════════════════════════ refusals ═════════════════════════════


class RefusalTests(ClaimsBase):
    def code(self, response):
        return response.status_code, response.json().get("code")

    def test_not_staff(self):
        r = self.emp_claim(
            {"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}, who=_emp_token(self.prod)
        )
        self.assertEqual(self.code(r), (403, "not_staff"))

    def test_switched_off(self):
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=False)
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"})
        self.assertEqual(self.code(r), (403, "switched_off"))
        CompensationConfig.objects.filter(pk=1).update(holiday_work_enabled=True)
        approval.save_config("holiday_work", enabled=False, actor="t")
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"})
        self.assertEqual(self.code(r), (403, "switched_off"))
        self.assertIn("Compensation claims are switched off", r.json()["error"])
        approval.save_config("holiday_work", enabled=True, actor="t")
        settings = PayrollSettings.get()
        settings.compensation_feature_enabled = False
        settings.save()
        self.assertEqual(
            self.code(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()})), (403, "switched_off")
        )
        # HR: reading still works, changing is refused with the master switch's sentence
        self.assertEqual(self.get("/api/compensation/claims").status_code, 200)
        self.assertEqual(self.get("/api/compensation/ledger").status_code, 200)
        r = self.hr_claim({"kind": "birthday", "date": BIRTHDAY.isoformat(), "items": [{"employeeId": self.asha.id}]})
        self.assertEqual(r.status_code, 403)
        self.assertIn("switched off in Settings", r.json()["error"])
        r = self.hr_use({"employeeId": self.asha.id, "date": USE_DAY.isoformat(), "shifts": 0.25, "reason": "x"})
        self.assertEqual(r.status_code, 403)

    def test_too_old_and_not_yet(self):
        old_sunday = date(2026, 8, 23)
        _punch(self.asha, old_sunday)
        r = self.emp_claim({"kind": "holiday_work", "date": old_sunday.isoformat(), "reason": "x"})
        self.assertEqual(self.code(r), (400, "too_old"))
        r = self.emp_claim({"kind": "holiday_work", "date": "2026-10-18", "reason": "x"})
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertIn("has not happened yet", r.json()["error"])

    def test_not_eligible_holiday_work(self):
        r = self.emp_claim({"kind": "holiday_work", "date": "2026-10-07", "reason": "x"})  # a Wednesday
        self.assertEqual(self.code(r), (400, "not_eligible"))
        r = self.emp_claim({"kind": "holiday_work", "date": HOLIDAY.isoformat(), "reason": "x"})  # did not work
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertIn("no punches or attendance", r.json()["error"])

    def test_a_birthday_the_attendance_does_not_make_claimable(self):
        self.birthday.return_value = {"outcome": effects.BIRTHDAY_PAID_LEAVE, "message": "Paid birthday leave."}
        r = self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()})
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertEqual(r.json()["error"], "Paid birthday leave.")
        r = self.emp_claim({"kind": "birthday", "date": "2026-10-08"})
        self.assertIn("not your birthday", r.json()["error"])

    def test_already_claimed(self):
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"})
        self.assertEqual(self.code(r), (409, "already_claimed"))
        self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        r = self.hr_claim(
            {
                "kind": "ot_allowance",
                "date": OT_ALLOW_DAY.isoformat(),
                "items": [{"employeeId": self.asha.id, "overtimeRecordId": self.allow_rec.id}],
            }
        )
        self.assertEqual(self.code(r), (409, "already_claimed"))

    def test_no_hod(self):
        _punch(self.mani, HOLIDAY)
        r = self.emp_claim(
            {"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}, who=_emp_token(self.mani)
        )
        self.assertEqual(self.code(r), (409, "no_hod"))
        self.assertIn("no Department Head", r.json()["error"])
        self.manager.can_approve_compensation = False
        self.manager.save()
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"})
        self.assertEqual(self.code(r), (409, "no_hod"))
        self.assertIn("not allowed to approve compensation", r.json()["error"])

    def test_invalid_shifts_and_missing_reason(self):
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x", "shifts": 0.3})
        self.assertEqual(self.code(r), (400, "invalid"))
        r = self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat()})
        self.assertEqual(self.code(r), (400, "invalid"))
        r = self.emp_claim({"kind": "use_balance", "date": USE_DAY.isoformat()})
        self.assertEqual(r.status_code, 400)

    def test_a_paid_ot_record_cannot_be_claimed(self):
        OvertimeRecord.objects.filter(pk=self.shift_rec.pk).update(
            status=OvertimeRecord.STATUS_ANNOUNCED, compensation_type=OvertimeRecord.TYPE_PAY, shifts=Decimal("0.50")
        )
        r = self.emp_claim(
            {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
        )
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertIn("HR already decided", r.json()["error"])

    def test_someone_elses_ot_record(self):
        r = self.emp_claim(
            {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id},
            who=_emp_token(self.ravi),
        )
        self.assertEqual(r.status_code, 404)

    def test_use_balance_refusals(self):
        self.credit(self.asha, "0.50")
        r = self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.75, "reason": "x"})
        self.assertEqual(self.code(r), (400, "not_eligible"))
        r = self.emp_use({"date": "2026-10-18", "shifts": 0.25, "reason": "x"})  # a Sunday
        self.assertEqual(self.code(r), (400, "not_eligible"))
        r = self.emp_use({"date": "2026-11-10", "shifts": 0.25, "reason": "x"})  # next month: the request window
        self.assertEqual(self.code(r), (400, "request_window_closed"))
        # what is already asked for counts: 0.50 balance, 0.50 waiting -> nothing left to ask for
        self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        r = self.emp_use({"date": "2026-10-21", "shifts": 0.25, "reason": "x"})
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertIn("already asked for", r.json()["error"])
        # BE-2's day check refuses with its own sentence
        self.check.return_value = "21 Oct 2026 is already a full paid day."
        self.credit(self.asha)
        r = self.emp_use({"date": "2026-10-21", "shifts": 0.25, "reason": "x"})
        self.assertEqual(r.json()["error"], "21 Oct 2026 is already a full paid day.")

    def test_before_claims_from_the_old_rules_stand(self):
        old = OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(2026, 9, 29),
            shift_end_time=time(18, 0),
            last_punch_out=time(19, 0),
            ot_minutes=60,
            ot_type="allowance",
            status="auto",
            allowance_minutes=30,
        )
        r = self.emp_claim({"kind": "ot_allowance", "date": old.date.isoformat(), "overtimeRecordId": old.id})
        self.assertEqual(self.code(r), (400, "not_eligible"))
        self.assertIn("Before Thursday 1 Oct 2026", r.json()["error"])
        item = next(
            i
            for i in self.client.get("/api/employee/compensation", **self.asha_t).json()["items"]
            if i["key"] == f"ot-{old.id}"
        )
        self.assertIn(item["status"], ("available", "not_used", "used"))
        self.assertEqual((item["claimable"], item["claimKind"]), (False, None))


# ═════════════════════════════ the Department Head decides ═════════════════════════════


class DecisionTests(ClaimsBase):
    def test_holiday_work_approval_credits_once(self):
        claim = self.made(
            self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x", "shifts": 0.5})
        )
        r = self.decide(claim.id)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["status"], body["credited"]), ("approved", True))
        self.assertEqual(body["effect"], "0.50 shift added to CL1's balance.")
        entry = CompensationLedger.objects.get(claim=claim)
        self.assertEqual((entry.entry_type, entry.source, entry.shifts), ("credit", "holiday_work", Decimal("0.50")))
        self.assertEqual(body["ledger"]["id"], entry.id)
        self.after.assert_called_once()
        self.assertEqual(self.after.call_args[0][0].pk, claim.id)
        # a second decision is refused, and writing the entry again changes nothing
        self.assertEqual(self.decide(claim.id).status_code, 400)
        claims.credit_or_debit(HolidayWorkClaim.objects.get(pk=claim.id))
        self.assertEqual(CompensationLedger.objects.filter(claim=claim).count(), 1)

    def test_ot_shift_approval_credits_and_marks_the_record_so_hr_cannot_pay_it(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["credited"]), (200, True))
        entry = CompensationLedger.objects.get(claim=claim)
        self.assertEqual(
            (entry.source, entry.overtime_record_id, entry.shifts), ("ot_shift", self.shift_rec.id, Decimal("0.75"))
        )
        rec = OvertimeRecord.objects.get(pk=self.shift_rec.pk)
        self.assertEqual(
            (rec.status, rec.compensation_type, rec.shifts, rec.claim_date),
            ("announced", "relaxation", Decimal("0.75"), None),
        )
        paid = self.client.post(
            "/api/compensation/ot/assign",
            {"mode": "pay", "records": [{"employeeId": self.asha.id, "date": OT_SHIFT_DAY.isoformat(), "shifts": 0.5}]},
            content_type="application/json",
            **self.admin,
        )
        # an approved claim is a conflict, not a bad request (compensation_views._assign_one: 409, code claim_conflict)
        self.assertEqual((paid.status_code, paid.json()["code"]), (409, "claim_conflict"), paid.content)
        self.assertEqual(CompensationLedger.objects.filter(overtime_record=self.shift_rec).count(), 1)

    def test_approval_is_refused_when_hr_paid_the_ot_meanwhile(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        OvertimeRecord.objects.filter(pk=self.shift_rec.pk).update(
            status=OvertimeRecord.STATUS_ANNOUNCED, compensation_type=OvertimeRecord.TYPE_PAY, shifts=Decimal("0.50")
        )
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertEqual(HolidayWorkClaim.objects.get(pk=claim.id).status, "pending")
        self.assertFalse(CompensationLedger.objects.exists())
        self.assertEqual(self.decide(claim.id, "rejected").status_code, 200)

    def test_ot_allowance_approval_writes_no_ledger_and_applies_the_next_working_day(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        page = self.client.get("/api/employee/compensation", **self.asha_t).json()
        self.assertIsNone(page["todayAllowance"])  # not approved yet: no allowance today
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["credited"]), (200, False))
        self.assertEqual(r.json()["effect"], "Late-in allowance of 30 min applies on 14 Oct.")
        self.assertFalse(CompensationLedger.objects.exists())
        self.after.assert_called_once()
        page = self.client.get("/api/employee/compensation", **self.asha_t).json()
        self.assertEqual((page["todayAllowance"]["date"], page["todayAllowance"]["minutes"]), ("2026-10-14", 30))

    def test_birthday_approval_credits(self):
        claim = self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        self.assertEqual(self.decide(claim.id).status_code, 200)
        entry = CompensationLedger.objects.get(claim=claim)
        self.assertEqual((entry.entry_type, entry.source, entry.shifts), ("credit", "birthday", Decimal("1.00")))

    def test_use_balance_approval_debits_once(self):
        self.credit(self.asha)
        claim = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["credited"]), (200, False))
        self.assertEqual(r.json()["effect"], "0.50 shift taken from CL1's balance for 20 Oct.")
        entry = CompensationLedger.objects.get(claim=claim)
        self.assertEqual((entry.entry_type, entry.source, entry.date), ("debit", "redemption", USE_DAY))
        claims.credit_or_debit(HolidayWorkClaim.objects.get(pk=claim.id))
        self.assertEqual(CompensationLedger.objects.filter(claim=claim).count(), 1)
        from .compensation_apply import balance_of

        self.assertEqual(balance_of(self.asha), Decimal("0.50"))

    def test_use_balance_is_refused_when_the_balance_no_longer_covers_it(self):
        credit = self.credit(self.asha, "0.50")
        claim = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        CompensationLedger.objects.create(
            employee=self.asha, entry_type="debit", shifts=Decimal("0.25"), date=TODAY, source="redemption"
        )  # HR redeemed meanwhile
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("balance is 0.25", r.json()["error"])
        self.assertTrue(credit.pk)

    def test_rejection_writes_nothing(self):
        claim = self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        r = self.decide(claim.id, "rejected", "Was on site visit")
        self.assertEqual((r.status_code, r.json()["status"], r.json()["credited"]), (200, "rejected", False))
        self.assertEqual(r.json()["effect"], "Not approved: nothing was added to CL1's balance.")
        self.assertFalse(CompensationLedger.objects.exists())
        self.after.assert_called_once()
        # a rejected claim can be raised again
        self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))

    def test_the_effects_check_refuses_an_approval(self):
        claim = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.check.return_value = "October 2026 is Payroll Done, so this cannot change."
        r = self.decide(claim.id)
        self.assertEqual(
            (r.status_code, r.json()["error"]), (409, "October 2026 is Payroll Done, so this cannot change.")
        )
        self.assertEqual(HolidayWorkClaim.objects.get(pk=claim.id).status, "pending")
        self.after.assert_not_called()

    def test_the_md_decides_for_an_md_department_head_the_same_way(self):
        from .md_portal import hod_approvals as H

        claim = self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )
        with self.captureOnCommitCallbacks(execute=True):
            r = H.deciders()["holiday_work"](self.manager, claim.id, "approved", "ok", "Md (MD, for CLB Cl)", None)
        self.assertEqual((r.status_code, r.data["credited"]), (200, True))
        self.assertEqual(CompensationLedger.objects.get(claim=claim).source, "ot_shift")
        row = {
            "kind": "ot_allowance",
            "kindLabel": "OT late-in allowance",
            "workDate": "2026-10-13",
            "minutes": 30,
            "raisedByRole": "employee",
        }
        self.assertEqual(
            H._describe("holiday_work", row),
            ("OT late-in allowance", "2026-10-13", None, "30 min · raised by the employee"),
        )


# ═════════════════════════════ the balance ═════════════════════════════


class BalanceTests(ClaimsBase):
    def test_earned_used_pending_available(self):
        self.credit(self.asha)
        claim = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        rows = {r["employeeId"]: r for r in self.get("/api/compensation/balance").json()["items"]}
        row = rows[self.asha.id]
        self.assertEqual((row["earned"], row["used"], row["pending"], row["available"]), (1.0, 0.0, 0.5, 0.5))
        page = self.client.get("/api/employee/compensation", **self.asha_t).json()
        self.assertEqual(page["useBalance"]["availableShifts"], 0.5)
        self.assertEqual((page["useBalance"]["pendingShifts"], page["balanceShifts"]), (0.5, 1.0))
        self.decide(claim.id)
        detail = self.get("/api/compensation/balance", employeeId=self.asha.id).json()
        self.assertEqual(
            (detail["earned"], detail["used"], detail["pending"], detail["available"], detail["balance"]),
            (1.0, 0.5, 0.0, 0.5, 0.5),
        )
        debit = next(e for e in detail["entries"] if e["type"] == "debit")
        self.assertEqual((debit["claim"]["id"], debit["claim"]["kind"]), (claim.id, "use_balance"))
        summary = self.get("/api/compensation/balance").json()["summary"]
        self.assertEqual((summary["employees"], summary["earned"], summary["used"]), (1, 1.0, 0.5))

    def test_the_ledger_lists_credits_and_debits_with_their_claim(self):
        claim = self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        self.decide(claim.id)
        CompensationLedger.objects.create(
            employee=self.asha,
            entry_type="debit",
            shifts=Decimal("0.25"),
            date=TODAY,
            source="redemption",
            created_by="HR",
        )
        body = self.get("/api/compensation/ledger").json()
        self.assertEqual(
            body["summary"],
            {"credits": 1, "debits": 1, "creditShifts": 1.0, "debitShifts": 0.25, "countedDebitShifts": 0.25},
        )
        credit = next(r for r in body["items"] if r["entryType"] == "credit")
        self.assertEqual(
            (credit["claim"]["kind"], credit["source"], credit["employeeCode"]), ("birthday", "birthday", "CL1")
        )
        hr_redeem = next(r for r in body["items"] if r["entryType"] == "debit")
        self.assertIsNone(hr_redeem["claim"])
        only = self.get("/api/compensation/ledger", entryType="debit").json()
        self.assertEqual(only["total"], 1)


# ═════════════════════════════ withdraw, lists, scope, permissions ═════════════════════════════


class ListAndAccessTests(ClaimsBase):
    def test_withdraw(self):
        own = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        hr = self.hr_claim({"kind": "birthday", "date": BIRTHDAY.isoformat(), "items": [{"employeeId": self.asha.id}]})
        hr_id = hr.json()["claims"][0]["id"]
        self.assertFalse(hr.json()["claims"][0]["canWithdraw"] is False)  # HR may withdraw what it raised
        r = self.client.delete(f"/api/employee/compensation/claims/{hr_id}", **self.asha_t)
        self.assertEqual((r.status_code, r.json()["code"]), (403, "not_yours"))
        self.assertEqual(
            self.client.delete(f"/api/employee/compensation/claims/{own.id}", **self.asha_t).status_code, 204
        )
        self.assertEqual(self.client.delete(f"/api/compensation/claims/{hr_id}", **self.admin).status_code, 204)
        self.assertFalse(HolidayWorkClaim.objects.exists())
        again = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.decide(again.id)
        r = self.client.delete(f"/api/employee/compensation/claims/{again.id}", **self.asha_t)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "not_pending"))

    def test_hr_list_filters_paging_and_summary(self):
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "Dispatch"}))
        self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        self.hr_claim(
            {
                "kind": "ot_shift",
                "date": OT_SHIFT_DAY.isoformat(),
                "items": [{"employeeId": self.asha.id, "overtimeRecordId": self.shift_rec.id}],
            }
        )
        body = self.get("/api/compensation/claims").json()
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (3, 1, 50))
        self.assertEqual(body["summary"]["byKind"]["birthday"], 1)
        self.assertEqual(body["summary"]["byStatus"]["pending"], 3)
        self.assertEqual(
            sorted(body["enabled"]),
            sorted(
                [
                    "master",
                    "holidayWork",
                    "workflow",
                    "canRaise",
                    "raiseProblem",
                    "allowance",
                    "shift",
                    "birthday",
                    "canClaim",
                ]
            ),
        )
        item = body["items"][0]
        for key in (
            "kind",
            "kindLabel",
            "raisedByRole",
            "minutes",
            "overtimeRecordId",
            "overtime",
            "useDate",
            "appliesOn",
            "ledger",
            "statusLabel",
            "approval",
            "hodName",
            "workDate",
            "dayKind",
        ):
            self.assertIn(key, item)
        self.assertEqual(self.get("/api/compensation/claims", kind="birthday", raisedBy="employee").json()["total"], 1)
        filtered = self.get("/api/compensation/claims", kind="birthday", status="approved").json()
        self.assertEqual(filtered["total"], 0)
        # the tiles ignore the kind / status filters (they ARE those filters)
        self.assertEqual(
            (filtered["summary"]["byStatus"]["pending"], filtered["summary"]["byKind"]["ot_shift"]), (3, 1)
        )
        self.assertEqual(self.get("/api/compensation/claims", raisedBy="hr").json()["total"], 1)
        self.assertEqual(self.get("/api/compensation/claims", q="Dispatch").json()["total"], 1)
        self.assertEqual(len(self.get("/api/compensation/claims", pageSize=2, page=2).json()["items"]), 1)
        self.assertEqual(self.get("/api/compensation/claims", month=9).json()["total"], 0)
        self.assertEqual(self.get("/api/compensation/claims", anyMonth=1, employeeId=self.asha.id).json()["total"], 3)
        self.assertEqual(self.get("/api/compensation/claims", kind="nope").status_code, 400)

    def test_the_old_holiday_work_list_shows_only_holiday_work(self):
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        body = self.get("/api/compensation/holiday-work").json()
        self.assertEqual([r["kind"] for r in body["results"]], ["holiday_work"])

    def test_branch_scope(self):
        mani_head = DepartmentManager.objects.create(employee=self.ravi)
        ManagerDepartmentAssignment.objects.create(manager=mani_head, department=self.sewing)
        mani = self.made(
            self.emp_claim(
                {"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}, who=_emp_token(self.mani)
            )
        )
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        ids = [i["id"] for i in self.get("/api/compensation/claims", who=self.ho_hr).json()["items"]]
        self.assertNotIn(mani.id, ids)
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.get(f"/api/compensation/claims/{mani.id}", who=self.ho_hr).status_code, 404)
        r = self.hr_claim(
            {
                "kind": "holiday_work",
                "date": SUNDAY.isoformat(),
                "reason": "x",
                "items": [{"employeeId": self.mani.id, "shifts": 1}],
            },
            who=self.ho_hr,
        )
        self.assertEqual(r.status_code, 404)

    def test_permissions(self):
        # an employee token on HR paths, an HR token on employee paths, a view-only HR changing
        self.assertEqual(self.client.get("/api/compensation/claims", **self.asha_t).status_code, 403)
        self.assertEqual(self.client.get("/api/employee/compensation/claims", **self.admin).status_code, 403)
        r = self.client.post(
            "/api/employee/compensation/claims",
            {"kind": "birthday", "date": BIRTHDAY.isoformat()},
            content_type="application/json",
            **self.admin,
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.get("/api/compensation/claims", who=self.view_only).status_code, 200)
        r = self.hr_claim(
            {"kind": "birthday", "date": BIRTHDAY.isoformat(), "items": [{"employeeId": self.asha.id}]},
            who=self.view_only,
        )
        self.assertEqual(r.status_code, 403)

    def test_the_raise_strip_of_a_month(self):
        body = self.get("/api/compensation/holiday-work/month", month=10, year=2026).json()
        days = {d["date"]: d for d in body["days"]}
        self.assertEqual(sorted(days), ["2026-10-02", "2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"])
        self.assertEqual((days["2026-10-02"]["kind"], days["2026-10-02"]["holidayName"]), ("holiday", "Gandhi Jayanti"))
        self.assertEqual((days["2026-10-11"]["worked"], days["2026-10-11"]["weekLabel"]), (4, "Week 2"))
        self.assertEqual(days["2026-10-18"]["worked"], 0)  # not yet
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        days = {
            d["date"]: d for d in self.get("/api/compensation/holiday-work/month", month=10, year=2026).json()["days"]
        }
        self.assertEqual(
            (days["2026-10-11"]["eligible"], days["2026-10-11"]["claimed"]), (3, {"pending": 1, "approved": 0})
        )
        self.assertEqual((body["defaultDate"], body["maxAgeDays"]), ("2026-10-11", 45))


# ═════════════════════════════ the HOD's lists and the apps ═════════════════════════════


class HodAndAppTests(ClaimsBase):
    def raise_every_kind(self):
        self.credit(self.asha)
        made = [
            self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"})),
            self.made(
                self.emp_claim(
                    {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
                )
            ),
            self.made(
                self.emp_claim(
                    {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
                )
            ),
            self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()})),
            self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.25, "reason": "x"})),
        ]
        return made

    def test_the_hod_lists_and_counts_every_kind(self):
        made = self.raise_every_kind()
        listed = self.client.get("/api/manager/pending-requests", **self.hod).json()["holidayWorkClaims"]
        self.assertEqual(sorted(r["kind"] for r in listed), sorted(claims.ALL_KINDS))
        allowance = next(r for r in listed if r["kind"] == "ot_allowance")
        self.assertEqual(
            (allowance["minutes"], allowance["raisedByRole"], allowance["overtime"]["extraMinutes"]),
            (30, "employee", 60),
        )
        use = next(r for r in listed if r["kind"] == "use_balance")
        self.assertEqual(use["useDate"], USE_DAY.isoformat())
        self.assertFalse(use["canWithdraw"])  # the head never withdraws
        me = self.client.get("/api/manager/me", **self.hod).json()
        self.assertEqual(me["pendingCompensationCount"], len(made))
        for category in ("holiday_work", "compensation"):
            body = self.client.get(
                "/api/manager/requests", {"category": category, "status": "pending"}, **self.hod
            ).json()
            self.assertEqual(len(body["items"]), len(made), category)

    def test_the_employee_page_keeps_the_old_contract_and_adds_the_claim_keys(self):
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        body = self.client.get("/api/employee/compensation", **self.asha_t).json()
        for key in (
            "isStaff",
            "enabled",
            "balanceShifts",
            "items",
            "todayAllowance",
            "tomorrowAllowance",
            "askHr",
            "message",
            "canClaim",
            "claimWindowDays",
            "useBalance",
        ):
            self.assertIn(key, body)
        self.assertEqual((body["canClaim"], body["claimWindowDays"]), (True, 45))
        old_keys = {
            "key",
            "kind",
            "group",
            "date",
            "title",
            "detail",
            "status",
            "statusLabel",
            "shifts",
            "minutes",
            "minutesUsed",
            "used",
        }
        new_keys = {"claimable", "claimKind", "claim", "claimMessage", "suggestedShifts"}
        for item in body["items"]:
            self.assertTrue(old_keys | new_keys <= set(item), item["key"])
        by_key = {i["key"]: i for i in body["items"]}
        claim = HolidayWorkClaim.objects.get()
        hw = by_key[f"hw-{claim.id}"]
        self.assertEqual(
            (hw["kind"], hw["status"], hw["claim"]["id"], hw["claim"]["canWithdraw"]),
            ("holiday_work", "pending_hod", claim.id, True),
        )
        self.assertIn("You raised this claim", hw["detail"])
        allowance = by_key[f"ot-{self.allow_rec.id}"]
        self.assertEqual(
            (allowance["status"], allowance["claimable"], allowance["claimKind"], allowance["overtimeRecordId"]),
            ("claimable", True, "ot_allowance", self.allow_rec.id),
        )
        shift = by_key[f"ot-{self.shift_rec.id}"]
        self.assertEqual((shift["status"], shift["suggestedShifts"], shift["claimable"]), ("claimable", 0.75, True))
        birthday = by_key[f"bd-{BIRTHDAY.isoformat()}"]
        self.assertEqual(
            (birthday["kind"], birthday["status"], birthday["claimable"]), ("birthday_credit", "claimable", True)
        )

    def test_a_worked_sunday_with_no_claim_is_claimable_on_the_page(self):
        body = self.client.get("/api/employee/compensation", **self.asha_t).json()
        item = next(i for i in body["items"] if i["key"] == f"hwd-{SUNDAY.isoformat()}")
        self.assertEqual(
            (item["kind"], item["status"], item["claimable"], item["suggestedShifts"]),
            ("holiday_work", "claimable", True, 1.0),
        )

    def test_pending_and_decided_claims_on_the_page(self):
        made = self.raise_every_kind()
        by_key = {i["key"]: i for i in self.client.get("/api/employee/compensation", **self.asha_t).json()["items"]}
        self.assertEqual(by_key[f"ot-{self.allow_rec.id}"]["status"], "claim_pending")
        self.assertEqual(by_key[f"hw-{made[4].id}"]["kind"], "use_balance")
        for claim in made:
            self.decide(claim.id)
        by_key = {i["key"]: i for i in self.client.get("/api/employee/compensation", **self.asha_t).json()["items"]}
        self.assertEqual(by_key[f"ot-{self.shift_rec.id}"]["status"], "claim_approved")
        self.assertEqual(by_key[f"bd-{BIRTHDAY.isoformat()}"]["status"], "claim_approved")
        self.assertNotIn(f"hw-{made[4].id}", by_key)  # the approved use is the redemption item of its debit
        debit = CompensationLedger.objects.get(claim=made[4])
        self.assertEqual(by_key[f"rd-{debit.id}"]["claim"]["id"], made[4].id)

    def test_a_production_employee_gets_no_claims(self):
        body = self.client.get("/api/employee/compensation/claims", **_emp_token(self.prod)).json()
        self.assertEqual((body["items"], body["isStaff"]), ([], False))
        page = self.client.get("/api/employee/compensation", **_emp_token(self.prod)).json()
        self.assertEqual((page["canClaim"], page["useBalance"]["allowed"]), (False, False))


# ═════════════════════════════ review fixes (2026-11-19) ═════════════════════════════


class ReviewFixClaimTests(ClaimsBase):
    """The security / correctness review of the claim workflow: the evidence is checked again at approval, nothing that
    changes attendance is approved while the master switch is off, the old holiday-work routes act on holiday work only
    under the Claims key, batches lock in id order, a withdrawn claim is a 404, the HOD is told once per thing claimed,
    and the waiting tile splits credits from days off."""

    def ot_shift_claim(self):
        return self.made(
            self.emp_claim(
                {"kind": "ot_shift", "date": OT_SHIFT_DAY.isoformat(), "overtimeRecordId": self.shift_rec.id}
            )
        )

    # security #1 / correctness #5: approval re-checks what the claim was raised on
    def test_a_pending_ot_claim_whose_record_was_pruned_is_refused(self):
        from .overtime import sync_overtime

        claim = self.ot_shift_claim()
        # the punches were corrected: no stored day shows OT any more, and detection now prunes the pending claim's row
        sync_overtime(OT_SHIFT_DAY, OT_SHIFT_DAY, employee_ids=[self.asha.id], prune=True)
        self.assertFalse(OvertimeRecord.objects.filter(pk=self.shift_rec.pk).exists())
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("no longer on record", r.json()["error"])
        self.assertFalse(CompensationLedger.objects.filter(claim=claim).exists())
        self.assertEqual(self.decide(claim.id, "rejected").status_code, 200)

    def test_an_ot_shift_claim_that_now_earns_less_is_refused(self):
        claim = self.ot_shift_claim()  # 0.75 by the (pinned) quarters rule
        self.ot_credit.return_value = Decimal("0.25")  # the record was updated from corrected punches
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("now earns 0.25", r.json()["error"])
        self.ot_credit.return_value = Decimal("0.75")
        self.assertEqual(self.decide(claim.id).status_code, 200)

    def test_an_allowance_claim_whose_record_changed_is_refused(self):
        claim = self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        OvertimeRecord.objects.filter(pk=self.allow_rec.pk).update(allowance_minutes=0)
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("less than the 30 min claimed", r.json()["error"])
        OvertimeRecord.objects.filter(pk=self.allow_rec.pk).update(allowance_minutes=30, ot_type="shift")
        r = self.decide(claim.id)
        self.assertEqual(r.status_code, 409)
        self.assertIn("no longer what was claimed", r.json()["error"])

    def test_a_holiday_work_claim_without_the_work_on_record_is_refused(self):
        claim = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        AttendanceLog.objects.filter(employee=self.asha, date=SUNDAY).delete()
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("no punches or attendance", r.json()["error"])

    def test_a_birthday_no_longer_worked_is_refused_and_the_check_may_refresh(self):
        claim = self.made(self.emp_claim({"kind": "birthday", "date": BIRTHDAY.isoformat()}))
        self.birthday.return_value = {"outcome": "paid_leave", "base": "paid_leave", "message": "Not worked."}
        r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"))
        self.assertIn("no longer shows the birthday as worked", r.json()["error"])
        self.assertTrue(self.birthday.call_args.kwargs.get("refresh"))  # the approval may work the day out again

    # security #2: nothing that changes attendance is approved with the master switch off
    def test_use_and_allowance_are_refused_while_the_master_switch_is_off(self):
        self.credit(self.asha)
        use = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        allowance = self.made(
            self.emp_claim(
                {"kind": "ot_allowance", "date": OT_ALLOW_DAY.isoformat(), "overtimeRecordId": self.allow_rec.id}
            )
        )
        work = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        PayrollSettings.objects.filter(pk=PayrollSettings.get().pk).update(compensation_feature_enabled=False)
        for claim in (use, allowance):
            r = self.decide(claim.id)
            self.assertEqual((r.status_code, r.json()["code"]), (409, "claim_refused"), claim.kind)
            self.assertIn("switched off", r.json()["error"])
        self.assertFalse(CompensationLedger.objects.filter(claim=use).exists())
        self.assertEqual(self.decide(work.id).status_code, 200)  # a credit stays decidable
        self.assertEqual(self.decide(use.id, "rejected").status_code, 200)

    # security #4: the old holiday-work routes
    def test_the_old_holiday_work_routes_act_on_holiday_work_only_under_the_claims_key(self):
        self.credit(self.asha)
        use = self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        self.assertEqual(self.client.get(f"/api/compensation/holiday-work/{use.id}", **self.admin).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/compensation/holiday-work/{use.id}", **self.admin).status_code, 404)
        self.assertTrue(HolidayWorkClaim.objects.filter(pk=use.id).exists())
        work = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        limited = _hr(_hr_user("rev_lim", {"compensation": "edit", "compensation.leave.holiday_work.claims": "view"}))
        self.assertEqual(self.client.get(f"/api/compensation/holiday-work/{work.id}", **limited).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/compensation/holiday-work/{work.id}", **limited).status_code, 403)
        raised = self.client.post(
            "/api/compensation/holiday-work",
            {"workDate": SUNDAY.isoformat(), "reason": "x", "employeeId": self.ravi.id, "shifts": 1},
            content_type="application/json",
            **limited,
        )
        self.assertEqual(raised.status_code, 403)
        self.assertEqual(self.client.delete(f"/api/compensation/holiday-work/{work.id}", **self.admin).status_code, 204)

    # security #5: a batch locks the employees in id order
    def test_a_batch_raise_creates_in_employee_id_order(self):
        self.assertLess(self.asha.id, self.ravi.id)
        with mock.patch("api.compensation_claims.create_claim", wraps=claims.create_claim) as spy:
            r = self.hr_claim(
                {
                    "kind": "holiday_work",
                    "date": SUNDAY.isoformat(),
                    "reason": "Dispatch",
                    "items": [{"employeeId": self.ravi.id}, {"employeeId": self.asha.id}],
                }
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([c.kwargs["employee"].id for c in spy.call_args_list], [self.asha.id, self.ravi.id])

    # security #6: a claim withdrawn while the HOD decides
    def test_deciding_a_claim_withdrawn_meanwhile_is_a_404(self):
        claim = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        original = claims.decide

        def racing(claim_id, *a, **kw):
            HolidayWorkClaim.objects.filter(pk=claim_id).delete()  # the employee's DELETE lands first
            return original(claim_id, *a, **kw)

        with mock.patch("api.compensation_claims.decide", side_effect=racing):
            r = self.decide(claim.id)
        self.assertEqual((r.status_code, r.json()["error"]), (404, "This claim was withdrawn."))

    # security #7: raise / withdraw / raise tells the HOD once
    def test_the_hod_is_told_once_per_employee_kind_and_date(self):
        def waiting():
            return Notification.objects.filter(employee=self.boss, type="holiday_work", source="approval_waiting")

        with mock.patch("api.whatsapp_service.send_notification", return_value=None) as wa:
            first = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
            gone = self.client.delete(f"/api/employee/compensation/claims/{first.id}", **self.asha_t)
            self.assertEqual(gone.status_code, 204, gone.content)
            second = self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
            self.assertEqual(waiting().count(), 1)
            keys = [c.kwargs["dedupe_key"] for c in wa.call_args_list]
            self.assertEqual(len(keys), 2)
            self.assertEqual(keys[0], keys[1])  # the WhatsApp queue drops the repeat on its dedupe key
            self.assertEqual(self.decide(second.id, "rejected").status_code, 200)
            self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "again"}))
            self.assertEqual(waiting().count(), 2)  # raised again after a rejection: that is news
            hod_keys = [
                c.kwargs["dedupe_key"] for c in wa.call_args_list if c.kwargs["dedupe_key"].startswith("hodwait")
            ]
            self.assertNotEqual(hod_keys[-1], keys[0])

    # correctness #11a: the waiting tile splits credits from days off
    def test_the_summary_splits_pending_credits_from_pending_use(self):
        self.credit(self.asha)
        self.made(self.emp_claim({"kind": "holiday_work", "date": SUNDAY.isoformat(), "reason": "x"}))
        self.ot_shift_claim()
        self.made(self.emp_use({"date": USE_DAY.isoformat(), "shifts": 0.5, "reason": "x"}))
        summary = self.get("/api/compensation/claims", anyMonth=1).json()["summary"]
        self.assertEqual(
            (summary["pendingCreditShifts"], summary["pendingUseShifts"], summary["pendingShifts"]), (1.75, 0.5, 2.25)
        )
