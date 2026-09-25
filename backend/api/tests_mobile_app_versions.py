"""Mobile App updates: HR publishes builds, the employee app is told about the newest one."""

from django.test import SimpleTestCase, TestCase

from .jwt_utils import sign_token
from .mobile_app_version_views import normalize_download_url, parse_version, update_for
from .models import AuditLog, Employee, HRUser, MobileAppVersion, Role

BASE = "/api/mobile-app"
LINK = "https://example.test/ukt-3.apk"


def _hr(username="ma_admin", super_admin=True, role=None):
    user, _ = HRUser.objects.get_or_create(
        username=username,
        defaults={"password_hash": "x", "is_super_admin": super_admin, "role": role},
    )
    token = sign_token({"role": "hr", "hrUserId": user.id, "name": username})
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def publish(version, *, active=True, mandatory=True, notes="", url=LINK):
    return MobileAppVersion.objects.create(
        version=version, download_url=url, release_notes=notes, is_active=active, is_mandatory=mandatory
    )


class VersionNumberTests(SimpleTestCase):
    def test_versions_are_numbers_not_text(self):
        self.assertGreater(parse_version("3.0.10"), parse_version("3.0.9"))
        self.assertGreater(parse_version("10.0.0"), parse_version("9.9.9"))
        self.assertGreater(parse_version("3.1"), parse_version("3.0.9"))

    def test_trailing_zeros_and_a_leading_v_do_not_matter(self):
        self.assertEqual(parse_version("3.0"), parse_version("3.0.0"))
        self.assertEqual(parse_version("v3.0.0"), parse_version("3.0"))
        self.assertLess(parse_version("3.0.0"), parse_version("3.0.1"))

    def test_anything_that_is_not_dotted_numbers_is_rejected(self):
        for bad in ("", "3", "abc", "3.x", "3.0.0-beta", "1.2.3.4.5", "3..0", " ", None, 3.0, "12345.1"):
            self.assertIsNone(parse_version(bad), repr(bad))


class DownloadLinkTests(SimpleTestCase):
    FILE_ID = "1AbC-dEf_GhI2jKlMnOpQrStUvWxYz012"
    DIRECT = f"https://drive.google.com/uc?export=download&id={FILE_ID}"

    def test_a_google_drive_share_link_becomes_a_direct_download(self):
        for link in (
            f"https://drive.google.com/file/d/{self.FILE_ID}/view?usp=sharing",
            f"https://drive.google.com/file/d/{self.FILE_ID}/view",
            f"https://www.drive.google.com/file/d/{self.FILE_ID}/edit",
            f"https://drive.google.com/open?id={self.FILE_ID}",
            f"https://drive.google.com/uc?id={self.FILE_ID}",
            f"https://docs.google.com/uc?export=download&id={self.FILE_ID}",
            f"  https://drive.google.com/file/d/{self.FILE_ID}/view  ",
        ):
            self.assertEqual(normalize_download_url(link), self.DIRECT, link)

    def test_any_other_link_is_kept_exactly(self):
        for link in ("https://example.test/app/ukt-3.apk", "http://192.168.1.5:8000/files/ukt.apk?x=1"):
            self.assertEqual(normalize_download_url(link), link)

    def test_a_drive_folder_link_without_a_file_is_left_alone(self):
        folder = "https://drive.google.com/drive/folders/abc123"
        self.assertEqual(normalize_download_url(folder), folder)

    def test_only_web_links_are_accepted(self):
        for bad in (
            "",
            "  ",
            "not a link",
            "ftp://example.test/a.apk",
            "javascript:alert(1)",
            "file:///a.apk",
            "https://",
            None,
            5,
        ):
            self.assertIsNone(normalize_download_url(bad), repr(bad))


