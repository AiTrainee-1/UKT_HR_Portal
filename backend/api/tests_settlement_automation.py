"""Settlement Automation Method + the leave check (owner 2026-11-26; api/settlement_automation/, advance_earnings).

Calendar: February 2026 (24 Mon-Sat days; 24,000 a month = 1,000 a day). Requests are raised on 21 Feb.

Run via: python manage.py test api.tests_settlement_automation -v 2
"""

from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from . import advance_earnings, approval_workflow as approval
from .attendance_final import _holiday_dates_for_month
from .jwt_utils import sign_token
from .models import (
    Advance,
    AdvanceRepayment,
    AttendanceDayRecord,
    Employee,
    HRUser,
    LeaveRequest,
    PayrollSettings,
    SettlementBatch,
    SettlementBatchFile,
    SettlementSettings,
)
from .request_auto_reject import engine as auto_reject

DAY = date(2026, 2, 21)


def _bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def _staff(code, salary="24000.00", join_date="2020-01-01") -> Employee:
    return Employee.objects.create(
        employee_code=code, first_name=code, last_name="Staff", employment_type="staff", status="active",
        salary_type="monthly", salary_amount=Decimal(salary), join_date=join_date,
    )  # fmt: skip


def _day(emp, d, status="present", shifts="1.00", **kw):
    return AttendanceDayRecord.objects.update_or_create(
        employee=emp, date=d,
        defaults={"status": status, "shifts_earned": Decimal(shifts), "is_half_shift": status == "half_shift",
                  "source": "manual", **kw},
    )[0]  # fmt: skip


def _configure():
    ps = PayrollSettings.get()
    ps.staff_pf_rules, ps.staff_esi_rules, ps.late_deduction_slabs = [], [], []
    ps.attendance_mode = "simple"
    ps.save()


class LeaveCheckTests(TestCase):
    """Absent days + approved leave on working days of the 1st-20th; a half-day leave 0.5; CL never."""

    def setUp(self):
        _configure()
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        self.emp = _staff("LV1")

    def test_absent_and_leave_count_cl_does_not(self):
        for n in (2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20):
            _day(self.emp, date(2026, 2, n))
        _day(self.emp, date(2026, 2, 3), "absent", "0")
        _day(self.emp, date(2026, 2, 4), "on_leave", "0")
        _day(self.emp, date(2026, 2, 5), "half_shift", "0.50", is_half_day_leave=True)
        _day(self.emp, date(2026, 2, 6), "half_shift", "0.50")  # a half day without leave: not leave
        # a Casual Leave day is stored Present (cl_balance): never leave here
        days = advance_earnings.leave_days_in_month(self.emp, 2, 2026)
        self.assertEqual(days, Decimal("2.5"))
        self.assertEqual(advance_earnings.leave_flag(days), "ok")

    def test_the_flags(self):
        self.assertEqual(
            [advance_earnings.leave_flag(Decimal(d)) for d in ("0", "2.5", "3", "3.5", "6")],
            ["ok", "ok", "warning", "critical", "critical"],
        )
        self.assertIsNone(advance_earnings.leave_flag(None))

    def test_unrecorded_working_days_are_absent_sundays_never(self):
        # no attendance at all in the 1st-20th: the engine judges every working day Absent (17 Mon-Sat days)
        self.assertEqual(advance_earnings.leave_days_in_month(self.emp, 2, 2026), Decimal("17"))


class _FlowBase(TestCase):
    def setUp(self):
        _configure()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.addCleanup(_holiday_dates_for_month.cache_clear)
        admin, _ = HRUser.objects.get_or_create(
            username="sa_admin", defaults={"password_hash": "x", "is_super_admin": True, "full_name": "Meena HR"}
        )
        md = HRUser.objects.create(username="sa_md", password_hash="x", is_md=True, full_name="Ravi Shankar")
        self.hr = _bearer({"role": "hr", "hrUserId": admin.id, "name": "Meena HR"})
        self.md = _bearer({"role": "hr", "hrUserId": md.id, "name": "Ravi Shankar"})
        self.a = _staff("SA1")
        self.b = _staff("SA2")
        for emp in (self.a, self.b):
            for n in range(2, 21):
                if date(2026, 2, n).weekday() != 6:
                    _day(emp, date(2026, 2, n))
        # SA2 took exactly 3 days of leave: warning
        for n in (9, 10, 11):
            _day(self.b, date(2026, 2, n), "absent", "0")
        today = patch("api.mobile_settlement_views.ist_today", return_value=DAY)
        today.start()
        self.addCleanup(today.stop)

    def automation(self, on=True, **emails):
        row = SettlementSettings.objects.order_by("id").first() or SettlementSettings.objects.create()
        row.method = "automation" if on else "normal"
        row.auditor_emails = emails.get("auditor", ["auditor@example.com"])
        row.accounts_emails = emails.get("accounts", ["accounts@example.com"])
        row.save()

    def apply(self, emp, kind="general", amount=5000, day=DAY):
        body = {"advanceType": kind, "amount": amount, "purpose": "Family needs"}
        if kind == "term":
            body["repaymentMonths"] = 5
        r = self.client.post(
            "/api/my/advances",
            body,
            content_type="application/json",
            **_bearer({"role": "employee", "employeeId": emp.id}),
        )
        self.assertEqual(r.status_code, 201, r.content)
        Advance.objects.filter(pk=r.json()["id"]).update(
            created_at=datetime(day.year, day.month, day.day, 6, 30, tzinfo=dt_timezone.utc)
        )
        return r.json()["id"]

    def month(self, auth=None, url="/api/settlement-automation/month?month=2&year=2026"):
        r = self.client.get(url, **(auth or self.hr))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def post(self, url, body=None, auth=None):
        return self.client.post(url, body or {}, content_type="application/json", **(auth or self.hr))

    def patch_(self, url, body, auth=None):
        return self.client.patch(url, body, content_type="application/json", **(auth or self.hr))


def _sent(*args, **kwargs):
    return SimpleNamespace(status="sent", pk=None, error_message="", http_status=200)


class SettingsTests(_FlowBase):
    def test_defaults_and_validation(self):
        body = self.client.get("/api/settlement-settings", **self.hr).json()
        self.assertEqual((body["method"], body["auditorEmails"], body["canChange"]), ("normal", [], True))
        r = self.client.put(
            "/api/settlement-settings",
            {"method": "automation", "auditorEmails": "a@x.com, b@x.com", "accountsEmails": ["acc@x.com"]},
            content_type="application/json",
            **self.hr,
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["method"], r.json()["auditorEmails"]), ("automation", ["a@x.com", "b@x.com"]))
        bad = self.client.put(
            "/api/settlement-settings", {"auditorEmails": "not-an-email"}, content_type="application/json", **self.hr
        )
        self.assertEqual((bad.status_code, bad.json()["code"]), (400, "email"))
        self.assertEqual(self.client.get("/api/settlement-automation/method", **self.hr).json()["method"], "automation")


