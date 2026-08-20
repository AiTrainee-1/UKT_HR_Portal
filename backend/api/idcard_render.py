"""
Server-side ID Card image renderer (Pillow)
==============================================
Until now, ID cards were only ever rasterized in the browser (html2canvas,
see IdCards.tsx) -there was no way to attach a real ID card image from the
backend at all, which is why "Email to employee" on the ID Cards page has
silently never attached an image (it expects the frontend to pass one, but
nothing in the frontend ever does). This module gives Email and WhatsApp
sends a real backend-generated image, replacing that reliance on
browser-side rendering for anything sent from the server.

Deliberately not a pixel-for-pixel replica of the dual-face fancy React
card (front+back, staff-vertical vs production-horizontal) -this is one
clean, professional landscape PNG carrying the essentials (photo, name,
code, designation, department, blood group, QR code), sized for chat/email
delivery rather than physical printing. The existing browser-based
Print/Download flow on the ID Cards page is untouched and still the tool
for producing print-quality physical cards.
"""

import base64
import io

from .document_pdf import _decode_b64_image

_CARD_SIZE = (1000, 600)
_FONT_CANDIDATES_BOLD = [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf"]
_FONT_CANDIDATES_REGULAR = [r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\segoeui.ttf"]


def _font(candidates: list[str], size: int):
    from PIL import ImageFont

    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _hex_to_rgb(hex_color: str | None, fallback=(14, 75, 58)) -> tuple:
    if not hex_color:
        return fallback
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return fallback
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return fallback


def render_idcard_png(idcard: dict, verify_url: str) -> bytes:
    """
    idcard is the same dict _idcard_dict() (growth_views.py) already builds
    for the frontend, so this stays in sync with whatever fields the React
    card reads -no separate data-fetching path to keep consistent.
    """
    from PIL import Image, ImageDraw

    primary = _hex_to_rgb((idcard.get("template") or {}).get("primaryColor"))
    W, H = _CARD_SIZE
    card = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(card)

    # Header band
    header_h = 130
    draw.rectangle([0, 0, W, header_h], fill=primary)
    company = (idcard.get("company") or {}).get("name") or "UKTextiles"
    draw.text((40, 28), company.upper(), fill="white", font=_font(_FONT_CANDIDATES_BOLD, 40))
    draw.text((40, 82), "EMPLOYEE ID CARD", fill="white", font=_font(_FONT_CANDIDATES_REGULAR, 22))

    # Photo box
    photo_box = (40, header_h + 40, 280, header_h + 40 + 320)
    photo_buf = _decode_b64_image(idcard.get("photoUrl"))
    if photo_buf:
        try:
            photo = Image.open(photo_buf).convert("RGB")
            photo = photo.resize((photo_box[2] - photo_box[0], photo_box[3] - photo_box[1]), Image.LANCZOS)
            card.paste(photo, (photo_box[0], photo_box[1]))
        except Exception:
            draw.rectangle(photo_box, fill=(230, 230, 230))
    else:
        draw.rectangle(photo_box, fill=(230, 230, 230))
    draw.rectangle(photo_box, outline=primary, width=3)

    # Text block
    text_x = 320
    y = header_h + 45
    draw.text((text_x, y), idcard.get("name") or "-", fill=(20, 20, 20), font=_font(_FONT_CANDIDATES_BOLD, 34))
    y += 50
    draw.text((text_x, y), f"Employee Code: {idcard.get('code') or '-'}", fill=(70, 70, 70), font=_font(_FONT_CANDIDATES_REGULAR, 22))
    y += 38
    draw.text((text_x, y), f"Designation: {idcard.get('designation') or '-'}", fill=(70, 70, 70), font=_font(_FONT_CANDIDATES_REGULAR, 22))
    y += 38
    draw.text((text_x, y), f"Department: {idcard.get('department') or '-'}", fill=(70, 70, 70), font=_font(_FONT_CANDIDATES_REGULAR, 22))
    y += 38
    if idcard.get("bloodGroup"):
        draw.text((text_x, y), f"Blood Group: {idcard['bloodGroup']}", fill=(70, 70, 70), font=_font(_FONT_CANDIDATES_REGULAR, 22))
        y += 38
    if idcard.get("branchName"):
        draw.text((text_x, y), f"Branch: {idcard['branchName']}", fill=(70, 70, 70), font=_font(_FONT_CANDIDATES_REGULAR, 22))

    # QR code, bottom-right
    try:
        import qrcode
        qr = qrcode.QRCode(box_size=6, border=1)
        qr.add_data(verify_url)
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        qr_size = 150
        qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)
        card.paste(qr_img, (W - qr_size - 40, H - qr_size - 40))
    except Exception:
        pass

    draw.rectangle([0, H - 6, W, H], fill=primary)

    out = io.BytesIO()
    card.save(out, format="PNG", optimize=True)
    return out.getvalue()
