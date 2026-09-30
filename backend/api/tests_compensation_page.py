"""The Compensation page is mandatory: PayrollSettings.compensation_feature_enabled switches the background OT /
Compensation features, never the page. Every read stays available while it is off; changes that nothing would act
on are refused with a clear reason."""

from datetime import date, time
from decimal import Decimal

from django.test import TestCase

from . import salary_split
from .jwt_utils import sign_token
from .models import (
    CompensationDayAnnouncement,
    CompensationLeaveCredit,
    Employee,
    HRUser,
    OvertimeRecord,
    PayrollSettings,
    Role,
)

BASE = "/api/compensation"
TODAY = date.today()
SPLIT_KEYS = ("basic", "da", "retentionAllowance", "otherAllowance", "petrolAllowance", "rha", "specialAllowance", "ca")


def _hr(username="cp_admin", super_admin=True, role=None):
    user, _ = HRUser.objects.get_or_create(
        username=username, defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role}
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class CompensationBase(TestCase):
    def setUp(self):
        self.hr = _hr()
        self.asha = Employee.objects.create(
            employee_code="C1",
            first_name="Asha",
            last_name="Kumar",
            status="active",
            employment_type="staff",
            salary_amount=Decimal("30000"),
        )
        self.detected = OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(TODAY.year, TODAY.month, 1),
            shift_end_time=time(17, 0),
            last_punch_out=time(19, 30),
            ot_minutes=150,
            status=OvertimeRecord.STATUS_DETECTED,
        )
        self.announced = OvertimeRecord.objects.create(
            employee=self.asha,
            date=date(TODAY.year, TODAY.month, 2),
            shift_end_time=time(17, 0),
            last_punch_out=time(19, 0),
            ot_minutes=120,
            status=OvertimeRecord.STATUS_ANNOUNCED,
            compensation_type=OvertimeRecord.TYPE_RELAXATION,
        )
        self.credit = CompensationLeaveCredit.objects.create(employee=self.asha, source_overtime_record=self.announced)
        self.day = CompensationDayAnnouncement.objects.create(date=date(TODAY.year, TODAY.month, 3), reason="Festival")

    def switch(self, on: bool):
        ps = PayrollSettings.get()
        ps.compensation_feature_enabled = on
        ps.save()

    def get(self, path="", **params):
        return self.client.get(f"{BASE}{path}", params, **self.hr)

    def post(self, path, body=None, headers=None):
        return self.client.post(f"{BASE}{path}", body or {}, content_type="application/json", **(headers or self.hr))

    def delete(self, path):
        return self.client.delete(f"{BASE}{path}", **self.hr)