class FlowTests(_FlowBase):
    def test_the_whole_workflow(self):
        self.automation()
        # two Salary Advances: one workflow (a Term Loan runs its own, see below - owner 2026-11-27)
        general = self.apply(self.a, "general", 5000)
        term = self.apply(self.b, "general", 6000)

        # 1-2: received, HR Review
        m = self.month()
        self.assertEqual((m["method"], m["received"], len(m["batches"])), ("automation", 2, 1))
        batch = m["batches"][0]
        self.assertEqual((batch["stage"], batch["number"], batch["counts"]["total"]), ("hr_review", 1, 2))
        self.assertEqual([t["state"] for t in batch["tracker"]][:3], ["done", "current", "pending"])
        flags = {i["advance"]["employeeCode"]: i["advance"]["leaveCheck"]["flag"] for i in batch["items"]}
        self.assertEqual(flags, {"SA1": "ok", "SA2": "warning"})
        self.assertEqual(batch["counts"]["warning"], 1)
        item_a = next(i for i in batch["items"] if i["advance"]["id"] == general)
        item_b = next(i for i in batch["items"] if i["advance"]["id"] == term)
        r = self.patch_(f"/api/settlement-automation/items/{item_a['id']}", {"hrNote": "Checked salary"})
        self.assertEqual(r.status_code, 200, r.content)

        # the Normal Method's approve is refused while the Automation Method is on
        put = self.client.put(
            f"/api/advances/{general}", {"status": "approved"}, content_type="application/json", **self.hr
        )
        self.assertEqual((put.status_code, put.json()["code"]), (409, "automation_method"))

        # Forward: refused when the list changed since HR looked
        bid = batch["id"]
        r = self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [general]})
        self.assertEqual((r.status_code, r.json()["code"]), (409, "changed"))
        r = self.post(
            f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [general, term], "note": "Ok"}
        )
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "md_review"), r.content)

        # forwarded: the employee can no longer withdraw, HR can no longer delete
        me = _bearer({"role": "employee", "employeeId": self.a.id})
        w = self.client.post(f"/api/my/requests/advance/{general}/withdraw", **me)
        self.assertEqual((w.status_code, w.json()["code"]), (409, "in_workflow"))
        d = self.client.delete(f"/api/advances/{general}", **self.hr)
        self.assertEqual((d.status_code, d.json()["code"]), (409, "in_workflow"))

        # a Salary Advance raised after the forward waits in Batch 2 of the same month
        c = _staff("SA3")
        for n in range(2, 21):
            if date(2026, 2, n).weekday() != 6:
                _day(c, date(2026, 2, n))
        late = self.apply(c, "general", 2000, day=date(2026, 2, 22))
        m = self.month()
        self.assertEqual([(b["number"], b["stage"]) for b in m["batches"]], [(1, "md_review"), (2, "hr_review")])
        self.assertEqual([i["advance"]["id"] for i in m["batches"][1]["items"]], [late])
        # a Term Loan is a workflow of its own: its own Batch 1, at HR Review, untouched by the Salary Advances
        loan = self.apply(self.a, "term", 3000, day=date(2026, 2, 25))
        t = self.month(url="/api/settlement-automation/month?month=2&year=2026&type=term")
        self.assertEqual((t["advanceType"], t["typeLabel"]), ("term", "Term Loan"))
        self.assertEqual(
            [(b["number"], b["stage"], b["advanceType"]) for b in t["batches"]], [(1, "hr_review", "term")]
        )
        self.assertEqual([i["advance"]["id"] for i in t["batches"][0]["items"]], [loan])
        overview = self.month(url="/api/settlement-automation/overview?month=2&year=2026")
        self.assertEqual(
            [(x["advanceType"], x["received"], x["currentBatch"]["stage"]) for x in overview["types"]],
            [("general", 3, "md_review"), ("term", 1, "hr_review")],
        )

        # 3: MD Review - only the MD, only what was forwarded
        self.assertEqual(self.client.get("/api/md/settlement/month?month=2&year=2026", **self.hr).status_code, 403)
        md_month = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")
        self.assertEqual([b["number"] for b in md_month["batches"]], [1])
        self.assertTrue(md_month["waitingForHr"])
        self.assertEqual(self.client.get("/api/md/settlement/waiting", **self.md).json()["count"], 2)
        self.assertNotIn("bankAccount", md_month["batches"][0]["items"][0]["advance"])
        r = self.patch_(f"/api/md/settlement/items/{item_a['id']}", {"decision": "approved", "amount": 4000}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark"))
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "undecided"))
        r = self.patch_(
            f"/api/md/settlement/items/{item_a['id']}",
            {"decision": "approved", "amount": 4000, "remark": "4,000 this month"},
            self.md,
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.patch_(f"/api/md/settlement/items/{item_b['id']}", {"decision": "rejected"}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark"))
        self.patch_(
            f"/api/md/settlement/items/{item_b['id']}", {"decision": "rejected", "remark": "Too much leave"}, self.md
        )
        # 2026-11-27: the MD changed both from HR's (empty) proposals, so they cannot approve - back to HR for rework
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {"note": "Go ahead"}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "has_changes"))
        self.assertEqual(sorted(r.json()["changed"]), sorted([item_a["id"], item_b["id"]]))
        r = self.post(f"/api/md/settlement/batches/{bid}/return", {"note": "Lower SA1, reject SA2"}, self.md)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "md_changes"), r.content)
        got = {i["id"]: (i["rework"], i["review"]) for i in r.json()["items"]}
        self.assertEqual(got, {item_a["id"]: ("md", "pending"), item_b["id"]: ("md", "pending")})
        r = self.post(f"/api/settlement-automation/batches/{bid}/resubmit-md", {})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "rework_open"))
        r = self.post(
            f"/api/settlement-automation/batches/{bid}/resolve-bulk",
            {"itemIds": [item_a["id"], item_b["id"]], "how": "accept"},
        )
        self.assertEqual((r.status_code, r.json()["skipped"], r.json()["counts"]["rework"]), (200, [], 0), r.content)
        r = self.post(f"/api/settlement-automation/batches/{bid}/resubmit-md", {"note": "Done as asked"})
        self.assertEqual((r.status_code, r.json()["stage"], r.json()["mdRound"]), (200, "md_review", 2), r.content)
        # the MD's decisions equal HR's revised proposals: they stand, and the MD can approve the revised settlement
        md_batch = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        self.assertEqual(
            (md_batch["counts"]["mdChanges"], md_batch["actions"]["canConfirmMd"], md_batch["counts"]["pending"]),
            (0, True, 0),
        )
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {"note": "Go ahead"}, self.md)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "hr_final"), r.content)

        # 4: HR Final Settlement, within the MD's decision
        r = self.patch_(f"/api/settlement-automation/items/{item_b['id']}/final", {"decision": "approved"})
        self.assertEqual((r.status_code, r.json()["code"]), (409, "md_rejected"))
        r = self.patch_(
            f"/api/settlement-automation/items/{item_a['id']}/final", {"decision": "approved", "amount": 4500}
        )
        self.assertEqual((r.status_code, r.json()["code"]), (400, "amount"))
        r = self.patch_(
            f"/api/settlement-automation/items/{item_a['id']}/final", {"decision": "approved", "amount": 3500}
        )
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark"))
        r = self.patch_(
            f"/api/settlement-automation/items/{item_a['id']}/final",
            {"decision": "approved", "amount": 3500, "remark": "MD asked to keep it lower"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Advance.objects.get(pk=general).status, "pending")  # nothing decided before Finalize
        r = self.post(f"/api/settlement-automation/batches/{bid}/finalize", {"note": "Final"})
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "auditor_send"), r.content)
        # 2026-11-27: the final settlement is locked, but written to the advances only once the audit is through
        self.assertEqual(Advance.objects.get(pk=general).status, "pending")
        self.assertFalse(AdvanceRepayment.objects.filter(advance_id=general).exists())

        # 5: Send to Auditor - the e-mail must really go
        pdf = SimpleUploadedFile("Settlement.pdf", b"%PDF-1.4 test", content_type="application/pdf")
        xlsx = SimpleUploadedFile("Settlement.xlsx", b"PK test", content_type="application/vnd.ms-excel")
        url = f"/api/settlement-automation/batches/{bid}/send-auditor"
        with patch("api.email_service.send_email", side_effect=_sent) as sent:
            r = self.client.post(url, {"pdf": pdf, "xlsx": xlsx}, **self.hr)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "auditor_review"), r.content)
        call = sent.call_args
        self.assertEqual((call.args[0], call.kwargs["to_email"]), ("settlement_auditor", "auditor@example.com"))
        self.assertEqual([f[0] for f in call.kwargs["attachments"]], ["Settlement.pdf", "Settlement.xlsx"])
        self.assertEqual(SettlementBatchFile.objects.filter(batch_id=bid).count(), 2)

        self.assertIn("/auditor-review/", call.kwargs["report_html"])
        self.assertIn("Review &amp; Confirm Settlement", call.kwargs["report_html"])

        # 6: HR confirms the auditor's review by hand (the auditor confirmed another way): now the advances are decided
        r = self.post(f"/api/settlement-automation/batches/{bid}/auditor-done", {"note": "Auditor OK on call"})
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "accounts_send"))
        a, b = Advance.objects.get(pk=general), Advance.objects.get(pk=term)
        self.assertEqual((a.status, a.amount, a.requested_amount), ("approved", Decimal("3500.00"), Decimal("5000.00")))
        self.assertEqual(a.decision_remark, "MD asked to keep it lower")
        self.assertEqual(
            list(AdvanceRepayment.objects.filter(advance=a).values_list("amount", flat=True)), [Decimal("3500.00")]
        )
        self.assertEqual((b.status, b.decision_remark), ("rejected", "Too much leave"))
        self.assertFalse(AdvanceRepayment.objects.filter(advance=b).exists())
        # 7-8: bank file to Accounts -> completed
        bank = SimpleUploadedFile("Bank.xlsx", b"PK bank", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent) as sent:
            r = self.client.post(f"/api/settlement-automation/batches/{bid}/send-accounts", {"bank": bank}, **self.hr)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "completed"), r.content)
        self.assertEqual(sent.call_args.args[0], "settlement_accounts")
        done = r.json()
        self.assertEqual(
            [t["state"] for t in done["tracker"]],
            ["done"] * 7 + ["skipped", "done", "done"],  # one MD rework cycle; no auditor changes: skipped
        )
        loop = next(t for t in done["tracker"] if t["key"] == "md_changes")
        self.assertEqual((loop["cycles"], loop["detail"]), (1, "Reworked and resubmitted once"))
        self.assertEqual((done["flow"]["mdCycles"], done["flow"]["mdPath"]), (1, "hr"))
        self.assertEqual(
            [h["action"] for h in done["history"]],
            [
                "forwarded",
                "md_returned",
                "md_resubmitted",
                "md_confirmed",
                "finalized",
                "auditor_sent",
                "auditor_confirmed",
                "accounts_sent",
                "completed",
            ],
        )
        f = done["files"][0]
        dl = self.client.get(f"/api/settlement-automation/files/{f['id']}", **self.hr)
        self.assertEqual((dl.status_code, dl.content), (200, b"PK bank"))

    def test_a_failed_email_does_not_move_the_workflow(self):
        self.automation()
        pk = self.apply(self.a)
        bid = self.month()["batches"][0]["id"]
        item = self.month()["batches"][0]["items"][0]["id"]
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [pk]})
        self.patch_(f"/api/md/settlement/items/{item}", {"decision": "approved"}, self.md)
        self.post(f"/api/md/settlement/batches/{bid}/confirm", {}, self.md)
        self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        failed = SimpleNamespace(status="failed", pk=None, error_message="SMTP said no", http_status=502)
        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", return_value=failed):
            r = self.client.post(
                f"/api/settlement-automation/batches/{bid}/send-auditor", {"pdf": pdf, "xlsx": xlsx}, **self.hr
            )
        self.assertEqual((r.status_code, r.json().get("code")), (502, "email_failed"), r.content)
        self.assertEqual(SettlementBatch.objects.get(pk=bid).stage, "auditor_send")

    def test_switching_back_to_normal_waits_for_the_workflow(self):
        self.automation()
        pk = self.apply(self.a)
        bid = self.month()["batches"][0]["id"]
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [pk]})
        r = self.client.put(
            "/api/settlement-settings", {"method": "normal"}, content_type="application/json", **self.hr
        )
        self.assertEqual((r.status_code, r.json()["code"]), (409, "workflow_in_progress"))

    def test_auto_reject_leaves_advances_to_the_workflow(self):
        self.automation()
        self.apply(self.a)
        self.assertFalse(auto_reject.due_queryset("advance", 1, today=date(2027, 1, 1)).exists())
        self.automation(on=False)
        self.assertTrue(auto_reject.due_queryset("advance", 1, today=date(2027, 1, 1)).exists())

    def test_normal_method_is_untouched(self):
        pk = self.apply(self.a)
        put = self.client.put(f"/api/advances/{pk}", {"status": "approved"}, content_type="application/json", **self.hr)
        self.assertEqual(put.status_code, 200, put.content)
        r = self.client.post(
            "/api/settlement-automation/batches/1/forward", {}, content_type="application/json", **self.hr
        )
        self.assertEqual((r.status_code, r.json()["code"]), (409, "normal_method"))
        # the list carries the leave check in the Normal Method too
        row = self.client.get("/api/advances", **self.hr).json()[0]
        self.assertEqual(row["leaveCheck"]["flag"], "ok")


