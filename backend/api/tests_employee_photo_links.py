"""
Employee photo links (api/employee_photo.py): list and summary responses send a signed, token-free link to an embedded
photo instead of the base64 picture itself, and GET /api/employees/<id>/photo serves such a link with no token.

One list (GET /api/hr-requests) measured 86 MB on a real database because one employee's 2 MB photo was repeated in every
request they had made. The single-employee record keeps the data URL (Edit Employee sends it back on save).

Run via: python manage.py test api.tests_employee_photo_links -v 2
"""

import base64
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from django.test import TestCase, override_settings
from django.utils import timezone

from . import approval_workflow as approval
from .employee_photo import (
    LINK_CACHE_CONTROL,
    is_own_photo_link,
    photo_digest,
    photo_link,
    photo_signature,
    photo_stand_ins,
)
from .jwt_utils import sign_token
from .models import (
    Branch,
    Employee,
    GateDevice,
    HRUser,
    LeaveRequest,
    OutpassGateScan,
    OutpassRequest,
    Role,
    TeaBreakLog,
    Visitor,
    VisitorVisit,
)

RAW = b"\xff\xd8\xff\xe0" + b"photo-bytes" * 300
PHOTO = "data:image/jpeg;base64," + base64.b64encode(RAW).decode()
BIG = "data:image/jpeg;base64," + "A" * 60_000  # what makes a list heavy when it is repeated per row
EXTERNAL = "https://example.com/p2.png"


def signed(emp_id, value, origin="http://testserver"):
    digest = photo_digest(value)
    return f"{origin}/api/employees/{emp_id}/photo?v={digest}&s={photo_signature(emp_id, digest)}"


def bearer(payload):
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class Fixture(TestCase):
    def setUp(self):
        approval.clear_cache()
        self.admin = HRUser.objects.create(username="photo_admin", password_hash="x", is_super_admin=True)
        self.hr = bearer({"role": "hr", "hrUserId": self.admin.id})
        self.ho = Branch.objects.create(name="PL Head Office", code="PLHO", is_head_office=True)
        self.u2 = Branch.objects.create(name="PL Unit 2", code="PLU2")
        self.asha = self.person("PL1", photo_url=PHOTO)
        self.ravi = self.person("PL2", photo_url=EXTERNAL)
        self.mani = self.person("PL3")

    def person(self, code, **fields):
        fields.setdefault("branch", self.ho)
        return Employee.objects.create(
            employee_code=code, first_name=code, last_name="Photo", status="active", employment_type="staff", **fields
        )

    def get(self, url, **headers):
        response = self.client.get(url, **(headers or self.hr))
        self.assertEqual(response.status_code, 200, response.content[:300])
        self.assertNotIn(b"data:image", response.content)
        return response.json()

    def fetch(self, link, **headers):
        """GET a photo link exactly as an <img> would (no token unless headers are given)."""
        parts = urlsplit(link)
        return self.client.get(f"{parts.path}?{parts.query}" if parts.query else parts.path, **headers)


