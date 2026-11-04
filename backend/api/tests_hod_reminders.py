"""
HR Requests page -> HoD's / Notify: what is pending with every Department Head (GET /api/hr/hod-pending) and the reminders
sent to them (hod_reminders.py, hod_reminders_views.py, hod_reminder_scheduler.py).

Pinned here:
  * "pending with a head" is the one rule of the mobile Approvals tab: the counts equal /api/manager/requests/summary for
    every head (carve-outs, individual assignments, the head's own request, a switched-off category = null, a pipeline
    where HR goes first), and the bulk scope equals managed_employee_ids head by head;
  * the endpoint's shape, filters, branch scope, kind access, and that its queries do not grow with heads or requests;
  * the wording (the owner's default text, {{pendingList}}, the date) and the schedule's due check (weekday, the 10-minute
    window, no double run, disabled) as pure functions;
  * settings validation, company-wide refusal, view-only access, the audit row;
  * sending: never inside the request (202 + background), ONE push per head per round (the WhatsApp message does not
    announce), the push switch working with WhatsApp off, every channel's "skipped" reason, exactly-once under a restart,
    the unique (date, slot) of a scheduled round.

No real WhatsApp / email / push leaves: WAClient, SMTP and Expo are mocked in every test that could reach them.

Run: DATABASE_URL= DB_TEST_NAME=uktex_test_hodrem python manage.py test api.tests_hod_reminders --noinput
"""

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest import mock

from django.db import IntegrityError, connection, transaction
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import approval_workflow as approval
from . import hod_reminders as rem
from .hod_scope import managed_employee_ids, managed_employee_map
from .jwt_utils import sign_token
from .models import (
    ApprovalWorkflowConfig,
    AuditLog,
    Branch,
    CasualLeaveRequest,
    Department,
    DepartmentManager,
    Designation,
    EmailMessageLog,
    Employee,
    EmployeePermission,
    HodReminderDelivery,
    HodReminderRun,
    HodReminderSettings,
    HolidayWorkClaim,
    HRUser,
    LeaveRequest,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
    ManagerEmployeeExclusion,
    MissingPunchRequest,
    MobileMessageSettings,
    Notification,
    OutpassRequest,
    PayrollSettings,
    PushToken,
    ResignationRequest,
    Role,
    WhatsAppMessageLog,
    WhatsAppSettings,
)
from .notification_targets import target_for

# Expo (signals.py) and WAClient (whatsapp_service.py) both call requests.post: one patch, routed by address.
POST = "requests.post"
SMTP = "api.email_service.smtplib.SMTP"
LAUNCH = "api.hod_reminders.launch"

SENDING = dict(
    WACLIENT_INSTANCE_ID="INST1",
    WACLIENT_ACCESS_TOKEN="tok",
    WHATSAPP_ALLOW_SENDING=True,
    EMAIL_ALLOW_SENDING=True,
    WHATSAPP_SEND_DELAY_SECONDS=0,
    WHATSAPP_DEFAULT_COUNTRY_CODE="91",
)


def _wa_ok():
    r = mock.Mock(status_code=200, content=b"x", text="")
    r.json.return_value = {"status": "success", "message_payload": {"key": {"id": "WAID"}}}
    return r


def _expo_ok(*_args, **kwargs):
    messages = kwargs.get("json") or []
    return mock.Mock(ok=True, json=lambda: {"data": [{"status": "ok", "id": f"t{i}"} for i in range(len(messages))]})