class LeaveOnRequestsTests(_FlowBase):
    def test_critical_more_than_three_days(self):
        for n in (9, 10, 11, 12):
            _day(self.a, date(2026, 2, n), "on_leave", "0")
        LeaveRequest  # (approved leave days are stored On Leave by the engine)
        pk = self.apply(self.a)
        check = Advance.objects.get(pk=pk)
        self.assertEqual(
            (check.leave_days_1_20, advance_earnings.leave_flag(check.leave_days_1_20)), (Decimal("4"), "critical")
        )


class HubAndBranchTests(_FlowBase):
    def test_the_requests_hub_only_links_advances_to_the_workflow(self):
        def advance_kind():
            body = self.client.get("/api/hr-requests", **self.hr).json()
            return next(k for k in body["kinds"] if k["key"] == "advance")

        normal = advance_kind()
        self.assertEqual(
            (normal["mode"], normal["canApprove"]), ("link", True)
        )  # the hub never decides advances itself
        self.automation()
        auto = advance_kind()
        self.assertEqual(
            (auto["mode"], auto["canApprove"], auto["openPath"], auto["openLabel"]),
            ("link", False, "/hr/Loan&Advance", "Open the Loan & Advance workflow"),
        )

    def test_branch_figures_follow_the_items_shown(self):
        from .settlement_automation.views import _figures

        items = [
            {"advance": {"leaveCheck": {"flag": "warning"}}, "requestedAmount": 5000.0,
             "md": {"decision": "approved", "amount": 4000.0}, "final": {"decision": "approved", "amount": 3500.0}},
            {"advance": {"leaveCheck": None}, "requestedAmount": 2000.0,
             "md": {"decision": "rejected", "amount": None}, "final": {"decision": "rejected", "amount": None}},
        ]  # fmt: skip
        counts, amounts = _figures(items)
        self.assertEqual((counts["total"], counts["approved"], counts["rejected"], counts["warning"]), (2, 1, 1, 1))
        # the same keys as the full batch (2026-11-27): the rounded total (no baseAmount: what was asked) and payable
        self.assertEqual(
            amounts,
            {"requested": 7000.0, "rounded": 7000.0, "mdApproved": 4000.0, "finalApproved": 3500.0, "payable": 0.0},
        )
        items[0]["baseAmount"], items[1]["baseAmount"] = 4500.0, 2000.0
        items[0]["effective"] = {"decision": "approved", "amount": 3500.0}
        self.assertEqual((_figures(items)[1]["rounded"], _figures(items)[1]["payable"]), (6500.0, 3500.0))