class TheLinkItself(Fixture):
    def test_nothing_and_an_external_link_come_back_as_they_are(self):
        self.assertIsNone(photo_link(1, None))
        self.assertEqual(photo_link(1, ""), "")
        self.assertEqual(photo_link(1, EXTERNAL), EXTERNAL)

    def test_outside_a_request_the_link_is_relative_or_on_the_configured_address(self):
        with override_settings(BACKEND_PUBLIC_URL=""):
            self.assertEqual(photo_link(7, PHOTO), signed(7, PHOTO, origin=""))
        with override_settings(BACKEND_PUBLIC_URL="https://api.example.com/"):
            self.assertEqual(photo_link(7, PHOTO), signed(7, PHOTO, origin="https://api.example.com"))

    @override_settings(ALLOWED_HOSTS=["api.example.com", "testserver"])
    def test_behind_the_proxy_the_link_is_on_the_public_https_address(self):
        response = self.client.get(
            "/api/employees?status=active",
            HTTP_X_FORWARDED_PROTO="https",
            HTTP_X_FORWARDED_HOST="api.example.com",
            **self.hr,
        )
        rows = {e["id"]: e["photoUrl"] for e in response.json()}
        self.assertEqual(rows[self.asha.id], signed(self.asha.id, PHOTO, origin="https://api.example.com"))

    def test_the_database_computes_the_same_digest_as_python(self):
        for value in (PHOTO, BIG):
            emp = self.person(f"PLD{len(value)}", photo_url=value)
            row = Employee.objects.annotate(**photo_stand_ins()).defer("photo_url").get(pk=emp.pk)
            self.assertEqual(row.photo_digest, photo_digest(value))
            self.assertEqual(row.photo_ref, "data:")
        external = Employee.objects.annotate(**photo_stand_ins()).get(pk=self.ravi.pk)
        self.assertEqual((external.photo_ref, external.photo_digest), (EXTERNAL, None))

    def test_only_this_employees_own_photo_links_count_as_their_own(self):
        own = signed(self.asha.id, PHOTO)
        self.assertTrue(is_own_photo_link(self.asha.id, own))
        self.assertTrue(is_own_photo_link(self.asha.id, f"/api/employees/{self.asha.id}/photo"))
        self.assertFalse(is_own_photo_link(self.ravi.id, own))
        for value in (None, "", PHOTO, EXTERNAL, f"https://x.test/api/employees/{self.asha.id}/photos"):
            self.assertFalse(is_own_photo_link(self.asha.id, value), value)


class ServingASignedLink(Fixture):
    def link_from_the_list(self, emp):
        rows = {e["id"]: e for e in self.get("/api/employees?status=active")}
        return rows[emp.id]["photoUrl"]

    def test_a_signed_link_is_served_without_a_token_and_cached_for_good(self):
        link = self.link_from_the_list(self.asha)
        self.assertEqual(link, signed(self.asha.id, PHOTO))
        response = self.fetch(link)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, RAW)
        self.assertEqual(response["Content-Type"], "image/jpeg")
        self.assertEqual(response["Cache-Control"], LINK_CACHE_CONTROL)

    def test_a_wrong_or_borrowed_signature_is_a_404(self):
        link = self.link_from_the_list(self.asha)
        query = parse_qs(urlsplit(link).query)
        v, s = query["v"][0], query["s"][0]
        base = f"/api/employees/{self.asha.id}/photo"
        flipped = s[:-1] + ("0" if s[-1] != "0" else "1")
        self.assertEqual(self.client.get(f"{base}?v={v}&s={flipped}").status_code, 404)
        self.assertEqual(self.client.get(f"{base}?v={v}&s=").status_code, 404)
        self.assertEqual(self.client.get(f"{base}?v={v}&s=%C3%A9%C3%A9").status_code, 404)  # not ASCII: still a 404
        other = self.person("PL9", photo_url=PHOTO)  # the same picture: the same digest, a different employee
        self.assertEqual(self.client.get(f"/api/employees/{other.id}/photo?v={v}&s={s}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/employees/999999/photo?v={v}&s={s}").status_code, 404)

    def test_after_the_photo_changes_the_old_link_is_a_404_and_the_list_has_a_new_one(self):
        old = self.link_from_the_list(self.asha)
        new_raw = b"\xff\xd8\xff\xe0" + b"another-photo" * 200
        new_photo = "data:image/jpeg;base64," + base64.b64encode(new_raw).decode()
        Employee.objects.filter(pk=self.asha.pk).update(photo_url=new_photo)
        self.assertEqual(self.fetch(old).status_code, 404)
        new = self.link_from_the_list(self.asha)
        self.assertNotEqual(new, old)
        response = self.fetch(new)
        self.assertEqual((response.status_code, response.content), (200, new_raw))

    def test_a_signed_link_to_a_photo_that_is_now_an_external_link_or_gone_is_a_404(self):
        link = self.link_from_the_list(self.asha)
        Employee.objects.filter(pk=self.asha.pk).update(photo_url=EXTERNAL)
        self.assertEqual(self.fetch(link).status_code, 404)
        Employee.objects.filter(pk=self.asha.pk).update(photo_url=None)
        self.assertEqual(self.fetch(link).status_code, 404)

    def test_only_one_of_the_two_parameters_means_the_token_check_as_before(self):
        digest = photo_digest(PHOTO)
        self.assertEqual(self.client.get(f"/api/employees/{self.asha.id}/photo?v={digest}").status_code, 401)
        ok = self.client.get(f"/api/employees/{self.asha.id}/photo?v=1", **self.hr)
        self.assertEqual(ok.status_code, 200)


