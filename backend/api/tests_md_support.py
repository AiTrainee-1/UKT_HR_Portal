"""Shared helpers for the MD portal's tests: an MD account, its token, and a base class with `self.get(path, **params)`.

class AttendanceTests(MdApiTestCase):
    def test_x(self):
        r = self.get("/api/md/attendance/summary", period="last_7_days")
"""

from django.test import TestCase

from .jwt_utils import sign_token
from .models import HRUser


def make_md(username: str = "md_test") -> HRUser:
    """The Managing Director account: company-wide (no branch), no role, flagged is_md."""
    user, _ = HRUser.objects.get_or_create(
        username=username, defaults={"password_hash": "x", "full_name": "Test MD", "is_md": True}
    )
    if not user.is_md:
        user.is_md = True
        user.save(update_fields=["is_md"])
    return user


def md_headers(user: HRUser) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id})}"}


class MdApiTestCase(TestCase):
    """setUp makes the MD; `self.get` calls an /api/md/ endpoint as the MD."""

    def setUp(self):
        super().setUp()
        self.md = make_md()

    def get(self, path: str, **params):
        return self.client.get(path, params, **md_headers(self.md))
