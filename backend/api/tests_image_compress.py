"""Image compression (api/image_compress.py): the pure functions, the storage layer every FileField save goes through,
each view that keeps a picture as base64 text, and the compress_stored_images management command."""

import base64
import io
from io import StringIO
from types import SimpleNamespace
from unittest import mock

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase
from PIL import Image

from . import image_compress as ic
from .jwt_utils import sign_token
from .models import (
    Branch,
    CompanyDocumentSettings,
    Employee,
    EmployeeDocument,
    FileBlob,
    HRUser,
    OnDutyPunchVerification,
    PayrollSettings,
)

PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
BROKEN_JPEG = b"\xff\xd8\xff\xe0" + b"0" * 400


# ── picture builders ───────────────────────────────────────────────────────────────────────────────────────────────


def picture(w: int, h: int) -> Image.Image:
    """Something photo-like: smooth gradients with grain, so it neither compresses to nothing nor is pure noise."""
    grain = Image.effect_noise((w, h), 24)
    across = Image.linear_gradient("L").rotate(90).resize((w, h))
    down = Image.linear_gradient("L").resize((w, h))
    return Image.merge("RGB", (grain, across, down))


def encode(img: Image.Image, fmt: str = "JPEG", **kw) -> bytes:
    out = io.BytesIO()
    if fmt == "JPEG":
        kw.setdefault("quality", 95)
    img.save(out, format=fmt, **kw)
    return out.getvalue()


