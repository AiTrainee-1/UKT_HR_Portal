"""GIFs and voice messages in the staff chat (owner 2026-11-25).

    phone -> POST chat/channels/<id>/media (multipart: kind=gif|voice, file, durationMs, waveform, replyToId)
          -> checked here (type, size, length) -> ChatMessage(kind, media, expires_at) -> chat_push (the readers' phones)
    phone -> GET chat/messages/<id>/media (members of the channel only) -> the file, until it expires

Owner decisions:
  * GIFs come from the phone's own gallery: no outside GIF service. Only a real GIF file (GIF87a / GIF89a) of at most
    8 MB is taken.
  * Voice messages are recorded in the app: an .m4a (AAC in an MP4 box, what expo-audio records) or raw AAC (ADTS), at
    most 2 minutes. The length the phone reports is checked against the file itself when the file says how long it is.
  * The Employee Web App records in the browser (2026-11-25): Chrome, Edge and Firefox make WebM / Ogg with Opus inside,
    Safari makes MP4 / AAC (taken as above). WebM and Ogg are taken only when the container's own first bytes say so
    and the sound inside is Opus (no video). Their length is read from the file (WebM: the stated Duration, else the
    last audio block's time; Ogg: the last page's sample position); when the file does not say, the browser's figure is
    used, capped at 2 minutes. The Android app plays WebM / Opus as it is.
  * Both expire: after ChatSettings.media_expiry_days (7 unless HR changes it on the HR chat page, 1-90) the file is
    deleted from the server. sweep_expired() runs every 30 minutes (chat_media_scheduler.py, also
    `manage.py purge_chat_media`) and the download refuses (and deletes) an expired file on access, so nothing is ever
    served late. The message itself stays: the API sends it with `media.expired = true` and no link, and the app shows
    "GIF expired" / "Voice message expired". Anyone who wanted to keep it saved it on their phone while it was there.
  * `text` carries a readable stand-in ("🎤 Voice message" / "🖼️ GIF"), which is what an older app, the HR chat page
    and the phone notification show.
"""

from __future__ import annotations

import json
import logging
import struct
import uuid
from datetime import timedelta

from django.db.models import F
from django.utils import timezone

logger = logging.getLogger(__name__)

KIND_GIF = "gif"
KIND_VOICE = "voice"
MEDIA_KINDS = (KIND_GIF, KIND_VOICE)

GIF_MAX_BYTES = 8 * 1024 * 1024
VOICE_MAX_BYTES = 6 * 1024 * 1024  # two minutes of the app's recording is about 1-2 MB
VOICE_MAX_MS = 120_000
VOICE_GRACE_MS = 3_000  # a phone's timer and the file's own length differ by a moment
VOICE_MIN_MS = 300
WAVEFORM_MAX_BARS = 64

VOICE_TEXT = "🎤 Voice message"
GIF_TEXT = "🖼️ GIF"

GIF_MIME = "image/gif"
M4A_MIME = "audio/mp4"
AAC_MIME = "audio/aac"
THREEGP_MIME = "audio/3gpp"
# browser recordings (the Employee Web App, 2026-11-25): Opus in a WebM or an Ogg box
WEBM_MIME = "audio/webm"
OGG_MIME = "audio/ogg"

WEBM_MAGIC = b"\x1a\x45\xdf\xa3"  # EBML
OGG_MAGIC = b"OggS"


class MediaError(ValueError):
    """An upload the server will not take: `code` for the app, the message in plain words for the employee."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ── what a file is ───────────────────────────────────────────────────────────────────────────────────────────────────


def is_gif(data: bytes) -> bool:
    return data[:6] in (b"GIF87a", b"GIF89a")


def gif_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) from a GIF's logical screen descriptor."""
    if not is_gif(data) or len(data) < 10:
        return None
    w = int.from_bytes(data[6:8], "little")
    h = int.from_bytes(data[8:10], "little")
    return (w, h) if w and h else None


def audio_mime(data: bytes) -> str | None:
    """audio/mp4 (an .m4a), audio/3gpp, audio/aac (ADTS), audio/webm or audio/ogg (both with Opus inside) from the first
    bytes; None for anything else."""
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand.startswith(b"3g"):
            return THREEGP_MIME
        return M4A_MIME
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xF6) == 0xF0:
        return AAC_MIME
    if data[:4] == WEBM_MAGIC:
        return WEBM_MIME if is_webm_opus(data) else None
    if data[:4] == OGG_MAGIC:
        return OGG_MIME if is_ogg_opus(data) else None
    return None


