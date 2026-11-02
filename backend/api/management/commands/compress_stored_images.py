"""Compress the pictures that were stored before upload-time compression existed (api/image_compress.py).

    python manage.py compress_stored_images             # DRY RUN (the default): counts and sizes, changes nothing
    python manage.py compress_stored_images --apply     # compresses in place, in batches - IRREVERSIBLE

What it looks at:
  * file_blobs: every stored file whose name or type says it is a picture (On-Duty selfies, employee documents ...),
    with the same profile the upload path uses (selfies as photos, everything else as documents). A picture that
    changes type is renamed to the matching extension, and every FileField pointing at it is updated in the same
    transaction. PDFs and other files are never read. Files still on the server's disk (uploaded before file_blobs
    existed) are not touched.
  * the pictures kept as base64 text: employees.photo_url, the company logo and the two signatures in payroll
    settings, and each document type's logo override.

The dry run really compresses every picture in memory, so "after" is what --apply would store, not a guess. A picture
that would not get clearly smaller is left as it is (image_compress.MIN_SAVING), so running --apply twice is harmless.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, models, transaction

from api.image_compress import LOGO, PHOTO, compress_bytes, profile_for_name, split_data_url, with_extension

IMAGE_NAME_REGEX = r"\.(jpe?g|jpe|jfif|png|webp|gif|bmp|tiff?)$"


@dataclass
class Tally:
    label: str
    images: int = 0
    smaller: int = 0
    unreadable: int = 0
    skipped: int = 0
    before: int = 0
    after: int = 0

    def add(self, before: int, after: int, changed: bool, unreadable: bool = False):
        self.images += 1
        self.before += before
        self.after += after
        self.smaller += int(changed)
        self.unreadable += int(unreadable)


def text_targets():
    from api.models import CompanyDocumentSettings, Employee, PayrollSettings

    return (
        ("employees.photo_url", Employee, "photo_url", PHOTO),
        ("payroll_settings.company_logo", PayrollSettings, "company_logo", LOGO),
        ("payroll_settings.signature_image", PayrollSettings, "signature_image", LOGO),
        ("payroll_settings.authorized_signature", PayrollSettings, "authorized_signature", LOGO),
        ("company_document_settings.logo_override", CompanyDocumentSettings, "logo_override", LOGO),
    )


def file_fields():
    """Every (model, field name, max_length) that stores a file name - the rows a renamed blob must follow."""
    out = []
    for model in apps.get_models():
        for field in model._meta.concrete_fields:
            if isinstance(field, models.FileField):
                out.append((model, field.name, field.max_length))
    return out


def human(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def batches(ids, size):
    for i in range(0, len(ids), size):
        yield ids[i : i + size]


class Command(BaseCommand):
    help = "Report (default) or, with --apply, compress the pictures already stored in the database. Irreversible."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Compress in place. Without it nothing is changed.")
        parser.add_argument("--batch-size", type=int, default=50, help="Rows read per batch (default 50).")
        parser.add_argument(
            "--only", choices=("files", "text"), help="Only the stored files, or only the text columns."
        )
        parser.add_argument(
            "--noinput", "--no-input", action="store_true", dest="noinput", help="Do not ask before --apply."
        )

    def handle(self, *args, **opts):
        apply = opts["apply"]
        size = max(1, opts["batch_size"])
        db = connection.settings_dict
        self.stdout.write(f"Database: {db.get('NAME')} on {db.get('HOST') or 'localhost'}")
        self.stdout.write(
            "Mode: APPLY - pictures will be replaced by their compressed copies" if apply else "Mode: dry run"
        )
        if apply and not opts["noinput"]:
            answer = input("Compressing stored pictures cannot be undone. Type 'compress' to go on: ")
            if answer.strip() != "compress":
                raise CommandError("Stopped - nothing was changed.")

        tallies = []
        if opts["only"] in (None, "files"):
            tallies.extend(self.files(apply, size))
        if opts["only"] in (None, "text"):
            for label, model, field, profile in text_targets():
                tallies.append(self.text_column(label, model, field, profile, apply, size))
        self.report(tallies, apply)

    # ── file_blobs ────────────────────────────────────────────────────────────────────────────────────────────────

    def files(self, apply: bool, size: int) -> list[Tally]:
        from api.db_file_storage import HybridFileStorage
        from api.models import FileBlob

        storage = HybridFileStorage()
        fields = file_fields()
        candidates = FileBlob.objects.filter(
            models.Q(content_type__istartswith="image/") | models.Q(name__iregex=IMAGE_NAME_REGEX)
        )
        ids = list(candidates.order_by("pk").values_list("pk", flat=True))
        tallies: dict[str, Tally] = {}
        done = 0
        for chunk in batches(ids, size):
            for pk in chunk:
                if apply:
                    with transaction.atomic():
                        blob = FileBlob.objects.select_for_update().filter(pk=pk).first()
                        if blob is not None:
                            self.blob(blob, tallies, apply, storage, fields)
                else:
                    blob = FileBlob.objects.filter(pk=pk).only("pk", "name", "content").first()
                    if blob is not None:
                        self.blob(blob, tallies, apply, storage, fields)
            done += len(chunk)
            self.stdout.write(f"  file_blobs: {done}/{len(ids)}")
        return sorted(tallies.values(), key=lambda t: t.label)

    def blob(self, blob, tallies, apply, storage, fields):
        folder = blob.name.split("/", 1)[0] if "/" in blob.name else "(top level)"
        tally = tallies.setdefault(folder, Tally(f"file_blobs: {folder}"))
        data = bytes(blob.content)
        result = compress_bytes(data, profile_for_name(blob.name))
        if result.mime is None:
            tally.skipped += 1  # named like a picture but is not one: never touched
            return
        new_name = with_extension(blob.name, result.mime) if result.changed else blob.name
        if new_name != blob.name:
            new_name = storage.get_available_name(new_name)
            if any(max_length and len(new_name) > max_length for _model, _field, max_length in fields):
                # the new name would not fit a file column: this one is left exactly as it is
                tally.skipped += 1
                tally.add(len(data), len(data), False)
                return
        tally.add(len(data), len(result.data), result.changed, result.reason == "unreadable")
        if not (apply and result.changed):
            return
        if new_name != blob.name:
            for model, field, _max_length in fields:
                model._base_manager.filter(**{field: blob.name}).update(**{field: new_name})
        blob.name = new_name
        blob.content = result.data
        blob.size = len(result.data)
        blob.content_type = result.mime
        blob.save(update_fields=["name", "content", "size", "content_type"])

    # ── pictures kept as text ─────────────────────────────────────────────────────────────────────────────────────

    def text_column(self, label, model, field, profile, apply: bool, size: int) -> Tally:
        tally = Tally(label)
        ids = list(
            model._base_manager.filter(**{f"{field}__startswith": "data:"}).order_by("pk").values_list("pk", flat=True)
        )
        done = 0
        for chunk in batches(ids, size):
            rows = model._base_manager.filter(pk__in=chunk).values_list("pk", field)
            for pk, value in rows:
                parts = split_data_url(value)
                if parts is None:
                    tally.skipped += 1
                    continue
                result = compress_bytes(parts[1], profile)
                new_value = (
                    f"data:{result.mime};base64,{base64.b64encode(result.data).decode('ascii')}"
                    if result.changed
                    else value
                )
                tally.add(len(value), len(new_value), result.changed, result.reason == "unreadable")
                if apply and result.changed:
                    # only when nobody changed the picture since it was read
                    model._base_manager.filter(pk=pk, **{field: value}).update(**{field: new_value})
            done += len(chunk)
            self.stdout.write(f"  {label}: {done}/{len(ids)}")
        return tally

    # ── the report ────────────────────────────────────────────────────────────────────────────────────────────────

    def report(self, tallies: list[Tally], apply: bool):
        width = max([len(t.label) for t in tallies] + [24])
        line = f"{{:<{width}}} {{:>7}} {{:>8}} {{:>10}} {{:>11}} {{:>11}} {{:>7}}"
        self.stdout.write("")
        self.stdout.write(line.format("Where", "Images", "Smaller", "Unreadable", "Now", "After", "Saving"))
        total = Tally("TOTAL")
        for t in tallies:
            total.images += t.images
            total.smaller += t.smaller
            total.unreadable += t.unreadable
            total.skipped += t.skipped
            total.before += t.before
            total.after += t.after
            self.stdout.write(self.row(line, t))
        self.stdout.write(self.row(line, total))
        self.stdout.write("")
        self.stdout.write("Now/After: bytes as stored (a text column counts its base64 characters).")
        if total.skipped:
            self.stdout.write(f"{total.skipped} item(s) named like a picture but not one, or left alone: not changed.")
        if total.unreadable:
            self.stdout.write(f"{total.unreadable} picture(s) could not be read and stay exactly as they are.")
        if apply:
            self.stdout.write(self.style.SUCCESS(f"Done: {total.smaller} picture(s) compressed."))
        else:
            self.stdout.write(
                self.style.WARNING("DRY RUN - nothing was changed. --apply compresses these in place (irreversible).")
            )

    @staticmethod
    def row(line, t: Tally) -> str:
        saving = f"{(1 - t.after / t.before) * 100:.0f}%" if t.before else "-"
        return line.format(t.label, t.images, t.smaller, t.unreadable, human(t.before), human(t.after), saving)
