"""
Chat GIFs, voice messages, their expiry, HR's expiry setting and who-reacted (owner 2026-11-25).

Run via: DB_NAME=<yours> python manage.py test api.tests_chat_media --noinput
"""

import io
import json
from datetime import timedelta
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from . import chat_media
from .jwt_utils import sign_token
from .models import (
    Branch,
    ChatChannel,
    ChatMessage,
    ChatReaction,
    ChatSettings,
    Department,
    Employee,
    FileBlob,
    HRUser,
    Notification,
    PushToken,
)


def animated_gif(frames: int = 2, size=(4, 3)) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    images = [Image.new("P", size, color=i) for i in range(frames)]
    images[0].save(out, format="GIF", save_all=True, append_images=images[1:], duration=100, loop=0)
    return out.getvalue()


def png_bytes() -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (3, 3), (200, 10, 10)).save(out, format="PNG")
    return out.getvalue()


def box(kind: bytes, body: bytes) -> bytes:
    return (8 + len(body)).to_bytes(4, "big") + kind + body


def m4a(duration_ms: int, timescale: int = 44100, version: int = 0) -> bytes:
    """A tiny but well-formed M4A header: ftyp + moov/mvhd stating its length, then some 'audio'."""
    ftyp = box(b"ftyp", b"M4A " + b"\x00\x00\x02\x00" + b"M4A isom")
    units = duration_ms * timescale // 1000
    if version == 1:
        mvhd = b"\x01\x00\x00\x00" + b"\x00" * 16 + timescale.to_bytes(4, "big") + units.to_bytes(8, "big") + b"\x00" * 80
    else:
        mvhd = b"\x00\x00\x00\x00" + b"\x00" * 8 + timescale.to_bytes(4, "big") + units.to_bytes(4, "big") + b"\x00" * 80
    return ftyp + box(b"mdat", b"\x21" * 400) + box(b"moov", box(b"mvhd", mvhd))


ADTS = bytes([0xFF, 0xF1, 0x50, 0x80, 0x02, 0x1F, 0xFC]) + b"\x00" * 200


def bearer(payload: dict) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {sign_token(payload)}"}


class ChatMediaBase(TestCase):
    def setUp(self):
        self.b1 = Branch.objects.create(name="Media HO", code="MED-HO")
        self.b2 = Branch.objects.create(name="Media South", code="MED-S")
        self.cutting = Department.objects.create(name="Cutting", branch=self.b1)
        self.packing = Department.objects.create(name="Packing", branch=self.b1)

        def emp(code, branch, dept=None, first="Emp"):
            return Employee.objects.create(
                employee_code=code, first_name=first, last_name=code, status="active", employment_type="staff",
                join_date="2020-01-01", branch=branch, department=dept,
            )

        self.ravi = emp("RAVI", self.b1, self.cutting, first="Ravi")
        self.meena = emp("MEENA", self.b1, self.cutting, first="Meena")
        self.packer = emp("PACK", self.b1, self.packing, first="Pack")
        self.south = emp("SOUTH", self.b2, first="South")
        self.admin = HRUser.objects.create(username="media_admin", password_hash="x", is_super_admin=True)
        self.client = APIClient()
        self.company = ChatChannel.get_company_channel(self.b1.pk)
        self.dept = ChatChannel.get_department_channel(self.cutting)

    def as_emp(self, e):
        return bearer({"role": "employee", "employeeId": e.pk})

    def as_hr(self):
        return bearer({"role": "hr", "hrUserId": self.admin.pk, "name": "Meena HR"})

    def upload(self, channel, kind, data, who=None, name="file.bin", mime="application/octet-stream", **fields):
        body = {"kind": kind, "file": SimpleUploadedFile(name, data, content_type=mime), **fields}
        return self.client.post(f"/api/chat/channels/{channel.pk}/media", body, format="multipart",
                                **self.as_emp(who or self.ravi))

    def send_gif(self, channel=None, who=None):
        res = self.upload(channel or self.company, "gif", animated_gif(), who=who, name="fun.gif", mime="image/gif")
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def send_voice(self, channel=None, who=None, duration_ms=12_000, **fields):
        res = self.upload(channel or self.company, "voice", m4a(duration_ms), who=who, name="voice.m4a",
                          mime="audio/m4a", **fields)
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def messages(self, channel=None, who=None):
        res = self.client.get(f"/api/chat/channels/{(channel or self.company).pk}/messages", **self.as_emp(who or self.ravi))
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def download(self, message_id, auth):
        return self.client.get(f"/api/chat/messages/{message_id}/media", **auth)