# ── WebM (EBML) ──────────────────────────────────────────────────────────────────────────────────────────────────────

_EBML_DOCTYPE = 0x4282
_WEBM_SEGMENT = 0x18538067
_WEBM_INFO = 0x1549A966
_WEBM_TRACKS = 0x1654AE6B
_WEBM_TRACK_ENTRY = 0xAE
_WEBM_CODEC_ID = 0x86
_WEBM_TIMECODE_SCALE = 0x2AD7B1
_WEBM_DURATION = 0x4489
_WEBM_CLUSTER = 0x1F43B675
_WEBM_CLUSTER_TIMECODE = 0xE7
_WEBM_SIMPLE_BLOCK = 0xA3
_WEBM_BLOCK_GROUP = 0xA0
_WEBM_BLOCK = 0xA1
# Elements whose children are read. A browser writes the Segment and each Cluster with an "unknown" size while it is
# still recording, so the file is walked element by element instead of skipping whole boxes.
_WEBM_MASTERS = {_WEBM_SEGMENT, _WEBM_INFO, _WEBM_TRACKS, _WEBM_TRACK_ENTRY, _WEBM_CLUSTER, _WEBM_BLOCK_GROUP}
_WEBM_HEAD_BYTES = 64 * 1024


def _ebml_id(data: bytes, i: int) -> tuple[int, int] | None:
    """(element id with its length marker, how many bytes) at i; None when it is not an id."""
    if i >= len(data):
        return None
    first = data[i]
    for n in range(1, 5):
        if first & (0x80 >> (n - 1)):
            if i + n > len(data):
                return None
            return int.from_bytes(data[i : i + n], "big"), n
    return None


def _ebml_size(data: bytes, i: int) -> tuple[int, int, bool] | None:
    """(size, how many bytes, size unknown) at i; None when it is not a size."""
    if i >= len(data):
        return None
    first = data[i]
    for n in range(1, 9):
        mask = 0x80 >> (n - 1)
        if first & mask:
            if i + n > len(data):
                return None
            value = first & (mask - 1)
            for k in range(1, n):
                value = (value << 8) | data[i + k]
            return value, n, value == (1 << (7 * n)) - 1
    return None


def _webm_elements(data: bytes, limit: int | None = None):
    """(id, body start, body end) of every element of a WebM file in order, going into the containers listed in
    _WEBM_MASTERS. A body cut short by the end of the data ends at the end of the data."""
    end = len(data) if limit is None else min(len(data), limit)
    i = 0
    while i < end:
        got = _ebml_id(data, i)
        if got is None:
            return
        eid, n = got
        sized = _ebml_size(data, i + n)
        if sized is None:
            return
        size, m, unknown = sized
        body = i + n + m
        if eid in _WEBM_MASTERS:
            yield eid, body, (end if unknown else min(body + size, end))
            i = body  # its children follow
            continue
        if unknown:
            return  # only a container may have an unknown size
        stop = body + size
        yield eid, body, min(stop, end)
        i = stop


def _webm_doctype(data: bytes) -> str | None:
    """The doc type the EBML header names ("webm", "matroska"); None when there is no readable header."""
    head = _ebml_size(data, 4)
    if data[:4] != WEBM_MAGIC or head is None:
        return None
    size, m, _ = head
    i, end = 4 + m, min(4 + m + size, len(data))
    while i < end:
        got = _ebml_id(data, i)
        sized = _ebml_size(data, i + got[1]) if got else None
        if not got or not sized:
            return None
        body = i + got[1] + sized[1]
        if got[0] == _EBML_DOCTYPE:
            return data[body : body + sized[0]].rstrip(b"\x00").decode("ascii", "replace")
        i = body + sized[0]
    return None


def is_webm_opus(data: bytes) -> bool:
    """A WebM file (doc type "webm") whose tracks are all Opus sound (a browser's voice recording: no video)."""
    try:
        if _webm_doctype(data) != "webm":
            return False
        codecs = [
            data[s:e].rstrip(b"\x00") for eid, s, e in _webm_elements(data, _WEBM_HEAD_BYTES) if eid == _WEBM_CODEC_ID
        ]
    except Exception:
        return False
    return bool(codecs) and all(c == b"A_OPUS" for c in codecs)