class TheTokenPathKeepsItsRules(Fixture):
    def test_hr_and_the_employee_themselves_get_the_photo_others_do_not(self):
        url = f"/api/employees/{self.asha.id}/photo"
        response = self.client.get(url, **self.hr)
        self.assertEqual((response.status_code, response.content), (200, RAW))
        self.assertEqual(response["Cache-Control"], "private, max-age=3600")
        self.assertEqual(self.client.get(url).status_code, 401)
        own = bearer({"role": "employee", "employeeId": self.asha.id})
        self.assertEqual(self.client.get(url, **own).status_code, 200)
        someone_else = bearer({"role": "employee", "employeeId": self.ravi.id})
        self.assertEqual(self.client.get(url, **someone_else).status_code, 404)

    def test_hr_of_another_branch_does_not_get_it(self):
        role = Role.objects.create(name="pl-viewer", permissions={"employees": "view"})
        unit_hr = HRUser.objects.create(
            username="pl_unit_hr", password_hash="x", is_super_admin=False, role=role, branch=self.u2
        )
        headers = bearer({"role": "hr", "hrUserId": unit_hr.id})
        self.assertEqual(self.client.get(f"/api/employees/{self.asha.id}/photo", **headers).status_code, 404)
        there = self.person("PLU", branch=self.u2, photo_url=PHOTO)
        self.assertEqual(self.client.get(f"/api/employees/{there.id}/photo", **headers).status_code, 200)


class TheEmployeeRecord(Fixture):
    def test_the_detail_endpoint_still_returns_the_embedded_photo(self):
        response = self.client.get(f"/api/employees/{self.asha.id}", **self.hr)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["photoUrl"], PHOTO)

    def test_a_list_row_sent_back_on_save_leaves_the_photo_alone(self):
        url = f"/api/employees/{self.asha.id}"
        for link in (signed(self.asha.id, PHOTO), f"/api/employees/{self.asha.id}/photo"):
            response = self.client.patch(
                url, {"photoUrl": link, "firstName": "Asha"}, content_type="application/json", **self.hr
            )
            self.assertEqual(response.status_code, 200, response.content[:300])
            self.asha.refresh_from_db()
            self.assertEqual((self.asha.photo_url, self.asha.first_name), (PHOTO, "Asha"))
        # a real change is still a change
        self.client.patch(url, {"photoUrl": EXTERNAL}, content_type="application/json", **self.hr)
        self.asha.refresh_from_db()
        self.assertEqual(self.asha.photo_url, EXTERNAL)