class UploadTests(ChatMediaBase):
    def test_a_gif_is_stored_served_and_listed(self):
        before = timezone.now()
        body = self.send_gif()
        self.assertEqual((body["kind"], body["text"]), ("gif", chat_media.GIF_TEXT))
        media = body["media"]
        self.assertEqual(media["url"], f"/api/chat/messages/{body['id']}/media")
        self.assertEqual((media["mime"], media["width"], media["height"], media["expired"]), ("image/gif", 4, 3, False))
        expires = timezone.datetime.fromisoformat(media["expiresAt"])
        self.assertAlmostEqual((expires - before).total_seconds(), 7 * 86400, delta=60)

        res = self.download(body["id"], self.as_emp(self.meena))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Content-Type"], "image/gif")
        self.assertIn("no-store", res["Cache-Control"])
        self.assertEqual(b"".join(res.streaming_content), animated_gif())  # untouched: still animated

        listed = self.messages(who=self.meena)
        self.assertEqual([m["kind"] for m in listed], ["gif"])
        self.assertEqual(listed[0]["media"]["url"], media["url"])

    def test_a_voice_message_keeps_the_files_own_length_and_its_waveform(self):
        body = self.send_voice(duration_ms=12_000, durationMs="99000", waveform=json.dumps(list(range(0, 200, 2))))
        media = body["media"]
        self.assertEqual((body["kind"], body["text"]), ("voice", chat_media.VOICE_TEXT))
        self.assertEqual((media["mime"], media["durationMs"]), ("audio/mp4", 12_000))
        self.assertEqual(len(media["waveform"]), 64)
        self.assertTrue(all(0 <= v <= 100 for v in media["waveform"]))
        res = self.download(body["id"], self.as_emp(self.meena))
        self.assertEqual((res.status_code, res["Content-Type"]), (200, "audio/mp4"))

    def test_raw_aac_uses_the_phones_length(self):
        res = self.upload(self.company, "voice", ADTS, name="v.aac", mime="audio/aac", durationMs="5400",
                          waveform="10,20,30")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual((res.json()["media"]["mime"], res.json()["media"]["durationMs"]), ("audio/aac", 5400))
        self.assertEqual(res.json()["media"]["waveform"], [10, 20, 30])

    def test_what_the_chat_refuses(self):
        cases = [
            (("gif", png_bytes(), "x.gif", "image/gif"), {}, "NOT_A_GIF"),
            (("gif", b"GIF89a" + b"\x00" * (chat_media.GIF_MAX_BYTES), "x.gif", "image/gif"), {}, "TOO_LARGE"),
            (("voice", m4a(125_000), "v.m4a", "audio/m4a"), {}, "TOO_LONG"),
            (("voice", m4a(100), "v.m4a", "audio/m4a"), {}, "TOO_SHORT"),
            (("voice", b"not audio at all" * 10, "v.m4a", "audio/m4a"), {"durationMs": "4000"}, "NOT_AUDIO"),
            (("voice", ADTS, "v.aac", "audio/aac"), {}, "NO_DURATION"),
            (("voice", ADTS, "v.aac", "audio/aac"), {"durationMs": "180000"}, "TOO_LONG"),
            (("video", ADTS, "v.mp4", "video/mp4"), {}, "BAD_KIND"),
            (("gif", b"", "x.gif", "image/gif"), {}, "EMPTY_FILE"),
        ]
        for (kind, data, name, mime), extra, code in cases:
            res = self.upload(self.company, kind, data, name=name, mime=mime, **extra)
            self.assertEqual(res.status_code, 400, (code, res.content))
            self.assertEqual(res.json()["code"], code)
            self.assertTrue(res.json()["error"])
        res = self.client.post(f"/api/chat/channels/{self.company.pk}/media", {"kind": "gif"}, format="multipart",
                               **self.as_emp(self.ravi))
        self.assertEqual(res.json()["code"], "NO_FILE")
        self.assertFalse(ChatMessage.objects.exists())
        self.assertFalse(FileBlob.objects.filter(name__startswith="chat_media/").exists())

    def test_the_mp4_length_reader(self):
        self.assertEqual(chat_media.mp4_duration_ms(m4a(61_500)), 61_500)
        self.assertEqual(chat_media.mp4_duration_ms(m4a(7_000, timescale=1000, version=1)), 7_000)
        self.assertIsNone(chat_media.mp4_duration_ms(b"\x00\x00\x00\x08ftyp"))
        self.assertIsNone(chat_media.mp4_duration_ms(b"garbage"))

    def test_a_reply_to_a_voice_message_quotes_it_readably(self):
        voice = self.send_voice()
        res = self.client.post(f"/api/chat/channels/{self.company.pk}/messages",
                               {"text": "Got it", "replyToId": voice["id"]}, format="json", **self.as_emp(self.meena))
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["replyTo"]["text"], chat_media.VOICE_TEXT)
        self.assertEqual(res.json()["replyTo"]["kind"], "voice")
        self.assertEqual((res.json()["kind"], res.json()["media"]), ("text", None))  # older apps: nothing new to read

        gif = self.upload(self.company, "gif", animated_gif(), who=self.meena, name="g.gif", mime="image/gif",
                          replyToId=str(voice["id"]))
        self.assertEqual(gif.json()["replyTo"]["id"], voice["id"])

    def test_the_phone_notification_says_voice_message(self):
        PushToken.objects.create(employee=self.meena, token="ExponentPushToken[meena]")
        with mock.patch("api.signals.requests.post") as post:
            post.return_value = mock.Mock(ok=True, status_code=200, json=lambda: {"data": [{"status": "ok", "id": "t"}]})
            self.send_voice()
        note = Notification.objects.get(employee=self.meena, type="chat")
        self.assertEqual(note.message, chat_media.VOICE_TEXT)
        self.assertFalse(Notification.objects.filter(employee=self.ravi).exists())

    def test_the_channel_list_says_how_long_media_stays(self):
        res = self.client.get("/api/chat/channels", **self.as_emp(self.ravi))
        self.assertEqual({c["mediaExpiryDays"] for c in res.json()}, {7})