class CtcBreakdownSplitTests(CompensationBase):
    """The CTC Breakdown shows each employee's 50% + 50% salary split (Basic, DA, Retention Allowance | Other, Petrol,
    RHA, Special Allowance, CA) and works employer PF out of the first portion. Display only: nothing is written."""

    def setUp(self):
        super().setUp()
        ps = PayrollSettings.get()
        ps.pf_rate = Decimal("12")
        ps.esi_rate = Decimal("0.75")
        ps.esi_applicable_below = Decimal("21000")
        ps.save()

    def row(self, code="C1"):
        return next(r for r in self.get().json()["results"] if r["employeeCode"] == code)

    def test_an_employee_with_no_recorded_split_shows_the_automatic_one(self):
        r = self.row()
        self.assertEqual([r[k] for k in SPLIT_KEYS], [5000.0, 5000.0, 5000.0, 3000.0, 3000.0, 3000.0, 3000.0, 3000.0])
        self.assertEqual((r["firstPortion"], r["secondPortion"], r["splitRecorded"]), (15000.0, 15000.0, False))
        # PF 12% of the first portion, ESI not applicable above the ceiling, annual CTC = (30,000 + 1,800) x 12
        self.assertEqual(
            (r["employerPf"], r["employerEsi"], r["grossMonthly"], r["annualCtc"]), (1800.0, 0.0, 30000.0, 381600.0)
        )
        # the old percentage-based columns are gone
        self.assertNotIn("hra", r)
        self.assertNotIn("allowances", r)

    def test_a_recorded_split_is_shown_as_recorded(self):
        salary_split.apply_to_employee(
            self.asha,
            {
                "basic": Decimal("9000"),
                "da": Decimal("3000"),
                "retention_allowance": Decimal("3000"),
                "other_allowance": Decimal("5000"),
                "petrol_allowance": Decimal("2000"),
                "rha": Decimal("4000"),
                "special_allowance": Decimal("3000"),
                "ca": Decimal("1000"),
            },
        )
        self.asha.save()
        r = self.row()
        self.assertEqual([r[k] for k in SPLIT_KEYS], [9000.0, 3000.0, 3000.0, 5000.0, 2000.0, 4000.0, 3000.0, 1000.0])
        self.assertEqual((r["firstPortion"], r["secondPortion"], r["splitRecorded"]), (15000.0, 15000.0, True))
        self.assertEqual(r["employerPf"], 1800.0)  # the first portion is always half the salary

    def test_an_odd_paisa_goes_to_the_first_portion_and_the_rows_still_add_up(self):
        Employee.objects.filter(pk=self.asha.pk).update(salary_amount=Decimal("10000.01"))
        r = self.row()
        self.assertEqual((r["firstPortion"], r["secondPortion"]), (5000.01, 5000.0))
        self.assertAlmostEqual(sum(r[k] for k in SPLIT_KEYS), 10000.01, places=2)
        self.assertEqual(r["employerPf"], 600.0)  # 12% of 5,000.01

    def test_an_employee_with_no_monthly_salary_has_no_split(self):
        Employee.objects.create(
            employee_code="P1", first_name="Piece", last_name="Rate", status="active", employment_type="production"
        )
        r = self.row("P1")
        self.assertTrue(all(r[k] is None for k in SPLIT_KEYS))
        self.assertEqual((r["firstPortion"], r["secondPortion"], r["splitRecorded"]), (None, None, False))
        self.assertEqual((r["employerPf"], r["employerEsi"], r["grossMonthly"], r["annualCtc"]), (0.0, 0.0, 0.0, 0.0))

    def test_a_stored_split_that_no_longer_matches_the_salary_is_not_shown(self):
        # the salary moved by a route that did not re-scale the split: show the automatic split of the salary
        salary_split.apply_to_employee(self.asha, salary_split.default_split(Decimal("2000")))
        self.asha.save()
        r = self.row()
        self.assertEqual((r["basic"], r["firstPortion"], r["splitRecorded"]), (5000.0, 15000.0, False))

    def test_reading_the_page_records_nothing(self):
        self.get()
        self.asha.refresh_from_db()
        self.assertIsNone(salary_split.breakup_of(self.asha))

    def test_the_pf_rate_applies_to_the_first_portion(self):
        ps = PayrollSettings.get()
        ps.pf_rate = Decimal("10")
        ps.save()
        self.assertEqual(self.row()["employerPf"], 1500.0)  # 10% of 15,000


class PageStaysAvailableTests(CompensationBase):
    """With the features switched OFF the page must still work: nothing is hidden, nothing 403s on a read."""

    def setUp(self):
        super().setUp()
        self.switch(False)

    def test_every_read_endpoint_answers_while_the_features_are_off(self):
        for path in ("", "/ot", "/credits", "/leave-days", "/summary"):
            r = self.get(path, month=TODAY.month, year=TODAY.year)
            self.assertEqual(r.status_code, 200, f"{path or '/'} -> {r.status_code} {r.content[:120]}")

    def test_ctc_breakdown_is_pure_display_and_is_still_there(self):
        body = self.get().json()
        row = next(r for r in body["results"] if r["employeeCode"] == "C1")
        self.assertEqual(row["firstPortion"] + row["secondPortion"], 30000.0)
        self.assertEqual(sum(row[k] for k in SPLIT_KEYS), 30000.0)

    def test_existing_ot_records_are_listed_and_nothing_new_is_detected(self):
        before = OvertimeRecord.objects.count()
        body = self.get("/ot", month=TODAY.month, year=TODAY.year).json()
        self.assertEqual({r["date"] for r in body["results"]}, {str(self.detected.date), str(self.announced.date)})
        self.assertEqual(OvertimeRecord.objects.count(), before)
        # the status filter still works
        announced = self.get("/ot", month=TODAY.month, year=TODAY.year, status="announced").json()
        self.assertEqual([r["status"] for r in announced["results"]], ["announced"])

    def test_credits_compensation_days_and_history_stay_readable(self):
        self.assertEqual(self.get("/credits").json()["results"][0]["id"], self.credit.id)
        days = self.get("/leave-days", month=TODAY.month, year=TODAY.year).json()
        self.assertEqual([d["reason"] for d in days["results"]], ["Festival"])
        self.assertEqual(self.get("/summary", month=TODAY.month, year=TODAY.year).status_code, 200)

    def test_a_role_that_only_holds_the_compensation_permission_can_still_open_it(self):
        role = Role.objects.create(name="Comp Viewer", permissions={"compensation": "view"})
        who = _hr("comp_viewer", super_admin=False, role=role)
        for path in ("", "/ot", "/credits", "/leave-days", "/summary"):
            self.assertEqual(self.client.get(f"{BASE}{path}", **who).status_code, 200, path)