class SplitMigrationTests(_FlowBase):
    def test_a_batch_that_held_both_types_is_split_in_two(self):
        import importlib

        from django.apps import apps

        from .models import SettlementBatchItem

        split_by_type = importlib.import_module("api.migrations.0189_settlement_batch_type").split_by_type
        general = Advance.objects.create(
            employee=self.a, advance_type="general", amount=Decimal("100"), outstanding=Decimal("100")
        )
        term = Advance.objects.create(
            employee=self.b, advance_type="term", amount=Decimal("900"), outstanding=Decimal("900")
        )
        mixed = SettlementBatch.objects.create(
            month=2, year=2026, number=1, stage="hr_final", md_note="Go", history=[{"action": "forwarded"}]
        )
        SettlementBatchItem.objects.create(batch=mixed, advance=general)
        SettlementBatchItem.objects.create(batch=mixed, advance=term)
        split_by_type(apps, None)
        mixed.refresh_from_db()
        loan_batch = SettlementBatch.objects.get(advance_type="term")
        self.assertEqual(
            (mixed.advance_type, loan_batch.number, loan_batch.stage, loan_batch.md_note),
            ("general", 1, "hr_final", "Go"),
        )
        self.assertEqual(list(mixed.items.values_list("advance_id", flat=True)), [general.id])
        self.assertEqual(list(loan_batch.items.values_list("advance_id", flat=True)), [term.id])