class AccessTests(ChatMediaBase):
    def test_only_members_of_the_channel_upload_and_download(self):
        dept_voice = self.send_voice(channel=self.dept)
        # another department of the same branch
        self.assertEqual(self.upload(self.dept, "gif", animated_gif(), who=self.packer, mime="image/gif").status_code, 403)
        self.assertEqual(self.download(dept_voice["id"], self.as_emp(self.packer)).status_code, 403)
        # another branch
        self.assertEqual(self.download(dept_voice["id"], self.as_emp(self.south)).status_code, 404)
        self.assertEqual(self.upload(self.company, "gif", animated_gif(), who=self.south, mime="image/gif").status_code, 404)
        # HR: no department channels; the company channel's files they may see
        self.assertIn(self.download(dept_voice["id"], self.as_hr()).status_code, (403, 404))
        company_gif = self.send_gif()
        self.assertEqual(self.download(company_gif["id"], self.as_hr()).status_code, 200)
        res = self.client.post(f"/api/chat/channels/{self.company.pk}/media",
                               {"kind": "gif", "file": SimpleUploadedFile("g.gif", animated_gif())},
                               format="multipart", **self.as_hr())
        self.assertEqual(res.status_code, 403)
        # no login at all
        self.assertEqual(self.client.get(f"/api/chat/messages/{company_gif['id']}/media").status_code, 401)
        # a text message has no file
        text = ChatMessage.objects.create(channel=self.company, sender=self.ravi, text="hello")
        self.assertEqual(self.download(text.pk, self.as_emp(self.meena)).status_code, 404)