class UpdateDecisionTests(TestCase):
    def test_nothing_published_means_no_update(self):
        self.assertEqual(update_for("android", "3.0.0"), {"updateAvailable": False, "latest": None})

    def test_a_newer_build_is_offered_with_what_the_prompt_shows(self):
        publish("3.1.0", notes="Faster punch-in")
        result = update_for("android", "3.0.0")
        self.assertTrue(result["updateAvailable"])
        latest = result["latest"]
        self.assertEqual(latest["version"], "3.1.0")
        self.assertEqual(latest["downloadUrl"], LINK)
        self.assertEqual(latest["releaseNotes"], "Faster punch-in")
        self.assertTrue(latest["mandatory"])
        self.assertIn("publishedAt", latest)

    def test_the_same_or_a_newer_phone_is_not_prompted(self):
        publish("3.1.0")
        self.assertFalse(update_for("android", "3.1.0")["updateAvailable"])
        self.assertFalse(update_for("android", "3.1")["updateAvailable"])
        self.assertFalse(update_for("android", "3.2.0")["updateAvailable"])

    def test_the_newest_active_build_wins_and_withdrawn_ones_are_ignored(self):
        publish("3.0.9")
        publish("3.0.10")
        publish("4.0.0", active=False)
        self.assertEqual(update_for("android", "3.0.0")["latest"]["version"], "3.0.10")

    def test_an_unknown_current_version_never_prompts(self):
        publish("3.1.0")
        for current in (None, "", "garbage"):
            self.assertFalse(update_for("android", current)["updateAvailable"], repr(current))

    def test_an_optional_build_can_be_skipped_but_a_mandatory_one_in_between_cannot(self):
        publish("3.1.0", mandatory=True)
        publish("3.2.0", mandatory=False)
        # On 3.0.0 the phone skips over mandatory 3.1.0, so the update is mandatory.
        self.assertTrue(update_for("android", "3.0.0")["latest"]["mandatory"])
        # On 3.1.0 only optional 3.2.0 is ahead.
        self.assertFalse(update_for("android", "3.1.0")["latest"]["mandatory"])

    def test_only_the_asked_platform_counts(self):
        MobileAppVersion.objects.create(platform="ios", version="9.0.0", download_url=LINK)
        self.assertFalse(update_for("android", "3.0.0")["updateAvailable"])


class HrEndpointTests(TestCase):
    def setUp(self):
        self.hr = _hr()

    def post(self, body, headers=None):
        return self.client.post(f"{BASE}/versions", body, content_type="application/json", **(headers or self.hr))

    def put(self, pk, body, headers=None):
        return self.client.put(f"{BASE}/versions/{pk}", body, content_type="application/json", **(headers or self.hr))

    def test_publishing_a_version_stores_it_and_flags_it_as_the_latest(self):
        response = self.post({"version": "3.0.0", "downloadUrl": LINK, "releaseNotes": "  Startup fix  "})
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(body["version"], "3.0.0")
        self.assertEqual(body["releaseNotes"], "Startup fix")
        self.assertTrue(body["isMandatory"])
        self.assertTrue(body["isActive"])
        self.assertTrue(body["isLatest"])
        self.assertEqual(body["createdBy"], "ma_admin")
        self.assertEqual(MobileAppVersion.objects.count(), 1)
        self.assertTrue(AuditLog.objects.filter(module="mobile_app_version", action="create").exists())

    def test_a_drive_share_link_is_saved_as_a_direct_download(self):
        share = "https://drive.google.com/file/d/FILE123/view?usp=sharing"
        body = self.post({"version": "3.0.0", "downloadUrl": share}).json()
        self.assertEqual(body["downloadUrl"], "https://drive.google.com/uc?export=download&id=FILE123")

    def test_the_list_is_newest_first_and_marks_only_the_latest_active_build(self):
        publish("3.0.9")
        publish("3.0.10")
        withdrawn = publish("4.0.0", active=False)
        rows = self.client.get(f"{BASE}/versions", **self.hr).json()
        self.assertEqual([r["version"] for r in rows], ["4.0.0", "3.0.10", "3.0.9"])
        self.assertEqual([r["isLatest"] for r in rows], [False, True, False])
        self.assertFalse(rows[0]["isActive"])
        self.assertEqual(rows[0]["id"], withdrawn.id)

    def test_bad_input_is_explained(self):
        cases = [
            ({"downloadUrl": LINK}, "version"),
            ({"version": "three", "downloadUrl": LINK}, "numbers separated by dots"),
            ({"version": "3.0.0"}, "download link"),
            ({"version": "3.0.0", "downloadUrl": "ftp://x/y.apk"}, "download link"),
            ({"version": "3.0.0", "downloadUrl": LINK, "releaseNotes": "x" * 4001}, "at most"),
            ({"version": "3.0.0", "downloadUrl": LINK, "platform": "ios"}, "android"),
        ]
        for body, expected in cases:
            response = self.post(body)
            self.assertEqual(response.status_code, 400, body)
            self.assertIn(expected, response.json()["error"], body)
        self.assertEqual(MobileAppVersion.objects.count(), 0)

    def test_the_same_version_cannot_be_published_twice(self):
        self.assertEqual(self.post({"version": "3.0.0", "downloadUrl": LINK}).status_code, 201)
        again = self.post({"version": "v3.0.0", "downloadUrl": LINK})
        self.assertEqual(again.status_code, 409)
        self.assertEqual(MobileAppVersion.objects.count(), 1)

    def test_a_build_can_be_withdrawn_and_brought_back(self):
        row = publish("3.1.0")
        self.assertEqual(self.put(row.id, {"isActive": False}).json()["isActive"], False)
        self.assertFalse(update_for("android", "3.0.0")["updateAvailable"])
        self.assertTrue(self.put(row.id, {"isActive": True}).json()["isActive"])
        self.assertTrue(update_for("android", "3.0.0")["updateAvailable"])

    def test_editing_changes_only_what_was_sent(self):
        row = publish("3.1.0", notes="Old notes", mandatory=True)
        body = self.put(row.id, {"releaseNotes": "New notes", "isMandatory": False}).json()
        self.assertEqual(body["releaseNotes"], "New notes")
        self.assertFalse(body["isMandatory"])
        row.refresh_from_db()
        self.assertEqual((row.version, row.download_url, row.is_active), ("3.1.0", LINK, True))

    def test_a_version_cannot_be_renamed_onto_another_one(self):
        publish("3.0.0")
        row = publish("3.1.0")
        self.assertEqual(self.put(row.id, {"version": "3.0.0"}).status_code, 409)
        self.assertEqual(self.put(row.id, {"version": "3.1.1"}).status_code, 200)

    def test_deleting_removes_it(self):
        row = publish("3.1.0")
        self.assertEqual(self.client.delete(f"{BASE}/versions/{row.id}", **self.hr).status_code, 204)
        self.assertFalse(MobileAppVersion.objects.exists())
        self.assertEqual(self.client.delete(f"{BASE}/versions/{row.id}", **self.hr).status_code, 404)
        self.assertEqual(self.put(row.id, {"isActive": False}).status_code, 404)