def transparent_logo(w: int = 1200, h: int = 500) -> Image.Image:
    """A coloured mark with grain on a fully transparent background."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    mark = picture(w // 2, h // 2).convert("RGBA")
    img.paste(mark, (w // 4, h // 4))
    return img


def opened(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def from_data_url(value: str) -> tuple[str, bytes]:
    head, payload = value.split(",", 1)
    return head[5:].split(";")[0], base64.b64decode(payload)


# ── the pure functions ─────────────────────────────────────────────────────────────────────────────────────────────


class CompressBytesTests(SimpleTestCase):
    def test_a_big_jpeg_comes_back_much_smaller_and_within_the_limit(self):
        original = encode(picture(3000, 2000))
        result = ic.compress_bytes(original, ic.PHOTO)
        self.assertTrue(result.changed)
        self.assertEqual((result.mime, result.reason), ("image/jpeg", "compressed"))
        self.assertLess(len(result.data), len(original) / 4)
        img = opened(result.data)
        self.assertEqual((img.format, img.size), ("JPEG", (800, 533)))

    def test_each_profile_has_its_own_long_side(self):
        original = encode(picture(1200, 3000))
        self.assertEqual(opened(ic.compress_bytes(original, "photo").data).size[1], 800)
        self.assertEqual(opened(ic.compress_bytes(original, "document").data).size[1], 1600)
        self.assertEqual(max(opened(ic.compress_bytes(original, "logo").data).size), 600)

    def test_a_png_with_transparency_stays_a_png_for_a_logo(self):
        original = encode(transparent_logo(), "PNG")
        result = ic.compress_bytes(original, ic.LOGO)
        self.assertTrue(result.changed)
        img = opened(result.data)
        self.assertEqual((result.mime, img.format, img.mode, img.size), ("image/png", "PNG", "RGBA", (600, 250)))
        self.assertEqual(img.getpixel((0, 0))[3], 0, "the background is still transparent")
        self.assertEqual(img.getpixel((300, 125))[3], 255)

    def test_a_transparent_png_photo_is_put_on_white_and_made_jpeg(self):
        result = ic.compress_bytes(encode(transparent_logo(), "PNG"), ic.PHOTO)
        img = opened(result.data)
        self.assertEqual((result.mime, img.format, img.mode), ("image/jpeg", "JPEG", "RGB"))
        self.assertTrue(all(c > 245 for c in img.getpixel((2, 2))), "transparent parts become white, not black")

    def test_a_png_photo_without_transparency_becomes_a_jpeg(self):
        result = ic.compress_bytes(encode(picture(1500, 1000), "PNG"), ic.DOCUMENT)
        self.assertEqual((result.mime, opened(result.data).format), ("image/jpeg", "JPEG"))

    def test_the_exif_orientation_is_applied_and_the_exif_dropped(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # "rotate 90 degrees clockwise to show"
        exif[0x0110] = "Phone X"
        original = encode(picture(400, 200), exif=exif.tobytes())
        result = ic.compress_bytes(original, ic.PHOTO)
        self.assertTrue(result.changed)
        img = opened(result.data)
        self.assertEqual(img.size, (200, 400), "stored upright")
        self.assertIsNone(img.getexif().get(0x0112))
        self.assertIsNone(img.getexif().get(0x0110))

    def test_a_pdf_and_other_files_pass_through_untouched(self):
        for data in (PDF, b"PK\x03\x04 a word file", b"", b"plain text"):
            result = ic.compress_bytes(data, ic.DOCUMENT)
            self.assertEqual(
                (result.data, result.mime, result.changed, result.reason), (data, None, False, "not-an-image")
            )

    def test_a_damaged_image_is_kept_as_it_came_and_logged(self):
        with self.assertLogs("api.image_compress", "WARNING") as logs:
            result = ic.compress_bytes(BROKEN_JPEG, ic.PHOTO)
        self.assertEqual((result.data, result.changed, result.reason), (BROKEN_JPEG, False, "unreadable"))
        self.assertIn("kept as it is", logs.output[0])

    def test_nothing_ever_gets_bigger(self):
        small = encode(picture(120, 90), quality=40)
        result = ic.compress_bytes(small, ic.PHOTO)
        self.assertEqual((result.data, result.changed, result.reason), (small, False, "no-saving"))

    def test_compressing_twice_changes_nothing_the_second_time(self):
        once = ic.compress_bytes(encode(picture(2000, 1500)), ic.PHOTO).data
        again = ic.compress_bytes(once, ic.PHOTO)
        self.assertFalse(again.changed)
        self.assertEqual(again.data, once)

    def test_a_grayscale_scan_stays_grayscale(self):
        scan = encode(picture(2400, 1800).convert("L"), "PNG")
        img = opened(ic.compress_bytes(scan, ic.DOCUMENT).data)
        self.assertEqual((img.format, img.mode, img.size), ("JPEG", "L", (1600, 1200)))

    def test_an_animated_gif_is_left_alone(self):
        frames = [picture(300, 200).convert("P"), picture(300, 200).convert("P")]
        out = io.BytesIO()
        frames[0].save(out, format="GIF", save_all=True, append_images=frames[1:])
        result = ic.compress_bytes(out.getvalue(), ic.PHOTO)
        self.assertEqual((result.changed, result.reason), (False, "animated"))

    def test_an_image_is_recognised_by_its_bytes_not_its_name(self):
        self.assertEqual(ic.sniff(encode(picture(10, 10))), "image/jpeg")
        self.assertEqual(ic.sniff(encode(picture(10, 10), "PNG")), "image/png")
        self.assertEqual(ic.sniff(encode(picture(10, 10), "WEBP")), "image/webp")
        self.assertIsNone(ic.sniff(PDF))


class DataUrlTests(SimpleTestCase):
    def test_a_photo_data_url_comes_back_as_a_smaller_jpeg_data_url(self):
        value = data_url(encode(picture(1600, 1600), "PNG"), "image/png")
        out = ic.compress_data_url(value, ic.PHOTO)
        mime, raw = from_data_url(out)
        self.assertEqual(mime, "image/jpeg")
        self.assertLess(len(out), len(value) / 4)
        self.assertEqual(opened(raw).size, (800, 800))

    def test_anything_that_is_not_a_base64_image_comes_back_untouched(self):
        for value in (
            None,
            "",
            "https://example.com/p.jpg",
            "/api/employees/7/photo",
            "data:text/plain,hello",
            data_url(PDF, "application/pdf"),
            data_url(BROKEN_JPEG, "image/jpeg"),
            12,
        ):
            with self.assertNoLogs("api.image_compress", "ERROR"):
                self.assertEqual(ic.compress_data_url(value, ic.PHOTO), value)

    def test_the_declared_type_does_not_matter_only_the_bytes(self):
        value = data_url(encode(picture(1600, 1200)), "image/png")  # a JPEG that says it is a PNG
        self.assertTrue(ic.compress_data_url(value, ic.PHOTO).startswith("data:image/jpeg;base64,"))


class FileNameTests(SimpleTestCase):
    def test_with_extension(self):
        self.assertEqual(ic.with_extension("a/b/scan.png", "image/jpeg"), "a/b/scan.jpg")
        self.assertEqual(ic.with_extension("a/b/scan.JPEG", "image/jpeg"), "a/b/scan.JPEG")
        self.assertEqual(ic.with_extension("logo.jpg", "image/png"), "logo.png")
        self.assertEqual(ic.with_extension("noext", "image/jpeg"), "noext.jpg")
        self.assertEqual(ic.with_extension("a.pdf", None), "a.pdf")

    def test_matching_filename(self):
        self.assertEqual(
            ic.matching_filename("Aadhaar Front.png", "employee_documents/2026/10/x.jpg"), "Aadhaar Front.jpg"
        )
        self.assertEqual(ic.matching_filename("pan.jpeg", "employee_documents/2026/10/pan.jpg"), "pan.jpeg")
        self.assertEqual(ic.matching_filename("pan.png", "employee_documents/2026/10/pan.png"), "pan.png")
        self.assertEqual(ic.matching_filename("letter.pdf", "employee_documents/2026/10/letter.pdf"), "letter.pdf")
        self.assertEqual(ic.matching_filename("", "x.jpg"), "")

    def test_the_folder_decides_the_profile(self):
        self.assertIs(ic.profile_for_name("on_duty_punch_verifications/2026/10/p.jpg"), ic.PHOTO)
        self.assertIs(ic.profile_for_name("employee_documents/2026/10/p.jpg"), ic.DOCUMENT)
        self.assertIs(ic.profile_for_name("anything/else.png"), ic.DOCUMENT)


# ── the storage layer ──────────────────────────────────────────────────────────────────────────────────────────────


def hr_admin(username="img_admin"):
    user = HRUser.objects.create(username=username, password_hash="x", is_super_admin=True)
    return user, {"HTTP_AUTHORIZATION": f"Bearer {sign_token({'role': 'hr', 'hrUserId': user.id, 'name': 'Admin'})}"}


class StorageTests(TestCase):
    def test_a_punch_selfie_saved_through_its_file_field_is_compressed_and_renamed(self):
        field = OnDutyPunchVerification._meta.get_field("photo")
        name = field.generate_filename(None, "selfie.png")
        original = encode(picture(1500, 2000), "PNG")
        stored = default_storage.save(name, ContentFile(original))
        posix = stored.replace("\\", "/")  # Django builds the folder with os.path: backslashes on a Windows machine
        self.assertTrue(posix.startswith("on_duty_punch_verifications/") and posix.endswith("selfie.jpg"), stored)
        blob = FileBlob.objects.get(name=stored)
        self.assertEqual((blob.content_type, blob.size), ("image/jpeg", len(bytes(blob.content))))
        self.assertLess(blob.size, len(original) / 10)
        self.assertEqual(opened(bytes(blob.content)).size, (600, 800))
        self.assertFalse(FileBlob.objects.filter(name=name).exists())
        with default_storage.open(stored) as f:
            self.assertEqual(f.read(), bytes(blob.content))

    def test_a_pdf_is_stored_byte_for_byte_under_its_own_name(self):
        stored = default_storage.save("employee_documents/2026/10/letter.pdf", ContentFile(PDF))
        self.assertEqual(stored, "employee_documents/2026/10/letter.pdf")
        blob = FileBlob.objects.get(name=stored)
        self.assertEqual((bytes(blob.content), blob.size, blob.content_type), (PDF, len(PDF), "application/pdf"))

    def test_a_damaged_image_is_stored_as_it_came(self):
        with self.assertLogs("api.image_compress", "WARNING"):
            stored = default_storage.save("employee_documents/2026/10/bad.jpg", ContentFile(BROKEN_JPEG))
        self.assertEqual(bytes(FileBlob.objects.get(name=stored).content), BROKEN_JPEG)

    def test_a_renamed_picture_never_overwrites_an_existing_file(self):
        default_storage.save("employee_documents/2026/10/card.jpg", ContentFile(PDF))
        stored = default_storage.save(
            "employee_documents/2026/10/card.png", ContentFile(encode(picture(2000, 1000), "PNG"))
        )
        self.assertNotEqual(stored, "employee_documents/2026/10/card.jpg")
        self.assertTrue(stored.endswith(".jpg"))
        self.assertEqual(bytes(FileBlob.objects.get(name="employee_documents/2026/10/card.jpg").content), PDF)


class EmployeeDocumentUploadTests(TestCase):
    def setUp(self):
        self.user, self.headers = hr_admin()
        self.emp = Employee.objects.create(employee_code="D1", first_name="Asha", last_name="K")

    def upload(self, name, data):
        return self.client.post(
            f"/api/recruitment/employee-documents/{self.emp.pk}/upload",
            {"file": ContentFile(data, name=name), "category": EmployeeDocument.CATEGORY_AADHAAR},
            **self.headers,
        )

    def test_a_photographed_document_is_stored_compressed_and_served_as_what_it_is(self):
        original = encode(picture(2400, 1800), "PNG")
        r = self.upload("Aadhaar Front.png", original)
        self.assertEqual(r.status_code, 201, r.content)
        doc = EmployeeDocument.objects.get()
        self.assertEqual(doc.original_filename, "Aadhaar Front.png")
        self.assertTrue(doc.file.name.endswith(".jpg"), doc.file.name)
        blob = FileBlob.objects.get(name=doc.file.name)
        self.assertLess(blob.size, len(original) / 5)
        self.assertEqual(opened(bytes(blob.content)).size, (1600, 1200), "documents keep enough pixels to read")

        served = self.client.get(f"/api/employee-documents/{doc.pk}/file", **self.headers)
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served["Content-Type"], "image/jpeg")
        self.assertEqual(served["Content-Disposition"], 'inline; filename="Aadhaar Front.jpg"')
        self.assertEqual(b"".join(served.streaming_content), bytes(blob.content))

    def test_a_pdf_document_is_untouched(self):
        self.assertEqual(self.upload("pan.pdf", PDF).status_code, 201)
        doc = EmployeeDocument.objects.get()
        self.assertTrue(doc.file.name.endswith("pan.pdf"))
        served = self.client.get(f"/api/employee-documents/{doc.pk}/file?download=1", **self.headers)
        self.assertEqual(b"".join(served.streaming_content), PDF)
        self.assertEqual(served["Content-Disposition"], 'attachment; filename="pan.pdf"')


# ── pictures kept as text ──────────────────────────────────────────────────────────────────────────────────────────


class TextColumnTests(TestCase):
    def setUp(self):
        self.user, self.headers = hr_admin()
        self.branch = Branch.objects.create(name="Main", code="MAIN")

    def assert_compressed_photo(self, stored: str, sent: str, side: int = 800):
        mime, raw = from_data_url(stored)
        self.assertEqual(mime, "image/jpeg")
        self.assertLess(len(stored), len(sent) / 3)
        self.assertEqual(max(opened(raw).size), side)

    def test_creating_an_employee_stores_the_photo_compressed(self):
        sent = data_url(encode(picture(1600, 1600), "PNG"), "image/png")
        body = {
            "employeeCode": "E1",
            "firstName": "Asha",
            "lastName": "K",
            "phone": "9876543210",
            "branchId": self.branch.pk,
            "photoUrl": sent,
        }
        r = self.client.post("/api/employees", body, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 201, r.content)
        self.assert_compressed_photo(Employee.objects.get(employee_code="E1").photo_url, sent)

    def test_editing_an_employee_stores_a_new_photo_compressed_and_keeps_a_link_as_sent(self):
        emp = Employee.objects.create(employee_code="E2", first_name="Ravi", last_name="M", branch=self.branch)
        sent = data_url(encode(picture(2000, 1500)), "image/jpeg")
        url = f"/api/employees/{emp.pk}"
        r = self.client.patch(url, {"photoUrl": sent}, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        emp.refresh_from_db()
        self.assert_compressed_photo(emp.photo_url, sent)

        stored = emp.photo_url  # an unrelated edit resubmits the stored photo: it is not compressed again
        self.client.patch(
            url, {"photoUrl": stored, "firstName": "Ravi"}, content_type="application/json", **self.headers
        )
        emp.refresh_from_db()
        self.assertEqual(emp.photo_url, stored)

        self.client.patch(
            url, {"photoUrl": "https://example.com/r.jpg"}, content_type="application/json", **self.headers
        )
        emp.refresh_from_db()
        self.assertEqual(emp.photo_url, "https://example.com/r.jpg")
        self.client.patch(url, {"photoUrl": None}, content_type="application/json", **self.headers)
        emp.refresh_from_db()
        self.assertIsNone(emp.photo_url)

    def test_a_photo_taken_in_device_control_is_stored_compressed(self):
        from . import device_directory as dd

        emp = Employee.objects.create(employee_code="E3", first_name="Meena", last_name="S", branch=self.branch)
        raw = encode(picture(1000, 1000), quality=85)
        self.assertLess(len(raw), dd.MAX_PHOTO_BYTES)
        sent = data_url(raw, "image/jpeg")
        request = SimpleNamespace(
            hr_branch_id=None, jwt_user={"hrUserId": self.user.pk, "name": "Admin", "role": "hr"}, META={}
        )
        dd.save_employee_photo(request, emp.pk, sent)
        emp.refresh_from_db()
        mime, stored = from_data_url(emp.photo_url)
        self.assertEqual((mime, opened(stored).size), ("image/jpeg", (800, 800)))
        self.assertLess(len(stored), len(raw))

    def test_the_company_logo_and_signatures_are_stored_compressed_with_their_transparency(self):
        logo = data_url(encode(transparent_logo(), "PNG"), "image/png")
        signature = data_url(encode(picture(1800, 600)), "image/jpeg")
        body = {"companyLogo": logo, "signatureImage": signature, "authorizedSignature": signature}
        r = self.client.put("/api/payroll-settings", body, content_type="application/json", **self.headers)
        self.assertEqual(r.status_code, 200, r.content)
        ps = PayrollSettings.objects.get(pk=1)
        mime, raw = from_data_url(ps.company_logo)
        self.assertEqual((mime, opened(raw).mode, opened(raw).size), ("image/png", "RGBA", (600, 250)))
        for value in (ps.signature_image, ps.authorized_signature):
            mime, raw = from_data_url(value)
            self.assertEqual(max(opened(raw).size), 600)
            self.assertLess(len(value), len(signature) / 4)
        r = self.client.put(
            "/api/payroll-settings", {"companyLogo": None}, content_type="application/json", **self.headers
        )
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(PayrollSettings.objects.get(pk=1).company_logo)

    def test_a_document_logo_override_is_stored_compressed(self):
        logo = data_url(encode(picture(1500, 900), "PNG"), "image/png")
        r = self.client.put(
            "/api/document-settings/offer_letter",
            {"logoOverride": logo},
            content_type="application/json",
            **self.headers,
        )
        self.assertEqual(r.status_code, 200, r.content)
        stored = CompanyDocumentSettings.objects.get(doc_type="offer_letter").logo_override
        _mime, raw = from_data_url(stored)
        self.assertEqual(opened(raw).size, (600, 360))
        self.assertLess(len(stored), len(logo) / 4)


# ── the management command ─────────────────────────────────────────────────────────────────────────────────────────


class CompressStoredImagesCommandTests(TestCase):
    def setUp(self):
        self.big_photo = data_url(encode(picture(2000, 2000), "PNG"), "image/png")
        self.small_photo = data_url(ic.compress_bytes(encode(picture(1600, 1600)), ic.PHOTO).data, "image/jpeg")
        self.asha = Employee.objects.create(
            employee_code="C1", first_name="Asha", last_name="K", photo_url=self.big_photo
        )
        self.ravi = Employee.objects.create(
            employee_code="C2", first_name="Ravi", last_name="M", photo_url=self.small_photo
        )
        self.link = Employee.objects.create(
            employee_code="C3", first_name="Link", last_name="L", photo_url="https://example.com/x.jpg"
        )
        self.logo = data_url(encode(transparent_logo(), "PNG"), "image/png")
        PayrollSettings.objects.update_or_create(pk=1, defaults={"company_logo": self.logo})

        # files stored before compression existed: written straight into file_blobs, the way the old storage did
        self.scan = encode(picture(2400, 1800), "PNG")
        self.selfie = encode(picture(1500, 2000))
        self.scan_name = "employee_documents/2026/01/aadhaar.png"
        self.selfie_name = "on_duty_punch_verifications/2026/01/punch.jpg"
        for name, data, ctype in (
            (self.scan_name, self.scan, "image/png"),
            (self.selfie_name, self.selfie, "image/jpeg"),
            ("employee_documents/2026/01/pan.pdf", PDF, "application/pdf"),
            ("employee_documents/2026/01/bad.jpg", BROKEN_JPEG, "image/jpeg"),
        ):
            FileBlob.objects.create(name=name, content=data, content_type=ctype, size=len(data))
        self.doc = EmployeeDocument.objects.create(
            employee=self.asha,
            category=EmployeeDocument.CATEGORY_AADHAAR,
            file=self.scan_name,
            original_filename="aadhaar.png",
        )

    def run_command(self, **opts):
        out = StringIO()
        with self.assertLogs("api.image_compress", "WARNING"):  # the damaged picture is reported, never changed
            call_command("compress_stored_images", stdout=out, **opts)
        return out.getvalue()

    def snapshot(self):
        return (
            list(Employee.objects.order_by("pk").values_list("photo_url", flat=True)),
            PayrollSettings.objects.get(pk=1).company_logo,
            sorted((b.name, bytes(b.content)) for b in FileBlob.objects.all()),
            EmployeeDocument.objects.get().file.name,
        )

    def test_the_dry_run_reports_and_changes_nothing(self):
        before = self.snapshot()
        out = self.run_command()
        self.assertEqual(self.snapshot(), before)
        self.assertIn("Mode: dry run", out)
        self.assertIn("DRY RUN - nothing was changed", out)
        for label in (
            "file_blobs: employee_documents",
            "file_blobs: on_duty_punch_verifications",
            "employees.photo_url",
            "payroll_settings.company_logo",
            "company_document_settings.logo_override",
            "TOTAL",
        ):
            self.assertIn(label, out)
        photos = next(line for line in out.splitlines() if line.startswith("employees.photo_url"))
        self.assertEqual(photos.split()[1:3], ["2", "1"], "two data: photos, one of them worth compressing")

    def test_apply_compresses_in_place_and_follows_renamed_files(self):
        out = self.run_command(apply=True, noinput=True, batch_size=2)
        self.assertIn("Done: 4 picture(s) compressed.", out)

        self.asha.refresh_from_db()
        self.assertTrue(self.asha.photo_url.startswith("data:image/jpeg;base64,"))
        self.assertLess(len(self.asha.photo_url), len(self.big_photo) / 4)
        self.ravi.refresh_from_db()
        self.link.refresh_from_db()
        self.assertEqual((self.ravi.photo_url, self.link.photo_url), (self.small_photo, "https://example.com/x.jpg"))
        mime, raw = from_data_url(PayrollSettings.objects.get(pk=1).company_logo)
        self.assertEqual((mime, opened(raw).mode, opened(raw).size), ("image/png", "RGBA", (600, 250)))

        # the PNG scan is now a JPEG under a .jpg name, and the document row follows it
        self.doc.refresh_from_db()
        self.assertEqual(self.doc.file.name, "employee_documents/2026/01/aadhaar.jpg")
        self.assertFalse(FileBlob.objects.filter(name=self.scan_name).exists())
        blob = FileBlob.objects.get(name=self.doc.file.name)
        self.assertEqual((blob.content_type, blob.size), ("image/jpeg", len(bytes(blob.content))))
        self.assertEqual(opened(bytes(blob.content)).size, (1600, 1200))
        with self.doc.file.open("rb") as f:
            self.assertEqual(f.read(), bytes(blob.content))

        selfie = FileBlob.objects.get(name=self.selfie_name)
        self.assertEqual(opened(bytes(selfie.content)).size, (600, 800))
        self.assertEqual(bytes(FileBlob.objects.get(name="employee_documents/2026/01/pan.pdf").content), PDF)
        self.assertEqual(bytes(FileBlob.objects.get(name="employee_documents/2026/01/bad.jpg").content), BROKEN_JPEG)

        again = self.run_command(apply=True, noinput=True)
        self.assertIn("Done: 0 picture(s) compressed.", again)

    def test_apply_asks_first_and_stops_on_anything_but_the_word(self):
        before = self.snapshot()
        with mock.patch("builtins.input", return_value="yes"):
            with self.assertRaises(CommandError):
                call_command("compress_stored_images", apply=True, stdout=StringIO())
        self.assertEqual(self.snapshot(), before)

    def test_only_text_leaves_the_files_alone(self):
        before_files = self.snapshot()[2]
        out = StringIO()
        call_command("compress_stored_images", apply=True, noinput=True, only="text", stdout=out)
        self.assertEqual(self.snapshot()[2], before_files)
        self.assertNotIn("file_blobs", out.getvalue())