class ExpiryTests(ChatMediaBase):
    def test_an_expired_file_is_refused_deleted_and_reported_without_a_link(self):
        body = self.send_gif()
        msg = ChatMessage.objects.get(pk=body["id"])
        name = msg.media.name
        self.assertTrue(FileBlob.objects.filter(name=name).exists())
        ChatMessage.objects.filter(pk=msg.pk).update(expires_at=timezone.now() - timedelta(minutes=1))

        listed = self.messages()[0]
        self.assertEqual((listed["media"]["expired"], listed["media"]["url"]), (True, None))
        self.assertEqual(listed["text"], chat_media.GIF_TEXT)

        res = self.download(msg.pk, self.as_emp(self.meena))
        self.assertEqual(res.status_code, 410)
        self.assertEqual(res.json()["code"], "MEDIA_EXPIRED")
        msg.refresh_from_db()
        self.assertIsNotNone(msg.media_deleted_at)
        self.assertEqual(msg.media.name, "")
        self.assertFalse(FileBlob.objects.filter(name=name).exists())  # lazy enforcement: gone on first access

    def test_the_sweep_deletes_only_what_is_due(self):
        old = self.send_voice()
        fresh = self.send_gif()
        ChatMessage.objects.filter(pk=old["id"]).update(expires_at=timezone.now() - timedelta(hours=1))
        done = chat_media.sweep_expired()
        self.assertEqual(done, {"due": 1, "deleted": 1})
        self.assertIsNotNone(ChatMessage.objects.get(pk=old["id"]).media_deleted_at)
        self.assertIsNone(ChatMessage.objects.get(pk=fresh["id"]).media_deleted_at)
        self.assertEqual(chat_media.sweep_expired(), {"due": 0, "deleted": 0})  # nothing twice
        call_command("purge_chat_media", stdout=io.StringIO())
        self.assertEqual(self.download(fresh["id"], self.as_emp(self.meena)).status_code, 200)