class AccessTests(TestCase):
    def setUp(self):
        self.hr = _hr()
        self.emp = Employee.objects.create(employee_code="E1", first_name="Asha", last_name="Kumar", status="active")
        self.employee_headers = {
            "HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'employee', 'employeeId': self.emp.id})}"
        }

    def test_managing_versions_needs_an_hr_login(self):
        row = publish("3.1.0")
        for headers in ({}, self.employee_headers):
            self.assertIn(self.client.get(f"{BASE}/versions", **headers).status_code, (401, 403))
            posted = self.client.post(
                f"{BASE}/versions",
                {"version": "9.0.0", "downloadUrl": LINK},
                content_type="application/json",
                **headers,
            )
            self.assertIn(posted.status_code, (401, 403))
            self.assertIn(self.client.delete(f"{BASE}/versions/{row.id}", **headers).status_code, (401, 403))
        self.assertEqual(MobileAppVersion.objects.count(), 1)

    def test_the_mobile_app_page_permission_governs_it(self):
        view = _hr(
            "viewer", super_admin=False, role=Role.objects.create(name="V", permissions={"mobile_app_login": "view"})
        )
        edit = _hr(
            "editor", super_admin=False, role=Role.objects.create(name="E", permissions={"mobile_app_login": "edit"})
        )
        none = _hr("other", super_admin=False, role=Role.objects.create(name="O", permissions={"payroll": "edit"}))
        body = {"version": "3.0.0", "downloadUrl": LINK}

        self.assertEqual(self.client.get(f"{BASE}/versions", **view).status_code, 200)
        self.assertEqual(
            self.client.post(f"{BASE}/versions", body, content_type="application/json", **view).status_code, 403
        )
        self.assertEqual(
            self.client.post(f"{BASE}/versions", body, content_type="application/json", **edit).status_code, 201
        )
        self.assertEqual(self.client.get(f"{BASE}/versions", **none).status_code, 403)

    def test_the_latest_version_is_readable_with_no_login_at_all(self):
        publish("3.1.0", notes="Faster")
        response = self.client.get(f"{BASE}/latest-version", {"platform": "android", "current": "3.0.0"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store")
        body = response.json()
        self.assertTrue(body["updateAvailable"])
        self.assertEqual(body["latest"]["version"], "3.1.0")
        # What the prompt needs and nothing about who published it or internal ids.
        self.assertEqual(set(body["latest"]), {"version", "downloadUrl", "releaseNotes", "mandatory", "publishedAt"})

    def test_a_stale_or_invalid_login_token_never_turns_the_check_into_a_401(self):
        # The app sends whatever token it has saved with every request, and it signs the employee out
        # on any 401, so this endpoint must ignore a bad token rather than reject it.
        publish("3.1.0")
        for header in ("Bearer not-a-real-token", "Bearer "):
            response = self.client.get(f"{BASE}/latest-version", {"current": "3.0.0"}, HTTP_AUTHORIZATION=header)
            self.assertEqual(response.status_code, 200, header)
            self.assertTrue(response.json()["updateAvailable"], header)

    def test_the_public_check_defaults_to_android_and_refuses_unknown_platforms(self):
        publish("3.1.0")
        self.assertTrue(self.client.get(f"{BASE}/latest-version", {"current": "3.0.0"}).json()["updateAvailable"])
        self.assertEqual(self.client.get(f"{BASE}/latest-version", {"platform": "windows"}).status_code, 400)

    def test_the_public_check_says_nothing_to_update_when_nothing_is_published(self):
        body = self.client.get(f"{BASE}/latest-version", {"current": "3.0.0"}).json()
        self.assertEqual(body, {"updateAvailable": False, "latest": None})