def webm_duration_ms(data: bytes) -> int | None:
    """The length of a WebM recording in milliseconds: its stated Duration, else the time of its last audio block (a
    browser that is still recording writes no Duration); None when the file says neither."""
    try:
        scale = 1_000_000  # nanoseconds per timecode unit, the WebM default
        stated = None
        cluster_time = 0
        last = None
        for eid, s, e in _webm_elements(data):
            if eid == _WEBM_TIMECODE_SCALE and e > s:
                scale = int.from_bytes(data[s:e], "big") or scale
            elif eid == _WEBM_DURATION and e - s in (4, 8):
                stated = struct.unpack(">f" if e - s == 4 else ">d", data[s:e])[0]
            elif eid == _WEBM_CLUSTER_TIMECODE and e > s:
                cluster_time = int.from_bytes(data[s:e], "big")
            elif eid in (_WEBM_SIMPLE_BLOCK, _WEBM_BLOCK):
                track = _ebml_size(data, s)
                if track is None or s + track[1] + 2 > len(data):
                    continue
                k = s + track[1]
                at = cluster_time + int.from_bytes(data[k : k + 2], "big", signed=True)
                last = at if last is None else max(last, at)
        if stated is not None and stated == stated and stated > 0:
            return round(stated * scale / 1_000_000)
        if last is not None and last > 0:
            return round(last * scale / 1_000_000)
    except Exception:  # a damaged file: the browser's own figure is used
        return None
    return None


# ── Ogg ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

OPUS_RATE = 48_000  # an Ogg Opus file counts its sound in 48 kHz samples, whatever it was recorded at


def _ogg_first_packet(data: bytes) -> bytes | None:
    if data[:4] != OGG_MAGIC or len(data) < 27:
        return None
    segments = data[26]
    start = 27 + segments
    if start > len(data):
        return None
    length = sum(data[27:start])
    return data[start : start + length]


def is_ogg_opus(data: bytes) -> bool:
    """An Ogg file whose first packet is an Opus header (a browser's voice recording)."""
    packet = _ogg_first_packet(data)
    return bool(packet) and packet[:8] == b"OpusHead"


def ogg_opus_duration_ms(data: bytes) -> int | None:
    """The length of an Ogg Opus recording in milliseconds, from the sample position of its last page that ends a
    packet (less the encoder's pre-skip); None when the file does not say."""
    try:
        head = _ogg_first_packet(data)
        if not head or head[:8] != b"OpusHead" or len(head) < 12:
            return None
        pre_skip = int.from_bytes(head[10:12], "little")
        at = len(data)
        for _ in range(64):
            at = data.rfind(OGG_MAGIC, 0, at)
            if at < 0:
                return None
            if at + 14 <= len(data) and data[at + 4] == 0:  # stream structure version 0: a real page header
                granule = int.from_bytes(data[at + 6 : at + 14], "little", signed=True)
                if granule > 0:  # -1: no packet ends on this page
                    samples = granule - pre_skip
                    return round(samples * 1000 / OPUS_RATE) if samples > 0 else None
    except Exception:
        return None
    return None


def _boxes(data: bytes, start: int, end: int):
    """(type, body start, body end) of each MP4 box between start and end."""
    i = start
    while i + 8 <= end:
        size = int.from_bytes(data[i : i + 4], "big")
        kind = data[i + 4 : i + 8]
        header = 8
        if size == 1:
            if i + 16 > end:
                return
            size = int.from_bytes(data[i + 8 : i + 16], "big")
            header = 16
        elif size == 0:
            size = end - i
        if size < header:
            return
        yield kind, i + header, min(i + size, end)
        i += size