class ChangesAreRefusedWhileOffTests(CompensationBase):
    """A save nothing acts on (and that would act retroactively once the switch is turned back on) is refused."""

    def setUp(self):
        super().setUp()
        self.switch(False)

    def assertRefused(self, response):
        self.assertEqual(response.status_code, 403, response.content)
        self.assertIn("switched off in Settings > Payroll > OT / Compensation", response.json()["error"])

    def test_announcing_and_rejecting_ot_are_refused_and_change_nothing(self):
        records = [{"employeeId": self.asha.id, "date": str(self.detected.date)}]
        self.assertRefused(self.post("/ot/announce", {"records": records, "compensationType": "pay"}))
        self.assertRefused(self.post("/ot/reject", {"records": records}))
        self.detected.refresh_from_db()
        self.assertEqual(self.detected.status, OvertimeRecord.STATUS_DETECTED)
        self.assertEqual(CompensationLeaveCredit.objects.count(), 1)

    def test_adding_and_removing_a_compensation_day_are_refused(self):
        self.assertRefused(self.post("/leave-days", {"date": str(date(TODAY.year, TODAY.month, 10))}))
        self.assertEqual(CompensationDayAnnouncement.objects.count(), 1)
        self.assertRefused(self.delete(f"/leave-days/{self.day.id}"))
        self.assertTrue(CompensationDayAnnouncement.objects.filter(pk=self.day.pk).exists())

    def test_redeeming_a_credit_is_refused(self):
        self.assertRefused(
            self.post(f"/credits/{self.credit.id}/redeem", {"date": str(date(TODAY.year, TODAY.month, 20))})
        )
        self.credit.refresh_from_db()
        self.assertEqual(self.credit.status, CompensationLeaveCredit.STATUS_AVAILABLE)

    def test_the_reason_is_the_same_for_a_branch_scoped_or_restricted_role(self):
        role = Role.objects.create(name="Comp Editor", permissions={"compensation": "edit"})
        who = _hr("comp_editor", super_admin=False, role=role)
        r = self.post("/leave-days", {"date": str(date(TODAY.year, TODAY.month, 11))}, who)
        self.assertRefused(r)


class ChangesWorkWhenOnTests(CompensationBase):
    def test_switching_the_features_on_allows_the_changes_again(self):
        self.switch(True)
        r = self.post("/leave-days", {"date": str(date(TODAY.year, TODAY.month, 10)), "reason": "Extra"})
        self.assertEqual(r.status_code, 201, r.content)
        records = [{"employeeId": self.asha.id, "date": str(self.detected.date)}]
        r = self.post("/ot/announce", {"records": records, "compensationType": "pay"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["announced"], 1)
        self.detected.refresh_from_db()
        self.assertEqual(self.detected.status, OvertimeRecord.STATUS_ANNOUNCED)

    def test_the_page_reads_the_same_with_the_features_on(self):
        self.switch(True)
        for path in ("", "/ot", "/credits", "/leave-days", "/summary"):
            self.assertEqual(self.get(path, month=TODAY.month, year=TODAY.year).status_code, 200, path)

    def test_the_background_features_still_obey_the_switch(self):
        """Detection stops while off (the page just lists what exists); that is what the switch is for."""
        from .overtime import detect_overtime_for_month

        self.switch(False)
        ps = PayrollSettings.get()
        rows = detect_overtime_for_month(TODAY.year, TODAY.month, settings=ps)
        self.assertEqual({r.pk for r in rows}, {self.detected.pk, self.announced.pk})