class AuditorPortalTests(_FlowBase):
    """The Auditor Review Portal (owner 2026-11-27): a secure, expiring link e-mailed to the auditor opens the finalized
    settlement without an HRMS login; the auditor checks figures and attendance, adds remarks, reduces or rejects, and
    approves (sending the bank file to Accounts, or back to HR) or forwards their changes to HR."""

    def finalized(self, amounts=(5000, 6000)):
        self.automation()
        ids = [self.apply(self.a, "general", amounts[0]), self.apply(self.b, "general", amounts[1])]
        m = self.month()
        bid = m["batches"][0]["id"]
        items = {i["advance"]["id"]: i["id"] for i in m["batches"][0]["items"]}
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        self.patch_(f"/api/md/settlement/items/{items[ids[0]]}", {"decision": "approved"}, self.md)
        self.patch_(f"/api/md/settlement/items/{items[ids[1]]}", {"decision": "approved"}, self.md)
        self.post(f"/api/md/settlement/batches/{bid}/confirm", {}, self.md)
        r = self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        self.assertEqual(r.status_code, 200, r.content)
        return bid, ids, items

    def send(self, bid):
        import re

        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent) as sent:
            r = self.client.post(
                f"/api/settlement-automation/batches/{bid}/send-auditor", {"pdf": pdf, "xlsx": xlsx}, **self.hr
            )
        self.assertEqual(r.status_code, 200, r.content)
        return re.search(r"/auditor-review/([A-Za-z0-9_-]+)", sent.call_args.kwargs["report_html"]).group(1)

    def portal(self, token, path="", method="get", body=None, **extra):
        url = f"/api/auditor-review/{token}{path}"
        if method == "get":
            return self.client.get(url)
        if method == "patch":
            return self.client.patch(url, body or {}, content_type="application/json")
        return self.client.post(url, body or {}, **extra)

    def test_the_link_opens_the_settlement_without_a_login(self):
        bid, ids, items = self.finalized()
        token = self.send(bid)
        r = self.portal(token)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            (body["settlement"]["typeLabel"], body["settlement"]["period"]), ("Salary Advance", "February 2026")
        )
        self.assertEqual(
            (len(body["items"]), body["canReview"], body["accounts"]["to"]), (2, True, ["accounts@example.com"])
        )
        row = body["items"][0]
        self.assertIn("earnings", row["advance"])
        self.assertIn("bankAccount", row["advance"])  # approved: the portal builds the bank file
        self.assertEqual(r["Cache-Control"], "no-store")
        # a wrong token, and the HR side sees the link's opening
        self.assertEqual(self.portal("x" * 43).status_code, 404)
        link = self.month()["batches"][0]["auditor"]["link"]
        self.assertEqual((link["openCount"], link["active"]), (1, True))
        self.assertNotIn("token", str(link))
        # the time card of an employee of this settlement only
        tc = self.portal(token, f"/timecard/{items[ids[0]]}")
        self.assertEqual(tc.status_code, 200, tc.content)
        self.assertEqual((tc.json()["employee"]["code"], tc.json()["month"]), ("SA1", 2))
        self.assertTrue(tc.json()["days"])
        self.assertEqual(self.portal(token, "/timecard/999999").status_code, 404)

    def test_a_new_send_revokes_the_old_link_and_an_expired_one_is_refused(self):
        from datetime import timedelta

        from django.utils import timezone

        from .models import SettlementAuditorLink

        bid, _ids, _items = self.finalized()
        old = self.send(bid)
        new = self.send(bid)
        self.assertEqual((self.portal(old).status_code, self.portal(old).json()["code"]), (410, "link_revoked"))
        self.assertEqual(self.portal(new).status_code, 200)
        SettlementAuditorLink.objects.filter(revoked_at__isnull=True).update(
            expires_at=timezone.now() - timedelta(minutes=1)
        )
        self.assertEqual(self.portal(new).json()["code"], "link_expired")

    def test_changes_go_back_to_hr_who_finalizes_the_revised_settlement(self):
        bid, ids, items = self.finalized()
        token = self.send(bid)
        a, b = items[ids[0]], items[ids[1]]
        # owner 2026-11-27: the auditor cannot reduce - they reject, or remark and return it for HR to change
        r = self.portal(token, f"/items/{a}", "patch", {"action": "reduce", "amount": 3000, "remark": "Cap at 3,000"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "reduce_not_allowed"))
        r = self.portal(token, f"/items/{a}", "patch", {"action": "reject", "remark": "Cap at 3,000"})
        self.assertEqual(r.status_code, 200, r.content)
        self.portal(token, f"/items/{b}", "patch", {"action": "reject", "remark": "Leave record unclear"})
        body = self.portal(token).json()
        self.assertEqual(
            (body["hasChanges"], body["totals"]["changes"], body["totals"]["approvedAmount"]), (True, 2, 0.0)
        )
        # with changes the auditor cannot approve; they forward to HR
        r = self.portal(token, "/submit", "post", {"decision": "approved_forward_hr"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "has_changes"))
        r = self.portal(token, "/submit", "post", {"decision": "changes_forward_hr", "note": "Please check"})
        self.assertEqual((r.status_code, r.json()["settlement"]["stage"]), (200, "auditor_changes"), r.content)
        self.assertFalse(r.json()["canReview"])
        self.assertEqual(Advance.objects.get(pk=ids[0]).status, "pending")  # nothing applied yet
        # read-only once answered
        again = self.portal(token, f"/items/{a}", "patch", {"action": ""})
        self.assertEqual((again.status_code, again.json()["code"]), (409, "submitted"))
        # HR sees every change and finalizes the revised settlement
        batch = self.month()["batches"][0]
        self.assertEqual(
            (batch["stage"], batch["auditor"]["outcome"], batch["auditor"]["changes"]),
            ("auditor_changes", "changes", 2),
        )
        row = next(i for i in batch["items"] if i["id"] == a)
        self.assertEqual(
            (row["auditor"]["action"], row["auditor"]["amount"], row["effective"]["decision"]), ("reject", None, "rejected")
        )
        self.assertEqual((row["rework"], row["review"]), ("auditor", "pending"))
        # 2026-11-27: no way to Accounts from here - HR answers and resubmits for the auditor's approval
        self.assertFalse(batch["actions"]["canResubmitAuditor"])
        r = self.post(f"/api/settlement-automation/batches/{bid}/resubmit-auditor", {})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "rework_open"))
        # HR changes the amount the auditor asked about (the auditor's rejection is answered by a lower amount)
        r = self.patch_(
            f"/api/settlement-automation/items/{a}/final",
            {"decision": "approved", "amount": 3000, "remark": "Cap at 3,000"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        row = next(i for i in r.json()["items"] if i["id"] == a)
        self.assertEqual(
            (row["final"]["amount"], row["final"]["remark"], row["rework"]), (3000.0, "Cap at 3,000", None)
        )
        r = self.post(f"/api/settlement-automation/items/{b}/resolve", {"how": "keep"})  # HR stands by its approval
        self.assertEqual(r.status_code, 200, r.content)
        r = self.post(f"/api/settlement-automation/batches/{bid}/resubmit-auditor", {"note": "Revised"})
        self.assertEqual(
            (r.status_code, r.json()["stage"], r.json()["auditorRound"]), (200, "auditor_send", 2), r.content
        )
        rows = {i["id"]: i for i in r.json()["items"]}
        self.assertEqual((rows[a]["auditor"]["action"], rows[b]["effective"]["decision"]), (None, "approved"))
        self.assertEqual([t["role"] for t in rows[b]["trail"]], ["hr_final", "auditor"])
        self.assertEqual(Advance.objects.get(pk=ids[0]).status, "pending")  # still nothing applied
        # round 2: a new link (the answered one is revoked); the auditor approves the revised settlement
        token2 = self.send(bid)
        self.assertEqual(self.portal(token).json()["code"], "link_revoked")
        body = self.portal(token2).json()
        self.assertEqual((body["settlement"]["round"], body["totals"]["approvedAmount"]), (2, 9000.0))
        trail_b = next(i for i in body["items"] if i["id"] == b)["trail"]
        self.assertEqual([t["role"] for t in trail_b], ["hr_final", "auditor"])
        r = self.portal(token2, "/submit", "post", {"decision": "approved_forward_hr"})
        self.assertEqual((r.status_code, r.json()["settlement"]["stage"]), (200, "accounts_send"), r.content)
        first, second = Advance.objects.get(pk=ids[0]), Advance.objects.get(pk=ids[1])
        self.assertEqual(
            (first.status, first.amount, first.decision_remark), ("approved", Decimal("3000.00"), "Cap at 3,000")
        )
        self.assertEqual((second.status, second.amount), ("approved", Decimal("6000.00")))
        states = {t["key"]: (t["state"], t["cycles"]) for t in self.month()["batches"][0]["tracker"]}
        self.assertEqual(
            (states["auditor_review"], states["auditor_changes"], states["accounts_send"]),
            (("done", None), ("done", 1), ("current", None)),
        )

    def test_approved_without_changes_the_auditor_sends_the_bank_file_to_accounts(self):
        bid, ids, items = self.finalized()
        token = self.send(bid)
        # a remark alone is not a change
        self.portal(token, f"/items/{items[ids[0]]}", "patch", {"action": "", "remark": "Checked the time card"})
        bank = SimpleUploadedFile("Bank.xlsx", b"PK bank", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent) as sent:
            r = self.portal(token, "/submit", "post", {"decision": "approved_send_accounts", "bank": bank})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            (sent.call_args.args[0], sent.call_args.kwargs["to_email"]), ("settlement_accounts", "accounts@example.com")
        )
        self.assertIsNone(r.json()["warning"])
        batch = self.month()["batches"][0]
        self.assertEqual(
            (batch["stage"], batch["accounts"]["sentVia"], batch["auditor"]["outcome"]),
            ("completed", "auditor", "approved"),
        )
        states = {t["key"]: (t["state"], t["detail"]) for t in batch["tracker"]}
        self.assertEqual(states["auditor_changes"], ("skipped", "No auditor changes"))
        self.assertEqual(states["accounts_send"], ("done", "Sent by the auditor"))
        self.assertEqual(Advance.objects.get(pk=ids[0]).status, "approved")

    def test_approved_and_forwarded_to_hr_who_sends_to_accounts(self):
        bid, ids, _items = self.finalized()
        token = self.send(bid)
        r = self.portal(token, "/submit", "post", {"decision": "approved_forward_hr"})
        self.assertEqual((r.status_code, r.json()["settlement"]["stage"]), (200, "accounts_send"), r.content)
        self.assertEqual(Advance.objects.get(pk=ids[1]).status, "approved")
        bank = SimpleUploadedFile("Bank.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent):
            r = self.client.post(f"/api/settlement-automation/batches/{bid}/send-accounts", {"bank": bank}, **self.hr)
        self.assertEqual((r.status_code, r.json()["accounts"]["sentVia"]), (200, "hr"))


class Round5Tests(_FlowBase):
    """HR review proposals, bulk steps, the MD's Direct to Auditor, the Leave calendars (owner 2026-11-27)."""

    def batch_with_two(self):
        self.automation()
        ids = [self.apply(self.a, "general", 5000), self.apply(self.b, "general", 6000)]
        m = self.month()
        b = m["batches"][0]
        items = {i["advance"]["id"]: i["id"] for i in b["items"]}
        return b["id"], ids, items

    def test_hr_proposals_are_the_mds_prefilled_decisions(self):
        bid, ids, items = self.batch_with_two()
        a, b = items[ids[0]], items[ids[1]]
        r = self.patch_(f"/api/settlement-automation/items/{a}", {"action": "reduce", "amount": 4000})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark"))
        r = self.patch_(f"/api/settlement-automation/items/{a}", {"action": "reduce", "amount": 4000, "hrNote": "Cap"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.post(f"/api/settlement-automation/batches/{bid}/hr-review-bulk", {"itemIds": [b], "action": "reject"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "remark"))
        r = self.post(
            f"/api/settlement-automation/batches/{bid}/hr-review-bulk",
            {"itemIds": [b], "action": "reject", "remark": "Too much leave"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        row = next(i for i in r.json()["items"] if i["id"] == a)
        self.assertEqual((row["hr"]["action"], row["hr"]["amount"]), ("reduce", 4000.0))
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        got = {i["id"]: (i["md"]["decision"], i["md"]["amount"], i["md"]["fromHr"]) for i in md["items"]}
        self.assertEqual(got, {a: ("approved", 4000.0, True), b: ("rejected", None, True)})
        self.assertTrue(md["actions"]["canConfirmMd"])  # the MD can accept HR's proposals as they are

    def test_md_bulk_and_hr_final_bulk(self):
        bid, ids, items = self.batch_with_two()
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        r = self.post(
            f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": list(items.values()), "decision": "approved"}, self.md
        )
        self.assertEqual((r.status_code, r.json()["counts"]["approved"], r.json()["skipped"]), (200, 2, []), r.content)
        self.post(f"/api/md/settlement/batches/{bid}/confirm", {"mode": "hr"}, self.md)
        r = self.post(
            f"/api/settlement-automation/batches/{bid}/final-bulk",
            {"itemIds": [items[ids[1]]], "decision": "rejected", "remark": "Budget"},
        )
        self.assertEqual((r.status_code, r.json()["counts"]["rejected"]), (200, 1), r.content)

    def test_md_direct_to_auditor_skips_hr_final(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        bid, ids, items = self.batch_with_two()
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        self.post(
            f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": list(items.values()), "decision": "approved"}, self.md
        )
        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent):
            r = self.client.post(
                f"/api/md/settlement/batches/{bid}/confirm", {"mode": "direct", "pdf": pdf, "xlsx": xlsx}, **self.md
            )
        self.assertEqual(
            (r.status_code, r.json()["stage"], r.json()["warning"]), (200, "auditor_review", None), r.content
        )
        b = self.month()["batches"][0]
        self.assertEqual((b["finalizedVia"], b["items"][0]["final"]["decision"]), ("md", "approved"))
        states = {t["key"]: (t["state"], t["detail"]) for t in b["tracker"]}
        self.assertEqual(states["hr_final"], ("skipped", "Finalized directly by the MD"))
        self.assertEqual(Advance.objects.get(pk=ids[0]).status, "pending")  # applied once the audit is through

    def test_md_direct_when_the_email_fails_stays_finalized(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        bid, ids, items = self.batch_with_two()
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        self.post(
            f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": list(items.values()), "decision": "approved"}, self.md
        )
        failed = SimpleNamespace(status="failed", pk=None, error_message="SMTP said no", http_status=502)
        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", return_value=failed):
            r = self.client.post(
                f"/api/md/settlement/batches/{bid}/confirm", {"mode": "direct", "pdf": pdf, "xlsx": xlsx}, **self.md
            )
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "auditor_send"), r.content)
        self.assertIn("could not be sent to the auditor", r.json()["warning"])

    def test_leave_calendars(self):
        _day(self.a, date(2026, 2, 3), "absent", "0")
        bid, ids, items = self.batch_with_two()
        r = self.client.get(f"/api/advances/{ids[0]}/leave-calendar", **self.hr)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([(d["date"], d["kind"]) for d in r.json()["days"]], [("2026-02-03", "absent")])
        self.assertEqual((r.json()["throughDay"], r.json()["total"]), (20, 1.0))
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        md = self.client.get(f"/api/md/settlement/items/{items[ids[0]]}/leave-calendar", **self.md)
        self.assertEqual((md.status_code, md.json()["total"]), (200, 1.0))


class ReworkTests(_FlowBase):
    """Rework and re-approval (owner 2026-11-27): every reviewer reopens what they decided before completing their stage;
    the MD's / auditor's changes send the settlement back to HR, who answers and resubmits; requests sort by where they
    stand with the current reviewer."""

    def forwarded(self):
        self.automation()
        ids = [self.apply(self.a, "general", 5000), self.apply(self.b, "general", 6000)]
        b = self.month()["batches"][0]
        items = {i["advance"]["id"]: i["id"] for i in b["items"]}
        return b["id"], ids, items

    def test_rework_reopens_a_request_in_hr_review_and_hr_final(self):
        bid, ids, items = self.forwarded()
        a, b = items[ids[0]], items[ids[1]]
        r = self.month()["batches"][0]
        self.assertEqual(({i["review"] for i in r["items"]}, r["counts"]["pending"]), ({"pending"}, 2))
        r = self.post(f"/api/settlement-automation/batches/{bid}/hr-review-bulk", {"itemIds": [a, b], "action": "approve"})
        self.assertEqual({i["id"]: (i["hr"]["action"], i["review"]) for i in r.json()["items"]}, {
            a: ("approve", "approved"),
            b: ("approve", "approved"),
        })
        r = self.post(f"/api/settlement-automation/items/{a}/rework")
        self.assertEqual(r.status_code, 200, r.content)
        row = next(i for i in r.json()["items"] if i["id"] == a)
        self.assertEqual((row["hr"]["action"], row["review"], r.json()["counts"]["pending"]), (None, "pending", 1))
        # a kept request waits for the MD (no pre-filled decision), as before
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        self.assertEqual({i["md"]["decision"] for i in md["items"]}, {None})
        # the MD reopens a decision of theirs: back to waiting
        self.patch_(f"/api/md/settlement/items/{a}", {"decision": "approved"}, self.md)
        r = self.patch_(f"/api/md/settlement/items/{a}", {"decision": ""}, self.md)
        self.assertEqual(next(i["review"] for i in r.json()["items"] if i["id"] == a), "pending")
        self.post(f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": [a, b], "decision": "approved"}, self.md)
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {"mode": "hr"}, self.md)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "hr_final"), r.content)
        # HR Final: Rework clears the final decision; Finalize waits for it
        r = self.post(f"/api/settlement-automation/items/{b}/rework")
        row = next(i for i in r.json()["items"] if i["id"] == b)
        self.assertEqual((row["final"]["decision"], row["review"]), (None, "pending"))
        r = self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "undecided"))
        self.patch_(f"/api/settlement-automation/items/{b}/final", {"decision": "approved"})
        r = self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "auditor_send"), r.content)
        # no Rework once the stage is completed
        r = self.post(f"/api/settlement-automation/items/{b}/rework")
        self.assertEqual((r.status_code, r.json()["code"]), (409, "stage"))

    def test_md_return_keep_and_second_round(self):
        bid, ids, items = self.forwarded()
        a, b = items[ids[0]], items[ids[1]]
        self.patch_(f"/api/settlement-automation/items/{a}", {"action": "reduce", "amount": 4000, "hrNote": "Cap 4k"})
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        # nothing to rework: refused without a change, a remark or a note
        r = self.post(f"/api/md/settlement/batches/{bid}/return", {}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "no_changes"))
        # HR's proposal pre-filled for the MD is no change; the MD lowers it further: a change
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        row = next(i for i in md["items"] if i["id"] == a)
        self.assertEqual((row["md"]["fromHr"], row["mdChanged"], row["review"]), (True, False, "pending"))
        self.patch_(f"/api/md/settlement/items/{a}", {"decision": "approved", "amount": 3000, "remark": "3k only"}, self.md)
        self.patch_(f"/api/md/settlement/items/{b}", {"decision": "approved"}, self.md)
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        self.assertEqual((md["counts"]["mdChanges"], md["actions"]["canConfirmMd"]), (1, False))
        r = self.post(f"/api/md/settlement/batches/{bid}/return", {"note": "See SA1"}, self.md)
        self.assertEqual(r.status_code, 200, r.content)
        rows = {i["id"]: i for i in r.json()["items"]}
        self.assertEqual((rows[a]["rework"], rows[b]["rework"]), ("md", None))
        self.assertEqual([t["role"] for t in rows[a]["trail"]], ["hr", "md"])
        self.assertEqual(r.json()["flow"]["mdReturn"]["note"], "See SA1")
        # HR stands by its 4,000 (keep): on resubmission the MD sees HR's proposal again, waiting for them
        r = self.post(f"/api/settlement-automation/items/{a}/resolve", {"how": "keep"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.post(f"/api/settlement-automation/batches/{bid}/resubmit-md", {})
        self.assertEqual((r.status_code, r.json()["mdRound"]), (200, 2), r.content)
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        rows = {i["id"]: i for i in md["items"]}
        self.assertEqual(
            (rows[a]["md"]["amount"], rows[a]["md"]["fromHr"], rows[a]["review"], rows[b]["review"]),
            (4000.0, True, "pending", "approved"),
        )
        steps = {t["key"]: t for t in md["tracker"]}
        self.assertEqual(
            (steps["md_review"]["state"], steps["md_review"]["round"], steps["md_changes"]["state"]),
            ("current", 2, "done"),
        )
        self.assertIn("round 2", steps["md_review"]["action"])
        # the MD accepts HR's 4,000 now: no change, approve
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {"mode": "hr"}, self.md)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "hr_final"), r.content)

    def test_auditor_returns_with_a_remark_only_and_explicit_approvals(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        import re

        bid, ids, items = self.forwarded()
        a, b = items[ids[0]], items[ids[1]]
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": ids})
        self.post(f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": [a, b], "decision": "approved"}, self.md)
        self.post(f"/api/md/settlement/batches/{bid}/confirm", {}, self.md)
        self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent) as sent:
            self.client.post(f"/api/settlement-automation/batches/{bid}/send-auditor", {"pdf": pdf, "xlsx": xlsx}, **self.hr)
        token = re.search(r"/auditor-review/([A-Za-z0-9_-]+)", sent.call_args.kwargs["report_html"]).group(1)
        url = f"/api/auditor-review/{token}"
        body = self.client.get(url).json()
        self.assertEqual(({i["review"] for i in body["items"]}, body["totals"]["pending"]), ({"pending"}, 2))
        r = self.client.patch(f"{url}/items/{a}", {"action": "approve"}, content_type="application/json")
        self.assertEqual(next(i["review"] for i in r.json()["items"] if i["id"] == a), "approved")
        r = self.client.patch(f"{url}/items/{a}", {"action": ""}, content_type="application/json")  # Rework
        self.assertEqual(next(i["review"] for i in r.json()["items"] if i["id"] == a), "pending")
        # nothing changed and nothing said: no return
        r = self.client.post(f"{url}/submit", {"decision": "changes_forward_hr"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "no_changes"))
        # a reduction is open in the portal: HR cannot confirm the review by hand
        self.client.patch(f"{url}/items/{b}", {"action": "reject", "remark": "Test"}, content_type="application/json")
        r = self.post(f"/api/settlement-automation/batches/{bid}/auditor-done", {})
        self.assertEqual((r.status_code, r.json()["code"]), (409, "auditor_changes_open"))
        self.client.patch(f"{url}/items/{b}", {"action": "approve", "remark": "Check the bank IFSC"}, content_type="application/json")
        r = self.client.post(f"{url}/submit", {"decision": "changes_forward_hr", "note": "One correction"})
        self.assertEqual((r.status_code, r.json()["settlement"]["stage"]), (200, "auditor_changes"), r.content)
        batch = self.month()["batches"][0]
        rows = {i["id"]: i for i in batch["items"]}
        self.assertEqual((rows[a]["rework"], rows[b]["rework"]), (None, "auditor"))
        self.assertEqual((rows[a]["review"], rows[b]["review"]), ("approved", "pending"))
        # nothing can go to Accounts while HR reworks
        bank = SimpleUploadedFile("Bank.xlsx", b"PK", content_type="application/vnd.ms-excel")
        r = self.client.post(f"/api/settlement-automation/batches/{bid}/send-accounts", {"bank": bank}, **self.hr)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "stage"))


