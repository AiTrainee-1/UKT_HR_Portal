"""File storage backed by Postgres instead of local disk.

Every upload in this app -geo-punch selfies, recruitment resumes, employee
documents- goes through Django's FileField, which already delegates every
read, write and delete to a pluggable Storage backend rather than touching
disk paths directly. That is what makes this change possible with **zero**
changes to models.py's FileField declarations or any view: swapping the
backend Django hands those calls to is the entire change.

Why this exists: this app runs on Railway, whose container filesystem is
ephemeral -anything saved to local disk (the previous, default behavior)
is at real risk of disappearing on the next redeploy or restart, while the
database row referencing it survives. Moving the bytes into Postgres removes
that risk entirely, at the cost storing binary content in the database
(acceptable for this app's file sizes -selfies, resumes, PDFs - a deliberate
tradeoff the user chose over external object storage).

Two classes:

  DatabaseFileStorage -pure Postgres backend. Every read/write/delete goes
  through the FileBlob model. This is what NEW uploads use.

  HybridFileStorage -what Django is actually configured to use (see
  settings.STORAGES). Writes ALWAYS go to DatabaseFileStorage. Reads and
  existence checks try DatabaseFileStorage first, then fall back to the
  local filesystem. This is what makes files uploaded before this shipped
  keep working unchanged -they were never migrated into Postgres, so the
  only way to keep reading them is to still look on disk for anything
  Postgres doesn't have.

Deliberately does not implement `path()` or `url()`: nothing in this app
generates a raw filesystem path or a direct media URL for these fields today
-every read already goes through an authenticated view that calls
`field.open("rb")` and streams the result via FileResponse (see
geo_attendance_views.py, resume_screening_views.py,
employee_documents_views.py). Django's base Storage class already raises
NotImplementedError for both, which is the correct behavior here, not a gap.
"""

from __future__ import annotations

import mimetypes

from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage, Storage
from django.utils.deconstruct import deconstructible


@deconstructible
class DatabaseFileStorage(Storage):
    """Stores file content as rows in the file_blobs table."""

    def _open(self, name, mode="rb"):
        from .models import FileBlob

        row = FileBlob.objects.filter(name=name).only("content").first()
        if row is None:
            raise FileNotFoundError(name)
        # `name=name` matters: FileResponse guesses Content-Type and the
        # download filename from this attribute, exactly as it did when
        # opening a real path off local disk -same behavior, same code path.
        return ContentFile(bytes(row.content), name=name)

    def _save(self, name, content):
        from .models import FileBlob

        content.seek(0)
        data = content.read()
        content_type = (
            getattr(content, "content_type", "") or mimetypes.guess_type(name)[0] or ""
        )
        FileBlob.objects.update_or_create(
            name=name,
            defaults={"content": data, "content_type": content_type, "size": len(data)},
        )
        return name

    def exists(self, name):
        from .models import FileBlob

        return FileBlob.objects.filter(name=name).exists()

    def delete(self, name):
        from .models import FileBlob

        FileBlob.objects.filter(name=name).delete()

    def size(self, name):
        from .models import FileBlob

        row = FileBlob.objects.filter(name=name).only("size").first()
        return row.size if row else 0

    def listdir(self, path):
        """Not used anywhere in this app -no UI browses uploads by directory.
        Implemented minimally rather than left to raise, in case that ever
        changes."""
        from .models import FileBlob

        prefix = f"{path.rstrip('/')}/" if path else ""
        names = FileBlob.objects.filter(name__startswith=prefix).values_list(
            "name", flat=True
        )
        dirs, files = set(), []
        for n in names:
            rest = n[len(prefix):]
            if "/" in rest:
                dirs.add(rest.split("/", 1)[0])
            else:
                files.append(rest)
        return sorted(dirs), sorted(files)


@deconstructible
class HybridFileStorage(Storage):
    """New uploads -> Postgres. Pre-existing files -> still read from disk.

    This is the backend Django is actually configured with. It exists
    specifically so shipping this change does not break a single existing
    geo-punch photo, resume, or employee document: their FileField.name
    values point at local paths that were never copied into Postgres, and
    the only way to honor "leave existing files as they are" is to keep
    looking on disk for exactly those, while sending everything new to the
    database.
    """

    def __init__(self):
        self._db = DatabaseFileStorage()
        self._disk = FileSystemStorage()

    def _open(self, name, mode="rb"):
        if self._db.exists(name):
            return self._db._open(name, mode)
        # Falls through to FileSystemStorage, which raises FileNotFoundError
        # itself if neither backend has it -same failure Django would have
        # produced before this change existed.
        return self._disk._open(name, mode)

    def _save(self, name, content):
        # Every new save lands in Postgres, unconditionally -this is the
        # entire point. Disk is never written to again.
        return self._db._save(name, content)

    def get_available_name(self, name, max_length=None):
        # Collision-avoidance must check BOTH backends, or a new upload could
        # silently overwrite an old on-disk file that happens to share a
        # generated name.
        while self.exists(name):
            name = self.get_alternative_name(*self._dup_split(name))
        return name

    @staticmethod
    def _dup_split(name):
        import os

        file_root, file_ext = os.path.splitext(name)
        return file_root, file_ext

    def exists(self, name):
        return self._db.exists(name) or self._disk.exists(name)

    def delete(self, name):
        # Whichever backend actually has it. Both are safe to call
        # unconditionally -deleting a name that isn't there is a no-op on
        # both sides.
        self._db.delete(name)
        try:
            self._disk.delete(name)
        except Exception:
            pass

    def size(self, name):
        if self._db.exists(name):
            return self._db.size(name)
        return self._disk.size(name)

    def listdir(self, path):
        db_dirs, db_files = self._db.listdir(path)
        try:
            disk_dirs, disk_files = self._disk.listdir(path)
        except FileNotFoundError:
            disk_dirs, disk_files = [], []
        return (
            sorted(set(db_dirs) | set(disk_dirs)),
            sorted(set(db_files) | set(disk_files)),
        )