def _hr(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': user.full_name})}"}


def _emp_token(emp) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': emp.id})}"}


def _emp(code, first, dept=None, branch=None, **kw):
    return Employee.objects.create(
        employee_code=code,
        first_name=first,
        last_name="Test",
        status="active",
        employment_type="staff",
        department=dept,
        branch=branch,
        **kw,
    )


def _leave(emp, start="2026-11-05", end=None, **kw):
    return LeaveRequest.objects.create(
        employee=emp, type="casual", start_date=start, end_date=end or start, approval_trail=[], **kw
    )


def _age(obj, days):
    """Make a request look raised `days` ago."""
    type(obj).objects.filter(pk=obj.pk).update(created_at=timezone.now() - timedelta(days=days))


class _World(TestCase):
    """Branch North: Sewing (head Suresh; staff Asha, Bala, Chitra) and Cutting (head Kavin, whose Casual Leave switch is
    off; staff Dev). Branch South: Sewing (head Ravi; staff Esha). Suresh has a phone, an email and a registered phone for
    notifications; Ravi has none of them."""

    def setUp(self):
        super().setUp()
        approval.clear_cache()
        self.addCleanup(approval.clear_cache)
        self.expo = mock.Mock(side_effect=_expo_ok)
        self.wa = mock.Mock(return_value=_wa_ok())

        def route(url, *args, **kwargs):
            return (self.expo if "exp.host" in url else self.wa)(url, *args, **kwargs)

        post = mock.patch(POST, side_effect=route)
        post.start()
        self.addCleanup(post.stop)

        self.north = Branch.objects.create(name="North", code="N")
        self.south = Branch.objects.create(name="South", code="S")
        self.sewing = Department.objects.create(name="Sewing", branch=self.north)
        self.cutting = Department.objects.create(name="Cutting", branch=self.north)
        self.sewing_south = Department.objects.create(name="Sewing South", branch=self.south)
        self.supervisor = Designation.objects.create(title="Supervisor")

        self.suresh = _emp(
            "H1",
            "Suresh",
            self.sewing,
            self.north,
            phone="9876500001",
            email="suresh@example.test",
            designation=self.supervisor,
        )
        self.m = DepartmentManager.objects.create(employee=self.suresh)
        ManagerDepartmentAssignment.objects.create(manager=self.m, department=self.sewing)
        PushToken.objects.create(employee=self.suresh, token="ExponentPushToken[suresh]")

        self.kavin = _emp("H3", "Kavin", self.cutting, self.north, phone="9876500003", email="kavin@example.test")
        self.m_cut = DepartmentManager.objects.create(employee=self.kavin, can_approve_casual_leave=False)
        ManagerDepartmentAssignment.objects.create(manager=self.m_cut, department=self.cutting)

        self.asha = _emp("E1", "Asha", self.sewing, self.north)
        self.bala = _emp("E2", "Bala", self.sewing, self.north)
        self.chitra = _emp("E3", "Chitra", self.sewing, self.north)
        self.dev = _emp("E4", "Dev", self.cutting, self.north)

        self.ravi = _emp("H2", "Ravi", self.sewing_south, self.south)
        self.m_south = DepartmentManager.objects.create(employee=self.ravi)
        ManagerDepartmentAssignment.objects.create(manager=self.m_south, department=self.sewing_south)
        self.esha = _emp("E5", "Esha", self.sewing_south, self.south)

        self.admin = HRUser.objects.create(
            username="hodrem_admin", full_name="Admin Asha", password_hash="x", is_super_admin=True
        )
        self.auth = _hr(self.admin)

    # ── helpers ──
    def get(self, path, auth=None, **params):
        return self.client.get(path, params, **(auth or self.auth))

    def post(self, path, body=None, auth=None):
        return self.client.post(path, body or {}, content_type="application/json", **(auth or self.auth))

    def put(self, path, body, auth=None):
        return self.client.put(path, body, content_type="application/json", **(auth or self.auth))

    def overview(self, auth=None, **params):
        res = self.get("/api/hr/hod-pending", auth, **params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def head(self, body, manager):
        return next(h for h in body["hods"] if h["managerId"] == manager.id)

    def role_user(self, name, permissions, branch=None, **kw):
        role = Role.objects.create(name=f"hodrem_{name}", permissions=permissions)
        return HRUser.objects.create(
            username=f"hodrem_{name}", full_name=name, password_hash="x", role=role, branch=branch, **kw
        )

    def standard_requests(self):
        """Asha: a leave (3 days, raised 4 days ago); Bala: a permission and a half-day casual leave; Chitra: a missing
        punch; Suresh's own leave; Dev's casual leave (Kavin may not decide casual leave); Esha's leave (South)."""
        self.asha_leave = _leave(self.asha, "2026-11-05", "2026-11-07", total_days=Decimal("3"))
        _age(self.asha_leave, 4)
        self.bala_perm = EmployeePermission.objects.create(
            employee=self.bala,
            date=date(2026, 11, 5),
            permission_time=time(9, 30),
            reason="x",
            type="morning_late_in",
            duration_minutes=60,
            approval_trail=[],
        )
        self.bala_cl = CasualLeaveRequest.objects.create(
            employee=self.bala, date=date(2026, 11, 6), portion="first_half", reason="x", approval_trail=[]
        )
        self.chitra_mp = MissingPunchRequest.objects.create(
            employee=self.chitra,
            date=date(2026, 11, 3),
            punch_time=time(9, 2),
            punch_type="IN",
            punch_slot="morning_in",
            reason="x",
            status="pending_hod",
            approval_trail=[],
        )
        _leave(self.suresh, "2026-11-10")  # the head's own: never pending with himself
        self.dev_cl = CasualLeaveRequest.objects.create(
            employee=self.dev, date=date(2026, 11, 6), reason="x", approval_trail=[]
        )
        self.esha_leave = _leave(self.esha, "2026-11-12")
        _leave(self.asha, "2026-10-01", status="approved")  # decided: not pending


# ─────────────────────────── the one rule ───────────────────────────


class OneRuleTests(_World):
    def test_the_bulk_scope_is_managed_employee_ids_for_every_head(self):
        ManagerEmployeeExclusion.objects.create(manager=self.m, employee=self.chitra)
        ManagerEmployeeAssignment.objects.create(manager=self.m_cut, employee=self.bala)  # individual beats department
        other = DepartmentManager.objects.create(employee=_emp("H4", "Mani", self.sewing, self.north))
        ManagerDepartmentAssignment.objects.create(manager=other, department=self.sewing)  # a later holder
        heads = list(DepartmentManager.objects.filter(is_active=True))
        bulk = managed_employee_map(heads)
        for m in heads:
            self.assertEqual(bulk[m.id], set(managed_employee_ids(m)), m.employee.first_name)
        self.assertIn(self.chitra.id, bulk[other.id])  # carved out of Suresh: falls to the next holder
        self.assertIn(self.bala.id, bulk[self.m_cut.id])

    def test_counts_equal_the_heads_own_approvals_tab(self):
        self.standard_requests()
        ManagerEmployeeExclusion.objects.create(manager=self.m, employee=self.chitra)  # carved out: nobody's now
        ManagerEmployeeAssignment.objects.create(manager=self.m_cut, employee=self.asha)  # Asha reports to Kavin
        OutpassRequest.objects.create(employee=self.bala, destination="Bank", reason="x", approval_trail=[])
        HolidayWorkClaim.objects.create(
            employee=self.asha, work_date=date(2026, 11, 2), shifts=Decimal("1.00"), approval_trail=[]
        )
        ResignationRequest.objects.create(employee=self.bala, reason="x", approval_trail=[])
        # HR decides permissions first: a waiting permission is not with the head yet
        ApprovalWorkflowConfig.objects.create(
            key="permission", steps=[{"roles": ["hr"], "mandatory": True}, {"roles": ["hod"], "mandatory": True}]
        )
        approval.clear_cache()
        body = self.overview()
        for m in (self.m, self.m_cut, self.m_south):
            mobile = self.client.get("/api/manager/requests/summary", **_emp_token(m.employee))
            self.assertEqual(mobile.status_code, 200, mobile.content)
            expected = {c["key"]: c["pending"] for c in mobile.json()["categories"]}
            got = self.head(body, m)["byCategory"]
            self.assertEqual({k: v for k, v in got.items() if v is not None}, expected, m.employee.first_name)
            self.assertEqual({k for k, v in got.items() if v is None}, {c.key for c in rem.CATEGORIES} - set(expected))
        suresh = self.head(body, self.m)
        self.assertEqual(suresh["byCategory"]["permission"], 0)  # HR first
        self.assertEqual(suresh["byCategory"]["missing_punch"], 0)  # Chitra carved out
        kavin = self.head(body, self.m_cut)
        self.assertIsNone(kavin["byCategory"]["casual_leave"])  # switched off: null, not 0
        self.assertEqual(kavin["byCategory"]["leave"], 1)  # Asha's leave follows her individual assignment
        self.assertEqual(kavin["byCategory"]["holiday_work"], 1)

    def test_the_heads_own_request_and_decided_ones_are_never_pending(self):
        self.standard_requests()
        suresh = self.head(self.overview(), self.m)
        self.assertNotIn(self.suresh.id, {i["employeeId"] for i in suresh["items"]})
        self.assertEqual(suresh["byCategory"]["leave"], 1)


# ─────────────────────────── GET /hr/hod-pending ───────────────────────────


class OverviewTests(_World):
    def test_shape_sorting_and_item_texts(self):
        self.standard_requests()
        body = self.overview()
        self.assertEqual(
            [c["key"] for c in body["categories"]],
            [
                "leave",
                "permission",
                "casual_leave",
                "attendance",
                "missing_punch",
                "on_duty",
                "outpass",
                "holiday_work",
                "resignation",
            ],
        )
        # most pending first, then by name
        self.assertEqual([h["name"] for h in body["hods"]], ["Suresh Test", "Ravi Test", "Kavin Test"])
        suresh = body["hods"][0]
        self.assertEqual(suresh["pending"], 4)
        self.assertEqual(suresh["code"], "H1")
        self.assertEqual(suresh["designation"], "Supervisor")
        self.assertEqual(suresh["departments"], ["Sewing"])
        self.assertEqual(suresh["branch"], "North")
        self.assertEqual(
            (suresh["phone"], suresh["email"], suresh["devices"]), ("9876500001", "suresh@example.test", 1)
        )
        self.assertEqual(suresh["oldestDays"], 4)
        self.assertEqual(suresh["items"][0]["id"], self.asha_leave.id)  # oldest first
        by_cat = {i["category"]: i for i in suresh["items"]}
        self.assertEqual(by_cat["leave"]["forText"], "05 - 07 Nov 2026")
        self.assertEqual(by_cat["leave"]["summary"], "Casual Leave · 3 days")
        self.assertEqual(by_cat["leave"]["waitingDays"], 4)
        self.assertEqual(by_cat["leave"]["openPath"], f"/hr/requests?kind=leave&focus={self.asha_leave.id}")
        self.assertEqual(by_cat["permission"]["forText"], "Morning Late-In · 05 Nov")
        self.assertEqual(by_cat["permission"]["summary"], "Permission · 60 min at 09:30")
        self.assertEqual(by_cat["casual_leave"]["summary"], "Casual Leave · First half")
        self.assertEqual(by_cat["casual_leave"]["forText"], "06 Nov 2026")
        self.assertEqual(by_cat["missing_punch"]["summary"], "Missing Punch · Morning Check-In 09:02")
        self.assertEqual(
            by_cat["missing_punch"]["openPath"], f"/hr/requests?kind=missing_punch&focus={self.chitra_mp.id}"
        )
        self.assertEqual(
            set(by_cat["leave"]),
            {
                "category",
                "categoryLabel",
                "id",
                "employeeId",
                "employeeCode",
                "employeeName",
                "department",
                "forText",
                "summary",
                "raisedAt",
                "waitingDays",
                "openPath",
            },
        )
        ravi = self.head(body, self.m_south)
        self.assertEqual((ravi["phone"], ravi["email"], ravi["devices"]), (None, None, 0))
        kavin = self.head(body, self.m_cut)
        self.assertEqual((kavin["pending"], kavin["oldestPendingAt"], kavin["oldestDays"]), (0, None, None))
        self.assertEqual(
            body["totals"],
            {
                "hods": 3,
                "withPending": 2,
                "pending": 5,
                "byCategory": {
                    "leave": 2,
                    "permission": 1,
                    "casual_leave": 1,
                    "attendance": 0,
                    "missing_punch": 1,
                    "on_duty": 0,
                    "outpass": 0,
                    "holiday_work": 0,
                    "resignation": 0,
                },
            },
        )

    def test_filters(self):
        self.standard_requests()
        self.assertEqual([h["name"] for h in self.overview(onlyPending="1")["hods"]], ["Suresh Test", "Ravi Test"])
        self.assertEqual(self.overview(onlyPending="1")["totals"]["hods"], 3)
        self.assertEqual([h["name"] for h in self.overview(branchId=self.south.id)["hods"]], ["Ravi Test"])
        self.assertEqual([h["name"] for h in self.overview(departmentId=self.cutting.id)["hods"]], ["Kavin Test"])
        self.assertEqual([h["name"] for h in self.overview(search="h2")["hods"]], ["Ravi Test"])
        self.assertEqual([h["name"] for h in self.overview(search="sewing south")["hods"]], ["Ravi Test"])
        self.assertEqual(self.get("/api/hr/hod-pending", branchId="x").status_code, 400)

    def test_a_branch_login_sees_its_own_branch_only(self):
        self.standard_requests()
        user = self.role_user("north", {"requests": "edit", "leave": "view", "casual_leave": "view"}, branch=self.north)
        body = self.overview(_hr(user))
        self.assertEqual({h["name"] for h in body["hods"]}, {"Suresh Test", "Kavin Test"})
        user_south = self.role_user("south", {"requests": "view", "leave": "view"}, branch=self.south)
        self.assertEqual([h["name"] for h in self.overview(_hr(user_south))["hods"]], ["Ravi Test"])

    def test_access_follows_the_requests_page(self):
        self.standard_requests()
        hidden = self.role_user("hidden", {"requests": "hidden"})
        self.assertEqual(self.get("/api/hr/hod-pending", _hr(hidden)).status_code, 403)
        # the kinds whose own module the role cannot open are left out, as on the Requests page
        narrow = self.role_user("narrow", {"requests": "view", "leave": "view"})
        body = self.overview(_hr(narrow))
        self.assertEqual([c["key"] for c in body["categories"]], ["leave", "permission", "outpass"])
        suresh = self.head(body, self.m)
        self.assertEqual(set(suresh["byCategory"]), {"leave", "permission", "outpass"})
        self.assertEqual({i["category"] for i in suresh["items"]}, {"leave", "permission"})
        emp = self.client.get("/api/hr/hod-pending", **_emp_token(self.suresh))
        self.assertEqual(emp.status_code, 403)

    def test_queries_do_not_grow_with_heads_or_requests(self):
        self.standard_requests()

        def count() -> int:
            with CaptureQueriesContext(connection) as ctx:
                self.overview()
            return len(ctx.captured_queries)

        before = count()
        for n in range(4):  # four more heads, each with requests in several categories
            dept = Department.objects.create(name=f"Dept {n}", branch=self.north)
            head = DepartmentManager.objects.create(employee=_emp(f"HX{n}", f"Head{n}", dept, self.north))
            ManagerDepartmentAssignment.objects.create(manager=head, department=dept)
            PushToken.objects.create(employee=head.employee, token=f"ExponentPushToken[x{n}]")
            for k in range(3):
                e = _emp(f"EX{n}{k}", f"Staff{n}{k}", dept, self.north)
                _leave(e)
                CasualLeaveRequest.objects.create(employee=e, date=date(2026, 11, 7), reason="x", approval_trail=[])
                MissingPunchRequest.objects.create(
                    employee=e,
                    date=date(2026, 11, 3),
                    punch_time=time(9, 0),
                    punch_type="IN",
                    reason="x",
                    status="pending_hod",
                    approval_trail=[],
                )
        self.assertEqual(count(), before)
        self.assertLessEqual(before, 40)


# ─────────────────────────── wording and schedule (pure) ───────────────────────────


class WordingTests(SimpleTestCase):
    def test_the_owners_default_message(self):
        text = rem.render(
            rem.DEFAULT_TEMPLATE,
            name="Suresh Kumar",
            by_category={"leave": 3, "permission": 1, "missing_punch": 2, "casual_leave": 0, "outpass": None},
            day=date(2026, 11, 4),
        )
        self.assertEqual(
            text,
            "Dear Suresh Kumar,\n"
            "You currently have some pending requests awaiting your approval in the UK Textiles HRMS application.\n"
            "Pending requests:\n"
            "• Leave Requests: 3\n"
            "• Permission Requests: 1\n"
            "• Missing Punch Requests: 2\n"
            "Kindly review and approve the pending requests at the earliest.\n"
            "Regards,\n"
            "HR Team – UKT",
        )

    def test_placeholders_total_date_and_labels(self):
        text = rem.render(
            "Hi {{ name }}: {{total}} on {{date}}\n{{pendingList}}",
            name="Ravi",
            by_category={"resignation": 1, "holiday_work": 2, "leave": 1},
            day=date(2026, 1, 9),
        )
        self.assertEqual(
            text,
            "Hi Ravi: 4 on 09 Jan 2026\n• Leave Requests: 1\n• Compensation Requests: 2\n• Resignation Requests: 1",
        )
        self.assertEqual(rem.line_label("Leave"), "Leave Requests")
        self.assertEqual(rem.line_label("Leave Requests"), "Leave Requests")

    def test_template_rules(self):
        self.assertIsNone(rem.template_problem(rem.DEFAULT_TEMPLATE))
        self.assertIn("too short", rem.template_problem("{{name}}"))
        self.assertIn("too long", rem.template_problem("{{pendingList}}" + "x" * 2000))
        self.assertIn("{{pendingList}}", rem.template_problem("Dear {{name}}, please approve."))
        self.assertIn("{{nme}}", rem.template_problem("Dear {{nme}},\n{{pendingList}}"))
        self.assertEqual(rem.template_problem(None), "The message must be text.")


MON = date(2026, 11, 2)  # a Monday
SUN = date(2026, 11, 8)


def at(day, h, m=0):
    return datetime.combine(day, time(h, m))


class DueTests(SimpleTestCase):
    WEEK = [0, 1, 2, 3, 4, 5]

    def due(self, now, done=(), enabled=True, times=("10:00", "16:00"), days=None):
        return rem.due_slots(
            now, enabled=enabled, times=list(times), days=self.WEEK if days is None else days, done=set(done)
        )

    def test_the_ten_minute_window(self):
        self.assertEqual(self.due(at(MON, 9, 59)), [])
        self.assertEqual(self.due(at(MON, 10, 0)), [(MON, "10:00")])
        self.assertEqual(self.due(at(MON, 10, 9)), [(MON, "10:00")])
        self.assertEqual(self.due(at(MON, 10, 9).replace(second=59)), [(MON, "10:00")])
        self.assertEqual(self.due(at(MON, 10, 10)), [])
        self.assertEqual(self.due(at(MON, 16, 3)), [(MON, "16:00")])

    def test_only_on_the_chosen_weekdays(self):
        self.assertEqual(self.due(at(SUN, 10, 1)), [])
        self.assertEqual(self.due(at(SUN, 10, 1), days=[6]), [(SUN, "10:00")])

    def test_never_twice_and_never_while_disabled(self):
        self.assertEqual(self.due(at(MON, 10, 5), done=[(MON, "10:00")]), [])
        self.assertEqual(self.due(at(MON, 10, 5), done=[(MON - timedelta(days=7), "10:00")]), [(MON, "10:00")])
        self.assertEqual(self.due(at(MON, 10, 5), enabled=False), [])

    def test_a_slot_just_before_midnight_belongs_to_its_own_day(self):
        tue = MON + timedelta(days=1)
        self.assertEqual(self.due(at(tue, 0, 2), times=["23:55"]), [(MON, "23:55")])
        self.assertEqual(self.due(at(MON, 0, 2), times=["23:55"]), [])  # Sunday's slot: Sunday is not chosen

    def test_next_run(self):
        kw = dict(enabled=True, times=["10:00", "16:00"], days=self.WEEK)
        self.assertEqual(rem.next_run_at(at(MON, 9, 0), done=set(), **kw), at(MON, 10))
        self.assertEqual(rem.next_run_at(at(MON, 10, 5), done=set(), **kw), at(MON, 10))  # due now
        self.assertEqual(rem.next_run_at(at(MON, 10, 5), done={(MON, "10:00")}, **kw), at(MON, 16))
        self.assertEqual(
            rem.next_run_at(at(SUN - timedelta(days=1), 17, 0), done=set(), **kw), at(MON + timedelta(days=7), 10)
        )
        self.assertIsNone(rem.next_run_at(at(MON, 9, 0), done=set(), enabled=False, times=["10:00"], days=self.WEEK))

    def test_parsing(self):
        self.assertEqual(rem.parse_times(["16:00", "9:05"]), (["09:05", "16:00"], None))
        for bad in (["24:00"], ["10:60"], ["ten"], [], ["10:00"] * 2, [f"{h:02d}:00" for h in range(7)], "10:00"):
            self.assertIsNone(rem.parse_times(bad)[0], bad)
        self.assertEqual(rem.parse_days([5, 0]), ([0, 5], None))
        for bad in ([7], [-1], [0, 0], [], [True], "0"):
            self.assertIsNone(rem.parse_days(bad)[0], bad)
        base = {"whatsapp": True, "email": True, "push": True}
        self.assertEqual(
            rem.parse_channels({"email": False}, base)[0], {"whatsapp": True, "email": False, "push": True}
        )
        self.assertIsNone(rem.parse_channels({"whatsapp": False, "email": False, "push": False}, base)[0])
        self.assertIsNone(rem.parse_channels({"sms": True}, base)[0])
        self.assertIsNone(rem.parse_channels({"push": "yes"}, base)[0])


# ─────────────────────────── settings ───────────────────────────


class SettingsTests(_World):
    URL = "/api/hr/hod-reminders/settings"

    def test_defaults(self):
        body = self.get(self.URL).json()
        self.assertEqual(body["enabled"], False)
        self.assertEqual(body["times"], ["10:00", "16:00"])
        self.assertEqual(body["days"], [0, 1, 2, 3, 4, 5])
        self.assertEqual(body["channels"], {"whatsapp": True, "email": True, "push": True})
        self.assertEqual(body["template"], rem.DEFAULT_TEMPLATE)
        self.assertEqual(body["defaultTemplate"], rem.DEFAULT_TEMPLATE)
        self.assertEqual((body["onlyWithPending"], body["companyWide"], body["canEdit"]), (True, True, True))
        self.assertIsNone(body["nextRunAt"])
        self.assertIsNone(body["lastRun"])
        self.assertEqual(set(body["channelStatus"]), {"whatsapp", "email", "push"})
        # under the test runner nothing can be sent
        self.assertFalse(body["channelStatus"]["whatsapp"]["available"])
        self.assertIn("not set up", body["channelStatus"]["whatsapp"]["note"])
        self.assertFalse(body["channelStatus"]["email"]["available"])
        self.assertTrue(body["channelStatus"]["push"]["available"])

    def test_save_validate_and_audit(self):
        res = self.put(
            self.URL,
            {
                "enabled": True,
                "times": ["16:30", "9:00"],
                "days": [0, 2],
                "channels": {"email": False},
                "template": "Hi {{name}},\n{{pendingList}}\nThanks",
            },
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["enabled"], body["times"], body["days"]), (True, ["09:00", "16:30"], [0, 2]))
        self.assertEqual(body["channels"], {"whatsapp": True, "email": False, "push": True})
        self.assertEqual(body["template"], "Hi {{name}},\n{{pendingList}}\nThanks")
        self.assertIsNotNone(body["nextRunAt"])
        self.assertEqual(body["updatedBy"], "Admin Asha")
        log = AuditLog.objects.get(module="hod_reminders")
        self.assertEqual(log.action, "update")
        self.assertEqual(set(log.new_values), {"enabled", "times", "days", "channels", "template"})
        for bad, words in (
            ({"times": ["25:00"]}, "HH:MM"),
            ({"times": [f"{h:02d}:00" for h in range(7)]}, "at most 6"),
            ({"times": ["10:00", "10:00"]}, "twice"),
            ({"days": [7]}, "weekday"),
            ({"template": "short"}, "too short"),
            ({"template": "Dear {{name}}, approve please"}, "{{pendingList}}"),
            ({"channels": {"whatsapp": False, "push": False}}, "at least one channel"),
            ({"enabled": "yes"}, "true or false"),
        ):
            res = self.put(self.URL, bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn(words, res.json()["error"])
        # the default wording stored back means "follow the default"; null resets it
        self.put(self.URL, {"template": rem.DEFAULT_TEMPLATE})
        self.assertEqual(HodReminderSettings.get().template, "")
        self.put(self.URL, {"template": "Hi {{name}},\n{{pendingList}}"})
        self.put(self.URL, {"template": None})
        self.assertEqual(HodReminderSettings.get().template, "")

    def test_company_wide_and_view_only(self):
        branch_editor = self.role_user("beditor", {"requests": "edit"}, branch=self.north)
        res = self.put(self.URL, {"enabled": True}, _hr(branch_editor))
        self.assertEqual((res.status_code, res.json()["code"]), (403, "company_wide_rule"))
        self.assertFalse(self.get(self.URL, _hr(branch_editor)).json()["canEdit"])
        viewer = self.role_user("viewer", {"requests": "view"})
        self.assertEqual(self.get(self.URL, _hr(viewer)).status_code, 200)
        self.assertFalse(self.get(self.URL, _hr(viewer)).json()["canEdit"])
        self.assertEqual(self.put(self.URL, {"enabled": True}, _hr(viewer)).status_code, 403)
        md = HRUser.objects.create(username="hodrem_md", password_hash="x", is_md=True)
        self.assertFalse(self.get(self.URL, _hr(md)).json()["canEdit"])
        self.assertEqual(self.put(self.URL, {"enabled": True}, _hr(md)).status_code, 403)
        self.assertFalse(HodReminderSettings.get().enabled)


# ─────────────────────────── preview ───────────────────────────


class PreviewTests(_World):
    URL = "/api/hr/hod-reminders/preview"

    def test_messages_for_heads_with_pending_only_and_nothing_sent(self):
        self.standard_requests()
        res = self.post(self.URL)
        self.assertEqual(res.status_code, 200, res.content)
        messages = res.json()["messages"]
        self.assertEqual([m["name"] for m in messages], ["Suresh Test", "Ravi Test"])
        self.assertEqual(messages[0]["pending"], 4)
        self.assertIn("• Leave Requests: 1\n• Permission Requests: 1\n• Casual Leave Requests: 1", messages[0]["text"])
        self.assertTrue(messages[0]["text"].startswith("Dear Suresh Test,"))
        custom = self.post(self.URL, {"template": "Hello {{name}} ({{total}})\n{{pendingList}}"}).json()["messages"]
        self.assertEqual(custom[1]["text"], "Hello Ravi Test (1)\n• Leave Requests: 1")
        self.assertEqual(self.post(self.URL, {"template": "no list here at all"}).status_code, 400)
        self.assertFalse(Notification.objects.exists())
        self.assertFalse(WhatsAppMessageLog.objects.exists())
        self.assertFalse(HodReminderRun.objects.exists())

    def test_a_view_only_login_may_preview_and_a_branch_login_sees_its_branch(self):
        self.standard_requests()
        viewer = self.role_user("pviewer", {"requests": "view"}, branch=self.south)
        res = self.post(self.URL, auth=_hr(viewer))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([m["name"] for m in res.json()["messages"]], ["Ravi Test"])


# ─────────────────────────── sending ───────────────────────────


@override_settings(**SENDING)
class SendTests(_World):
    URL = "/api/hr/hod-reminders/send"

    def setUp(self):
        super().setUp()
        smtp = mock.patch(SMTP)
        self.smtp = smtp.start()
        self.addCleanup(smtp.stop)
        launch = mock.patch(LAUNCH)
        self.launch = launch.start()
        self.addCleanup(launch.stop)
        ps = PayrollSettings.get()
        ps.smtp_host, ps.smtp_port, ps.smtp_username, ps.smtp_password = "smtp.example.test", 587, "hr@x.test", "pw"
        ps.save()
        self.standard_requests()

    def send(self, body=None, auth=None):
        res = self.post(self.URL, body, auth)
        self.assertEqual(res.status_code, 202, res.content)
        return res.json()["run"]

    def detail(self, run_id, auth=None):
        res = self.get(f"/api/hr/hod-reminders/runs/{run_id}", auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def deliveries(self, run_id):
        return {d["name"]: d for d in self.detail(run_id)["deliveries"]}

    def test_nothing_is_sent_inside_the_request(self):
        run = self.send()
        self.assertEqual(
            (run["status"], run["trigger"], run["hods"], run["sentBy"]), ("running", "manual", 2, "Admin Asha")
        )
        self.launch.assert_called_once_with(run["id"])
        self.wa.assert_not_called()
        self.smtp.assert_not_called()
        self.expo.assert_not_called()
        self.assertFalse(Notification.objects.exists())
        rows = self.deliveries(run["id"])
        self.assertEqual(set(rows), {"Suresh Test", "Ravi Test"})
        self.assertEqual(rows["Suresh Test"]["whatsapp"], {"status": "pending", "note": None})
        self.assertEqual(AuditLog.objects.filter(module="hod_reminders", action="create").count(), 1)

    def test_one_round_every_channel_and_exactly_one_push_per_head(self):
        run = self.send()
        self.assertEqual(rem.process_run(run["id"]), "done")
        rows = self.deliveries(run["id"])
        suresh = rows["Suresh Test"]
        self.assertEqual(
            (suresh["whatsapp"]["status"], suresh["email"]["status"], suresh["push"]["status"]),
            ("sent", "sent", "sent"),
        )
        self.assertEqual(suresh["pending"], 4)
        self.assertEqual(suresh["byCategory"]["casual_leave"], 1)
        # WhatsApp: the new catalogue type, keyed to the round, the Notify text
        log = WhatsAppMessageLog.objects.get(employee=self.suresh)
        self.assertEqual(log.document_type, "hod_pending_reminder")
        self.assertEqual(log.dedupe_key, f"hodrem:{run['id']}:{self.m.id}")
        self.assertEqual(log.message_text, suresh["text"])
        self.assertEqual(self.wa.call_args.kwargs["json"]["number"], "919876500001")
        # email: the new email type, with the subject and the text's line breaks kept in the HTML
        email = EmailMessageLog.objects.get(employee=self.suresh)
        self.assertEqual((email.email_type, email.status), ("hod_pending_reminder", "sent"))
        self.assertEqual(email.subject, "Pending approvals awaiting you – UK Textiles HRMS")
        server = self.smtp.return_value.__enter__.return_value
        html = server.send_message.call_args.args[0].get_body(("html",)).get_content()
        self.assertIn("Dear Suresh Test,<br>You currently have", html)
        # push: ONE notification (the WhatsApp message made none), pushed once, opening Approvals
        notes = Notification.objects.filter(employee=self.suresh)
        self.assertEqual(notes.count(), 1)
        note = notes.get()
        self.assertEqual(
            (note.type, note.source, note.title), ("hod_pending_reminder", "hod_pending_reminder", "Pending approvals")
        )
        self.assertEqual(note.message, suresh["text"])
        self.assertEqual(self.expo.call_count, 1)
        self.assertEqual(target_for(note)["kind"], "approvals")
        self.assertEqual(target_for(note)["role"], "approver")
        # Ravi has no phone, no email and no registered phone: skipped with plain reasons
        ravi = rows["Ravi Test"]
        self.assertEqual(ravi["whatsapp"], {"status": "skipped", "note": "No phone number"})
        self.assertEqual(ravi["email"], {"status": "skipped", "note": "No email address"})
        self.assertEqual(ravi["push"]["status"], "skipped")
        self.assertIn("No phone registered for notifications", ravi["push"]["note"])
        self.assertEqual(Notification.objects.filter(employee=self.ravi).count(), 1)  # still in the app's list
        body = self.detail(run["id"])
        self.assertEqual(body["status"], "done")
        self.assertEqual(
            body["counts"],
            {
                "whatsapp": {"sent": 1, "failed": 0, "skipped": 1},
                "email": {"sent": 1, "failed": 0, "skipped": 1},
                "push": {"sent": 1, "failed": 0, "skipped": 1},
            },
        )
        # processing it again sends nothing more
        self.assertIsNone(rem.process_run(run["id"]))
        self.assertEqual(WhatsAppMessageLog.objects.count(), 1)
        self.assertEqual(Notification.objects.count(), 2)

    def test_push_alone_while_whatsapp_is_off(self):
        WhatsAppSettings.objects.update_or_create(pk=1, defaults={"approval_notifications_enabled": False})
        run = self.send({"channels": {"whatsapp": True, "email": False, "push": True}})
        rem.process_run(run["id"])
        suresh = self.deliveries(run["id"])["Suresh Test"]
        self.assertEqual(suresh["whatsapp"]["status"], "skipped")
        self.assertIn("switched off on the WhatsApp Control page", suresh["whatsapp"]["note"])
        self.assertEqual(suresh["email"], {"status": "off", "note": None})
        self.assertEqual(suresh["push"]["status"], "sent")
        self.wa.assert_not_called()
        self.assertEqual(Notification.objects.filter(employee=self.suresh).count(), 1)

    def test_whatsapp_without_push_makes_no_notification(self):
        run = self.send({"channels": {"whatsapp": True, "email": False, "push": False}})
        rem.process_run(run["id"])
        self.assertEqual(self.deliveries(run["id"])["Suresh Test"]["whatsapp"]["status"], "sent")
        self.assertFalse(Notification.objects.exists())
        self.expo.assert_not_called()

    def test_channel_switches_and_set_up_are_respected(self):
        settings_row = MobileMessageSettings.get()
        settings_row.disabled_types = ["hod_pending_reminder"]
        settings_row.save()
        ps = PayrollSettings.get()
        ps.smtp_password = ""
        ps.save()
        with override_settings(WACLIENT_INSTANCE_ID="", WACLIENT_ACCESS_TOKEN=""):
            run = self.send()
            rem.process_run(run["id"])
        suresh = self.deliveries(run["id"])["Suresh Test"]
        self.assertEqual(suresh["whatsapp"], {"status": "skipped", "note": "WhatsApp not set up"})
        self.assertEqual(suresh["email"], {"status": "skipped", "note": "Email (SMTP) not set up"})
        self.assertEqual(suresh["push"]["status"], "skipped")
        self.assertIn("switched off", suresh["push"]["note"])
        self.expo.assert_not_called()

    def test_refusals(self):
        busy = self.send()
        res = self.post(self.URL)
        self.assertEqual((res.status_code, res.json()["code"]), (409, "run_in_progress"))
        rem.process_run(busy["id"])
        self.assertEqual(self.post(self.URL, {"managerIds": [999999]}).status_code, 400)
        self.assertEqual(self.post(self.URL, {"managerIds": "all"}).status_code, 400)
        res = self.post(self.URL, {"managerIds": [self.m_cut.id]})  # Kavin has nothing pending
        self.assertEqual((res.status_code, res.json()["code"]), (400, "nothing_pending"))
        self.assertEqual(
            self.post(self.URL, {"channels": {"whatsapp": False, "email": False, "push": False}}).status_code, 400
        )
        branch_editor = self.role_user("seditor", {"requests": "edit"}, branch=self.north)
        res = self.post(self.URL, auth=_hr(branch_editor))
        self.assertEqual((res.status_code, res.json()["code"]), (403, "company_wide_rule"))
        viewer = self.role_user("sviewer", {"requests": "view"})
        self.assertEqual(self.post(self.URL, auth=_hr(viewer)).status_code, 403)
        self.assertEqual(HodReminderRun.objects.count(), 1)

    def test_limited_to_chosen_heads(self):
        run = self.send({"managerIds": [self.m_south.id]})
        self.assertEqual(run["hods"], 1)
        self.assertEqual(set(self.deliveries(run["id"])), {"Ravi Test"})

    def test_a_round_whose_processor_stopped_is_taken_over_without_sending_twice(self):
        run = self.send()
        d = HodReminderDelivery.objects.get(run_id=run["id"], manager=self.m)
        # the first processor sent the push, was sending the email, then the server stopped
        d.push_status, d.email_status = "sent", "sending"
        d.save()
        HodReminderRun.objects.filter(pk=run["id"]).update(
            claim_token="dead", heartbeat_at=timezone.now() - timedelta(minutes=5)
        )
        self.assertEqual(rem.resume_stale(), [run["id"]])
        suresh = self.deliveries(run["id"])["Suresh Test"]
        self.assertEqual(suresh["push"]["status"], "sent")
        self.assertEqual(suresh["email"]["status"], "failed")
        self.assertIn("not tried again", suresh["email"]["note"])
        self.assertEqual(suresh["whatsapp"]["status"], "sent")
        self.smtp.assert_not_called()
        self.assertFalse(Notification.objects.filter(employee=self.suresh).exists())  # the push was not made again

    def test_an_alive_processor_is_left_alone_and_an_old_round_is_given_up(self):
        run = self.send()
        HodReminderRun.objects.filter(pk=run["id"]).update(claim_token="alive", heartbeat_at=timezone.now())
        self.assertEqual(rem.resume_stale(), [])
        self.assertIsNone(rem.process_run(run["id"]))
        HodReminderRun.objects.filter(pk=run["id"]).update(
            heartbeat_at=timezone.now() - timedelta(minutes=10), started_at=timezone.now() - timedelta(hours=1)
        )
        rem.resume_stale()
        body = self.detail(run["id"])
        self.assertEqual(body["status"], "failed")
        self.assertEqual({d["whatsapp"]["status"] for d in body["deliveries"]}, {"failed"})
        self.wa.assert_not_called()

    def test_runs_list(self):
        first = self.send({"channels": {"whatsapp": False, "email": False, "push": True}})
        rem.process_run(first["id"])
        second = self.send({"managerIds": [self.m.id]})
        res = self.get("/api/hr/hod-reminders/runs", page=1, pageSize=1)
        body = res.json()
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (2, 1, 1))
        self.assertEqual(body["items"][0]["id"], second["id"])
        self.assertNotIn("deliveries", body["items"][0])
        older = self.get("/api/hr/hod-reminders/runs", page=2, pageSize=1).json()["items"][0]
        self.assertEqual(older["counts"]["push"], {"sent": 1, "failed": 0, "skipped": 1})
        self.assertEqual(older["channels"], {"whatsapp": False, "email": False, "push": True})
        self.assertEqual(self.get("/api/hr/hod-reminders/runs/999999").status_code, 404)
        # a branch login sees only its own branch's heads in a round
        viewer = self.role_user("rviewer", {"requests": "view"}, branch=self.south)
        scoped = self.detail(first["id"], _hr(viewer))
        self.assertEqual([d["name"] for d in scoped["deliveries"]], ["Ravi Test"])
        self.assertEqual(scoped["hods"], 1)
        settings_body = self.get("/api/hr/hod-reminders/settings").json()
        self.assertEqual(settings_body["lastRun"]["id"], second["id"])


# ─────────────────────────── the schedule ───────────────────────────


@override_settings(**SENDING)
class ScheduleTests(_World):
    def setUp(self):
        super().setUp()
        self.standard_requests()
        s = HodReminderSettings.get()
        s.enabled, s.times, s.days = True, ["10:00"], [0, 1, 2, 3, 4, 5]
        s.channel_email = False
        s.save()

    def test_a_due_slot_runs_once(self):
        started = rem.run_scheduled(at(MON, 10, 3))
        self.assertEqual(len(started), 1)
        run = HodReminderRun.objects.get(pk=started[0])
        self.assertEqual((run.trigger, run.slot, run.run_date, run.status), ("schedule", "10:00", MON, "done"))
        self.assertEqual(run.hods, 2)
        self.assertEqual(WhatsAppMessageLog.objects.count(), 1)  # Suresh (Ravi has no phone)
        self.assertIn("Dear Suresh Test", WhatsAppMessageLog.objects.get().message_text)
        self.assertEqual(rem.run_scheduled(at(MON, 10, 4)), [])
        self.assertEqual(rem.run_scheduled(at(MON, 10, 12)), [])
        self.assertEqual(HodReminderRun.objects.count(), 1)
        self.assertEqual(WhatsAppMessageLog.objects.count(), 1)

    def test_disabled_or_not_today_runs_nothing(self):
        HodReminderSettings.objects.filter(pk=1).update(enabled=False)
        self.assertEqual(rem.run_scheduled(at(MON, 10, 1)), [])
        HodReminderSettings.objects.filter(pk=1).update(enabled=True)
        self.assertEqual(rem.run_scheduled(at(SUN, 10, 1)), [])
        self.assertFalse(HodReminderRun.objects.exists())

    def test_the_database_allows_one_round_per_date_and_slot(self):
        HodReminderRun.objects.create(trigger="schedule", slot="10:00", run_date=MON)
        with self.assertRaises(IntegrityError), transaction.atomic():
            HodReminderRun.objects.create(trigger="schedule", slot="10:00", run_date=MON)
        # another worker already started it: this one starts nothing (seen as done, or refused by the database)
        self.assertEqual(rem.run_scheduled(at(MON, 10, 2)), [])
        with mock.patch("api.hod_reminders.scheduled_done", return_value=set()):
            self.assertEqual(rem.run_scheduled(at(MON, 10, 2)), [])
        self.assertEqual(HodReminderRun.objects.filter(trigger="schedule").count(), 1)
        # manual rounds are not limited
        HodReminderRun.objects.create(trigger="manual", run_date=MON)
        HodReminderRun.objects.create(trigger="manual", run_date=MON)

    def test_the_job_is_registered_at_startup(self):
        import inspect

        from .apps import ApiConfig

        source = inspect.getsource(ApiConfig._start_scheduler)
        self.assertIn("hod_reminder_scheduler.start_scheduler_if_needed()", source)
