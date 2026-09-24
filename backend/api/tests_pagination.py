"""
Default pagination on list endpoints (view_common.paginate).

Run via: python manage.py test api.tests_pagination -v 2
"""

from django.test import TestCase
from rest_framework.test import APIRequestFactory

from . import view_common
from .jwt_utils import sign_token
from .models import Employee, HRUser, Notification
from .view_common import paginate


def _request(query=""):
    from rest_framework.request import Request

    return Request(APIRequestFactory().get(f"/x{query}"))


class PaginateHelperTests(TestCase):
    def setUp(self):
        for i in range(12):
            Employee.objects.create(employee_code=f"PG{i:02d}", first_name="P", last_name=str(i))
        self.qs = Employee.objects.order_by("id")
        self.ser = lambda e: e.employee_code

    def test_without_page_the_shape_is_the_legacy_bare_array(self):
        r = paginate(_request(), self.qs, self.ser)
        self.assertEqual(len(r.data), 12)
        self.assertIsInstance(r.data, list)
        self.assertNotIn("X-Truncated", r)

    def test_without_page_the_array_is_capped_and_flagged(self):
        r = paginate(_request(), self.qs, self.ser, cap=5)
        self.assertEqual(r.data, ["PG00", "PG01", "PG02", "PG03", "PG04"])
        self.assertEqual(r["X-Truncated"], "true")

    def test_exactly_at_the_cap_is_not_flagged(self):
        r = paginate(_request(), self.qs, self.ser, cap=12)
        self.assertEqual(len(r.data), 12)
        self.assertNotIn("X-Truncated", r)

    def test_page_returns_an_envelope_with_the_total(self):
        r = paginate(_request("?page=2&pageSize=5"), self.qs, self.ser)
        self.assertEqual(
            r.data,
            {
                "items": ["PG05", "PG06", "PG07", "PG08", "PG09"],
                "total": 12,
                "page": 2,
                "pageSize": 5,
            },
        )

    def test_last_page_is_short_and_pages_past_the_end_are_empty(self):
        self.assertEqual(paginate(_request("?page=3&pageSize=5"), self.qs, self.ser).data["items"], ["PG10", "PG11"])
        self.assertEqual(paginate(_request("?page=9&pageSize=5"), self.qs, self.ser).data["items"], [])

    def test_pages_partition_the_rows_without_overlap(self):
        seen = []
        for page in (1, 2, 3, 4):
            seen += paginate(_request(f"?page={page}&pageSize=4"), self.qs, self.ser).data["items"]
        self.assertEqual(seen, [f"PG{i:02d}" for i in range(12)])

    def test_page_size_defaults_and_is_clamped(self):
        self.assertEqual(
            paginate(_request("?page=1"), self.qs, self.ser).data["pageSize"], view_common.DEFAULT_PAGE_SIZE
        )
        self.assertEqual(
            paginate(_request("?page=1&pageSize=99999"), self.qs, self.ser).data["pageSize"], view_common.MAX_PAGE_SIZE
        )
        self.assertEqual(paginate(_request("?page=1&pageSize=0"), self.qs, self.ser).data["pageSize"], 1)
        self.assertEqual(paginate(_request("?page=-4&pageSize=5"), self.qs, self.ser).data["page"], 1)

    def test_non_numeric_paging_is_a_400_not_a_500(self):
        self.assertEqual(paginate(_request("?page=abc"), self.qs, self.ser).status_code, 400)
        self.assertEqual(paginate(_request("?page=1&pageSize=x"), self.qs, self.ser).status_code, 400)

    def test_plain_lists_paginate_too(self):
        rows = list(range(7))
        r = paginate(_request("?page=2&pageSize=3"), rows, str)
        self.assertEqual((r.data["items"], r.data["total"]), (["3", "4", "5"], 7))

    def test_a_page_costs_one_count_and_one_select(self):
        with self.assertNumQueries(2):
            paginate(_request("?page=1&pageSize=5"), self.qs, self.ser)

    def test_the_legacy_path_stays_a_single_query(self):
        with self.assertNumQueries(1):
            paginate(_request(), self.qs, self.ser)


class ListEndpointTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.emp = Employee.objects.create(employee_code="PGE", first_name="Pg", last_name="E")
        for i in range(7):
            Notification.objects.create(employee=cls.emp, type="general", message=f"m{i}")
        admin = HRUser.objects.create(username="pg_admin", password_hash="x", is_super_admin=True)
        cls.hr = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': admin.id})}"}
        cls.emp_auth = {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': cls.emp.id})}"}

    def test_existing_clients_still_get_a_bare_array(self):
        for url, headers in (
            ("/api/notifications", self.emp_auth),
            ("/api/leave-requests", self.hr),
            ("/api/attendance", self.hr),
            ("/api/payroll", self.hr),
        ):
            r = self.client.get(url, **headers)
            self.assertEqual(r.status_code, 200, url)
            self.assertIsInstance(r.json(), list, url)

    def test_notifications_are_newest_first_and_page(self):
        r = self.client.get("/api/notifications?page=1&pageSize=3", **self.emp_auth)
        body = r.json()
        self.assertEqual((body["total"], body["page"], body["pageSize"]), (7, 1, 3))
        self.assertEqual([n["message"] for n in body["items"]], ["m6", "m5", "m4"])

    def test_notifications_pages_stay_scoped_to_the_employee(self):
        other = Employee.objects.create(employee_code="PGO", first_name="O", last_name="O")
        Notification.objects.create(employee=other, type="general", message="not yours")
        body = self.client.get("/api/notifications?page=1&pageSize=50", **self.emp_auth).json()
        self.assertEqual(body["total"], 7)
        self.assertNotIn("not yours", [n["message"] for n in body["items"]])

    def test_payroll_list_pages(self):
        r = self.client.get("/api/payroll?page=1&pageSize=10", **self.hr)
        self.assertEqual(r.json(), {"items": [], "total": 0, "page": 1, "pageSize": 10})

    def test_bad_paging_on_a_real_endpoint_is_a_400(self):
        self.assertEqual(self.client.get("/api/notifications?page=x", **self.emp_auth).status_code, 400)

    def test_a_capped_list_flags_truncation(self):
        r = paginate(_request(), Notification.objects.order_by("id"), lambda n: n.message, cap=3)
        self.assertEqual(len(r.data), 3)
        self.assertEqual(r["X-Truncated"], "true")
