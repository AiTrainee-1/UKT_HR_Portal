"""Image compression for every picture the HRMS stores.

The owner's rule: pictures are kept for identification, not for their quality, so every uploaded image is made small
before it reaches the database, and the small copy is the only one kept (and so the one every page and app shows).

Two kinds of storage go through here:

  * Files (FileField -> HybridFileStorage -> FileBlob rows): On-Duty punch selfies, employee documents (Aadhaar / PAN /
    passbook photographed or scanned), and anything uploaded through a FileField in the future. db_file_storage.py calls
    `compress_upload()` on every save, so no view has to remember to.
  * Text columns holding a base64 `data:` URL: the employee photo, the company logo, the signatures. Each view that
    writes one of those calls `compress_data_url()` on the value first.

The rules, the same everywhere:

  * An image is recognised by its bytes, never by its file name or the type the client claimed.
  * EXIF orientation is applied (a phone photo taken sideways is stored upright), and the EXIF block is dropped (it
    can carry the GPS position and the phone model; nothing reads it).
  * The long side is cut down to the profile's limit, then the picture is encoded as JPEG - except a logo or signature
    with real transparency, which stays PNG so it still sits cleanly on the coloured headers of payslips and letters.
  * Nothing ever gets bigger: when the new bytes are not clearly smaller (MIN_SAVING) the original bytes are kept as
    they came. That also makes compressing twice a no-op, so the clean-up command can be re-run safely.
  * Nothing that was accepted before is refused now: a PDF, a Word file, a damaged or unknown image is stored exactly as
    before (an image Pillow cannot read is logged).
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Profile:
    """How hard one kind of picture is compressed."""

    name: str
    #: the longest side, in pixels, after compression (a smaller picture is never enlarged)
    max_side: int
    #: JPEG quality, 1-95
    quality: int
    #: True: a picture with real transparency stays a PNG (logos, signatures); False: it is put on white and made JPEG
    keep_transparency: bool


#: A face: employee photos, On-Duty selfies, photos taken at the biometric terminal. 800 px is more than an ID card
#: (240 x 320 px photo box) or any screen in the apps shows, and a face stays clearly recognisable at quality 70.
PHOTO = Profile("photo", 800, 70, False)
#: A photographed or scanned document (Aadhaar, PAN, passbook, certificates): bigger and a little better, so the small
#: print (numbers, names, dates) stays readable.
DOCUMENT = Profile("document", 1600, 75, False)
#: Company logo and the signatures printed on payslips and letters. 600 px matches what the PDF builders already shrink
#: them to (document_pdf._decode_b64_image), so printed documents look exactly as before.
LOGO = Profile("logo", 600, 85, True)

PROFILES = {p.name: p for p in (PHOTO, DOCUMENT, LOGO)}

#: A re-encode has to save at least this share of the bytes to be kept (unless the picture had to be shrunk or turned
#: upright). Below that the original stays: re-encoding an already-small JPEG only costs quality.
MIN_SAVING = 0.10
#: A picture bigger than this (in pixels) is not decoded at all - stored as it came. Guards against "decompression
#: bomb" files; 60 MP is well above any phone camera.
MAX_PIXELS = 60_000_000

#: The FileField folders (upload_to) and the profile their images get; anything else is treated as a document so text
#: in it stays readable.
STORAGE_PROFILES = (("on_duty_punch_verifications/", PHOTO),)

JPEG = "image/jpeg"
PNG = "image/png"

_EXTENSIONS = {
    JPEG: (".jpg", ".jpeg", ".jpe", ".jfif"),
    PNG: (".png",),
    "image/webp": (".webp",),
    "image/gif": (".gif",),
    "image/bmp": (".bmp",),
    "image/tiff": (".tif", ".tiff"),
}
IMAGE_EXTENSIONS = tuple(ext for exts in _EXTENSIONS.values() for ext in exts)


@dataclass(frozen=True)
class Result:
    """What compress_bytes did. `data` is what to store: the new bytes, or the original ones when `changed` is False."""

    data: bytes
    #: the image type of `data` ("image/jpeg"), or None when it is not an image
    mime: str | None
    changed: bool
    #: compressed | not-an-image | unreadable | animated | too-large | no-saving
    reason: str


def sniff(data: bytes) -> str | None:
    """The image type of `data` from its first bytes, or None when it is not a picture this module handles."""
    if not data:
        return None
    if data[:3] == b"\xff\xd8\xff":
        return JPEG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return PNG
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:2] == b"BM":
        return "image/bmp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    return None


def profile_named(profile: Profile | str) -> Profile:
    return profile if isinstance(profile, Profile) else PROFILES[profile]


def profile_for_name(name: str) -> Profile:
    """The profile for a stored file, from the folder its FileField puts it in."""
    path = (name or "").replace("\\", "/").lower()
    for prefix, profile in STORAGE_PROFILES:
        if path.startswith(prefix):
            return profile
    return DOCUMENT


def _has_transparency(img) -> bool:
    if img.mode not in ("RGBA", "LA", "PA") and "transparency" not in img.info:
        return False
    alpha = img.convert("RGBA").getchannel("A")
    return alpha.getextrema()[0] < 255


def _on_white(img):
    """The picture as plain RGB, any transparent part painted white (what a viewer shows behind it)."""
    from PIL import Image

    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.getchannel("A"))
        return canvas
    if img.mode in ("L", "1"):
        return img.convert("L")  # a black-and-white scan stays one channel: a third of the size of the same in colour
    return img.convert("RGB")


def _jpeg(img, quality: int, icc: bytes | None) -> bytes:
    out = io.BytesIO()
    extra = {"icc_profile": icc} if icc else {}
    img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True, **extra)
    return out.getvalue()


def _png(img) -> bytes:
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def compress_bytes(data: bytes, profile: Profile | str = PHOTO) -> Result:
    """Compress one picture by `profile`. Never raises; anything it cannot or should not change comes back as it was."""
    profile = profile_named(profile)
    data = bytes(data or b"")
    mime = sniff(data)
    if mime is None:
        return Result(data, None, False, "not-an-image")
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as source:
            if getattr(source, "n_frames", 1) > 1:
                return Result(data, mime, False, "animated")
            if source.width * source.height > MAX_PIXELS:
                logger.warning("image_compress: %sx%s picture left as it is (too many pixels)", *source.size)
                return Result(data, mime, False, "too-large")
            full_size = source.size
            if source.format == "JPEG" and max(full_size) > profile.max_side:
                # Decode a big JPEG straight at 1/2, 1/4 or 1/8 scale (never below the limit on either side): a 12 MP
                # phone photo then costs a fraction of the CPU and memory, on a server with few web workers.
                source.draft(None, (profile.max_side, profile.max_side))
            source.load()
            resized = source.size != full_size
            # the colour profile is kept (phones shoot in Display P3), but only an RGB one: a CMYK profile would be
            # wrong on the RGB JPEG written here
            icc = source.info.get("icc_profile") if source.mode in ("RGB", "RGBA") else None
            img = ImageOps.exif_transpose(source)
            turned = img.size != source.size or _orientation(source) not in (None, 1)
            transparent = _has_transparency(img)
            if max(img.size) > profile.max_side:
                resized = True
                if img.mode == "1":
                    img = img.convert("L")
                elif img.mode not in ("RGB", "RGBA", "L", "LA"):
                    img = img.convert("RGBA" if transparent else "RGB")
                img.thumbnail((profile.max_side, profile.max_side), Image.LANCZOS)

            if transparent and profile.keep_transparency:
                out, out_mime = _png(img.convert("RGBA")), PNG
            else:
                flat = _on_white(img)
                out, out_mime = _jpeg(flat, profile.quality, icc), JPEG
                if profile.keep_transparency:
                    # a flat logo (few colours, sharp edges) is often smaller - and always crisper - as a PNG
                    as_png = _png(flat)
                    if len(as_png) <= len(out):
                        out, out_mime = as_png, PNG
    except Exception as exc:  # a damaged or exotic file: kept exactly as it came
        logger.warning("image_compress: could not read a %s (%s bytes), kept as it is: %s", mime, len(data), exc)
        return Result(data, mime, False, "unreadable")

    must_change = resized or turned
    worth_it = len(out) <= len(data) * (1 - MIN_SAVING)
    if len(out) >= len(data) or not (must_change or worth_it):
        return Result(data, mime, False, "no-saving")
    return Result(out, out_mime, True, "compressed")


def _orientation(img) -> int | None:
    try:
        return img.getexif().get(0x0112)
    except Exception:
        return None


# ── data: URLs (pictures kept as text in a column) ─────────────────────────────────────────────────────────────────


def split_data_url(value) -> tuple[str, bytes] | None:
    """(declared type, bytes) of a base64 `data:` URL, or None when `value` is anything else."""
    if not isinstance(value, str) or not value.startswith("data:"):
        return None
    head, sep, payload = value.partition(",")
    if not sep or ";base64" not in head.lower():
        return None
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None
    return head[5:].split(";", 1)[0].lower(), raw


def compress_data_url(value, profile: Profile | str = PHOTO):
    """A base64 image `data:` URL compressed by `profile`, as a `data:` URL with the right type.

    Anything else - None, "", an https link, the /api/employees/<id>/photo link, a damaged value - comes back untouched,
    so a view can pass whatever the client sent straight through this."""
    parts = split_data_url(value)
    if parts is None:
        return value
    result = compress_bytes(parts[1], profile)
    if not result.changed:
        return value
    return f"data:{result.mime};base64,{base64.b64encode(result.data).decode('ascii')}"


# ── stored files ───────────────────────────────────────────────────────────────────────────────────────────────────


def with_extension(name: str, mime: str | None) -> str:
    """`name` with the extension that matches `mime` ("x.png" + image/jpeg -> "x.jpg"); unchanged when it already
    matches, or when `mime` is not an image type this module writes."""
    exts = _EXTENSIONS.get(mime or "")
    if not exts:
        return name
    root, ext = os.path.splitext(name)
    if ext.lower() in exts:
        return name
    return root + exts[0]


def matching_filename(original: str, stored_name: str) -> str:
    """The name to show / download a stored file under: the name it was uploaded with, its extension swapped for the
    stored one when compression changed the picture's type (uploaded "aadhaar.png", stored as JPEG -> "aadhaar.jpg")."""
    if not original or not stored_name:
        return original
    stored_ext = os.path.splitext(stored_name)[1].lower()
    original_ext = os.path.splitext(original)[1].lower()
    if stored_ext == original_ext or stored_ext not in IMAGE_EXTENSIONS or original_ext not in IMAGE_EXTENSIONS:
        return original
    for exts in _EXTENSIONS.values():
        if stored_ext in exts and original_ext in exts:
            return original  # .jpeg vs .jpg: the same type
    return os.path.splitext(original)[0] + stored_ext


def compress_upload(name: str, content):
    """(name, content) to hand on to the storage backend: the compressed picture under a name with the matching
    extension, or exactly what came in when it is not an image or does not get smaller."""
    from django.core.files.base import ContentFile

    if name is None:
        name = getattr(content, "name", None)
    try:
        if hasattr(content, "seek"):
            content.seek(0)
        data = content.read()
    except Exception:  # an unreadable stream: let the storage backend deal with it exactly as before
        return name, content
    if isinstance(data, str):
        data = data.encode()
    result = compress_bytes(data, profile_for_name(name or ""))
    if not result.changed:
        try:
            content.seek(0)
            return name, content
        except Exception:
            return name, ContentFile(data, name=os.path.basename(name or ""))
    new_name = with_extension(name, result.mime)
    new_content = ContentFile(result.data, name=os.path.basename(new_name))
    new_content.content_type = result.mime
    return new_name, new_content