def mp4_duration_ms(data: bytes) -> int | None:
    """The length an MP4 / M4A file states for itself (moov -> mvhd), in milliseconds; None when it says nothing."""
    try:
        for kind, s, e in _boxes(data, 0, len(data)):
            if kind != b"moov":
                continue
            for inner, s2, e2 in _boxes(data, s, e):
                if inner != b"mvhd" or e2 - s2 < 20:
                    continue
                version = data[s2]
                if version == 1:
                    if e2 - s2 < 32:
                        return None
                    timescale = int.from_bytes(data[s2 + 20 : s2 + 24], "big")
                    duration = int.from_bytes(data[s2 + 24 : s2 + 32], "big")
                else:
                    timescale = int.from_bytes(data[s2 + 12 : s2 + 16], "big")
                    duration = int.from_bytes(data[s2 + 16 : s2 + 20], "big")
                if not timescale or duration in (0, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
                    return None
                return round(duration * 1000 / timescale)
    except Exception:  # a damaged box: the phone's own figure is used
        return None
    return None


# ── what the phone sent ──────────────────────────────────────────────────────────────────────────────────────────────


def parse_duration_ms(raw) -> int | None:
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value or value < 0:  # NaN / negative
        return None
    return int(round(value))


def parse_waveform(raw) -> list[int] | None:
    """Up to 64 loudness bars 0-100, from a JSON list or "12,40,…"; None when there is nothing usable."""
    if raw in (None, ""):
        return None
    values = raw
    if isinstance(raw, str):
        text = raw.strip()
        try:
            values = json.loads(text) if text.startswith("[") else [v for v in text.split(",") if v.strip()]
        except ValueError:
            return None
    if not isinstance(values, (list, tuple)):
        return None
    bars: list[int] = []
    for v in values[: WAVEFORM_MAX_BARS * 4]:
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n != n:
            continue
        bars.append(max(0, min(100, int(round(n)))))
    if not bars:
        return None
    if len(bars) > WAVEFORM_MAX_BARS:  # squeeze evenly into 64 bars, keeping each group's peak
        step = len(bars) / WAVEFORM_MAX_BARS
        bars = [max(bars[int(i * step) : max(int((i + 1) * step), int(i * step) + 1)]) for i in range(WAVEFORM_MAX_BARS)]
    return bars


def read_upload(kind: str, upload, duration_raw=None, waveform_raw=None) -> dict:
    """Checks one upload and returns what to store: {kind, data, mime, ext, size, durationMs, width, height, waveform,
    text}. Raises MediaError (with words for the employee) for anything the chat does not take."""
    kind = (kind or "").strip().lower()
    if kind not in MEDIA_KINDS:
        raise MediaError("BAD_KIND", "Only a GIF or a voice message can be sent here.")
    if upload is None:
        raise MediaError("NO_FILE", "No file was attached. Please try again.")
    limit = GIF_MAX_BYTES if kind == KIND_GIF else VOICE_MAX_BYTES
    declared = getattr(upload, "size", None)
    if declared is not None and declared > limit:
        raise MediaError(*_too_large(kind))
    data = upload.read(limit + 1)
    if isinstance(data, str):
        data = data.encode()
    if len(data) > limit:
        raise MediaError(*_too_large(kind))
    if not data:
        raise MediaError("EMPTY_FILE", "The file is empty. Please try again.")

    if kind == KIND_GIF:
        if not is_gif(data):
            raise MediaError("NOT_A_GIF", "That picture is not a GIF. Please choose a GIF from your photos.")
        dims = gif_dimensions(data)
        return {
            "kind": KIND_GIF,
            "data": data,
            "mime": GIF_MIME,
            "ext": ".gif",
            "size": len(data),
            "durationMs": None,
            "width": dims[0] if dims else None,
            "height": dims[1] if dims else None,
            "waveform": None,
            "text": GIF_TEXT,
        }

    mime = audio_mime(data)
    if mime is None:
        raise MediaError("NOT_AUDIO", "That recording could not be read. Please record it again.")
    if mime in (M4A_MIME, THREEGP_MIME):
        stated = mp4_duration_ms(data)
    elif mime == WEBM_MIME:
        stated = webm_duration_ms(data)
    elif mime == OGG_MIME:
        stated = ogg_opus_duration_ms(data)
    else:
        stated = None
    duration = stated if stated is not None else parse_duration_ms(duration_raw)
    if stated is None and duration is not None and mime in (WEBM_MIME, OGG_MIME):
        # a browser recording that does not say how long it is: the browser's own figure, never more than 2 minutes
        duration = min(duration, VOICE_MAX_MS)
    if duration is None:
        raise MediaError("NO_DURATION", "The length of the voice message is missing. Please record it again.")
    if duration > VOICE_MAX_MS + VOICE_GRACE_MS:
        raise MediaError("TOO_LONG", "A voice message can be at most 2 minutes long.")
    if duration < VOICE_MIN_MS:
        raise MediaError("TOO_SHORT", "That voice message is too short. Hold the mic a little longer.")
    return {
        "kind": KIND_VOICE,
        "data": data,
        "mime": mime,
        "ext": {M4A_MIME: ".m4a", THREEGP_MIME: ".3gp", AAC_MIME: ".aac", WEBM_MIME: ".webm", OGG_MIME: ".ogg"}[mime],
        "size": len(data),
        "durationMs": min(duration, VOICE_MAX_MS),
        "width": None,
        "height": None,
        "waveform": parse_waveform(waveform_raw),
        "text": VOICE_TEXT,
    }


def _too_large(kind: str) -> tuple[str, str]:
    if kind == KIND_GIF:
        return "TOO_LARGE", "That GIF is larger than 8 MB. Please choose a smaller one."
    return "TOO_LARGE", "That voice message is too large to send."


def file_name(info: dict) -> str:
    return f"{info['kind']}-{uuid.uuid4().hex}{info['ext']}"


def stored_mime(info: dict, stored_name: str) -> str:
    """The type of the file as stored: a one-frame GIF may have been stored as PNG / JPEG by the storage's picture
    compression (db_file_storage), which renames it to match."""
    name = (stored_name or "").lower()
    if info["kind"] == KIND_GIF:
        if name.endswith(".png"):
            return "image/png"
        if name.endswith((".jpg", ".jpeg")):
            return "image/jpeg"
        if name.endswith(".webp"):
            return "image/webp"
    return info["mime"]


# ── expiry ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def expiry_days() -> int:
    from .models import ChatSettings

    return ChatSettings.get().media_expiry_days


def is_media(m) -> bool:
    return (m.kind or "text") in MEDIA_KINDS


def is_expired(m, now=None) -> bool:
    """True once a GIF / voice message can no longer be seen: its file was deleted, or its time is up."""
    if not is_media(m):
        return False
    if m.media_deleted_at is not None or not m.media:
        return True
    now = now or timezone.now()
    return m.expires_at is not None and m.expires_at <= now


def delete_media(m, now=None) -> bool:
    """Deletes one message's file from the server and marks it gone; the message row stays. True when a file went."""
    now = now or timezone.now()
    had_file = bool(m.media)
    if had_file:
        try:
            m.media.delete(save=False)
        except Exception:  # already gone from storage: still marked deleted below
            logger.warning("Chat media %s: the file could not be deleted from storage", m.pk, exc_info=True)
    m.media = ""
    if m.media_deleted_at is None:
        m.media_deleted_at = now
    m.save(update_fields=["media", "media_deleted_at"])
    return had_file


def sweep_expired(now=None, limit: int = 2000) -> dict:
    """Deletes the files of every GIF / voice message whose time is up. Every 30 minutes (chat_media_scheduler.py) and
    straight after HR shortens the period. Returns what it did."""
    from .models import ChatMessage

    now = now or timezone.now()
    due = list(
        ChatMessage.objects.filter(kind__in=MEDIA_KINDS, media_deleted_at__isnull=True, expires_at__lte=now)
        .order_by("expires_at", "id")[:limit]
    )
    deleted = 0
    for m in due:
        try:
            if delete_media(m, now):
                deleted += 1
        except Exception:
            logger.exception("Chat media sweep: message %s", m.pk)
    return {"due": len(due), "deleted": deleted}


def apply_expiry_days(days: int) -> int:
    """HR changed the period: every GIF / voice message still on the server now expires `days` after it was sent
    (a shorter period removes older ones at the next sweep, a longer one keeps the rest longer). Returns how many."""
    from .models import ChatMessage

    return ChatMessage.objects.filter(kind__in=MEDIA_KINDS, media_deleted_at__isnull=True).update(
        expires_at=F("created_at") + timedelta(days=days)
    )


# ── what the API says about it ───────────────────────────────────────────────────────────────────────────────────────


def media_url(message_id: int) -> str:
    return f"/api/chat/messages/{message_id}/media"


def media_json(m, now=None) -> dict | None:
    """The `media` block of a message: null for a text message. An expired one keeps its kind, length and size (so the
    app can say "Voice message expired") but has no link."""
    if not is_media(m):
        return None
    expired = is_expired(m, now)
    return {
        "url": None if expired else media_url(m.pk),
        "mime": m.media_mime or None,
        "size": m.media_size,
        "durationMs": m.media_duration_ms,
        "width": m.media_width,
        "height": m.media_height,
        "waveform": m.media_waveform if isinstance(m.media_waveform, list) else None,
        "expiresAt": m.expires_at.isoformat() if m.expires_at else None,
        "expired": expired,
    }


def preview_text(m) -> str:
    """How a message reads in a one-line preview (a reply's quote, a phone notification)."""
    kind = getattr(m, "kind", "text") or "text"
    if kind == KIND_VOICE:
        return VOICE_TEXT
    if kind == KIND_GIF:
        return GIF_TEXT
    return m.text or ""