class ListsSendLinks(Fixture):
    def test_every_shape_of_the_employees_list(self):
        expected = {
            self.asha.id: signed(self.asha.id, PHOTO),
            self.ravi.id: EXTERNAL,
            self.mani.id: None,
        }
        for url in ("/api/employees", "/api/employees?status=active", "/api/employees?lite=1"):
            rows = {e["id"]: e["photoUrl"] for e in self.get(url)}
            self.assertEqual({k: rows[k] for k in expected}, expected, url)
        paged = self.get("/api/employees?page=1&pageSize=50")
        self.assertEqual({e["id"]: e["photoUrl"] for e in paged["results"]}, expected)

    def test_hr_requests(self):
        heavy = self.person("PLH", photo_url=BIG)
        for day in (12, 13, 14):
            LeaveRequest.objects.create(
                employee=heavy, start_date=f"2026-10-{day}", end_date=f"2026-10-{day}", type="casual", reason="r"
            )
        OutpassRequest.objects.create(
            employee=self.asha, destination="Bank", reason="loan", source="manual", approval_trail=[]
        )
        response = self.client.get("/api/hr-requests?kind=all", **self.hr)
        self.assertLess(len(response.content), 40_000)  # the 60 KB photo is in none of the three rows
        body = self.get("/api/hr-requests?kind=all")
        photos = {i["employee"]["id"]: i["employee"]["photoUrl"] for i in body["items"]}
        self.assertEqual(photos, {heavy.id: signed(heavy.id, BIG), self.asha.id: signed(self.asha.id, PHOTO)})

    def test_outpass_requests(self):
        OutpassRequest.objects.create(
            employee=self.asha, destination="Bank", reason="loan", source="manual", approval_trail=[]
        )
        rows = self.get("/api/outpass-requests")
        self.assertEqual(rows[0]["employee"]["photoUrl"], signed(self.asha.id, PHOTO))
        paged = self.get("/api/outpass-requests?page=1&pageSize=10")
        self.assertEqual(paged["items"][0]["employee"]["photoUrl"], signed(self.asha.id, PHOTO))
        mine = self.get("/api/outpass-requests", **bearer({"role": "employee", "employeeId": self.asha.id}))
        self.assertEqual(len(mine), 1)
        self.assertNotIn("employee", mine[0])

    def test_tea_break_records_and_the_employees_own_status(self):
        gate = GateDevice.objects.create(
            name="PL Gate", branch=self.ho, username="pl_gate", password_hash="x", login_token="pltok"
        )
        now = timezone.now()
        TeaBreakLog.objects.create(employee=self.asha, out_gate=gate, out_at=now - timedelta(minutes=30), in_at=now)
        TeaBreakLog.objects.create(employee=self.asha, out_gate=gate, out_at=now - timedelta(minutes=5))
        body = self.get("/api/tea-break/records?range=month")
        self.assertEqual(body["total"], 2)
        self.assertEqual({i["employee"]["photoUrl"] for i in body["items"]}, {signed(self.asha.id, PHOTO)})
        mine = self.get("/api/tea-break/my-status", **bearer({"role": "employee", "employeeId": self.asha.id}))
        self.assertEqual({r["employee"]["photoUrl"] for r in mine["recent"]}, {signed(self.asha.id, PHOTO)})

    def test_the_device_control_people_list(self):
        body = self.get("/api/attendance/device-control/people")
        photos = {i["employee"]["id"]: i["employee"]["photoUrl"] for i in body["items"] if i["employee"]}
        self.assertEqual(photos[self.asha.id], signed(self.asha.id, PHOTO))
        self.assertEqual(photos[self.ravi.id], EXTERNAL)
        self.assertIsNone(photos[self.mani.id])
        self.assertEqual(self.fetch(photos[self.asha.id]).status_code, 200)

    def test_new_joinees_and_the_recruitment_dashboard(self):
        joined = (timezone.localdate() - timedelta(days=3)).isoformat()
        Employee.objects.filter(pk=self.asha.pk).update(join_date=joined)
        rows = self.get("/api/recruitment/new-joinees?days=30")
        self.assertEqual([r["photoUrl"] for r in rows if r["id"] == self.asha.id], [signed(self.asha.id, PHOTO)])
        dashboard = self.get("/api/recruitment/dashboard")
        recent = {r["id"]: r["photoUrl"] for r in dashboard["recentJoineeList"]}
        self.assertEqual(recent[self.asha.id], signed(self.asha.id, PHOTO))

    def test_visitor_records(self):
        visitor = Visitor.objects.create(name="Guest", phone="9000000099")
        VisitorVisit.objects.create(
            visitor=visitor, branch=self.ho, whom_to_meet="Asha", purpose="meeting", meeting_employee=self.asha
        )
        body = self.get("/api/visitor/records?range=month")
        self.assertEqual(body["items"][0]["meetingEmployee"]["photoUrl"], signed(self.asha.id, PHOTO))

    def test_the_gate_kiosks_scan_log(self):
        gate = GateDevice.objects.create(
            name="PL Gate", branch=self.ho, username="pl_gate2", password_hash="x", login_token="pltok2"
        )
        OutpassGateScan.objects.create(
            gate=gate, employee=self.asha, result=OutpassGateScan.RESULT_SUCCESS, message="ok", scan_type="exit"
        )
        kiosk = bearer({"role": "gate_device", "deviceId": gate.id, "gateName": gate.name})
        body = self.get("/api/gate-devices/scan-log", **kiosk)
        self.assertEqual(body["items"][0]["photoUrl"], signed(self.asha.id, PHOTO))
