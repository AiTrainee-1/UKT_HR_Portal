"""Shared fixtures for the Geo-Tracking tests: a small company, tokens, tracks made directly in the database and builders
for the JSON the phone sends. No test cases live here."""

import math
from datetime import datetime
from datetime import timezone as dt_timezone

from django.test import TestCase

from .jwt_utils import sign_token
from .models import (
    Branch,
    Department,
    DutyTrack,
    Employee,
    HRUser,
    OnDutySession,
    Role,
    TrackingConsent,
)

UTC = dt_timezone.utc
#: 10:00 IST on Wednesday 28 Oct 2026
T0 = datetime(2026, 10, 28, 4, 30, tzinfo=UTC)
LAT0, LNG0 = 11.0, 77.0
M_PER_DEG_LAT = 111_194.9  # the length of a degree of latitude for the haversine radius used by the project (6371 km)


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def offset_latlng(lat: float, lng: float, north_m: float = 0.0, east_m: float = 0.0) -> tuple[float, float]:
    """The point ``north_m`` metres north and ``east_m`` metres east of (lat, lng)."""
    return (
        lat + north_m / M_PER_DEG_LAT,
        lng + east_m / (M_PER_DEG_LAT * math.cos(math.radians(lat))),
    )


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


def employee_headers(emp: Employee) -> dict:
    return bearer({"role": "employee", "employeeId": emp.id})


def hr_headers(user: HRUser) -> dict:
    return bearer({"role": "hr", "hrUserId": user.id, "name": user.full_name or user.username})


def point(
    seq: int, at: datetime, lat: float = LAT0, lng: float = LNG0, *, acc: float = 8.0, snake: bool = False, **extra
) -> dict:
    """One point of a /tracking/batch body, camelCase (or snake_case with snake=True, the way the mobile app's axios sends it)."""
    row = {
        "seq": seq,
        "recordedAt": ms(at),
        "latitude": lat,
        "longitude": lng,
        "accuracy": acc,
        "speed": 0,
        "activity": "unknown",
        "battery": 80,
        "network": "wifi",
        "provider": "gps",
        "isMocked": False,
    }
    row.update(extra)
    if snake:
        row = {_snake(k): v for k, v in row.items()}
    return row


def event(seq: int, kind: str, at: datetime, **extra) -> dict:
    row = {"seq": seq, "kind": kind, "startedAt": ms(at)}
    row.update(extra)
    return row


def _snake(key: str) -> str:
    out = []
    for ch in key:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def snake_deep(value):
    """What the mobile app's axios client does to a JSON body: every key, at every level, decamelized."""
    if isinstance(value, dict):
        return {_snake(k): snake_deep(v) for k, v in value.items()}
    if isinstance(value, list):
        return [snake_deep(v) for v in value]
    return value


class GeoBase(TestCase):
    """A small company: two branches, a department, employees at each, and HR users with different scopes."""

    def setUp(self):
        super().setUp()
        self.ho = Branch.objects.create(name="Geo Head Office", code="GEO-HO")
        self.u2 = Branch.objects.create(name="Geo Unit 2", code="GEO-U2")
        self.dept = Department.objects.create(name="Sales")
        self.asha = self.employee("G1", "Asha", "Kumar", self.ho)
        self.meena = self.employee("G2", "Meena", "Devi", self.ho)
        self.ravi = self.employee("G3", "Ravi", "Raj", self.u2)
        self.hr_super = HRUser.objects.create(
            username="geo_admin", password_hash="x", is_super_admin=True, full_name="Admin"
        )
        self.hr_ho = self.hr_user("ho", {"geo_attendance": "edit", "settings": "edit"}, branch=self.ho)
        self.hr_u2 = self.hr_user("u2", {"geo_attendance": "edit"}, branch=self.u2)
        self.hr_viewer = self.hr_user("viewer", {"geo_attendance": "view", "settings": "view"})
        self.hr_editor = self.hr_user("editor", {"geo_attendance": "edit", "settings": "edit"})
        self.hr_nogeo = self.hr_user("nogeo", {"leave": "edit"})

    # ── people ──────────────────────────────────────────────────────────────

    def employee(self, code: str, first: str, last: str, branch: Branch | None) -> Employee:
        return Employee.objects.create(
            employee_code=code,
            first_name=first,
            last_name=last,
            status="active",
            employment_type="staff",
            join_date="2020-01-01",
            branch=branch,
            department=self.dept,
        )

    def hr_user(self, name: str, permissions: dict, branch: Branch | None = None) -> HRUser:
        role = Role.objects.create(name=f"geo_{name}", permissions=permissions)
        return HRUser.objects.create(
            username=f"geo_{name}", password_hash="x", role=role, branch=branch, full_name=name.title()
        )

    # ── tracks ──────────────────────────────────────────────────────────────

    def make_session(
        self, emp: Employee, *, status: str = OnDutySession.STATUS_PENDING_HOD, created=None, **extra
    ) -> OnDutySession:
        session = OnDutySession.objects.create(
            employee=emp, destination="ABC Traders, Coimbatore", branch=emp.branch, status=status, **extra
        )
        if created is not None:
            OnDutySession.objects.filter(pk=session.pk).update(created_at=created)
        return session

    def make_track(
        self,
        emp: Employee,
        started_at: datetime = T0,
        *,
        ended_at: datetime | None = None,
        session: OnDutySession | None = None,
        **extra,
    ) -> DutyTrack:
        session = session or self.make_session(emp)
        fields = {"status": DutyTrack.STATUS_ACTIVE if ended_at is None else DutyTrack.STATUS_ENDED}
        if ended_at is not None:
            fields.update(
                ended_at=ended_at, end_reason=extra.pop("end_reason", DutyTrack.END_MANUAL), state=DutyTrack.STATE_ENDED
            )
        fields.update(extra)
        fields.setdefault("state_since", started_at)
        return DutyTrack.objects.create(
            session=session, employee=emp, branch=emp.branch, started_at=started_at, **fields
        )

    def consent(self, emp: Employee, device: str = "dev-1", version: int | None = None) -> None:
        from .geo_tracking import settings as geo_settings

        TrackingConsent.objects.create(
            employee=emp, device_id=device, notice_version=version or geo_settings.get().notice_version
        )

    # ── calls ───────────────────────────────────────────────────────────────

    def call(self, method: str, path: str, body=None, headers=None, **params):
        client = self.client
        headers = headers or {}
        if method == "get":
            return client.get(path, params, **headers)
        return getattr(client, method)(
            path, body if body is not None else {}, content_type="application/json", **headers
        )

    def as_employee(self, emp, method, path, body=None, **params):
        return self.call(method, path, body, employee_headers(emp), **params)

    def as_hr(self, user, method, path, body=None, **params):
        return self.call(method, path, body, hr_headers(user), **params)

    def batch(self, emp, points=(), events=(), *, device="dev-1", extra=None, snake=False):
        body = {"deviceId": device, "points": list(points), "events": list(events)}
        body.update(extra or {})
        if snake:
            body = snake_deep(body)
        return self.as_employee(emp, "post", "/api/tracking/batch", body)