class SettingsTests(ChatMediaBase):
    def put(self, value, auth=None):
        return self.client.put("/api/chat/settings", {"mediaExpiryDays": value}, format="json", **(auth or self.as_hr()))

    def test_hr_reads_and_changes_the_period(self):
        res = self.client.get("/api/chat/settings", **self.as_hr())
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.json()["mediaExpiryDays"], res.json()["minDays"], res.json()["maxDays"]), (7, 1, 90))

        voice = self.send_voice()
        res = self.put(30)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["mediaExpiryDays"], res.json()["updatedBy"]), (30, "Meena HR"))
        msg = ChatMessage.objects.get(pk=voice["id"])
        self.assertAlmostEqual((msg.expires_at - msg.created_at).total_seconds(), 30 * 86400, delta=1)
        # new uploads follow it too
        gif = self.send_gif()
        self.assertAlmostEqual(
            (timezone.datetime.fromisoformat(gif["media"]["expiresAt"]) - timezone.now()).total_seconds(),
            30 * 86400, delta=60,
        )

    def test_shortening_it_removes_what_is_now_past_it(self):
        voice = self.send_voice()
        ChatMessage.objects.filter(pk=voice["id"]).update(created_at=timezone.now() - timedelta(days=3))
        self.assertEqual(self.put(2).status_code, 200)
        msg = ChatMessage.objects.get(pk=voice["id"])
        self.assertIsNotNone(msg.media_deleted_at)
        self.assertTrue(self.messages()[0]["media"]["expired"])

    def test_validation_and_who_may(self):
        for bad in (0, 91, "abc", 2.5, True, None, ""):
            res = self.put(bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn("1 to 90", res.json()["error"])
        self.assertEqual(ChatSettings.get().media_expiry_days, 7)
        self.assertEqual(self.put("14").json()["mediaExpiryDays"], 14)  # a number sent as text is fine
        self.assertEqual(self.client.get("/api/chat/settings", **self.as_emp(self.ravi)).status_code, 403)
        self.assertEqual(self.put(5, auth=self.as_emp(self.ravi)).status_code, 403)
        self.assertEqual(self.client.get("/api/chat/settings").status_code, 401)


class ReactionNamesTests(ChatMediaBase):
    def test_each_reaction_says_who_reacted(self):
        msg = ChatMessage.objects.create(channel=self.company, sender=self.packer, text="Team lunch on Friday")
        for who, emoji in ((self.ravi, "👍"), (self.meena, "👍"), (self.meena, "❤️")):
            res = self.client.post(f"/api/chat/messages/{msg.pk}/reactions", {"emoji": emoji}, format="json",
                                   **self.as_emp(who))
            self.assertEqual(res.status_code, 200, res.content)

        body = self.messages(who=self.meena)[0]
        thumbs, heart = body["reactions"]
        self.assertEqual((thumbs["emoji"], thumbs["count"], thumbs["reactedByMe"]), ("👍", 2, True))
        self.assertEqual([p["name"] for p in thumbs["people"]], ["Meena MEENA", "Ravi RAVI"])  # you first
        self.assertEqual([p["isMe"] for p in thumbs["people"]], [True, False])
        self.assertEqual((heart["emoji"], heart["count"], [p["employeeId"] for p in heart["people"]]),
                         ("❤️", 1, [self.meena.pk]))

        res = self.client.get(f"/api/chat/messages/{msg.pk}/reactions", **self.as_emp(self.ravi))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["messageId"], msg.pk)
        self.assertEqual([r["count"] for r in res.json()["reactions"]], [2, 1])
        self.assertEqual(res.json()["reactions"][0]["people"][0]["name"], "Ravi RAVI")

        # HR reads them on the company channel; someone from another branch cannot
        self.assertEqual(self.client.get(f"/api/chat/messages/{msg.pk}/reactions", **self.as_hr()).status_code, 200)
        self.assertEqual(
            self.client.get(f"/api/chat/messages/{msg.pk}/reactions", **self.as_emp(self.south)).status_code, 404
        )

    def test_removing_a_reaction_still_works(self):
        msg = ChatMessage.objects.create(channel=self.company, sender=self.packer, text="Hi")
        ChatReaction.objects.create(message=msg, employee=self.ravi, emoji="😂")
        res = self.client.delete(f"/api/chat/messages/{msg.pk}/reactions", {"emoji": "😂"}, format="json",
                                 **self.as_emp(self.ravi))
        self.assertEqual((res.status_code, res.json()["reactions"]), (200, []))


# ── voice messages recorded in a browser (the Employee Web App, 2026-11-25) ─────────────────────────────────────────


def ebml(eid: int, body: bytes, unknown: bool = False) -> bytes:
    """One EBML element: its id, a 4-byte size (or the 8-byte "unknown" size a recording browser writes), its body."""
    size = b"\x01\xff\xff\xff\xff\xff\xff\xff" if unknown else (0x10000000 | len(body)).to_bytes(4, "big")
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + size + body