class RoundingTests(_FlowBase):
    """Salary Advance rounding (owner 2026-11-27): at HR Review the amount asked for is capped at the eligible limit and
    rounded to the nearest ₹500 (never above the limit); it is the workflow's "as asked" amount from then on."""

    def test_rounded_amounts_drive_the_workflow_and_a_round_up_is_paid(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        self.automation()
        capped = self.apply(self.a, "general", 5000)  # the limit is brought down to 3,760 below: -> 3,500
        rounded_up = self.apply(self.b, "general", 4800)  # limit 5,440: -> 5,000 (more than asked, within the limit)
        Advance.objects.filter(pk=capped).update(earned_limit=Decimal("3760"))
        Advance.objects.filter(pk=rounded_up).update(earned_limit=Decimal("5440"))
        loan = self.apply(self.a, "term", 3000, day=date(2026, 2, 25))
        batch = self.month()["batches"][0]
        rows = {i["advance"]["id"]: i for i in batch["items"]}
        self.assertEqual(
            rows[capped]["rounding"],
            {"requested": 5000.0, "limit": 3760.0, "rounded": 3500.0, "capped": True, "direction": "down", "zero": False},
        )
        self.assertEqual((rows[rounded_up]["rounding"]["rounded"], rows[rounded_up]["rounding"]["direction"]), (5000.0, "up"))
        self.assertEqual((rows[capped]["baseAmount"], batch["amounts"]["rounded"]), (3500.0, 8500.0))
        term = self.month(url="/api/settlement-automation/month?month=2&year=2026&type=term")["batches"][0]
        self.assertEqual((term["items"][0]["rounding"], term["items"][0]["baseAmount"]), (None, 3000.0))
        self.assertEqual(term["items"][0]["advance"]["id"], loan)
        a, b = rows[capped]["id"], rows[rounded_up]["id"]
        bid = batch["id"]
        # HR: a reduction must be below the ROUNDED amount
        r = self.patch_(f"/api/settlement-automation/items/{a}", {"action": "reduce", "amount": 3600, "hrNote": "Lower"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "amount"))
        self.post(f"/api/settlement-automation/batches/{bid}/hr-review-bulk", {"itemIds": [a, b], "action": "approve"})
        self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [capped, rounded_up]})
        # frozen at Forward: a limit worked out again later changes nothing
        Advance.objects.filter(pk=capped).update(earned_limit=Decimal("9000"))
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        self.assertEqual({i["id"]: i["baseAmount"] for i in md["items"]}, {a: 3500.0, b: 5000.0})
        # the MD: never above the rounded amount; the full approval IS the rounded amount, and is no change from HR
        r = self.patch_(f"/api/md/settlement/items/{a}", {"decision": "approved", "amount": 4000, "remark": "x y z"}, self.md)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "amount"))
        r = self.post(f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": [a, b], "decision": "approved"}, self.md)
        self.assertEqual({i["id"]: i["md"]["amount"] for i in r.json()["items"]}, {a: 3500.0, b: 5000.0})
        self.assertEqual(r.json()["counts"]["mdChanges"], 0)
        r = self.post(f"/api/md/settlement/batches/{bid}/confirm", {"mode": "hr"}, self.md)
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "hr_final"), r.content)
        self.post(f"/api/settlement-automation/batches/{bid}/finalize", {})
        pdf = SimpleUploadedFile("r.pdf", b"%PDF", content_type="application/pdf")
        xlsx = SimpleUploadedFile("r.xlsx", b"PK", content_type="application/vnd.ms-excel")
        with patch("api.email_service.send_email", side_effect=_sent):
            self.client.post(f"/api/settlement-automation/batches/{bid}/send-auditor", {"pdf": pdf, "xlsx": xlsx}, **self.hr)
        r = self.post(f"/api/settlement-automation/batches/{bid}/auditor-done", {})
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "accounts_send"), r.content)
        first, second = Advance.objects.get(pk=capped), Advance.objects.get(pk=rounded_up)
        self.assertEqual((first.status, first.amount, first.requested_amount), ("approved", Decimal("3500.00"), Decimal("5000.00")))
        # rounded up: paid ₹5,000 although ₹4,800 was asked (the owner's rule), the request itself unchanged
        self.assertEqual((second.status, second.amount, second.requested_amount), ("approved", Decimal("5000.00"), Decimal("4800.00")))

    def test_a_request_that_rounds_to_zero_can_only_be_rejected(self):
        self.automation()
        pk = self.apply(self.a, "general", 5000)
        Advance.objects.filter(pk=pk).update(earned_limit=Decimal("240"))
        item = self.month()["batches"][0]["items"][0]
        self.assertEqual((item["rounding"]["rounded"], item["rounding"]["zero"]), (0.0, True))
        r = self.patch_(f"/api/settlement-automation/items/{item['id']}", {"action": "keep"})
        self.assertEqual((r.status_code, r.json()["code"]), (400, "rounds_to_zero"))
        r = self.patch_(f"/api/settlement-automation/items/{item['id']}", {"action": "reject", "hrNote": "Below Rs 250"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_lower_limit_reopens_an_hr_reduction_that_is_no_longer_below_the_rounding(self):
        # review finding 2026-11-27: a reduced figure must never go forward above the rounded amount (or the limit)
        self.automation()
        pk = self.apply(self.a, "general", 5000)
        Advance.objects.filter(pk=pk).update(earned_limit=Decimal("10000"))
        item = self.month()["batches"][0]["items"][0]
        r = self.patch_(f"/api/settlement-automation/items/{item['id']}", {"action": "reduce", "amount": 4700, "hrNote": "Cap it"})
        self.assertEqual(r.status_code, 200, r.content)
        Advance.objects.filter(pk=pk).update(earned_limit=Decimal("4600"))  # the limit worked out again, lower
        row = self.month()["batches"][0]["items"][0]
        self.assertEqual(
            (row["rounding"]["rounded"], row["hr"]["action"], row["hr"]["amount"], row["review"], row["hrNote"]),
            (4500.0, None, None, "pending", "Cap it"),
        )

    def test_a_zero_request_goes_forward_only_as_hr_rejection_and_the_md_rejecting_it_is_no_change(self):
        self.automation()
        zero = self.apply(self.a, "general", 5000)
        other = self.apply(self.b, "general", 5000)
        Advance.objects.filter(pk=zero).update(earned_limit=Decimal("240"))
        batch = self.month()["batches"][0]
        rows = {i["advance"]["id"]: i["id"] for i in batch["items"]}
        bid = batch["id"]
        r = self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [zero, other]})
        self.assertEqual((r.status_code, r.json()["code"], r.json()["zero"]), (400, "rounds_to_zero", [rows[zero]]))
        self.patch_(f"/api/settlement-automation/items/{rows[zero]}", {"action": "reject", "hrNote": "Rounds to Rs 0"})
        r = self.post(f"/api/settlement-automation/batches/{bid}/forward", {"advanceIds": [zero, other]})
        self.assertEqual((r.status_code, r.json()["stage"]), (200, "md_review"), r.content)
        self.post(f"/api/md/settlement/batches/{bid}/bulk", {"itemIds": [rows[other]], "decision": "approved"}, self.md)
        self.patch_(f"/api/md/settlement/items/{rows[zero]}", {"decision": "rejected", "remark": "Nothing to pay"}, self.md)
        md = self.month(self.md, "/api/md/settlement/month?month=2&year=2026")["batches"][0]
        self.assertEqual((md["counts"]["mdChanges"], md["actions"]["canConfirmMd"]), (0, True))

    def test_the_rounded_amount_is_the_strict_top_when_paying(self):
        from .settlement_views import _apply_amount_and_start

        self.automation()
        pk = self.apply(self.a, "general", 5000)
        adv = Advance.objects.get(pk=pk)
        # rounded below what was asked: nothing above the rounding is paid (was: up to the amount asked)
        self.assertIn("rounded", _apply_amount_and_start(adv, {"amount": "4700"}, "pending", ceiling=Decimal("4500")))
        self.assertIsNone(_apply_amount_and_start(adv, {"amount": "4500"}, "pending", ceiling=Decimal("4500")))
        # the Normal Method (no ceiling): the amount asked is the top, as before
        adv = Advance.objects.get(pk=pk)
        self.assertIn("asked for", _apply_amount_and_start(adv, {"amount": "5001"}, "pending"))