def webm(block_times_ms=(0, 20, 40), stated_ms=None, codecs=(b"A_OPUS",), doctype=b"webm", unknown=True) -> bytes:
    """A small WebM file shaped like Chrome's MediaRecorder output: Segment and Clusters of unknown size, no Duration
    unless `stated_ms`, one SimpleBlock per time in `block_times_ms` (a Cluster per started second)."""
    import struct

    header = ebml(0x1A45DFA3, ebml(0x4286, b"\x01") + ebml(0x4282, doctype) + ebml(0x4287, b"\x04"))
    info_body = ebml(0x2AD7B1, (1_000_000).to_bytes(3, "big")) + ebml(0x4D80, b"Chrome")
    if stated_ms is not None:
        info_body += ebml(0x4489, struct.pack(">d", float(stated_ms)))
    tracks = ebml(
        0x1654AE6B,
        b"".join(ebml(0xAE, ebml(0xD7, bytes([i + 1])) + ebml(0x86, c) + ebml(0x63A2, b"OpusHead" + b"\x01" * 11))
                 for i, c in enumerate(codecs)),
    )
    clusters = b""
    by_second: dict[int, list[int]] = {}
    for t in block_times_ms:
        by_second.setdefault(t // 1000 * 1000, []).append(t)
    for start, times in sorted(by_second.items()):
        blocks = b"".join(ebml(0xA3, b"\x81" + (t - start).to_bytes(2, "big", signed=True) + b"\x80" + b"\xfc" * 40)
                          for t in times)
        clusters += ebml(0x1F43B675, ebml(0xE7, start.to_bytes(4, "big")) + blocks, unknown=unknown)
    return header + ebml(0x18538067, ebml(0x1549A966, info_body) + tracks + clusters, unknown=unknown)


def ogg_page(granule: int, packet: bytes, seq: int, header_type: int = 0) -> bytes:
    lacing, n = [], len(packet)
    while n >= 255:
        lacing.append(255)
        n -= 255
    lacing.append(n)
    return (b"OggS" + bytes([0, header_type]) + granule.to_bytes(8, "little", signed=True) + b"\x2a\x00\x00\x00"
            + seq.to_bytes(4, "little") + b"\x00\x00\x00\x00" + bytes([len(lacing)]) + bytes(lacing) + packet)


def ogg_opus(duration_ms: int | None, pre_skip: int = 312, first_packet: bytes | None = None) -> bytes:
    """A small Ogg Opus file like Firefox's MediaRecorder makes; `duration_ms` None = no page states a position."""
    head = first_packet or (b"OpusHead" + bytes([1, 1]) + pre_skip.to_bytes(2, "little")
                            + (48_000).to_bytes(4, "little") + b"\x00\x00\x00")
    tags = b"OpusTags" + (7).to_bytes(4, "little") + b"Firefox" + b"\x00\x00\x00\x00"
    end = -1 if duration_ms is None else pre_skip + duration_ms * 48
    middle = -1 if duration_ms is None else pre_skip + duration_ms * 24
    return (ogg_page(0, head, 0, 2) + ogg_page(0, tags, 1) + ogg_page(middle, b"\xfc" * 300, 2)
            + ogg_page(end, b"\xfc" * 120, 3, 4))


class BrowserVoiceTests(ChatMediaBase):
    """WebM / Ogg with Opus inside, as Chrome, Edge and Firefox record; the m4a / AAC rules above are unchanged."""

    def send(self, data, name, mime, **fields):
        return self.upload(self.company, "voice", data, name=name, mime=mime, **fields)

    def test_a_chrome_webm_recording_is_taken_with_its_own_length(self):
        times = list(range(0, 9_001, 20))  # 9 s of 20 ms Opus frames, no Duration written
        res = self.send(webm(times), "voice.webm", "audio/webm;codecs=opus", durationMs="99000",
                        waveform=json.dumps([5, 50, 90]))
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual((body["kind"], body["text"]), ("voice", chat_media.VOICE_TEXT))
        self.assertEqual((body["media"]["mime"], body["media"]["durationMs"]), ("audio/webm", 9_000))  # the file wins
        self.assertEqual(body["media"]["waveform"], [5, 50, 90])
        self.assertTrue(ChatMessage.objects.get(pk=body["id"]).media.name.endswith(".webm"))
        got = self.download(body["id"], self.as_emp(self.meena))
        self.assertEqual((got.status_code, got["Content-Type"]), (200, "audio/webm"))
        self.assertEqual(b"".join(got.streaming_content), webm(times))  # stored untouched

    def test_a_stated_webm_duration_wins_and_known_sizes_work_too(self):
        res = self.send(webm((0, 20), stated_ms=7_500, unknown=False), "v.webm", "audio/webm", durationMs="1000")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["media"]["durationMs"], 7_500)
        self.assertEqual(chat_media.webm_duration_ms(webm((0, 1_000, 2_480), unknown=False)), 2_480)

    def test_an_unreadable_length_uses_the_browsers_figure_capped_at_two_minutes(self):
        silent = webm(block_times_ms=())  # no audio block yet, no Duration: the file does not say
        self.assertIsNone(chat_media.webm_duration_ms(silent))
        res = self.send(silent, "v.webm", "audio/webm", durationMs="4200")
        self.assertEqual((res.status_code, res.json()["media"]["durationMs"]), (201, 4_200), res.content)
        res = self.send(silent, "v.webm", "audio/webm", durationMs="150000")
        self.assertEqual((res.status_code, res.json()["media"]["durationMs"]), (201, chat_media.VOICE_MAX_MS), res.content)
        res = self.send(silent, "v.webm", "audio/webm")
        self.assertEqual((res.status_code, res.json()["code"]), (400, "NO_DURATION"))
        res = self.send(ogg_opus(None), "v.ogg", "audio/ogg", durationMs="125000")
        self.assertEqual((res.status_code, res.json()["media"]["durationMs"]), (201, chat_media.VOICE_MAX_MS), res.content)

    def test_a_firefox_ogg_opus_recording_is_taken_with_its_own_length(self):
        self.assertEqual(chat_media.ogg_opus_duration_ms(ogg_opus(6_300)), 6_300)
        res = self.send(ogg_opus(6_300), "voice.ogg", "audio/ogg;codecs=opus", durationMs="60000")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual((res.json()["media"]["mime"], res.json()["media"]["durationMs"]), ("audio/ogg", 6_300))
        got = self.download(res.json()["id"], self.as_emp(self.meena))
        self.assertEqual((got.status_code, got["Content-Type"]), (200, "audio/ogg"))

    def test_what_is_refused_from_a_browser(self):
        vorbis = b"\x01vorbis" + b"\x00" * 22
        cases = [
            (webm(codecs=(b"V_VP8", b"A_OPUS")), "v.webm", {"durationMs": "4000"}, "NOT_AUDIO"),  # a video
            (webm(codecs=(b"A_VORBIS",)), "v.webm", {"durationMs": "4000"}, "NOT_AUDIO"),
            (webm(doctype=b"matroska"), "v.mkv", {"durationMs": "4000"}, "NOT_AUDIO"),
            (b"\x1a\x45\xdf\xa3" + b"\x00" * 40, "v.webm", {"durationMs": "4000"}, "NOT_AUDIO"),  # only the magic
            (ogg_opus(4_000, first_packet=vorbis), "v.ogg", {"durationMs": "4000"}, "NOT_AUDIO"),
            (b"OggS" + b"\x00" * 10, "v.ogg", {"durationMs": "4000"}, "NOT_AUDIO"),
            (webm(list(range(0, 130_001, 1_000))), "v.webm", {"durationMs": "60000"}, "TOO_LONG"),  # the file says 130 s
            (ogg_opus(200_000), "v.ogg", {}, "TOO_LONG"),
            (webm(block_times_ms=()), "v.webm", {"durationMs": "100"}, "TOO_SHORT"),
        ]
        for data, name, extra, code in cases:
            res = self.send(data, name, "audio/webm", **extra)
            self.assertEqual(res.status_code, 400, (code, name, res.content))
            self.assertEqual(res.json()["code"], code, name)
        self.assertFalse(ChatMessage.objects.exists())

    def test_the_readers_never_crash_on_damaged_files(self):
        for data in (b"", b"\x1a\x45\xdf\xa3", webm()[:37], webm()[:-7], b"OggS", ogg_opus(3_000)[:30],
                     b"\x1a\x45\xdf\xa3\xff\xff\xff\xff" * 8):
            self.assertIn(chat_media.audio_mime(data), (None, chat_media.WEBM_MIME, chat_media.OGG_MIME))
            chat_media.webm_duration_ms(data)
            chat_media.ogg_opus_duration_ms(data)
        # an m4a and raw AAC still read as before
        self.assertEqual(chat_media.audio_mime(m4a(5_000)), chat_media.M4A_MIME)
        self.assertEqual(chat_media.audio_mime(ADTS), chat_media.AAC_MIME)
